/**
 * 定时备份的调度逻辑（纯函数，不碰文件系统、不起定时器）。
 *
 * ## 为什么单独一个文件、还全是纯函数
 *
 * 调度是这类功能里最容易「看起来对、实际错」的部分：跨午夜、错过窗口、
 * 第一次启用该不该立刻跑、`lastRunAt` 被写坏之后会不会变成每 60 秒打一个包。
 * 把它抽成纯函数，就能在离线把每一条边界钉死；运行时那半边（`scheduler.js`）
 * 只剩「每分钟问一次 dueInfo，due 了就调 runBackup」。
 *
 * ## 错过策略：不补跑（用户明确选定）
 *
 * DSH 是桌面应用，关机/休眠是常态。到点时进程不在，就**跳过这一次**，
 * 直接等下一个点 —— 而不是开机后补跑。理由是可预期：否则早上九点开机
 * 会在你刚打开应用时突然打一个全量包。实现方式是一个宽限窗口
 * `MISS_GRACE_MS`：到点后 10 分钟内进程在，就正常跑；超过 10 分钟才算错过。
 * 心跳间隔 60 秒，正常运行时永远不会超出这个窗口。
 */
import { MODULE_IDS } from './modules.js';

/** 错过判定的宽限窗口：到点后 10 分钟内仍算「到点」，超出算「错过」。 */
export const MISS_GRACE_MS = 10 * 60 * 1000;

/** 两种频率模式。 */
export const SCHEDULE_MODES = ['daily', 'interval'];

/** 默认值：**关着的**。定时备份必须由用户显式打开，不能默认替人打包。 */
export const DEFAULT_SCHEDULE = {
  enabled: false,
  /** 'daily' = 每天某个时刻；'interval' = 每隔 N 小时 */
  mode: 'daily',
  /** mode='daily' 时的时刻，HH:MM（本地时间） */
  at: '03:00',
  /** mode='interval' 时的间隔小时数 */
  hours: 24,
  /** 保留最近几份，超出的自动删；0 = 不清理 */
  keep: 7,
  /** 定时备份打包哪些模块；null = 用模块默认勾选（对话永远不在内） */
  moduleIds: null,
  includeBaseline: true,
};

/** 解析 `HH:MM` / `H:M`。非法一律返回 null（调用方决定怎么兜）。 */
export function parseAt(value) {
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(value);
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/**
 * 把任意输入（多半来自设置文件或请求体）归一成一份合法调度。
 * **永不抛错**：设置文件被手改坏时应该退回默认值，而不是让插件起不来。
 */
export function normalizeSchedule(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = SCHEDULE_MODES.includes(src.mode) ? src.mode : DEFAULT_SCHEDULE.mode;
  const parsed = parseAt(src.at);
  const at =
    parsed === null
      ? DEFAULT_SCHEDULE.at
      : `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;

  let moduleIds = null;
  if (Array.isArray(src.moduleIds)) {
    const seen = new Set();
    for (const id of src.moduleIds) {
      if (MODULE_IDS.includes(id)) seen.add(id);
    }
    if (seen.size === 0) {
      // 输入非空但全是垃圾 id → 当成「没配」，回默认勾选。
      // 输入本来就是空数组 → 保持空（用户明确什么都没选，不该替他扩大范围）。
      moduleIds = src.moduleIds.length > 0 ? null : [];
    } else {
      // 对话硬闸在这里也生效：存进去的清单里永远不该出现 sessions。
      // 全被剔空时保持空数组 —— 把 `['sessions']` 悄悄变成「默认全勾」
      // 等于替用户扩大备份范围，宁可让运行时如实报「没有可打包的模块」。
      moduleIds = sanitizeScheduledModules([...seen]);
    }
  }

  return {
    enabled: src.enabled === true,
    mode,
    at,
    hours: clampInt(src.hours, 1, 720, DEFAULT_SCHEDULE.hours),
    keep: clampInt(src.keep, 0, 200, DEFAULT_SCHEDULE.keep),
    moduleIds,
    includeBaseline: src.includeBaseline !== false,
  };
}

/**
 * 定时备份的**硬闸**：对话模块永远不进定时包。
 *
 * 与「手动备份默认不勾对话」不同 —— 手动那次用户是当场看着勾选框点的，
 * 定时这次是无人值守地跑，一旦勾上就是每天把公司对话记录打一份包。
 * 所以这里不看用户怎么配，直接剔除。
 */
export function sanitizeScheduledModules(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  for (const id of input) {
    if (id === 'sessions') continue;
    if (MODULE_IDS.includes(id)) seen.add(id);
  }
  return [...seen];
}

/** `lastRunAt` 归一：不是正整数就当「从没跑过」。 */
function lastRunOf(lastRunAt) {
  return Number.isFinite(lastRunAt) && lastRunAt > 0 ? lastRunAt : null;
}

/** 今天（`now` 所在本地日）的 HH:MM 对应的 ms。 */
function todayPoint(schedule, now) {
  const { hour, minute } = parseAt(schedule.at) ?? { hour: 3, minute: 0 };
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/**
 * 判定此刻该不该跑，并说明理由。
 *
 * @param {ReturnType<typeof normalizeSchedule>} schedule
 * @param {number} now ms
 * @param {number|null} lastRunAt ms（上次成功跑完的时间）
 * @returns {{due: boolean, reason: 'disabled'|'not-yet'|'due'|'missed'|'already-ran', scheduledAt: number|null}}
 */
export function dueInfo(schedule, now, lastRunAt) {
  if (schedule.enabled !== true) return { due: false, reason: 'disabled', scheduledAt: null };
  const last = lastRunOf(lastRunAt);

  if (schedule.mode === 'interval') {
    const intervalMs = schedule.hours * 3600_000;
    if (last === null) return { due: false, reason: 'not-yet', scheduledAt: null };
    const point = last + intervalMs;
    if (now < point) return { due: false, reason: 'not-yet', scheduledAt: point };
    if (now - point > MISS_GRACE_MS) return { due: false, reason: 'missed', scheduledAt: point };
    return { due: true, reason: 'due', scheduledAt: point };
  }

  // daily
  const point = todayPoint(schedule, now);
  if (now < point) return { due: false, reason: 'not-yet', scheduledAt: point };
  if (last !== null && last >= point) return { due: false, reason: 'already-ran', scheduledAt: point };
  if (now - point > MISS_GRACE_MS) return { due: false, reason: 'missed', scheduledAt: point };
  return { due: true, reason: 'due', scheduledAt: point };
}

/**
 * 下一次运行时间。
 *
 * 语义上**永远返回未来时刻**（或关闭时返回 null）：调用方要展示的
 * 「下次运行」是「这一轮过去之后的下一次」，所以即使此刻正 due，
 * 返回的也是再下一个点。
 */
export function computeNextRun(schedule, now, lastRunAt) {
  if (schedule.enabled !== true) return null;

  if (schedule.mode === 'interval') {
    const intervalMs = schedule.hours * 3600_000;
    const last = lastRunOf(lastRunAt);
    if (last === null) return now + intervalMs;
    const point = last + intervalMs;
    return point > now ? point : now + intervalMs;
  }

  const point = todayPoint(schedule, now);
  if (now < point) return point;
  const tomorrow = new Date(point);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getTime();
}

/**
 * 界面/接口上一行中文描述。
 *
 * 关闭状态也要写出来：`/state` 的 `scheduleView.description` 是接口的一部分，
 * 关着的时候只回「每天 03:00」会让人以为定时备份正在跑。
 */
export function describeSchedule(schedule) {
  const when =
    schedule.mode === 'interval'
      ? schedule.hours % 24 === 0
        ? `每 ${schedule.hours / 24} 天`
        : `每 ${schedule.hours} 小时`
      : `每天 ${schedule.at}`;
  return schedule.enabled === true ? when : `已关闭（配置：${when}）`;
}

/**
 * 按「保留最近 N 份」算出该删哪些包（返回文件名，从新到旧 —— 也就是按时间倒序）。
 *
 * 两条安全设计：
 *  1. `keep <= 0` 表示**不清理**，不是「全删」—— 配错一个 0 不该把备份清空。
 *  2. `mtimeMs` 读不出来（缺失/非数字）的包按**最新**排，永远不删 ——
 *     日期不明的文件不该被自动删除，宁可多留一份。
 */
export function pruneKeep(archives, keep) {
  if (!Array.isArray(archives)) return [];
  const n = Number(keep);
  if (!Number.isFinite(n) || n <= 0) return [];
  const sorted = [...archives].sort((a, b) => {
    const ta = Number.isFinite(a?.mtimeMs) ? a.mtimeMs : Number.POSITIVE_INFINITY;
    const tb = Number.isFinite(b?.mtimeMs) ? b.mtimeMs : Number.POSITIVE_INFINITY;
    return tb - ta;
  });
  return sorted
    .slice(n)
    .map((a) => a?.name)
    .filter((name) => typeof name === 'string' && name !== '');
}

/**
 * 这个 `.tar.gz` 是不是**本插件自己打的包**。
 *
 * 为什么必须有这道闸：`listArchives` 只按 `*.tar.gz` 后缀筛，不看前缀。
 * 用户的备份目录完全可能是个通用文件夹（甚至就填了 `D:\`），里面躺着别人的
 * 压缩包。自动清理要是按「保留最新 N 份」一刀切，就会把人家的文件删掉 ——
 * 这是本功能里唯一会**主动删用户数据**的地方，所以口径必须收到最紧：
 * 只认自己生成的时间戳命名。
 */
export function isOwnArchiveName(name) {
  return typeof name === 'string' && /^dsh-sync-\d{8}-\d{6}\.tar\.gz$/.test(name);
}
