/**
 * 扫描器：模块 → 文件清单 + sha256 + 计数。
 *
 * 两条硬约束：
 *  1. **读不到的文件不抛异常**，记入 `warnings`。权限不足、文件被占用是常态，
 *     不能因为一个文件读不了就让整次备份失败 —— 那样用户永远备不成。
 *  2. **哈希流式计算**，不整文件读进内存（会话文件可能几十 MB）。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { guardEntry } from './guard.js';
import { sha256File } from './hash.js';
import { toPosix } from './paths.js';
import { MODULE_IDS, MODULE_META, countTodoEntries, listModuleRoots, todoTrackOf } from './modules.js';

/** 永不进入清单的目录名：体积大且可重建。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.system', '.pnpm-store', '.cache']);

/** 计数需要读文本时的体积上限；超过就只按文件数算，避免读进巨型文件。 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 递归收集目录下命中 `include` 的文件。 */
async function walkDir(base, dir, include, out, warnings) {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push({ path: dir, reason: `readdir: ${err.code || err.message}` });
    return;
  }
  for (const d of dirents) {
    const abs = join(dir, d.name);
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue;
      await walkDir(base, abs, include, out, warnings);
      continue;
    }
    // 符号链接、设备文件等一律跳过：本插件只搬真实文件
    if (!d.isFile()) continue;
    const rel = toPosix(relative(base, abs));
    if (!include(rel)) continue;
    out.push({ absPath: abs, relPath: rel });
  }
}

/**
 * 扫描全部模块。
 *
 * @param {import('./paths.js').Roots} roots
 * @param {{moduleIds?: string[]}} [options]
 * @returns {Promise<{
 *   scannedAt: number,
 *   roots: import('./paths.js').Roots,
 *   modules: Record<string, any>,
 *   warnings: {path: string, reason: string}[],
 *   credentials: {moduleId: string, relPath: string, absPath: string, reason: string}[],
 *   totals: {files: number, bytes: number},
 * }>}
 */
export async function scan(roots, options = {}) {
  const want = new Set(options.moduleIds ?? MODULE_IDS);
  /** @type {{path: string, reason: string}[]} */
  const warnings = [];
  /** 被凭据守卫剔除的文件（绝不进包，且必须让用户看见） */
  /** @type {{moduleId: string, relPath: string, absPath: string, reason: string}[]} */
  const credentials = [];
  /** @type {Record<string, any>} */
  const modules = {};
  /** countKind='dir' 时用来收集去重后的目录前缀 */
  const dirSets = new Map();

  for (const id of MODULE_IDS) {
    if (!want.has(id)) continue;
    const meta = MODULE_META[id];
    modules[id] = {
      id,
      label: meta.label,
      note: meta.note,
      countKind: meta.countKind,
      defaultChecked: meta.defaultChecked,
      count: 0,
      files: 0,
      bytes: 0,
      bases: [],
      tracks: {},
      entries: [],
    };
  }

  for (const r of listModuleRoots(roots)) {
    const mod = modules[r.moduleId];
    if (!mod) continue;

    const exists = await pathExists(r.base);
    mod.bases.push({ base: r.base, exists });
    if (!exists) continue;

    const found = [];
    await walkDir(r.base, r.base, r.include, found, warnings);

    for (const f of found) {
      let st;
      try {
        st = await stat(f.absPath);
      } catch (err) {
        warnings.push({ path: f.absPath, reason: `stat: ${err.code || err.message}` });
        continue;
      }

      // 文本只读一次：凭据内容闸与待办条目计数共用同一份内容。
      const wantsText = st.size <= MAX_TEXT_BYTES;
      let text = null;
      let textTried = false;
      const readTextOnce = async () => {
        if (!wantsText) return null;
        if (textTried) return text;
        textTried = true;
        try {
          text = await readFile(f.absPath, 'utf8');
        } catch (err) {
          warnings.push({ path: f.absPath, reason: `read: ${err.code || err.message}` });
          text = null;
        }
        return text;
      };

      // 凭据守卫：命中的文件直接剔除，并如实记录原因（绝不静默跳过）。
      const verdict = await guardEntry({ relPath: f.relPath, size: st.size }, readTextOnce);
      if (verdict.blocked) {
        credentials.push({ moduleId: r.moduleId, relPath: f.relPath, absPath: f.absPath, reason: verdict.reason });
        continue;
      }

      let sha256;
      try {
        sha256 = await sha256File(f.absPath);
      } catch (err) {
        warnings.push({ path: f.absPath, reason: `hash: ${err.code || err.message}` });
        continue;
      }

      mod.entries.push({
        moduleId: r.moduleId,
        base: r.base,
        relPath: f.relPath,
        absPath: f.absPath,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        sha256,
      });
      mod.files += 1;
      mod.bytes += st.size;

      if (mod.countKind === 'entry') {
        const body = await readTextOnce();
        if (body !== null) {
          try {
            const n = countTodoEntries(body);
            mod.count += n;
            const track = todoTrackOf(f.relPath) ?? 'other';
            mod.tracks[track] = (mod.tracks[track] ?? 0) + n;
          } catch (err) {
            warnings.push({ path: f.absPath, reason: `count: ${err.code || err.message}` });
          }
        }
      }

      if (mod.countKind === 'dir') {
        const depth = MODULE_META[r.moduleId].dirDepth ?? 1;
        const key = f.relPath.split('/').slice(0, depth).join('/');
        if (!dirSets.has(r.moduleId)) dirSets.set(r.moduleId, new Set());
        dirSets.get(r.moduleId).add(key);
      }
    }
  }

  for (const id of Object.keys(modules)) {
    const mod = modules[id];
    if (mod.countKind === 'dir') mod.count = dirSets.get(id)?.size ?? 0;
    else if (mod.countKind === 'file') mod.count = mod.files;
    // 'entry' 的 count 已在上面累加
    mod.entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  }

  const totals = { files: 0, bytes: 0 };
  for (const mod of Object.values(modules)) {
    totals.files += mod.files;
    totals.bytes += mod.bytes;
  }

  return { scannedAt: Date.now(), roots, modules, warnings, credentials, totals };
}

/** 把扫描结果压成「模块 → 人类可读摘要」，供界面直接渲染。 */
export function summarize(result) {
  return Object.values(result.modules).map((mod) => ({
    id: mod.id,
    label: mod.label,
    note: mod.note,
    countKind: mod.countKind,
    defaultChecked: mod.defaultChecked,
    count: mod.count,
    files: mod.files,
    bytes: mod.bytes,
    tracks: mod.tracks,
    bases: mod.bases,
  }));
}
