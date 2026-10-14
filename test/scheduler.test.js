/**
 * 定时备份运行时的测试。
 *
 * 这里测的是「心跳到底会不会在该跑的时候跑、不该跑的时候忍住」——
 * 这类 bug 的特点是**平时完全看不出来**（要么永远不跑，要么每 60 秒打一个包），
 * 只有把时间与结果都注入进来才测得动。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SCHEDULE_STATE,
  createScheduler,
  loadScheduleState,
  removeArchiveSet,
  saveScheduleState,
  scheduleStatePathOf,
  scheduledModuleIds,
} from '../lib/scheduler.js';
import { normalizeSchedule } from '../lib/schedule.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

const HOUR = 3600_000;

/** 建一个受控环境：真目录（状态文件、边车删除都走真 IO）+ 假打包。 */
async function harness(over = {}) {
  const dir = await mkdtemp(join(PROJECT, '.tmp-sched-'));
  const roots = { dshHome: dir };
  const outDir = join(dir, 'packs');
  await mkdir(outDir, { recursive: true });

  const clock = { t: new Date(2026, 9, 14, 12, 0, 0, 0).getTime() };
  const calls = { backup: [], listed: [], pruned: [] };

  const schedule = normalizeSchedule(
    over.schedule ?? { enabled: true, mode: 'interval', hours: 6, keep: 7, includeBaseline: true },
  );

  const settings = { outDir: null, syncDir: null, allowDelete: false, includeBaseline: true, schedule };
  const loadSettings = async () => ({ ...settings, schedule });

  const runBackup =
    over.runBackup ??
    (async (r, opts) => {
      calls.backup.push(opts);
      const name = `dsh-sync-20261014-1200${String(calls.backup.length).padStart(2, '0')}.tar.gz`;
      const path = join(outDir, name);
      await writeFile(path, 'x');
      await writeFile(`${path}.sha256`, 'x');
      await writeFile(`${path}.meta.json`, '{}');
      return { ok: true, archive: { name, path, bytes: 10, bytesHuman: '10 B', totals: { files: 3 } }, credentials: [] };
    });

  const listArchiveDir =
    over.listArchiveDir ??
    (async () => {
      calls.listed.push(true);
      return [];
    });

  const sched = createScheduler({ roots, loadSettings, runBackup, listArchiveDir, now: () => clock.t, log: () => {} });

  if (over.state !== undefined) await saveScheduleState(roots, over.state);

  return {
    dir,
    roots,
    outDir,
    clock,
    calls,
    sched,
    schedule,
    settings,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ───────────────────────── 关闭 / 锚点 ─────────────────────────

test('关着的时候心跳什么都不做', async () => {
  const h = await harness({ schedule: { enabled: false } });
  try {
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'disabled');
    assert.equal(r.nextRunAt, null);
    assert.equal(h.calls.backup.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('★ 第一次启用只落锚点，不会在打开开关的瞬间打一个包', async () => {
  const h = await harness();
  try {
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'anchored');
    assert.equal(h.calls.backup.length, 0, '首次心跳绝不能真打包');

    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastPointAt, h.clock.t, '锚点必须落盘，否则每次心跳都往后推 → 永远不跑');
    assert.equal(st.lastRunAt, null);
    assert.equal(r.nextRunAt, h.clock.t + 6 * HOUR);
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── 该跑的时候要跑 ─────────────────────────

test('到点就跑，并把结果与包名落盘', async () => {
  const h = await harness();
  try {
    // 锚点在 6 小时 1 分钟前 → 调度点是 1 分钟前，落在 10 分钟宽限内
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });

    const r = await h.sched.tick();
    assert.equal(r.ran, true, `应触发，实得 ${r.reason}`);
    assert.equal(h.calls.backup.length, 1);

    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastRunAt, h.clock.t);
    assert.equal(st.runCount, 1);
    assert.equal(st.lastError, null);
    assert.match(st.lastArchive, /^dsh-sync-\d{8}-\d{6}\.tar\.gz$/);
    assert.equal(st.lastResult.totals.files, 3);
    assert.equal(st.lastPointAt, h.clock.t, '锚点重置到此刻，界面预告的下次时间才与实际一致');
  } finally {
    await h.cleanup();
  }
});

test('跑完立刻再来一拍不会重复跑', async () => {
  const h = await harness();
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });
    await h.sched.tick();
    const second = await h.sched.tick();
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'not-yet');
    assert.equal(h.calls.backup.length, 1, '一拍只许打一个包');
  } finally {
    await h.cleanup();
  }
});

test('★ 错过超过宽限 → 不补跑，但必须重新计时（否则永久卡死再也不跑）', async () => {
  const h = await harness();
  try {
    // 锚点在 20 小时前 → 调度点 14 小时前，远超 10 分钟宽限
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - 20 * HOUR });
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'missed');
    assert.equal(h.calls.backup.length, 0);
    assert.equal(r.nextRunAt, h.clock.t + 6 * HOUR, '错过之后要从现在重新计时');

    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastPointAt, h.clock.t, '锚点必须推进，否则每一拍都还是「错过」→ 永远不跑');

    // 把时钟拨到下一个点：必须真的跑起来
    h.clock.t += 6 * HOUR + 60_000;
    const later = await h.sched.tick();
    assert.equal(later.ran, true, `错过之后必须能恢复运行，实得 ${later.reason}`);
  } finally {
    await h.cleanup();
  }
});

test('★ daily 错过之后也重新计时，第二天照常跑', async () => {
  const h = await harness({ schedule: { enabled: true, mode: 'daily', at: '03:00' } });
  try {
    // 锚点在昨天 03:00，现在已经是今天 12:00 → 今天的点早过了
    await saveScheduleState(h.roots, { lastPointAt: new Date(2026, 9, 13, 3, 0, 0, 0).getTime() });
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'missed');

    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastPointAt, h.clock.t);

    // 下一拍不能还是 missed
    const again = await h.sched.tick();
    assert.equal(again.reason, 'already-ran', '锚点推进后应变成「今天已跑过」而不是继续错过');
    assert.equal(new Date(again.nextRunAt).getDate(), 15);
    assert.equal(new Date(again.nextRunAt).getHours(), 3);
  } finally {
    await h.cleanup();
  }
});

test('daily 模式：今天还没到点就不跑', async () => {
  const h = await harness({ schedule: { enabled: true, mode: 'daily', at: '23:30' } });
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - 20 * HOUR });
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'not-yet');
    assert.equal(new Date(r.nextRunAt).getHours(), 23);
    assert.equal(new Date(r.nextRunAt).getMinutes(), 30);
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── 失败处理 ─────────────────────────

test('★ 打包失败时记下原因、消费掉这个点，且不每 60 秒重试', async () => {
  const h = await harness({
    runBackup: async () => {
      throw new Error('磁盘满了');
    },
  });
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000), runCount: 4 });
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'failed');
    assert.equal(r.error, '磁盘满了');

    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastError, '磁盘满了');
    assert.equal(st.lastPointAt, h.clock.t, '失败也要推进锚点，否则会一直重试');
    assert.equal(st.lastRunAt, null, '没成功就不该写 lastRunAt');
    assert.equal(st.runCount, 4, '失败的尝试不算一次运行');

    const again = await h.sched.tick();
    assert.equal(again.reason, 'not-yet', '不该马上重试');
  } finally {
    await h.cleanup();
  }
});

test('定时备份里没有可打包的模块时直接失败，不去调 runBackup', async () => {
  const h = await harness({ schedule: { enabled: true, mode: 'interval', hours: 6, moduleIds: ['sessions'] } });
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });
    const r = await h.sched.tick();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'failed');
    assert.match(r.error, /没有可打包的模块/);
    assert.equal(h.calls.backup.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('状态文件坏掉时当作「没跑过」，重新锚点而不是崩', async () => {
  const h = await harness();
  try {
    const file = scheduleStatePathOf(h.roots);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{ 这不是 JSON', 'utf8');
    const st = await loadScheduleState(h.roots);
    assert.equal(st.corrupted, true);
    assert.equal(st.lastPointAt, null);

    const r = await h.sched.tick();
    assert.equal(r.reason, 'anchored');
    assert.equal(h.calls.backup.length, 0);
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── 对话模块硬闸 ─────────────────────────

test('★ 定时备份的模块清单里永远没有对话，哪怕设置里写了', async () => {
  const h = await harness({
    schedule: { enabled: true, mode: 'interval', hours: 6, moduleIds: ['skills', 'sessions', 'memory'] },
  });
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });
    await h.sched.tick();
    assert.equal(h.calls.backup.length, 1);
    assert.deepEqual(h.calls.backup[0].moduleIds, ['skills', 'memory']);
    assert.equal(h.calls.backup[0].moduleIds.includes('sessions'), false);
  } finally {
    await h.cleanup();
  }
});

test('scheduledModuleIds：没配就用默认勾选（对话本来就不在默认里）', () => {
  const ids = scheduledModuleIds({ moduleIds: null });
  assert.ok(ids.includes('skills'));
  assert.ok(ids.includes('config'));
  assert.equal(ids.includes('sessions'), false);
  assert.deepEqual(scheduledModuleIds({ moduleIds: ['sessions'] }), []);
});

// ───────────────────────── 清理旧包 ─────────────────────────

test('★ 按保留份数清掉最旧的包，主包与两个边车一起删', async () => {
  const h = await harness({
    schedule: { enabled: true, mode: 'interval', hours: 6, keep: 2 },
    listArchiveDir: async () => [
      { name: 'dsh-sync-20261011-030000.tar.gz', mtimeMs: 100 },
      { name: 'dsh-sync-20261012-030000.tar.gz', mtimeMs: 200 },
      { name: 'dsh-sync-20261013-030000.tar.gz', mtimeMs: 300 },
      { name: 'dsh-sync-20261014-030000.tar.gz', mtimeMs: 400 },
    ],
  });
  try {
    // 先造出这四个包的真文件
    for (const n of [
      'dsh-sync-20261011-030000.tar.gz',
      'dsh-sync-20261012-030000.tar.gz',
      'dsh-sync-20261013-030000.tar.gz',
      'dsh-sync-20261014-030000.tar.gz',
    ]) {
      await writeFile(join(h.outDir, n), 'x');
      await writeFile(join(h.outDir, `${n}.sha256`), 'x');
      await writeFile(join(h.outDir, `${n}.meta.json`), '{}');
    }
    // 让 runBackup 把包打在同一个目录里
    h.settings.outDir = h.outDir;
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });

    const r = await h.sched.tick();
    assert.equal(r.ran, true);
    assert.deepEqual(r.pruned, ['dsh-sync-20261012-030000.tar.gz', 'dsh-sync-20261011-030000.tar.gz']);

    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastPruned.length, 2);
    // 主包与边车都没了
    await assert.rejects(() => readFile(join(h.outDir, 'dsh-sync-20261011-030000.tar.gz'), 'utf8'));
    await assert.rejects(() => readFile(join(h.outDir, 'dsh-sync-20261011-030000.tar.gz.sha256'), 'utf8'));
    await assert.rejects(() => readFile(join(h.outDir, 'dsh-sync-20261011-030000.tar.gz.meta.json'), 'utf8'));
    // 该留的还在
    await readFile(join(h.outDir, 'dsh-sync-20261014-030000.tar.gz'), 'utf8');
  } finally {
    await h.cleanup();
  }
});

test('★ 别人的 tar.gz 一个都不许删（备份目录可能被填成通用文件夹）', async () => {
  const h = await harness({
    schedule: { enabled: true, mode: 'interval', hours: 6, keep: 1 },
    listArchiveDir: async () => [
      { name: 'mysql-dump.tar.gz', mtimeMs: 10 },
      { name: 'photos-backup.tar.gz', mtimeMs: 20 },
      { name: 'dsh-sync-20261014-030000.tar.gz', mtimeMs: 400 },
    ],
  });
  try {
    for (const n of ['mysql-dump.tar.gz', 'photos-backup.tar.gz', 'dsh-sync-20261014-030000.tar.gz']) {
      await writeFile(join(h.outDir, n), 'x');
    }
    h.settings.outDir = h.outDir;
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });

    const r = await h.sched.tick();
    assert.equal(r.ran, true);
    assert.deepEqual(r.pruned, [], '只有 1 份自己的包，keep=1，不该删任何东西');
    await readFile(join(h.outDir, 'mysql-dump.tar.gz'), 'utf8');
    await readFile(join(h.outDir, 'photos-backup.tar.gz'), 'utf8');
  } finally {
    await h.cleanup();
  }
});

test('keep=0 表示不清理（配错一个 0 不该把备份清空）', async () => {
  const h = await harness({
    schedule: { enabled: true, mode: 'interval', hours: 6, keep: 0 },
    listArchiveDir: async () => [
      { name: 'dsh-sync-20261011-030000.tar.gz', mtimeMs: 100 },
      { name: 'dsh-sync-20261012-030000.tar.gz', mtimeMs: 200 },
    ],
  });
  try {
    for (const n of ['dsh-sync-20261011-030000.tar.gz', 'dsh-sync-20261012-030000.tar.gz']) {
      await writeFile(join(h.outDir, n), 'x');
    }
    h.settings.outDir = h.outDir;
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });
    const r = await h.sched.tick();
    assert.deepEqual(r.pruned, []);
    await readFile(join(h.outDir, 'dsh-sync-20261011-030000.tar.gz'), 'utf8');
  } finally {
    await h.cleanup();
  }
});

test('★ 刚打出来的那份包永远不会被自己清掉（keep=1 也不删）', async () => {
  const h = await harness({
    schedule: { enabled: true, mode: 'interval', hours: 6, keep: 1 },
    // 目录里已有一份「更新的」别人的包，让刚打的那份排第二
    listArchiveDir: async () => [
      { name: 'dsh-sync-20261014-120000.tar.gz', mtimeMs: 9e15 },
      { name: 'dsh-sync-20261014-120001.tar.gz', mtimeMs: 1 },
    ],
  });
  try {
    h.settings.outDir = h.outDir;
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });
    const r = await h.sched.tick();
    assert.equal(r.ran, true);
    const justMade = r.archive.name;
    assert.equal(r.pruned.includes(justMade), false, '不能把自己刚打出来的包删了');
    await readFile(join(h.outDir, justMade), 'utf8');
  } finally {
    await h.cleanup();
  }
});

test('removeArchiveSet：非自己命名的文件直接拒绝，不碰', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.outDir, 'someone-else.tar.gz'), 'x');
    const r = await removeArchiveSet(h.outDir, 'someone-else.tar.gz');
    assert.equal(r.removed, false);
    await readFile(join(h.outDir, 'someone-else.tar.gz'), 'utf8');
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── 立即跑一次 / 重入 / 状态 ─────────────────────────

test('立即跑一次：无视调度点直接跑，并把该点消费掉', async () => {
  const h = await harness();
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t }); // 刚锚点，离到点还早
    const r = await h.sched.runNow();
    assert.equal(r.ran, true);
    assert.equal(h.calls.backup.length, 1);
    const st = await loadScheduleState(h.roots);
    assert.equal(st.lastRunAt, h.clock.t);
    assert.equal(st.lastPointAt, h.clock.t, '刚锚点过，被消费的点就是锚点本身');
  } finally {
    await h.cleanup();
  }
});

test('★ 正在跑的时候再来一拍只会拿到 busy，不会叠第二个包', async () => {
  let release;
  const gate = new Promise((res) => {
    release = res;
  });
  const h = await harness({
    runBackup: async () => {
      await gate;
      return { ok: true, archive: { name: 'dsh-sync-20261014-120000.tar.gz', path: join(h_out(), 'x.tar.gz'), bytes: 1, bytesHuman: '1 B' }, credentials: [] };
    },
  });
  function h_out() {
    return h.outDir;
  }
  try {
    h.settings.outDir = h.outDir;
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000) });
    const first = h.sched.tick();
    await new Promise((r) => setTimeout(r, 20));
    const second = await h.sched.tick();
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'busy');
    release();
    const done = await first;
    assert.equal(done.ran, true);
  } finally {
    await h.cleanup();
  }
});

test('status() 给出界面要的：调度、状态、下次运行、以及为什么现在不跑', async () => {
  const h = await harness();
  try {
    await saveScheduleState(h.roots, { lastPointAt: h.clock.t - (6 * HOUR + 60_000), lastRunAt: h.clock.t - 6 * HOUR });
    const s = await h.sched.status();
    assert.equal(s.schedule.enabled, true);
    assert.equal(s.reason, 'due');
    assert.equal(s.due, true);
    assert.equal(s.nextRunAt, h.clock.t + 6 * HOUR, '与跑完之后算出来的下次时间必须一致');
    assert.equal(s.state.lastRunAt, h.clock.t - 6 * HOUR);
    assert.ok(s.statePath.endsWith('schedule.json'));
  } finally {
    await h.cleanup();
  }
});

test('start/stop 幂等，且重复 start 不会挂两个心跳', async () => {
  const h = await harness({ schedule: { enabled: false } });
  try {
    assert.equal(h.sched.start(), true);
    assert.equal(h.sched.start(), false, '第二次 start 应该是空操作');
    assert.equal(h.sched.stop(), true);
    assert.equal(h.sched.stop(), true);
    assert.equal(h.sched.start(), true, '停掉之后还能再起');
    h.sched.stop();
  } finally {
    await h.cleanup();
  }
});

test('默认状态对象是「什么都没跑过」，不是 undefined', () => {
  assert.equal(DEFAULT_SCHEDULE_STATE.lastPointAt, null);
  assert.equal(DEFAULT_SCHEDULE_STATE.lastRunAt, null);
  assert.equal(DEFAULT_SCHEDULE_STATE.runCount, 0);
  assert.equal(DEFAULT_SCHEDULE_STATE.lastError, null);
});
