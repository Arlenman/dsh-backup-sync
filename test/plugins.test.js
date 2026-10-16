/**
 * 「插件」模块的清单层：把 profile 里的 `package.json` / `node_modules`
 * 翻成「装了哪些插件、什么版本、启没启用」。
 *
 * 这一层要盯住三件事，每一件都对应界面上会被用户看错的一句话：
 *  ① **已启用 ≠ 已安装**：只有出现在 `dsh.profile.bundles` 里的才会被宿主挂载；
 *     只躺在 `dependencies` 里的是被带进来的依赖，混在一起等于骗人。
 *  ② **标题口径要和「设置 → 插件」一致**：插件自带 `locale/zh.json` 的
 *     `meta.title` 优先，其次 `en`，最后退包名 —— 不编。
 *  ③ **版本要说「真正装上的」**：`^1.5.3` 到底装成什么，只有
 *     `node_modules/<name>/package.json` 说了算。
 */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { isStaleBackupName, listInstalledPackages, listPlugins, profileDirOf } from '../lib/plugins.js';
import { withFixture } from './fixture.js';

/** 往夹具里写一个文件。 */
async function put(abs, content) {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

const pkgJson = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const locale = (meta) => pkgJson({ meta });

/**
 * 一棵「像真的」profile：四个已启用插件（含一个内置 bundle、一个本地 link、
 * 一个装不上的），外加一个只被依赖带进来的包、一个装了但清单里没写的插件。
 */
async function seedProfile(roots, over = {}) {
  const dir = profileDirOf(roots);
  const put2 = (rel, content) => put(join(dir, rel), content);

  await put2(
    'package.json',
    pkgJson({
      name: 'desktop',
      dependencies: {
        'dsh-notify-me': '^1.5.3',
        'dsh-backup-sync': 'link:D:/dsh-work/dsh-backup-sync',
        cosmokit: '^4.0.4',
        ...over.dependencies,
      },
      dsh: {
        profile: {
          bundles: over.bundles ?? [
            '@deepseek-ai/dsh-base',
            'dsh-notify-me',
            'dsh-backup-sync',
            'dsh-gone',
          ],
        },
      },
    }),
  );

  // 装了、有中文语言文件（标题与描述都从 zh.json 来）
  await put2(
    'node_modules/dsh-notify-me/package.json',
    pkgJson({ name: 'dsh-notify-me', version: '1.5.3', description: 'Notify me (en)', dsh: { bundle: { patch: 'x.yml' } } }),
  );
  await put2(
    'node_modules/dsh-notify-me/locale/zh.json',
    locale({ title: '通知提醒', description: '审批、提问、回复完成时弹系统通知' }),
  );
  await put2('node_modules/dsh-notify-me/locale/en.json', locale({ title: 'Notify me', description: 'Desktop notifications' }));

  // 装了、没有语言文件：标题退包名，描述退 package.json 的 description
  await put2(
    'node_modules/dsh-backup-sync/package.json',
    pkgJson({ name: 'dsh-backup-sync', version: '0.2.0', description: '备份同步', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  );

  // 内置 bundle：范围包，装不进 profile 的 node_modules（真机上就是这样），
  // 但这里故意装一个，用来验证「内置」判定与 en 兜底
  await put2('node_modules/@deepseek-ai/dsh-base/package.json', pkgJson({ name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2' }));
  await put2('node_modules/@deepseek-ai/dsh-base/locale/en.json', locale({ title: 'Base bundle' }));

  // 只被依赖带进来、不在 bundles 里：宿主不会挂它
  await put2('node_modules/cosmokit/package.json', pkgJson({ name: 'cosmokit', version: '4.0.4' }));

  // 装了、还带 dsh 字段，但清单里（bundles 与 dependencies）都没写 → 孤儿
  await put2(
    'node_modules/dsh-leftover/package.json',
    pkgJson({ name: 'dsh-leftover', version: '0.9.9', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  );

  // dsh-gone 在 bundles 里，但没装 → installed:false
  return dir;
}

const byName = (plugins) => new Map(plugins.map((p) => [p.name, p]));

test('★ 插件清单：把 bundles / 依赖 / node_modules 翻成一行一个插件', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const out = await listPlugins(fx.roots);

    assert.equal(out.ok, true);
    assert.equal(out.manifestError, null);
    assert.equal(out.profile, 'desktop');
    assert.ok(out.profileDir.endsWith(join('profiles', 'desktop')));

    const m = byName(out.plugins);
    assert.deepStrictEqual([...m.keys()], [
      '@deepseek-ai/dsh-base',
      'dsh-notify-me',
      'dsh-backup-sync',
      'dsh-gone',
      'cosmokit',
    ], 'bundles 顺序在前（那是加载顺序），其余按名字排');
  });
});

test('插件行：标题优先取 locale/zh.json 的 meta.title，退 en，最后退包名', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const m = byName((await listPlugins(fx.roots)).plugins);

    assert.equal(m.get('dsh-notify-me').title, '通知提醒');
    assert.equal(m.get('dsh-notify-me').titleSource, 'zh');
    assert.equal(m.get('dsh-notify-me').description, '审批、提问、回复完成时弹系统通知');

    assert.equal(m.get('@deepseek-ai/dsh-base').title, 'Base bundle', '没有 zh 就用 en');
    assert.equal(m.get('@deepseek-ai/dsh-base').titleSource, 'en');

    assert.equal(m.get('dsh-backup-sync').title, 'dsh-backup-sync', '没有语言文件就如实显示包名');
    assert.equal(m.get('dsh-backup-sync').titleSource, 'name');
    assert.equal(m.get('dsh-backup-sync').description, '备份同步', '描述要退到 package.json 的 description');
  });
});

test('插件行：版本取「真正装上的那个」，不是依赖里写的范围', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const m = byName((await listPlugins(fx.roots)).plugins);
    assert.equal(m.get('dsh-notify-me').spec, '^1.5.3');
    assert.equal(m.get('dsh-notify-me').version, '1.5.3');
    assert.equal(m.get('dsh-backup-sync').version, '0.2.0');
    assert.equal(m.get('dsh-gone').version, null, '没装的没有版本，不能编一个出来');
  });
});

test('插件行：bundled 才算「已启用」；只在依赖里的要能一眼分出来', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const out = await listPlugins(fx.roots);
    const m = byName(out.plugins);

    assert.equal(m.get('dsh-notify-me').bundled, true);
    assert.equal(m.get('dsh-notify-me').installed, true);
    assert.equal(m.get('dsh-gone').bundled, true);
    assert.equal(m.get('dsh-gone').installed, false, 'bundles 里声明了但没装，要如实标出来');

    assert.equal(m.get('cosmokit').bundled, false, '只在 dependencies 里 = 宿主不会挂载');
    assert.deepStrictEqual(out.dependencyOnly, ['cosmokit']);

    assert.equal(m.get('dsh-notify-me').kind, 'third-party');
    assert.equal(m.get('@deepseek-ai/dsh-base').kind, 'builtin');

    assert.equal(m.get('dsh-backup-sync').local, true, 'link: 装的是本地目录（换机后不能照搬）');
    assert.equal(m.get('dsh-notify-me').local, false);
  });
});

test('插件清单合计：装了 / 启用了 / 第三方 / 缺包 四个数各有出处', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const out = await listPlugins(fx.roots);
    assert.deepStrictEqual(out.totals, {
      all: 5,
      enabled: 4,
      thirdParty: 4,
      standalone: 3,
      missing: 1,
    }, 'enabled=在 bundles 里的（4）；standalone=其中的第三方（3）；missing=声明了没装的（1）');
  });
});

test('装了但清单里没声明的插件要点出来（bundles 被削减时的典型症状）', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const out = await listPlugins(fx.roots);
    assert.deepStrictEqual(out.orphans, ['dsh-leftover'], '没有 dsh 字段的普通依赖（cosmokit）不算孤儿');
  });
});

test('清单坏了要说清楚是哪一行坏、坏在哪，而不是静默当空', async () => {
  await withFixture({ empty: true }, async (fx) => {
    const dir = profileDirOf(fx.roots);
    await put(join(dir, 'package.json'), '{ 这不是 JSON\n');
    const warns = [];
    const out = await listPlugins(fx.roots, { warn: (m) => warns.push(m) });

    assert.equal(out.ok, false);
    assert.ok(out.manifestError !== null && out.manifestError.includes('package.json'));
    assert.equal(warns.length, 1, '坏掉的清单必须留下一条警告');
    assert.deepStrictEqual(out.plugins, []);
    assert.deepStrictEqual(out.bundles, []);
  });
});

test('profile 目录整个不存在（家里那台还没同步过的新机器）也算「清单坏了」，不抛错', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await rm(profileDirOf(fx.roots), { recursive: true, force: true });
    const out = await listPlugins(fx.roots);
    assert.equal(out.ok, false);
    assert.ok(out.manifestError.includes('package.json'));
    assert.equal(out.totals.all, 0);
  });
});

test('bundles 里出现奇怪的东西（空串 / 非字符串）不能让界面崩', async () => {
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots, { bundles: ['dsh-notify-me', '', '   ', 42, null] });
    const out = await listPlugins(fx.roots);
    assert.deepStrictEqual(out.bundles, ['dsh-notify-me']);
    assert.deepStrictEqual(out.plugins.map((p) => p.name), ['dsh-notify-me', 'cosmokit', 'dsh-backup-sync'],
      'bundles 里那一个在前，其余（依赖里的）按名字排');
  });
});

test('★ 内置 bundle 不在 profile 的 node_modules 里是正常的，绝不能算成「声明了但没装上」', async () => {
  // 真机（C:\Users\98340\.dsh\profiles\desktop）上，bundles 里那三个
  // @deepseek-ai/* 永远不在 node_modules —— 它们随内核走。若把它们算进
  // missing，界面就会在**每一台好机器**上常年挂着「3 个声明了但没装上」。
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    // 把那个「故意装上的内置包」拆掉，还原真机形状
    await rm(join(profileDirOf(fx.roots), 'node_modules/@deepseek-ai'), { recursive: true, force: true });

    const out = await listPlugins(fx.roots);
    const m = byName(out.plugins);
    assert.equal(m.get('@deepseek-ai/dsh-base').installed, false, '读不到就是读不到，不编');
    assert.equal(m.get('@deepseek-ai/dsh-base').kind, 'builtin');
    assert.equal(out.totals.missing, 1, 'missing 只数第三方：内置的那两个不算，缺的仍是 dsh-gone');
    assert.deepStrictEqual(
      out.plugins.filter((p) => p.bundled && !p.installed).map((p) => p.name),
      ['@deepseek-ai/dsh-base', 'dsh-gone'],
      '行本身照旧如实标 installed:false，只是合计口径不含内置',
    );
  });
});

test('★ 重装留下的备份目录（xxx.old-<时间戳>）不是插件，不该报成「装了却没声明」', async () => {
  // 真机 node_modules 里躺着 dsh-memory-evolve.old-2026-10-09T09-55-37-666Z，
  // 是重装时留的备份副本。它照样带 dsh 字段，于是每次展开插件卡都会弹一条
  // 黄色警告说「宿主不会挂载它」—— 可它压根不是一次安装，告警纯属噪音。
  await withFixture({ empty: true }, async (fx) => {
    await seedProfile(fx.roots);
    const nm = join(profileDirOf(fx.roots), 'node_modules');
    await put(
      join(nm, 'dsh-memory-evolve.old-2026-10-09T09-55-37-666Z/package.json'),
      pkgJson({ name: 'dsh-memory-evolve', version: '0.1.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
    );
    await put(
      join(nm, 'dsh-real-orphan/package.json'),
      pkgJson({ name: 'dsh-real-orphan', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
    );

    const out = await listPlugins(fx.roots);
    assert.deepStrictEqual(out.orphans, ['dsh-leftover', 'dsh-real-orphan'], '备份目录不进孤儿名单，真孤儿照样报');
  });
});

test('isStaleBackupName：只认重装备份目录，别把名字里带 backup 的真插件误伤', () => {
  assert.equal(isStaleBackupName('dsh-memory-evolve.old-2026-10-09T09-55-37-666Z'), true);
  assert.equal(isStaleBackupName('dsh-x.bak-20261001'), true);
  assert.equal(isStaleBackupName('dsh-x.disabled'), true);
  assert.equal(isStaleBackupName('@scope/pkg.old-20261001'), true);
  assert.equal(isStaleBackupName('dsh-backup-sync'), false, '名字里带 backup ≠ 备份目录');
  assert.equal(isStaleBackupName('@xiaoyuyu6420/dsh-backup'), false);
  assert.equal(isStaleBackupName('dsh-gone'), false);
});

test('listInstalledPackages：只扫顶层与一层 scope，跳过点开头的与文件', async () => {
  await withFixture({ empty: true }, async (fx) => {
    const dir = await seedProfile(fx.roots);
    await put(join(dir, 'node_modules/.pnpm/whatever/index.js'), 'x\n');
    await put(join(dir, 'node_modules/.modules.yaml'), 'x\n');
    await put(join(dir, 'node_modules/@deepseek-ai/.bin/x'), 'x\n');
    const list = await listInstalledPackages(dir);
    assert.deepStrictEqual(list, [
      '@deepseek-ai/dsh-base',
      'cosmokit',
      'dsh-backup-sync',
      'dsh-leftover',
      'dsh-notify-me',
    ]);
  });
});

test('listInstalledPackages：没有 node_modules 时给空数组，不抛错', async () => {
  await withFixture({ empty: true }, async (fx) => {
    assert.deepStrictEqual(await listInstalledPackages(profileDirOf(fx.roots)), []);
  });
});
