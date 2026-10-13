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

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  outDir: null,
  syncDir: null,
  allowDelete: false,
  includeBaseline: true,
};

export function settingsPathOf(roots) {
  return join(roots.dshHome, 'backup-sync', 'settings.json');
}

export async function loadSettings(roots) {
  const file = settingsPathOf(roots);
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...parsed, version: SETTINGS_VERSION };
  } catch {
    // 设置文件坏了不致命：回默认值即可，别让它挡住备份
    return { ...DEFAULT_SETTINGS, corrupted: true };
  }
}

export async function saveSettings(roots, patch) {
  const file = settingsPathOf(roots);
  const current = await loadSettings(roots);
  const next = { ...DEFAULT_SETTINGS, ...current, ...patch, version: SETTINGS_VERSION };
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
