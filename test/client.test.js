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

/**
 * 极简 React 替身：只记录树，不渲染。
 *
 * 钩子也必须给：面板组件在渲染函数外被直接调用时，任何缺失的钩子都会立刻抛
 * 「Invalid hook call」或 undefined is not a function。这里给的是「只跑一次初始值」
 * 的替身 —— 足够验证首屏结构，交互逻辑走 renderPanel 纯函数测。
 */
function makeFakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  });
  const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
  const useEffect = () => {};
  const useCallback = (fn) => fn;
  const useMemo = (fn) => (typeof fn === 'function' ? fn() : fn);
  const useRef = (init) => ({ current: init });
  return { createElement, useState, useEffect, useCallback, useMemo, useRef };
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
 * 递归展开函数组件 —— 等价于 React 渲染，但不含状态与副作用。
 *
 * 不展开的话，`h(Button, ...)`、`h(KeyValues, {pairs})` 这类节点在树里只是个
 * 「type 是函数」的壳，props 里的内容（pairs/entries/counts）根本不在 children 上，
 * 断言会全部落空 —— 这是最容易写出「假绿灯」的地方。
 */
function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    return expand(node.type({ ...node.props, children: node.children }));
  }
  return { ...node, children: (node.children ?? []).flatMap(expand) };
}

/** 渲染整个面板并展开到最终 DOM 形状。 */
function renderFull(ui, actions = {}) {
  const { module } = loadBundle();
  return expand(module.__internals.renderPanel(ui, actions));
}

/** 展开后的原生 button 元素。 */
function nativeButtons(tree) {
  return findAll(tree, (n) => n.type === 'button');
}

function buttonByText(tree, label) {
  return nativeButtons(tree).filter((b) => textOf(b).includes(label));
}

/** bundle 导出的纯函数集合。 */
function internals() {
  return loadBundle().module.__internals;
}

/** 首屏 UI 状态，可覆盖任意字段。 */
function initialUi(over = {}) {
  return { ...internals().createInitialUiState(), ...over };
}

/** 一份「宿主已经答过话」的 scan 结果，六个模块齐全。 */
function sampleScan() {
  return {
    modules: [
      { id: 'skills', countKind: 'dir', count: 10, files: 24, bytes: 133_120, bytesHuman: '130.0 KB', exists: true, entries: [{ relPath: 'cdp-browser-automation/SKILL.md', size: 2048, sizeHuman: '2.0 KB' }] },
      { id: 'plugins', countKind: 'file', count: 3, files: 3, bytes: 13_000, bytesHuman: '12.7 KB', exists: true, entries: [] },
      { id: 'config', countKind: 'file', count: 2, files: 2, bytes: 8_700, bytesHuman: '8.5 KB', exists: true, entries: [] },
      { id: 'memory', countKind: 'file', count: 8, files: 8, bytes: 230_000, bytesHuman: '224.6 KB', exists: true, entries: [] },
      { id: 'todo', countKind: 'entry', count: 2, files: 2, bytes: 1_800, bytesHuman: '1.8 KB', exists: true, entries: [] },
      { id: 'sessions', countKind: 'dir', count: 48, files: 48, bytes: 23_700_000, bytesHuman: '22.60 MB', exists: true, entries: [] },
    ],
  };
}

/** 一份完整的 /state 应答。 */
function sampleState(over = {}) {
  return {
    ok: true,
    outDir: 'D:\\dsh-backups-sync',
    outDirExists: true,
    archives: [],
    baseline: { path: 'C:\\Users\\x\\.dsh\\backup-sync\\state.json', exists: true, corrupted: false, files: 49, lastSyncAtLocal: '2026-10-13 18:06:57', machine: 'demo-pc', archives: {} },
    sanity: { safe: true, warnings: [] },
    scan: sampleScan(),
    defaults: { moduleIds: ['skills', 'plugins', 'config', 'memory', 'todo'], allModuleIds: ['skills', 'plugins', 'config', 'memory', 'todo', 'sessions'], allowDelete: false, includeBaseline: true },
    settings: { outDir: null, syncDir: null, allowDelete: false, includeBaseline: true },
    ...over,
  };
}

/** 一份 /import/preview 应答。 */
function samplePreview(over = {}) {
  return {
    ok: true,
    archive: {
      name: 'dsh-sync-20261013-180657.tar.gz',
      createdAtLocal: '2026-10-13 18:06:57',
      machine: 'demo-pc',
      modules: ['skills', 'plugins', 'config', 'memory', 'todo'],
      totals: { files: 49, bytes: 426_800 },
    },
    baseSource: { used: 'none', localKeys: 0, packKeys: 0, packRead: true, packMachine: 'demo-pc', packLastSyncAt: 0 },
    counts: { import: 49, keep: 0, delete: 0, same: 0, skip: 0, conflict: 0 },
    conflicts: [],
    pending: [],
    actions: [
      { key: 'skills:cdp/SKILL.md', moduleId: 'skills', relPath: 'cdp/SKILL.md', action: 'import', reason: '归档新增，本地没有' },
      { key: 'config:AGENTS.md', moduleId: 'config', relPath: 'AGENTS.md', action: 'same', reason: '双方都没动' },
    ],
    canApply: true,
    ...over,
  };
}

/**
 * 在假 window 里执行 bundle，返回注册信息与「物化后的模块」。
 * @param {{ requireStrict?: boolean, globals?: Record<string, unknown> }} [opts]
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
    ...(opts.globals ?? {}),
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

  // 卡片靠 data-dbs-module 区分 —— 不要再数 borderRadius，面板里圆角容器不止六处。
  const cards = findAll(tree, (n) => typeof n.props?.['data-dbs-module'] === 'string');
  assert.equal(cards.length, 6, `应有 6 张模块卡片，实得 ${cards.length}`);
  assert.deepEqual(
    cards.map((c) => c.props['data-dbs-module']),
    ['skills', 'plugins', 'config', 'memory', 'todo', 'sessions'],
  );
});

test('面板有四个页签，首屏停在「备份」，每个页签都能独立渲染而不抛错', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);
  const page = calls.register.find((r) => r.options.name === 'main').component;
  const I = module.__internals;

  const tree = page({});
  const tabs = findAll(tree, (n) => typeof n.props?.['data-dbs-tab'] === 'string');
  assert.deepEqual(
    tabs.map((t) => t.props['data-dbs-tab']),
    ['backup', 'history', 'import', 'sync'],
  );
  assert.deepEqual(
    tabs.map((t) => textOf(t)),
    ['备份', '历史版本', '导入', '同步'],
  );
  assert.equal(
    tabs.find((t) => t.props['data-on'] === '1').props['data-dbs-tab'],
    'backup',
    '首屏应停在「备份」页签',
  );

  for (const tab of ['backup', 'history', 'import', 'sync']) {
    const ui = { ...I.createInitialUiState(), tab };
    assert.doesNotThrow(() => I.renderPanel(ui, {}), `「${tab}」页签渲染不应抛错`);
    const body = findAll(I.renderPanel(ui, {}), (n) => n.props?.['data-dbs-tabbody'] === tab);
    assert.equal(body.length, 1, `「${tab}」页签应有且只有一个内容容器`);
  }
});

test('★ 未拿到宿主数据时面板也必须完整可读（不能白屏、不能出现 undefined/NaN）', () => {
  const tree = renderFull(initialUi());
  const text = textOf(tree);

  assert.ok(text.includes('正在读取本机状态'), '加载中应有明确提示');
  for (const bad of ['undefined', 'NaN', 'null', '[object Object]']) {
    assert.ok(!text.includes(bad), `首屏不应出现「${bad}」，实得：${text}`);
  }
  // 六张卡片仍要在（计数显示为「— 个」）。
  assert.equal(findAll(tree, (n) => typeof n.props?.['data-dbs-module'] === 'string').length, 6);
});

test('宿主不可用时渲染出错误横幅，而不是抛错', () => {
  const ui = { ...initialUi(), loading: false, error: '连接宿主失败' };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('出错了'), '应有错误标题');
  assert.ok(text.includes('连接宿主失败'), '应带上宿主返回的原因');
});

test('★ 路径体检不通过时停用写操作，并把原因摊开给用户看', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: {
      outDir: 'D:\\x',
      outDirExists: false,
      archives: [],
      sanity: { safe: false, warnings: ['找不到 profile 目录：C:\\nope\\desktop'] },
      scan: { modules: [] },
      defaults: { moduleIds: ['skills'] },
    },
  };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('路径体检没通过'), '必须明确告知写操作已停用');
  assert.ok(text.includes('找不到 profile 目录'), '必须把具体原因列出来');

  const start = buttonByText(tree, '开始备份');
  assert.equal(start.length, 1);
  assert.equal(start[0].props.disabled, true, '体检不通过时「开始备份」必须禁用');
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

// ─────────────────────────── 面板 UI 的纯函数与渲染（不需要 React 渲染器）

test('formatBytes 与宿主的 human() 同口径，且对非法输入不吐 NaN', () => {
  const I = internals();
  assert.equal(I.formatBytes(0), '0 B');
  assert.equal(I.formatBytes(1023), '1023 B');
  assert.equal(I.formatBytes(1024), '1.0 KB');
  assert.equal(I.formatBytes(426_800), '416.8 KB');
  assert.equal(I.formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(I.formatBytes(23_700_000), '22.60 MB');
  for (const bad of [undefined, null, Number.NaN, -1, '12', {}]) {
    assert.equal(I.formatBytes(bad), '—', `formatBytes(${String(bad)}) 应回退到破折号`);
  }
});

test('formatCount 按 countKind 选单位，未知数量显示破折号而不是 0', () => {
  const I = internals();
  assert.equal(I.formatCount(12, 'entry'), '12 条');
  assert.equal(I.formatCount(10, 'dir'), '10 个');
  assert.equal(I.formatCount(3, 'file'), '3 个');
  assert.equal(I.formatCount(null, 'entry'), '— 条');
  assert.equal(I.formatCount(undefined, 'dir'), '— 个');
  // 未知数量绝不能显示成 0 —— 那会让用户以为没东西可备份。
  assert.ok(!I.formatCount(null, 'entry').includes('0'));
});

test('★ 默认勾选：五个模块勾上，「对话」不勾（本地专用）', () => {
  const I = internals();
  const selected = I.effectiveSelection(I.createInitialUiState());
  assert.deepEqual([...selected], ['skills', 'plugins', 'config', 'memory', 'todo']);
  assert.ok(!selected.includes('sessions'), '对话默认不勾选');
  assert.deepEqual([...I.DEFAULT_SELECTED], ['skills', 'plugins', 'config', 'memory', 'todo']);
});

test('effectiveSelection 优先级：用户手选 > 宿主默认 > 内置默认', () => {
  const I = internals();
  const base = I.createInitialUiState();

  // 宿主有默认 → 用宿主的
  const withHost = { ...base, state: { defaults: { moduleIds: ['skills'] } } };
  assert.deepEqual([...I.effectiveSelection(withHost)], ['skills']);

  // 用户手选 → 压过宿主
  const withUser = { ...withHost, selected: ['memory'] };
  assert.deepEqual([...I.effectiveSelection(withUser)], ['memory']);

  // 宿主也没有 → 内置默认
  assert.deepEqual([...I.effectiveSelection(base)], ['skills', 'plugins', 'config', 'memory', 'todo']);

  // 用户显式清空 → 空就是空，不能悄悄回退到默认（否则「取消全选」按了没用）
  assert.deepEqual([...I.effectiveSelection({ ...withHost, selected: [] })], []);
});

test('requestOutDir：输入框空就不带目录（让宿主用设置/默认值），有内容就去掉首尾空白', () => {
  const I = internals();
  assert.equal(I.requestOutDir(I.createInitialUiState()), undefined);
  assert.equal(I.requestOutDir({ outDir: '   ' }), undefined);
  assert.equal(I.requestOutDir({ outDir: '' }), undefined);
  assert.equal(I.requestOutDir({ outDir: '  D:\\bak  ' }), 'D:\\bak');
  assert.equal(I.requestOutDir({}), undefined);
  assert.equal(I.requestOutDir(null), undefined);
});

test('★ 每个请求目录的地方都必须走 requestOutDir —— 「历史版本」刷新漏过（真机缺陷回归）', async () => {
  const I = internals();
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // 别处再出现手写的三元表达式，就说明又有人漏改了一处
  const handWritten = src.split('\n').filter((l) => /ui\.outDir\.trim\(\)\s*===\s*''/.test(l));
  assert.deepEqual(handWritten, [], `仍有手写的目录三元表达式：\n${handWritten.join('\n')}`);
  assert.equal(I.requestOutDir({ outDir: 'X' }), 'X');
});

test('toggleSelection 不改原数组（React 状态必须换新引用才会重渲染）', () => {
  const I = internals();
  const before = ['skills', 'memory'];
  const after = I.toggleSelection(before, 'todo');
  assert.deepEqual([...before], ['skills', 'memory'], '原数组必须保持不动');
  assert.deepEqual([...after], ['skills', 'memory', 'todo']);
  assert.deepEqual([...I.toggleSelection(after, 'skills')], ['memory', 'todo']);
});

test('computeSelectionSummary 只统计勾选的模块，计数未知时降级而不算成 0', () => {
  const I = internals();
  const modules = I.moduleRows(sampleState());

  const all5 = I.computeSelectionSummary(modules, ['skills', 'plugins', 'config', 'memory', 'todo']);
  assert.equal(all5.modules, 5);
  assert.equal(all5.files, 24 + 3 + 2 + 8 + 2);
  assert.equal(all5.bytes, 133_120 + 13_000 + 8_700 + 230_000 + 1_800);
  assert.equal(all5.bytesHuman, '377.6 KB');
  assert.equal(all5.unknown, 0);

  const onlySkills = I.computeSelectionSummary(modules, ['skills']);
  assert.equal(onlySkills.files, 24);
  assert.deepEqual([...onlySkills.moduleIds], ['skills']);

  const none = I.computeSelectionSummary(modules, []);
  assert.equal(none.modules, 0);
  assert.equal(none.files, 0);

  // 宿主还没答话 → 计数是 null，必须记进 unknown，不能当成 0 个文件。
  const pending = I.computeSelectionSummary(I.fallbackModules(), ['skills', 'plugins']);
  assert.equal(pending.unknown, 2);
  assert.equal(pending.files, 0);
});

test('moduleRows 保持固定显示顺序，宿主多给的模块不会冒出来', () => {
  const I = internals();
  const rows = I.moduleRows({ scan: { modules: [...sampleScan().modules, { id: 'bogus', count: 1, files: 1, bytes: 1 }] } });
  // 注意：rows 是 vm realm 里造的数组，先展开成宿主数组再比，否则 deepStrictEqual 会因原型不等而失败。
  assert.deepEqual(
    [...rows.map((r) => r.id)],
    ['skills', 'plugins', 'config', 'memory', 'todo', 'sessions'],
  );
  // 宿主漏报的模块仍要占位（显示「待统计」），否则界面会莫名其妙少一张卡片。
  const partial = I.moduleRows({ scan: { modules: [{ id: 'skills', count: 1, files: 1, bytes: 1 }] } });
  assert.equal(partial.length, 6);
  assert.equal(partial.find((r) => r.id === 'memory').pending, true);
});

test('describeCounts 措辞与宿主一致，全零时明说「没有任何差异」', () => {
  const I = internals();
  assert.equal(I.describeCounts({ import: 49, keep: 0, delete: 0, same: 0, skip: 0, conflict: 0 }), '导入 49');
  assert.equal(
    I.describeCounts({ import: 3, keep: 2, delete: 1, same: 5, skip: 0, conflict: 1 }),
    '导入 3 · 保留本地 2 · 删除本地 1 · 无变化 5 · 待裁决 1',
  );
  assert.equal(I.describeCounts({ import: 0, keep: 0, delete: 0, same: 0, skip: 0, conflict: 0 }), '没有任何差异');
  assert.equal(I.describeCounts(undefined), '没有任何差异');
});

test('★ 冲突默认「未裁决」，绝不预选任何一侧（预选 = 替用户做决定）', () => {
  const I = internals();
  const conflicts = [
    { key: 'config:AGENTS.md' },
    { key: 'memory:MEMORY.md' },
  ];
  const empty = I.emptyResolutions();
  assert.deepEqual({ ...empty }, {}, '初始裁决表必须是空的');
  assert.equal(I.unresolvedCount(conflicts, empty), 2);

  const allLocal = I.setAllResolutions(conflicts, 'local');
  assert.equal(I.unresolvedCount(conflicts, allLocal), 0);
  assert.deepEqual({ ...allLocal }, { 'config:AGENTS.md': 'local', 'memory:MEMORY.md': 'local' });

  const partial = { 'config:AGENTS.md': 'archive' };
  assert.equal(I.unresolvedCount(conflicts, partial), 1);
});

test('groupActions 按「冲突→导入→删除→保留→跳过→无变化」排，空组不出现', () => {
  const I = internals();
  const groups = I.groupActions([
    { action: 'same', key: 'a' },
    { action: 'import', key: 'b' },
    { action: 'conflict', key: 'c' },
    { action: 'import', key: 'd' },
  ]);
  assert.deepEqual([...groups.map((g) => g.action)], ['conflict', 'import', 'same']);
  assert.equal(groups.find((g) => g.action === 'import').items.length, 2);
  assert.deepEqual([...I.groupActions([])], []);
  assert.deepEqual([...I.groupActions(undefined)], []);
});

test('shortHash 只截前 12 位，空值给破折号', () => {
  const I = internals();
  assert.equal(I.shortHash('77ba47961b3d362d969e056eb3d7c257329c4453c9a223ff16e5aaa900b22b3f'), '77ba47961b3d');
  assert.equal(I.shortHash(''), '—');
  assert.equal(I.shortHash(undefined), '—');
});

test('★ 注入的面板 CSS 花括号必须配平（少一个 } 会让其后所有规则静默失效）', () => {
  // 真实教训：dsh-memory-evolve 的 styles.css 在 .mt-pager-info 后多了一个孤立的 }，
  // 导致该文件 113 个选择器全部失效、整个面板「变丑」，而构建与运行都不报任何错。
  const css = internals().PANEL_CSS;
  let depth = 0;
  let min = 0;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < min) min = depth;
    }
  }
  assert.equal(min, 0, 'CSS 里出现了多余的 }（其后的规则会全部失效）');
  assert.equal(depth, 0, `CSS 的 { 与 } 数量不等，差 ${depth}`);
  assert.ok(css.includes('.dbs-root'), 'CSS 应当定义面板根类');
});

test('ensureStyles 幂等：注入一次；没有 document 时不抛错', () => {
  const I = internals();
  assert.doesNotThrow(() => I.ensureStyles(), '没有 document 时应当安静返回');

  const head = { children: [], appendChild(el) { this.children.push(el); } };
  const doc = {
    head,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
    getElementById: (id) => head.children.find((c) => c.id === id) ?? null,
  };
  const { module } = loadBundle({ globals: { document: doc } });
  module.__internals.ensureStyles();
  module.__internals.ensureStyles();
  assert.equal(head.children.length, 1, '样式只应注入一次');
  assert.equal(head.children[0].id, 'dsh-backup-sync-styles');
  assert.ok(head.children[0].textContent.includes('.dbs-root'), '注入的应当是面板样式');
});

test('apply 会顺带注入样式，且仍然只注册那两个槽位', () => {
  const head = { children: [], appendChild(el) { this.children.push(el); } };
  const doc = {
    head,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
    getElementById: (id) => head.children.find((c) => c.id === id) ?? null,
  };
  const { module } = loadBundle({ globals: { document: doc } });
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);
  assert.equal(head.children.length, 1, 'apply 应注入样式表');
  assert.deepEqual(calls.register.map((r) => r.options.name), ['sidebar.panellist', 'main']);
});

test('★ 弹框配色不许硬编码深色 —— 本机应用是浅色主题，深底深字等于不可读', () => {
  // 真实事故：.dbs-dialog 原来写 background:var(--dsh-surface,#1b1b1d)，
  // 而 0.2.0-rc.2 全应用只有一个 --dsh* 变量（--dsh-onboarding-border-angle），
  // 于是回退色 #1b1b1d 生效 → 浅色主题下弹框变成深底 + 深字，内容几乎看不见。
  const css = internals().PANEL_CSS;
  const dialog = css.match(/\.dbs-dialog\{[^}]*\}/)?.[0];
  assert.ok(dialog, '应当有 .dbs-dialog 规则');
  assert.ok(!/#1b1b1d|#1c1c1e|#000\b/.test(dialog), `弹框背景不得回退到硬编码深色：${dialog}`);
  assert.ok(/var\(--dbs-surface/.test(dialog), '弹框背景应使用运行时解析出的 --dbs-surface');
  assert.ok(/CanvasText/.test(dialog), '应保留 CanvasText 作为最后兜底');
  assert.ok(/color-scheme/.test(dialog), '应声明 color-scheme，让系统色跟随主题');
  // 面板自身也不该出现任何 --dsh-* 变量依赖（应用根本没定义）
  assert.ok(!/var\(--dsh-/.test(css), '不要依赖应用未定义的主题变量');
  assert.ok(/\.dbs-root\{[^}]*color:var\(--dbs-text/.test(css), '面板文字色应来自运行时解析');
});

test('syncTheme 从 body 的实际配色推出 --dbs-surface / --dbs-text', () => {
  const props = {};
  const doc = {
    body: {},
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
  };
  const { module } = loadBundle({
    globals: {
      document: doc,
      getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(15, 17, 21)' }),
    },
  });
  module.__internals.syncTheme();
  assert.equal(props['--dbs-surface'], 'rgb(255, 255, 255)');
  assert.equal(props['--dbs-text'], 'rgb(15, 17, 21)');
});

test('syncTheme 遇到透明背景时不写死颜色（交给 Canvas 兜底），也不抛错', () => {
  const props = {};
  const doc = {
    body: {},
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
  };
  const { module } = loadBundle({
    globals: {
      document: doc,
      getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'transparent' }),
    },
  });
  assert.doesNotThrow(() => module.__internals.syncTheme());
  assert.deepEqual({ ...props }, {}, '透明色不该被写成具体值');

  // 没有 document 时也必须安静返回
  assert.doesNotThrow(() => internals().syncTheme());
});

// ───────────────────────────────────────── 备份页签

test('备份页签：汇总条只算勾选的模块，六张卡片都有勾选框', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState() };
  const tree = renderFull(ui);
  const text = textOf(tree);

  assert.ok(text.includes('已选 5 个模块'), `汇总条应报告已选模块数，实得：${text}`);
  assert.ok(text.includes('39 个文件'), '应汇总文件数（24+3+2+8+2）');
  assert.ok(text.includes('377.6 KB'), '应汇总原始大小');

  // 每张模块卡片内部恰好一个勾选框（页面上还有「基线进包」等其它勾选框，不能全局数）。
  const cards = findAll(tree, (n) => typeof n.props?.['data-dbs-module'] === 'string');
  assert.equal(cards.length, 6);
  for (const card of cards) {
    const boxes = findAll(card, (n) => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(boxes.length, 1, `卡片「${card.props['data-dbs-module']}」应恰好一个勾选框，实得 ${boxes.length}`);
  }

  const sessionsCard = cards.find((c) => c.props['data-dbs-module'] === 'sessions');
  assert.equal(sessionsCard.props['data-on'], '0', '对话卡片默认不选中');
  assert.ok(textOf(sessionsCard).includes('本地专用 · 不上云'));
  assert.ok(textOf(sessionsCard).includes('48 个'), '对话应显示自己的条目数');
  assert.equal(findAll(sessionsCard, (n) => n.type === 'input')[0].props.checked, false, '对话默认不勾');

  const skillsCard = cards.find((c) => c.props['data-dbs-module'] === 'skills');
  assert.equal(findAll(skillsCard, (n) => n.type === 'input')[0].props.checked, true, '技能默认勾上');
});

test('★ 一个模块都没勾时「开始备份」必须禁用（否则会打出空包）', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), selected: [] };
  const tree = renderFull(ui);
  const start = buttonByText(tree, '开始备份');
  assert.equal(start.length, 1);
  assert.equal(start[0].props.disabled, true);
  assert.ok(textOf(tree).includes('已选 0 个模块'));
});

test('宿主还没答话时「开始备份」也是禁用的（不能拿未知清单去打包）', () => {
  const tree = renderFull(initialUi());
  const start = buttonByText(tree, '开始备份');
  assert.equal(start[0].props.disabled, true);
});

test('★ 备份二次确认把「要备什么、多大、放哪、叫什么名字」一次说清', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), confirmingBackup: true };
  const tree = renderFull(ui);
  const text = textOf(tree);

  assert.ok(text.includes('确认备份'), '应弹出二次确认');
  assert.ok(text.includes('5 个：技能、插件、配置、记忆、待办'), `应列出模块名，实得：${text}`);
  assert.ok(text.includes('39 个'), '应列出文件数');
  assert.ok(text.includes('377.6 KB'), '应列出原始大小');
  assert.ok(text.includes('D:\\dsh-backups-sync'), '应列出输出目录');
  assert.ok(text.includes('dsh-sync-'), '应说明包名按时间自动生成');
  assert.ok(text.includes('按备份时间自动命名'), '应明确命名规则');
  // 二次确认必须给出「取消」与「确认备份」两条出路
  assert.equal(buttonByText(tree, '取消').length, 1);
  assert.equal(buttonByText(tree, '确认备份').length, 1);
});

test('★ 勾了「对话」时二次确认要明确警告内容会随包外流', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    selected: ['skills', 'sessions'],
    confirmingBackup: true,
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('注意'), '勾了对话必须给警告');
  assert.ok(text.includes('对话'), '警告要点名是哪个模块');
  assert.ok(text.includes('工作对话原文'), '要说清风险到底是什么');
});

test('备份目录输入框：空值时用宿主的目录做占位提示', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState() };
  const tree = renderFull(ui);
  const input = findAll(tree, (n) => n.type === 'input' && n.props.id === 'dbs-outdir')[0];
  assert.ok(input, '应有备份目录输入框');
  assert.equal(input.props.value, '');
  assert.equal(input.props.placeholder, 'D:\\dsh-backups-sync');
});

test('备份完成后把包名、大小、路径、sha256、边车校验结果都摆出来', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    backupResult: {
      ok: true,
      archive: {
        name: 'dsh-sync-20261013-180657.tar.gz',
        path: 'D:\\dsh-backups-sync\\dsh-sync-20261013-180657.tar.gz',
        bytesHuman: '181.9 KB',
        sha256: '77ba47961b3d362d969e056eb3d7c257329c4453c9a223ff16e5aaa900b22b3f',
        modules: ['skills', 'plugins', 'config', 'memory', 'todo'],
        totals: { files: 49, bytes: 426_800 },
      },
      sidecar: { ok: true },
    },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('备份完成'));
  assert.ok(text.includes('dsh-sync-20261013-180657.tar.gz'));
  assert.ok(text.includes('181.9 KB'));
  assert.ok(text.includes('77ba47961b3d362d969e056eb3d7c257329c4453c9a223ff16e5aaa900b22b3f'), 'sha256 要完整展示，方便和边车文件对');
  assert.ok(text.includes('通过'), '边车校验结果要显示');
  assert.ok(text.includes('49 个'), '文件数要显示');
});

test('展开某个模块能看到逐文件清单（含相对路径与体积）', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), expanded: { skills: true } };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('收起文件'), '展开后按钮文案应变成「收起文件」');
  assert.ok(text.includes('cdp-browser-automation/SKILL.md'), '应列出相对路径');
  assert.ok(text.includes('2.0 KB'), '应列出体积');
});

// ───────────────────────────────────────── 历史版本页签

test('历史版本：空目录给出下一步指引，而不是一片空白', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), tab: 'history' };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('还没有备份包'), '空态要有提示');
  assert.ok(text.includes('去「备份」页签'), '要告诉用户下一步做什么');
});

test('历史版本：列出每份包的名称/时间/大小/机器/文件数，并给出校验、导入、复制路径', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    tab: 'history',
    state: sampleState({
      archives: [
        {
          name: 'dsh-sync-20261013-180657.tar.gz',
          path: 'D:\\dsh-backups-sync\\dsh-sync-20261013-180657.tar.gz',
          bytesHuman: '181.9 KB',
          mtimeLocal: '2026-10-13 18:06:57',
          machine: 'demo-pc',
          modules: ['skills', 'plugins', 'config', 'memory', 'todo'],
          totals: { files: 49 },
        },
      ],
    }),
  };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('dsh-sync-20261013-180657.tar.gz'));
  assert.ok(text.includes('181.9 KB'));
  assert.ok(text.includes('demo-pc'));
  assert.ok(text.includes('49 个文件'));
  assert.ok(text.includes('5 个模块'));
  // 页签栏里也有一个叫「导入」的按钮，所以要限定在历史版本的列表行里找。
  const row = findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className === 'dbs-row')[0];
  assert.ok(row, '应有一行历史版本');
  for (const label of ['校验', '导入', '复制路径']) {
    assert.equal(buttonByText(row, label).length, 1, `每份包应有「${label}」按钮`);
  }
});

test('历史版本：校验结果如实报数，不符项逐条列出', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    tab: 'history',
    state: sampleState({ archives: [{ name: 'a.tar.gz', path: 'D:\\a.tar.gz', bytesHuman: '1.0 KB', mtimeLocal: 'x', machine: 'm', modules: [], totals: { files: 3 } }] }),
    verifyResult: { ok: false, archive: { name: 'a.tar.gz' }, checked: 3, bad: [{ path: 'dsh/x.md', reason: '哈希不符' }] },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('校验未通过'));
  assert.ok(text.includes('逐文件重算哈希 3 个'));
  assert.ok(text.includes('dsh/x.md：哈希不符'));
});

// ───────────────────────────────────────── 导入页签

test('★ 导入：没选包时「分析差异」禁用（不能拿空来源去分析）', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), tab: 'import' };
  const tree = renderFull(ui);
  const go = buttonByText(tree, '分析差异');
  assert.equal(go.length, 1);
  assert.equal(go[0].props.disabled, true);
});

test('导入：从历史版本点「导入」后自动跳到导入页签并带上包名', () => {
  const archives = [
    {
      name: 'dsh-sync-20261013-180657.tar.gz',
      path: 'D:\\dsh-backups-sync\\dsh-sync-20261013-180657.tar.gz',
      bytesHuman: '181.9 KB',
      mtimeLocal: '2026-10-13 18:06:57',
      machine: 'demo-pc',
      modules: ['skills'],
      totals: { files: 49 },
    },
  ];
  const ui = { ...initialUi(), loading: false, state: sampleState({ archives }), tab: 'import', importSource: archives[0].name };
  const tree = renderFull(ui);
  const go = buttonByText(tree, '分析差异');
  assert.equal(go[0].props.disabled, false, '选了包就应可点');
  const select = findAll(tree, (n) => n.type === 'select')[0];
  assert.ok(select, '有历史包时应当给下拉选择');
  assert.equal(select.props.value, archives[0].name);
  // 下拉里除了占位项，应当能选到这份包
  const options = findAll(select, (n) => n.type === 'option');
  assert.equal(options.length, 2);
  assert.ok(textOf(options[1]).includes(archives[0].name));
});

test('导入：删除开关默认关闭，并明确写出「默认不删任何本地文件」', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), tab: 'import' };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('默认不删任何本地文件'));
  assert.ok(!text.includes('已开启删除'));

  const on = textOf(renderFull({ ...ui, allowDelete: true }));
  assert.ok(on.includes('已开启删除'), '打开删除后必须换成警告文案');
  assert.ok(on.includes('本地改过的一律报冲突'), '要说清删除的边界');
});

test('★ 导入预览：计数网格 + 基准来源说明（本机没同步过必须说清是「全部按新增」）', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'dsh-sync-20261013-180657.tar.gz',
    preview: samplePreview(),
  };
  const tree = renderFull(ui);
  const text = textOf(tree);

  assert.ok(text.includes('比较基准'), '要显示比较基准');
  assert.ok(text.includes('本机还没同步过，全部按新增处理'), `首次导入必须讲清基准，实得：${text}`);
  assert.ok(text.includes('仅用于溯源，不参与比较'), '包内基线要说清它不参与比较');
  assert.ok(text.includes('dsh-sync-20261013-180657.tar.gz'));
  assert.ok(text.includes('49'), '计数网格要显示导入数');

  // 计数网格的六个格子（零值也显示，避免用户以为漏了一格）
  const counts = findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className === 'dbs-count');
  assert.equal(counts.length, 6, '六格计数都应显示，包括 0');
});

test('★ 有冲突时逐条列出，默认两侧都不选，并如实报「还有几处没选」', () => {
  const conflicts = [
    { key: 'config:AGENTS.md', moduleId: 'config', relPath: 'AGENTS.md', base: 'aa'.repeat(32), ours: 'bb'.repeat(32), theirs: 'cc'.repeat(32), reason: '双方都改了 → 需裁决' },
    { key: 'memory:MEMORY.md', moduleId: 'memory', relPath: 'MEMORY.md', base: 'dd'.repeat(32), ours: 'ee'.repeat(32), theirs: 'ff'.repeat(32), reason: '双方都改了 → 需裁决' },
  ];
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'a.tar.gz',
    preview: samplePreview({ conflicts, counts: { import: 47, keep: 0, delete: 0, same: 0, skip: 0, conflict: 2 } }),
  };
  const tree = renderFull(ui);
  const text = textOf(tree);

  assert.ok(text.includes('需要你裁决 2 处冲突'));
  assert.ok(text.includes('还有 2 处没选'));
  assert.ok(text.includes('config · AGENTS.md'), '要显示模块与相对路径');
  assert.ok(text.includes('本地 bbbbbbbbbbbb'), '要给出本地哈希前缀');
  assert.ok(text.includes('归档 cccccccccccc'), '要给出归档哈希前缀');
  assert.ok(text.includes('基准 aaaaaaaaaaaa'), '要给出共同祖先哈希前缀');

  const radios = findAll(tree, (n) => n.type === 'input' && n.props.type === 'radio');
  assert.equal(radios.length, 4, '每条冲突两个选项');
  assert.equal(radios.filter((r) => r.props.checked === true).length, 0, '默认一个都不预选');

  // 裁决完之后不再提示未裁决
  const resolved = textOf(
    renderFull({ ...ui, resolutions: { 'config:AGENTS.md': 'archive', 'memory:MEMORY.md': 'local' } }),
  );
  assert.ok(resolved.includes('已全部裁决'));
  assert.ok(!resolved.includes('还有 2 处没选'));
});

// ───────────────────────── 冲突裁决必须折算进计数
//
// 真机踩到的缺陷：点了「全部采用归档」，界面还写着「待裁决 1 · 导入 0」，
// 二次确认甚至说「没有任何差异」—— 而实际上会写 1 个文件。裁决是本地状态，
// 宿主给的 counts 是裁决前的原始差异，必须在客户端折算，否则数字与行为矛盾。

/** 把 CountGrid 的格子读成 { 标签: 数值 }。 */
function countCells(tree) {
  const out = {};
  for (const cell of findAll(tree, (n) => n.props?.className === 'dbs-count')) {
    const value = cell.children?.[0]?.children?.[0];
    const label = cell.children?.[1]?.children?.[0];
    if (typeof label === 'string') out[label] = String(value);
  }
  return out;
}

/** 一条真冲突的预览。 */
function conflictPreview(over = {}) {
  const conflicts = [
    { key: 'skills:SKILL.md', moduleId: 'skills', relPath: 'SKILL.md', base: 'a'.repeat(64), ours: 'b'.repeat(64), theirs: 'c'.repeat(64), reason: '双方都改了 → 需裁决' },
  ];
  return samplePreview({
    conflicts,
    counts: { import: 0, keep: 0, delete: 0, same: 19, skip: 31, conflict: 1 },
    ...over,
  });
}

test('effectiveCounts：裁决折算规则（归档→导入、本地→保留、未裁决→待裁决）', () => {
  const I = internals();
  const p = conflictPreview();
  assert.deepEqual({ ...I.effectiveCounts(p, {}) }, { import: 0, keep: 0, delete: 0, same: 19, skip: 31, conflict: 1 });
  assert.deepEqual({ ...I.effectiveCounts(p, { 'skills:SKILL.md': 'archive' }) }, { import: 1, keep: 0, delete: 0, same: 19, skip: 31, conflict: 0 });
  assert.deepEqual({ ...I.effectiveCounts(p, { 'skills:SKILL.md': 'local' }) }, { import: 0, keep: 1, delete: 0, same: 19, skip: 31, conflict: 0 });
  // 折算不得改动宿主给的原始对象
  assert.equal(p.counts.conflict, 1, '不能就地改宿主的 counts');
  assert.equal(p.counts.import, 0);
  // 没有预览 / 没有冲突时也不能炸：一律回「写入 0」，确认框就不会谎报要写东西
  assert.deepEqual({ ...I.effectiveCounts(null, {}) }, { import: 0, keep: 0, conflict: 0 });
  assert.equal(I.effectiveCounts({ counts: { import: 2 } }, {}).import, 2);
  assert.equal(I.effectiveWriteCount({ import: 3, delete: 2 }), 5);
  assert.equal(I.effectiveWriteCount(null), 0);
});

test('★ 裁决后差异区的数字必须跟着动（真机缺陷回归）', () => {
  const base = { ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a.tar.gz', preview: conflictPreview() };

  const unresolved = countCells(renderFull(base));
  assert.equal(unresolved['待裁决'], '1');
  assert.equal(unresolved['导入'], '0');

  const toArchive = countCells(renderFull({ ...base, resolutions: { 'skills:SKILL.md': 'archive' } }));
  assert.equal(toArchive['待裁决'], '0', '裁决完就不该再报待裁决');
  assert.equal(toArchive['导入'], '1', '采用归档必须计入「导入」');

  const toLocal = countCells(renderFull({ ...base, resolutions: { 'skills:SKILL.md': 'local' } }));
  assert.equal(toLocal['待裁决'], '0');
  assert.equal(toLocal['保留本地'], '1');
  assert.equal(toLocal['导入'], '0');
});

test('★ 未裁决时「执行导入」应禁用，并让用户先去裁决（而不是点进去看到「没有差异」）', () => {
  const tree = renderFull({ ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a.tar.gz', preview: conflictPreview() });
  const go = buttonByText(tree, '执行导入');
  assert.equal(go[0].props.disabled, true);
  const text = textOf(tree);
  assert.ok(text.includes('还有 1 处冲突没裁决'), `要说清为什么不能点：${text.slice(-300)}`);
  assert.ok(text.includes('选「采用归档版本」才会写入'));
});

test('★ 裁决为「采用归档」后「执行导入」才可点', () => {
  const tree = renderFull({
    ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a.tar.gz',
    preview: conflictPreview(), resolutions: { 'skills:SKILL.md': 'archive' },
  });
  assert.equal(buttonByText(tree, '执行导入')[0].props.disabled, false);
});

test('★ 裁决为「保留本地」时禁用，并说明不会写入任何东西', () => {
  const tree = renderFull({
    ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a.tar.gz',
    preview: conflictPreview(), resolutions: { 'skills:SKILL.md': 'local' },
  });
  assert.equal(buttonByText(tree, '执行导入')[0].props.disabled, true);
  assert.ok(textOf(tree).includes('裁决结果是「保留本地」'));
});

test('★ 宿主说不能导入时，客户端不许自己放开（canApply 是上限）', () => {
  const tree = renderFull({
    ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a.tar.gz',
    preview: conflictPreview({ canApply: false }), resolutions: { 'skills:SKILL.md': 'archive' },
  });
  assert.equal(buttonByText(tree, '执行导入')[0].props.disabled, true, '折算后能写也不行，宿主说不行就是不行');
});

test('★ 二次确认的「将写入」必须与页面数字一致（不再出现「没有任何差异」而实际写入）', () => {
  const base = {
    ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a.tar.gz',
    preview: conflictPreview(), confirmingApply: true,
  };

  const toArchive = textOf(renderFull({ ...base, resolutions: { 'skills:SKILL.md': 'archive' } }));
  assert.ok(toArchive.includes('导入 1'), `确认框应写「导入 1」：${toArchive.slice(-400)}`);
  assert.ok(!toArchive.includes('没有任何差异'), '要写入时不能说没有差异');
  assert.ok(toArchive.includes('未裁决冲突\n无') || toArchive.includes('无'), '已裁决就不该报未裁决');

  const toLocal = textOf(renderFull({ ...base, resolutions: { 'skills:SKILL.md': 'local' } }));
  assert.ok(toLocal.includes('0 个（不会改动任何文件）'), `保留本地时应明说不会改文件：${toLocal.slice(-400)}`);

  const unresolved = textOf(renderFull(base));
  assert.ok(unresolved.includes('1 处（按保留本地处理）'), '未裁决要在确认框里说明后果');
  assert.ok(unresolved.includes('0 个（不会改动任何文件）'));
});

test('导入：动作明细可展开，按动作分组并写明每条的原因', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'a.tar.gz',
    preview: samplePreview(),
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('动作明细（共 2 条）'));
  assert.ok(text.includes('导入 1 条'));
  assert.ok(text.includes('无变化 1 条'));
  assert.ok(text.includes('skills · cdp/SKILL.md'));
  assert.ok(text.includes('归档新增，本地没有'), '每条要带上宿主给的原因');
});

test('导入：没有可写入内容时禁用「执行导入」并说明原因', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'a.tar.gz',
    preview: samplePreview({
      counts: { import: 0, keep: 0, delete: 0, same: 49, skip: 0, conflict: 0 },
      actions: [{ key: 'k', moduleId: 'skills', relPath: 'a', action: 'same', reason: '双方都没动' }],
      canApply: false,
    }),
  };
  const tree = renderFull(ui);
  const go = buttonByText(tree, '执行导入');
  assert.equal(go.length, 1);
  assert.equal(go[0].props.disabled, true);
  assert.ok(textOf(tree).includes('没有需要写入的内容'));
});

test('★ 导入二次确认必须写明「会写什么、未裁决几处、删不删」，并说明有快照与回滚', () => {
  const conflicts = [{ key: 'config:AGENTS.md', moduleId: 'config', relPath: 'AGENTS.md', ours: 'b'.repeat(64), theirs: 'c'.repeat(64), base: 'a'.repeat(64), reason: 'r' }];
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'dsh-sync-20261013-180657.tar.gz',
    preview: samplePreview({ conflicts, counts: { import: 48, keep: 0, delete: 0, same: 0, skip: 0, conflict: 1 } }),
    confirmingApply: true,
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('确认导入'));
  assert.ok(text.includes('将写入'));
  assert.ok(text.includes('导入 48'));
  assert.ok(text.includes('1 处（按保留本地处理）'), '未裁决的后果要说清楚');
  assert.ok(text.includes('关闭（不会删本地文件）'));
  assert.ok(text.includes('pre-restore-'), '要告诉用户有快照');
  assert.ok(text.includes('回算 sha256'), '要告诉用户写完会校验');
});

test('导入结果：报出写入数、校验数、快照目录与失败项', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'a.tar.gz',
    applyResult: {
      ok: true,
      counts: { import: 49, keep: 0, delete: 0, skip: 0, same: 0, failed: 0 },
      verified: { checked: 49, failed: 0 },
      snapshotDir: 'C:\\Users\\x\\.dsh\\backup-sync\\pre-restore-20261013-181500',
      snapshotFiles: 2,
      conflictsUnresolved: [],
      baselinePath: 'C:\\Users\\x\\.dsh\\backup-sync\\state.json',
      errors: [],
    },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('导入完成'));
  assert.ok(text.includes('导入 49'));
  assert.ok(text.includes('49 个，失败 0 个'));
  assert.ok(text.includes('pre-restore-20261013-181500'));
  assert.ok(text.includes('state.json'));
});

test('导入结果：有失败项时改成醒目提示，并把每条错误列出来', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'a.tar.gz',
    applyResult: {
      ok: false,
      counts: { import: 48, keep: 0, delete: 0, skip: 0, same: 0, failed: 1 },
      verified: { checked: 48, failed: 1 },
      snapshotDir: null,
      snapshotFiles: 0,
      conflictsUnresolved: [],
      baselinePath: null,
      errors: [{ key: 'skills:x/SKILL.md', message: '写入后哈希不符，已回滚' }],
    },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('导入有失败项'));
  assert.ok(text.includes('skills:x/SKILL.md：写入后哈希不符，已回滚'));
  assert.ok(text.includes('无（本次没有覆盖任何已有文件）'), '没有快照要说清楚是为什么');
});

// ───────────────────────────────────────── 同步页签

test('同步页签：说清这是「复制到文件夹」而不是真的云同步', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), tab: 'sync' };
  const tree = renderFull(ui);
  const text = textOf(tree);

  assert.ok(text.includes('最小的同步方式'));
  assert.ok(text.includes('U 盘、OneDrive、坚果云'));
  assert.ok(text.includes('.sha256 与 .meta.json'), '要说清边车也一起复制');
  assert.ok(text.includes('二期'), '要说明 git / WebDAV 还没做');

  // 没填目录时两个按钮都禁用
  for (const label of ['推送最新备份过去', '列出文件夹里的包']) {
    const b = buttonByText(tree, label);
    assert.equal(b.length, 1);
    assert.equal(b[0].props.disabled, true, `没填同步目录时「${label}」应禁用`);
  }
});

test('同步页签：列出文件夹里的包，并给出「去导入」入口', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    syncDir: 'D:\\OneDrive\\dsh-sync',
    syncListing: {
      ok: true,
      target: 'D:\\OneDrive\\dsh-sync',
      exists: true,
      archives: [
        { name: 'dsh-sync-20261013-180657.tar.gz', path: 'D:\\OneDrive\\dsh-sync\\dsh-sync-20261013-180657.tar.gz', bytesHuman: '181.9 KB', mtimeLocal: '2026-10-13 18:10:02', machine: 'demo-pc', totals: { files: 49 } },
      ],
    },
  };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('dsh-sync-20261013-180657.tar.gz'));
  assert.ok(text.includes('181.9 KB'));
  assert.equal(buttonByText(tree, '去导入').length, 1);
});

test('同步页签：文件夹不存在时明确报出来，而不是假装列了个空表', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    syncDir: 'Z:\\nope',
    syncListing: { ok: true, target: 'Z:\\nope', exists: false, archives: [] },
  };
  assert.ok(textOf(renderFull(ui)).includes('文件夹不存在'));
});

test('★ 整个面板不出现 undefined / NaN / [object Object]（六种状态全查一遍）', () => {
  const states = [
    initialUi(),
    { ...initialUi(), loading: false, state: sampleState() },
    { ...initialUi(), loading: false, state: sampleState(), tab: 'history' },
    { ...initialUi(), loading: false, state: sampleState(), tab: 'import', importSource: 'a', preview: samplePreview() },
    { ...initialUi(), loading: false, state: sampleState(), tab: 'sync', syncDir: 'D:\\x' },
    { ...initialUi(), loading: false, state: sampleState(), confirmingBackup: true },
  ];
  for (const [i, ui] of states.entries()) {
    const text = textOf(renderFull(ui));
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      assert.ok(!text.includes(bad), `第 ${i + 1} 种状态出现了「${bad}」：${text.slice(0, 400)}`);
    }
  }
});

// ───────────────────────── 凭据守卫的界面呈现

/** 造一份「有文件被凭据守卫拦下」的 /state。 */
function stateWithBlocked(credentials) {
  const s = sampleState();
  return { ...s, scan: { ...s.scan, credentials } };
}

test('★ 有文件被凭据守卫拦下时，备份页签必须显著提示，并逐条列出原因', () => {
  const blocked = [
    { moduleId: 'memory', relPath: 'projects/abc/KEY.md', reason: '内容命中「带令牌的 git 地址」（片段 https:…01）' },
    { moduleId: 'config', relPath: '.credentials.yaml', reason: '文件名属于凭据类（.credentials.yaml）' },
  ];
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: stateWithBlocked(blocked) }));

  assert.ok(text.includes('凭据守卫拦下 2 个文件'), `应报出拦截数量：${text.slice(0, 300)}`);
  assert.ok(text.includes('它们不会进包'), '必须说清后果');
  assert.ok(text.includes('projects/abc/KEY.md'), '要列出文件路径');
  assert.ok(text.includes('内容命中「带令牌的 git 地址」'), '要列出命中原因');
  assert.ok(text.includes('.credentials.yaml'), '文件名类拦截也要列出');
  assert.ok(text.includes('文件名属于凭据类'), '文件名类原因也要列出');
});

test('没有拦截时不出现凭据提示（避免天天喊狼来了）', () => {
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: sampleState() }));
  assert.ok(!text.includes('凭据守卫拦下'), '没有拦截就不该出现红条');
});

test('拦截超过 8 个时折叠，并给出剩余数量', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    moduleId: 'memory',
    relPath: `f${i}.md`,
    reason: '内容命中「OpenAI 风格密钥」',
  }));
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: stateWithBlocked(many) }));
  assert.ok(text.includes('凭据守卫拦下 11 个文件'), '总数要报全');
  assert.ok(text.includes('f0.md') && text.includes('f7.md'), '前 8 个要列出');
  assert.ok(!text.includes('f8.md'), '第 9 个起折叠');
  assert.ok(text.includes('还有 3 个'), '要说明折叠了几个');
});

test('★ 备份二次确认里要带上凭据拦截数（用户确认的是「这些内容」，不是全部）', () => {
  const blocked = [{ moduleId: 'memory', relPath: 'a.md', reason: '内容命中「JWT」' }];
  const text = textOf(
    renderFull({ ...initialUi(), loading: false, state: stateWithBlocked(blocked), confirmingBackup: true }),
  );
  assert.ok(text.includes('凭据守卫'), '确认框要提一句');
  assert.ok(text.includes('拦下 1 个文件，不进包'), `要说清数量与后果：${text.slice(-400)}`);
});

test('★ 拦截字段缺失时（老宿主/接口裁剪）面板不得崩，也不得显示 undefined', () => {
  const s = sampleState();
  const noField = { ...s, scan: { ...s.scan } };
  delete noField.scan.credentials;
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: noField }));
  assert.ok(!text.includes('凭据守卫拦下'), '字段缺失就当作没有拦截');
  assert.ok(!text.includes('undefined'), '不得显示 undefined');
});

// ───────────────────────── callApi：区分「调用失败」与「业务结论」

/** 造一个假 fetch，按顺序返回给定的响应。 */
function fakeFetchOf(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r === undefined) throw new Error('假 fetch 没有更多响应了');
    return r;
  };
  fn.calls = calls;
  return fn;
}

/** 造一个「宿主正常应答」的 Response 替身。 */
function jsonResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

/** 造一个「应答不是 JSON」的 Response 替身。 */
function badJsonResponse(status) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  };
}

test('★ 校验未通过是「正常应答」，不是调用失败 —— 不得被 callApi 抛成异常（真机缺陷回归）', async () => {
  // 真机症状：面板顶部出现「出错了：HTTP 200」，而真正有用的 bad 列表被整个丢掉。
  // 宿主 /verify 的失败形状是 {ok:false, sidecar:{ok:false,...}, bad:[...]}，HTTP 200、没有 error 字段。
  const payload = {
    ok: false,
    archive: { name: 'dsh-sync-20260101-000000.tar.gz' },
    sidecar: { ok: false, expected: 'aa'.repeat(32), actual: 'bb'.repeat(32), checked: true },
    checked: 3,
    bad: [],
  };
  const fetch = fakeFetchOf([jsonResponse(200, payload)]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;

  const data = await callApi('/verify', { archiveName: 'x.tar.gz' });
  assert.equal(data.ok, false, '结论要原样交回调用方');
  assert.equal(data.checked, 3, '明细不能丢');
  assert.equal(data.sidecar.ok, false, '边车结论不能丢');
  assert.equal(fetch.calls.length, 1);
});

test('宿主用 jsonFail 报错时（{ok:false, error}）callApi 必须抛，且抛的是那句人话', async () => {
  const fetch = fakeFetchOf([jsonResponse(400, { ok: false, error: '备份目录不存在' })]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/backup', {}), /备份目录不存在/);
});

test('★ ok:false 且 error 是空串/非字符串时，按「业务结论」处理而不是抛「HTTP 200」', async () => {
  const cases = [{ ok: false, error: '' }, { ok: false, error: null }, { ok: false }];
  for (const payload of cases) {
    const fetch = fakeFetchOf([jsonResponse(200, payload)]);
    const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
    const data = await callApi('/state');
    assert.equal(data.ok, false, `${JSON.stringify(payload)} 应原样返回`);
  }
});

test('应答不是 JSON 时报「接口返回的不是 JSON」并带上状态码', async () => {
  const fetch = fakeFetchOf([badJsonResponse(502)]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/state'), /接口返回的不是 JSON（HTTP 502）/);
});

test('HTTP 非 2xx 但 body 是 JSON 且没写 ok:false 时，仍然要报错', async () => {
  const fetch = fakeFetchOf([jsonResponse(500, { message: '内部错误' })]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/state'), /HTTP 500/);
});

test('GET 不带 body、POST 带 JSON body 与 content-type', async () => {
  const fetch = fakeFetchOf([jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true })]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await callApi('/state');
  await callApi('/backup', { moduleIds: ['skills'] });
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(fetch.calls[0].init.body, undefined);
  assert.equal(fetch.calls[1].init.method, 'POST');
  assert.equal(fetch.calls[1].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body), { moduleIds: ['skills'] });
  assert.ok(fetch.calls[0].url.endsWith('/api/dsh-backup-sync/state'), fetch.calls[0].url);
});

// ───────────────────────── 校验结果的文案

/** 历史页在有包时才渲染校验结果块，所以造一行包。 */
const ONE_ARCHIVE = {
  name: 'dsh-sync-20261013-180657.tar.gz',
  path: 'D:\\dsh-backups-sync\\dsh-sync-20261013-180657.tar.gz',
  bytesHuman: '191.9 KB',
  mtimeLocal: '2026-10-13 18:06:57',
  machine: 'demo-pc',
  modules: ['skills'],
  totals: { files: 50 },
};

test('★ 边车 sha256 不符时要说清「期望 vs 实得」，不能只报「不符 0 个」（真机缺陷回归）', () => {
  const text = textOf(
    renderFull({
      ...initialUi(),
      loading: false,
      state: sampleState({ archives: [ONE_ARCHIVE] }),
      tab: 'history',
      verifyResult: {
        ok: false,
        archive: { name: 'dsh-sync-20260101-000000.tar.gz' },
        sidecar: { ok: false, expected: 'a1b2c3d4e5f6' + '0'.repeat(52), actual: 'ffeeddccbbaa' + '1'.repeat(52), checked: true },
        checked: 50,
        bad: [],
      },
    }),
  );
  assert.ok(text.includes('校验未通过'), '标题要说不通过');
  assert.ok(text.includes('边车 sha256 不符'), `要解释失败原因：${text.slice(-500)}`);
  assert.ok(text.includes('a1b2c3d4e5f6'), '要给出期望值前缀');
  assert.ok(text.includes('ffeeddccbbaa'), '要给出实得值前缀');
  assert.ok(text.includes('不符 0 个'), '逐文件不符数仍要如实显示');
});

test('逐文件哈希不符时逐条列出路径与原因', () => {
  const text = textOf(
    renderFull({
      ...initialUi(),
      loading: false,
      state: sampleState({ archives: [ONE_ARCHIVE] }),
      tab: 'history',
      verifyResult: {
        ok: false,
        archive: { name: 'p.tar.gz' },
        sidecar: { ok: true, expected: 'x', actual: 'x', checked: true },
        checked: 2,
        bad: [{ path: 'dsh/skills/a/SKILL.md', reason: '哈希不符（期望 abc…，实得 def…）' }],
      },
    }),
  );
  assert.ok(text.includes('dsh/skills/a/SKILL.md'), '要列出路径');
  assert.ok(text.includes('哈希不符'), '要列出原因');
  assert.ok(!text.includes('边车 sha256 不符'), '边车没问题就不该提');
});

test('校验通过时不出现任何失败文案', () => {
  const text = textOf(
    renderFull({
      ...initialUi(),
      loading: false,
      state: sampleState({ archives: [ONE_ARCHIVE] }),
      tab: 'history',
      verifyResult: {
        ok: true,
        archive: { name: 'p.tar.gz' },
        sidecar: { ok: true, expected: 'x', actual: 'x', checked: true },
        checked: 50,
        bad: [],
      },
    }),
  );
  assert.ok(text.includes('校验通过'), '要有通过提示');
  assert.ok(!text.includes('校验未通过'), '不该同时出现失败提示');
  assert.ok(!text.includes('边车 sha256 不符'));
  assert.ok(!text.includes('反馈给开发者'));
});

test('★ 两个判据都解释不了 ok:false 时，如实说明而不是留一个红框没有理由', () => {
  const text = textOf(
    renderFull({
      ...initialUi(),
      loading: false,
      state: sampleState({ archives: [ONE_ARCHIVE] }),
      tab: 'history',
      verifyResult: { ok: false, archive: { name: 'p.tar.gz' }, sidecar: { ok: true }, checked: 0, bad: [] },
    }),
  );
  assert.ok(text.includes('逐文件哈希全部相符，却仍判为未通过'), `要给个说法：${text.slice(-400)}`);
  assert.ok(text.includes('反馈给开发者'), '要引导用户上报');
});

test('verifyDetailLines 对残缺输入不崩、不吐 undefined', () => {
  const { verifyDetailLines } = internals();
  for (const v of [null, undefined, {}, { ok: false }, { ok: true, bad: null }, { ok: false, sidecar: null, bad: [] }]) {
    // vm 里造的数组带的是 vm realm 的原型，deepStrictEqual 会判不等 —— 一律摊平成宿主数组。
    const lines = [...verifyDetailLines(v)];
    assert.ok(Array.isArray(lines), `${JSON.stringify(v)} 应返回数组`);
    for (const l of lines) {
      assert.ok(typeof l === 'string' && !l.includes('undefined'), `坏行：${l}`);
    }
  }
  assert.deepStrictEqual([...verifyDetailLines(null)], []);
  assert.deepStrictEqual([...verifyDetailLines({ ok: true, sidecar: { ok: true }, bad: [] })], []);
});
