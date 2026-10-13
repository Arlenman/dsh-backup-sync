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
  previewImport,
  runBackup,
  syncCopy,
  syncList,
  verifyArchiveFull,
} from './service.js';
import { effective, loadSettings, saveSettings, settingsPathOf } from './settings.js';
import { rootsFromContext } from './paths.js';

export const ROUTE_PREFIX = '/api/dsh-backup-sync';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function jsonOk(payload) {
  return new Response(JSON.stringify({ ok: true, ...payload }), { status: 200, headers: JSON_HEADERS });
}

function jsonFail(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: String(message ?? '未知错误') }), {
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
 * 构造路由表。
 *
 * @param {any} ctx 宿主 Cordis Context
 * @param {{resolveRoots?: () => any}} [opts] 测试可注入 fixture 根目录
 * @returns {{path: string, methods: string[], requestBody: string, fetch: (r: Request) => Promise<Response>}[]}
 */
export function buildRoutes(ctx, opts = {}) {
  const resolve = typeof opts.resolveRoots === 'function' ? opts.resolveRoots : () => rootsFromContext(ctx);

  const withSettings = async (body) => {
    const roots = resolve();
    const settings = await loadSettings(roots);
    const eff = effective(body.outDir, body.syncDir, settings);
    return { roots, settings, eff };
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
  ];
}
