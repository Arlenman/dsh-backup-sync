/**
 * 基线库：记住「上次同步完成时每个文件长什么样」。
 *
 * ## 为什么必须有基线
 *
 * 设包里的技能 A 是 10/1 版、本地是 10/10 版。只看这两份**无法区分**：
 *   ① 本地 10/10 改过，包是旧的            → 应保留本地
 *   ② 本地没动过，是在另一台机器上改的      → 应用包里的
 * 两种情况的表象完全相同（包旧、本地新），正确动作却相反。
 *
 * 唯一解法是三方比较（base / ours / theirs），即 git merge 的算法。
 * 所以本插件不是一个压缩工具，而是一个**带基线的三方合并器**。
 *
 * 推论：**基线库自身必须进备份包**，否则换机后基线为空，
 * 第一次导入会把所有差异都判成「双方都改」的冲突。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { toPosix } from './paths.js';

export const BASELINE_VERSION = 1;

/** 基线里的文件键：`<模块id>:<相对根路径>`。 */
export function keyOf(moduleId, relPath) {
  return `${moduleId}:${toPosix(relPath)}`;
}

function safeHostname() {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
}

export function emptyBaseline(machine = safeHostname()) {
  return { version: BASELINE_VERSION, machine, lastSyncAt: null, archives: {}, files: {} };
}

/**
 * 读基线库。
 *
 * **损坏绝不静默当空** —— 返回 `corrupted: true`，调用方（界面）必须显式
 * 警告「首次同步将按无基线处理」，否则用户会以为一切正常，实际冲突满天飞。
 *
 * @param {string} file
 * @returns {Promise<{ok: boolean, exists: boolean, corrupted: boolean, error?: string, data: any}>}
 */
export async function loadBaseline(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件不存在是**正常情况**（第一次用），不是错误
      return { ok: true, exists: false, corrupted: false, data: emptyBaseline() };
    }
    return {
      ok: false,
      exists: false,
      corrupted: false,
      error: `读取失败：${err.code || err.message}`,
      data: emptyBaseline(),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      exists: true,
      corrupted: true,
      error: `JSON 解析失败：${err.message}`,
      data: emptyBaseline(),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, exists: true, corrupted: true, error: '结构不是对象', data: emptyBaseline() };
  }
  if (typeof parsed.version !== 'number' || typeof parsed.files !== 'object' || parsed.files === null) {
    return {
      ok: false,
      exists: true,
      corrupted: true,
      error: '缺少 version 或 files 字段',
      data: emptyBaseline(),
    };
  }
  if (parsed.version > BASELINE_VERSION) {
    return {
      ok: false,
      exists: true,
      corrupted: true,
      error: `基线版本 ${parsed.version} 高于本插件支持的 ${BASELINE_VERSION}`,
      data: emptyBaseline(),
    };
  }

  return {
    ok: true,
    exists: true,
    corrupted: false,
    data: {
      version: parsed.version,
      machine: typeof parsed.machine === 'string' ? parsed.machine : safeHostname(),
      lastSyncAt: typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : null,
      archives: parsed.archives && typeof parsed.archives === 'object' ? parsed.archives : {},
      files: parsed.files,
    },
  };
}

/**
 * 原子写基线库：先写 `.tmp-<uuid>` 再改名。
 * 中途断电/崩溃最多留下一个临时文件，**绝不会写出半截的 state.json**。
 */
export async function saveBaseline(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * 从扫描结果的 entries 生成基线文件表。
 * @param {{moduleId: string, relPath: string, sha256: string, size: number, mtimeMs: number}[]} entries
 */
export function filesFromEntries(entries) {
  /** @type {Record<string, {sha256: string, size: number, mtimeMs: number}>} */
  const files = {};
  for (const e of entries) {
    files[keyOf(e.moduleId, e.relPath)] = { sha256: e.sha256, size: e.size, mtimeMs: e.mtimeMs };
  }
  return files;
}

/** 从扫描结果直接落一份基线（备份成功后调用）。 */
export async function writeBaselineFromScan(file, result, extra = {}) {
  const entries = [];
  for (const mod of Object.values(result.modules)) entries.push(...mod.entries);
  const data = {
    ...emptyBaseline(),
    lastSyncAt: Date.now(),
    files: filesFromEntries(entries),
    ...extra,
  };
  await saveBaseline(file, data);
  return { file, fileCount: entries.length, baseline: data };
}
