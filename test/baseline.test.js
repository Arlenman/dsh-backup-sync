/**
 * baseline.js 的测试。
 *
 * 最要紧的一条：**损坏的基线不能被静默当成空基线**。
 * 若静默处理，用户换机后第一次导入会把所有差异判成冲突却毫无提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_VERSION,
  emptyBaseline,
  filesFromEntries,
  keyOf,
  loadBaseline,
  saveBaseline,
} from '../lib/baseline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

async function tmpdir() {
  return mkdtemp(join(PROJECT, '.tmp-baseline-'));
}

test('keyOf 统一成正斜杠', () => {
  assert.equal(keyOf('skills', 'foo\\SKILL.md'), 'skills:foo/SKILL.md');
  assert.equal(keyOf('todo', 'daily/2026-10-13.todo.md'), 'todo:daily/2026-10-13.todo.md');
});

test('文件不存在 → 正常返回空基线，不是错误', async () => {
  const dir = await tmpdir();
  try {
    const r = await loadBaseline(join(dir, 'nope.json'));
    assert.equal(r.ok, true);
    assert.equal(r.exists, false);
    assert.equal(r.corrupted, false);
    assert.deepEqual(r.data.files, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSON 损坏 → ok=false 且 corrupted=true（绝不静默）', async () => {
  const dir = await tmpdir();
  try {
    const f = join(dir, 'state.json');
    await writeFile(f, '{ 这不是 JSON', 'utf8');
    const r = await loadBaseline(f);
    assert.equal(r.ok, false);
    assert.equal(r.corrupted, true);
    assert.equal(r.exists, true);
    assert.match(r.error, /JSON 解析失败/);
    // 仍然给出一份可用的空基线，方便调用方降级运行
    assert.deepEqual(r.data.files, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('结构不对（缺 files）→ corrupted', async () => {
  const dir = await tmpdir();
  try {
    const f = join(dir, 'state.json');
    await writeFile(f, JSON.stringify({ version: 1 }), 'utf8');
    const r = await loadBaseline(f);
    assert.equal(r.corrupted, true);
    assert.match(r.error, /files/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('版本高于本插件支持 → corrupted（不猜测未来格式）', async () => {
  const dir = await tmpdir();
  try {
    const f = join(dir, 'state.json');
    await writeFile(f, JSON.stringify({ version: 99, files: {} }), 'utf8');
    const r = await loadBaseline(f);
    assert.equal(r.corrupted, true);
    assert.match(r.error, /99/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('正常往返：写入后读回内容一致', async () => {
  const dir = await tmpdir();
  try {
    const f = join(dir, 'state.json');
    const data = emptyBaseline('测试机');
    data.files['skills:a/SKILL.md'] = { sha256: 'deadbeef', size: 10, mtimeMs: 123 };
    data.lastSyncAt = 456;
    await saveBaseline(f, data);

    const r = await loadBaseline(f);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.corrupted, false);
    assert.equal(r.data.machine, '测试机');
    assert.equal(r.data.lastSyncAt, 456);
    assert.deepEqual(r.data.files['skills:a/SKILL.md'], { sha256: 'deadbeef', size: 10, mtimeMs: 123 });
    assert.equal(r.data.version, BASELINE_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写：失败不留半截文件，成功不留 tmp 残留', async () => {
  const dir = await tmpdir();
  try {
    const f = join(dir, 'nested', 'state.json');
    await saveBaseline(f, emptyBaseline());
    await saveBaseline(f, emptyBaseline('第二次')); // 覆盖已存在的文件
    const leftovers = (await readdir(join(dir, 'nested'))).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], `残留临时文件：${leftovers.join(', ')}`);
    const r = await loadBaseline(f);
    assert.equal(r.data.machine, '第二次');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveBaseline 自动建父目录', async () => {
  const dir = await tmpdir();
  try {
    const f = join(dir, 'a', 'b', 'c', 'state.json');
    await saveBaseline(f, emptyBaseline());
    const raw = await readFile(f, 'utf8');
    assert.match(raw, /"version": 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filesFromEntries 按键归并', () => {
  const files = filesFromEntries([
    { moduleId: 'skills', relPath: 'a/SKILL.md', sha256: '11', size: 1, mtimeMs: 1 },
    { moduleId: 'todo', relPath: 'daily/2026-10-13.todo.md', sha256: '22', size: 2, mtimeMs: 2 },
  ]);
  assert.deepEqual(Object.keys(files).sort(), ['skills:a/SKILL.md', 'todo:daily/2026-10-13.todo.md']);
});
