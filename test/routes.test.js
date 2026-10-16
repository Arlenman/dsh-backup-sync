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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROUTE_PREFIX, buildRoutes } from '../lib/routes.js';
import { loadSettings, settingsPathOf } from '../lib/settings.js';
import { loadScheduleState, scheduleStatePathOf } from '../lib/scheduler.js';
import { runBackup } from '../lib/service.js';
import { startFakeWebdav } from './fake-webdav.js';
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
  for (const p of ['/schedule', '/schedule/run-now', '/skills', '/plugins', '/file']) {
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

// ───────────────────────── /plugins ─────────────────────────

test('★ /plugins：界面按这份应答逐个渲染插件行，字段一个都不能少', async () => {
  await withFixture(async (fx) => {
    const profileDir = join(fx.roots.dshHome, 'profiles', fx.roots.profile);
    // 夹具的 profile 清单只有 bundles；这里补一条依赖，用来验证「只在 dependencies
    // 里 = 宿主不会挂载」的标法（真正装的包也要在清单里声明，否则算孤儿）。
    await writeFile(
      join(profileDir, 'package.json'),
      `${JSON.stringify({ name: fx.roots.profile, dependencies: { 'dsh-notify-me': '^1.5.3' }, dsh: { profile: { bundles: ['a', 'b'] } } }, null, 2)}\n`,
      'utf8',
    );
    await mkdir(join(profileDir, 'node_modules', 'dsh-notify-me', 'locale'), { recursive: true });
    await writeFile(
      join(profileDir, 'node_modules', 'dsh-notify-me', 'package.json'),
      `${JSON.stringify({ name: 'dsh-notify-me', version: '1.5.3', dsh: { bundle: { patch: 'x.yml' } } })}\n`,
      'utf8',
    );
    await writeFile(
      join(profileDir, 'node_modules', 'dsh-notify-me', 'locale', 'zh.json'),
      `${JSON.stringify({ meta: { title: '通知提醒', description: '审批、提问、回复完成时弹系统通知' } })}\n`,
      'utf8',
    );

    const { status, body } = await finder(fx).get('/plugins');
    assert.equal(status, 200);
    assert.equal(body.profile, fx.roots.profile);
    assert.equal(body.profileDir, profileDir);
    assert.deepStrictEqual(body.bundles, ['a', 'b'], '夹具的 bundles 原样回传');

    const notify = body.plugins.find((p) => p.name === 'dsh-notify-me');
    assert.equal(notify.title, '通知提醒');
    assert.equal(notify.titleSource, 'zh');
    assert.equal(notify.version, '1.5.3');
    assert.equal(notify.description, '审批、提问、回复完成时弹系统通知');
    assert.equal(notify.bundled, false, '夹具的 bundles 里没有它 → 界面标「仅依赖」');
    assert.equal(notify.installed, true);
    assert.equal(notify.kind, 'third-party');
    assert.equal(typeof notify.dir, 'string');

    assert.deepStrictEqual(body.dependencyOnly, ['dsh-notify-me']);
    assert.equal(body.totals.all, 3);
    assert.equal(body.totals.enabled, 2, 'bundles 里的两个（夹具里都没装）');
    assert.equal(body.totals.missing, 2);
    assert.deepStrictEqual(body.orphans, [], '装了但没写进清单的才叫孤儿，它写在 dependencies 里');
  });
});

test('/plugins：profile 还没同步过来（没有 package.json）时如实报错，不是空清单', async () => {
  await withFixture({ empty: true }, async (fx) => {
    const { status, body } = await finder(fx).get('/plugins');
    assert.equal(status, 200, '这是业务答案，不是 HTTP 错误');
    assert.equal(body.ok, false);
    assert.ok(String(body.manifestError).includes('package.json'));
    assert.deepStrictEqual(body.plugins, []);
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

// ───────────────────────── 云端接口

/**
 * 夹具 + 假 WebDAV + 路由表。
 *
 * 假服务器在**进入 try 之前**就启动，所以从启动那一行起所有代码都必须在 try 里 ——
 * 否则夹具自己抛错会把监听中的 socket 留到测试进程跑完不退出（cloud.test.js 踩过）。
 */
async function withCloudRoutes(fn, serverOpts = {}) {
  return withFixture(async (fx) => {
    const davRoot = join(fx.root, 'dav-root');
    await mkdir(davRoot, { recursive: true });
    const outDir = join(fx.root, 'backups');
    const srv = await startFakeWebdav({ root: davRoot, username: 'u', password: 'p', ...serverOpts });
    try {
      const api = finder(fx);
      return await fn({ ...fx, srv, davRoot, outDir, ...api });
    } finally {
      await srv.stop();
    }
  });
}

test('路由表：八条 /cloud 路径都在，且方法合法不重复', () => {
  const paths = buildRoutes({ get: () => undefined }).map((r) => r.path);
  for (const p of [
    '/cloud/state',
    '/cloud/config',
    '/cloud/password',
    '/cloud/test',
    '/cloud/upload',
    '/cloud/list',
    '/cloud/download',
    '/cloud/remove',
  ]) {
    assert.ok(paths.includes(`${ROUTE_PREFIX}${p}`), `缺路由 ${p}`);
  }
});

test('★ /cloud/state：回配置与可上传的本地包，但**永远没有密码**', async () => {
  await withCloudRoutes(async ({ post, outDir, ...fx }) => {
    const backup = await runBackup(fx.roots, { moduleIds: ['skills'], outDir });
    const { body } = await post('/cloud/state', { outDir });

    assert.equal(body.ok, true);
    assert.equal(body.cloud.kind, 'webdav');
    assert.equal(body.cloud.enabled, false, '默认关着');
    assert.equal(body.cloud.ready, false, '没填地址没填密码 → 不该显示成可用');
    assert.equal(body.cloud.hasPassword, false);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /password"\s*:\s*"[^"]/, '响应里不能出现任何密码字段');
    assert.equal('password' in body.cloud, false);

    assert.ok(Array.isArray(body.localArchives));
    assert.equal(body.localArchives[0].name, backup.archive.name, '本地包列表要能被界面直接拿去当上传候选项');
  });
});

test('★ 备份目录留空时：列表接口回的就是「打一份新备份」会写进去的那个默认目录', async () => {
  await withCloudRoutes(async ({ post, ...fx }) => {
    // 全新安装的默认态：settings.outDir = null，界面上目录框也留空 → 请求不带 outDir。
    // 2026-10-16 在真机上暴露的缺陷：写盘那侧走 defaultArchiveDir（D:\dsh-backups-sync），
    // 列表这侧拿到的是 undefined → 界面永远显示「还没有备份包」、云端上传下拉空着。
    const before = await post('/cloud/state', {});
    assert.equal(typeof before.body.localDir, 'string', 'localDir 不能是 undefined');
    assert.ok(before.body.localDir.length > 0, `localDir 不能为空：${before.body.localDir}`);
    // 与宿主自己公布的「默认目录」必须一致 —— 不在测试里重算一遍默认值（那等于把实现抄一遍）
    const state0 = await post('/state', {});
    assert.equal(before.body.localDir, state0.body.settings.defaultOutDir);

    // 不带 outDir 打一份包 —— 等价于界面上目录框空着的点击行为
    const backup = await runBackup(fx.roots, { moduleIds: ['skills'] });
    assert.equal(backup.ok, true);
    assert.equal(
      backup.archive.path.startsWith(before.body.localDir),
      true,
      `包要落在列表接口报的那个目录里：包=${backup.archive.path} 目录=${before.body.localDir}`,
    );

    // 打完再看：列表接口必须能看见它（同一目录、同一口径）
    const after = await post('/cloud/state', {});
    assert.equal(after.body.localDir, before.body.localDir);
    assert.ok(
      after.body.localArchives.some((a) => a.name === backup.archive.name),
      '刚打出来的包必须出现在可上传列表里',
    );

    // /state 与 /settings 也要给同一个目录，界面上的占位提示才不会指错地方
    const state = await post('/state', {});
    assert.equal(state.body.outDir, before.body.localDir);
    assert.equal(state.body.settings.outDir, before.body.localDir);
  });
});

test('★ /cloud/config + /cloud/password：配置与密码分两个接口，密码只进不出', async () => {
  await withCloudRoutes(async ({ post, ...fx }) => {
    const saved = await post('/cloud/config', {
      url: fx.srv.url,
      username: 'u',
      remoteDir: '/dsh-backup/',
      enabled: true,
      autoUpload: true,
    });
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.cloud.url, fx.srv.url);
    assert.equal(saved.body.cloud.remoteDir, 'dsh-backup', '首尾斜杠要归一');
    assert.equal(saved.body.cloud.enabled, true);
    assert.equal(saved.body.cloud.hasPassword, false, '还没存密码');

    const pw = await post('/cloud/password', { password: 'p' });
    assert.equal(pw.body.hasPassword, true);
    assert.equal(JSON.stringify(pw.body).includes('"p"'), false, '回执里不能有密码本身');

    const state = await post('/cloud/state', {});
    assert.equal(state.body.cloud.ready, true);
    assert.equal(state.body.cloud.remoteUrl, `${fx.srv.url}dsh-backup/`, '要给出人看的远端位置');

    const cleared = await post('/cloud/password', { clear: true });
    assert.equal(cleared.body.hasPassword, false);

    // 非法输入要在这一层就被挡下，不能等到上传时才发现
    const bad = await post('/cloud/config', { remoteDir: '../evil' });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /\.\./);
    const bad2 = await post('/cloud/config', { url: 'ftp://x/y' });
    assert.equal(bad2.body.ok, false);
  });
});

test('★ /cloud/test：save=true 先存后测；密码错如实回 401', async () => {
  await withCloudRoutes(async ({ post, srv, ...fx }) => {
    const good = await post('/cloud/test', {
      save: true,
      url: srv.url,
      username: 'u',
      password: 'p',
      remoteDir: 'dsh-backup',
      enabled: true,
    });
    assert.equal(good.body.ok, true);
    assert.equal(good.body.result.ok, true, JSON.stringify(good.body.result));
    assert.equal(good.body.result.remoteDir, 'dsh-backup');
    assert.equal(good.body.cloud.ready, true, 'save=true 要真的落盘');
    assert.ok((await loadSettings(fx.roots)).cloud.url === srv.url);

    const bad = await post('/cloud/test', { password: 'wrong' });
    assert.equal(bad.body.ok, true, '接口调用成功，「连不上」是业务答案');
    assert.equal(bad.body.result.ok, false);
    assert.equal(bad.body.result.status, 401);
    assert.match(bad.body.result.error, /认证|密码|401/);
  });
});

test('★ /cloud 上传/列表/下载/删除：一条链路走通，且只认自有命名', async () => {
  await withCloudRoutes(async ({ post, outDir, srv, ...fx }) => {
    await post('/cloud/config', { url: srv.url, username: 'u', remoteDir: 'dsh-backup', enabled: true });
    await post('/cloud/password', { password: 'p' });

    const backup = await runBackup(fx.roots, { moduleIds: ['skills'], outDir });
    const up = await post('/cloud/upload', { outDir });
    assert.equal(up.body.ok, true, JSON.stringify(up.body));
    assert.equal(up.body.archive.name, backup.archive.name, '不指定就传最新那一份');
    assert.equal(up.body.files.length, 3, '包 + .sha256 + .meta.json');
    assert.equal(up.body.lastUpload.name, backup.archive.name);

    const list = await post('/cloud/list', { outDir });
    assert.equal(list.body.ok, true);
    assert.equal(list.body.files.length, 1, '边车不当包列');
    assert.equal(list.body.files[0].isOwn, true);
    assert.equal(list.body.files[0].localExists, true);

    // 非自有命名：在碰任何文件之前就该被挡（看服务器有没有收到请求）
    const beforeRequests = srv.requests.length;
    for (const name of ['别人的备份.tar.gz', '../evil.tar.gz']) {
      const d = await post('/cloud/download', { name, outDir });
      assert.equal(d.body.ok, false, `${name} 不该被允许下载`);
      assert.match(d.body.error, /不是本插件|只认/);
      const r = await post('/cloud/remove', { name });
      assert.equal(r.body.ok, false, `${name} 不该被允许删除`);
      assert.match(r.body.error, /不是本插件|只认/);
    }
    assert.equal(srv.requests.length, beforeRequests, '被拒的请求不该真的发到服务器上');

    const dl = await post('/cloud/download', { name: backup.archive.name, outDir });
    assert.equal(dl.body.ok, false);
    assert.match(dl.body.error, /已存在/, '默认不覆盖本地已有的包');
    const dl2 = await post('/cloud/download', { name: backup.archive.name, outDir, overwrite: true });
    assert.equal(dl2.body.ok, true, JSON.stringify(dl2.body));
    assert.equal(dl2.body.sha256, backup.archive.sha256);
    assert.equal(dl2.body.verified, true);

    const rm = await post('/cloud/remove', { name: backup.archive.name });
    assert.equal(rm.body.ok, true);
    assert.equal(rm.body.removed.length, 3);
    const again = await post('/cloud/remove', { name: backup.archive.name });
    assert.equal(again.body.ok, true, '重复删除要幂等');

    const noName = await post('/cloud/download', {});
    assert.equal(noName.body.ok, false);
    assert.match(noName.body.error, /包名/);
  });
});

test('★ /cloud/upload：远端只读时如实回状态码与服务器原文，不留 lastUpload', async () => {
  await withCloudRoutes(
    async ({ post, outDir, ...fx }) => {
      await post('/cloud/config', { url: fx.srv.url, username: 'u', remoteDir: 'dsh-backup', enabled: true });
      await post('/cloud/password', { password: 'p' });
      await runBackup(fx.roots, { moduleIds: ['skills'], outDir });

      const up = await post('/cloud/upload', { outDir });
      assert.equal(up.body.ok, false);
      assert.equal(up.body.status, 403, '要把服务器给的状态码带回来');
      assert.match(up.body.error, /403|只读|拒绝/);

      const state = await post('/cloud/state', {});
      assert.equal(state.body.cloud.lastUpload, null, '失败了不能留下「已上传」的痕迹');
    },
    { readonly: true },
  );
});
