/**
 * 插件自己的设置（备份目录、同步文件夹、默认开关）。
 *
 * **刻意不写 `cordis.patch.yml`**：那个文件是 DSH 的托管配置，写坏了会触发
 * 「应用无法使用」的致命恢复（会备份并重置用户的 provider / 主题 / 插件配置）。
 * 自己的设置放自己的文件里，跟基线库同处 `~/.dsh/backup-sync/`。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DEFAULT_SCHEDULE, normalizeSchedule } from './schedule.js';

export const SETTINGS_VERSION = 1;

/**
 * 云端配置的**非密**部分。密码单独存 `cloud-credentials.json`
 * （见 `lib/cloud.js` 的 `saveCloudPassword`）——这里的字段会被打进设置、
 * 显示在界面、写进日志，所以绝不能出现任何秘密。
 */
export const DEFAULT_CLOUD = {
  kind: 'webdav',
  enabled: false,
  url: null,
  username: null,
  remoteDir: 'dsh-backup',
  insecureTLS: false,
  autoUpload: false,
  lastUpload: null,
  lastCheck: null,
};

/** 远端目录：去首尾斜杠、反斜杠归一、折叠重复斜杠；空与 `..` 一律拒绝。 */
export function normalizeRemoteDir(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : '';
  const parts = text.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0) throw new Error('远端目录不能为空（例如 dsh-backup）');
  if (parts.includes('..')) throw new Error('远端目录不能包含 ..（不允许跳出云端根目录）');
  return parts.join('/');
}

/**
 * 归一云端配置。
 *
 * 与 `schedule` 同一个理由：patch 是**按字段**来的，只改一个开关时其余字段
 * 必须保留。`saveSettings` 的浅合并对嵌套对象无能为力（`{...current, ...patch}`
 * 会把整个 `cloud` 换成 patch 里那半个），所以必须在这里逐字段兜住。
 */
export function normalizeCloud(raw) {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let remoteDir = DEFAULT_CLOUD.remoteDir;
  if (typeof r.remoteDir === 'string' && r.remoteDir.trim() !== '') {
    try {
      remoteDir = normalizeRemoteDir(r.remoteDir);
    } catch {
      remoteDir = DEFAULT_CLOUD.remoteDir;
    }
  }
  const url = typeof r.url === 'string' && r.url.trim() !== '' ? r.url.trim() : null;
  return {
    kind: 'webdav',
    enabled: r.enabled === true,
    url,
    username: typeof r.username === 'string' && r.username !== '' ? r.username : null,
    remoteDir,
    insecureTLS: r.insecureTLS === true,
    autoUpload: r.autoUpload === true,
    lastUpload: r.lastUpload ?? null,
    lastCheck: r.lastCheck ?? null,
  };
}

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  outDir: null,
  syncDir: null,
  allowDelete: false,
  includeBaseline: true,
  /** 定时备份。默认**关着** —— 不能替用户决定每天自动打包。 */
  schedule: normalizeSchedule(DEFAULT_SCHEDULE),
  /** 云备份。默认**关着**，且不给地址 —— 云是外部依赖，必须用户显式开启。 */
  cloud: { ...DEFAULT_CLOUD },
};

export function settingsPathOf(roots) {
  return join(roots.dshHome, 'backup-sync', 'settings.json');
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 为什么必须做：`JSON.parse("\uFEFF{…}")` 在 Node 里**直接抛**。而 Windows 上
 * 记事本、PowerShell 5.1 的 `Set-Content -Encoding UTF8`、部分编辑器的「UTF-8
 * with BOM」选项都会给文件加 BOM —— 用户手工改一次设置文件，插件就会静默回退
 * 到默认值并标记 corrupted（本机实测踩到：BOM 让 JSON.parse 报
 * `Unexpected token '', "{…" is not valid JSON`）。
 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function loadSettings(roots) {
  const file = settingsPathOf(roots);
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(stripBom(await readFile(file, 'utf8')));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      version: SETTINGS_VERSION,
      schedule: normalizeSchedule(parsed.schedule),
      cloud: normalizeCloud(parsed.cloud),
    };
  } catch {
    // 设置文件坏了不致命：回默认值即可，别让它挡住备份
    return { ...DEFAULT_SETTINGS, corrupted: true };
  }
}

export async function saveSettings(roots, patch) {
  const file = settingsPathOf(roots);
  const current = await loadSettings(roots);
  const next = { ...DEFAULT_SETTINGS, ...current, ...patch, version: SETTINGS_VERSION };
  // schedule 是嵌套对象：patch 只传一半时必须与现有值合并，
  // 否则「只改开关」会把频率/时刻一起抹成 undefined，归一后又弹回默认值 —— 用户会看到自己刚设的频率莫名其妙没了。
  next.schedule = normalizeSchedule({ ...(current.schedule ?? DEFAULT_SETTINGS.schedule), ...(patch?.schedule ?? {}) });
  // cloud 同理：浅合并会把整个 cloud 对象换成 patch 里那半个，逐字段归一才能只改想改的那个
  next.cloud = normalizeCloud({ ...(current.cloud ?? DEFAULT_SETTINGS.cloud), ...(patch?.cloud ?? {}) });
  delete next.corrupted;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return next;
}

/** 把请求里的可选覆盖合并进设置（请求 > 设置 > 默认）。 */
export function effective(outDir, syncDir, settings) {
  return {
    outDir: typeof outDir === 'string' && outDir.trim() !== '' ? outDir.trim() : (settings.outDir ?? undefined),
    syncDir: typeof syncDir === 'string' && syncDir.trim() !== '' ? syncDir.trim() : (settings.syncDir ?? undefined),
  };
}
