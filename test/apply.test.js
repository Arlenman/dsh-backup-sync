/**
 * apply.js 的测试。
 *
 * 执行器是本项目里**唯一会写用户数据**的模块，所以测试的重点不是「功能对不对」，
 * 而是三条不可退让的写入不变量：
 *   ① 动手前先快照，恢复失败能退回原状；
 *   ② 冲突未裁决时一个字都不许改本地；
 *   ③ 写完必须回算哈希确认，不能写完就当成功。
 *
 * 另外钉死一条最容易踩的自动化缺陷：**冲突裁决为「保留本地」之后，基线必须
 * 记下本地哈希**，否则下次导入还会冲突，用户会被同一个问题反复问。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyPlan, resolveAbs, snapshotDirName } from '../lib/apply.js';
import { FORMAT_ID, createArchive, extractArchive, incomingFromManifest, readManifest } from '../lib/archive.js';
import { parseKey, diffFiles } from '../lib/diff.js';
import { sha256Text } from '../lib/hash.js';
import { MODULE_IDS } from '../lib/modules.js';
import { scan } from '../lib/scan.js';
import { withFixture, withTempDir } from './fixture.js';

// ─────────────────────────────────────────── 测试脚手架

const exists = (p) => stat(p).then(() => true, () => false);

/** 全树的 `模块:相对路径 → {sha256}` 映射，直接喂给 `diffFiles`。 */
async function hashMapOf(roots, moduleIds = MODULE_IDS) {
  const r = await scan(roots, { moduleIds });
  const out = {};
  for (const mod of Object.values(r.modules)) {
    for (const e of mod.entries) out[`${e.moduleId}:${e.relPath}`] = { sha256: e.sha256 };
  }
  return out;
}

/** 全树的内容指纹（只留哈希），用来判「两边完全一致」—— 刻意不含 mtime。 */
async function treeOf(roots, moduleIds = MODULE_IDS) {
  const m = await hashMapOf(roots, moduleIds);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.sha256]));
}

/** 手搓动作计划：跳过 diff 生成，直接测执行器。 */
function planOf(rows) {
  const actions = rows.map(([key, action]) => {
    const { moduleId, relPath } = parseKey(key);
    return { key, moduleId, relPath, action, reason: '测试手搓' };
  });
  const counts = { import: 0, keep: 0, delete: 0, conflict: 0, same: 0, skip: 0 };
  for (const a of actions) counts[a.action] += 1;
  return {
    actions,
    counts,
    conflicts: actions.filter((a) => a.action === 'conflict'),
    pending: actions.filter((a) => a.action === 'import' || a.action === 'delete'),
  };
}

/** 手搓一个「已解包」的归档目录 + 清单。 */
async function makeIncoming(dir, entries, { modules } = {}) {
  const files = [];
  for (const e of entries) {
    const abs = join(dir, ...e.path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, e.content, 'utf8');
    files.push({
      key: e.key,
      path: e.path,
      moduleId: e.key.slice(0, e.key.indexOf(':')),
      size: Buffer.byteLength(e.content, 'utf8'),
      mtimeMs: 1,
      sha256: e.sha256 ?? sha256Text(e.content),
    });
  }
  return {
    format: FORMAT_ID,
    version: 1,
    modules: modules ?? [...new Set(files.map((f) => f.moduleId))],
    files,
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
  };
}

/** 源机打一个包并解好，返回一次导入所需的全部材料。 */
async function packAndOpen(roots, moduleIds, outDir) {
  const result = await scan(roots, { moduleIds });
  const archive = await createArchive({ roots, result, moduleIds, outDir });
  const incomingRoot = join(outDir, 'incoming');
  await extractArchive(archive.archivePath, incomingRoot);
  const manifest = await readManifest(archive.archivePath);
  return { archivePath: archive.archivePath, result, incomingRoot, manifest, incoming: incomingFromManifest(manifest) };
}

/** 源机打包 → 解包，拿到 manifest 与 incoming 目录。 */
async function withArchive(moduleIds, fn) {
  return withTempDir('.tmp-apply-', async (outDir) =>
    withFixture(async (source) => {
      const pack = await packAndOpen(source.roots, moduleIds, outDir);
      return fn({ source, ...pack, outDir });
    }),
  );
}

// ─────────────────────────────────────────── 键 → 磁盘路径

test('resolveAbs 把键还原成磁盘绝对路径（记忆与待办同根也能分开）', async () => {
  await withFixture(async ({ roots }) => {
    const h = roots.dshHome;
    assert.equal(resolveAbs(roots, 'todo', 'daily/2026-10-13.todo.md'), join(h, 'memories', 'daily', '2026-10-13.todo.md'));
    assert.equal(resolveAbs(roots, 'memory', 'daily/2026-10-13.md'), join(h, 'memories', 'daily', '2026-10-13.md'));
    assert.equal(resolveAbs(roots, 'todo', 'TODOS-life.md'), join(h, 'memories', 'TODOS-life.md'));
    assert.equal(resolveAbs(roots, 'skills', 'cdp-browser-automation/SKILL.md'), join(roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md'));
    assert.equal(resolveAbs(roots, 'config', 'AGENTS.md'), join(h, 'AGENTS.md'));
    assert.equal(resolveAbs(roots, 'config', 'cordis.patch.yml'), join(h, 'profiles', 'desktop', 'cordis.patch.yml'));
    assert.equal(resolveAbs(roots, 'plugins', 'package.json'), join(h, 'profiles', 'desktop', 'package.json'));
  });
});

test('resolveAbs 不会张冠李戴：模块与路径不匹配时返回 null', async () => {
  await withFixture(async ({ roots }) => {
    // 只差一个后缀，但分属两个模块 —— 认错了就会把待办写进记忆的位置
    assert.equal(resolveAbs(roots, 'memory', 'daily/2026-10-13.todo.md'), null);
    assert.equal(resolveAbs(roots, 'todo', 'daily/2026-10-13.md'), null);
    assert.equal(resolveAbs(roots, 'memory', 'TODOS-life.md'), null);
    assert.equal(resolveAbs(roots, 'config', 'MEMORY.md'), null);
    assert.equal(resolveAbs(roots, '不存在的模块', 'AGENTS.md'), null);
  });
});

test('snapshotDirName 带时间戳，可读可排序', () => {
  const n = snapshotDirName(new Date(2026, 9, 13, 18, 6, 57));
  assert.equal(n, 'pre-restore-20261013-180657');
});

// ─────────────────────────────────────────── 基本执行

test('import 把文件写到本地，并回算哈希确认', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 来自归档\n' },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });

      assert.equal(res.ok, true);
      assert.equal(res.counts.import, 1);
      assert.equal(res.counts.failed, 0);
      assert.equal(res.verified.checked, 1);
      assert.equal(res.verified.failed, 0);
      assert.equal(res.results[0].effective, 'import');
      assert.equal(res.results[0].applied, true);
      assert.equal(res.results[0].sha256, sha256Text('# 来自归档\n'));
      assert.equal(await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8'), '# 来自归档\n');
    });
  });
});

test('目标多级目录不存在时自动建出来', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'skills:brand-new-skill/scripts/deep/tool.mjs', path: 'agents/skills/brand-new-skill/scripts/deep/tool.mjs', content: 'x\n' },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['skills:brand-new-skill/scripts/deep/tool.mjs', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      assert.equal(res.counts.failed, 0);
      assert.equal(
        await exists(join(t.roots.agentsSkills, 'brand-new-skill', 'scripts', 'deep', 'tool.mjs')),
        true,
      );
    });
  });
});

test('keep / same / skip 三种动作一个字节都不碰', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture(async (t) => {
      const localPath = join(t.roots.dshHome, 'AGENTS.md');
      const before = await readFile(localPath, 'utf8');

      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([
          ['config:AGENTS.md', 'same'],
          ['config:cordis.patch.yml', 'keep'],
          ['sessions:x/y/session.jsonl', 'skip'],
        ]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });

      assert.equal(res.counts.import, 0);
      assert.equal(res.counts.failed, 0);
      assert.equal(await readFile(localPath, 'utf8'), before);
      assert.equal(res.snapshotFiles, 0, '什么都没做就不该产生快照');
    });
  });
});

test('计划之外的文件一个都不碰', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 新\n' },
    ]);
    await withFixture(async (t) => {
      const before = await treeOf(t.roots, ['memory']);
      await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      assert.deepEqual(await treeOf(t.roots, ['memory']), before);
    });
  });
});

// ─────────────────────────────────────────── 冲突裁决

test('★ 冲突未裁决时保留本地、一个字都不改', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture(async (t) => {
      const localPath = join(t.roots.dshHome, 'AGENTS.md');
      const before = await readFile(localPath, 'utf8');
      assert.notEqual(before, '# 归档版\n');

      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'conflict']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        resolutions: {}, // 用户还没裁决
      });

      assert.equal(res.counts.import, 0);
      assert.equal(res.results[0].effective, 'keep');
      assert.equal(res.results[0].applied, false);
      assert.match(res.results[0].reason, /未裁决/);
      assert.deepEqual(res.conflictsUnresolved, ['config:AGENTS.md']);
      assert.equal(await readFile(localPath, 'utf8'), before, '未裁决绝不能动本地');
    });
  });
});

test('冲突裁决为 archive → 覆盖成本地归档版', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture(async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'conflict']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        resolutions: { 'config:AGENTS.md': 'archive' },
      });
      assert.equal(res.results[0].effective, 'import');
      assert.equal(res.results[0].applied, true);
      assert.equal(res.counts.failed, 0);
      assert.equal(await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8'), '# 归档版\n');
      assert.deepEqual(res.conflictsUnresolved, []);
    });
  });
});

test('★ 冲突裁决为 local 后，基线要记「归档版本」当共同祖先', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const archiveText = '# 归档版\n';
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: archiveText },
    ]);
    await withFixture(async (t) => {
      const before = await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8');
      const localSha = sha256Text(before);

      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'conflict']]),
        manifest,
        incomingRoot,
        baseline: { files: { 'config:AGENTS.md': { sha256: 'old-old-old' } } },
        resolutions: { 'config:AGENTS.md': 'local' },
      });

      assert.equal(res.results[0].effective, 'keep');
      assert.equal(await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8'), before, '本地一个字都不该变');

      // 记的是**归档版本**而不是本地版本 —— 反直觉，但两种记法的后果正好相反
      assert.equal(res.baseline.files['config:AGENTS.md'].sha256, sha256Text(archiveText));

      const current = { 'config:AGENTS.md': { sha256: localSha } };
      const incoming = { 'config:AGENTS.md': { sha256: sha256Text(archiveText) } };

      // ① 再导入同一个包：应当静默保留本地，不能再问第二次
      const again = diffFiles({ baseline: res.baseline.files, current, incoming, modules: ['config'] });
      assert.equal(again.counts.conflict, 0, '同一个冲突不该出现第二次');
      assert.equal(again.counts.keep, 1, '应当认成「只有本地改了」→ 静默保留');
      assert.equal(again.counts.import, 0);

      // ② 反面对照：若记的是本地哈希，下次就会把用户刚裁决保留的版本反过来覆盖掉
      const wrong = diffFiles({
        baseline: { 'config:AGENTS.md': { sha256: localSha } },
        current,
        incoming,
        modules: ['config'],
      });
      assert.equal(wrong.counts.import, 1, '记本地哈希的后果：下次会擅自把归档版盖回来，等于裁决白做');
    });
  });
});

// ─────────────────────────────────────────── 删除

test('delete 动作要 allowDelete 这把第二道锁，否则拒绝执行', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [], { modules: ['config'] });
    await withFixture(async (t) => {
      const localPath = join(t.roots.dshHome, 'AGENTS.md');
      assert.equal(await exists(localPath), true);

      const refused = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'delete']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        allowDelete: false,
      });
      assert.equal(refused.results[0].effective, 'keep');
      assert.equal(refused.results[0].applied, false);
      assert.match(refused.results[0].reason, /未启用删除/);
      assert.equal(await exists(localPath), true, '没开删除就绝不能删');

      const allowed = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'delete']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        allowDelete: true,
      });
      assert.equal(allowed.results[0].effective, 'delete');
      assert.equal(allowed.results[0].applied, true);
      assert.equal(allowed.counts.delete, 1);
      assert.equal(await exists(localPath), false);
      assert.equal('config:AGENTS.md' in allowed.baseline.files, false, '删掉的键要从基线里摘掉');
    });
  });
});

// ─────────────────────────────────────────── 快照（写入不变量①）

test('★ 覆盖前先把原件快照下来（恢复失败能退回原状）', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
      { key: 'skills:cdp-browser-automation/SKILL.md', path: 'agents/skills/cdp-browser-automation/SKILL.md', content: '# 归档技能\n' },
    ]);
    await withFixture(async (t) => {
      const agentsBefore = await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8');
      const skillBefore = await readFile(join(t.roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md'), 'utf8');

      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([
          ['config:AGENTS.md', 'import'],
          ['skills:cdp-browser-automation/SKILL.md', 'import'],
        ]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });

      assert.equal(res.snapshotFiles, 2, '被覆盖的两个文件都该进快照');
      assert.ok(res.snapshotDir, '应当产生快照目录');
      assert.match(res.snapshotDir, /pre-restore-\d{8}-\d{6}$/);

      // 快照里是**原件**，且布局与归档一致（dsh/ 与 agents/），必要时可原样再打一个包
      assert.equal(await readFile(join(res.snapshotDir, 'dsh', 'AGENTS.md'), 'utf8'), agentsBefore);
      assert.equal(
        await readFile(join(res.snapshotDir, 'agents', 'skills', 'cdp-browser-automation', 'SKILL.md'), 'utf8'),
        skillBefore,
      );

      // 快照目录要在 backup-sync 下（不属于任何模块，不会被下次扫描当成用户数据）
      assert.equal(dirname(res.snapshotDir), join(t.roots.dshHome, 'backup-sync'));
      assert.equal(await exists(join(res.snapshotDir, 'snapshot.json')), true);

      // 本地确实已被覆盖
      assert.equal(await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8'), '# 归档版\n');
    });
  });
});

test('被删除的文件也要先快照', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [], { modules: ['config'] });
    await withFixture(async (t) => {
      const before = await readFile(join(t.roots.dshHome, 'AGENTS.md'), 'utf8');
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'delete']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        allowDelete: true,
      });
      assert.equal(res.snapshotFiles, 1);
      assert.equal(await readFile(join(res.snapshotDir, 'dsh', 'AGENTS.md'), 'utf8'), before);
    });
  });
});

test('本机没有的文件不需要快照（没什么可丢的）', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 新\n' },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      assert.equal(res.snapshotFiles, 0);
      assert.equal(res.snapshotDir, null);
      assert.equal(res.counts.failed, 0);
    });
  });
});

test('snapshot:false 可以关掉快照（但要显式关）', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture(async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        snapshot: false,
      });
      assert.equal(res.snapshotDir, null);
      assert.equal(res.counts.import, 1);
    });
  });
});

// ─────────────────────────────────────────── 预演

test('★ dryRun 只算不做：不写文件、不建快照、不写基线', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
      { key: 'skills:new-skill/SKILL.md', path: 'agents/skills/new-skill/SKILL.md', content: '# 新技能\n' },
    ]);
    await withFixture(async (t) => {
      const before = await treeOf(t.roots);
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([
          ['config:AGENTS.md', 'import'],
          ['skills:new-skill/SKILL.md', 'import'],
        ]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
        baselinePath: join(t.roots.dshHome, 'backup-sync', 'state.json'),
        dryRun: true,
      });

      assert.equal(res.dryRun, true);
      assert.equal(res.counts.import, 2, '预演也要如实算出打算做什么');
      assert.equal(res.snapshotDir, null);
      assert.equal(res.baselinePath, null);
      assert.deepEqual(await treeOf(t.roots), before, '预演之后一个字节都不该变');
      assert.equal(await exists(join(t.roots.dshHome, 'backup-sync', 'state.json')), false);
      for (const r of res.results) assert.equal(r.applied, false);
    });
  });
});

// ─────────────────────────────────────────── 失败处理

test('归档里缺了清单声明的文件 → 记失败，其余文件照常导入', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 好文件\n' },
      { key: 'config:settings.yaml', path: 'dsh/settings.yaml', content: 'a: 1\n' },
    ]);
    // 把第二个从磁盘上删掉，模拟解包不完整
    const { rm } = await import('node:fs/promises');
    await rm(join(incomingRoot, 'dsh', 'settings.yaml'));

    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([
          ['config:AGENTS.md', 'import'],
          ['config:settings.yaml', 'import'],
        ]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });

      assert.equal(res.ok, false, '有失败项时 ok 必须是 false');
      assert.equal(res.counts.failed, 1);
      assert.equal(res.counts.import, 1);
      assert.equal(res.errors[0].key, 'config:settings.yaml');
      assert.equal(await exists(join(t.roots.dshHome, 'AGENTS.md')), true, '好的那个必须照常导入');
      assert.equal(await exists(join(t.roots.dshHome, 'settings.yaml')), false);
      // 失败项不许进基线
      assert.equal('config:settings.yaml' in res.baseline.files, false);
    });
  });
});

test('★ 写完回算哈希不符 → 记失败（不能写完就当成功）', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      // 故意写一个错的 sha256
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 实际内容\n', sha256: 'f'.repeat(64) },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      assert.equal(res.verified.checked, 1);
      assert.equal(res.verified.failed, 1);
      assert.equal(res.counts.failed, 1);
      assert.equal(res.ok, false);
      assert.equal(res.results[0].applied, false, '校验没过就不算落地成功');
      assert.equal('config:AGENTS.md' in res.baseline.files, false);
      assert.match(res.errors[0].message, /哈希/);
      assert.match(res.errors[0].message, /已回滚/);
      // 半成品必须清掉：写坏了还留在那儿，下次扫描会把它当成用户数据
      assert.equal(await exists(join(t.roots.dshHome, 'AGENTS.md')), false, '校验失败要回滚，不留半成品');
    });
  });
});

test('键解不出路径 → 记失败而不是写到别处', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'memory:daily/2026-10-13.todo.md', path: 'dsh/memories/daily/2026-10-13.todo.md', content: 'x\n' },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        // 模块与路径不匹配：记忆模块不该认领待办路径
        plan: planOf([['memory:daily/2026-10-13.todo.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      assert.equal(res.counts.failed, 1);
      assert.match(res.errors[0].message, /无法确定落点/);
      assert.equal(await exists(join(t.roots.dshHome, 'memories', 'daily', '2026-10-13.todo.md')), false);
    });
  });
});

test('清单里没有 incomingRoot 的路径记录 → 记失败', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    await mkdir(incomingRoot, { recursive: true });
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# x\n' },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:cordis.patch.yml', 'import']]), // 清单里没有这个键
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      assert.equal(res.counts.failed, 1);
      assert.match(res.errors[0].message, /清单里没有/);
    });
  });
});

// ─────────────────────────────────────────── 原子性与基线

test('写入是原子的：不留 .tmp- 残渣', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture(async (t) => {
      await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { files: {} },
      });
      const names = await readdir(t.roots.dshHome);
      assert.deepEqual(names.filter((n) => n.includes('.tmp-')), []);
    });
  });
});

test('给了 baselinePath 就顺手把基线写回磁盘（原子、可复读）', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture({ empty: true }, async (t) => {
      const baselinePath = join(t.roots.dshHome, 'backup-sync', 'state.json');
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'import']]),
        manifest,
        incomingRoot,
        baseline: { version: 1, machine: 'demo-pc', lastSyncAt: 0, archives: {}, files: {} },
        baselinePath,
      });

      assert.equal(res.baselinePath, baselinePath);
      const onDisk = JSON.parse(await readFile(baselinePath, 'utf8'));
      assert.deepEqual(onDisk, res.baseline);
      assert.equal(onDisk.files['config:AGENTS.md'].sha256, sha256Text('# 归档版\n'));
      assert.equal(onDisk.machine, 'demo-pc');
      assert.equal(onDisk.lastSyncAt > 0, true);
      assert.equal(res.baseline.version, 1);
    });
  });
});

test('基线保留未涉及模块的旧键（不能被这次导入抹掉）', async () => {
  await withTempDir('.tmp-apply-', async (dir) => {
    const incomingRoot = join(dir, 'in');
    const manifest = await makeIncoming(incomingRoot, [
      { key: 'config:AGENTS.md', path: 'dsh/AGENTS.md', content: '# 归档版\n' },
    ]);
    await withFixture(async (t) => {
      const res = await applyPlan({
        roots: t.roots,
        plan: planOf([['config:AGENTS.md', 'same']]),
        manifest,
        incomingRoot,
        baseline: { files: { 'memory:MEMORY.md': { sha256: 'keepme' }, 'config:AGENTS.md': { sha256: 'x' } } },
      });
      assert.equal(res.baseline.files['memory:MEMORY.md'].sha256, 'keepme');
      assert.equal(res.baseline.files['config:AGENTS.md'].sha256, 'x');
    });
  });
});

// ─────────────────────────────────────────── 端到端：换机

test('★ 端到端换机：源机打包 → 全新的目标机导入 → 两棵树逐文件完全一致', async () => {
  const mods = ['skills', 'plugins', 'config', 'memory', 'todo'];
  await withArchive(mods, async (ctx) => {
    await withFixture({ empty: true }, async (target) => {
      assert.deepEqual(await treeOf(target.roots, mods), {}, '目标机应当是干净的');

      const incoming = incomingFromManifest(ctx.manifest);
      const plan = diffFiles({ baseline: {}, current: {}, incoming, modules: ctx.manifest.modules });
      assert.equal(plan.counts.import, ctx.manifest.files.length);
      assert.equal(plan.counts.conflict, 0, '空机器不该有任何冲突');
      assert.equal(plan.counts.skip, 0);

      const res = await applyPlan({
        roots: target.roots,
        plan,
        manifest: ctx.manifest,
        incomingRoot: ctx.incomingRoot,
        baseline: { version: 1, machine: 'old', lastSyncAt: 0, archives: {}, files: {} },
      });

      assert.equal(res.ok, true, `不该有失败：${JSON.stringify(res.errors)}`);
      assert.equal(res.counts.failed, 0);
      assert.equal(res.verified.failed, 0);
      assert.equal(res.verified.checked, ctx.manifest.files.length);
      assert.equal(res.snapshotFiles, 0, '全新机器没有东西需要备份');

      assert.deepEqual(
        await treeOf(target.roots, mods),
        await treeOf(ctx.source.roots, mods),
        '导入后两边必须逐文件一致 —— 这是「换机同步」唯一算数的证明',
      );

      // 基线也应当与归档对齐，下次导入就是「无变化」
      const again = diffFiles({
        baseline: res.baseline.files,
        current: incoming,
        incoming,
        modules: ctx.manifest.modules,
      });
      assert.equal(again.counts.import, 0);
      assert.equal(again.counts.conflict, 0);
      assert.equal(again.counts.same, ctx.manifest.files.length);
    });
  });
});

test('★ 端到端增量：两台机器各自动过 → 只问该问的、只动该动的', async () => {
  const mods = ['config', 'memory'];
  await withTempDir('.tmp-apply-', async (outDir) => {
    await withFixture(async (a) => {
      // 源机 A 打第 1 个包
      const p1 = await packAndOpen(a.roots, mods, join(outDir, 'p1'));

      await withFixture({ empty: true }, async (b) => {
        // ── B 首次导入：应当是纯导入，零冲突
        const plan1 = diffFiles({ baseline: {}, current: {}, incoming: p1.incoming, modules: p1.manifest.modules });
        const r1 = await applyPlan({
          roots: b.roots,
          plan: plan1,
          manifest: p1.manifest,
          incomingRoot: p1.incomingRoot,
          baseline: { version: 1, machine: 'A', lastSyncAt: 0, archives: {}, files: {} },
        });
        assert.equal(r1.ok, true, `首次导入不该失败：${JSON.stringify(r1.errors)}`);
        assert.deepEqual(r1.conflictsUnresolved, [], '首次导入是纯导入，不该有任何冲突');

        // ── A 改 AGENTS.md，重新打包（→ 归档侧也变了）
        await writeFile(join(a.roots.dshHome, 'AGENTS.md'), '# A 改过的规则\n', 'utf8');
        const p2 = await packAndOpen(a.roots, mods, join(outDir, 'p2'));

        // ── B 也改 AGENTS.md（→ 真冲突），再单方改一个 A 没碰的文件（→ 应静默保留本地）
        await writeFile(join(b.roots.dshHome, 'AGENTS.md'), '# B 改过的规则\n', 'utf8');
        await writeFile(join(b.roots.dshHome, 'memories', 'MEMORY.md'), '# B 单方追加\n', 'utf8');

        const plan2 = diffFiles({
          baseline: r1.baseline.files,
          current: await hashMapOf(b.roots, mods),
          incoming: p2.incoming,
          modules: p2.manifest.modules,
        });

        assert.equal(plan2.counts.conflict, 1, '只有双方都改过的 AGENTS.md 才该冲突');
        assert.equal(plan2.conflicts[0].key, 'config:AGENTS.md');
        assert.equal(plan2.counts.keep, 1, 'B 单方改过的 MEMORY.md 该静默保留本地');
        assert.equal(plan2.counts.import, 0, 'A 没碰别的文件，没有该导入的');

        const before = await treeOf(b.roots, mods);
        const r2 = await applyPlan({
          roots: b.roots,
          plan: plan2,
          manifest: p2.manifest,
          incomingRoot: p2.incomingRoot,
          baseline: r1.baseline,
          resolutions: { 'config:AGENTS.md': 'local' },
        });

        assert.equal(r2.counts.failed, 0, JSON.stringify(r2.errors));
        assert.deepEqual(r2.conflictsUnresolved, [], '裁决之后不该还有悬空冲突');
        assert.equal(r2.counts.import, 0, '这次本来就没有该写的东西');
        assert.deepEqual(await treeOf(b.roots, mods), before, '既然没有该写的，就一个字节都不该变');
        assert.equal(await readFile(join(b.roots.dshHome, 'AGENTS.md'), 'utf8'), '# B 改过的规则\n');

        // ── 第三次：A 又改了一次 AGENTS.md 并打包
        // 用新基线再比，AGENTS.md 仍是真冲突（B 保留的本地版 vs A 的新版），MEMORY.md 则仍静默保留
        await writeFile(join(a.roots.dshHome, 'AGENTS.md'), '# A 又改了一次\n', 'utf8');
        const p3 = await packAndOpen(a.roots, mods, join(outDir, 'p3'));

        const plan3 = diffFiles({
          baseline: r2.baseline.files,
          current: await hashMapOf(b.roots, mods),
          incoming: p3.incoming,
          modules: p3.manifest.modules,
        });
        assert.equal(plan3.counts.conflict, 1, 'A 又改了 → B 保留的版本仍需裁决');
        assert.equal(plan3.conflicts[0].key, 'config:AGENTS.md');
        assert.equal(plan3.counts.keep, 1, 'MEMORY.md 仍然只该静默保留，不能反复打扰');

        // ── 这次裁决采用归档版，AGENTS.md 才应该真的被改写
        const r3 = await applyPlan({
          roots: b.roots,
          plan: plan3,
          manifest: p3.manifest,
          incomingRoot: p3.incomingRoot,
          baseline: r2.baseline,
          resolutions: { 'config:AGENTS.md': 'archive' },
        });
        assert.equal(r3.counts.failed, 0, JSON.stringify(r3.errors));
        assert.equal(r3.counts.import, 1);
        assert.equal(await readFile(join(b.roots.dshHome, 'AGENTS.md'), 'utf8'), '# A 又改了一次\n');
        assert.equal(await readFile(join(b.roots.dshHome, 'memories', 'MEMORY.md'), 'utf8'), '# B 单方追加\n');
        assert.equal(r3.snapshotFiles, 1, '覆盖前应当把 B 改过的原件快照下来');
        assert.equal(
          await readFile(join(r3.snapshotDir, 'dsh', 'AGENTS.md'), 'utf8'),
          '# B 改过的规则\n',
          '快照里必须是 B 的原件，不是归档版',
        );
      });
    });
  });
});

test('★ 选择性备份不会误删未勾选模块 —— 端到端复核', async () => {
  await withArchive(['skills'], async (ctx) => {
    await withFixture(async (target) => {
      // 目标机记忆丰富，但归档只含技能
      const memoriesBefore = await treeOf(target.roots, ['memory', 'todo']);
      assert.ok(Object.keys(memoriesBefore).length > 0);

      const incoming = incomingFromManifest(ctx.manifest);
      const plan = diffFiles({
        baseline: {},
        current: await hashMapOf(target.roots),
        incoming,
        modules: ctx.manifest.modules,
      });

      const res = await applyPlan({
        roots: target.roots,
        plan,
        manifest: ctx.manifest,
        incomingRoot: ctx.incomingRoot,
        baseline: { files: {} },
      });

      assert.equal(res.counts.failed, 0);
      assert.ok(res.counts.skip > 0, '未勾选模块的文件应当被跳过');
      assert.deepEqual(
        await treeOf(target.roots, ['memory', 'todo']),
        memoriesBefore,
        '只勾了技能，记忆和待办必须一动不动',
      );
    });
  });
});
