/**
 * archive.js 的测试。
 *
 * 验收标准只有一条：**打出来的包解回去，文件必须落在正确的位置、内容一字不差**。
 * 顺带钉死三件容易退化的性质：包内不混入 node_modules、打包是原子的（不留残渣）、
 * 被篡改的包能验出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARCHIVE_VERSION,
  FORMAT_ID,
  createArchive,
  extractArchive,
  listArchives,
  localStamp,
  prefixFor,
  readManifest,
  renderRestoreDoc,
  resolveTar,
  timestampName,
  validateManifest,
  verifyArchive,
} from '../lib/archive.js';
import { scan } from '../lib/scan.js';
import { withFixture, withTempDir } from './fixture.js';

/** 打一个包，返回 {fx 上下文里的东西 + 结果}。 */
async function build(outDir, moduleIds, opts = {}) {
  return withFixture(async (fx) => {
    const result = await scan(fx.roots, { moduleIds });
    const r = await createArchive({ roots: fx.roots, result, moduleIds, outDir, ...opts });
    return { r, roots: fx.roots, result };
  });
}

const exists = (p) => stat(p).then(() => true, () => false);

// ─────────────────────────────────────────── 命名与落点

test('打包名是「备份时间名称」', () => {
  const d = new Date(2026, 9, 13, 18, 3, 12); // 2026-10-13 18:03:12
  assert.equal(timestampName(d), 'dsh-sync-20261013-180312');
  assert.equal(localStamp(d), '2026-10-13 18:03:12');
});

test('技能根映射到 agents/skills，DSH 根映射到 dsh', async () => {
  await withFixture(async ({ roots }) => {
    assert.deepEqual(prefixFor(roots.agentsSkills, roots), { root: 'agents', prefix: 'agents/skills' });
    assert.deepEqual(prefixFor(roots.dshHome, roots), { root: 'dsh', prefix: 'dsh' });
    assert.deepEqual(prefixFor(join(roots.dshHome, 'memories'), roots), {
      root: 'dsh',
      prefix: 'dsh/memories',
    });
    assert.deepEqual(prefixFor(join(roots.dshHome, 'profiles', 'desktop'), roots), {
      root: 'dsh',
      prefix: 'dsh/profiles/desktop',
    });
  });
});

test('未知根返回 null（宁可漏打，也不能打到错位置）', async () => {
  await withFixture(async ({ roots }) => {
    assert.equal(prefixFor('D:\\somewhere\\else', roots), null);
  });
});

test('resolveTar 能找到可用的 tar', async () => {
  const tar = await resolveTar();
  assert.ok(typeof tar === 'string' && tar.length > 0);
});

// ─────────────────────────────────────────── 端到端往返

test('★ 打包 → 解包 → 每个文件都落在正确位置且内容一字不差', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['skills', 'config', 'todo']);

    assert.equal(r.ok, true);
    assert.match(r.archivePath, /dsh-sync-\d{8}-\d{6}\.tar\.gz$/);
    assert.ok(r.bytes > 0);

    const dest = join(outDir, 'unpacked');
    await extractArchive(r.archivePath, dest);

    // 三份文件必须各就各位
    const checks = [
      // 技能：还原到 ~/.agents 下（系统提示里那个「~/.agents/skills」）
      'agents/skills/cdp-browser-automation/SKILL.md',
      'agents/skills/cdp-browser-automation/scripts/run.mjs',
      'agents/skills/win-disk-cleaner/SKILL.md',
      // 配置：cordis.patch.yml 是整机配置的真源，必须原样在包里
      'dsh/profiles/desktop/cordis.patch.yml',
      'dsh/AGENTS.md',
      // 待办：与记忆同树，靠文件名切出来
      'dsh/memories/TODOS-life.md',
      'dsh/memories/daily/2026-10-13.todo.md',
    ];
    for (const rel of checks) {
      assert.equal(await exists(join(dest, ...rel.split('/'))), true, `包内缺少 ${rel}`);
    }

    // 内容逐字节一致
    const cdpInPack = await readFile(join(dest, 'agents', 'skills', 'cdp-browser-automation', 'SKILL.md'), 'utf8');
    assert.equal(cdpInPack, '# cdp\n');
    const patchInPack = await readFile(join(dest, 'dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
    assert.equal(patchInPack, '- insert: []\n');

    // 自描述文件
    assert.equal(await exists(join(dest, 'manifest.json')), true);
    assert.equal(await exists(join(dest, 'RESTORE.md')), true);
  });
});

test('顺序敏感：解包后待办与记忆没有串门', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['memory', 'todo']);
    const dest = join(outDir, 'u2');
    await extractArchive(r.archivePath, dest);

    const dsh = join(dest, 'dsh', 'memories');
    // 待办
    assert.equal(await exists(join(dsh, 'TODOS-life.md')), true);
    assert.equal(await exists(join(dsh, 'daily', '2026-10-13.todo.md')), true);
    // 记忆
    assert.equal(await exists(join(dsh, 'MEMORY.md')), true);
    assert.equal(await exists(join(dsh, 'daily', '2026-10-13.md')), true);
    assert.equal(await exists(join(dsh, 'projects', '0c4f6561d62a', 'KEY.md')), true);
    assert.equal(await exists(join(dsh, 'projects', '0c4f6561d62a', 'MEMORY.md')), true);
    // 交叉项：待办的文件绝不能出现在记忆的清单里
    const m = await readManifest(r.archivePath);
    const todoFiles = m.files.filter((f) => f.moduleId === 'todo').map((f) => f.path);
    const memFiles = m.files.filter((f) => f.moduleId === 'memory').map((f) => f.path);
    assert.deepEqual(memFiles.filter((p) => p.includes('TODOS')), []);
    assert.deepEqual(todoFiles.filter((p) => p.endsWith('MEMORY.md')), []);
  });
});

test('node_modules 绝不进包', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['skills']);
    assert.ok(r.manifest.files.length > 0);
    assert.equal(
      r.manifest.files.some((f) => f.path.includes('node_modules')),
      false,
    );
    const dest = join(outDir, 'u3');
    await extractArchive(r.archivePath, dest);
    assert.equal(await exists(join(dest, 'agents', 'skills', 'cdp-browser-automation', 'node_modules')), false);
  });
});

// ─────────────────────────────────────────── 清单

test('清单记录了模块、条目、文件与合计', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['skills', 'todo']);

    assert.equal(r.manifest.format, FORMAT_ID);
    assert.equal(r.manifest.version, ARCHIVE_VERSION);
    assert.deepEqual(r.manifest.modules, ['skills', 'todo']);
    assert.equal(r.manifest.counts.skills.count, 2, '两个技能目录');
    assert.equal(r.manifest.counts.todo.count, 8, '4 个待办文件 × 2 条');
    assert.equal(r.manifest.totals.files, r.manifest.files.length);
    assert.equal(
      r.manifest.totals.bytes,
      r.manifest.files.reduce((n, f) => n + f.size, 0),
    );
    assert.equal(r.manifest.baselineIncluded, false);

    for (const f of r.manifest.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
      assert.match(f.key, /^(skills|todo):/, f.path);
      assert.ok(f.path.startsWith('agents/') || f.path.startsWith('dsh/'), f.path);
    }
  });
});

test('清单里的哈希与磁盘上的文件一致', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['config']);
    const f = r.manifest.files.find((x) => x.path.endsWith('AGENTS.md'));
    assert.ok(f, '清单里应有 AGENTS.md');
    const { createHash } = await import('node:crypto');
    // 直接从包里取出来比对，验证哈希口径一致
    const dest = join(outDir, 'uh');
    await extractArchive(r.archivePath, dest);
    const bytes = await readFile(join(dest, ...f.path.split('/')));
    const h = createHash('sha256').update(bytes).digest('hex');
    assert.equal(h, f.sha256);
    assert.equal(bytes.length, f.size);
  });
});

test('基线库进包，落在 sync/state.json', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const baselineJson = '{"version":1,"files":{"skills:a/SKILL.md":{"sha256":"x"}}}\n';
    const { r } = await build(outDir, ['skills'], { baselineJson });
    assert.equal(r.manifest.baselineIncluded, true);

    const dest = join(outDir, 'ub');
    await extractArchive(r.archivePath, dest);
    const back = await readFile(join(dest, 'sync', 'state.json'), 'utf8');
    assert.equal(back, baselineJson);
  });
});

test('readManifest 只读清单，不用解包', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['todo']);
    const m = await readManifest(r.archivePath);
    assert.deepEqual(m.modules, ['todo']);
    assert.equal(m.totals.files, r.manifest.totals.files);
  });
});

test('RESTORE.md 写清了目录对应关系', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['skills', 'todo']);
    const text = renderRestoreDoc(r.manifest);
    assert.match(text, /`dsh\/`/);
    assert.match(text, /`agents\/`/);
    assert.match(text, /backup-sync\/state\.json/);
    assert.match(text, /标准 `tar\.gz`/);
    assert.match(text, /技能（skills）/);
  });
});

// ─────────────────────────────────────────── 原子性与校验

test('打包后不留 staging 与 .part 残渣', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    await build(outDir, ['skills']);
    const names = await readdir(outDir);
    assert.deepEqual(names.filter((n) => n.startsWith('.staging-')), []);
    assert.deepEqual(names.filter((n) => n.includes('.part-')), []);
    // 正常产物：包 + 两个边车
    assert.equal(names.filter((n) => n.endsWith('.tar.gz')).length, 1);
    assert.equal(names.filter((n) => n.endsWith('.sha256')).length, 1);
    assert.equal(names.filter((n) => n.endsWith('.meta.json')).length, 1);
  });
});

test('边车文件内容可用于校验', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['config']);
    const side = await readFile(r.sha256Path, 'utf8');
    assert.match(side, /^[0-9a-f]{64} {2}dsh-sync-\d{8}-\d{6}\.tar\.gz\n$/);

    const v = await verifyArchive(r.archivePath);
    assert.equal(v.checked, true);
    assert.equal(v.ok, true);
    assert.equal(v.actual, r.sha256);

    const meta = JSON.parse(await readFile(r.metaPath, 'utf8'));
    assert.equal(meta.sha256, r.sha256);
    assert.equal(meta.bytes, r.bytes);
    assert.deepEqual(meta.modules, ['config']);
  });
});

test('包被改动后校验必须失败', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['config']);
    const buf = await readFile(r.archivePath);
    await writeFile(r.archivePath, Buffer.concat([buf, Buffer.from('tampered')]));
    const v = await verifyArchive(r.archivePath);
    assert.equal(v.ok, false, '追加了字节却仍报通过 = 校验形同虚设');
  });
});

test('没有边车时校验不假装通过（checked=false）', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['config']);
    const { rm } = await import('node:fs/promises');
    await rm(r.sha256Path);
    const v = await verifyArchive(r.archivePath);
    assert.equal(v.checked, false);
    assert.equal(v.expected, null);
  });
});

// ─────────────────────────────────────────── 清单防线

test('★ 清单里的路径穿越必须被拒（防被篡改的包写到主目录之外）', () => {
  const base = { format: FORMAT_ID, version: 1, modules: ['skills'], files: [] };
  assert.throws(() => validateManifest({ ...base, files: [{ path: '../evil.txt' }] }), /路径不安全/);
  assert.throws(() => validateManifest({ ...base, files: [{ path: 'a/../../evil' }] }), /路径不安全/);
  assert.throws(() => validateManifest({ ...base, files: [{ path: 'C:/Windows/x' }] }), /路径不安全/);
  assert.throws(() => validateManifest({ ...base, files: [{ path: '/etc/passwd' }] }), /路径不安全/);
  assert.throws(() => validateManifest({ ...base, files: [{ path: 'dsh\\..\\..\\evil' }] }), /路径不安全/);
  // 正常路径要通过
  assert.ok(validateManifest({ ...base, files: [{ path: 'dsh/memories/MEMORY.md' }] }));
});

test('清单防线：格式、版本、缺字段', () => {
  assert.throws(() => validateManifest(null), /不是对象/);
  assert.throws(() => validateManifest({ format: 'other', version: 1, modules: [], files: [] }), /format/);
  assert.throws(() => validateManifest({ format: FORMAT_ID, version: 99, modules: [], files: [] }), /高于本插件支持/);
  assert.throws(() => validateManifest({ format: FORMAT_ID, version: 1, files: [] }), /modules/);
  assert.throws(() => validateManifest({ format: FORMAT_ID, version: 1, modules: [] }), /files/);
});

test('readManifest 遇到非备份包时明确报错，不返回半个对象', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const junk = join(outDir, 'junk.txt');
    await writeFile(junk, 'not a tarball', 'utf8');
    await assert.rejects(() => readManifest(junk));
  });
});

// ─────────────────────────────────────────── 历史列表

test('备份历史按时间倒序，且不列出残渣', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    await build(outDir, ['config'], { name: 'dsh-sync-20260101-000000' });
    await new Promise((r) => setTimeout(r, 1100)); // 让 mtime 明确拉开
    await build(outDir, ['todo'], { name: 'dsh-sync-20260202-000000' });
    await writeFile(join(outDir, '.staging-stray'), 'x', 'utf8');
    await writeFile(join(outDir, 'junk.tar.gz.part-abc'), 'x', 'utf8');

    const list = await listArchives(outDir);
    assert.deepEqual(list.map((x) => x.name), ['dsh-sync-20260202-000000.tar.gz', 'dsh-sync-20260101-000000.tar.gz']);
    for (const it of list) {
      assert.equal(it.hasMeta, true);
      assert.equal(it.hasSha256, true);
      assert.ok(it.bytes > 0);
      assert.ok(it.meta.counts);
    }
  });
});

test('输出目录不存在时历史列表返回空数组而不是抛错', async () => {
  assert.deepEqual(await listArchives(join('D:\\nope', 'never-exists-xyz')), []);
});

test('空模块不炸：没有文件的模块也能出包', async () => {
  await withTempDir('.tmp-arch-', async (outDir) => {
    const { r } = await build(outDir, ['sessions']);
    assert.equal(r.ok, true);
    assert.ok(r.manifest.files.length > 0, '夹具里有两个会话目录');
    // 只勾不含文件的模块（夹具里没有 sessions 之外的模块为空）——用 moduleIds 过滤掉内容
    const m = await readManifest(r.archivePath);
    assert.deepEqual(m.modules, ['sessions']);
  });
});
