/**
 * 定时备份的运行时：心跳 + 落盘状态 + 自动清理旧包。
 *
 * 调度规则本身全在 `schedule.js`（纯函数、已单测）；这里只做三件事：
 *   ① 每 60 秒问一次「现在该跑吗」；
 *   ② 该跑就跑一次 `runBackup`，把结果写进 `~/.dsh/backup-sync/schedule.json`；
 *   ③ 跑完按「保留份数」清掉旧包。
 *
 * ## 三个刻意的设计
 *
 * **锚点（lastPointAt）**：第一次启用定时备份时，先把「计时起点 = 现在」落盘，
 * 而不是立刻跑一次。没有这个锚点，`interval` 模式的「下次 = 上次 + 间隔」在
 * 从没跑过时永远算成「现在 + 间隔」，每次心跳都往后推 —— 结果是**永远不会跑**。
 *
 * **失败只消费这一个点，不重试**：跑挂了就把 `lastPointAt` 推进到该点并记下
 * `lastError`，不会每 60 秒重试一次。理由与「错过不补跑」一致 —— 可预期。
 * 用户界面上会显著显示失败原因，旁边就是「立即跑一次」。
 *
 * **只删自己的包**：清理是本功能里唯一会主动删用户数据的地方，口径收到最紧
 * （`isOwnArchiveName` 只认自己生成的时间戳命名，且 `keep<=0` 表示不清理）。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { MODULE_IDS, MODULE_META } from './modules.js';
import { computeNextRun, dueInfo, isOwnArchiveName, pruneKeep, sanitizeScheduledModules } from './schedule.js';
import { stripBom } from './settings.js';

export const SCHEDULE_STATE_VERSION = 1;

/** 心跳间隔。60 秒足够准（宽限窗口是 10 分钟），又不至于空转。 */
export const HEARTBEAT_MS = 60_000;

/** 启动后第一次检查延迟：等 DSH 把启动那一堆 IO 忙完再说。 */
export const STARTUP_DELAY_MS = 15_000;

export const DEFAULT_SCHEDULE_STATE = {
  version: SCHEDULE_STATE_VERSION,
  /** 计时锚点：上一次被「消费」的调度点。调度只看它，不看 lastRunAt。 */
  lastPointAt: null,
  /** 上一次**成功**跑完的时刻。 */
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  lastArchive: null,
  lastPruned: [],
  /** 最近一次「定时备份后自动上传云端」的结果（成功时）。 */
  cloudUpload: null,
  /** 最近一次自动上传失败的原因。**它不影响 lastError** —— 备份本身是成功的。 */
  cloudError: null,
  runCount: 0,
  updatedAt: null,
};

export function scheduleStatePathOf(roots) {
  return join(roots.dshHome, 'backup-sync', 'schedule.json');
}

export async function loadScheduleState(roots) {
  const file = scheduleStatePathOf(roots);
  if (!existsSync(file)) return { ...DEFAULT_SCHEDULE_STATE };
  try {
    const parsed = JSON.parse(stripBom(await readFile(file, 'utf8')));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_SCHEDULE_STATE };
    }
    return { ...DEFAULT_SCHEDULE_STATE, ...parsed, version: SCHEDULE_STATE_VERSION };
  } catch {
    // 状态文件坏了不致命：当作「没跑过」重新锚点即可，别让它挡住定时备份
    return { ...DEFAULT_SCHEDULE_STATE, corrupted: true };
  }
}

export async function saveScheduleState(roots, patch) {
  const file = scheduleStatePathOf(roots);
  const current = await loadScheduleState(roots);
  const next = { ...DEFAULT_SCHEDULE_STATE, ...current, ...patch, version: SCHEDULE_STATE_VERSION, updatedAt: Date.now() };
  delete next.corrupted;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return next;
}

/**
 * 删掉一个备份包**及其两个边车**（`.sha256` / `.meta.json`）。
 *
 * 边车必须一起删：只删主包会在历史列表里留下读不到包的孤儿边车。
 * 三道保险：名字必须是自己打的、必须是 `.tar.gz`、删除失败不抛（清理是
 * 附带动作，不能因为它让一次成功的备份变成失败）。
 */
export async function removeArchiveSet(outDir, name) {
  if (!isOwnArchiveName(name)) return { name, removed: false, reason: '不是本插件打的包' };
  const removed = [];
  for (const suffix of ['', '.sha256', '.meta.json']) {
    const file = join(outDir, `${name}${suffix}`);
    try {
      await rm(file, { force: true });
      removed.push(`${name}${suffix}`);
    } catch {
      // 删不掉就留着，下一轮还会再试
    }
  }
  return { name, removed: removed.length > 0, files: removed };
}

/** 默认的模块选择：与手动备份一致（对话不在内），再过硬闸。 */
export function scheduledModuleIds(schedule) {
  const base = Array.isArray(schedule?.moduleIds)
    ? schedule.moduleIds
    : MODULE_IDS.filter((id) => MODULE_META[id].defaultChecked);
  return sanitizeScheduledModules(base);
}

/**
 * 建一个调度器。
 *
 * 依赖全部注入（`runBackup` / `listArchiveDir` / `now` / `log`），
 * 这样离线测试可以完全控制时间与结果，不需要真起定时器、也不需要真打包。
 *
 * @param {{
 *   roots: any,
 *   loadSettings: (roots: any) => Promise<any>,
 *   runBackup: (roots: any, opts: any) => Promise<any>,
 *   listArchiveDir: (outDir: string) => Promise<any[]>,
 *   uploadArchive?: (roots: any, opts: {name: string, outDir: string}) => Promise<any>,
 *   now?: () => number,
 *   log?: (...args: any[]) => void,
 * }} deps
 */
export function createScheduler(deps) {
  const roots = deps.roots;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : (...a) => console.log('[dsh-backup-sync]', ...a);

  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {NodeJS.Timeout|null} */
  let kickoff = null;
  /** 重入闸：一次打包可能要几十秒，心跳不能叠上去。 */
  let running = false;

  async function status() {
    const settings = await deps.loadSettings(roots);
    const schedule = settings.schedule;
    const state = await loadScheduleState(roots);
    const t = now();
    const info = dueInfo(schedule, t, state.lastPointAt);
    return {
      schedule,
      state,
      statePath: scheduleStatePathOf(roots),
      due: info.due,
      reason: info.reason,
      scheduledAt: info.scheduledAt,
      nextRunAt: computeNextRun(schedule, t, state.lastPointAt),
    };
  }

  /** 真正跑一次。`pointAt` 是要消费掉的计时点（写进 lastPointAt）。 */
  async function execute(settings, pointAt) {
    if (running) return { ran: false, reason: 'busy' };
    running = true;
    const startedAt = now();
    try {
      const ids = scheduledModuleIds(settings.schedule);
      if (ids.length === 0) throw new Error('定时备份没有可打包的模块');

      const result = await deps.runBackup(roots, {
        moduleIds: ids,
        outDir: settings.outDir ?? undefined,
        includeBaseline: settings.schedule.includeBaseline !== false,
      });

      // 清理旧包。keep<=0 时 pruneKeep 返回空数组（= 不清理）。
      const outDir = dirname(result.archive.path);
      let pruned = [];
      try {
        const all = await deps.listArchiveDir(outDir);
        const own = all.filter((a) => isOwnArchiveName(a.name));
        const doomed = pruneKeep(own, settings.schedule.keep).filter((n) => n !== result.archive.name);
        for (const name of doomed) {
          const r = await removeArchiveSet(outDir, name);
          if (r.removed) pruned.push(name);
        }
      } catch (err) {
        // 清理失败不影响「这次备份成功了」这个事实，只记一行
        log(`清理旧包失败：${err?.message ?? err}`);
      }

      const state = await saveScheduleState(roots, {
        lastPointAt: pointAt,
        lastRunAt: startedAt,
        lastArchive: result.archive.name,
        lastPruned: pruned,
        lastResult: {
          name: result.archive.name,
          path: result.archive.path,
          bytes: result.archive.bytes,
          bytesHuman: result.archive.bytesHuman,
          totals: result.archive.totals ?? null,
          modules: ids,
          credentials: (result.credentials ?? []).length,
          at: startedAt,
        },
        lastError: null,
        // 每轮开头先清干净：上一轮的上传结论不该粘在这一轮上
        cloudUpload: null,
        cloudError: null,
        runCount: (await loadScheduleState(roots)).runCount + 1,
      });
      log(`定时备份完成：${result.archive.name}（${result.archive.bytesHuman}），清理 ${pruned.length} 份`);

      // ── 可选：把刚打好的包推上云端。
      //
      // 三条纪律：
      //  ① **先落锚点再上传**：备份成功与计时点消费是必须立刻持久化的事实。
      //     上传可能慢（最长 5 分钟），若把它塞在落盘之前，这段时间里进程一挂
      //     就会重跑一次定时备份 —— 白打一个包。
      //  ② **只传这一份**（按名字指定），不是「传最新的」：并发场景下「最新」
      //     可能已经是别人打的那一份。
      //  ③ **失败绝不改写成「备份失败」**：云端是附加动作，本地那份包是好的。
      //     只在状态里留一行 cloudError，界面照实显示，用户可手动重试。
      let cloudUpload = null;
      let cloudError = null;
      if (
        settings.cloud?.enabled === true &&
        settings.cloud?.autoUpload === true &&
        typeof deps.uploadArchive === 'function'
      ) {
        try {
          const up = await deps.uploadArchive(roots, { name: result.archive.name, outDir });
          cloudUpload = {
            at: now(),
            name: result.archive.name,
            bytes: up?.archive?.bytes ?? result.archive.bytes,
            files: Array.isArray(up?.files) ? up.files.length : null,
            remoteDir: up?.remoteDir ?? settings.cloud.remoteDir ?? null,
            remoteUrl: up?.remoteUrl ?? null,
          };
          await saveScheduleState(roots, { cloudUpload, cloudError: null });
          log(`定时备份已自动上传云端：${result.archive.name} → ${cloudUpload.remoteUrl ?? cloudUpload.remoteDir ?? ''}`);
        } catch (err) {
          cloudError = err?.message ?? String(err);
          await saveScheduleState(roots, { cloudUpload: null, cloudError });
          log(`定时备份已成功，但自动上传云端失败：${cloudError}`);
        }
      }

      return { ran: true, reason: 'ran', archive: state.lastResult, pruned, cloudUpload, cloudError };
    } catch (err) {
      const message = err?.message ?? String(err);
      await saveScheduleState(roots, {
        lastPointAt: pointAt,
        lastError: message,
        lastResult: null,
        cloudUpload: null,
        cloudError: null,
      });
      log(`定时备份失败：${message}`);
      return { ran: false, reason: 'failed', error: message };
    } finally {
      running = false;
    }
  }

  /**
   * 一次心跳。返回 `{ran, reason, nextRunAt?}`，`reason` 用于界面解释。
   * 永不抛错 —— 心跳里抛出去会变成 unhandled rejection。
   */
  async function tick() {
    try {
      const settings = await deps.loadSettings(roots);
      const schedule = settings.schedule;
      const t = now();

      if (schedule.enabled !== true) return { ran: false, reason: 'disabled', nextRunAt: null };

      const state = await loadScheduleState(roots);
      if (state.lastPointAt === null) {
        // 第一次启用：只落锚点，不立刻跑（否则打开开关的瞬间就打一个包）
        await saveScheduleState(roots, { lastPointAt: t });
        return { ran: false, reason: 'anchored', nextRunAt: computeNextRun(schedule, t, t) };
      }

      const info = dueInfo(schedule, t, state.lastPointAt);

      // ★ 错过（关机/休眠跨过了调度点）时必须**把锚点推进到当下**。
      // 不推进的话，下一个心跳算出来的调度点还是那个早已过去的时刻，
      // 于是永远判「错过」—— 定时备份从此再也不会跑，且界面上看不出异常。
      if (info.reason === 'missed') {
        await saveScheduleState(roots, { lastPointAt: t });
        return { ran: false, reason: 'missed', nextRunAt: computeNextRun(schedule, t, t) };
      }
      if (!info.due) {
        return { ran: false, reason: info.reason, nextRunAt: computeNextRun(schedule, t, state.lastPointAt) };
      }
      // 消费「现在」而不是「那个调度点」：这样界面上预告的下次运行时间
      // 与实际跑完之后算出来的完全一致（不会差一个宽限窗口）。
      const out = await execute(settings, t);
      return { ...out, nextRunAt: computeNextRun(schedule, now(), (await loadScheduleState(roots)).lastPointAt) };
    } catch (err) {
      log(`心跳异常：${err?.message ?? err}`);
      return { ran: false, reason: 'error', error: err?.message ?? String(err) };
    }
  }

  /** 「立即跑一次」：无视调度点直接跑，并把计时起点重置到此刻。 */
  async function runNow() {
    const settings = await deps.loadSettings(roots);
    return await execute(settings, now());
  }

  function start() {
    if (timer !== null) return false;
    timer = setInterval(() => {
      void tick();
    }, HEARTBEAT_MS);
    kickoff = setTimeout(() => {
      void tick();
    }, STARTUP_DELAY_MS);
    // 不拖着进程退出（DSH 关闭时不该因为一个心跳定时器卡住）
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof kickoff.unref === 'function') kickoff.unref();
    log(`调度器已启动，心跳 ${HEARTBEAT_MS / 1000} 秒`);
    return true;
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    if (kickoff !== null) clearTimeout(kickoff);
    timer = null;
    kickoff = null;
    return true;
  }

  return { tick, runNow, status, start, stop, execute };
}
