/**
 * 云端编排层 —— 把「备份包」与「WebDAV 服务器」接起来。
 *
 * 分工：`lib/webdav.js` 只会说协议（怎么列目录、怎么放文件），**不知道什么是备份包**；
 * 这一层才知道「哪些文件算一份包」「哪些名字允许删」「传完怎么核对」。
 *
 * 四条不可动摇的纪律（写在这里，改代码前先读）：
 *  1. **密码与配置分家**：密码只在 `~/.dsh/backup-sync/cloud-credentials.json`，
 *     绝不进 `settings.json`、绝不进备份包与基线（文件名已加进 `guard.js` 的
 *     `SECRET_BASENAMES`）、绝不进任何 HTTP 响应（`cloudView` 只回 `hasPassword`）。
 *  2. **远端只删自己的包**：`isOwnArchiveName()` 是唯一准入，别人放进同一目录的东西
 *     一律不碰 —— 云端那个目录可能是个共用文件夹。
 *  3. **传完必须核对**：上传后拿远端字节数与本地比；下载后拿 `.sha256` 校验。
 *     不一致就是不一致，宁可报错也不留一份「看起来成功了」的坏数据。
 *  4. **失败不吞**：所有错误都带 HTTP 状态码与服务器原文（`WebdavError`），
 *     由界面如实显示；绝不把失败静默成「已同步」。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { createWebdav, normalizeBaseUrl } from './webdav.js';
import { isOwnArchiveName } from './schedule.js';
import { DEFAULT_CLOUD, loadSettings, normalizeRemoteDir, saveSettings, settingsPathOf } from './settings.js';
import { defaultArchiveDir, listArchiveDir } from './service.js';
import { sha256File } from './hash.js';
import { localStamp } from './archive.js';

export const CLOUD_CREDENTIALS_BASENAME = 'cloud-credentials.json';

/** 一份包在云端是三个文件：包本体 + sha256 边车 + meta 边车。 */
export const SIDECAR_SUFFIXES = ['.sha256', '.meta.json'];

export function credentialsPathOf(roots) {
  return join(roots.dshHome, 'backup-sync', CLOUD_CREDENTIALS_BASENAME);
}

export { normalizeRemoteDir };

function assertOwnName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (basename(n) !== n || !isOwnArchiveName(n)) {
    throw new Error(`拒绝：${JSON.stringify(name)} 不是本插件生成的备份包（只认 dsh-sync-<时间戳>.tar.gz）`);
  }
  return n;
}

// ───────────────────────── 配置

/**
 * 保存云端配置（**只写非密字段**）。
 *
 * @param {object} roots
 * @param {{url?:string|null, username?:string|null, remoteDir?:string, enabled?:boolean,
 *          insecureTLS?:boolean, autoUpload?:boolean}} patch
 */
export async function saveCloudConfig(roots, patch = {}) {
  const next = {};
  if ('url' in patch) {
    const raw = patch.url;
    if (raw === null || raw === undefined || String(raw).trim() === '') next.url = null;
    else next.url = normalizeBaseUrl(raw); // 协议/尾斜杠校验都在里面
  }
  if ('username' in patch) {
    const u = patch.username;
    next.username = u === null || u === undefined || String(u) === '' ? null : String(u);
  }
  if ('remoteDir' in patch) next.remoteDir = normalizeRemoteDir(patch.remoteDir); // 空/.. 会抛
  for (const key of ['enabled', 'insecureTLS', 'autoUpload']) {
    if (key in patch) next[key] = patch[key] === true;
  }
  return saveSettings(roots, { cloud: next });
}

/**
 * 读取密码。文件坏了/不存在都返回 null，绝不抛 —— 云备份是附加功能，
 * 不能让一个坏掉的凭据文件把整个插件带崩。
 *
 * @returns {Promise<{password: string|null, updatedAt: number|null, corrupted: boolean, path: string}>}
 */
export async function loadCloudCredentials(roots) {
  const path = credentialsPathOf(roots);
  if (!existsSync(path)) return { password: null, updatedAt: null, corrupted: false, path };
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const pw = parsed?.password;
    if (typeof pw !== 'string' || pw === '') return { password: null, updatedAt: parsed?.updatedAt ?? null, corrupted: false, path };
    return { password: pw, updatedAt: parsed?.updatedAt ?? null, corrupted: false, path };
  } catch {
    return { password: null, updatedAt: null, corrupted: true, path };
  }
}

/**
 * 保存密码。**空字符串 = 清除**（并把文件删掉，不留空壳）。
 * 权限尽力收成 0600；Windows 上 chmod 语义有限，失败忽略（不为一个权限位挡住功能）。
 */
export async function saveCloudPassword(roots, password) {
  const path = credentialsPathOf(roots);
  if (typeof password !== 'string' || password === '') {
    await rm(path, { force: true });
    return { ok: true, cleared: true, path };
  }
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ version: 1, updatedAt: Date.now(), password }, null, 2)}\n`;
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, cleared: false, path };
}

/** 界面用的云端视图。**绝不能带密码**（有断言钉着这一点）。 */
export async function cloudView(roots) {
  const settings = await loadSettings(roots);
  const cloud = { ...DEFAULT_CLOUD, ...(settings.cloud ?? {}) };
  const creds = await loadCloudCredentials(roots);
  return {
    kind: 'webdav',
    enabled: cloud.enabled === true,
    url: cloud.url ?? null,
    username: cloud.username ?? null,
    remoteDir: cloud.remoteDir ?? DEFAULT_CLOUD.remoteDir,
    insecureTLS: cloud.insecureTLS === true,
    autoUpload: cloud.autoUpload === true,
    hasPassword: creds.password !== null,
    credentialsCorrupted: creds.corrupted,
    /** 地址与密码都齐了才叫「就绪」——少了任何一个都不该显示成可用 */
    ready: cloud.url !== null && creds.password !== null,
    lastUpload: cloud.lastUpload ?? null,
    lastCheck: cloud.lastCheck ?? null,
    settingsPath: settingsPathOf(roots),
    credentialsPath: creds.path,
    /** 界面上直接显示的远端位置，省得用户自己拼 */
    remoteUrl: cloud.url === null ? null : `${cloud.url}${cloud.remoteDir ?? DEFAULT_CLOUD.remoteDir}/`,
  };
}

/**
 * 组装一个已认证的 WebDAV 客户端。
 * @param {object} roots
 * @param {{url?:string, username?:string, password?:string, insecureTLS?:boolean, remoteDir?:string}} [overrides]
 *        界面上「还没保存就先试一下」用；不给就用已保存的。
 */
export async function makeClient(roots, overrides = {}) {
  const settings = await loadSettings(roots);
  const cloud = { ...DEFAULT_CLOUD, ...(settings.cloud ?? {}) };
  const creds = await loadCloudCredentials(roots);
  const url = overrides.url !== undefined && overrides.url !== null && String(overrides.url).trim() !== ''
    ? normalizeBaseUrl(overrides.url)
    : cloud.url === null
      ? null
      : normalizeBaseUrl(cloud.url);
  if (url === null) throw new Error('还没填云端地址（WebDAV 地址）');
  const password = overrides.password !== undefined && overrides.password !== null && overrides.password !== ''
    ? String(overrides.password)
    : creds.password;
  if (password === null) throw new Error('还没填云端密码（在「云端」区块里保存一次）');
  const remoteDir = normalizeRemoteDir(
    overrides.remoteDir !== undefined && overrides.remoteDir !== null && String(overrides.remoteDir).trim() !== ''
      ? overrides.remoteDir
      : (cloud.remoteDir ?? DEFAULT_CLOUD.remoteDir),
  );
  const client = createWebdav({
    url,
    username: overrides.username !== undefined && overrides.username !== null ? String(overrides.username) : (cloud.username ?? ''),
    password,
    insecureTLS: overrides.insecureTLS === true || cloud.insecureTLS === true,
  });
  return { client, url, remoteDir, settings, cloud };
}

/** 把「上次连接测试」的结果记进设置（界面刷新后还能看到上次结论）。 */
async function remember(roots, key, value) {
  try {
    await saveSettings(roots, { cloud: { [key]: value } });
  } catch {
    // 记录失败不影响主流程
  }
}

// ───────────────────────── 连接测试

/**
 * 认证 + 目录可达（必要时 `ensureDir`）。
 * @returns {Promise<{ok:boolean, url?:string, remoteDir?:string, dav?:string|null,
 *                    created?:string[], status?:number, error?:string}>}
 */
export async function testConnection(roots, overrides = {}) {
  const started = Date.now();
  const { client, url, remoteDir } = await makeClient(roots, overrides);
  try {
    const probe = await client.probe();
    if (!probe.ok) {
      const out = { ok: false, url, remoteDir, status: probe.status ?? null, error: probe.error ?? `HTTP ${probe.status}` };
      await remember(roots, 'lastCheck', { at: started, atLocal: localStamp(new Date(started)), ok: false, url, error: out.error });
      return out;
    }
    const dir = await client.ensureDir(remoteDir);
    // 列一次，确认这个账号真的**读得到**（有些服务器 MKCOL 放行但 PROPFIND 拒绝）
    await client.list(remoteDir);
    const out = {
      ok: true,
      url,
      remoteDir,
      remoteUrl: `${url}${remoteDir}/`,
      dav: probe.dav ?? null,
      created: dir.created ?? [],
      insecureTLS: client.insecureTLS === true,
    };
    await remember(roots, 'lastCheck', {
      at: started,
      atLocal: localStamp(new Date(started)),
      ok: true,
      url,
      remoteDir,
      created: out.created.length,
    });
    return out;
  } catch (err) {
    const out = { ok: false, url, remoteDir, status: err?.status ?? null, error: err?.message ?? String(err) };
    await remember(roots, 'lastCheck', { at: started, atLocal: localStamp(new Date(started)), ok: false, url, error: out.error });
    return out;
  } finally {
    await client.close();
  }
}

// ───────────────────────── 上传

/** 找出要传的那份包（不传名字就选最新的一份）。 */
async function pickLocalArchive(roots, opts) {
  const outDir = defaultArchiveDir(roots, opts.outDir);
  if (typeof opts.name === 'string' && opts.name.trim() !== '') {
    const name = assertOwnName(opts.name);
    const path = join(outDir, name);
    if (!existsSync(path)) throw new Error(`本地备份目录里找不到这份包：${path}`);
    const st = await stat(path);
    return { name, path, bytes: st.size, outDir };
  }
  const list = await listArchiveDir(outDir);
  const own = list.filter((a) => isOwnArchiveName(a.name));
  if (own.length === 0) {
    throw new Error(`备份目录里没有可上传的包（${outDir}）—— 先去打一个包`);
  }
  const newest = own.sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0))[own.length - 1];
  return { name: newest.name, path: newest.path, bytes: newest.bytes ?? null, outDir };
}

/**
 * 上传一份包（默认最新那份）：包本体 + 两个边车。
 *
 * 约束 5 的实现：客户端用 `Content-Length` 发送（不用 chunked），传完用 PROPFIND
 * 核对远端字节数 —— 服务器把内容截断了也能当场发现。
 *
 * @param {object} roots
 * @param {{name?:string, outDir?:string}} [opts]
 */
export async function uploadArchive(roots, opts = {}) {
  const picked = await pickLocalArchive(roots, opts);
  const { client, url, remoteDir } = await makeClient(roots, opts);
  try {
    await client.ensureDir(remoteDir);
    const sha256 = await sha256File(picked.path);
    const wanted = [{ name: picked.name, path: picked.path, bytes: (await stat(picked.path)).size }];
    for (const suffix of SIDECAR_SUFFIXES) {
      const p = `${picked.path}${suffix}`;
      if (existsSync(p)) wanted.push({ name: `${picked.name}${suffix}`, path: p, bytes: (await stat(p)).size });
    }

    const files = [];
    for (const f of wanted) {
      const remote = `${remoteDir}/${f.name}`;
      const body = await readFile(f.path);
      await client.put(remote, body);
      const st = await client.stat(remote);
      const remoteBytes = st === null ? null : st.bytes;
      if (remoteBytes !== f.bytes) {
        throw new Error(
          `上传后核对失败：${f.name} 本地 ${f.bytes} 字节，远端 ${remoteBytes === null ? '读不到' : `${remoteBytes} 字节`}`,
        );
      }
      files.push({ name: f.name, bytes: f.bytes, remoteBytes, remotePath: remote });
    }

    const at = Date.now();
    const summary = {
      at,
      atLocal: localStamp(new Date(at)),
      name: picked.name,
      bytes: picked.bytes,
      sha256,
      url,
      remoteDir,
      files: files.length,
    };
    await remember(roots, 'lastUpload', summary);
    return {
      ok: true,
      archive: { name: picked.name, bytes: picked.bytes, sha256, path: picked.path },
      files,
      remoteDir,
      remoteUrl: `${url}${remoteDir}/`,
      url,
      lastUpload: summary,
    };
  } finally {
    await client.close();
  }
}

// ───────────────────────── 列远端

/**
 * 列远端目录里的备份包，并标注与本地的关系。
 *
 * 只列 `.tar.gz` 本体：边车文件是包的附属物，单独列出来只会让界面更乱
 * （它们要么跟着包一起下载，要么一起删除）。
 */
export async function listRemote(roots, opts = {}) {
  const { client, url, remoteDir } = await makeClient(roots, opts);
  try {
    let entries;
    try {
      entries = await client.list(remoteDir);
    } catch (err) {
      if (err?.status === 404) entries = [];
      else throw err;
    }
    const outDir = defaultArchiveDir(roots, opts.outDir);
    const local = new Map();
    for (const a of await listArchiveDir(outDir)) local.set(a.name, a);

    const files = entries
      .filter((e) => e.isDir === false && e.name.endsWith('.tar.gz'))
      .map((e) => {
        const here = local.get(e.name) ?? null;
        return {
          name: e.name,
          bytes: e.bytes,
          bytesHuman: e.bytes === null ? null : humanBytes(e.bytes),
          mtimeMs: e.mtimeMs instanceof Date ? e.mtimeMs.getTime() : null,
          mtimeLocal: e.mtimeMs instanceof Date ? localStamp(e.mtimeMs) : null,
          isOwn: isOwnArchiveName(e.name),
          localExists: here !== null,
          localBytes: here?.bytes ?? null,
          localSha256: here?.sha256 ?? null,
          /** 远端比本地新（本地没有也算）——界面用它提示「云端有更新的一份」 */
          remoteNewer: here === null ? true : (e.mtimeMs instanceof Date ? e.mtimeMs.getTime() : 0) > (here.mtimeMs ?? 0),
        };
      })
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    return { ok: true, url, remoteDir, remoteUrl: `${url}${remoteDir}/`, dirMissing: entries.length === 0, files, localDir: outDir };
  } finally {
    await client.close();
  }
}

function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// ───────────────────────── 下载

/**
 * 把远端的一份包拉回本地备份目录。
 *
 * 安全顺序：先落到 `.part-<随机>` 临时文件 → 校验 sha256（远端有边车时）→
 * 才改名成正式文件。校验失败删临时文件，**绝不留下半截的包**（半截的包比没有更坏：
 * 它会被 `listArchiveDir` 当成一份正常备份显示出来）。
 *
 * @param {object} roots
 * @param {string} name 远端包名，必须是本插件生成的命名
 * @param {{outDir?:string, overwrite?:boolean}} [opts]
 */
export async function downloadRemote(roots, name, opts = {}) {
  const safe = assertOwnName(name);
  const outDir = defaultArchiveDir(roots, opts.outDir);
  await mkdir(outDir, { recursive: true });
  const target = join(outDir, safe);
  if (existsSync(target) && opts.overwrite !== true) {
    throw new Error(`本地已存在同名备份包：${target}（要覆盖请显式确认）`);
  }

  const { client, url, remoteDir } = await makeClient(roots, opts);
  const tmp = `${target}.part-${randomUUID()}`;
  const pulled = [];
  try {
    // 先拿边车（体积小、还能当校验依据），再拿本体
    let expected = null;
    for (const suffix of SIDECAR_SUFFIXES) {
      const remoteName = `${safe}${suffix}`;
      try {
        const buf = await client.get(`${remoteDir}/${remoteName}`);
        await writeFile(`${tmp}${suffix}`, buf);
        if (suffix === '.sha256') expected = buf.toString('utf8').trim().split(/\s+/)[0] || null;
      } catch (err) {
        if (err?.status === 404) continue; // 远端没有这个边车，正常
        throw err;
      }
    }

    const body = await client.get(`${remoteDir}/${safe}`);
    await writeFile(tmp, body);
    const actual = await sha256File(tmp);
    if (expected !== null && expected !== actual) {
      throw new Error(`下载校验失败：远端 .sha256 是 ${expected.slice(0, 16)}…，实际算出 ${actual.slice(0, 16)}…（文件可能传坏了，已丢弃）`);
    }

    await rename(tmp, target);
    pulled.push(target);
    for (const suffix of SIDECAR_SUFFIXES) {
      const p = `${tmp}${suffix}`;
      if (existsSync(p)) {
        const dest = `${target}${suffix}`;
        await rm(dest, { force: true });
        await rename(p, dest);
        pulled.push(dest);
      }
    }

    const st = await stat(target);
    return {
      ok: true,
      name: safe,
      path: target,
      bytes: st.size,
      sha256: actual,
      verified: expected !== null,
      files: pulled,
      url,
      remoteDir,
    };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    for (const suffix of SIDECAR_SUFFIXES) await rm(`${tmp}${suffix}`, { force: true }).catch(() => {});
    throw err;
  } finally {
    await client.close();
  }
}

// ───────────────────────── 删除

/**
 * 删远端的一份包（含两个边车）。**只删本插件生成的命名** —— 云端那个目录
 * 可能是个共用文件夹，删错东西是不可逆的。不存在也算成功（幂等）。
 */
export async function removeRemote(roots, name, opts = {}) {
  const safe = assertOwnName(name);
  const { client, url, remoteDir } = await makeClient(roots, opts);
  try {
    const removed = [];
    for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
      const remoteName = `${safe}${suffix}`;
      const r = await client.remove(`${remoteDir}/${remoteName}`);
      if (r.status !== 404) removed.push(remoteName);
    }
    return { ok: true, name: safe, removed, url, remoteDir };
  } finally {
    await client.close();
  }
}
