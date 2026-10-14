/**
 * 定时备份的纯逻辑测试。
 *
 * 这一层刻意做成纯函数：调度是最容易「看起来对、实际错」的东西
 * （跨天、错过窗口、时区、第一次启用该不该立刻跑），必须能在离线把它钉死。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SCHEDULE,
  MISS_GRACE_MS,
  computeNextRun,
  describeSchedule,
  dueInfo,
  isOwnArchiveName,
  normalizeSchedule,
  parseAt,
  pruneKeep,
  sanitizeScheduledModules,
} from '../lib/schedule.js';

/** 本地时间戳助手：把「2026-10-14 09:30:00」这种可读时间转成 ms。 */
function at(y, mo, d, h, mi, s = 0) {
  return new Date(y, mo - 1, d, h, mi, s, 0).getTime();
}

// ───────────────────────── parseAt / normalizeSchedule ─────────────────────────

test('parseAt：接受 HH:MM 与 H:M，拒绝垃圾', () => {
  assert.deepEqual({ ...parseAt('03:00') }, { hour: 3, minute: 0 });
  assert.deepEqual({ ...parseAt('3:5') }, { hour: 3, minute: 5 });
  assert.deepEqual({ ...parseAt(' 23:59 ') }, { hour: 23, minute: 59 });
  assert.equal(parseAt('24:00'), null);
  assert.equal(parseAt('12:60'), null);
  assert.equal(parseAt('nope'), null);
  assert.equal(parseAt(''), null);
  assert.equal(parseAt(null), null);
  assert.equal(parseAt(1234), null);
});

test('normalizeSchedule：空输入给默认值，且默认是关的', () => {
  const s = normalizeSchedule(undefined);
  assert.equal(s.enabled, false);
  assert.equal(s.mode, DEFAULT_SCHEDULE.mode);
  assert.equal(s.at, DEFAULT_SCHEDULE.at);
  assert.equal(s.hours, DEFAULT_SCHEDULE.hours);
  assert.equal(s.keep, DEFAULT_SCHEDULE.keep);
  assert.equal(s.moduleIds, null);
  assert.equal(s.includeBaseline, true);
});

test('normalizeSchedule：越界值被夹住，而不是抛错', () => {
  const s = normalizeSchedule({ hours: 999, keep: -5, at: '25:99', mode: 'weird' });
  assert.equal(s.hours, 720);
  assert.equal(s.keep, 0);
  assert.equal(s.at, DEFAULT_SCHEDULE.at);
  assert.equal(s.mode, 'daily');
});

test('normalizeSchedule：hours 下限是 1（0 会让心跳每 60 秒打一个包）', () => {
  assert.equal(normalizeSchedule({ hours: 0 }).hours, 1);
  assert.equal(normalizeSchedule({ hours: -3 }).hours, 1);
  assert.equal(normalizeSchedule({ hours: '6' }).hours, 6);
});

test('normalizeSchedule：at 补零，keep 上限 200', () => {
  assert.equal(normalizeSchedule({ at: '7:5' }).at, '07:05');
  assert.equal(normalizeSchedule({ keep: 999 }).keep, 200);
  assert.equal(normalizeSchedule({ keep: '12' }).keep, 12);
});

test('normalizeSchedule：moduleIds 去重、剔除未知模块、空数组保持空', () => {
  assert.deepEqual(normalizeSchedule({ moduleIds: ['skills', 'skills', 'nope'] }).moduleIds, ['skills']);
  assert.deepEqual(normalizeSchedule({ moduleIds: [] }).moduleIds, [], '明确什么都没选就是空，不该变成默认全勾');
  assert.equal(normalizeSchedule({ moduleIds: 'skills' }).moduleIds, null);
  assert.equal(normalizeSchedule({ moduleIds: ['nope', 'zzz'] }).moduleIds, null, '全是垃圾 id 当成没配');
});

test('★ normalizeSchedule 必须幂等 —— saveSettings 会再归一一次', () => {
  for (const input of [[], ['nope'], ['sessions'], ['skills', 'sessions'], ['skills'], null, 'x']) {
    const once = normalizeSchedule({ moduleIds: input }).moduleIds;
    const twice = normalizeSchedule({ moduleIds: once }).moduleIds;
    assert.deepEqual(twice, once, `moduleIds=${JSON.stringify(input)} 归一两次结果不一致`);
  }
});

test('★ normalizeSchedule：对话硬闸在写入时就生效，存下来的清单里没有 sessions', () => {
  assert.deepEqual(normalizeSchedule({ moduleIds: ['skills', 'sessions', 'memory'] }).moduleIds, ['skills', 'memory']);
  assert.deepEqual(normalizeSchedule({ moduleIds: ['sessions'] }).moduleIds, []);
});

test('sanitizeScheduledModules：对话模块永远进不了定时备份', () => {
  assert.deepEqual(sanitizeScheduledModules(['skills', 'sessions', 'memory']), ['skills', 'memory']);
  assert.deepEqual(sanitizeScheduledModules(null), []);
  assert.deepEqual(sanitizeScheduledModules(['sessions']), []);
});

// ───────────────────────── daily 模式 ─────────────────────────

test('daily：还没到点 → 下次是今天的点，且不触发', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' });
  const now = at(2026, 10, 14, 1, 30);
  const info = dueInfo(s, now, null);
  assert.equal(info.due, false);
  assert.equal(info.reason, 'not-yet');
  assert.equal(computeNextRun(s, now, null), at(2026, 10, 14, 3, 0));
});

test('daily：刚过点且在宽限内 → 触发', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' });
  const now = at(2026, 10, 14, 3, 2);
  const info = dueInfo(s, now, at(2026, 10, 13, 3, 0));
  assert.equal(info.due, true);
  assert.equal(info.reason, 'due');
  assert.equal(info.scheduledAt, at(2026, 10, 14, 3, 0));
});

test('daily：已经跑过今天的点 → 不重复跑，下次明天', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' });
  const now = at(2026, 10, 14, 3, 5);
  const info = dueInfo(s, now, at(2026, 10, 14, 3, 1));
  assert.equal(info.due, false);
  assert.equal(info.reason, 'already-ran');
  assert.equal(computeNextRun(s, now, at(2026, 10, 14, 3, 1)), at(2026, 10, 15, 3, 0));
});

test('daily：错过超过宽限 → 不补跑，直接等明天（用户选的策略 A）', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' });
  const now = at(2026, 10, 14, 9, 0); // DSH 早上九点才开机
  const info = dueInfo(s, now, at(2026, 10, 13, 3, 0));
  assert.equal(info.due, false);
  assert.equal(info.reason, 'missed');
  assert.equal(computeNextRun(s, now, at(2026, 10, 13, 3, 0)), at(2026, 10, 15, 3, 0));
});

test('daily：宽限边界 —— 正好等于宽限算触发，多 1 毫秒算错过', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' });
  const point = at(2026, 10, 14, 3, 0);
  assert.equal(dueInfo(s, point + MISS_GRACE_MS, null).due, true);
  assert.equal(dueInfo(s, point + MISS_GRACE_MS + 1, null).due, false);
});

test('daily：跨午夜 —— 23:50 时下次是明天 03:00', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' });
  assert.equal(computeNextRun(s, at(2026, 10, 14, 23, 50), null), at(2026, 10, 15, 3, 0));
});

test('daily：零点整这个点本身也能正确算（不能因为 setHours 进位算成后天）', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'daily', at: '00:00' });
  assert.equal(computeNextRun(s, at(2026, 10, 14, 0, 0), null), at(2026, 10, 15, 0, 0));
  assert.equal(dueInfo(s, at(2026, 10, 14, 0, 0), null).due, true);
});

// ───────────────────────── interval 模式 ─────────────────────────

test('interval：从没跑过 → 不立刻跑，等满一个间隔', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'interval', hours: 6 });
  const now = at(2026, 10, 14, 10, 0);
  const info = dueInfo(s, now, null);
  assert.equal(info.due, false);
  assert.equal(info.reason, 'not-yet');
  assert.equal(computeNextRun(s, now, null), now + 6 * 3600_000);
});

test('interval：差 1 分钟不到点 → 不跑', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'interval', hours: 24 });
  const last = at(2026, 10, 13, 10, 0);
  const info = dueInfo(s, at(2026, 10, 14, 9, 59), last);
  assert.equal(info.due, false);
  assert.equal(info.reason, 'not-yet');
});

test('interval：到点即跑', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'interval', hours: 24 });
  const last = at(2026, 10, 13, 10, 0);
  const now = at(2026, 10, 14, 10, 0);
  const info = dueInfo(s, now, last);
  assert.equal(info.due, true);
  assert.equal(info.scheduledAt, now);
});

test('interval：错过超过宽限 → 不补跑，从现在重新计时', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'interval', hours: 6 });
  const last = at(2026, 10, 13, 10, 0); // 一天前
  const now = at(2026, 10, 14, 10, 0);
  const info = dueInfo(s, now, last);
  assert.equal(info.due, false);
  assert.equal(info.reason, 'missed');
  assert.equal(computeNextRun(s, now, last), now + 6 * 3600_000);
});

// ───────────────────────── 关闭态 ─────────────────────────

test('关闭时永不触发，且没有下次运行时间', () => {
  const s = normalizeSchedule({ enabled: false, mode: 'daily', at: '03:00' });
  const info = dueInfo(s, at(2026, 10, 14, 3, 1), null);
  assert.equal(info.due, false);
  assert.equal(info.reason, 'disabled');
  assert.equal(computeNextRun(s, at(2026, 10, 14, 3, 1), null), null);
});

test('lastRunAt 是垃圾值时当作「没跑过」，不能因此每 60 秒跑一次', () => {
  const s = normalizeSchedule({ enabled: true, mode: 'interval', hours: 6 });
  const now = at(2026, 10, 14, 10, 0);
  assert.equal(dueInfo(s, now, NaN).due, false);
  assert.equal(dueInfo(s, now, 'x').due, false);
  assert.equal(dueInfo(s, now, 0).due, false);
});

// ───────────────────────── describeSchedule ─────────────────────────

test('describeSchedule：中文描述跟着模式走，关闭状态要写出来', () => {
  assert.equal(describeSchedule(normalizeSchedule({ enabled: true, mode: 'daily', at: '03:00' })), '每天 03:00');
  assert.equal(describeSchedule(normalizeSchedule({ enabled: true, mode: 'interval', hours: 1 })), '每 1 小时');
  assert.equal(describeSchedule(normalizeSchedule({ enabled: true, mode: 'interval', hours: 48 })), '每 2 天');
  // 关着的时候只回「每天 03:00」，读接口的人会以为它正在跑。
  assert.equal(describeSchedule(normalizeSchedule({ enabled: false, mode: 'daily', at: '03:00' })), '已关闭（配置：每天 03:00）');
  assert.equal(describeSchedule(normalizeSchedule({ enabled: false, mode: 'interval', hours: 6 })), '已关闭（配置：每 6 小时）');
  assert.equal(describeSchedule(normalizeSchedule({})), '已关闭（配置：每天 03:00）', '默认就是关闭');
});

// ───────────────────────── pruneKeep ─────────────────────────

const packs = [
  { name: 'a.tar.gz', mtimeMs: 100 },
  { name: 'b.tar.gz', mtimeMs: 300 },
  { name: 'c.tar.gz', mtimeMs: 200 },
  { name: 'd.tar.gz', mtimeMs: 400 },
];

test('pruneKeep：保留最新 N 份，返回要删的（从旧到新）', () => {
  assert.deepEqual(pruneKeep(packs, 2), ['c.tar.gz', 'a.tar.gz']);
  assert.deepEqual(pruneKeep(packs, 4), []);
  assert.deepEqual(pruneKeep(packs, 9), []);
});

test('pruneKeep：keep=0 表示不清理，不是「全删」', () => {
  assert.deepEqual(pruneKeep(packs, 0), []);
  assert.deepEqual(pruneKeep(packs, -1), []);
});

test('pruneKeep：keep>=1 时最新那份永远不会出现在删除名单里', () => {
  for (let k = 1; k <= 4; k++) {
    assert.equal(pruneKeep(packs, k).includes('d.tar.gz'), false, `keep=${k} 竟然要删最新包`);
  }
});

test('pruneKeep：mtimeMs 缺失/非数字的排到最后（最旧），不会崩', () => {
  const messy = [...packs, { name: 'z.tar.gz' }, { name: 'y.tar.gz', mtimeMs: 'x' }];
  const del = pruneKeep(messy, 4);
  assert.deepEqual(del.sort(), ['a.tar.gz', 'c.tar.gz']);
});

test('pruneKeep：入参不是数组时返回空数组', () => {
  assert.deepEqual(pruneKeep(null, 2), []);
  assert.deepEqual(pruneKeep(undefined, 2), []);
});

// ───────────────────────── 只删自己的包 ─────────────────────────

test('★ isOwnArchiveName：只认自己打的时间戳包，别人的 tar.gz 一律不认', () => {
  assert.equal(isOwnArchiveName('dsh-sync-20261013-180657.tar.gz'), true);
  assert.equal(isOwnArchiveName('dsh-sync-20261013-180657.tar.gz.sha256'), false);
  assert.equal(isOwnArchiveName('dsh-sync-20261013-180657.tar.gz.meta.json'), false);
  // 下面这些是「备份目录被填成通用文件夹」时真实会遇到的邻居
  assert.equal(isOwnArchiveName('mysql-backup.tar.gz'), false);
  assert.equal(isOwnArchiveName('dsh-sync-manual.tar.gz'), false, '没有时间戳就不算我们的');
  assert.equal(isOwnArchiveName('dsh-sync-2026-10-13.tar.gz'), false);
  assert.equal(isOwnArchiveName('dsh-sync-20261013-180657.zip'), false);
  assert.equal(isOwnArchiveName('xdsh-sync-20261013-180657.tar.gz'), false);
  assert.equal(isOwnArchiveName(''), false);
  assert.equal(isOwnArchiveName(null), false);
  assert.equal(isOwnArchiveName(123), false);
});
