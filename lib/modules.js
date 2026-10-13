/**
 * 模块 → 文件清单映射。
 *
 * ## 核心约束：模块按【文件模式】划分，不按目录划分
 *
 * 记忆与待办同居 `<dshHome>/memories/` 一棵树里，只能靠文件名区分：
 *
 *   daily/2026-10-13.md          → 记忆
 *   daily/2026-10-13.todo.md     → 待办
 *   projects/<hash>/MEMORY.md    → 记忆
 *   projects/<hash>/KEY.md       → 记忆
 *   projects/<hash>/TODOS.md     → 待办
 *
 * 按目录切分必然切错 —— `projects/<hash>/` 下 MEMORY.md 与 TODOS.md 是**邻居，
 * 却属于两个不同模块**。这是整个设计里最容易做错的地方。
 *
 * ## 技能不在 ~/.dsh 里
 *
 * 技能库在 `<userHome>/.agents/skills`。这正是本插件存在的首要理由 ——
 * `@xiaoyuyu6420/dsh-backup` 的 `BACKUP_TYPES.skills` 指向 `~/.dsh/skills`
 * （本机该目录根本不存在），所以它一个技能都备不到。
 */
import { join } from 'node:path';
import { toPosix } from './paths.js';

/** @typedef {'skills'|'plugins'|'config'|'memory'|'todo'|'sessions'} ModuleId */

/** @type {ModuleId[]} */
export const MODULE_IDS = ['skills', 'plugins', 'config', 'memory', 'todo', 'sessions'];

/**
 * @typedef {object} ModuleMeta
 * @property {string} label          界面上显示的中文名
 * @property {'file'|'dir'|'entry'} countKind 计数口径
 * @property {number} [dirDepth]     countKind='dir' 时统计到第几层目录（默认 1）
 * @property {boolean} defaultChecked 默认是否勾选
 * @property {string} note           界面上的说明
 */

/** @type {Record<ModuleId, ModuleMeta>} */
export const MODULE_META = {
  skills: {
    label: '技能',
    countKind: 'dir',
    dirDepth: 1,
    defaultChecked: true,
    note: '工作流本体，位于 ~/.agents/skills',
  },
  plugins: {
    label: '插件',
    countKind: 'file',
    defaultChecked: true,
    note: 'bundles 清单 + 依赖锁 + .npmrc',
  },
  config: {
    label: '配置',
    countKind: 'file',
    defaultChecked: true,
    note: 'cordis.patch.yml 等核心配置',
  },
  memory: {
    label: '记忆',
    countKind: 'file',
    defaultChecked: true,
    note: 'MEMORY / USER / KEY / daily',
  },
  todo: {
    label: '待办',
    countKind: 'entry',
    defaultChecked: true,
    note: '四轨：life / work / project / daily',
  },
  sessions: {
    label: '对话',
    countKind: 'dir',
    dirDepth: 2,
    defaultChecked: false,
    note: '本地专用 · 不上云',
  },
};

/**
 * 待办的四个文件模式（相对 `memories/` 的 POSIX 路径）。
 * 与 `dsh-memory-evolve/lib/sync/filesets.js` 的口径一致：
 * `TODOS.md` / `TODOS-life.md` / `TODOS-work.md` / `daily/YYYY-MM-DD.todo.md`。
 */
const TODO_PATTERNS = [
  /^TODOS-life\.md$/,
  /^TODOS-work\.md$/,
  /^projects\/[0-9a-f]+\/TODOS\.md$/,
  /^daily\/\d{4}-\d{2}-\d{2}\.todo\.md$/,
];

/** 判定 `memories/` 下的相对路径是否属于待办。 */
export function isTodoPath(relPath) {
  const p = toPosix(relPath);
  return TODO_PATTERNS.some((re) => re.test(p));
}

/**
 * 判定待办属于哪一轨（仅对待办路径有意义）。
 * @returns {'life'|'work'|'project'|'daily'|null}
 */
export function todoTrackOf(relPath) {
  const p = toPosix(relPath);
  if (p === 'TODOS-life.md') return 'life';
  if (p === 'TODOS-work.md') return 'work';
  if (/^projects\/[0-9a-f]+\/TODOS\.md$/.test(p)) return 'project';
  if (/^daily\/\d{4}-\d{2}-\d{2}\.todo\.md$/.test(p)) return 'daily';
  return null;
}

/**
 * 数待办条目。
 *
 * 文件格式（由文件头部的说明注释定义，程序自动维护）：
 *   - 第一条 `§` **之前**是格式说明注释块，**不是待办**
 *   - 之后每个独占一行的 `§` 分隔一个条目
 *   - 条目的首行是元数据 tag，其中必有 `[id: 8位十六进制]`
 *
 * @param {string} text
 * @returns {number}
 */
export function countTodoEntries(text) {
  const chunks = String(text).split(/^[ \t]*§[ \t]*$/m);
  if (chunks.length <= 1) return 0; // 只有说明块、一个 § 都没有
  return chunks.slice(1).filter((c) => /\[id:\s*[0-9a-f]{8}\]/i.test(c)).length;
}

/** profile 里属于「插件」模块的文件（相对 profile 目录）。 */
const PLUGIN_FILES = new Set(['package.json', 'pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml']);

/** `<dshHome>` 下属于「配置」模块的文件。 */
const CONFIG_FILES = new Set(['settings.yaml', 'AGENTS.md']);

/**
 * 展开成「扫描根」列表。
 *
 * 同一模块可以有多个根（配置就同时落在 profile 目录和 dshHome）；
 * 同一个根也可以被多个模块共用（memories 同时供给 memory 与 todo，
 * 靠 include 谓词互斥切分）。
 *
 * @param {import('./paths.js').Roots} roots
 * @returns {{moduleId: ModuleId, base: string, include: (rel: string) => boolean}[]}
 */
export function listModuleRoots(roots) {
  const { dshHome, agentsSkills, profile } = roots;
  const profileDir = join(dshHome, 'profiles', profile);
  const memories = join(dshHome, 'memories');

  return [
    { moduleId: 'skills', base: agentsSkills, include: () => true },
    { moduleId: 'plugins', base: profileDir, include: (p) => PLUGIN_FILES.has(p) },
    { moduleId: 'config', base: profileDir, include: (p) => p === 'cordis.patch.yml' },
    { moduleId: 'config', base: dshHome, include: (p) => CONFIG_FILES.has(p) },
    // 记忆与待办共用同一个根，靠 isTodoPath 做互斥切分
    { moduleId: 'memory', base: memories, include: (p) => !isTodoPath(p) },
    { moduleId: 'todo', base: memories, include: (p) => isTodoPath(p) },
    { moduleId: 'sessions', base: join(dshHome, 'sessions'), include: () => true },
  ];
}

/**
 * 反查：某个根下的某个相对路径，被哪些模块认领。
 * 用于「互斥性」测试 —— 每个路径必须**恰好**属于一个模块。
 *
 * @param {string} base
 * @param {string} relPath
 * @param {import('./paths.js').Roots} roots
 * @returns {ModuleId[]}
 */
export function modulesFor(base, relPath, roots) {
  const b = toPosix(base);
  const p = toPosix(relPath);
  /** @type {Set<ModuleId>} */
  const hit = new Set();
  for (const r of listModuleRoots(roots)) {
    if (toPosix(r.base) !== b) continue;
    if (r.include(p)) hit.add(r.moduleId);
  }
  return [...hit];
}
