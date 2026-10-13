/**
 * 业务层 + HTTP 层测试。
 *
 * 这里最要紧的一条是「换机首次导入」：基准留空才导得进去。
 * 一旦有人"好心"把包内基线接成基准，新机器上每个文件都会被判成
 * 「本地已删除 → 保持删除」，界面还显示成功 —— 静默失效，比报错更糟。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ROUTE_PREFIX, buildRoutes } from '../lib/routes.js';
import {
  applyImport,
  baselinePathOf,
  collectState,
  defaultArchiveDir,
  normalizeModuleIds,
  previewImport,
  runBackup,
  sanityOf,
  syncCopy,
  syncList,
  verifyArchiveFull,
} from '../lib/service.js';
import { loadSettings, saveSettings, settingsPathOf } from '../lib/settings.js';
import { makeFixture, withFixture, withTempDir } from './fixture.js';

/** 全新空机器：只建出 profile 骨架，好让 sanityOf 放行（模拟家里那台刚装好 DSH 的电脑）。 */
async function emptyMachine() {
  const fx = await makeFixture({ empty: true });
  await mkdir(join(fx.roots.dshHome, 'profiles', fx.roots.profile), { recursive: true });
  return fx;
}

const MODULES = ['skills', 'config', 'memory', 'todo'];

// ───────────────────────── 纯函数

test('normalizeModuleIds：缺省=默认勾选，显式=过滤未知并去重', () => {
  assert.deepEqual(normalizeModuleIds(undefined), ['skills', 'plugins', 'config', 'memory', 'todo']);
  assert.deepEqual(normalizeModuleIds(null), ['skills', 'plugins', 'config', 'memory', 'todo']);
  assert.deepEqual(normalizeModuleIds([]), []);
  assert.deepEqual(normalizeModuleIds(['todo', 'skills']), ['todo', 'skills']);
  assert.deepEqual(normalizeModuleIds(['todo', 'todo', 'nope', '', '  ']), ['todo']);
  assert.deepEqual(normalizeModuleIds('skills, todo ,bogus'), ['skills', 'todo']);
  assert.equal(normalizeModuleIds(undefined).includes('sessions'), false, '对话模块默认不勾选');
});

test('defaultArchiveDir：显式覆盖优先，否则本机 D 盘', () => {
  const roots = { dshHome: 'C:\\x\\.dsh', userHome: 'C:\\x', profile: 'desktop', agentsSkills: 'C:\\x\\s' };
  assert.equal(defaultArchiveDir(roots, 'D:\\somewhere'), 'D:\\somewhere');
  if (process.platform === 'win32' && existsSync('D:\\')) {
    assert.equal(defaultArchiveDir(roots), 'D:\\dsh-backups-sync');
  } else {
    assert.equal(defaultArchiveDir(roots), join('C:\\x', 'dsh-backups-sync'));
  }
});

test('sanityOf：profile 目录不在就拒绝写操作', async () => {
  await withFixture(async (fx) => {
    const good = sanityOf(fx.roots);
    assert.equal(good.safe, true);
    assert.equal(good.warnings.length, 0);

    const bad = sanityOf({ ...fx.roots, dshHome: join(fx.root, 'nowhere') });
    assert.equal(bad.safe, false);
    assert.match(bad.warnings.join(' '), /profile 目录不存在/);
    await assert.rejects(() => runBackup({ ...fx.roots, dshHome: join(fx.root, 'nowhere') }, { outDir: fx.root }), /拒绝备份/);
    await assert.rejects(
      () => applyImport({ ...fx.roots, dshHome: join(fx.root, 'nowhere') }, { archivePath: join(fx.root, 'x.tar.gz') }),
      /拒绝导入/,
    );
  });
});

// ───────────────────────── 首屏状态

test('collectState：六个模块、空历史、无基线', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const state = await collectState(fx.roots, { outDir });
      assert.equal(state.ok, true);
      assert.equal(state.scan.modules.length, 6);
      assert.deepEqual(
        state.scan.modules.map((m) => m.id),
        ['skills', 'plugins', 'config', 'memory', 'todo', 'sessions'],
      );
      const skills = state.scan.modules.find((m) => m.id === 'skills');
      assert.equal(skills.count, 2, '两个技能目录');
      assert.equal(skills.exists, true);
      assert.ok(skills.entries.length > 0, '面板要能看到技能里的文件');
      assert.equal(skills.entries.some((e) => e.relPath.includes('node_modules')), false, 'node_modules 必须被跳过');

      const sessions = state.scan.modules.find((m) => m.id === 'sessions');
      assert.equal(sessions.defaultChecked, false, '对话模块默认不勾选');

      assert.deepEqual(state.archives, []);
      assert.equal(state.outDirExists, true, 'withTempDir 已经把输出目录建出来了');
      assert.equal(state.baseline.exists, false);
      assert.equal(state.sanity.safe, true);
      assert.deepEqual(state.defaults.moduleIds, ['skills', 'plugins', 'config', 'memory', 'todo']);
    });
  });
});

// ───────────────────────── 备份

test('runBackup：产出时间命名的包 + 两份边车，并更新本机基线', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const r = await runBackup(fx.roots, { moduleIds: MODULES, outDir });
      assert.equal(r.ok, true);
      assert.match(r.archive.name, /^dsh-sync-\d{8}-\d{6}\.tar\.gz$/);
      assert.ok(r.archive.bytes > 0);
      assert.match(r.archive.sha256, /^[0-9a-f]{64}$/);
      assert.equal(r.sidecar.checked, true);
      assert.equal(r.sidecar.ok, true);
      assert.deepEqual(r.archive.modules, MODULES);
      assert.equal(r.archive.baselineIncluded, true);

      assert.equal(existsSync(r.archive.path), true);
      assert.equal(existsSync(r.archive.sha256Path), true);
      assert.equal(existsSync(r.archive.metaPath), true);

      const files = await readdir(outDir);
      assert.equal(files.some((f) => f.startsWith('.staging-')), false, '不能留下暂存目录');
      assert.equal(files.some((f) => f.includes('.part-')), false, '不能留下半截包');

      const baseline = JSON.parse(await readFile(baselinePathOf(fx.roots), 'utf8'));
      assert.equal(baseline.version, 1);
      assert.ok(Object.keys(baseline.files).length > 0);
      assert.equal(Object.keys(baseline.archives).length, 1);
      assert.equal(Object.keys(baseline.files).every((k) => MODULES.includes(k.slice(0, k.indexOf(':')))), true);
    });
  });
});

test('★ runBackup 更新基线时只覆盖本次模块，别把没参与的模块基线抹掉', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      // 先备份全部（含 plugins/sessions），基线里就有这两个模块的键
      const full = await runBackup(fx.roots, { moduleIds: ['skills', 'plugins', 'sessions'], outDir });
      const before = JSON.parse(await readFile(baselinePathOf(fx.roots), 'utf8'));
      const pluginKeys = Object.keys(before.files).filter((k) => k.startsWith('plugins:'));
      const sessionKeys = Object.keys(before.files).filter((k) => k.startsWith('sessions:'));
      assert.ok(pluginKeys.length > 0 && sessionKeys.length > 0, '前置条件：基线里得有这两个模块');

      // 再只备份技能
      await runBackup(fx.roots, { moduleIds: ['skills'], outDir, name: 'only-skills' });
      const after = JSON.parse(await readFile(baselinePathOf(fx.roots), 'utf8'));

      for (const k of pluginKeys) assert.ok(k in after.files, `插件基线键被误删：${k}`);
      for (const k of sessionKeys) assert.ok(k in after.files, `对话基线键被误删：${k}`);
      assert.equal(Object.keys(after.files).filter((k) => k.startsWith('skills:')).length > 0, true);
      assert.equal(Object.keys(after.archives).length, 2, '两次备份都要记进历史');
      assert.equal(full.ok, true);
    });
  });
});

test('runBackup：一个模块都没选要报错，不是打空包', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      await assert.rejects(() => runBackup(fx.roots, { moduleIds: [], outDir }), /至少要选择一个模块/);
    });
  });
});

// ───────────────────────── 换机导入（核心）

test('★ 换机首次导入：基准必须留空，否则新机器一个文件都导不进去', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const backup = await runBackup(fx.roots, { moduleIds: MODULES, outDir });

      const fresh = await emptyMachine();
      try {
        const preview = await previewImport(fresh.roots, { archivePath: backup.archive.path });
        assert.equal(preview.baseSource.used, 'none', '本机没基线，基准必须是空的');
        assert.equal(preview.baseSource.packRead, true, '包内基线仍要读出来，供界面显示这包来自哪台机器');
        assert.equal(typeof preview.baseSource.packMachine, 'string');
        assert.ok(preview.baseSource.packMachine.length > 0);
        // 源机是第一次备份，那时它自己还没有基线，所以包内这份 files 是空的 ——
        // 恰恰说明它没有资格当比较基准。
        assert.equal(preview.baseSource.packKeys, 0);

        assert.equal(preview.counts.keep, 0, '「本地没有」绝不能被判成保留');
        assert.equal(preview.counts.conflict, 0, '空机器上不该有冲突');
        assert.equal(preview.counts.same, 0);
        assert.equal(preview.counts.import, backup.archive.totals.files, '每一个文件都该导入');
        assert.equal(preview.canApply, true);

        const applied = await applyImport(fresh.roots, { archivePath: backup.archive.path });
        assert.equal(applied.ok, true);
        assert.deepEqual(applied.errors, []);
        assert.equal(applied.counts.failed, 0);
        assert.equal(applied.counts.import, backup.archive.totals.files);
        assert.equal(applied.verified.failed, 0);
        assert.equal(applied.snapshotFiles, 0, '空机器上没东西可快照');

        // 内容真的落地
        assert.equal(existsSync(join(fresh.roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md')), true);
        assert.equal(existsSync(join(fresh.roots.dshHome, 'settings.yaml')), true);
        assert.equal(existsSync(join(fresh.roots.dshHome, 'profiles', 'desktop', 'cordis.patch.yml')), true);
        assert.equal(
          existsSync(join(fresh.roots.agentsSkills, 'cdp-browser-automation', 'node_modules')),
          false,
          'node_modules 不该进包',
        );

        // 内容一字不差
        const src = await readFile(join(fx.roots.dshHome, 'memories', 'daily', '2026-10-13.todo.md'), 'utf8');
        const dst = await readFile(join(fresh.roots.dshHome, 'memories', 'daily', '2026-10-13.todo.md'), 'utf8');
        assert.equal(dst, src);

        // 第二遍：同一个包再导一次必须安静无事
        const again = await previewImport(fresh.roots, { archivePath: backup.archive.path });
        assert.equal(again.baseSource.used, 'local', '第二遍该用本机基线了');
        assert.equal(again.counts.import, 0);
        assert.equal(again.counts.conflict, 0);
        assert.equal(again.counts.same, backup.archive.totals.files);
        assert.equal(again.canApply, false);
      } finally {
        await fresh.cleanup();
      }
    });
  });
});

test('★ 源机已同步过（包内基线非空）时，新机器依然必须全部导入', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      // 第一次备份：源机此时还没基线，包内基线是空的
      await runBackup(fx.roots, { moduleIds: MODULES, outDir, name: 'warmup' });
      // 第二次备份：源机已经有基线了，包内基线这次是满的
      const backup = await runBackup(fx.roots, { moduleIds: MODULES, outDir, name: 'warm' });

      const fresh = await emptyMachine();
      try {
        const preview = await previewImport(fresh.roots, { archivePath: backup.archive.path });
        assert.equal(preview.baseSource.packRead, true);
        assert.ok(preview.baseSource.packKeys > 0, '前置条件：包内基线这次必须非空，否则测不到点子上');
        assert.equal(preview.baseSource.used, 'none', '本机没同步过，基准仍然是空的');

        // 如果谁把包内基线接成了基准，下面两条立刻炸：
        // keep 会等于总文件数（「本地已删除 → 保持删除」），import 会变成 0。
        assert.equal(preview.counts.keep, 0);
        assert.equal(preview.counts.import, backup.archive.totals.files);
        assert.equal(preview.counts.conflict, 0);
      } finally {
        await fresh.cleanup();
      }
    });
  });
});

test('★ 双方都改了同一个文件 → 冲突，裁决 archive 才覆盖本地', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const first = await runBackup(fx.roots, { moduleIds: MODULES, outDir, name: 'first' });
      const fresh = await emptyMachine();
      try {
        await applyImport(fresh.roots, { archivePath: first.archive.path });

        // 本机改一下 settings.yaml
        const localFile = join(fresh.roots.dshHome, 'settings.yaml');
        await writeFile(localFile, 'a: 2   # 家里改的\n', 'utf8');

        // 源机也改一下同一个文件，再打一个包
        await writeFile(join(fx.roots.dshHome, 'settings.yaml'), 'a: 3   # 公司改的\n', 'utf8');
        const second = await runBackup(fx.roots, { moduleIds: MODULES, outDir, name: 'second' });

        const preview = await previewImport(fresh.roots, { archivePath: second.archive.path });
        assert.equal(preview.counts.conflict, 1, '两边都改了同一个文件，必须报冲突');
        assert.equal(preview.conflicts[0].relPath, 'settings.yaml');
        assert.equal(preview.canApply, true);
        assert.equal(preview.counts.keep, 0);

        // 不裁决 = 安全默认（保留本地）
        const noResolve = await applyImport(fresh.roots, { archivePath: second.archive.path });
        assert.equal(noResolve.counts.import, 0);
        assert.deepEqual(noResolve.conflictsUnresolved, ['config:settings.yaml']);
        assert.equal(await readFile(localFile, 'utf8'), 'a: 2   # 家里改的\n');

        // 裁决 archive → 覆盖成公司那版，且旧内容进了快照
        const resolved = await applyImport(fresh.roots, {
          archivePath: second.archive.path,
          resolutions: { 'config:settings.yaml': 'archive' },
        });
        assert.equal(resolved.counts.import, 1);
        assert.deepEqual(resolved.conflictsUnresolved, []);
        assert.equal(await readFile(localFile, 'utf8'), 'a: 3   # 公司改的\n');
        assert.ok(resolved.snapshotFiles > 0, '写之前必须留快照');
        assert.notEqual(resolved.snapshotDir, null);
        const snap = await readdir(resolved.snapshotDir, { recursive: true });
        assert.equal(snap.some((p) => String(p).endsWith('settings.yaml')), true, '被覆盖的旧版本要能在快照里找到');
      } finally {
        await fresh.cleanup();
      }
    });
  });
});

test('★ 裁决 local 之后再导同一个包，不能把用户刚选的版本冲掉', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const first = await runBackup(fx.roots, { moduleIds: MODULES, outDir, name: 'first' });
      const fresh = await emptyMachine();
      try {
        await applyImport(fresh.roots, { archivePath: first.archive.path });
        const localFile = join(fresh.roots.dshHome, 'settings.yaml');
        await writeFile(localFile, 'a: 2   # 家里改的\n', 'utf8');
        await writeFile(join(fx.roots.dshHome, 'settings.yaml'), 'a: 3   # 公司改的\n', 'utf8');
        const second = await runBackup(fx.roots, { moduleIds: MODULES, outDir, name: 'second' });

        await applyImport(fresh.roots, {
          archivePath: second.archive.path,
          resolutions: { 'config:settings.yaml': 'local' },
        });
        assert.equal(await readFile(localFile, 'utf8'), 'a: 2   # 家里改的\n');

        const again = await previewImport(fresh.roots, { archivePath: second.archive.path });
        assert.equal(again.counts.import, 0, '不能又冒出「只有归档改了 → 导入」');
        assert.equal(again.counts.keep, 1);
        assert.equal(again.counts.conflict, 0, '裁决过一次就不该反复问');
      } finally {
        await fresh.cleanup();
      }
    });
  });
});

test('previewImport 只读：跑完不动本机任何文件', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const backup = await runBackup(fx.roots, { moduleIds: MODULES, outDir });
      const fresh = await emptyMachine();
      try {
        await previewImport(fresh.roots, { archivePath: backup.archive.path });
        const listing = (await readdir(fresh.roots.dshHome, { recursive: true })).map((p) => String(p).replace(/\\/g, '/'));
        assert.deepEqual([...listing].sort(), ['profiles', 'profiles/desktop'], '预览阶段除了本来就有的 profiles 骨架，不该多出任何东西');
      } finally {
        await fresh.cleanup();
      }
    });
  });
});

test('applyImport：dryRun 不写盘、不动基线', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const backup = await runBackup(fx.roots, { moduleIds: MODULES, outDir });
      const fresh = await emptyMachine();
      try {
        const dry = await applyImport(fresh.roots, { archivePath: backup.archive.path, dryRun: true });
        assert.equal(dry.dryRun, true);
        assert.equal(dry.baselinePath, null);
        assert.equal(existsSync(join(fresh.roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md')), false);
        assert.equal(existsSync(baselinePathOf(fresh.roots)), false);
      } finally {
        await fresh.cleanup();
      }
    });
  });
});

test('previewImport：拒绝非 .tar.gz 与不存在的包', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      await writeFile(join(outDir, 'not-a-pack.zip'), 'x', 'utf8');
      await assert.rejects(() => previewImport(fx.roots, { archivePath: join(outDir, 'not-a-pack.zip') }), /不是 \.tar\.gz/);
      await assert.rejects(() => previewImport(fx.roots, { archivePath: join(outDir, 'missing.tar.gz') }), /不存在/);
      await assert.rejects(() => previewImport(fx.roots, { archiveName: 'nope.tar.gz', outDir }), /不存在/);
      await assert.rejects(() => previewImport(fx.roots, {}), /必须指定/);
    });
  });
});

// ───────────────────────── 校验与同步

test('verifyArchiveFull：逐文件重算哈希', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const backup = await runBackup(fx.roots, { moduleIds: MODULES, outDir });
      const v = await verifyArchiveFull(fx.roots, { archiveName: backup.archive.name, outDir });
      assert.equal(v.ok, true);
      assert.equal(v.checked, backup.archive.totals.files);
      assert.deepEqual(v.bad, []);
      assert.equal(v.sidecar.ok, true);
    });
  });
});

test('syncCopy / syncList：把最新包推到同步文件夹，也能列回来', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      await withTempDir('.tmp-sync-', async (syncDir) => {
        const backup = await runBackup(fx.roots, { moduleIds: MODULES, outDir });
        const pushed = await syncCopy(fx.roots, { outDir, targetDir: syncDir });
        assert.equal(pushed.ok, true);
        assert.equal(pushed.archive, backup.archive.name);
        assert.equal(pushed.copied.length, 3, '包 + sha256 + meta 三件都要过去');

        const listed = await syncList(fx.roots, { targetDir: syncDir });
        assert.equal(listed.archives.length, 1);
        assert.equal(listed.archives[0].name, backup.archive.name);
        assert.equal(listed.archives[0].hasSha256, true);

        await assert.rejects(() => syncCopy(fx.roots, { outDir, targetDir: outDir }), /不能就是备份目录本身/);
        await assert.rejects(() => syncCopy(fx.roots, { outDir, targetDir: '' }), /必须填写同步目标文件夹/);
      });
    });
  });
});

test('syncCopy：备份目录空的时候要说清楚，而不是复制个空', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      await withTempDir('.tmp-sync-', async (syncDir) => {
        await assert.rejects(() => syncCopy(fx.roots, { outDir, targetDir: syncDir }), /还没有备份包/);
      });
    });
  });
});

// ───────────────────────── 设置

test('设置：默认值、落盘、坏文件回默认值', async () => {
  await withFixture(async (fx) => {
    const initial = await loadSettings(fx.roots);
    assert.deepEqual(initial, { version: 1, outDir: null, syncDir: null, allowDelete: false, includeBaseline: true });

    const saved = await saveSettings(fx.roots, { outDir: 'D:\\x', syncDir: 'D:\\y' });
    assert.equal(saved.outDir, 'D:\\x');
    assert.equal(existsSync(settingsPathOf(fx.roots)), true);

    const reloaded = await loadSettings(fx.roots);
    assert.equal(reloaded.outDir, 'D:\\x');
    assert.equal(reloaded.syncDir, 'D:\\y');

    await writeFile(settingsPathOf(fx.roots), '{oops', 'utf8');
    const broken = await loadSettings(fx.roots);
    assert.equal(broken.corrupted, true);
    assert.equal(broken.outDir, null, '坏了就回默认值，别挡住备份');
  });
});

// ───────────────────────── HTTP 层

test('★ /state 必须回传已保存的 settings —— 客户端靠它回填「同步目录」输入框', async () => {
  await withFixture(async (fx) => {
    const routes = buildRoutes({ get: () => undefined }, { resolveRoots: () => fx.roots });
    const state = routes.find((r) => r.path === `${ROUTE_PREFIX}/state`);
    const get = async () => {
      const res = await state.fetch(new Request('http://x/api/dsh-backup-sync/state', { method: 'GET' }));
      assert.equal(res.status, 200);
      return await res.json();
    };

    const before = await get();
    assert.ok(before.settings !== undefined, '/state 必须带 settings');
    assert.equal(before.settings.syncDir, null, '没存过就是 null');
    assert.ok(typeof before.settings.defaultOutDir === 'string' && before.settings.defaultOutDir !== '');

    await saveSettings(fx.roots, { syncDir: 'D:\\OneDrive\\dsh-sync', outDir: 'D:\\bak' });
    const after = await get();
    assert.equal(after.settings.syncDir, 'D:\\OneDrive\\dsh-sync', '存过的同步目录必须回传');
    // settings.outDir 是「生效值」（设置与默认合并后的结果），必须和顶层 outDir 一致
    assert.equal(after.settings.outDir, 'D:\\bak');
    assert.equal(after.outDir, 'D:\\bak');
    assert.equal(after.settings.allowDelete, false);
    assert.equal(after.settings.includeBaseline, true);
  });
});

test('collectState 也自带 settings（服务层直接调用时不依赖路由补字段）', async () => {
  await withFixture(async (fx) => {
    const s = await collectState(fx.roots);
    assert.ok(s.settings !== undefined, 'collectState 应自带 settings');
    assert.equal(s.settings.syncDir, null);
    assert.equal(s.settings.corrupted, false);
    assert.ok(s.settings.path.endsWith('settings.json'));

    await saveSettings(fx.roots, { syncDir: 'D:\\y' });
    assert.equal((await collectState(fx.roots)).settings.syncDir, 'D:\\y');
  });
});

test('★ collectState 回传被凭据守卫拦下的文件（界面要显著提示）', async () => {
  await withFixture(async (fx) => {
    // fixture 里塞一个内容含令牌的记忆文件
    const memDir = join(fx.roots.dshHome, 'memories');
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, 'MEMORY.md'), '# 正常\n', 'utf8');
    await writeFile(join(memDir, 'leak.md'), 'token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n', 'utf8');

    const state = await collectState(fx.roots);
    assert.equal(state.scan.credentials.length, 1, '被拦的文件要出现在 scan.credentials 里');
    assert.equal(state.scan.credentials[0].relPath, 'leak.md');
    assert.match(state.scan.credentials[0].reason, /内容命中/);
    const names = state.scan.modules.find((m) => m.id === 'memory').entries.map((e) => e.relPath);
    assert.ok(!names.includes('leak.md'), '被拦的文件不能出现在清单里');
  });
});

test('路由表：路径合法、方法不重复、路径不重复', async () => {
  await withFixture(async (fx) => {
    const routes = buildRoutes({ get: () => undefined }, { resolveRoots: () => fx.roots });
    assert.ok(routes.length >= 8, `路由太少：${routes.length}`);
    const seen = new Set();
    for (const r of routes) {
      // 内核 assertFetchRoute 的硬约束
      assert.match(r.path, /^\/api\/[A-Za-z0-9_$.-]+(\/[A-Za-z0-9_$.-]+)*$/, `路径不合法：${r.path}`);
      assert.ok(r.methods.length > 0, `没声明方法：${r.path}`);
      assert.equal(new Set(r.methods).size, r.methods.length, `方法重复：${r.path}`);
      assert.equal(seen.has(r.path), false, `路径重复：${r.path}`);
      assert.equal(r.requestBody, 'buffered');
      assert.equal(typeof r.fetch, 'function');
      seen.add(r.path);
    }
    assert.ok(seen.has(`${ROUTE_PREFIX}/state`));
    assert.ok(seen.has(`${ROUTE_PREFIX}/backup`));
    assert.ok(seen.has(`${ROUTE_PREFIX}/import/preview`));
    assert.ok(seen.has(`${ROUTE_PREFIX}/import/apply`));
  });
});

test('路由派发：state 返回完整首屏，坏请求体返回 JSON 错误而不是抛出', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const routes = buildRoutes({ get: () => undefined }, { resolveRoots: () => fx.roots });
      const find = (p) => routes.find((r) => r.path === `${ROUTE_PREFIX}${p}`);

      const res = await find('/state').fetch(new Request('http://x/api/dsh-backup-sync/state', { method: 'POST', body: JSON.stringify({ outDir }) }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.scan.modules.length, 6);
      assert.equal(body.outDir, outDir);
      assert.equal(body.settings.outDir, outDir);
      assert.equal(body.settings.syncDir, null);

      const bad = await find('/backup').fetch(new Request('http://x/api/dsh-backup-sync/backup', { method: 'POST', body: '{oops' }));
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.equal(badBody.ok, false);
      assert.match(badBody.error, /JSON/);

      // 业务错误也要变成 ok:false，而不是 500 或者抛出去
      const noModule = await find('/backup').fetch(
        new Request('http://x/api/dsh-backup-sync/backup', { method: 'POST', body: JSON.stringify({ moduleIds: [], outDir }) }),
      );
      assert.equal(noModule.status, 400);
      assert.match((await noModule.json()).error, /至少要选择一个模块/);
    });
  });
});

test('路由派发：备份 → 预览 → 导入 全链路走 HTTP 也能跑通', async () => {
  await withFixture(async (fx) => {
    await withTempDir('.tmp-out-', async (outDir) => {
      const fresh = await emptyMachine();
      try {
        const srcRoutes = buildRoutes({ get: () => undefined }, { resolveRoots: () => fx.roots });
        const dstRoutes = buildRoutes({ get: () => undefined }, { resolveRoots: () => fresh.roots });
        const call = async (routes, p, payload) => {
          const r = routes.find((x) => x.path === `${ROUTE_PREFIX}${p}`);
          const res = await r.fetch(
            new Request(`http://x${r.path}`, { method: 'POST', body: JSON.stringify(payload) }),
          );
          return await res.json();
        };

        const backup = await call(srcRoutes, '/backup', { moduleIds: MODULES, outDir });
        assert.equal(backup.ok, true);

        const preview = await call(dstRoutes, '/import/preview', { archivePath: backup.archive.path });
        assert.equal(preview.ok, true);
        assert.ok(preview.counts.import > 0);
        assert.equal(preview.counts.keep, 0);

        const applied = await call(dstRoutes, '/import/apply', { archivePath: backup.archive.path });
        assert.equal(applied.ok, true);
        assert.equal(applied.counts.failed, 0);

        const verify = await call(srcRoutes, '/verify', { archiveName: backup.archive.name, outDir });
        assert.equal(verify.ok, true);
        assert.deepEqual(verify.bad, []);
      } finally {
        await fresh.cleanup();
      }
    });
  });
});
