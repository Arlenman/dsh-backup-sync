/**
 * modules.js 的测试。
 *
 * 重点不是覆盖率，而是**抓住那个最容易做错的地方**：
 * 记忆与待办在同一棵树里交错，`projects/<hash>/` 下 MEMORY.md 与 TODOS.md
 * 是邻居却属于不同模块。这里逐个断言，将来加模式时也不会悄悄切重。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  MODULE_IDS,
  MODULE_META,
  countTodoEntries,
  isTodoPath,
  listModuleRoots,
  modulesFor,
  todoTrackOf,
} from '../lib/modules.js';
import { toPosix } from '../lib/paths.js';

/** 假的 roots，纯字符串比较，不碰真实磁盘。 */
const roots = {
  dshHome: 'C:/fake/.dsh',
  userHome: 'C:/fake',
  profile: 'desktop',
  agentsSkills: 'C:/fake/.agents/skills',
};
const MEMORIES = toPosix(join(roots.dshHome, 'memories'));
const PROFILE_DIR = toPosix(join(roots.dshHome, 'profiles', 'desktop'));

// ---------------------------------------------------------------- 待办模式

const TODO_PATHS = [
  'TODOS-life.md',
  'TODOS-work.md',
  'projects/0c4f6561d62a/TODOS.md',
  'daily/2026-10-13.todo.md',
];

const MEMORY_PATHS = [
  'MEMORY.md',
  'USER.md',
  'SUGGESTIONS.jsonl',
  'daily/2026-10-13.md',
  'projects/0c4f6561d62a/MEMORY.md',
  'projects/0c4f6561d62a/KEY.md',
  'advisor/instructions/a.md',
  'skills-state.json',
];

test('待办路径被认作待办', () => {
  for (const p of TODO_PATHS) assert.equal(isTodoPath(p), true, p);
});

test('记忆路径不被认作待办', () => {
  for (const p of MEMORY_PATHS) assert.equal(isTodoPath(p), false, p);
});

test('daily 下 .md 与 .todo.md 分属两个模块（只差一个后缀）', () => {
  assert.equal(isTodoPath('daily/2026-10-13.md'), false);
  assert.equal(isTodoPath('daily/2026-10-13.todo.md'), true);
});

test('projects/<hash>/ 下 MEMORY.md 与 TODOS.md 是邻居却分属不同模块', () => {
  assert.equal(isTodoPath('projects/0c4f6561d62a/MEMORY.md'), false);
  assert.equal(isTodoPath('projects/0c4f6561d62a/KEY.md'), false);
  assert.equal(isTodoPath('projects/0c4f6561d62a/TODOS.md'), true);
});

test('反斜杠路径同样能识别', () => {
  assert.equal(isTodoPath('projects\\0c4f6561d62a\\TODOS.md'), true);
  assert.equal(isTodoPath('daily\\2026-10-13.todo.md'), true);
});

test('四轨归属正确', () => {
  assert.equal(todoTrackOf('TODOS-life.md'), 'life');
  assert.equal(todoTrackOf('TODOS-work.md'), 'work');
  assert.equal(todoTrackOf('projects/0c4f6561d62a/TODOS.md'), 'project');
  assert.equal(todoTrackOf('daily/2026-10-13.todo.md'), 'daily');
  assert.equal(todoTrackOf('MEMORY.md'), null);
});

// ---------------------------------------------------------------- 互斥性

test('每个路径恰好被一个模块认领（互斥，不重不漏）', () => {
  const cases = [
    ...TODO_PATHS.map((p) => [MEMORIES, p, 'todo']),
    ...MEMORY_PATHS.map((p) => [MEMORIES, p, 'memory']),
    [PROFILE_DIR, 'package.json', 'plugins'],
    [PROFILE_DIR, 'pnpm-lock.yaml', 'plugins'],
    [PROFILE_DIR, '.npmrc', 'plugins'],
    [PROFILE_DIR, 'cordis.patch.yml', 'config'],
    [toPosix(roots.dshHome), 'settings.yaml', 'config'],
    [toPosix(roots.dshHome), 'AGENTS.md', 'config'],
  ];
  for (const [base, rel, expected] of cases) {
    const got = modulesFor(base, rel, roots);
    assert.deepEqual(got, [expected], `${base} :: ${rel}`);
  }
});

test('记忆与待办共用同一个根（同根不同谓词）', () => {
  const dshRoots = listModuleRoots(roots).filter((r) => toPosix(r.base) === MEMORIES);
  assert.equal(dshRoots.length, 2);
  assert.deepEqual(dshRoots.map((r) => r.moduleId).sort(), ['memory', 'todo']);
});

test('profile 里未被认领的文件（如 node_modules 内容）谁都不属于', () => {
  assert.deepEqual(modulesFor(PROFILE_DIR, 'node_modules/foo/index.js', roots), []);
  assert.deepEqual(modulesFor(PROFILE_DIR, 'cordis.yml', roots), []);
});

// ---------------------------------------------------------------- 计数口径

test('六个模块都有元信息，且对话默认不勾选', () => {
  for (const id of MODULE_IDS) {
    assert.ok(MODULE_META[id], id);
    assert.equal(typeof MODULE_META[id].label, 'string');
    assert.equal(typeof MODULE_META[id].note, 'string');
  }
  assert.equal(MODULE_META.sessions.defaultChecked, false);
  assert.equal(MODULE_META.skills.defaultChecked, true);
});

// ---------------------------------------------------------------- 待办条目计数

/** 真实文件格式：第一条 § 之前是说明注释，不是待办。 */
const TODO_TEXT = [
  '<!--',
  '待办条目格式说明（程序自动维护，请勿手改结构）：',
  '- 条目以 § 分隔；第一条 § 之前的本注释块是格式说明，不是待办',
  '- 每条待办的首行是元数据 tag：',
  '  [id: 8位十六进制] 条目的唯一标识',
  '-->',
  '',
  '§',
  '[2026-10-07 13:59] [id: bd05fb63] [due: 2026-10-10] [status: done] [cat: 运维]',
  '重启后删除某个被锁定的目录',
  '§',
  '[2026-10-07 14:18] [id: 52cb5fe9] [status: pending]',
  '确认是否加日志轮转',
  '',
].join('\n');

test('说明注释块不算待办', () => {
  assert.equal(countTodoEntries(TODO_TEXT), 2);
});

test('只有说明块、没有条目时为 0', () => {
  assert.equal(countTodoEntries('<!--\n说明\n-->\n'), 0);
  assert.equal(countTodoEntries(''), 0);
});

test('多行条目只算一条', () => {
  const text = '<!-- x -->\n§\n[id: aaaaaaaa]\n第一行\n第二行\n第三行\n';
  assert.equal(countTodoEntries(text), 1);
});

test('§ 缩进或带空白也能分隔', () => {
  const text = '<!-- x -->\n  §  \n[id: aaaaaaaa]\n内容\n';
  assert.equal(countTodoEntries(text), 1);
});
