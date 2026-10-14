/**
 * 新增接口的 HTTP 层测试：`/schedule`、`/schedule/run-now`、`/skills`、`/file`。
 *
 * 这一层要盯两件事：
 *  ① **形状**：客户端完全按返回的字段渲染，少一个字段界面就空一块；
 *  ② **口径**：「不能看」「没到点」这类**业务答案**必须是 `ok:true` + 中文原因，
 *     不能变成 `ok:false` 的错误 —— 否则界面会弹一个红色报错，
 *     而用户看到的内容（比如「这是二进制文件」）根本不是错误。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROUTE_PREFIX, buildRoutes } from '../lib/routes.js';
import { loadSettings, settingsPathOf } from '../lib/settings.js';
import { loadScheduleState, scheduleStatePathOf } from '../lib/scheduler.js';
import { withFixture, withTempDir } from './fixture.js';

function finder(fx, opts = {}) {
  const routes = buildRoutes({ get: () => undefined }, { resolveRoots: () => fx.roots, ...opts });
  const find = (p) => {
    const r = routes.find((x) => x.path === `${ROUTE_PREFIX}${p}`);
    assert.ok(r !== undefined, `路由 ${p} 不存在`);
    return r;
  };
  const post = async (p, body) => {
    const res = await find(p).fetch(
      new Request(`http://x/api/dsh-backup-sync${p}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    );
    return { status: res.status, body: await res.json() };
  };
  const get = async (p) => {
    const res = await find(p).fetch(new Request(`http://x/api/dsh-backup-sync${p}`, { method: 'GET' }));
    return { status: res.status, body: await res.json() };
  };
  return { routes, find, post, get };
}

// ───────────────────────── 路由表形状 ─────────────────────────

test('路由表：新增四条路径都合法、方法不重复', () => {
  const routes = buildRoutes({ get: () => undefined });
  const paths = routes.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length, '路径不能重复');
  for (const r of routes) {
    assert.ok(r.path.startsWith(`${ROUTE_PREFIX}/`), `${r.path} 必须在 /api 下`);
    assert.ok(r.methods.length > 0);
    assert.equal(new Set(r.methods).size, r.methods.length, `${r.path} 方法不能重复`);
    for (const m of r.methods) assert.ok(['GET', 'POST'].includes(m), `${r.path} 的方法 ${m} 不合法`);
  }
  for (const p of ['/schedule', '/schedule/run-now', '/skills', '/file']) {
    assert.ok(paths.includes(`${ROUTE_PREFIX}${p}`), `缺路由 ${p}`);
  }
});

// ───────────────────────── /state 带调度信息 ─────────────────────────

test('★ /state 回传调度设置与调度状态 —— 界面靠它渲染定时备份卡片', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    const { body } = await post('/state', {});
    assert.equal(body.ok, true);
    assert.ok(body.settings.schedule !== undefined, 'settings 里必须有 schedule');
    assert.equal(body.settings.schedule.enabled, false, '默认关');
    assert.equal(body.settings.schedule.mode, 'daily');
    assert.equal(body.settings.schedule.at, '03:00');
    assert.equal(body.settings.schedule.keep, 7);

    const v = body.scheduleView;
    assert.ok(v !== undefined, '/state 必须带 scheduleView');
    assert.equal(v.description, '已关闭（配置：每天 03:00）', '关着的时候不能只说「每天 03:00」，读接口的人会以为它在跑');
    assert.equal(v.due, false);
    assert.equal(v.reason, 'disabled');
    assert.equal(v.nextRunAt, null);
    assert.equal(v.state.lastRunAt, null);
    assert.equal(v.state.runCount, 0);
    assert.ok(String(v.statePath).endsWith('schedule.json'));
  });
});

test('/state：没配过的模块清单是 null（表示「用默认勾选」），不是空数组', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    const { body } = await post('/state', {});
    assert.equal(body.settings.schedule.moduleIds, null);
  });
});

// ───────────────────────── /schedule ─────────────────────────

test('/schedule GET：只读状态，不改设置', async () => {
  await withFixture(async (fx) => {
    const { get } = finder(fx);
    const { status, body } = await get('/schedule');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.schedule.enabled, false);
    assert.ok(body.scheduleView !== undefined);
    const onDisk = await loadSettings(fx.roots);
    assert.equal(onDisk.schedule.enabled, false);
  });
});

test('★ /schedule POST：开启定时备份并落盘', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    const { body } = await post('/schedule', { enabled: true, mode: 'daily', at: '23:30', keep: 3 });
    assert.equal(body.ok, true);
    assert.equal(body.schedule.enabled, true);
    assert.equal(body.schedule.at, '23:30');
    assert.equal(body.schedule.keep, 3);
    assert.equal(body.scheduleView.description, '每天 23:30');

    const onDisk = await loadSettings(fx.roots);
    assert.equal(onDisk.schedule.enabled, true);
    assert.equal(onDisk.schedule.at, '23:30');
    assert.equal(onDisk.schedule.keep, 3);
  });
});

test('★ /schedule POST：只改保留份数不会重置计时锚点（否则白白推迟一个周期）', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    await post('/schedule', { enabled: true, mode: 'interval', hours: 6 });
    // 手动把锚点写成一个确定值，模拟「已经跑过一轮」
    const anchor = Date.now() - 60_000;
    await writeFile(
      scheduleStatePathOf(fx.roots),
      `${JSON.stringify({ version: 1, lastPointAt: anchor, runCount: 2 }, null, 2)}\n`,
      'utf8',
    );

    await post('/schedule', { keep: 2 });
    const st = await loadScheduleState(fx.roots);
    assert.equal(st.lastPointAt, anchor, '只改保留份数不该动锚点');
    assert.equal(st.runCount, 2);

    await post('/schedule', { hours: 12 });
    const st2 = await loadScheduleState(fx.roots);
    assert.equal(st2.lastPointAt, null, '改频率必须重新锚点');
  });
});

test('★ /schedule POST：手改坏的值被归一，不会把界面卡死', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    const { body } = await post('/schedule', { enabled: 'yes', mode: 'hourly', at: '99:99', hours: 0, keep: -5 });
    assert.equal(body.schedule.enabled, false, '非 true 一律关');
    assert.equal(body.schedule.mode, 'daily', '不认识的方式回默认');
    assert.equal(body.schedule.at, '03:00');
    assert.equal(body.schedule.hours, 1, '小时数钳到下限');
    assert.equal(body.schedule.keep, 0, '保留份数允许 0（表示不清理）');
  });
});

test('★ /schedule POST：模块清单里的对话被硬闸剔除', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    const { body } = await post('/schedule', { moduleIds: ['skills', 'sessions', 'memory'] });
    assert.deepEqual(body.schedule.moduleIds, ['skills', 'memory']);
  });
});

test('/schedule POST：只传 moduleIds 为 null 表示回到默认勾选', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    await post('/schedule', { moduleIds: ['skills'] });
    const { body } = await post('/schedule', { moduleIds: null });
    assert.equal(body.schedule.moduleIds, null);
  });
});

// ───────────────────────── /schedule/run-now ─────────────────────────

test('★ /schedule/run-now：立刻打一个包，并把结果写进调度状态', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const { post } = finder(fx);
      // 先设一个模块清单（默认勾选里含 skills/config 等，夹具里都有内容）
      await post('/schedule', { moduleIds: ['skills', 'config'] });
      const { body } = await post('/schedule/run-now', { outDir });
      assert.equal(body.ok, true);
      assert.equal(body.ran, true, `应立即运行，实得 ${body.reason ?? ''} ${body.error ?? ''}`);
      assert.match(body.archive.name, /^dsh-sync-\d{8}-\d{6}\.tar\.gz$/);
      assert.equal(body.archive.path.startsWith(outDir), true);
      assert.ok(body.scheduleView.state.lastRunAt > 0);
      assert.equal(body.scheduleView.state.lastArchive, body.archive.name);
      assert.equal(body.scheduleView.state.runCount, 1);
    });
  });
});

test('★ /schedule/run-now：没有可打包的模块时给中文原因，不抛 500', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    await post('/schedule', { moduleIds: ['sessions'] }); // 会被硬闸剔成空
    const { status, body } = await post('/schedule/run-now', {});
    assert.equal(status, 200, '业务失败不该是 500');
    assert.equal(body.ran, false);
    assert.equal(body.reason, 'failed');
    assert.match(body.error, /没有可打包的模块/);
  });
});

// ───────────────────────── /skills ─────────────────────────

test('★ /skills：一行一个技能，带名字、描述、文件数、体积与人类可读体积', async () => {
  await withFixture(async (fx) => {
    await writeFile(
      join(fx.roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md'),
      '---\nname: cdp-browser-automation\ndescription: 用 CDP 驱动浏览器\n---\n\n正文\n',
      'utf8',
    );
    const { get } = finder(fx);
    const { status, body } = await get('/skills');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2, '夹具里有两个技能');
    assert.equal(body.root, fx.roots.agentsSkills);

    const cdp = body.skills.find((s) => s.id === 'cdp-browser-automation');
    assert.equal(cdp.name, 'cdp-browser-automation');
    assert.equal(cdp.description, '用 CDP 驱动浏览器');
    assert.equal(cdp.files, 2);
    assert.ok(cdp.bytes > 0);
    assert.ok(typeof cdp.bytesHuman === 'string' && cdp.bytesHuman.length > 0);
    assert.equal(cdp.hasSkillMd, true);

    const cleaner = body.skills.find((s) => s.id === 'win-disk-cleaner');
    assert.equal(cleaner.description, 'cleaner', '没有 frontmatter 时退回正文（这里只有一行标题）');
    assert.equal(cleaner.descriptionSource, 'heading');
  });
});

test('/skills：技能库不存在时回空清单，不报错', async () => {
  await withFixture({ empty: true }, async (fx) => {
    const { status, body } = await finder(fx).get('/skills');
    assert.equal(status, 200);
    assert.deepEqual(body.skills, []);
    assert.equal(body.count, 0);
  });
});

// ───────────────────────── /file ─────────────────────────

test('★ /file：正常文件回内容，形状齐全', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    const { status, body } = await post('/file', { moduleId: 'config', relPath: 'settings.yaml' });
    assert.equal(status, 200);
    assert.equal(body.ok, true, '能看是成功');
    const v = body.view;
    assert.equal(v.viewable, true);
    assert.equal(v.text, 'a: 1\n');
    assert.equal(v.bytes, 5);
    assert.equal(v.truncated, false);
    assert.equal(v.binary, false);
    assert.equal(v.guard, null);
    assert.equal(v.moduleId, 'config');
    assert.equal(v.relPath, 'settings.yaml');
    assert.ok(String(v.absPath).endsWith(join('.dsh', 'settings.yaml')));
  });
});

test('★ /file：不能看时是 ok:true + viewable:false + 中文原因，不是红色报错', async () => {
  await withFixture(async (fx) => {
    const { post } = finder(fx);
    // 穿越路径
    const bad = await post('/file', { moduleId: 'config', relPath: '../.credentials.yaml' });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, true, '路径被拒是业务答案');
    assert.equal(bad.body.view.viewable, false);
    assert.equal(bad.body.view.text, null);
    assert.ok(bad.body.view.reason.length > 0);

    // 不认识的模块
    const unknown = await post('/file', { moduleId: 'nope', relPath: 'x' });
    assert.equal(unknown.body.ok, true);
    assert.equal(unknown.body.view.viewable, false);
    assert.match(unknown.body.view.reason, /不认识的模块/);

    // 文件不存在
    const missing = await post('/file', { moduleId: 'config', relPath: 'AGENTS.md.bak' });
    assert.equal(missing.body.ok, true);
    assert.equal(missing.body.view.viewable, false);
  });
});

test('★ /file：二进制文件如实说明，不把乱码当内容回', async () => {
  await withFixture(async (fx) => {
    await writeFile(join(fx.roots.dshHome, 'AGENTS.md'), Buffer.from([0x00, 0x41, 0x00, 0x42]));
    const { post } = finder(fx);
    const { body } = await post('/file', { moduleId: 'config', relPath: 'AGENTS.md' });
    assert.equal(body.view.viewable, false);
    assert.equal(body.view.binary, true);
    assert.equal(body.view.text, null);
    assert.match(body.view.reason, /二进制/);
  });
});

test('★ /file：请求体本身不合法才走错误分支', async () => {
  await withFixture(async (fx) => {
    const { find } = finder(fx);
    const res = await find('/file').fetch(
      new Request('http://x/api/dsh-backup-sync/file', { method: 'POST', body: '{oops' }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /JSON/);
  });
});

// ───────────────────────── 设置不被别的接口带坏 ─────────────────────────

test('★ 只读接口不许改任何设置文件', async () => {
  await withFixture(async (fx) => {
    const { get, post } = finder(fx);
    const path = settingsPathOf(fx.roots);
    const before = await loadSettings(fx.roots);
    const beforeText = await readFile(path, 'utf8').catch(() => null);

    await get('/state');
    await get('/schedule');
    await get('/skills');
    await post('/file', { moduleId: 'config', relPath: 'settings.yaml' });

    const after = await loadSettings(fx.roots);
    const afterText = await readFile(path, 'utf8').catch(() => null);
    assert.equal(afterText, beforeText, '只读接口不该往 settings.json 写东西');
    assert.deepEqual({ ...after, schedule: { ...after.schedule } }, { ...before, schedule: { ...before.schedule } });
  });
});
