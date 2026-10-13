#!/usr/bin/env node
/**
 * 真机验收：拿一个**真实的备份包**，在一台「全新的空机器」上跑完整导入，
 * 再逐文件核对结果是否与包内内容一字不差。
 *
 * 这是「换机同步能不能用」唯一算数的证明 —— 单元测试用的是仿真树，
 * 只有真包 + 真技能 + 真配置 + 真记忆全过一遍，才敢说这条路走得通。
 *
 * 全程只写临时目录（仓库下的 `.tmp-restore-*`），**不碰真实 ~/.dsh**，
 * 所以随时可以反复跑。
 *
 *   node scripts/verify-restore.mjs                       # 用默认备份目录里最新一份
 *   node scripts/verify-restore.mjs --archive <路径>
 *   node scripts/verify-restore.mjs --out D:\dsh-backups-sync
 *   node scripts/verify-restore.mjs --json
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlan } from '../lib/apply.js';
import {
  createArchive,
  extractArchive,
  incomingFromManifest,
  listArchives,
  prefixForAbs,
  readManifest,
  verifyArchive,
} from '../lib/archive.js';
import { diffFiles } from '../lib/diff.js';
import { scan } from '../lib/scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const DEFAULT_OUT = 'D:\\dsh-backups-sync';
const PROFILE = 'desktop';

function parseArgs(argv) {
  const out = { archive: null, out: DEFAULT_OUT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--archive') out.archive = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

const human = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** 全树的 `模块:相对路径 → sha256` 指纹。 */
async function treeOf(roots, moduleIds) {
  const r = await scan(roots, { moduleIds });
  const out = {};
  for (const m of Object.values(r.modules)) {
    for (const e of m.entries) out[`${e.moduleId}:${e.relPath}`] = e.sha256;
  }
  return out;
}

/** 全树的 `模块:相对路径 → {sha256}` 映射，喂给 diffFiles。 */
async function hashMapOf(roots, moduleIds) {
  const t = await treeOf(roots, moduleIds);
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { sha256: v }]));
}

function diffTrees(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const onlyA = [];
  const onlyB = [];
  const differing = [];
  for (const k of [...keys].sort()) {
    if (!(k in b)) onlyA.push(k);
    else if (!(k in a)) onlyB.push(k);
    else if (a[k] !== b[k]) differing.push(k);
  }
  return { onlyA, onlyB, differing };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/verify-restore.mjs [--archive <路径>] [--out <目录>] [--json]');
    return;
  }

  // ── 选包
  let archivePath = args.archive;
  if (!archivePath) {
    const list = await listArchives(args.out);
    if (list.length === 0) throw new Error(`在 ${args.out} 里没找到备份包`);
    archivePath = list[0].path;
  }
  archivePath = resolve(archivePath);
  if (!existsSync(archivePath)) throw new Error(`备份包不存在：${archivePath}`);

  const log = [];
  const say = (s = '') => {
    log.push(s);
    if (!args.json) console.log(s);
  };

  say(`包：${archivePath}`);
  say(`大小：${human((await readFile(archivePath)).length)}`);

  // ── 校验边车（有就核，没有就说明）
  const sidecar = await verifyArchive(archivePath);
  say(
    sidecar.checked
      ? `边车校验：${sidecar.ok ? '✅ 通过' : `❌ 不符（期望 ${sidecar.expected}，实得 ${sidecar.actual}）`}`
      : '边车校验：无 .sha256 边车，跳过',
  );

  // ── 解包到临时区
  const work = await mkdtemp(join(PROJECT, '.tmp-restore-'));
  const extractDir = join(work, 'incoming');
  const targetHome = join(work, 'target');
  const targetRoots = {
    dshHome: join(targetHome, 'dsh'),
    userHome: join(targetHome, 'home'),
    profile: PROFILE,
    agentsSkills: join(targetHome, 'home', '.agents', 'skills'),
  };
  // 源侧：直接扫解包出来的那份，它就是「另一台机器的真实状态」
  const sourceRoots = {
    dshHome: join(extractDir, 'dsh'),
    userHome: extractDir,
    profile: PROFILE,
    agentsSkills: join(extractDir, 'agents', 'skills'),
  };

  try {
    await extractArchive(archivePath, extractDir);
    const manifest = await readManifest(archivePath);
    const moduleIds = manifest.modules;
    say(`模块：${moduleIds.join(' / ')}`);
    say(`文件：${manifest.files.length} 个 / 清单记 ${human(manifest.totals.bytes)}`);
    say('');

    // ── 目标机必须是干净的
    await mkdir(targetRoots.agentsSkills, { recursive: true });
    const before = await treeOf(targetRoots, moduleIds);
    if (Object.keys(before).length !== 0) throw new Error('目标机不是空的，这个脚本应当在全新目录上跑');

    // ── 第一遍：首次导入
    const incoming = incomingFromManifest(manifest);
    const plan1 = diffFiles({ baseline: {}, current: {}, incoming, modules: moduleIds });
    const r1 = await applyPlan({
      roots: targetRoots,
      plan: plan1,
      manifest,
      incomingRoot: extractDir,
      baseline: { version: 1, machine: 'verify', lastSyncAt: 0, archives: {}, files: {} },
      baselinePath: join(targetRoots.dshHome, 'backup-sync', 'state.json'),
    });

    say('【第一遍】首次导入');
    say(`  计划：${JSON.stringify(plan1.counts)}`);
    say(`  结果：${JSON.stringify(r1.counts)}`);
    say(`  写入后校验：${r1.verified.checked} 个，失败 ${r1.verified.failed} 个`);
    say(`  快照：${r1.snapshotDir ?? '无（本来就是空机器）'}`);
    if (r1.errors.length > 0) {
      for (const e of r1.errors) say(`  ❌ ${e.key}：${e.message}`);
    }

    // ── 逐文件核对
    const expect = await treeOf(sourceRoots, moduleIds);
    const actual = await treeOf(targetRoots, moduleIds);
    const d = diffTrees(expect, actual);
    say(`  逐文件核对：期望 ${Object.keys(expect).length} 个，实得 ${Object.keys(actual).length} 个`);
    if (d.onlyA.length) say(`  ❌ 只应存在但缺失：${d.onlyA.join(', ')}`);
    if (d.onlyB.length) say(`  ❌ 多出来了：${d.onlyB.join(', ')}`);
    if (d.differing.length) say(`  ❌ 内容不一致：${d.differing.join(', ')}`);
    const pass1 = r1.ok && d.onlyA.length === 0 && d.onlyB.length === 0 && d.differing.length === 0;
    say(`  ${pass1 ? '✅ 通过' : '❌ 不通过'}`);
    say('');

    // ── 第二遍：同一个包再导入一次（必须安静无事）
    const current2 = await hashMapOf(targetRoots, moduleIds);
    const plan2 = diffFiles({
      baseline: r1.baseline.files,
      current: current2,
      incoming,
      modules: moduleIds,
    });
    const r2 = await applyPlan({
      roots: targetRoots,
      plan: plan2,
      manifest,
      incomingRoot: extractDir,
      baseline: r1.baseline,
    });
    const after2 = await treeOf(targetRoots, moduleIds);
    const d2 = diffTrees(actual, after2);
    const pass2 =
      r2.counts.import === 0 &&
      r2.counts.failed === 0 &&
      r2.conflictsUnresolved.length === 0 &&
      plan2.counts.same === manifest.files.length &&
      d2.onlyA.length === 0 &&
      d2.onlyB.length === 0 &&
      d2.differing.length === 0;

    say('【第二遍】同一个包再导入一次（幂等）');
    say(`  计划：${JSON.stringify(plan2.counts)}`);
    say(`  结果：${JSON.stringify(r2.counts)}`);
    say(`  文件是否有变动：${d2.onlyA.length + d2.onlyB.length + d2.differing.length === 0 ? '否 ✅' : '是 ❌'}`);
    say(`  ${pass2 ? '✅ 通过' : '❌ 不通过'}`);
    say('');

    // ── 第三遍：目标机单方改一个文件，再导入 → 必须静默保留本地，不许问也不许改
    const victim = manifest.files.find((f) => f.key.startsWith('memory:') || f.key.startsWith('config:'));
    let pass3 = true;
    let localOnly = null;
    if (victim) {
      const abs = join(targetRoots.dshHome, ...victim.key.slice(victim.key.indexOf(':') + 1).split('/'));
      localOnly = `${await readFile(abs, 'utf8')}\n<!-- 本地单方追加 -->\n`;
      await writeFile(abs, localOnly, 'utf8');
      const current3 = await hashMapOf(targetRoots, moduleIds);
      const plan3 = diffFiles({ baseline: r1.baseline.files, current: current3, incoming, modules: moduleIds });
      const r3 = await applyPlan({
        roots: targetRoots,
        plan: plan3,
        manifest,
        incomingRoot: extractDir,
        baseline: r1.baseline,
      });
      const back = await readFile(abs, 'utf8');
      pass3 =
        plan3.counts.conflict === 0 &&
        plan3.counts.keep === 1 &&
        r3.counts.import === 0 &&
        r3.counts.failed === 0 &&
        back === localOnly;

      say('【第三遍】目标机单方改了一个文件，再导入');
      say(`  改的是：${victim.key}`);
      say(`  计划：${JSON.stringify(plan3.counts)}`);
      say(`  结果：${JSON.stringify(r3.counts)}`);
      say(`  本地内容是否被保留：${back === localOnly ? '是 ✅' : '否 ❌'}`);
      say(`  ${pass3 ? '✅ 通过' : '❌ 不通过'}`);
      say('');
    }

    // ── 第四遍：两侧都改了同一个文件 → 真冲突 → 裁决采用归档版
    let pass4 = true;
    if (victim) {
      const srcAbs = join(sourceRoots.dshHome, ...victim.key.slice(victim.key.indexOf(':') + 1).split('/'));
      const srcText = `${await readFile(srcAbs, 'utf8')}\n<!-- 源机改动 -->\n`;
      await writeFile(srcAbs, srcText, 'utf8');

      // 把改过的解包目录当成「另一台机器的第二次备份」重新打一个包
      const out2 = join(work, 'out2');
      const rescan = await scan(sourceRoots, { moduleIds });
      const arch2 = await createArchive({ roots: sourceRoots, result: rescan, moduleIds, outDir: out2 });
      const incoming2Root = join(out2, 'incoming');
      await extractArchive(arch2.archivePath, incoming2Root);
      const man2 = await readManifest(arch2.archivePath);
      const incoming2 = incomingFromManifest(man2);

      const plan4 = diffFiles({
        baseline: r1.baseline.files,
        current: await hashMapOf(targetRoots, moduleIds),
        incoming: incoming2,
        modules: moduleIds,
      });
      const r4 = await applyPlan({
        roots: targetRoots,
        plan: plan4,
        manifest: man2,
        incomingRoot: incoming2Root,
        baseline: r1.baseline,
        resolutions: { [victim.key]: 'archive' },
      });

      const abs = join(targetRoots.dshHome, ...victim.key.slice(victim.key.indexOf(':') + 1).split('/'));
      const nowText = await readFile(abs, 'utf8');
      // 快照沿用归档布局（dsh/ 与 agents/），所以要反查前缀，不能直接拼相对路径
      const snapPrefix = prefixForAbs(abs, targetRoots);
      const snapText =
        r4.snapshotDir && snapPrefix
          ? await readFile(join(r4.snapshotDir, ...snapPrefix.split('/')), 'utf8')
          : null;

      const after4 = await treeOf(targetRoots, moduleIds);
      const expect4 = await treeOf(sourceRoots, moduleIds);
      const d4 = diffTrees(expect4, after4);

      pass4 =
        plan4.counts.conflict === 1 &&
        plan4.counts.same === manifest.files.length - 1 &&
        r4.counts.import === 1 &&
        r4.counts.failed === 0 &&
        nowText === srcText &&
        snapText === localOnly &&
        d4.onlyA.length === 0 &&
        d4.onlyB.length === 0 &&
        d4.differing.length === 0;

      say('【第四遍】两侧都改了同一个文件 → 真冲突 → 裁决采用归档版');
      say(`  冲突键：${plan4.conflicts.map((c) => c.key).join(', ') || '（无）'}`);
      say(`  计划：${JSON.stringify(plan4.counts)}`);
      say(`  结果：${JSON.stringify(r4.counts)}`);
      say(`  本地是否换成了归档版：${nowText === srcText ? '是 ✅' : '否 ❌'}`);
      say(`  原件是否进了快照：${snapText === localOnly ? '是 ✅' : '否 ❌'}`);
      say(`  裁决后与源机是否逐文件一致：${d4.onlyA.length + d4.onlyB.length + d4.differing.length === 0 ? '是 ✅' : '否 ❌'}`);
      say(`  ${pass4 ? '✅ 通过' : '❌ 不通过'}`);
      say('');
    }

    const allPass = pass1 && pass2 && pass3 && pass4;
    say(`总结：${allPass ? '✅ 四遍全通过' : '❌ 有不过的'}`);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            archive: archivePath,
            modules: moduleIds,
            files: manifest.files.length,
            pass: allPass,
            pass1,
            pass2,
            pass3,
            pass4,
            first: { plan: plan1.counts, result: r1.counts, verified: r1.verified, errors: r1.errors, diff: d },
            second: { plan: plan2.counts, result: r2.counts, immutable: d2 },
          },
          null,
          2,
        ),
      );
    }
    if (!allPass) process.exitCode = 1;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
