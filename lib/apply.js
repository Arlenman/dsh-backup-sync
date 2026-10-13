/**
 * 执行器：把 `diffFiles()` 算出来的计划真正落到磁盘上。
 *
 * 这是全项目**唯一会写用户数据**的模块，所以它遵守三条不可退让的不变量：
 *
 * ### ① 动手前先快照
 * 任何一次覆盖或删除之前，先把**原件**复制到
 * `<DSH_HOME>/backup-sync/pre-restore-<时间戳>/`，布局与备份包完全一致
 * （`dsh/` + `agents/`），所以那份快照本身就是一个能原样还原的包。
 * 写完校验不过也会**用它回滚**。
 *
 * ### ② 冲突未裁决 = 一个字都不改
 * 用户没裁决的冲突一律按「保留本地」处理，并如实记进 `conflictsUnresolved`。
 * 宁可什么都不做，也不能替用户猜。
 *
 * ### ③ 写完必须回算哈希
 * 写完不算哈希就等于「我以为写对了」。校验不过立刻回滚（有快照就还原，
 * 没有就删掉刚写的），并计入 `failed` —— 诚实比假装干净重要。
 *
 * 另外有一条自动化场景下极易忽略、但用户每天都会碰到的行为：
 * **冲突裁决为「保留本地」之后，基线要记下本地哈希**。
 * 否则下次导入同一个包还会冲突，用户会被同一个问题反复问，直到他放弃这个插件。
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { manifestIndex, prefixForAbs } from './archive.js';
import { saveBaseline } from './baseline.js';
import { parseKey } from './diff.js';
import { sha256File } from './hash.js';
import { listModuleRoots } from './modules.js';
import { toPosix } from './paths.js';

/** 快照目录名：`pre-restore-20261013-180657`。 */
export function snapshotDirName(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `pre-restore-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 键 → 磁盘绝对路径。
 *
 * **必须经过模块自己的 `include` 谓词**：记忆与待办共用 `memories` 这一个根，
 * 只差一个文件后缀。不判谓词就会把待办写到记忆的位置（或反之）。
 *
 * @returns {string|null} 解不出来返回 null —— 宁可报错，也不能写到别处
 */
export function resolveAbs(roots, moduleId, relPath) {
  const p = toPosix(relPath);
  if (!p) return null;
  // 防穿越：键来自归档清单，而清单是可以被篡改的
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return null;
  if (p.split('/').includes('..')) return null;

  for (const r of listModuleRoots(roots)) {
    if (r.moduleId !== moduleId) continue;
    if (!r.include(p)) continue;
    return join(r.base, ...p.split('/'));
  }
  return null;
}

/** 给结果压一行摘要，界面直接用。 */
export function describeApply(result) {
  const c = result.counts;
  const parts = [];
  if (result.dryRun) parts.push('【预演】');
  if (c.import) parts.push(`导入 ${c.import}`);
  if (c.delete) parts.push(`删除 ${c.delete}`);
  if (c.keep) parts.push(`保留 ${c.keep}`);
  if (c.same) parts.push(`无变化 ${c.same}`);
  if (c.skip) parts.push(`跳过 ${c.skip}`);
  if (c.failed) parts.push(`失败 ${c.failed}`);
  if (result.snapshotFiles) parts.push(`已快照 ${result.snapshotFiles}`);
  return parts.length > 0 ? parts.join(' · ') : '没有任何动作';
}

/**
 * 执行导入计划。
 *
 * @param {{
 *   roots: any,
 *   plan: any,
 *   manifest: any,
 *   incomingRoot: string,
 *   resolutions?: Record<string, 'local'|'archive'>,
 *   baseline?: any,
 *   baselinePath?: string|null,
 *   allowDelete?: boolean,
 *   snapshot?: boolean,
 *   dryRun?: boolean,
 *   now?: number,
 * }} args
 */
export async function applyPlan({
  roots,
  plan = { actions: [] },
  manifest,
  incomingRoot,
  resolutions = {},
  baseline = {},
  baselinePath = null,
  allowDelete = false,
  snapshot = true,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const index = manifestIndex(manifest);

  /** @type {any[]} */
  const results = [];
  /** @type {{key: string, message: string}[]} */
  const errors = [];
  const writes = [];
  const deletes = [];

  // ── 第一步：把计划翻译成「打算做什么」，冲突在这里裁决
  for (const a of plan.actions) {
    const key = a.key;
    const { moduleId, relPath } = a.moduleId !== undefined ? a : parseKey(key);

    let effective = a.action;
    let reason = a.reason ?? '';

    if (a.action === 'conflict') {
      const r = resolutions[key];
      if (r === 'archive') {
        effective = 'import';
        reason = '冲突裁决：采用归档版本';
      } else if (r === 'local') {
        effective = 'keep';
        reason = '冲突裁决：保留本地版本';
      } else {
        effective = 'keep';
        reason = '冲突未裁决 → 保留本地（安全默认）';
      }
    } else if (a.action === 'delete' && !allowDelete) {
      effective = 'keep';
      reason = '未启用删除 → 保守保留本地';
    }

    const rec = { key, moduleId, relPath, action: a.action, effective, applied: false, reason, error: null };
    results.push(rec);

    if (effective === 'import') {
      const abs = resolveAbs(roots, moduleId, relPath);
      const rel = index.paths[key];
      if (!abs) rec.error = `无法确定落点：${key}`;
      else if (!rel) rec.error = `归档清单里没有「${key}」的路径记录`;
      else {
        writes.push({
          rec,
          key,
          abs,
          srcAbs: join(incomingRoot, ...rel.split('/')),
          sha256: index.files[key]?.sha256 ?? null,
          size: index.files[key]?.size ?? null,
        });
      }
    } else if (effective === 'delete') {
      const abs = resolveAbs(roots, moduleId, relPath);
      if (!abs) rec.error = `无法确定落点：${key}`;
      else deletes.push({ rec, key, abs });
    }
  }

  const targets = [...writes, ...deletes].filter((t) => !t.rec.error);

  // ── 第二步：先探存在性，再快照（不变量①）
  for (const t of targets) {
    const st = await stat(t.abs).catch(() => null);
    t.existedBefore = Boolean(st?.isFile());
  }

  let snapshotDir = null;
  let snapshotFiles = 0;
  if (snapshot && !dryRun && targets.some((t) => t.existedBefore)) {
    const dir = join(roots.dshHome, 'backup-sync', snapshotDirName(new Date(now)));
    const recorded = [];
    for (const t of targets) {
      if (!t.existedBefore) continue;
      const prefix = prefixForAbs(t.abs, roots);
      if (!prefix) continue; // 不在已知根下，到不了这里；真到了就不快照，绝不乱放
      const dest = join(dir, ...prefix.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await cp(t.abs, dest);
      t.snapPath = dest;
      snapshotFiles += 1;
      recorded.push(prefix);
    }
    if (snapshotFiles > 0) {
      await writeFile(
        join(dir, 'snapshot.json'),
        `${JSON.stringify(
          {
            createdAt: new Date(now).toISOString(),
            reason: '导入前快照',
            roots: { dsh: 'dsh', agents: 'agents' },
            files: recorded,
            note: '本目录是导入前的原件，布局与备份包一致，可直接覆盖回去。',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      snapshotDir = dir;
    }
  }

  // ── 第三步：写（不变量③：写完回算哈希）
  let checked = 0;
  let verifyFailed = 0;

  for (const t of writes) {
    const rec = t.rec;
    if (rec.error) continue;
    if (dryRun) continue;

    const src = await stat(t.srcAbs).catch(() => null);
    if (!src?.isFile()) {
      rec.error = `归档里找不到 ${t.srcAbs}（解包不完整？）`;
      continue;
    }

    const tmp = `${t.abs}.tmp-${randomUUID()}`;
    try {
      await mkdir(dirname(t.abs), { recursive: true });
      await cp(t.srcAbs, tmp);
      await rename(tmp, t.abs);
    } catch (err) {
      await rm(tmp, { force: true });
      rec.error = `写入失败：${err.message}`;
      continue;
    }

    checked += 1;
    const actual = await sha256File(t.abs);
    if (t.sha256 && actual !== t.sha256) {
      verifyFailed += 1;
      // 回滚：有快照就还原，本来不存在就删掉刚写的半成品
      if (t.snapPath) await cp(t.snapPath, t.abs);
      else await rm(t.abs, { force: true });
      rec.error = `写入后哈希不符（期望 ${t.sha256.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…），已回滚`;
      continue;
    }
    rec.applied = true;
    rec.sha256 = actual;
  }

  // ── 第四步：删
  for (const t of deletes) {
    const rec = t.rec;
    if (rec.error) continue;
    if (dryRun) continue;
    try {
      await rm(t.abs, { force: true });
      rec.applied = true;
    } catch (err) {
      rec.error = `删除失败：${err.message}`;
    }
  }

  for (const rec of results) {
    if (rec.error) errors.push({ key: rec.key, message: rec.error });
  }

  // ── 第五步：算新基线
  //
  // `didIt` 要区分「需要动作且做成了」与「本来就不需要动作」：
  // keep / skip / same 无事可做，属正常完成，不能因为没有 applied 就被当成没发生
  // （否则「冲突裁决为保留本地」的基线永远不更新，下次导入还会问同一个问题）。
  const didIt = (rec) => {
    if (rec.error) return false;
    if (dryRun) return true; // 预演：按「将会如此」算
    if (rec.effective === 'keep' || rec.effective === 'skip' || rec.effective === 'same') return true;
    return rec.applied;
  };
  const newFiles = { ...(baseline?.files ?? {}) };

  for (const rec of results) {
    if (rec.error) continue;
    if (rec.effective === 'import' && didIt(rec)) {
      const f = index.files[rec.key];
      newFiles[rec.key] = {
        sha256: f?.sha256 ?? rec.sha256 ?? null,
        size: f?.size ?? 0,
        mtimeMs: now,
      };
    } else if (rec.effective === 'delete' && didIt(rec)) {
      delete newFiles[rec.key];
    } else if (rec.action === 'conflict' && resolutions[rec.key] === 'local' && didIt(rec)) {
      // 这里记**归档版本**当共同祖先，而不是本地版本 —— 很反直觉，但反过来会出大事：
      //   记本地版本 → 下次导入 base==ours、theirs≠base → 判成「归档改了」→
      //   擅自把用户刚裁决保留的本地版本盖掉，等于裁决白做。
      //   记归档版本 → 下次导入 base==theirs、ours≠base → 判成「只有本地改了」→ 静默保留。
      const theirs = index.files[rec.key]?.sha256 ?? null;
      if (theirs) {
        newFiles[rec.key] = { sha256: theirs, size: index.files[rec.key]?.size ?? 0, mtimeMs: now };
      } else {
        // 归档里删了它、用户选择保留：记本地状态，下次仍是「归档已删、本地未动」保守保留
        const abs = resolveAbs(roots, rec.moduleId, rec.relPath);
        const st = abs ? await stat(abs).catch(() => null) : null;
        if (st?.isFile()) newFiles[rec.key] = { sha256: await sha256File(abs), size: st.size, mtimeMs: st.mtimeMs };
        else delete newFiles[rec.key];
      }
    }
  }

  const newBaseline = {
    version: baseline?.version ?? 1,
    machine: baseline?.machine ?? '',
    lastSyncAt: dryRun ? (baseline?.lastSyncAt ?? 0) : now,
    archives: { ...(baseline?.archives ?? {}) },
    files: newFiles,
  };

  let wroteBaseline = null;
  if (baselinePath && !dryRun) {
    await saveBaseline(baselinePath, newBaseline);
    wroteBaseline = baselinePath;
  }

  const counts = { import: 0, keep: 0, delete: 0, skip: 0, same: 0, failed: 0 };
  const failedKeys = new Set(errors.map((e) => e.key));
  for (const rec of results) {
    if (failedKeys.has(rec.key)) counts.failed += 1;
    else counts[rec.effective] = (counts[rec.effective] ?? 0) + 1;
  }

  return {
    ok: errors.length === 0,
    dryRun,
    counts,
    results: results.map(({ error, ...rest }) => ({ ...rest, error: error ?? null })),
    errors,
    verified: { checked, failed: verifyFailed },
    snapshotDir,
    snapshotFiles,
    conflictsUnresolved: results
      .filter((r) => r.action === 'conflict' && !resolutions[r.key])
      .map((r) => r.key),
    baseline: newBaseline,
    baselinePath: wroteBaseline,
  };
}
