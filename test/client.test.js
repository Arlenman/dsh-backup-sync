/**
 * lib/client.js 的离线契约测试。
 *
 * 本机没有打包器，客户端 bundle 是手写的，所以「写错 id / require 了不存在的模块 /
 * inject 了不存在的服务」这类错误**不会在构建期暴露**，只会在真机刷新页面时表现为
 * 「条目 pending」→ `web boot: N entries did not activate` → 「应用无法使用」致命恢复框
 * （第三个按钮会备份并重置用户的 cordis.patch.yml 与 dsh.profile.bundles）。
 *
 * 所以这里用 node:vm 造一个假的 window.__ModuleLoader__，把 bundle 原样跑一遍，
 * 在没有安装任何插件的情况下就把契约违反项挡在提交之前。
 *
 * 契约出处：docs/notes/module-loader-contract.md
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(PROJECT, 'lib', 'client.js');
const PKG = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'));

/** 平台种子表（内核 `dsh-web-frontend` 的 `function rM()`，共 9 项）。 */
const SEED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/** 本机 0.2.0-rc.2 已知的客户端服务名。inject 里出现这些说明混淆了「模块 id」与「服务名」。 */
const SERVICE_NAMES = [
  'slots',
  'layout',
  'uiWorkspace',
  'locale',
  'shortcuts',
  'remote',
  'configForms',
  'connection',
  'theme',
  'sessions',
  'conversation',
];

/** 极简 React 替身：只记录树，不渲染。 */
function makeFakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  });
  return { createElement };
}

/** 把渲染树里的可见文本拼起来。 */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join(' ');
}

/** 按 type 收集节点。 */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

/**
 * 在假 window 里执行 bundle，返回注册信息与「物化后的模块」。
 * @param {{ requireStrict?: boolean }} [opts]
 */
function loadBundle(opts = {}) {
  const code = readFileSync(BUNDLE, 'utf8');
  const box = {};
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(registration) {
          box.registration = registration;
        },
      },
    },
    console,
  });
  vm.runInContext(code, context, { filename: BUNDLE });

  assert.ok(box.registration, 'bundle 必须调用 window.__ModuleLoader__.load({...})');
  const registration = box.registration;

  const allowed = new Set([...SEED, ...(PKG.dsh?.client?.inject ?? [])]);
  const required = [];
  const fakeReact = makeFakeReact();
  const require = (spec) => {
    required.push(spec);
    if (spec === 'react') return fakeReact;
    if (opts.requireStrict !== false && !allowed.has(spec)) {
      throw new Error(`require("${spec}") missed the module table`);
    }
    return {};
  };

  const module = registration.factory(require);
  return { registration, module, required, fakeReact };
}

/** 造一个记录调用的假 ctx.slots。 */
function makeFakeCtx() {
  const calls = { inject: [], register: [] };
  const ctx = {
    slots: {
      inject(key, callback) {
        calls.inject.push(key);
        // 真实现是「等槽位被声明后再跑 callback」；这里立刻跑，等价于槽位已声明。
        return callback();
      },
      register(options, component) {
        calls.register.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, calls };
}

test('bundle 注册的 id 严格等于 package.json 的 name（否则报 loaded without registering）', () => {
  const { registration } = loadBundle();
  assert.equal(registration.id, PKG.name);
  assert.equal(registration.id, 'dsh-backup-sync');
});

test('bundle 只 require 平台种子词或已声明的 boot 条目', () => {
  const { required } = loadBundle();
  const allowed = new Set([...SEED, ...(PKG.dsh?.client?.inject ?? [])]);
  const offenders = required.filter((spec) => !allowed.has(spec));
  assert.deepEqual(offenders, [], `这些 specifier 不在种子表也不在 dsh.client.inject 里：${offenders.join(', ')}`);
  assert.ok(required.includes('react'), '应当 require react');
});

test('dsh.client 声明合法：platform 是字符串、inject 是字符串数组且不是服务名', () => {
  const client = PKG.dsh?.client;
  assert.ok(client, 'package.json 必须有 dsh.client');
  assert.equal(typeof client.platform, 'string');
  assert.equal(client.platform, 'web');
  assert.ok(Array.isArray(client.inject), 'dsh.client.inject 必须是数组');
  for (const id of client.inject) {
    assert.equal(typeof id, 'string', `inject 项必须是字符串，实得 ${typeof id}`);
    assert.ok(
      !SERVICE_NAMES.includes(id),
      `inject 里写的是模块 id，不是 Cordis 服务名；"${id}" 是服务名（服务名要写在 lib/client.js 的 inject 数组里）`,
    );
  }
});

test('package.json 用 exports["./client"] 暴露客户端 bundle', () => {
  assert.equal(PKG.exports?.['./client'], './lib/client.js');
});

test('模块导出 inject 是 ["slots"]，且不包含任何不存在的服务名', () => {
  const { module } = loadBundle();
  // 注意：module 是在 vm realm 里创建的，它的数组原型与宿主不同，
  // 直接 deepStrictEqual 会因原型不等而失败 —— 先展开成宿主数组再比。
  assert.deepEqual([...module.inject], ['slots']);
  assert.equal(typeof module.apply, 'function');
});

test('apply 注册且只注册 sidebar.panellist 与 main 两个槽位', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  assert.deepEqual(calls.inject, ['sidebar.panellist', 'main']);
  assert.equal(calls.register.length, 2);
  assert.deepEqual(
    calls.register.map((r) => r.options.name),
    ['sidebar.panellist', 'main'],
  );
});

test('sidebar.panellist 用 list 槽位的必需字段 id，且 label 是普通字符串（不依赖 locale）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const entry = calls.register.find((r) => r.options.name === 'sidebar.panellist');
  assert.ok(entry, '必须注册 sidebar.panellist');
  assert.equal(typeof entry.options.id, 'string', 'list 槽位必须给 id，否则 register 直接抛错');
  assert.equal(entry.options.id, 'backup-sync');
  assert.equal(typeof entry.options.order, 'number');
  assert.equal(typeof entry.options.label, 'string', 'label 给普通字符串即可，侧边栏用 resolveSlotLabel(label) ?? id');
  assert.equal(entry.options.label, '备份同步');
  assert.equal(entry.options.locale, undefined, '不传 locale：没有注册对应字典时标签可能解析不到');
  assert.equal(typeof entry.component, 'function');
});

test('main 用 keyed 槽位的必需字段 key，且 key 与 panellist 的 id 一致（配对机制）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const panel = calls.register.find((r) => r.options.name === 'sidebar.panellist');
  const main = calls.register.find((r) => r.options.name === 'main');
  assert.ok(main, '必须注册 main');
  assert.equal(typeof main.options.key, 'string', 'keyed 槽位必须给 key，否则 register 直接抛错');
  assert.equal(
    main.options.key,
    panel.options.id,
    'sidebar.panellist 的 id 必须等于 main 的 key —— 这是「侧边栏行点开对应面板」的唯一机制',
  );
});

test('★ main 的 key 不能是 conversation（内置对话面板占用，replaceRisk: shadows-shipped-ui）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const main = calls.register.find((r) => r.options.name === 'main');
  assert.notEqual(main.options.key, 'conversation', '用 conversation 会遮蔽内置对话面板');
});

test('图标组件收到 { size, active } 不抛错，并渲染出 SVG', () => {
  const { module, fakeReact } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const icon = calls.register.find((r) => r.options.name === 'sidebar.panellist').component;
  for (const props of [{ size: 16, active: false }, { size: 22, active: true }, undefined, {}]) {
    const tree = icon(props);
    assert.equal(tree.type, 'svg', `props=${JSON.stringify(props)} 时应渲染 svg`);
    assert.ok(tree.props.width > 0, 'width 必须为正数');
    assert.ok(fakeReact, 'fakeReact 应当被用到');
  }
});

test('图标对非法 size 回退到 16，不产生 NaN/负数尺寸', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const icon = calls.register.find((r) => r.options.name === 'sidebar.panellist').component;
  for (const bad of [{ size: 0 }, { size: -5 }, { size: 'big' }, { size: Number.NaN }]) {
    assert.equal(icon(bad).props.width, 16, `size=${String(bad.size)} 应回退到 16`);
  }
});

test('图标的 SVG 路径语法合法（写错 d 属性只会静默不渲染，肉眼很难发现）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const icon = calls.register.find((r) => r.options.name === 'sidebar.panellist').component;
  const tree = icon({ size: 16, active: false });

  const withD = findAll(tree, (n) => typeof n.props?.d === 'string');
  assert.ok(withD.length > 0, '图标应当至少有一条 path');
  for (const node of withD) {
    const d = node.props.d;
    assert.match(
      d,
      /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/,
      `path 的 d 属性含非法字符：${d}`,
    );
    assert.match(d, /^[Mm]/, `path 的 d 属性必须以 M/m 开头：${d}`);
  }

  // 只允许简单图元，避免再写回无法肉眼验证的复杂弧线。
  const shapes = new Set(findAll(tree, (n) => typeof n.type === 'string').map((n) => n.type));
  for (const shape of shapes) {
    assert.ok(
      ['svg', 'rect', 'path', 'circle', 'line', 'g'].includes(shape),
      `图标里出现了意料之外的图元「${shape}」`,
    );
  }
});

test('面板渲染出六个模块卡片，对话卡片标注「本地专用 · 不上云」', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const page = calls.register.find((r) => r.options.name === 'main').component;
  const tree = page({});
  const text = textOf(tree);

  for (const label of ['技能', '插件', '配置', '记忆', '待办', '对话']) {
    assert.ok(text.includes(label), `面板应包含「${label}」卡片，实得文本：${text}`);
  }
  assert.ok(text.includes('本地专用 · 不上云'), '对话卡片必须标注「本地专用 · 不上云」');
  assert.ok(text.includes('备份同步'), '面板标题应为「备份同步」');

  // 卡片靠 borderRadius '8px' 区分（徽标是 4px，别把徽标也数进去）。
  const cards = findAll(tree, (n) => n.props?.style?.borderRadius === '8px');
  assert.equal(cards.length, 6, `应有 6 张模块卡片，实得 ${cards.length}`);
});

test('模块体没有顶层副作用：load() 之外不碰 document', () => {
  const code = readFileSync(BUNDLE, 'utf8');
  // 副作用（含 CSS 注入）必须写在 factory 闭包内，物化时才跑。
  // 这里用一个「没有 document 的 window」跑一遍：只要不抛错，就说明顶层没碰 DOM。
  const box = {};
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (r) => { box.registration = r; } } },
    console,
  });
  assert.doesNotThrow(() => vm.runInContext(code, context, { filename: BUNDLE }));
  assert.ok(box.registration, '顶层不应抛错，且应当完成注册');
});
