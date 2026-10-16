/**
 * 插件清单：把「插件」模块的那几个清单文件，翻成「这台机器上装了哪几个插件」。
 *
 * ## 为什么需要这一层
 *
 * 备份页签的「插件」卡展开后是一串 `package.json` / `pnpm-lock.yaml` /
 * `pnpm-workspace.yaml` —— 那是**存下来的东西**，不是**装上的东西**。
 * 用户想知道的是「我装了哪些插件、各是什么版本、启没启用」，而不是
 * 「profile 目录里有哪三个文件」。和 `skills.js` 是同一个理由：
 * 扫描器只会给扁平文件清单，翻译成人话是界面的事。
 *
 * ## 三个口径都跟宿主保持一致
 *
 *  1. **已启用** = 出现在 profile 的 `dsh.profile.bundles` 里。
 *     只在 `dependencies` 里、不在 bundles 里的，是**被别人带进来的依赖**，
 *     宿主不会挂载它 —— 这两者混在一起看会误导人，所以分开标。
 *  2. **标题**优先取插件自带 `locale/zh.json` 的 `meta.title`
 *     （和「设置 → 插件」里显示的名字一模一样），再退 `locale/en.json`，
 *     最后退包名。取不到就如实显示包名，不编。
 *  3. **版本**取**真正装上的那个**（`node_modules/<name>/package.json`），
 *     不是依赖声明里的范围 —— `^1.2.3` 到底装成了什么，只有这里说了算。
 *
 * 早先这套口径是读内核 `dsh-app-boot` 的 `readPluginMeta` / `dictionariesOf`
 * 确认的（`{meta:{title,description}}` 结构、语言文件按语言 id 命名）。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 内置 bundle 的前缀：这些随 DSH 内核走，不在 profile 的 node_modules 里。 */
const BUILTIN_SCOPE = '@deepseek-ai/';

/**
 * 这个目录名像不像「重装时留下的备份副本」。
 *
 * 真机上 `node_modules/dsh-memory-evolve.old-2026-10-09T09-55-37-666Z` 就是
 * 2026-10-09 重装时留的副本。它照样带着 `dsh` 字段，于是会被孤儿扫描命中，
 * 每次展开插件卡都弹一条「宿主不会挂载它」的黄色警告 —— 可它压根不是一次
 * 安装，插件管理面板里也不会出现它。**只在 `.old-` / `.bak-` 这种带点的
 * 分隔符上判定**：`dsh-backup-sync`、`@xiaoyuyu6420/dsh-backup` 这类名字里
 * 带 backup 的真插件必须放过。
 */
export function isStaleBackupName(name) {
  return /\.(?:old|bak|backup|broken|disabled|orig)(?:-|$)/i.test(String(name));
}

/** 取带 `meta` 的语言文件里的标题/描述；文件不存在或结构不对都返回 null。 */
async function readLocaleMeta(dir, lang) {
  try {
    const text = await readFile(join(dir, 'locale', `${lang}.json`), 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    const meta = parsed?.meta ?? null;
    if (meta === null || typeof meta !== 'object') return null;
    return {
      title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title.trim() : null,
      description:
        typeof meta.description === 'string' && meta.description.trim() !== '' ? meta.description.trim() : null,
    };
  } catch {
    return null;
  }
}

/** 读一个 JSON 文件；不存在返回 null，坏掉抛错（坏掉的清单必须让用户看见）。 */
async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

/** profile 目录（`<dshHome>/profiles/<profile>`）。 */
export function profileDirOf(roots) {
  return join(roots.dshHome, 'profiles', roots.profile);
}

/**
 * 列出这台机器上装了哪些插件。
 *
 * @param {import('./paths.js').Roots} roots
 * @param {{warn?: (m: string) => void}} [opts]
 */
export async function listPlugins(roots, opts = {}) {
  const profileDir = profileDirOf(roots);
  const warn = opts.warn ?? (() => {});

  const manifestPath = join(profileDir, 'package.json');
  let manifest = null;
  let manifestError = null;
  try {
    manifest = await readJson(manifestPath);
  } catch (err) {
    manifestError = `${manifestPath}: ${err?.message ?? String(err)}`;
    warn(manifestError);
  }
  // 文件不存在也是「读不到清单」：新机器上 profile 还没同步过来时就是这一种，
  // 报成 ok:true + 空清单会让人以为「这台机器一个插件都没装」。
  if (manifestError === null && manifest === null) {
    manifestError = `${manifestPath}: 没有这个文件（profile 目录可能还没同步过来）`;
    warn(manifestError);
  }

  const deps = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object' ? manifest.dependencies : {};
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((b) => typeof b === 'string' && b.trim() !== '')
    : [];

  /** 依赖名 ∪ bundles 名：只出现在 bundles 里的是内置 bundle（随内核走）。 */
  const names = [...new Set([...bundles, ...Object.keys(deps)])];

  /** 读某个包目录里的 package.json（同一目录只读一次）。 */
  const pkgCache = new Map();
  const readPkg = async (name) => {
    if (pkgCache.has(name)) return pkgCache.get(name);
    const file = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
    const pkg = await readJson(file).catch((err) => {
      warn(`读 ${name} 的 package.json 失败：${err?.message ?? String(err)}`);
      return null;
    });
    pkgCache.set(name, pkg);
    return pkg;
  };

  const rows = [];
  for (const name of names) {
    const spec = typeof deps[name] === 'string' ? deps[name] : null;
    const dir = join(profileDir, 'node_modules', ...name.split('/'));
    const pkg = await readPkg(name);

    const installed = pkg !== null;
    const zh = installed ? await readLocaleMeta(dir, 'zh') : null;
    const en = installed && (zh?.title ?? null) === null ? await readLocaleMeta(dir, 'en') : null;
    const title = zh?.title ?? en?.title ?? name;
    const description =
      zh?.description ?? en?.description ?? (typeof pkg?.description === 'string' ? pkg.description.trim() : null);

    rows.push({
      name,
      title,
      /** 标题是从哪来的：语言文件 / 包名兜底。界面据此决定要不要显示包名。 */
      titleSource: (zh?.title ?? null) !== null ? 'zh' : (en?.title ?? null) !== null ? 'en' : 'name',
      version: typeof pkg?.version === 'string' ? pkg.version : null,
      spec,
      description: description === '' ? null : description,
      kind: name.startsWith(BUILTIN_SCOPE) ? 'builtin' : 'third-party',
      bundled: bundles.includes(name),
      installed,
      local: typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:')),
      dir,
    });
  }

  // 排序：宿主会挂载的（bundles）按 bundles 顺序在前 —— 那个顺序就是加载顺序，
  // 用户对照「设置 → 插件」时能一一对上；其余按名字排，保证每次刷新顺序稳定。
  const rank = new Map(bundles.map((b, i) => [b, i]));
  rows.sort((a, b) => {
    const ra = rank.has(a.name) ? rank.get(a.name) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.name) ? rank.get(b.name) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // 装了、但清单里（bundles 与 dependencies）一个字都没写：通常是
  // `package.json` 被回写削减过（本机踩过：bundles 从 6 项变 2 项，
  // 插件面板说「已安装」，工具却全部消失）。判据用包自己的 `dsh` 字段，
  // 免得把 cosmokit 这类普通依赖也算进来。
  const declared = new Set(names);
  const orphans = [];
  for (const name of await listInstalledPackages(profileDir)) {
    if (declared.has(name)) continue;
    if (isStaleBackupName(name)) continue;
    const pkg = await readPkg(name);
    if (pkg !== null && pkg.dsh !== null && typeof pkg.dsh === 'object') orphans.push(name);
  }

  return {
    ok: manifestError === null,
    manifestError,
    profile: roots.profile,
    profileDir,
    /** bundles 全量（含没有独立包的内置 bundle）。 */
    bundles,
    plugins: rows,
    totals: {
      all: rows.length,
      enabled: rows.filter((r) => r.bundled).length,
      thirdParty: rows.filter((r) => r.kind === 'third-party').length,
      standalone: rows.filter((r) => r.bundled && r.kind === 'third-party').length,
      /**
       * 「声明了但没装上」**只数第三方**。
       *
       * `@deepseek-ai/*` 那些内置 bundle 由内核提供，本来就不在 profile 的
       * `node_modules` 里 —— 把它们算进来，界面就会在每一台好机器上常年挂着
       * 「3 个声明了但没装上」，把真正的缺包淹掉。行的 `installed` 照旧如实
       * 为 false，只是这个合计口径不含内置。
       */
      missing: rows.filter((r) => r.bundled && !r.installed && r.kind === 'third-party').length,
    },
    /** 供界面提示用：装了但没在 bundles 里（依赖，不会被挂载）。 */
    dependencyOnly: rows.filter((r) => !r.bundled).map((r) => r.name),
    /** 装了、清单里却没声明（宿主不会挂载）。 */
    orphans,
  };
}

/**
 * 目录里实际装了哪些包（`node_modules` 扫描），用于「声明了但没装」的对照。
 *
 * 只扫一层 + 一层 scope，不递归：插件都是顶层包。
 * 单独导出是为了让测试能直接钉这个口径，而不是只能从 `listPlugins` 反推。
 *
 * @param {string} profileDir
 */
export async function listInstalledPackages(profileDir) {
  const base = join(profileDir, 'node_modules');
  const out = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      const scoped = await readdir(join(base, e.name), { withFileTypes: true }).catch(() => []);
      for (const s of scoped) {
        if (s.name.startsWith('.')) continue;
        out.push(`${e.name}/${s.name}`);
      }
      continue;
    }
    out.push(e.name);
  }
  return out.sort();
}
