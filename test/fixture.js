/**
 * 共享测试夹具：一棵仿真的 `~/.dsh` + `~/.agents/skills` 树。
 *
 * 仿真的三个要点（都是真机上会踩的）：
 *  1. 技能在 `~/.dsh` **之外**（`~/.agents/skills`）；
 *  2. 记忆与待办**同一棵树里交错**（`projects/<hash>/` 下 MEMORY.md 与 TODOS.md 是邻居）；
 *  3. 技能里带 `node_modules`，必须被跳过。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT = join(HERE, '..');

/** 2 条待办的待办文件内容，格式与真实文件一致。 */
export const TODO_FILE = [
  '<!--',
  '待办条目格式说明（程序自动维护，请勿手改结构）：',
  '- 条目以 § 分隔；第一条 § 之前的本注释块是格式说明，不是待办',
  '-->',
  '',
  '§',
  '[2026-10-07 13:59] [id: bd05fb63] [status: done] [cat: 运维]',
  '条目一',
  '§',
  '[2026-10-07 14:18] [id: 52cb5fe9] [status: pending]',
  '条目二',
  '',
].join('\n');

/**
 * 造夹具。
 * @param {{base?: string}} [opts] `base` 是 mkdtemp 的父目录，默认工程根（保证落在 D 盘）
 */
export async function makeFixture(opts = {}) {
  const base = opts.base ?? PROJECT;
  const root = await mkdtemp(join(base, '.tmp-fixture-'));
  const roots = {
    dshHome: join(root, '.dsh'),
    userHome: join(root, 'home'),
    profile: 'desktop',
    agentsSkills: join(root, 'home', '.agents', 'skills'),
  };

  // empty:true 只建出根结构，用来模拟「家里那台还没同步过的新机器」
  if (opts.empty !== true) await seed(roots);

  return { root, roots, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 把仿真树的内容写进去。 */
async function seed(roots) {
  const { dshHome, userHome, agentsSkills, profile } = roots;

  const put = async (abs, content) => {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };
  const at = (rel, content = 'x\n') => put(join(dshHome, rel), content);
  const skill = (name, rel, content = 'x\n') => put(join(agentsSkills, name, rel), content);

  // —— 技能：在 ~/.dsh 之外，这是本插件存在的首要理由
  await skill('cdp-browser-automation', 'SKILL.md', '# cdp\n');
  await skill('cdp-browser-automation', 'scripts/run.mjs', 'export {};\n');
  await skill('win-disk-cleaner', 'SKILL.md', '# cleaner\n');
  // 技能里带 node_modules 时必须被跳过
  await skill('cdp-browser-automation', 'node_modules/dep/index.js', 'module.exports={};\n');

  // —— 插件 + 配置
  await put(
    join(dshHome, 'profiles', profile, 'package.json'),
    `${JSON.stringify({ name: 'desktop', dsh: { profile: { bundles: ['a', 'b'] } } }, null, 2)}\n`,
  );
  await at(`profiles/${profile}/pnpm-lock.yaml`, 'lockfileVersion: 9\n');
  await at(`profiles/${profile}/.npmrc`, 'registry=https://registry.npmjs.org/\n');
  await at(`profiles/${profile}/cordis.patch.yml`, '- insert: []\n');
  await at('settings.yaml', 'a: 1\n');
  await at('AGENTS.md', '# rules\n');

  // —— 记忆与待办：同一棵树，交错
  await at('memories/MEMORY.md', '# memory\n');
  await at('memories/USER.md', '# user\n');
  await at('memories/SUGGESTIONS.jsonl', '{"a":1}\n');
  await at('memories/skills-state.json', '{}\n');
  await at('memories/daily/2026-10-13.md', '# daily\n');
  await at('memories/projects/0c4f6561d62a/MEMORY.md', '# p\n');
  await at('memories/projects/0c4f6561d62a/KEY.md', '[mem-aaaaaaaa] x\n');
  await at('memories/advisor/instructions/a.md', 'y\n');
  await put(join(dshHome, 'memories', 'daily', '2026-10-13.todo.md'), TODO_FILE);
  await put(join(dshHome, 'memories', 'daily', '2026-09-30.todo.md'), TODO_FILE);
  await put(join(dshHome, 'memories', 'projects', '0c4f6561d62a', 'TODOS.md'), TODO_FILE);
  await put(join(dshHome, 'memories', 'TODOS-life.md'), TODO_FILE);

  // —— 对话：两层目录
  await at('sessions/--C-Users-x-.dsh--/uuid-1/session.v4.jsonl.zstd', 'Z\n');
  await at('sessions/--C-Users-x-.dsh--/uuid-2/session.v4.jsonl.zstd', 'ZZ\n');
}

/**
 * 在夹具上跑一段逻辑，结束自动清理。
 * 两种写法都支持：`withFixture(fn)` 与 `withFixture({ empty: true }, fn)`。
 */
export async function withFixture(a, b) {
  const [opts, fn] = typeof a === 'function' ? [b ?? {}, a] : [a ?? {}, b];
  const fx = await makeFixture(opts);
  try {
    return await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

/** 在工程目录下开一个临时输出目录，结束自动清理。 */
export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(PROJECT, prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
