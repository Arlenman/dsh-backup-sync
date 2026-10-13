/**
 * scan.js 的测试。
 *
 * 用 `mkdtemp` 造一棵**仿真 fixture 树**，根路径整体注入 —— 绝不碰真实用户数据。
 * 仿真点：技能在 `~/.dsh` 之外；记忆与待办在同一棵树里交错；对话是两层目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, summarize } from '../lib/scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

/** 2 条待办的待办文件内容，格式与真实文件一致。 */
const TODO_FILE = [
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

async function makeFixture() {
  const root = await mkdtemp(join(PROJECT, '.tmp-scan-'));
  const dshHome = join(root, '.dsh');
  const userHome = join(root, 'home');
  const agentsSkills = join(userHome, '.agents', 'skills');
  const profile = 'desktop';

  const put = async (abs, content) => {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };
  const at = (rel) => put(join(dshHome, rel), 'x\n');
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
  await at(`profiles/${profile}/pnpm-lock.yaml`);
  await at(`profiles/${profile}/.npmrc`);
  await at(`profiles/${profile}/cordis.patch.yml`);
  await at('settings.yaml');
  await at('AGENTS.md');

  // —— 记忆与待办：同一棵树，交错
  await at('memories/MEMORY.md');
  await at('memories/USER.md');
  await at('memories/SUGGESTIONS.jsonl');
  await at('memories/skills-state.json');
  await at('memories/daily/2026-10-13.md');
  await at('memories/projects/0c4f6561d62a/MEMORY.md');
  await at('memories/projects/0c4f6561d62a/KEY.md');
  await at('memories/advisor/instructions/a.md');
  await put(join(dshHome, 'memories', 'daily', '2026-10-13.todo.md'), TODO_FILE);
  await put(join(dshHome, 'memories', 'daily', '2026-09-30.todo.md'), TODO_FILE);
  await put(join(dshHome, 'memories', 'projects', '0c4f6561d62a', 'TODOS.md'), TODO_FILE);
  await put(join(dshHome, 'memories', 'TODOS-life.md'), TODO_FILE);

  // —— 对话：两层目录
  await at('sessions/--C-Users-x-.dsh--/uuid-1/session.v4.jsonl.zstd');
  await at('sessions/--C-Users-x-.dsh--/uuid-2/session.v4.jsonl.zstd');

  return { root, roots: { dshHome, userHome, profile, agentsSkills } };
}

/** 在同一个 fixture 上跑一次扫描（每个断言各跑一次也行，但没必要）。 */
async function withFixture(fn) {
  const { root, roots } = await makeFixture();
  try {
    return await fn(await scan(roots), roots);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('技能从 ~/.agents/skills 扫到，且按技能目录计数', async () => {
  await withFixture((r) => {
    const s = r.modules.skills;
    assert.equal(s.count, 2, '两个技能目录');
    assert.equal(s.files, 3, 'SKILL.md ×2 + scripts/run.mjs，node_modules 被跳过');
    assert.ok(s.entries.every((e) => !e.relPath.includes('node_modules')));
  });
});

test('记忆与待办被正确分开（同一棵树，靠文件名切）', async () => {
  await withFixture((r) => {
    const mem = r.modules.memory;
    const todo = r.modules.todo;

    const memPaths = mem.entries.map((e) => e.relPath).sort();
    const todoPaths = todo.entries.map((e) => e.relPath).sort();

    assert.deepEqual(todoPaths, [
      'TODOS-life.md',
      'daily/2026-09-30.todo.md',
      'daily/2026-10-13.todo.md',
      'projects/0c4f6561d62a/TODOS.md',
    ]);
    assert.deepEqual(memPaths, [
      'MEMORY.md',
      'SUGGESTIONS.jsonl',
      'USER.md',
      'advisor/instructions/a.md',
      'daily/2026-10-13.md',
      'projects/0c4f6561d62a/KEY.md',
      'projects/0c4f6561d62a/MEMORY.md',
      'skills-state.json',
    ]);

    // 交集必须为空
    const overlap = memPaths.filter((p) => todoPaths.includes(p));
    assert.deepEqual(overlap, [], `记忆与待办切重了：${overlap.join(', ')}`);
  });
});

test('待办按条目数计，并给出四轨分布', async () => {
  await withFixture((r) => {
    const t = r.modules.todo;
    assert.equal(t.count, 8, '4 个文件 × 每个 2 条');
    assert.equal(t.countKind, 'entry');
    assert.deepEqual(t.tracks, { life: 2, project: 2, daily: 4 });
  });
});

test('插件与配置分开计数', async () => {
  await withFixture((r) => {
    assert.deepEqual(
      r.modules.plugins.entries.map((e) => e.relPath).sort(),
      ['.npmrc', 'package.json', 'pnpm-lock.yaml'],
    );
    assert.deepEqual(
      r.modules.config.entries.map((e) => e.relPath).sort(),
      ['AGENTS.md', 'cordis.patch.yml', 'settings.yaml'],
    );
  });
});

test('对话按会话目录计（两层深度），不是按文件', async () => {
  await withFixture((r) => {
    assert.equal(r.modules.sessions.count, 2, '两个会话目录');
    assert.equal(r.modules.sessions.files, 2);
  });
});

test('每个条目都带 sha256 / size / mtimeMs，哈希稳定可复现', async () => {
  await withFixture(async (r, roots) => {
    for (const mod of Object.values(r.modules)) {
      for (const e of mod.entries) {
        assert.match(e.sha256, /^[0-9a-f]{64}$/, `${e.relPath} 的哈希不合法`);
        assert.ok(Number.isInteger(e.size));
        assert.ok(Number.isInteger(e.mtimeMs));
      }
    }
    // 同一棵树扫两次，哈希必须一致
    const again = await scan(roots);
    const a = r.modules.config.entries.map((e) => `${e.relPath}=${e.sha256}`).sort();
    const b = again.modules.config.entries.map((e) => `${e.relPath}=${e.sha256}`).sort();
    assert.deepEqual(a, b);
  });
});

test('扫描不产生警告（fixture 全部可读）', async () => {
  await withFixture((r) => assert.deepEqual(r.warnings, []));
});

test('某个根不存在时记 exists=false 而不是报错', async () => {
  const { root, roots } = await makeFixture();
  try {
    await rm(roots.agentsSkills, { recursive: true, force: true });
    const r = await scan(roots);
    assert.equal(r.modules.skills.count, 0);
    assert.equal(r.modules.skills.files, 0);
    assert.equal(r.modules.skills.bases[0].exists, false);
    assert.deepEqual(r.warnings, [], '根不存在是正常情况，不该产生警告');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moduleIds 过滤生效', async () => {
  const { root, roots } = await makeFixture();
  try {
    const r = await scan(roots, { moduleIds: ['config', 'todo'] });
    assert.deepEqual(Object.keys(r.modules).sort(), ['config', 'todo']);
    assert.equal(r.totals.files, r.modules.config.files + r.modules.todo.files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('summarize 输出界面直接可用的结构', async () => {
  await withFixture((r) => {
    const s = summarize(r);
    assert.equal(s.length, 6);
    const todo = s.find((m) => m.id === 'todo');
    assert.equal(todo.label, '待办');
    assert.equal(todo.count, 8);
    assert.equal(todo.countKind, 'entry');
    const sessions = s.find((m) => m.id === 'sessions');
    assert.equal(sessions.defaultChecked, false);
    assert.match(sessions.note, /不上云/);
  });
});

test('totals 汇总全部模块', async () => {
  await withFixture((r) => {
    const sum = Object.values(r.modules).reduce((n, m) => n + m.files, 0);
    assert.equal(r.totals.files, sum);
    assert.ok(r.totals.bytes > 0);
  });
});
