/**
 * 三方比较（three-way merge）—— 差分器核心。
 *
 * ## 为什么必须三方
 *
 * 设包里的技能 A 是 10/1 版、本地是 10/10 版。只看这两份无法区分：
 *   ① 本地 10/10 改过，包是旧的         → 应保留本地
 *   ② 本地没动过，是在另一台机器上改的   → 应用包里的
 * 表象完全相同，正确动作相反。只有引入基线（base）才能判定。
 *
 * ## 陷阱：选择性备份会被误判成「包删了」
 *
 * 如果归档是**只含勾选模块**的（比如只勾了技能），那么未勾选模块的文件
 * 在 `incoming` 里全部缺席。若不加保护，就会被判成「归档已删除该文件」
 * → 进而删掉本地的记忆、配置、对话。**灾难**。
 *
 * 所以 `diffFiles` 必须收到归档声明的模块清单 `modules`，
 * 范围之外的键一律 `skip`，本地保持不动。
 */
import { toPosix } from './paths.js';

/** @typedef {'import'|'keep'|'delete'|'conflict'|'same'|'skip'} Action */

export const ACTIONS = /** @type {const} */ (['import', 'keep', 'delete', 'conflict', 'same', 'skip']);

/** 拆基线键 `<模块id>:<相对路径>`，只切第一个冒号（路径里可能有冒号）。 */
export function parseKey(key) {
  const i = key.indexOf(':');
  if (i < 0) return { moduleId: '', relPath: toPosix(key) };
  return { moduleId: key.slice(0, i), relPath: toPosix(key.slice(i + 1)) };
}

/**
 * 从一张映射里取某个键的哈希。
 *
 * 刻意容忍两种写法：`{key: {sha256}}` 与 `{key: '哈希'}`。
 * 因为只认前者时，误传后者会**静默地把每个文件都判成「本地已删除」**——
 * 这个错法不报错、看起来还很有道理，但方向正好是删数据，代价太大。
 */
function shaOf(map, key) {
  const v = map[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : (v.sha256 ?? null);
}

/**
 * 对单个键做分类。
 * @returns {{action: Action, reason: string}}
 */
function classify(b, o, t, allowDelete) {
  // —— 基线里没有：要么单边新增，要么双方各自新增
  if (b === null) {
    if (o === null) return { action: 'import', reason: '归档新增，本地没有' };
    if (t === null) return { action: 'keep', reason: '本地新增，归档没有' };
    return o === t
      ? { action: 'same', reason: '双方各自新增，内容一致' }
      : { action: 'conflict', reason: '双方各自新增了同名但内容不同的文件' };
  }

  // —— 基线里有，但两边都没了
  if (o === null && t === null) return { action: 'same', reason: '双方都已删除' };

  // —— 本地删了
  if (o === null) {
    return t === b
      ? { action: 'keep', reason: '本地已删除，归档未改动 → 保持删除' }
      : { action: 'conflict', reason: '本地已删除，但归档改了它 → 需裁决' };
  }

  // —— 归档里删了
  if (t === null) {
    if (o !== b) return { action: 'conflict', reason: '归档已删除，但本地改了它 → 需裁决' };
    return allowDelete
      ? { action: 'delete', reason: '归档已删除，本地未改动 → 跟随删除' }
      : { action: 'keep', reason: '归档已删除，本地未改动（未启用删除，保守保留）' };
  }

  // —— 三方都在
  const oursChanged = o !== b;
  const theirsChanged = t !== b;
  if (!oursChanged && !theirsChanged) return { action: 'same', reason: '双方都没动' };
  if (!oursChanged && theirsChanged) return { action: 'import', reason: '只有归档改了 → 导入' };
  if (oursChanged && !theirsChanged) return { action: 'keep', reason: '只有本地改了 → 保留本地' };
  return o === t
    ? { action: 'same', reason: '双方都改成了同一结果' }
    : { action: 'conflict', reason: '双方都改了 → 需裁决' };
}

/**
 * 生成动作计划。
 *
 * @param {{
 *   baseline?: Record<string, {sha256: string}>,
 *   current?: Record<string, {sha256: string}>,
 *   incoming?: Record<string, {sha256: string}>,
 *   modules?: string[]|null,
 *   allowDelete?: boolean,
 * }} args
 * @returns {{
 *   actions: {key: string, moduleId: string, relPath: string, action: Action, reason: string}[],
 *   counts: Record<Action, number>,
 *   conflicts: any[],
 *   pending: any[],
 * }}
 */
export function diffFiles({
  baseline = {},
  current = {},
  incoming = {},
  modules = null,
  allowDelete = false,
} = {}) {
  const scope = modules ? new Set(modules) : null;
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current), ...Object.keys(incoming)]);

  /** @type {any[]} */
  const actions = [];
  const counts = { import: 0, keep: 0, delete: 0, conflict: 0, same: 0, skip: 0 };

  for (const key of [...keys].sort()) {
    const { moduleId, relPath } = parseKey(key);

    // 归档未声明的模块 → 一律不碰（这是防「选择性备份误删」的唯一屏障）
    if (scope && !scope.has(moduleId)) {
      actions.push({
        key,
        moduleId,
        relPath,
        action: 'skip',
        reason: `归档未包含「${moduleId}」模块，本地保持不动`,
      });
      counts.skip += 1;
      continue;
    }

    const b = shaOf(baseline, key);
    const o = shaOf(current, key);
    const t = shaOf(incoming, key);

    const { action, reason } = classify(b, o, t, allowDelete);
    actions.push({ key, moduleId, relPath, action, reason, base: b, ours: o, theirs: t });
    counts[action] += 1;
  }

  return {
    actions,
    counts,
    conflicts: actions.filter((a) => a.action === 'conflict'),
    pending: actions.filter((a) => a.action === 'import' || a.action === 'delete'),
  };
}

/** 把动作计划压成一行给界面用。 */
export function describePlan(result) {
  const c = result.counts;
  const parts = [];
  if (c.import) parts.push(`导入 ${c.import}`);
  if (c.keep) parts.push(`保留本地 ${c.keep}`);
  if (c.delete) parts.push(`删除本地 ${c.delete}`);
  if (c.same) parts.push(`无变化 ${c.same}`);
  if (c.skip) parts.push(`跳过 ${c.skip}`);
  if (c.conflict) parts.push(`待裁决 ${c.conflict}`);
  return parts.length > 0 ? parts.join(' · ') : '没有任何差异';
}
