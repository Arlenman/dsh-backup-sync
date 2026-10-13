/**
 * diff.js 的测试。
 *
 * 这是全项目最容易出错的地方，所以**十三种组合逐个断言，一种不漏**，
 * 外加一条专门堵「选择性备份被误判成删除」的护栏测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, describePlan, diffFiles, parseKey } from '../lib/diff.js';

const KEY = 'skills:a/SKILL.md';

/** 造一份「单键」比较，返回该键的动作。 */
function one({ base = null, ours = null, theirs = null, modules = ['skills'], allowDelete = false }) {
  const pack = (v) => (v === null ? {} : { [KEY]: { sha256: v } });
  const r = diffFiles({
    baseline: pack(base),
    current: pack(ours),
    incoming: pack(theirs),
    modules,
    allowDelete,
  });
  assert.equal(r.actions.length, 1);
  return r.actions[0];
}

// ─────────────────────────────────────────── 十三种组合

test('① 基线无 / 本地无 / 归档有 → 导入（归档新增）', () => {
  const a = one({ base: null, ours: null, theirs: 't1' });
  assert.equal(a.action, 'import');
});

test('② 基线无 / 本地有 / 归档无 → 保留本地（本地新增）', () => {
  const a = one({ base: null, ours: 'o1', theirs: null });
  assert.equal(a.action, 'keep');
});

test('③ 基线无 / 本地有 / 归档有 / 内容相同 → 无变化', () => {
  const a = one({ base: null, ours: 'x', theirs: 'x' });
  assert.equal(a.action, 'same');
});

test('④ 基线无 / 本地有 / 归档有 / 内容不同 → 冲突', () => {
  const a = one({ base: null, ours: 'o1', theirs: 't1' });
  assert.equal(a.action, 'conflict');
});

test('⑤ 三方完全相同 → 无变化', () => {
  const a = one({ base: 'b1', ours: 'b1', theirs: 'b1' });
  assert.equal(a.action, 'same');
});

test('⑥ 基线有 / 本地未改 / 归档改了 → 导入', () => {
  const a = one({ base: 'b1', ours: 'b1', theirs: 't1' });
  assert.equal(a.action, 'import');
});

test('⑦ 基线有 / 本地改了 / 归档未改 → 保留本地', () => {
  const a = one({ base: 'b1', ours: 'o1', theirs: 'b1' });
  assert.equal(a.action, 'keep');
});

test('⑧ 基线有 / 双方都改且不同 → 冲突', () => {
  const a = one({ base: 'b1', ours: 'o1', theirs: 't1' });
  assert.equal(a.action, 'conflict');
});

test('⑨ 基线有 / 双方都改但结果相同 → 无变化（不该报冲突）', () => {
  const a = one({ base: 'b1', ours: 'o1', theirs: 'o1' });
  assert.equal(a.action, 'same');
});

test('⑩ 本地删了 / 归档未改 → 保持删除', () => {
  const a = one({ base: 'b1', ours: null, theirs: 'b1' });
  assert.equal(a.action, 'keep');
});

test('⑪ 本地删了 / 归档改了 → 冲突', () => {
  const a = one({ base: 'b1', ours: null, theirs: 't1' });
  assert.equal(a.action, 'conflict');
});

test('⑫ 双方都删了 → 无变化', () => {
  const a = one({ base: 'b1', ours: null, theirs: null });
  assert.equal(a.action, 'same');
});

test('⑬ 归档删了 / 本地未改 → 默认保守保留，不删本地', () => {
  const a = one({ base: 'b1', ours: 'b1', theirs: null });
  assert.equal(a.action, 'keep', '默认 allowDelete=false 时必须保留');
  assert.match(a.reason, /未启用删除/);
});

test('⑬-b 归档删了 / 本地未改 / 显式开删除 → 才跟随删除', () => {
  const a = one({ base: 'b1', ours: 'b1', theirs: null, allowDelete: true });
  assert.equal(a.action, 'delete');
});

test('⑬-c 归档删了 / 本地改了 → 无论是否允许删除，都是冲突', () => {
  assert.equal(one({ base: 'b1', ours: 'o1', theirs: null, allowDelete: true }).action, 'conflict');
  assert.equal(one({ base: 'b1', ours: 'o1', theirs: null, allowDelete: false }).action, 'conflict');
});

test('十三种存在性组合的动作逐行核对', () => {
  const rows = [
    [null, null, 't1', 'import'],
    [null, 'o1', null, 'keep'],
    [null, 'x', 'x', 'same'],
    [null, 'o1', 't1', 'conflict'],
    ['b1', 'b1', 'b1', 'same'],
    ['b1', 'b1', 't1', 'import'],
    ['b1', 'o1', 'b1', 'keep'],
    ['b1', 'o1', 't1', 'conflict'],
    ['b1', 'o1', 'o1', 'same'],
    ['b1', null, 'b1', 'keep'],
    ['b1', null, 't1', 'conflict'],
    ['b1', null, null, 'same'],
    ['b1', 'b1', null, 'keep'],
  ];
  for (const [base, ours, theirs, expected] of rows) {
    assert.equal(
      one({ base, ours, theirs }).action,
      expected,
      `base=${base} ours=${ours} theirs=${theirs}`,
    );
  }
});

test('真冲突恰好四种，缺一不可、多一不可', () => {
  const conflictCases = [
    ['双方各自新增且内容不同', null, 'o1', 't1'],
    ['双方都改且结果不同', 'b1', 'o1', 't1'],
    ['本地删了、归档改了它', 'b1', null, 't1'],
    ['归档删了、本地改了它', 'b1', 'o1', null],
  ];
  for (const [name, base, ours, theirs] of conflictCases) {
    assert.equal(one({ base, ours, theirs, allowDelete: true }).action, 'conflict', name);
  }

  // 每一种冲突都有「只差一点点」的邻居，必须落到别的动作上
  const nearMisses = [
    ['双方各自新增但内容相同', null, 'x', 'x', 'same'],
    ['双方都改但结果相同', 'b1', 'o1', 'o1', 'same'],
    ['本地删了、归档没动', 'b1', null, 'b1', 'keep'],
    ['归档删了、本地没动', 'b1', 'b1', null, 'delete'],
  ];
  for (const [name, base, ours, theirs, expected] of nearMisses) {
    assert.equal(one({ base, ours, theirs, allowDelete: true }).action, expected, name);
  }
});

// ─────────────────────────────────────────── 护栏：选择性备份

test('★ 归档未包含的模块，无论本地怎样都不许删（选择性备份陷阱）', () => {
  const baseline = { 'sessions:s1/a.jsonl': { sha256: 'b1' } };
  const current = { 'sessions:s1/a.jsonl': { sha256: 'b1' } };
  const incoming = {}; // 归档里只有 skills，没有 sessions

  const r = diffFiles({ baseline, current, incoming, modules: ['skills'], allowDelete: true });

  assert.equal(r.counts.delete, 0, '绝不能因为归档没含 sessions 就删本地会话');
  assert.equal(r.counts.skip, 1);
  assert.equal(r.actions[0].action, 'skip');
  assert.match(r.actions[0].reason, /sessions/);
});

test('★ 记忆与待办同树时，只勾了待办不会碰记忆', () => {
  const baseline = { 'memory:MEMORY.md': { sha256: 'm1' }, 'todo:TODOS.md': { sha256: 't1' } };
  const current = { 'memory:MEMORY.md': { sha256: 'm2' }, 'todo:TODOS.md': { sha256: 't1' } };
  const incoming = { 'todo:TODOS.md': { sha256: 't2' } };

  const r = diffFiles({ baseline, current, incoming, modules: ['todo'] });
  const byKey = Object.fromEntries(r.actions.map((a) => [a.key, a.action]));
  assert.equal(byKey['memory:MEMORY.md'], 'skip');
  assert.equal(byKey['todo:TODOS.md'], 'import');
});

test('modules 传 null 时不做范围限制（全量归档）', () => {
  const r = diffFiles({
    baseline: {},
    current: { 'sessions:s1/a': { sha256: 'o1' } },
    incoming: {},
    modules: null,
  });
  assert.equal(r.counts.skip, 0);
  assert.equal(r.actions[0].action, 'keep');
});

// ─────────────────────────────────────────── 键与汇总

test('parseKey 只切第一个冒号（路径里可能有冒号）', () => {
  assert.deepEqual(parseKey('skills:a/SKILL.md'), { moduleId: 'skills', relPath: 'a/SKILL.md' });
  assert.deepEqual(parseKey('config:profiles/desktop/cordis.patch.yml'), {
    moduleId: 'config',
    relPath: 'profiles/desktop/cordis.patch.yml',
  });
});

test('counts 覆盖全部动作且总数等于键数', () => {
  const r = diffFiles({
    baseline: { 'skills:a': { sha256: 'b' } },
    current: { 'skills:a': { sha256: 'b' }, 'skills:new': { sha256: 'n' } },
    incoming: { 'skills:a': { sha256: 't' }, 'skills:b': { sha256: 'x' } },
    modules: ['skills'],
  });
  assert.deepEqual(Object.keys(r.counts).sort(), [...ACTIONS].sort());
  const total = ACTIONS.reduce((n, k) => n + r.counts[k], 0);
  assert.equal(total, 3);
  assert.deepEqual(r.counts, { import: 2, keep: 1, delete: 0, conflict: 0, same: 0, skip: 0 });
});

test('conflicts 与 pending 只挑对应动作', () => {
  const r = diffFiles({
    baseline: { 'skills:a': { sha256: 'b1' }, 'skills:z': { sha256: 'b9' } },
    current: { 'skills:a': { sha256: 'o1' }, 'skills:z': { sha256: 'b9' } },
    incoming: { 'skills:a': { sha256: 't1' }, 'skills:z': { sha256: 'b9' } },
    modules: ['skills'],
  });
  assert.deepEqual(r.conflicts.map((a) => a.key), ['skills:a']);
  assert.deepEqual(r.pending, []);
});

test('describePlan 给出一行摘要', () => {
  const r = diffFiles({
    baseline: {},
    current: { 'skills:a': { sha256: 'o' } },
    incoming: { 'skills:b': { sha256: 't' } },
    modules: ['skills'],
  });
  assert.equal(describePlan(r), '导入 1 · 保留本地 1');
  assert.equal(describePlan(diffFiles({ modules: ['skills'] })), '没有任何差异');
});

test('空输入不炸', () => {
  const r = diffFiles();
  assert.deepEqual(r.actions, []);
  assert.equal(describePlan(r), '没有任何差异');
});
