#!/usr/bin/env node
/**
 * 对**真实机器**打一个备份包（M3 验收用，也是将来插件命令行的雏形）。
 *
 *   node scripts/backup-now.mjs                       # 默认 5 个模块 → D:\dsh-backups-sync
 *   node scripts/backup-now.mjs --all                 # 含对话模块
 *   node scripts/backup-now.mjs --modules skills,todo
 *   node scripts/backup-now.mjs --out D:\somewhere
 *   node scripts/backup-now.mjs --verify              # 打完包解回来逐文件核对哈希
 *   node scripts/backup-now.mjs --no-baseline         # 不更新基线库
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createArchive, extractArchive, readManifest, verifyArchive } from '../lib/archive.js';
import { loadBaseline, saveBaseline } from '../lib/baseline.js';
import { keyOf } from '../lib/baseline.js';
import { MODULE_IDS, MODULE_META } from '../lib/modules.js';
import { resolveRoots } from '../lib/paths.js';
import { scan, summarize } from '../lib/scan.js';
import { sha256File } from '../lib/hash.js';

const DEFAULT_OUT = 'D:\\dsh-backups-sync';

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, modules: null, all: false, verify: false, baseline: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--modules') out.modules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--all') out.all = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--no-baseline') out.baseline = false;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const args = parseArgs(process.argv.slice(2));
const roots = resolveRoots(process.env);
const moduleIds =
  args.modules ??
  (args.all ? MODULE_IDS : MODULE_IDS.filter((id) => MODULE_META[id].defaultChecked));

const t0 = Date.now();
const result = await scan(roots, { moduleIds });
const rows = summarize(result);

const baselinePath = join(roots.dshHome, 'backup-sync', 'state.json');
const loaded = await loadBaseline(baselinePath);

// 基线：包内带一份，换机后第一次导入才有比对基准
const baselineJson = args.baseline ? `${JSON.stringify(loaded.data, null, 2)}\n` : null;

const created = await createArchive({
  roots,
  result,
  moduleIds,
  outDir: args.out,
  baselineJson,
  name: undefined,
});

const verified = await verifyArchive(created.archivePath);
const ms = Date.now() - t0;

if (args.json) {
  console.log(JSON.stringify({ archive: created.archivePath, bytes: created.bytes, sha256: created.sha256, manifest: created.manifest, ms }, null, 2));
  process.exit(0);
}

console.log('备份同步 · 打包完成');
console.log(`  时间      ${created.manifest.createdAtLocal}`);
console.log(`  机器      ${created.manifest.machine}（${hostname()}）`);
console.log(`  profile   ${created.manifest.profile}`);
console.log(`  输出      ${created.archivePath}`);
console.log(`  体积      ${human(created.bytes)}（${created.bytes} 字节）`);
console.log(`  sha256    ${created.sha256}`);
console.log(`  边车      ${created.sha256Path.replace(args.out, '…')}`);
console.log(`            ${created.metaPath.replace(args.out, '…')}`);
console.log(`  暂存方式  硬链接 ${created.staged.linked} / 复制 ${created.staged.copied}`);
console.log(`  耗时      ${ms} ms`);
console.log('');
console.log('模块        条目    文件        体积');
console.log('-'.repeat(48));
for (const r of rows) {
  console.log(
    `${r.label.padEnd(10)}  ${String(r.count).padStart(4)}  ${String(r.files).padStart(6)}  ${human(r.bytes).padStart(10)}`,
  );
}
console.log('-'.repeat(48));
console.log(
  `${'合计'.padEnd(10)}  ${''.padStart(4)}  ${String(created.manifest.totals.files).padStart(6)}  ${human(created.manifest.totals.bytes).padStart(10)}`,
);

// 更新基线库：记录「这次发出去的是什么」，下次导入才有三方比较的基准
if (args.baseline) {
  const files = {};
  for (const mod of Object.values(result.modules)) {
    for (const e of mod.entries) files[keyOf(e.moduleId, e.relPath)] = { sha256: e.sha256, size: e.size, mtimeMs: e.mtimeMs };
  }
  await saveBaseline(baselinePath, {
    version: 1,
    machine: created.manifest.machine,
    lastSyncAt: Date.now(),
    archives: { ...loaded.data.archives, [created.manifest.createdAt]: { name: created.archivePath.split(/[\\/]/).pop(), files: created.manifest.totals.files } },
    files,
  });
  console.log('');
  console.log(`基线库已更新  ${baselinePath}`);
  console.log(`  ${Object.keys(files).length} 个文件键，供下次增量导入做三方比较`);
  if (loaded.corrupted) console.log(`  ⚠ 原基线库损坏（${loaded.error}），已用本次状态重建`);
}

if (args.verify) {
  console.log('');
  console.log('逐文件核对（解包 → 重算 sha256）…');
  const tmp = await mkdtemp(join(args.out, '.verify-'));
  try {
    await extractArchive(created.archivePath, tmp);
    const m = await readManifest(created.archivePath);
    let bad = 0;
    for (const f of m.files) {
      const abs = join(tmp, ...f.path.split('/'));
      const st = await stat(abs).catch(() => null);
      if (!st) {
        bad += 1;
        console.log(`  ✗ 缺文件 ${f.path}`);
        continue;
      }
      const h = await sha256File(abs);
      if (h !== f.sha256) {
        bad += 1;
        console.log(`  ✗ 哈希不符 ${f.path}`);
      }
    }
    console.log(`  ${m.files.length - bad}/${m.files.length} 个文件核对通过`);
    console.log(`  包完整性校验：${verified.ok ? '通过' : '失败'}（边车 sha256 ${verified.ok ? '一致' : '不一致'}）`);
    if (bad > 0) process.exitCode = 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
