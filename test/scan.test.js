/**
 * scan.js 的测试。
 *
 * 用 `mkdtemp` 造一棵**仿真 fixture 树**，根路径整体注入 —— 绝不碰真实用户数据。
 * 仿真点：技能在 `~/.dsh` 之外；记忆与待办在同一棵树里交错；对话是两层目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scan, summarize } from '../lib/scan.js';
import { makeFixture, withFixture as withFixtureRaw } from './fixture.js';

/** 在夹具上跑一次扫描：让每个断言都拿到「扫完的结果 + roots」。 */
const withFixture = (fn) => withFixtureRaw(async ({ roots }) => fn(await scan(roots), roots));

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

// ───────────────────────── 凭据守卫（承重） ─────────────────────────

/**
 * ★ 这条是「凭据永不进包」真正的落点。
 *
 * 光有 guard.js 的单测不够：守卫要**真的接在扫描链路上**才算数
 * （真机验收时就是在包里看到了 `profiles/desktop/.npmrc`，才回头确认这道闸的）。
 * `.npmrc` 恰恰是最容易被忽略的一个 —— 名字不在黑名单里，只有内容能判。
 */
test('★ 带 _authToken 的 .npmrc 被内容闸剔除，并如实记录原因（绝不静默跳过）', async () => {
  await withFixture(async (fx) => {
    const npmrc = join(fx.roots.dshHome, 'profiles', fx.roots.profile, '.npmrc');
    await writeFile(
      npmrc,
      'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWx\n',
      'utf8',
    );
    const r = await scan(fx.roots);

    const paths = r.modules.plugins.entries.map((e) => e.relPath);
    assert.ok(!paths.includes('.npmrc'), '带令牌的 .npmrc 绝不能进计划');
    assert.ok(paths.includes('package.json'), '同模块的其他文件不受影响');

    const hit = r.credentials.find((c) => c.relPath === '.npmrc');
    assert.ok(hit !== undefined, '被剔除的文件必须出现在 credentials 里');
    assert.equal(hit.moduleId, 'plugins');
    assert.match(hit.reason, /npm 认证令牌/);
    assert.ok(!hit.reason.includes('npm_AbCdEfGhIjKlMnOpQrStUvWx'), '原因里不许复述完整令牌');
    assert.match(hit.reason, /_authT…Wx/, '要给出打码片段（留头 6 尾 2），用户才判得出是不是误报');
  });
});

test('不带令牌的 .npmrc 正常进包（守卫别误伤真配置）', async () => {
  await withFixture(async (fx) => {
    await writeFile(join(fx.roots.dshHome, 'profiles', fx.roots.profile, '.npmrc'), 'store-dir=D:\\pnpm-store\n', 'utf8');
    const r = await scan(fx.roots);
    assert.ok(r.modules.plugins.entries.map((e) => e.relPath).includes('.npmrc'));
    assert.deepEqual(r.credentials, []);
  });
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
