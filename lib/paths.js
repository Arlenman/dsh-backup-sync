/**
 * 根路径解析。
 *
 * 要点：**技能库在 `<userHome>/.agents/skills`，不在 `~/.dsh` 里**。
 * 这正是本插件存在的首要理由 —— `@xiaoyuyu6420/dsh-backup` 只备份 `~/.dsh`，
 * 够不到技能，而技能就是用户的工作流本体。
 *
 * 所有根都允许整体覆盖：测试注入 fixture 目录，**绝不碰真实用户数据**。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * @typedef {object} Roots
 * @property {string} dshHome      DSH 主目录，默认 ~/.dsh
 * @property {string} userHome     用户主目录
 * @property {string} profile      profile 名。优先级：profileContext.name > DSH_PROFILE > 'desktop'
 * @property {string} agentsSkills 技能库，<userHome>/.agents/skills
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Partial<Roots>} [overrides] 测试用：整体覆盖任意根
 * @returns {Roots}
 */
export function resolveRoots(env = process.env, overrides = {}) {
  const userHome = env.USERPROFILE || env.HOME || homedir();
  const dshHome = env.DSH_HOME || join(userHome, '.dsh');
  const base = {
    dshHome: resolve(dshHome),
    userHome: resolve(userHome),
    profile: env.DSH_PROFILE || 'desktop',
    agentsSkills: resolve(env.DSH_AGENTS_SKILLS || join(userHome, '.agents', 'skills')),
  };
  return { ...base, ...overrides };
}

/** 归一化成正斜杠（POSIX）相对路径，供所有模式匹配统一使用。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 本插件解析根路径时关心的全部环境变量。 */
const ENV_NAMES = ['USERPROFILE', 'HOME', 'DSH_HOME', 'DSH_PROFILE', 'DSH_AGENTS_SKILLS'];

/**
 * 从宿主 Context 取一个「读环境变量」的函数。
 *
 * **不要直接用 `process.env`**：内核的权威来源是 `launchEnvironment` 服务
 * （`@deepseek-ai/dsh-launch-environment`，把 process / project-env / user-env 三层
 * 合成一个不可变快照，桌面端启动时会显式把 DSH_HOME 等值灌进去）。
 * 宿主进程的 `process.env` 未必带着这些值，解析错了 dshHome 就会备份到空目录、
 * 导入时写到错位置 —— 所以这里两条路都走，服务优先、进程环境兜底。
 *
 * 注意**不 import `@deepseek-ai/dsh-launch-environment`**：那是宿主自带的包，
 * 插件自己的 node_modules 里没有，import 会直接崩。用 `ctx.get()` 拿服务即可。
 *
 * @param {any} ctx 宿主 Cordis Context
 * @returns {(name: string) => string|undefined}
 */
export function launchEnvReader(ctx) {
  const snapshot = typeof ctx?.get === 'function' ? ctx.get('launchEnvironment', false) : undefined;
  if (snapshot !== undefined && snapshot !== null && typeof snapshot.get === 'function') {
    return (name) => {
      const entry = snapshot.get(name);
      return entry !== undefined && entry !== null && typeof entry.value === 'string' ? entry.value : undefined;
    };
  }
  return (name) => {
    const v = process.env[name];
    return typeof v === 'string' ? v : undefined;
  };
}

/**
 * 从宿主 Context 取 profile 名。
 *
 * ★ 权威来源是 `profileContext` 服务（`dsh/lib/profile-boot-*.js` 里
 * `hostCtx.provide("profileContext", {name, dir, …})`），**不是环境变量**。
 *
 * 为什么不能用 `DSH_PROFILE`：那个变量由 `dsh-shell-env` 的 `collect()`
 * 在**每次 shell 工具执行时**现算，宿主进程的 `process.env` 里根本没有它，
 * 于是永远落到 `'desktop'` 兜底。真机上已经暴露过后果：在 `dsh web`
 * （profile = web）实例上打的包，里面装的是 `profiles/desktop/*`；
 * 换一台只有 web profile 的机器，`profiles/desktop` 不存在，`sanityOf()`
 * 会拒绝一切备份与导入 —— 插件直接不可用。
 *
 * @param {any} ctx 宿主 Cordis Context
 * @returns {string|undefined}
 */
export function profileNameFromContext(ctx) {
  const pc = typeof ctx?.get === 'function' ? ctx.get('profileContext', false) : undefined;
  const name = pc?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
}

/**
 * 用宿主 Context 解析根路径。逻辑与 `resolveRoots` 完全一致，只是取值来源换成
 * `launchEnvironment`。拿到结果后**务必**用 `service.js` 的 `sanityOf` 体检再动写操作。
 *
 * @param {any} ctx 宿主 Cordis Context
 * @param {Partial<Roots>} [overrides]
 * @returns {Roots}
 */
export function rootsFromContext(ctx, overrides = {}) {
  const read = launchEnvReader(ctx);
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of ENV_NAMES) {
    const value = read(name);
    if (typeof value === 'string' && value.trim() !== '') env[name] = value;
  }
  // profileContext 优先于 DSH_PROFILE（后者在宿主进程里通常压根不存在，见上）
  const fromService = profileNameFromContext(ctx);
  if (fromService !== undefined) env.DSH_PROFILE = fromService;
  return resolveRoots(env, overrides);
}
