/**
 * 归档器：把扫描结果打成一个自描述的 `tar.gz`。
 *
 * ## 包内布局
 *
 * ```
 * dsh-sync-20261013-180312.tar.gz
 * ├── manifest.json   机器可读清单（权威：每个文件的路径/大小/哈希）
 * ├── RESTORE.md      人可读还原说明（用 7-Zip 手工还原也看得懂）
 * ├── dsh/            → 还原到 <DSH_HOME>
 * ├── agents/         → 还原到 <用户主目录>/.agents
 * └── sync/           → 还原到 <DSH_HOME>/backup-sync（含基线库 state.json）
 * ```
 *
 * **为什么不用花哨格式**：标准 `tar.gz` + 纯 JSON 清单，任何解压工具都能打开。
 * 就算将来这个插件没了，用户拿 7-Zip 也能把文件一个个放回去 ——
 * 不做只能用自己打开的死包。
 *
 * ## 为什么要 staging
 *
 * 技能在 `~/.agents/skills`、配置在 `~/.dsh`，来源跨两个根且要在包内分目录。
 * `tar` 单次调用只能有一个基准目录，所以先按目标布局在**输出盘**上搭一棵
 * 临时树（同盘优先硬链接，跨盘退回复制），再整体 tar。
 * staging 建在输出目录里，保证最后的改名是同盘原子操作。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sha256File } from './hash.js';
import { toPosix } from './paths.js';

export const FORMAT_ID = 'dsh-backup-sync';
export const ARCHIVE_VERSION = 1;
export const TOOL_VERSION = '0.1.0';

function safeHostname() {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** `dsh-sync-20261013-180312` —— 用户要的「备份时间名称」。 */
export function timestampName(d = new Date()) {
  return [
    'dsh-sync-',
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

/** `2026-10-13 18:03:12` —— 给人看的。 */
export function localStamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function prefixOf(abs, roots) {
  const b = toPosix(abs);
  const agents = toPosix(roots.agentsSkills);
  const home = toPosix(roots.dshHome);

  if (b === agents || b.startsWith(`${agents}/`)) {
    return { root: 'agents', prefix: `agents/skills${b.slice(agents.length)}` };
  }
  if (b === home || b.startsWith(`${home}/`)) {
    return { root: 'dsh', prefix: `dsh${b.slice(home.length)}` };
  }
  return null;
}

/**
 * 某个扫描根在包内的落点。
 * @returns {{root: string, prefix: string}|null} `root` 是还原时的一级目录名
 */
export function prefixFor(base, roots) {
  return prefixOf(base, roots);
}

/**
 * 反查：一个绝对路径在包内应当落在哪。
 * 快照目录刻意复用同一套布局，这样「导入前的原件」本身也是一个可还原的包。
 * @returns {string|null} 形如 `dsh/memories/MEMORY.md`
 */
export function prefixForAbs(abs, roots) {
  return prefixOf(abs, roots)?.prefix ?? null;
}

/** 包内一级目录 → 还原目标绝对路径。 */
export function rootTargets(roots) {
  return { dsh: roots.dshHome, agents: join(roots.userHome, '.agents') };
}

/** 取系统自带 tar（Windows 10 1803+ 起 `System32\tar.exe` 就是 bsdtar）。 */
export async function resolveTar() {
  const sys = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidate = join(sys, 'System32', 'tar.exe');
  try {
    await stat(candidate);
    return candidate;
  } catch {
    return 'tar';
  }
}

/** 用 spawn + 数组参数跑外部命令：**不经过 shell**，路径里的空格与中文都不会出问题。 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 建清单。 */
export function buildManifest({ roots, result, moduleIds, baselineIncluded = false, createdAt = new Date() }) {
  const files = [];
  const counts = {};

  for (const id of moduleIds) {
    const mod = result.modules[id];
    if (!mod) continue;
    counts[id] = {
      label: mod.label,
      countKind: mod.countKind,
      count: mod.count,
      files: mod.files,
      bytes: mod.bytes,
    };
    for (const e of mod.entries) {
      const p = prefixFor(e.base, roots);
      if (!p) continue; // 不在已知根下的文件不该出现在这里，静默丢弃而不是打包到错位置
      files.push({
        key: `${id}:${e.relPath}`,
        path: `${p.prefix}/${e.relPath}`,
        moduleId: id,
        size: e.size,
        mtimeMs: e.mtimeMs,
        sha256: e.sha256,
      });
    }
  }

  return {
    format: FORMAT_ID,
    version: ARCHIVE_VERSION,
    createdAt: createdAt.toISOString(),
    createdAtLocal: localStamp(createdAt),
    machine: safeHostname(),
    profile: roots.profile,
    modules: [...moduleIds],
    counts,
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
    roots: { dsh: 'dsh', agents: 'agents' },
    baselineIncluded: Boolean(baselineIncluded),
    files,
    tool: { name: 'dsh-backup-sync', version: TOOL_VERSION },
  };
}

/** 包内的人可读还原说明。 */
export function renderRestoreDoc(manifest) {
  const lines = [
    '# 备份同步 · 还原说明',
    '',
    `- 备份时间：${manifest.createdAtLocal}（${manifest.createdAt}）`,
    `- 来源机器：${manifest.machine}`,
    `- 来源 profile：${manifest.profile}`,
    `- 包含模块：${manifest.modules.join('、')}`,
    `- 文件数：${manifest.totals.files}，合计 ${manifest.totals.bytes} 字节`,
    '',
    '## 目录对应关系',
    '',
    '| 包内目录 | 还原到 |',
    '|---|---|',
    '| `dsh/` | `<DSH_HOME>`（通常是 `~/.dsh`） |',
    '| `agents/` | 用户主目录下的 `.agents/`（即 `~/.agents/skills` 处） |',
    '| `sync/` | `<DSH_HOME>/backup-sync/`（基线库，用于下次增量比对） |',
    '',
    '## 各模块文件数',
    '',
    '| 模块 | 条目 | 文件 | 字节 |',
    '|---|---|---|---|',
  ];
  for (const [id, c] of Object.entries(manifest.counts)) {
    lines.push(`| ${c.label}（${id}） | ${c.count} | ${c.files} | ${c.bytes} |`);
  }
  lines.push(
    '',
    '## 手工还原步骤',
    '',
    '1. 关闭 DeepSeek Harness（避免写入冲突）。',
    '2. 把 `dsh/` 里的内容按同名路径覆盖到 `<DSH_HOME>` 下。',
    '3. 把 `agents/skills/` 覆盖到 `~/.agents/skills/`。',
    '4. 把 `sync/state.json` 放到 `<DSH_HOME>/backup-sync/state.json`，下次增量导入才有比对基线。',
    '5. 重启 DeepSeek Harness。',
    '',
    '> 本包是标准 `tar.gz`，用 7-Zip、`tar -xzf` 等任何工具都能打开。',
    '> `manifest.json` 里有每个文件的 sha256，可用于校验完整性。',
    '',
  );
  return lines.join('\n');
}

/**
 * 把清单拆成 `diffFiles()` 与执行器各自要的两张表。
 *
 * - `files`：`key → {sha256,size,mtimeMs}`，喂给 `diffFiles({incoming})`
 * - `paths`：`key → 包内相对路径`，执行器据此找到解包后的源文件
 *
 * @param {any} manifest
 * @returns {{files: Record<string, {sha256: string, size: number, mtimeMs: number}>, paths: Record<string, string>}}
 */
export function manifestIndex(manifest) {
  const files = {};
  const paths = {};
  for (const f of manifest.files) {
    files[f.key] = { sha256: f.sha256, size: f.size, mtimeMs: f.mtimeMs };
    paths[f.key] = f.path;
  }
  return { files, paths };
}

/** 只要 `files` 那半张表。 */
export function incomingFromManifest(manifest) {
  return manifestIndex(manifest).files;
}

/** 落一个文件到 staging（同盘硬链接，跨盘复制）。 */
async function stageFile(src, dest) {
  await mkdir(join(dest, '..'), { recursive: true });
  try {
    await link(src, dest);
    return 'link';
  } catch {
    await cp(src, dest);
    return 'copy';
  }
}

/**
 * 打包。
 *
 * @param {{
 *   roots: any,
 *   result: any,
 *   moduleIds: string[],
 *   outDir: string,
 *   name?: string,
 *   baselineJson?: string|null,
 *   createdAt?: Date,
 * }} args
 */
export async function createArchive({
  roots,
  result,
  moduleIds,
  outDir,
  name,
  baselineJson = null,
  createdAt = new Date(),
}) {
  const archiveName = `${name ?? timestampName(createdAt)}.tar.gz`;
  await mkdir(outDir, { recursive: true });

  const staging = join(outDir, `.staging-${randomUUID()}`);
  const partPath = join(outDir, `${archiveName}.part-${randomUUID()}`);
  const finalPath = join(outDir, archiveName);
  const manifest = buildManifest({
    roots,
    result,
    moduleIds,
    baselineIncluded: Boolean(baselineJson),
    createdAt,
  });

  let linked = 0;
  let copied = 0;
  try {
    await mkdir(staging, { recursive: true });

    // 按扫描条目落文件（用 entries 而不是 manifest：manifest 只有相对路径，缺绝对源路径）
    for (const id of moduleIds) {
      const mod = result.modules[id];
      if (!mod) continue;
      for (const e of mod.entries) {
        const p = prefixFor(e.base, roots);
        if (!p) continue;
        const dest = join(staging, ...`${p.prefix}/${e.relPath}`.split('/'));
        const how = await stageFile(e.absPath, dest);
        if (how === 'link') linked += 1;
        else copied += 1;
      }
    }

    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(join(staging, 'RESTORE.md'), renderRestoreDoc(manifest), 'utf8');
    if (baselineJson) {
      await mkdir(join(staging, 'sync'), { recursive: true });
      await writeFile(join(staging, 'sync', 'state.json'), baselineJson, 'utf8');
    }

    const tar = await resolveTar();
    const r = await run(tar, ['-czf', partPath, '-C', staging, '.']);
    if (r.code !== 0) {
      throw new Error(`tar 打包失败（退出码 ${r.code}）：${(r.err || r.out).trim().slice(0, 500)}`);
    }

    const sha256 = await sha256File(partPath);
    const bytes = (await stat(partPath)).size;

    // 同盘改名 = 原子：中途失败最多留一个 .part-*，绝不会留半截正式包
    await rename(partPath, finalPath);
    await writeFile(`${finalPath}.sha256`, `${sha256}  ${archiveName}\n`, 'utf8');
    await writeFile(
      `${finalPath}.meta.json`,
      `${JSON.stringify(
        {
          name: archiveName,
          createdAt: manifest.createdAt,
          createdAtLocal: manifest.createdAtLocal,
          machine: manifest.machine,
          profile: manifest.profile,
          modules: manifest.modules,
          counts: manifest.counts,
          totals: manifest.totals,
          bytes,
          sha256,
          baselineIncluded: manifest.baselineIncluded,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return {
      ok: true,
      archivePath: finalPath,
      sha256Path: `${finalPath}.sha256`,
      metaPath: `${finalPath}.meta.json`,
      bytes,
      sha256,
      manifest,
      staged: { linked, copied },
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(partPath, { force: true });
  }
}

/** 只读清单，不解包（bsdtar 的 `-O` 把成员吐到 stdout）。 */
export async function readManifest(archivePath) {
  const tar = await resolveTar();
  const r = await run(tar, ['-xOf', archivePath, 'manifest.json']);
  if (r.code !== 0) {
    throw new Error(`读取 manifest.json 失败（退出码 ${r.code}）：${(r.err || r.out).trim().slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON：${err.message}`);
  }
  return validateManifest(parsed);
}

/**
 * 校验清单结构。
 *
 * 重点防路径穿越：`path` 必须是包内相对路径，不能带 `..` 或绝对前缀 ——
 * 否则一个被篡改的包可以在解包时写到用户主目录之外。
 */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') errors.push('清单不是对象');
  else {
    if (m.format !== FORMAT_ID) errors.push(`format 应为 ${FORMAT_ID}，实际 ${m.format}`);
    if (typeof m.version !== 'number') errors.push('缺少 version');
    else if (m.version > ARCHIVE_VERSION) errors.push(`包版本 ${m.version} 高于本插件支持的 ${ARCHIVE_VERSION}`);
    if (!Array.isArray(m.files)) errors.push('缺少 files 数组');
    if (!Array.isArray(m.modules)) errors.push('缺少 modules 数组');
  }
  if (errors.length > 0) {
    const err = new Error(`备份包清单不合法：${errors.join('；')}`);
    err.manifestErrors = errors;
    throw err;
  }

  for (const f of m.files) {
    if (typeof f.path !== 'string' || f.path.length === 0) {
      throw new Error('清单里有条目缺少 path');
    }
    const bad =
      f.path.startsWith('/') ||
      f.path.startsWith('\\') ||
      /^[A-Za-z]:/.test(f.path) ||
      f.path.split(/[/\\]/).includes('..');
    if (bad) throw new Error(`清单里的路径不安全：${f.path}`);
  }
  return m;
}

/** 校验包的完整性（算实际 sha256 与边车对比）。 */
export async function verifyArchive(archivePath) {
  let expected = null;
  try {
    expected = (await readFile(`${archivePath}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  } catch {
    expected = null;
  }
  const actual = await sha256File(archivePath);
  return {
    ok: expected === null ? true : expected === actual,
    expected,
    actual,
    checked: expected !== null,
  };
}

/** 解包到指定目录。 */
export async function extractArchive(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });
  const tar = await resolveTar();
  const r = await run(tar, ['-xzf', archivePath, '-C', destDir]);
  if (r.code !== 0) {
    throw new Error(`解包失败（退出码 ${r.code}）：${(r.err || r.out).trim().slice(0, 500)}`);
  }
  return destDir;
}

/** 列出备份历史（按时间倒序）。staging 与 .part 文件不列出。 */
export async function listArchives(outDir) {
  let names;
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.tar.gz')) continue;
    if (n.startsWith('.staging-')) continue;
    const full = join(outDir, n);
    let meta = null;
    try {
      meta = JSON.parse(await readFile(`${full}.meta.json`, 'utf8'));
    } catch {
      meta = null;
    }
    const st = await stat(full).catch(() => null);
    out.push({
      name: n,
      path: full,
      bytes: st?.size ?? null,
      mtimeMs: st?.mtimeMs ?? null,
      hasMeta: meta !== null,
      hasSha256: await stat(`${full}.sha256`).then(
        () => true,
        () => false,
      ),
      meta,
    });
  }
  out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return out;
}
