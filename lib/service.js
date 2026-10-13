/**
 * 业务层：把 scan / diff / archive / apply / baseline 串成界面需要的动作。
 *
 * 这一层**与 HTTP 无关**（routes.js 只做协议翻译），所以可以完全离线测试：
 * 单元测试注入 fixture 根目录，绝不碰真实用户数据。
 *
 * 五个动作：
 *   collectState   面板首屏：本机现状 + 备份历史 + 基线状态
 *   runBackup      打一个包（选模块 → 汇总 → 生成时间命名的 tar.gz + 边车）
 *   previewImport  导入前分析：三方比较 → 导入/保留/冲突/跳过
 *   applyImport    执行导入（冲突逐条裁决、写前快照、写后校验哈希）
 *   syncCopy       把某个包复制到同步文件夹（U 盘 / 网盘目录）
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { applyPlan } from './apply.js';
import {
  createArchive,
  extractArchive,
  incomingFromManifest,
  listArchives,
  localStamp,
  readManifest,
  verifyArchive,
} from './archive.js';
import { keyOf, loadBaseline, saveBaseline } from './baseline.js';
import { diffFiles } from './diff.js';
import { MODULE_IDS, MODULE_META } from './modules.js';
import { scan, summarize } from './scan.js';
import { loadSettings, settingsPathOf } from './settings.js';
import { sha256File } from './hash.js';

/** 默认备份目录：本机 D 盘优先（用户约定：数据与临时产物都放 D 盘）。 */
export const DEFAULT_ARCHIVE_DIR = 'D:\\dsh-backups-sync';

export function human(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function defaultArchiveDir(roots, override) {
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim());
  if (process.platform === 'win32' && existsSync('D:\\')) return DEFAULT_ARCHIVE_DIR;
  return join(roots.userHome, 'dsh-backups-sync');
}

/** 基线库固定落在 ~/.dsh/backup-sync/state.json（与 apply.js 的快照目录同级）。 */
export function baselinePathOf(roots) {
  return join(roots.dshHome, 'backup-sync', 'state.json');
}

/**
 * 模块选择归一化。
 * `undefined`/`null` → 默认勾选的模块；显式数组/逗号串 → 只保留认识的 id（去重、保序）。
 */
export function normalizeModuleIds(input) {
  if (input === undefined || input === null) return MODULE_IDS.filter((id) => MODULE_META[id].defaultChecked);
  const list = Array.isArray(input) ? input : String(input).split(',');
  const out = [];
  for (const raw of list) {
    const id = String(raw).trim();
    if (id === '' || MODULE_META[id] === undefined || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 根路径体检。
 *
 * 这是**唯一的安全闸**：`resolveRoots` 依赖环境变量，万一宿主进程的环境被裁剪，
 * dshHome 可能解析成别的地方 —— 那样备份会打到空目录、导入会写到错位置。
 * 所以 profile 目录不存在时一律拒绝写操作，并把原因显示到界面上。
 */
export function sanityOf(roots) {
  const profileDir = join(roots.dshHome, 'profiles', roots.profile);
  const checks = {
    dshHome: { path: roots.dshHome, exists: existsSync(roots.dshHome) },
    profileDir: { path: profileDir, exists: existsSync(profileDir) },
    agentsSkills: { path: roots.agentsSkills, exists: existsSync(roots.agentsSkills) },
  };
  const warnings = [];
  if (!checks.dshHome.exists) warnings.push(`DSH 主目录不存在：${roots.dshHome}`);
  if (!checks.profileDir.exists) {
    warnings.push(`profile 目录不存在：${profileDir}（为避免写错位置，备份与导入已停用）`);
  }
  if (!checks.agentsSkills.exists) warnings.push(`技能库不存在：${roots.agentsSkills}（技能模块会是空的）`);
  return { profileDir, checks, warnings, safe: checks.profileDir.exists };
}

function scanView(result) {
  const modules = MODULE_IDS.filter((id) => result.modules[id] !== undefined).map((id) => {
    const m = result.modules[id];
    return {
      id,
      label: m.label,
      note: m.note,
      countKind: m.countKind,
      defaultChecked: m.defaultChecked,
      count: m.count,
      files: m.files,
      bytes: m.bytes,
      bytesHuman: human(m.bytes),
      tracks: m.tracks ?? {},
      bases: m.bases ?? [],
      exists: (m.bases ?? []).some((b) => b.exists === true),
      entries: (m.entries ?? []).map((e) => ({
        relPath: e.relPath,
        base: e.base,
        size: e.size,
        sizeHuman: human(e.size),
        mtimeMs: e.mtimeMs,
        sha256: e.sha256,
      })),
    };
  });
  return {
    modules,
    totals: result.totals,
    totalsHuman: human(result.totals?.bytes ?? 0),
    warnings: result.warnings ?? [],
    credentials: result.credentials ?? [],
    scannedAt: result.scannedAt,
  };
}

/** 备份历史（读 .meta.json 边车，不解包，所以很快）。 */
export async function listArchiveDir(outDir) {
  const list = await listArchives(outDir);
  return list.map((a) => ({
    name: a.name,
    path: a.path,
    bytes: a.bytes,
    bytesHuman: human(a.bytes),
    mtimeMs: a.mtimeMs,
    mtimeLocal: a.mtimeMs ? localStamp(new Date(a.mtimeMs)) : null,
    hasMeta: a.hasMeta,
    hasSha256: a.hasSha256,
    createdAtLocal: a.meta?.createdAtLocal ?? null,
    machine: a.meta?.machine ?? null,
    profile: a.meta?.profile ?? null,
    modules: a.meta?.modules ?? null,
    counts: a.meta?.counts ?? null,
    totals: a.meta?.totals ?? null,
    baselineIncluded: a.meta?.baselineIncluded ?? null,
    sha256: a.meta?.sha256 ?? null,
  }));
}

/** 首屏状态。 */
export async function collectState(roots, opts = {}) {
  const outDir = defaultArchiveDir(roots, opts.outDir);
  const sanity = sanityOf(roots);

  const t0 = Date.now();
  const result = await scan(roots, { moduleIds: MODULE_IDS });
  const scanMs = Date.now() - t0;

  const baselinePath = baselinePathOf(roots);
  const loaded = await loadBaseline(baselinePath);
  const files = loaded.data?.files ?? {};
  const loadedSettings = await loadSettings(roots);

  const perModule = {};
  for (const key of Object.keys(files)) {
    const cut = key.indexOf(':');
    const mod = cut === -1 ? key : key.slice(0, cut);
    perModule[mod] = (perModule[mod] ?? 0) + 1;
  }

  return {
    ok: true,
    generatedAt: Date.now(),
    generatedAtLocal: localStamp(new Date()),
    roots: {
      dshHome: roots.dshHome,
      userHome: roots.userHome,
      profile: roots.profile,
      profileDir: sanity.profileDir,
      agentsSkills: roots.agentsSkills,
    },
    sanity: { safe: sanity.safe, checks: sanity.checks, warnings: sanity.warnings },
    outDir,
    outDirExists: existsSync(outDir),
    baseline: {
      path: baselinePath,
      exists: loaded.exists,
      corrupted: loaded.corrupted,
      error: loaded.error ?? null,
      files: Object.keys(files).length,
      perModule,
      lastSyncAt: loaded.data?.lastSyncAt ?? null,
      lastSyncAtLocal: loaded.data?.lastSyncAt ? localStamp(new Date(loaded.data.lastSyncAt)) : null,
      machine: loaded.data?.machine ?? null,
      archives: Object.keys(loaded.data?.archives ?? {}).length,
    },
    scan: { ...scanView(result), ms: scanMs },
    archives: await listArchiveDir(outDir),
    // 已保存的设置。界面靠它回填输入框 —— 少了这个键，刷新页面后
    // 「同步目录」输入框永远是空的（已保存的值看不见），这是实测踩到的缺陷。
    settings: {
      path: settingsPathOf(roots),
      outDir: loadedSettings.outDir ?? null,
      syncDir: loadedSettings.syncDir ?? null,
      allowDelete: loadedSettings.allowDelete === true,
      includeBaseline: loadedSettings.includeBaseline !== false,
      corrupted: loadedSettings.corrupted === true,
    },
    defaults: {
      moduleIds: MODULE_IDS.filter((id) => MODULE_META[id].defaultChecked),
      allModuleIds: [...MODULE_IDS],
      allowDelete: false,
      includeBaseline: true,
    },
  };
}

/** 打一个包，并更新本机基线。 */
export async function runBackup(roots, opts = {}) {
  const sanity = sanityOf(roots);
  if (!sanity.safe) throw new Error(`拒绝备份：${sanity.warnings.join('；')}`);

  const ids = normalizeModuleIds(opts.moduleIds);
  if (ids.length === 0) throw new Error('至少要选择一个模块');

  const outDir = defaultArchiveDir(roots, opts.outDir);
  const result = await scan(roots, { moduleIds: ids });

  const baselinePath = baselinePathOf(roots);
  const loaded = await loadBaseline(baselinePath);
  const includeBaseline = opts.includeBaseline !== false;
  // 包内带一份基线：换机后第一次导入才有比对基准，否则只能按「全新文件」处理
  const baselineJson = includeBaseline ? `${JSON.stringify(loaded.data, null, 2)}\n` : null;

  const created = await createArchive({
    roots,
    result,
    moduleIds: ids,
    outDir,
    baselineJson,
    name: typeof opts.name === 'string' && opts.name.trim() !== '' ? opts.name.trim() : undefined,
  });
  const sidecar = await verifyArchive(created.archivePath);

  // 基线更新**只覆盖本次参与的模块**，其余模块的键原样保留。
  // 否则一次「只备份技能」会把插件/记忆的基线抹掉，下次导入那些模块就退化成「首次导入」，
  // 可能拿旧包覆盖本机新改动 —— 这是会真丢数据的方向。
  const files = {};
  for (const [key, value] of Object.entries(loaded.data?.files ?? {})) {
    const cut = key.indexOf(':');
    const mod = cut === -1 ? key : key.slice(0, cut);
    if (!ids.includes(mod)) files[key] = value;
  }
  for (const mod of Object.values(result.modules)) {
    for (const e of mod.entries) {
      files[keyOf(e.moduleId, e.relPath)] = { sha256: e.sha256, size: e.size, mtimeMs: e.mtimeMs };
    }
  }

  const archiveName = basename(created.archivePath);
  await saveBaseline(baselinePath, {
    version: loaded.data?.version ?? 1,
    machine: created.manifest.machine,
    lastSyncAt: Date.now(),
    archives: {
      ...(loaded.data?.archives ?? {}),
      [created.manifest.createdAt]: { name: archiveName, files: created.manifest.totals.files, modules: ids },
    },
    files,
  });

  return {
    ok: true,
    archive: {
      name: archiveName,
      path: created.archivePath,
      bytes: created.bytes,
      bytesHuman: human(created.bytes),
      sha256: created.sha256,
      sha256Path: created.sha256Path,
      metaPath: created.metaPath,
      createdAtLocal: created.manifest.createdAtLocal,
      machine: created.manifest.machine,
      profile: created.manifest.profile,
      modules: created.manifest.modules,
      counts: created.manifest.counts,
      totals: created.manifest.totals,
      baselineIncluded: created.manifest.baselineIncluded,
      staged: created.staged,
      blocked: created.blocked ?? 0,
    },
    sidecar,
    rows: summarize(result),
    // 被凭据守卫剔除的文件：界面必须显著提示，绝不静默
    credentials: result.credentials ?? [],
    baseline: {
      path: baselinePath,
      files: Object.keys(files).length,
      corruptedBefore: loaded.corrupted,
      errorBefore: loaded.error ?? null,
    },
  };
}

function resolveArchivePath(roots, opts) {
  if (typeof opts.archivePath === 'string' && opts.archivePath.trim() !== '') {
    const p = resolve(opts.archivePath.trim());
    if (!p.endsWith('.tar.gz')) throw new Error(`不是 .tar.gz 备份包：${p}`);
    if (!existsSync(p)) throw new Error(`备份包不存在：${p}`);
    return p;
  }
  if (typeof opts.archiveName === 'string' && opts.archiveName.trim() !== '') {
    // basename 掐掉任何目录成分，杜绝 ../ 穿越
    const p = join(defaultArchiveDir(roots, opts.outDir), basename(opts.archiveName.trim()));
    if (!existsSync(p)) throw new Error(`备份包不存在：${p}`);
    return p;
  }
  throw new Error('必须指定要导入的备份包');
}

async function withExtracted(archivePath, fn) {
  const work = await mkdtemp(join(tmpdir(), 'dsh-backup-sync-'));
  try {
    await extractArchive(archivePath, work);
    return await fn(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * 三方比较的核心：归档（theirs）× 本机（ours）× 基准（base）。
 *
 * 基准选取：**本机基线优先，包内基线补齐本机没有的键**。
 * 换机第一次导入时本机基线是空的，全靠包内那一份，否则每个文件都会被当成
 * 「双方各自新增」而误报冲突。
 */
async function buildPlan(roots, work, archivePath, allowDelete) {
  const manifest = await readManifest(archivePath);
  const moduleIds = manifest.modules;
  const incoming = incomingFromManifest(manifest);

  const currentScan = await scan(roots, { moduleIds });
  const current = {};
  for (const mod of Object.values(currentScan.modules)) {
    for (const e of mod.entries) {
      current[keyOf(e.moduleId, e.relPath)] = { sha256: e.sha256, size: e.size, mtimeMs: e.mtimeMs };
    }
  }

  const baselinePath = baselinePathOf(roots);
  const local = await loadBaseline(baselinePath);
  const localFiles = local.data?.files ?? {};

  let packFiles = {};
  let packRead = false;
  let packMachine = null;
  let packLastSyncAt = null;
  if (manifest.baselineIncluded) {
    try {
      const parsed = JSON.parse(await readFile(join(work, 'sync', 'state.json'), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && parsed.files !== null && typeof parsed.files === 'object') {
        packFiles = parsed.files;
        packRead = true;
        packMachine = typeof parsed.machine === 'string' ? parsed.machine : null;
        packLastSyncAt = typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : null;
      }
    } catch {
      // 包内基线读不出来不影响导入：它只用于展示，不参与比较
    }
  }

  // ★ 基准**只用本机基线**。刻意不把包内基线当基准 ——
  // 包内那份描述的是「打包那台机器当时的文件」，不是本机的历史。
  // 拿它当基准会在新机器上把「本地根本没有这个文件」判成
  // 「本地已删除、归档未改动 → 保持删除」（diff.js 的 classify 分支 `o===null && t===b` → keep），
  // 结果**首次导入一个文件都不写** —— 换机同步直接失效，而且界面还显示「成功」。
  // 基准留空则退化成「归档新增 → 导入」，正是换机第一次该有的行为；
  // 本机有同名但内容不同的文件会报冲突交用户裁决，也是最安全的方向。
  // 真机验收脚本 scripts/verify-restore.mjs 第一遍用的就是空基准，与这里一致。
  const files = { ...localFiles };
  const base = {
    version: local.data?.version ?? 1,
    machine: local.data?.machine ?? '',
    lastSyncAt: local.data?.lastSyncAt ?? 0,
    archives: local.data?.archives ?? {},
    files,
  };

  const plan = diffFiles({ baseline: files, current, incoming, modules: moduleIds, allowDelete });

  return {
    manifest,
    moduleIds,
    incoming,
    current,
    base,
    plan,
    baselinePath,
    local,
    baseSource: {
      used: Object.keys(localFiles).length > 0 ? 'local' : 'none',
      localKeys: Object.keys(localFiles).length,
      packKeys: packRead ? Object.keys(packFiles).length : 0,
      packRead,
      packMachine,
      packLastSyncAt,
      packLastSyncAtLocal: packLastSyncAt ? localStamp(new Date(packLastSyncAt)) : null,
    },
  };
}

function archiveInfo(archivePath, manifest) {
  return {
    name: basename(archivePath),
    path: archivePath,
    createdAtLocal: manifest.createdAtLocal,
    machine: manifest.machine,
    profile: manifest.profile,
    modules: manifest.modules,
    counts: manifest.counts,
    totals: manifest.totals,
    baselineIncluded: manifest.baselineIncluded,
    tool: manifest.tool ?? null,
  };
}

/** 导入前分析（只读：不写任何本机文件）。 */
export async function previewImport(roots, opts = {}) {
  const archivePath = resolveArchivePath(roots, opts);
  const allowDelete = opts.allowDelete === true;
  const sanity = sanityOf(roots);

  return withExtracted(archivePath, async (work) => {
    const built = await buildPlan(roots, work, archivePath, allowDelete);
    const sidecar = await verifyArchive(archivePath);
    const c = built.plan.counts;
    return {
      ok: true,
      archive: archiveInfo(archivePath, built.manifest),
      sidecar,
      sanity: { safe: sanity.safe, warnings: sanity.warnings },
      allowDelete,
      baseSource: built.baseSource,
      counts: c,
      countsHuman: {
        import: c.import,
        keep: c.keep,
        delete: c.delete,
        same: c.same,
        skip: c.skip,
        conflict: c.conflict,
      },
      conflicts: built.plan.conflicts,
      pending: built.plan.pending,
      actions: built.plan.actions,
      // 有导入/删除/待裁决才值得执行；全是 keep/same 就没必要写盘
      canApply: c.import > 0 || c.delete > 0 || c.conflict > 0,
    };
  });
}

/** 执行导入。 */
export async function applyImport(roots, opts = {}) {
  const sanity = sanityOf(roots);
  if (!sanity.safe) throw new Error(`拒绝导入：${sanity.warnings.join('；')}`);

  const archivePath = resolveArchivePath(roots, opts);
  const allowDelete = opts.allowDelete === true;
  const dryRun = opts.dryRun === true;
  const resolutions = opts.resolutions !== null && typeof opts.resolutions === 'object' ? opts.resolutions : {};

  return withExtracted(archivePath, async (work) => {
    const built = await buildPlan(roots, work, archivePath, allowDelete);
    const result = await applyPlan({
      roots,
      plan: built.plan,
      manifest: built.manifest,
      incomingRoot: work,
      resolutions,
      baseline: built.base,
      baselinePath: built.baselinePath,
      allowDelete,
      snapshot: true,
      dryRun,
    });

    const failed = result.results.filter((r) => r.error !== undefined && r.error !== null);
    return {
      ok: result.ok,
      dryRun,
      archive: archiveInfo(archivePath, built.manifest),
      baseSource: built.baseSource,
      counts: result.counts,
      countsHuman: result.counts,
      results: result.results,
      errors: result.errors,
      failed,
      verified: result.verified,
      snapshotDir: result.snapshotDir,
      snapshotFiles: result.snapshotFiles,
      conflictsUnresolved: result.conflictsUnresolved,
      baselinePath: result.baselinePath,
      describe: describeApplySafe(result),
    };
  });
}

function describeApplySafe(result) {
  const c = result.counts ?? {};
  const parts = [];
  if (c.import) parts.push(`导入 ${c.import}`);
  if (c.delete) parts.push(`删除 ${c.delete}`);
  if (c.keep) parts.push(`保留 ${c.keep}`);
  if (c.same) parts.push(`无变化 ${c.same}`);
  if (c.skip) parts.push(`跳过 ${c.skip}`);
  if (c.failed) parts.push(`失败 ${c.failed}`);
  return parts.length > 0 ? parts.join(' · ') : '没有任何动作';
}

/** 完整校验：解包 → 逐文件重算 sha256。慢，但能证明包没坏。 */
export async function verifyArchiveFull(roots, opts = {}) {
  const archivePath = resolveArchivePath(roots, opts);
  const sidecar = await verifyArchive(archivePath);
  return withExtracted(archivePath, async (work) => {
    const manifest = await readManifest(archivePath);
    const bad = [];
    for (const f of manifest.files) {
      const abs = join(work, ...f.path.split('/'));
      const st = await stat(abs).catch(() => null);
      if (st === null) {
        bad.push({ path: f.path, reason: '缺文件' });
        continue;
      }
      const h = await sha256File(abs);
      if (h !== f.sha256) bad.push({ path: f.path, reason: `哈希不符（期望 ${f.sha256.slice(0, 12)}…，实得 ${h.slice(0, 12)}…）` });
    }
    return {
      ok: sidecar.ok !== false && bad.length === 0,
      archive: archiveInfo(archivePath, manifest),
      sidecar,
      checked: manifest.files.length,
      bad,
    };
  });
}

/** 把一个包（默认最新）复制到同步文件夹 —— U 盘 / 网盘目录都走这条路。 */
export async function syncCopy(roots, opts = {}) {
  const outDir = defaultArchiveDir(roots, opts.outDir);
  const rawTarget = typeof opts.targetDir === 'string' ? opts.targetDir.trim() : '';
  if (rawTarget === '') throw new Error('必须填写同步目标文件夹');
  const target = resolve(rawTarget);
  if (target === resolve(outDir)) throw new Error('同步目标不能就是备份目录本身');

  const list = await listArchives(outDir);
  if (list.length === 0) throw new Error(`备份目录里还没有备份包：${outDir}`);
  const pick = typeof opts.archiveName === 'string' && opts.archiveName.trim() !== ''
    ? list.find((a) => a.name === basename(opts.archiveName.trim()))
    : list[0];
  if (pick === undefined) throw new Error(`备份目录里没有这个包：${opts.archiveName}`);

  await mkdir(target, { recursive: true });
  const copied = [];
  for (const suffix of ['', '.sha256', '.meta.json']) {
    const src = `${pick.path}${suffix}`;
    if (!existsSync(src)) continue;
    const dest = join(target, `${pick.name}${suffix}`);
    await copyFile(src, dest);
    copied.push({ name: `${pick.name}${suffix}`, bytes: (await stat(dest)).size, sizeHuman: human((await stat(dest)).size) });
  }
  return { ok: true, target, archive: pick.name, copied };
}

/** 列出同步文件夹里的备份包（供「从同步文件夹导入」）。 */
export async function syncList(roots, opts = {}) {
  const rawTarget = typeof opts.targetDir === 'string' ? opts.targetDir.trim() : '';
  if (rawTarget === '') throw new Error('必须填写同步目标文件夹');
  const target = resolve(rawTarget);
  return { ok: true, target, exists: existsSync(target), archives: await listArchiveDir(target) };
}
