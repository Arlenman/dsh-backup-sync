/**
 * 「点一下看文件内容」的宿主半边。
 *
 * 这是本插件里**唯一一条把文件内容回吐给界面的接口**，所以安全口径要比别处更紧。
 * 五道闸，缺一不可：
 *
 *  1. **模块白名单**：`moduleId` 必须是 `MODULE_IDS` 之一，且只能落在
 *     `listModuleRoots()` 给出的根里 —— 与备份扫描**同一份**白名单。
 *     不做这一步的话，一个 `../../.credentials.yaml` 就能把明文 API key 读出来。
 *  2. **相对路径形态**：拒绝绝对路径、盘符、UNC、任何一段 `..`、NUL。
 *  3. **落点校验**：`join` 之后再 `relative` 回算一次，确认真的在根目录里面
 *     （第 2 道闸是形态检查，这一道是事实检查 —— 符号链接/大小写之类的边界靠它兜）。
 *  4. **归属校验**：这个相对路径必须**真的被该模块认领**（`modulesFor`）。
 *     光在根目录里不够 —— `memories/` 下 `TODOS.md` 属于待办、`MEMORY.md` 属于记忆，
 *     用错模块 id 去读邻居的文件同样应该拒绝。
 *  5. **凭据守卫**：文件名闸无条件拒绝、不看内容；内容闸命中同样拒绝，
 *     只回一个**打码片段**（头 6 尾 2），让用户能判断是不是误报。
 *
 * 另外两条产品约束：
 *  - 超过 `MAX_VIEW_BYTES` 只读前一段，并且**明确标记 `truncated`** ——
 *    绝不静默截断（用户会以为文件就这么长）。
 *  - 二进制文件不预览（回了也是乱码），如实说明。
 *
 * ## 返回约定
 *
 * 「不能看」是**业务答案**，不是错误：一律 `viewable:false` + 中文 `reason`，
 * 由路由用 `jsonOk` 包出去。只有请求本身不合法（缺参数、模块 id 不认识）
 * 才走 `jsonFail`。这与 `/verify` 的口径一致 —— 客户端把
 * `{ok:false}` 且**没有** `error` 字段的响应当业务答案处理。
 */
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { MODULE_IDS, listModuleRoots, modulesFor } from './modules.js';
import { inspectContentMatch, inspectPath } from './guard.js';
import { toPosix } from './paths.js';

/** 单个文件最多回吐多少字节。 */
export const MAX_VIEW_BYTES = 512 * 1024;

/** 判断二进制时只看开头这么多字节。 */
const BINARY_SNIFF_BYTES = 8000;

/**
 * 相对路径的**形态**检查（第 2 道闸）。
 *
 * @param {unknown} relPath
 * @returns {string|null} 合法时返回归一后的 posix 路径，非法返回 null
 */
export function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string') return null;
  const raw = relPath.trim();
  if (raw === '' || raw.includes('\0')) return null;
  // 绝对路径 / 盘符 / UNC 一律拒绝
  if (raw.startsWith('/') || raw.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  const posix = toPosix(raw);
  const parts = posix.split('/').filter((p) => p !== '');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}

/**
 * 把 `{moduleId, relPath}` 解析成一个**允许读**的绝对路径（第 1/2/3/4 道闸）。
 *
 * @param {import('./paths.js').Roots} roots
 * @param {string} moduleId
 * @param {string} relPath
 * @returns {{ok: true, absPath: string, base: string, relPath: string} | {ok: false, reason: string}}
 */
export function resolveModuleFile(roots, moduleId, relPath) {
  if (!MODULE_IDS.includes(moduleId)) {
    return { ok: false, reason: `不认识的模块：${String(moduleId)}` };
  }
  const rel = normalizeRelPath(relPath);
  if (rel === null) {
    return { ok: false, reason: '路径不合法：只接受模块根目录内的相对路径（不许绝对路径、盘符或 ..）' };
  }

  for (const root of listModuleRoots(roots)) {
    if (root.moduleId !== moduleId) continue;
    if (!root.include(rel)) continue;

    const absPath = join(root.base, ...rel.split('/'));
    const back = relative(root.base, absPath);
    if (back === '' || back.startsWith('..') || isAbsolute(back)) continue;

    if (!modulesFor(root.base, rel, roots).includes(moduleId)) continue;

    return { ok: true, absPath, base: root.base, relPath: rel };
  }
  return { ok: false, reason: '这个路径不属于所选模块，或不在它的目录里' };
}

/** 去掉 UTF-8 截断切出来的半个字符。 */
function dropTrailingReplacement(text) {
  return text.endsWith('\uFFFD') ? text.slice(0, -1) : text;
}

/**
 * 读一个模块内文件，供界面只读查看。
 *
 * @param {import('./paths.js').Roots} roots
 * @param {{moduleId: string, relPath: string}} input
 * @returns {Promise<{
 *   viewable: boolean, reason: string|null, guard: {id: string, excerpt: string}|null,
 *   moduleId: string, relPath: string, absPath: string|null,
 *   bytes: number|null, mtimeMs: number|null,
 *   text: string|null, truncated: boolean, binary: boolean,
 * }>}
 */
export async function describeModuleFile(roots, input) {
  const moduleId = String(input?.moduleId ?? '');
  const relPathInput = String(input?.relPath ?? '');

  const base = {
    viewable: false,
    reason: null,
    guard: null,
    moduleId,
    relPath: relPathInput,
    absPath: null,
    bytes: null,
    mtimeMs: null,
    text: null,
    truncated: false,
    binary: false,
  };

  const resolved = resolveModuleFile(roots, moduleId, relPathInput);
  if (!resolved.ok) return { ...base, reason: resolved.reason };
  const { absPath, relPath } = resolved;
  const at = { ...base, relPath, absPath };

  // 第 5 道闸之一：文件名闸。无条件拒绝，内容一个字节都不读。
  const byName = inspectPath(relPath);
  if (byName !== null) {
    return {
      ...at,
      reason: `按设计不显示凭据类文件的内容（${byName}）。它也不会进任何备份包或基线。`,
      guard: { id: '文件名闸', excerpt: byName },
    };
  }

  let st;
  try {
    st = await stat(absPath);
  } catch {
    return { ...at, reason: '文件不存在或读不到' };
  }
  if (!st.isFile()) return { ...at, reason: '这不是一个普通文件' };
  const bytes = st.size;
  const mtimeMs = Math.round(st.mtimeMs);
  const truncated = bytes > MAX_VIEW_BYTES;

  let buf;
  try {
    const fh = await open(absPath, 'r');
    try {
      const want = Math.min(bytes, MAX_VIEW_BYTES);
      buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, 0);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch (err) {
    return { ...at, bytes, mtimeMs, reason: `读文件失败：${err?.code || err?.message}` };
  }

  const binary = buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  if (binary) {
    return {
      ...at,
      bytes,
      mtimeMs,
      binary: true,
      reason: `这是二进制文件（${bytes} 字节），不显示内容。`,
    };
  }

  let text = buf.toString('utf8');
  if (truncated) text = dropTrailingReplacement(text);

  // 第 5 道闸之二：内容闸。命中就不回内容，只回打码片段。
  const hit = inspectContentMatch(text);
  if (hit !== null) {
    return {
      ...at,
      bytes,
      mtimeMs,
      truncated,
      reason: `内容命中凭据规则「${hit.id}」，按设计不显示。若这是误报，可对照片段自行判断。`,
      guard: hit,
    };
  }

  return { ...at, viewable: true, bytes, mtimeMs, text, truncated };
}
