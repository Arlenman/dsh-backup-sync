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
 * @property {string} profile      profile 名，默认 desktop
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
