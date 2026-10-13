/**
 * settings.js 的测试。
 *
 * 这个文件管的是「备份目录 / 同步文件夹」记不记得住 —— 记不住的表现是
 * 「刷新一下历史版本就空了」，用户会以为备份丢了（真机踩过两次）。
 * 另一个坑是 **UTF-8 BOM**：Windows 的记事本 / PowerShell 5.1 会给 JSON 文件
 * 加 BOM，而 `JSON.parse("\uFEFF{…}")` 直接抛 → 设置被静默回默认值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  effective,
  loadSettings,
  saveSettings,
  settingsPathOf,
  stripBom,
} from '../lib/settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

async function tmpRoots() {
  const dir = await mkdtemp(join(PROJECT, '.tmp-settings-'));
  return { dir, roots: { dshHome: dir } };
}

/** 直接往设置文件写原文（父目录要自己建，settingsPathOf 只管拼路径）。 */
async function writeRawSettings(roots, text) {
  const file = settingsPathOf(roots);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}

test('stripBom：只吃开头那一个 BOM，别的一律不动', () => {
  assert.equal(stripBom('\uFEFF{}'), '{}');
  assert.equal(stripBom('{}'), '{}');
  assert.equal(stripBom(''), '');
  assert.equal(stripBom('a\uFEFFb'), 'a\uFEFFb', '中间的 BOM 字符不是文件头，不能动');
  assert.equal(stripBom(null), null);
  assert.equal(stripBom(undefined), undefined);
});

test('设置文件不存在时给默认值，且不标 corrupted', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    const s = await loadSettings(roots);
    assert.deepEqual(s, { ...DEFAULT_SETTINGS });
    assert.equal(s.corrupted, undefined, '文件不存在是正常情况，不是损坏');
    assert.equal(s.version, SETTINGS_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('存了再读要一模一样（outDir 必须记得住）', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    const saved = await saveSettings(roots, { outDir: 'D:\\my-backups', syncDir: 'E:\\cloud' });
    assert.equal(saved.outDir, 'D:\\my-backups');
    const loaded = await loadSettings(roots);
    assert.equal(loaded.outDir, 'D:\\my-backups');
    assert.equal(loaded.syncDir, 'E:\\cloud');
    assert.equal(loaded.corrupted, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('★ 设置文件带 UTF-8 BOM 时必须照常读出来（真机踩过）', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    const file = settingsPathOf(roots);
    // 模拟记事本 / PowerShell 5.1 的「UTF-8 with BOM」写法
    await writeRawSettings(roots, `\uFEFF${JSON.stringify({ version: 1, outDir: 'D:\\bom-dir' }, null, 2)}`);
    assert.ok(file.endsWith('settings.json'), file);

    const loaded = await loadSettings(roots);
    assert.equal(loaded.outDir, 'D:\\bom-dir', 'BOM 不该让设置失效');
    assert.equal(loaded.corrupted, undefined, 'BOM 不算损坏');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存时会丢掉 corrupted 标记，不再残留', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    await writeRawSettings(roots, '{ 坏掉的 JSON');
    const broken = await loadSettings(roots);
    assert.equal(broken.corrupted, true, '真损坏要报出来');

    await saveSettings(roots, { outDir: 'D:\\fixed' });
    const after = await loadSettings(roots);
    assert.equal(after.corrupted, undefined, '写回之后不该还标着损坏');
    assert.equal(after.outDir, 'D:\\fixed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真损坏（不是 BOM）时回默认值并标记 corrupted，不抛异常', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    await writeRawSettings(roots, '\uFEFF{ 这不是 JSON');
    const s = await loadSettings(roots);
    assert.equal(s.corrupted, true);
    assert.equal(s.outDir, DEFAULT_SETTINGS.outDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('顶层是数组/字符串/null 时也回默认值（不能当成设置对象合并）', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    for (const bad of ['[]', '"x"', 'null', '3']) {
      await writeRawSettings(roots, bad);
      const s = await loadSettings(roots);
      assert.equal(s.outDir, DEFAULT_SETTINGS.outDir, `${bad} 应回默认值`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存是原子写：临时文件不残留', async () => {
  const { dir, roots } = await tmpRoots();
  try {
    await saveSettings(roots, { outDir: 'D:\\a' });
    await saveSettings(roots, { outDir: 'D:\\b' });
    const file = settingsPathOf(roots);
    const raw = await readFile(file, 'utf8');
    assert.ok(raw.endsWith('\n'), '文件要以换行结尾');
    assert.equal(JSON.parse(raw).outDir, 'D:\\b', '后写的赢');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('effective：请求里的值优先，空串视为没传', () => {
  const settings = { outDir: 'D:\\from-settings', syncDir: 'E:\\sync' };
  assert.deepEqual(effective('D:\\from-request', undefined, settings), {
    outDir: 'D:\\from-request',
    syncDir: 'E:\\sync',
  });
  assert.deepEqual(effective('   ', '  ', settings), {
    outDir: 'D:\\from-settings',
    syncDir: 'E:\\sync',
  });
  assert.deepEqual(effective(undefined, undefined, { outDir: null, syncDir: null }), {
    outDir: undefined,
    syncDir: undefined,
  });
  assert.deepEqual(effective('  D:\\padded  ', undefined, settings).outDir, 'D:\\padded', '要去空白');
});

test('settingsPathOf 落在 <dshHome>/backup-sync/settings.json', () => {
  assert.equal(settingsPathOf({ dshHome: 'C:\\x\\.dsh' }), join('C:\\x\\.dsh', 'backup-sync', 'settings.json'));
});
