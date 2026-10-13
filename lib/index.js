/**
 * 宿主半边入口。
 *
 * 内核认的插件形状（对照已装的 `dsh-context`）：`export { name, inject, apply }`。
 * `inject` 在这里是**宿主服务名**清单 —— 但本插件刻意留空：
 * 路由需要 `connection` 服务，而 `connection` 由内核的 `dsh-client-connection` 提供，
 * 万一它没加载，静态 inject 会让整个插件停在 pending（用户看到插件"没生效"却不知道为什么）。
 * 改成在 `apply` 里用 `ctx.inject(['connection'], …)` 懒等：服务到位就注册路由，
 * 没到位插件也照常挂着，只在宿主日志里留一行 —— 一个备份插件不该有能力拖垮启动。
 */
import { buildRoutes } from './routes.js';

export const name = 'dsh-backup-sync';

/** 宿主服务：一个都不硬依赖，全部懒解析。 */
export const inject = [];

/**
 * @param {any} ctx 宿主 Cordis Context
 */
export function apply(ctx) {
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection');
    const register =
      typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : undefined;

    if (register === undefined) {
      console.error('[dsh-backup-sync] connection.fetch.register 不可用，备份同步面板的接口未注册');
      return;
    }

    let registered = 0;
    for (const r of buildRoutes(ctx)) {
      try {
        // registerFetchRoute 自己会 owner.effect(...) 包一层；这里再包一层，
        // 让插件卸载时路由跟着走（与 dsh-context 的写法一致）。
        c.effect(() => register(r), `dsh-backup-sync: ${r.path}`);
        registered += 1;
      } catch (err) {
        console.error(`[dsh-backup-sync] 路由 ${r.path} 注册失败：${err?.message ?? err}`);
      }
    }
    console.log(`[dsh-backup-sync] 已注册 ${registered} 条接口`);
  });
}
