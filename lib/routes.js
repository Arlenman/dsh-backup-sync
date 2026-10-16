/**
 * HTTP 层：把 service.js 的五个动作翻译成宿主路由。
 *
 * 路由 API（从内核 `dsh-client-connection` 逆向，见 docs/notes/module-loader-contract.md）：
 *   ctx.inject(['connection'], (c) => {
 *     const register = c.get('connection').fetch.register;
 *     register({ path, methods, requestBody, fetch });
 *   })
 *
 * 三条硬约束（违反会在注册时抛错）：
 *   ① path 必须在 `/api/` 下，且 `/api/` 之后每段都匹配 `[A-Za-z0-9_$.-]+`；
 *   ② methods 非空且不重复；
 *   ③ 同一个 path 只能注册一次。
 *
 * **鉴权是自动的**：这些路由挂在共享 `/api` 通道上，外面套着
 * `connection.admit(req)`（Host/Origin 围栏 + 浏览器 cookie）。
 * 桌面端更省事 —— Electron 主进程把 `dsh-app://app/*` 全量转发给本地 Host
 * 并自己注入 cookie（main.js 的 forwardWebRequest），所以客户端里
 * `fetch('/api/dsh-backup-sync/state')` 就够了，不用管凭据。
 */
import {
  applyImport,
  collectState,
  defaultArchiveDir,
  human as humanBytes,
  listArchiveDir,
  previewImport,
  runBackup,
  syncCopy,
  syncList,
  verifyArchiveFull,
} from './service.js';
import { effective, loadSettings, saveSettings, settingsPathOf } from './settings.js';
import { rootsFromContext } from './paths.js';
import { createScheduler, loadScheduleState, saveScheduleState } from './scheduler.js';
import { describeSchedule, isOwnArchiveName, normalizeSchedule } from './schedule.js';
import { describeModuleFile } from './fileview.js';
import { listSkills } from './skills.js';
import {
  cloudView,
  downloadRemote,
  listRemote,
  removeRemote,
  saveCloudConfig,
  saveCloudPassword,
  testConnection,
  uploadArchive,
} from './cloud.js';

export const ROUTE_PREFIX = '/api/dsh-backup-sync';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function jsonOk(payload) {
  return new Response(JSON.stringify({ ok: true, ...payload }), { status: 200, headers: JSON_HEADERS });
}

function jsonFail(message, status = 400, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error: String(message ?? '未知错误'), ...extra }), {
    status,
    headers: JSON_HEADERS,
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`请求体不是合法 JSON：${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed;
}

/** 统一收口：解析请求体 → 跑业务 → 包成 JSON 响应；异常一律转成可读错误。 */
function route(fn) {
  return async (request) => {
    try {
      const body = request.method === 'POST' ? await readJson(request) : {};
      return jsonOk(await fn(body, request));
    } catch (err) {
      // 宿主日志里留一份堆栈，界面上只显示一行 —— 界面不该出现英文堆栈
      console.error('[dsh-backup-sync] 路由失败：', err);
      return jsonFail(err?.message ?? String(err));
    }
  };
}

/**
 * 云端接口专用收口。
 *
 * 比通用 `route` 多做一件事：把 WebDAV 失败里的 **HTTP 状态码与服务器原文** 一起
 * 交回界面。云端出错时「403」「401」「507」是三种完全不同的病因（权限/密码/满了），
 * 只说一句「上传失败」等于让用户去猜。约束 6 就是这条。
 */
function cloudRoute(fn) {
  return async (request) => {
    try {
      const body = request.method === 'POST' ? await readJson(request) : {};
      return jsonOk(await fn(body, request));
    } catch (err) {
      console.error('[dsh-backup-sync] 云端接口失败：', err);
      /** @type {Record<string, unknown>} */
      const extra = {};
      if (typeof err?.status === 'number') extra.status = err.status;
      if (typeof err?.method === 'string') extra.method = err.method;
      if (typeof err?.detail === 'string' && err.detail !== '') extra.detail = err.detail.slice(0, 600);
      // HTTP 一律 200：真正的结论在 JSON 的 ok/error/status 里。
      // 回 4xx 会让客户端的 fetch 包装层在解析前就短路，status/detail 全丢。
      return jsonFail(err?.message ?? String(err), 200, extra);
    }
  };
}

/**
 * 构造路由表。
 *
 * @param {any} ctx 宿主 Cordis Context
 * @param {{resolveRoots?: () => any, scheduler?: any}} [opts] 测试可注入 fixture 根目录与调度器
 * @returns {{path: string, methods: string[], requestBody: string, fetch: (r: Request) => Promise<Response>}[]}
 */
export function buildRoutes(ctx, opts = {}) {
  const resolve = typeof opts.resolveRoots === 'function' ? opts.resolveRoots : () => rootsFromContext(ctx);

  // 调度器由 index.js 创建并启动心跳；这里只是复用同一个实例。
  // 测试不传时按需自建（`roots` 用 getter，因为根目录是每次请求现算的）。
  const scheduler =
    opts.scheduler ??
    createScheduler({
      get roots() {
        return resolve();
      },
      loadSettings,
      runBackup,
      listArchiveDir,
      log: (m) => console.log(`[dsh-backup-sync] ${m}`),
    });

  const withSettings = async (body) => {
    const roots = resolve();
    const settings = await loadSettings(roots);
    const eff = effective(body.outDir, body.syncDir, settings);
    // 目录没填时，一律落到「打一份新备份会写进去的那个目录」（defaultArchiveDir）。
    // 2026-10-16 在真机上暴露：`effective()` 只回 settings.outDir（默认是 null），于是
    // 写盘的接口（runBackup → defaultArchiveDir）写进 D:\dsh-backups-sync，
    // 而**列表类**接口拿到的是 undefined → 界面永远显示「还没有备份包」、
    // 云端卡片的上传下拉也是空的。同一个默认目录必须在两处是同一个值。
    if (!eff.outDir) eff.outDir = defaultArchiveDir(roots, settings.outDir);
    return { roots, settings, eff };
  };

  /** 调度状态：界面要的「下次什么时候跑 / 为什么现在不跑」全在这里。 */
  const scheduleView = async (settings) => {
    const st = await scheduler.status();
    return {
      description: describeSchedule(settings.schedule),
      due: st.due,
      reason: st.reason,
      scheduledAt: st.scheduledAt,
      nextRunAt: st.nextRunAt,
      state: st.state,
      statePath: st.statePath,
    };
  };

  return [
    {
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, settings, eff } = await withSettings(body);
        const state = await collectState(roots, { outDir: eff.outDir });
        return {
          ...state,
          settings: {
            ...settings,
            settingsPath: settingsPathOf(roots),
            outDir: state.outDir,
            syncDir: eff.syncDir ?? null,
            defaultOutDir: defaultArchiveDir(roots),
          },
          scheduleView: await scheduleView(settings),
        };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/settings`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const roots = resolve();
        /** @type {Record<string, unknown>} */
        const patch = {};
        if ('outDir' in body) patch.outDir = body.outDir === null ? null : String(body.outDir).trim() || null;
        if ('syncDir' in body) patch.syncDir = body.syncDir === null ? null : String(body.syncDir).trim() || null;
        if ('allowDelete' in body) patch.allowDelete = body.allowDelete === true;
        if ('includeBaseline' in body) patch.includeBaseline = body.includeBaseline !== false;
        const next = await saveSettings(roots, patch);
        return { settings: next, settingsPath: settingsPathOf(roots) };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/backup`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, settings, eff } = await withSettings(body);
        // 用户手填的目录要记住（和 /sync/push 记住 syncDir 同一个道理）。
        // 不记的话：打完包一切换到「历史版本」就空了 —— 界面按 state.outDir 列包，
        // 而刷新页面时客户端不带 outDir，于是弹回默认目录，看起来像备份丢了。
        // 只记**显式传进来**的值，别把默认值固化进 settings.json。
        const requested = typeof body.outDir === 'string' ? body.outDir.trim() : '';
        if (requested !== '' && requested !== (settings.outDir ?? '')) {
          await saveSettings(roots, { outDir: requested });
        }
        return await runBackup(roots, {
          moduleIds: body.moduleIds,
          outDir: eff.outDir,
          name: body.name,
          includeBaseline: body.includeBaseline === undefined ? settings.includeBaseline : body.includeBaseline !== false,
        });
      }),
    },

    {
      path: `${ROUTE_PREFIX}/import/preview`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, settings, eff } = await withSettings(body);
        return await previewImport(roots, {
          archiveName: body.archiveName,
          archivePath: body.archivePath,
          outDir: eff.outDir,
          allowDelete: body.allowDelete === undefined ? settings.allowDelete : body.allowDelete === true,
        });
      }),
    },

    {
      path: `${ROUTE_PREFIX}/import/apply`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, settings, eff } = await withSettings(body);
        return await applyImport(roots, {
          archiveName: body.archiveName,
          archivePath: body.archivePath,
          outDir: eff.outDir,
          resolutions: body.resolutions,
          allowDelete: body.allowDelete === undefined ? settings.allowDelete : body.allowDelete === true,
          dryRun: body.dryRun === true,
        });
      }),
    },

    {
      path: `${ROUTE_PREFIX}/verify`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, eff } = await withSettings(body);
        return await verifyArchiveFull(roots, {
          archiveName: body.archiveName,
          archivePath: body.archivePath,
          outDir: eff.outDir,
        });
      }),
    },

    {
      path: `${ROUTE_PREFIX}/sync/push`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, settings, eff } = await withSettings(body);
        const targetDir = body.targetDir ?? eff.syncDir;
        if (typeof targetDir === 'string' && targetDir.trim() !== '' && targetDir !== settings.syncDir) {
          await saveSettings(roots, { syncDir: targetDir.trim() });
        }
        return await syncCopy(roots, { outDir: eff.outDir, targetDir, archiveName: body.archiveName });
      }),
    },

    {
      path: `${ROUTE_PREFIX}/sync/list`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { roots, settings, eff } = await withSettings(body);
        const targetDir = body.targetDir ?? eff.syncDir;
        if (typeof targetDir === 'string' && targetDir.trim() !== '' && targetDir !== settings.syncDir) {
          await saveSettings(roots, { syncDir: targetDir.trim() });
        }
        return await syncList(roots, { targetDir });
      }),
    },

    // ───────────────────────── 定时备份

    {
      path: `${ROUTE_PREFIX}/schedule`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const roots = resolve();
        const current = await loadSettings(roots);

        // 只有**计时相关**的字段变了才重置锚点。
        // 只改保留份数就把计时起点推到现在，会让下一次运行白白晚一个周期 ——
        // 用户改个「保留 7 份 → 保留 3 份」，不该顺带把定时备份推迟 6 小时。
        const TIMING_KEYS = ['enabled', 'mode', 'at', 'hours'];
        const changed = TIMING_KEYS.filter((k) => k in body);

        /** @type {Record<string, unknown>} */
        const patch = {};
        if (changed.length > 0 || 'keep' in body || 'moduleIds' in body || 'includeBaseline' in body) {
          const merged = { ...current.schedule };
          for (const key of ['enabled', 'mode', 'at', 'hours', 'keep', 'moduleIds', 'includeBaseline']) {
            if (key in body) merged[key] = body[key];
          }
          patch.schedule = normalizeSchedule(merged);
        }

        const settings = Object.keys(patch).length > 0 ? await saveSettings(roots, patch) : current;
        if (changed.length > 0) {
          // 改频率/开关之后重新锚点：否则「每 6 小时」会拿旧起点算，
          // 可能一改完就立刻跑一次（用户会以为设置没生效）。
          await saveScheduleState(roots, { lastPointAt: null });
        }
        return { settings, schedule: settings.schedule, scheduleView: await scheduleView(settings) };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/schedule/run-now`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const { settings, eff } = await withSettings(body);
        // 「立即跑一次」要尊重当前生效的输出目录（含界面上手填的那个）
        const patched = { ...settings, outDir: eff.outDir ?? settings.outDir };
        const out = await scheduler.execute(patched, Date.now());
        return { ...out, scheduleView: await scheduleView(settings) };
      }),
    },

    // ───────────────────────── 云端（WebDAV）

    {
      path: `${ROUTE_PREFIX}/cloud/state`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const { roots, eff } = await withSettings(body);
        const view = await cloudView(roots);
        // 顺带把本地可上传的包列出来：界面的「上传」下拉直接用它，
        // 省一次请求，也避免两次请求之间本地包发生变化造成对不上。
        const archives = (await listArchiveDir(eff.outDir))
          .filter((a) => isOwnArchiveName(a.name))
          .map((a) => ({ name: a.name, bytes: a.bytes, bytesHuman: a.bytesHuman, mtimeLocal: a.mtimeLocal, sha256: a.sha256 ?? null }))
          .slice(0, 20);
        return { cloud: view, localDir: eff.outDir, localArchives: archives };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/config`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const roots = resolve();
        /** @type {Record<string, unknown>} */
        const patch = {};
        // 只转交**显式出现**的字段：`enabled:false` 也是有效取值，不能靠真值判断
        if ('url' in body) patch.url = body.url === null ? null : String(body.url);
        if ('username' in body) patch.username = body.username === null ? null : String(body.username);
        if ('remoteDir' in body) patch.remoteDir = body.remoteDir === null ? '' : String(body.remoteDir);
        for (const key of ['enabled', 'insecureTLS', 'autoUpload']) {
          if (key in body) patch[key] = body[key] === true;
        }
        if (Object.keys(patch).length > 0) await saveCloudConfig(roots, patch);
        return { cloud: await cloudView(roots) };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/password`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const roots = resolve();
        // 空字符串 = 清除。界面上「留空」有两种意思，所以由 `clear` 显式区分：
        //   ① 只保存别的字段（留空 = 不动密码）→ 客户端**根本不调**这个接口；
        //   ② 明确要清掉密码 → `{clear:true}`。
        const clear = body.clear === true;
        const password = typeof body.password === 'string' ? body.password : '';
        if (clear) await saveCloudPassword(roots, '');
        else if (password !== '') await saveCloudPassword(roots, password);
        // 回执里只有布尔值 —— 密码只进不出
        return { hasPassword: (await cloudView(roots)).hasPassword, cleared: clear };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/test`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const roots = resolve();
        /** @type {Record<string, unknown>} */
        const draft = {};
        for (const key of ['url', 'username', 'password', 'remoteDir']) {
          if (typeof body[key] === 'string' && body[key] !== '') draft[key] = body[key];
        }
        if (body.insecureTLS === true) draft.insecureTLS = true;
        // 「保存并测试连接」：先把这次填的存下来，再按存下来的配置测。
        // 分两步的好处是**测通了就一定是存下来的那套配置能通** ——
        // 否则「测通了一次、过会儿又连不上」会变成一个查不明白的谜。
        if (body.save === true) {
          /** @type {Record<string, unknown>} */
          const patch = {};
          if ('url' in body) patch.url = body.url === null ? null : String(body.url);
          if ('username' in body) patch.username = body.username === null ? null : String(body.username);
          if ('remoteDir' in body) patch.remoteDir = body.remoteDir === null ? '' : String(body.remoteDir);
          for (const key of ['enabled', 'insecureTLS', 'autoUpload']) {
            if (key in body) patch[key] = body[key] === true;
          }
          if (Object.keys(patch).length > 0) await saveCloudConfig(roots, patch);
          if (typeof body.password === 'string' && body.password !== '') await saveCloudPassword(roots, body.password);
          return { result: await testConnection(roots), cloud: await cloudView(roots) };
        }
        return { result: await testConnection(roots, draft), cloud: await cloudView(roots) };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/upload`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const { roots, eff } = await withSettings(body);
        const out = await uploadArchive(roots, {
          name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name : undefined,
          outDir: eff.outDir,
        });
        return { ...out, cloud: await cloudView(roots) };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/list`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const { roots, eff } = await withSettings(body);
        return await listRemote(roots, { outDir: eff.outDir });
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/download`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const { roots, eff } = await withSettings(body);
        if (typeof body.name !== 'string' || body.name.trim() === '') throw new Error('要下载哪一份？请给出包名');
        const out = await downloadRemote(roots, body.name.trim(), {
          outDir: eff.outDir,
          overwrite: body.overwrite === true,
        });
        return { ...out, cloud: await cloudView(roots) };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/cloud/remove`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: cloudRoute(async (body) => {
        const roots = resolve();
        if (typeof body.name !== 'string' || body.name.trim() === '') throw new Error('要删除哪一份？请给出包名');
        return await removeRemote(roots, body.name.trim(), {});
      }),
    },

    // ───────────────────────── 只读查看

    {
      path: `${ROUTE_PREFIX}/skills`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: route(async () => {
        const roots = resolve();
        const skills = await listSkills(roots, { warn: (m) => console.warn(`[dsh-backup-sync] ${m}`) });
        return {
          skills: skills.map((s) => ({ ...s, bytesHuman: humanBytes(s.bytes) })),
          count: skills.length,
          root: roots.agentsSkills,
        };
      }),
    },

    {
      path: `${ROUTE_PREFIX}/file`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const roots = resolve();
        // 「不能看」是业务答案不是错误：一律 ok:true + viewable:false + 中文原因。
        // 只有请求本身不合法才走 jsonFail（这里 moduleId 缺失交给 resolveModuleFile 判）。
        return { view: await describeModuleFile(roots, { moduleId: body.moduleId, relPath: body.relPath }) };
      }),
    },
  ];
}
