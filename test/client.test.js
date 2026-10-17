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
      {
        id: 'skills',
        countKind: 'dir',
        count: 10,
        files: 24,
        bytes: 133_120,
        bytesHuman: '130.0 KB',
        exists: true,
        entries: [
          { relPath: 'cdp-browser-automation/SKILL.md', size: 2048, sizeHuman: '2.0 KB' },
          { relPath: 'cdp-browser-automation/scripts/run.mjs', size: 1024, sizeHuman: '1.0 KB' },
          { relPath: 'win-disk-cleaner/SKILL.md', size: 512, sizeHuman: '512 B' },
        ],
      },
      {
        id: 'plugins',
        countKind: 'file',
        count: 3,
        files: 3,
        bytes: 13_000,
        bytesHuman: '12.7 KB',
        exists: true,
        entries: [
          { relPath: 'package.json', size: 919, sizeHuman: '919 B' },
          { relPath: 'pnpm-lock.yaml', size: 11_800, sizeHuman: '11.5 KB' },
        ],
      },
      {
        id: 'config',
        countKind: 'file',
        count: 2,
        files: 2,
        bytes: 8_700,
        bytesHuman: '8.5 KB',
        exists: true,
        entries: [
          { relPath: 'settings.yaml', size: 5, sizeHuman: '5 B' },
          { relPath: 'AGENTS.md', size: 1400, sizeHuman: '1.4 KB' },
        ],
      },
      { id: 'memory', countKind: 'file', count: 8, files: 8, bytes: 230_000, bytesHuman: '224.6 KB', exists: true, entries: [] },
      { id: 'todo', countKind: 'entry', count: 2, files: 2, bytes: 1_800, bytesHuman: '1.8 KB', exists: true, entries: [] },
      { id: 'sessions', countKind: 'dir', count: 48, files: 48, bytes: 23_700_000, bytesHuman: '22.60 MB', exists: true, entries: [] },
    ],
  };
}

/** 一份 /skills 应答（三个技能，覆盖「有描述 / 只有标题 / 缺 SKILL.md」）。 */
function sampleSkills() {
  return [
    {
      id: 'cdp-browser-automation',
      name: 'cdp-browser-automation',
      dir: 'cdp-browser-automation',
      path: 'C:\\Users\\x\\.agents\\skills\\cdp-browser-automation',
      description: '通过 DevTools 协议驱动一个已经在运行的 Chrome。',
      descriptionSource: 'frontmatter',
      hasSkillMd: true,
      files: 2,
      bytes: 3072,
      bytesHuman: '3.0 KB',
      mtimeMs: 1_760_000_000_000,
    },
    {
      id: 'win-disk-cleaner',
      name: 'cleaner',
      dir: 'win-disk-cleaner',
      path: 'C:\\Users\\x\\.agents\\skills\\win-disk-cleaner',
      description: 'cleaner',
      descriptionSource: 'heading',
      hasSkillMd: true,
      files: 1,
      bytes: 512,
      bytesHuman: '512 B',
      mtimeMs: null,
    },
    {
      id: 'loose-notes',
      name: 'loose-notes',
      dir: 'loose-notes',
      path: 'C:\\Users\\x\\.agents\\skills\\loose-notes',
      description: null,
      descriptionSource: 'none',
      hasSkillMd: false,
      files: 1,
      bytes: 128,
      bytesHuman: '128 B',
      mtimeMs: null,
    },
  ];
}

/** 一份 /state 应答里的 scheduleView。 */
function sampleScheduleView(over = {}) {
  return {
    description: '每天 03:00 · 保留 7 份',
    due: false,
    reason: 'not-yet',
    scheduledAt: null,
    nextRunAt: 1_760_500_000_000,
    state: {
      lastPointAt: 1_760_000_000_000,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      lastArchive: null,
      lastPruned: [],
      runCount: 0,
    },
    statePath: 'C:\\Users\\x\\.dsh\\backup-sync\\schedule.json',
    ...over,
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
    settings: {
      outDir: null,
      syncDir: null,
      allowDelete: false,
      includeBaseline: true,
      schedule: { enabled: false, mode: 'daily', at: '03:00', hours: 24, keep: 7, moduleIds: null, includeBaseline: true },
    },
    scheduleView: sampleScheduleView(),
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
  // M6 起入口搬进设置，客户端只剩「注册 settings.section」这一件事：
  // bundle 里唯一的 require 是平台种子词 react，所以 inject 必须为空 ——
  // 留着侧边栏/布局模块 id 会白送一层跨版本耦合（新内核若改了模块 id，
  // 这个插件就会 did not activate，进而触发「应用无法使用」致命恢复）。
  assert.deepEqual(client.inject, [], 'dsh.client.inject 必须为空：bundle 只 require react');
  assert.ok(
    !client.inject.some((id) => /sidebar|layout/u.test(id)),
    '入口已搬进设置，不许再声明侧边栏/布局模块依赖',
  );
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

test('★ apply 只注册 settings.section 一个槽位（入口从侧边栏搬进设置里）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  assert.deepEqual(calls.inject, ['settings.section']);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.register[0].options.name, 'settings.section');
});

test('★ 侧边栏那一格必须腾出来：不许再注册 sidebar.panellist / main', () => {
  // 用户明确要求：备份同步不是高频操作，占着左侧菜单最上面那一格是浪费，
  // 那一格要留给以后高频使用的插件入口。
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const names = calls.register.map((r) => r.options.name);
  assert.ok(!names.includes('sidebar.panellist'), '不能再注册侧边栏条目');
  assert.ok(!names.includes('main'), '不能再占用中栏面板位');
  assert.ok(!calls.inject.includes('sidebar.panellist'), '也不该再去等侧边栏槽位');
  assert.ok(!calls.inject.includes('main'), '也不该再去等中栏槽位');
});

test('settings.section 用 list 槽位的必需字段 id，label 是普通字符串', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const entry = calls.register.find((r) => r.options.name === 'settings.section');
  assert.ok(entry, '必须注册 settings.section');
  assert.equal(typeof entry.options.id, 'string', 'list 槽位必须给 id，否则 register 直接抛错');
  assert.equal(entry.options.id, 'backup-sync');
  assert.equal(typeof entry.options.order, 'number');
  assert.equal(entry.options.label, '备份同步');
  assert.equal(entry.options.locale, undefined, '不传 locale：没有注册对应字典时标签可能解析不到');
  assert.equal(typeof entry.component, 'function');
});

test('★ 分区排在所有内核分区之后（低频入口不跟账号/模型/插件抢前面的位置）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const entry = calls.register.find((r) => r.options.name === 'settings.section');
  // 内核自带：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20。
  // 设置左栏只有 188px 宽、9 个分区已经排满，新的低频入口应当排在后面。
  assert.ok(entry.options.order >= 21, `order=${entry.options.order} 排得太靠前`);
});

test('分区组件收到 { close } 也照常渲染（设置外壳会传 close 进来）', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const section = calls.register.find((r) => r.options.name === 'settings.section').component;
  for (const props of [{ close: () => {} }, { close: undefined }, {}]) {
    const tree = section(props);
    assert.equal(tree.props['data-dsh-backup-sync'], 'panel');
  }
});

test('面板渲染出六个模块卡片，对话卡片标注「本地专用 · 不上云」', () => {
  const { module } = loadBundle();
  const { ctx, calls } = makeFakeCtx();
  module.apply(ctx);

  const page = calls.register.find((r) => r.options.name === 'settings.section').component;
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
  const page = calls.register.find((r) => r.options.name === 'settings.section').component;
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

test('★ joinHint 按 Host 的实际分隔符拼路径提示（Windows 反斜杠 / Linux 正斜杠）', () => {
  // 真实教训：同一个 client.js 同时发给 Windows 与 Linux 的 Host。
  // 原先占位符硬编码 `${outDir}\\dsh-sync-…`，在 WSL 那台机器上渲染成
  // `/home/allen/dsh-backups-sync\dsh-sync-…` —— 混合分隔符，用户照着粘贴必失败。
  const I = internals();
  // Windows 风格目录 → 反斜杠
  assert.equal(I.joinHint('D:\\dsh-backups-sync', 'a.tar.gz'), 'D:\\dsh-backups-sync\\a.tar.gz');
  // Linux 风格目录 → 正斜杠
  assert.equal(I.joinHint('/home/allen/dsh-backups-sync', 'a.tar.gz'), '/home/allen/dsh-backups-sync/a.tar.gz');
  // 结尾多余的分隔符先剥掉再拼，避免出现 `//` 或 `\\`
  assert.equal(I.joinHint('/home/allen/out/', 'a.tar.gz'), '/home/allen/out/a.tar.gz');
  assert.equal(I.joinHint('D:\\out\\', 'a.tar.gz'), 'D:\\out\\a.tar.gz');
  // 有目录但两种风格都像（UNC `\\wsl$\\…`）→ 按反斜杠
  assert.equal(I.joinHint('\\\\wsl$\\Ubuntu\\home', 'a.tar.gz'), '\\\\wsl$\\Ubuntu\\home\\a.tar.gz');
  // Host 还没回答时不能拼出一个假的根路径，只给裸文件名
  assert.equal(I.joinHint(undefined, 'a.tar.gz'), 'a.tar.gz');
  assert.equal(I.joinHint('', 'a.tar.gz'), 'a.tar.gz');
  assert.equal(I.joinHint('   ', 'a.tar.gz'), 'a.tar.gz');
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

test('apply 会顺带注入样式，且仍然只注册那一个槽位', () => {
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
  assert.deepEqual(calls.register.map((r) => r.options.name), ['settings.section']);
});

test('★ 模块卡一列到底（设置分区只有 564px，两列会把说明文字挤成逐字换行）', () => {
  // 2026-10-15 用户实测后要求：**一列就好，不要两列**。
  // 真实数字：设置弹窗固定 800px 宽，左栏 188px，分区左右各 24px 内边距
  // → 内容宽 564px（实测面板 559px）。两列时每列约 268px，
  // 「profile 依赖清单（package.json / lock / .npmrc）」这种长说明会被折断成 `.npmr c`。
  // 一列之后卡片独占整行，说明文字按自然断点换行。
  const css = internals().PANEL_CSS;
  // 先把注释剥掉：注释里为了讲清原因会写出 @media/@container 字样，直接匹配原文会误判成规则。
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const grid = rules.match(/\.dbs-grid\{[^}]*\}/)?.[0];
  assert.ok(grid, '应当有 .dbs-grid 规则');
  assert.ok(
    /grid-template-columns:\s*(1fr|repeat\(1\s*,)/.test(grid),
    `网格必须是一列：${grid}`,
  );
  assert.ok(!/repeat\(\s*[2-9]/.test(grid), `不许再出现多列模板：${grid}`);
  assert.ok(!/minmax\(/.test(grid), `一列不需要 minmax 自适应列宽：${grid}`);

  // 一列与宽度无关，所以**整条容器查询链路一并撤掉**：
  // 留着 container-type 只会白送一个 `contain:layout` 陷阱（见下一条测试）。
  assert.ok(!/@container/.test(rules), '一列布局不该再用容器查询');
  assert.ok(!/container-type/.test(rules), '一列布局不该再声明查询容器');

  // 历史事故：折行一度写成视口媒体查询，而视口是 1920px，永远不命中。
  const viewportRules = rules.match(/@media[^{]*\{[^@]*\.dbs-grid/g) ?? [];
  assert.deepEqual(viewportRules, [], `网格不许依赖视口宽度折行：${viewportRules.join(' | ')}`);
});

test('★ 设置分区自己滚（外壳 .options 已是 overflow-y:auto），面板不能再套一层高度/滚动', () => {
  const css = internals().PANEL_CSS;
  const root = css.match(/\.dbs-root\{[^}]*\}/)?.[0];
  assert.ok(root, '应当有 .dbs-root 规则');
  assert.ok(!/height:\s*100%/.test(root), `height:100% 会在设置分区里套出第二层滚动条：${root}`);
  assert.ok(!/overflow-y:\s*auto/.test(root), `面板自己滚动会和外壳的滚动打架：${root}`);
});

test('★ 浮层必须留在页签容器外面（将来若再引入容器查询，contain:layout 会把 position:fixed 变成相对容器定位）', () => {
  const I = internals();
  const css = I.PANEL_CSS;

  // ① 这是**保险**而不是当下生效的约束：一列布局已经把 container-type 撤了，
  //    但结构上「浮层不能塞进页签容器」要一直成立 —— 一旦有人把 container-type
  //    加回页签容器，塞进去的浮层就会跟着内容滚、只盖住面板那一块。
  //    顺带把最危险的位置钉死：`.dbs-root` 上绝对不能有 container-type。
  const rootRule = css.match(/\.dbs-root\{[^}]*\}/)?.[0] ?? '';
  assert.ok(rootRule !== '', '应当有 .dbs-root 规则');
  assert.ok(!/container-type/.test(rootRule), `container-type 不能放在 .dbs-root 上：${rootRule}`);

  // ② 结构上也要成立：浮层是页签容器的兄弟，不是子孙。
  //    必须先展开函数组件 —— Overlay 的 className 写在组件内部，
  //    不展开的话整棵树里根本找不到 .dbs-overlay（假绿灯高发区）。
  const ui = { ...I.createInitialUiState(), confirmingBackup: true };
  const tree = expand(I.renderPanel(ui, {}));

  const overlays = findAll(tree, (n) => String(n.props?.className ?? '').includes('dbs-overlay'));
  assert.ok(overlays.length > 0, '前提：确认框应当渲染出一个浮层');

  const bodies = findAll(tree, (n) => n.props?.['data-dbs-tabbody'] !== undefined);
  assert.equal(bodies.length, 1, '应当只有一个页签内容容器');
  const inside = findAll(bodies[0], (n) => String(n.props?.className ?? '').includes('dbs-overlay'));
  assert.equal(inside.length, 0, '浮层不能放进页签容器里，否则 position:fixed 会相对它定位');
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

test('★ 备份页签必须有「重新统计」按钮 —— 面板只在挂载时取一次数，否则计数永远是旧的', () => {
  // 用户的工作流：改完磁盘上的技能/配置 → 切回「备份同步」想看清有几条要备份。
  // 面板此时不会重新请求，若没有手动刷新入口，汇总条显示的就是改之前的数字 ——
  // 而汇总条的整个意义就是「备份前看清有几条」。真机截图核对时发现缺这个入口。
  const ui = { ...initialUi(), loading: false, state: sampleState() };
  let called = 0;
  const tree = renderFull(ui, { refresh: () => { called += 1; } });
  const btn = buttonByText(tree, '重新统计');
  assert.equal(btn.length, 1, '备份页签应恰好一个「重新统计」按钮');
  btn[0].props.onClick();
  assert.equal(called, 1, '点「重新统计」必须真的触发刷新');
});

test('忙碌时「重新统计」也要禁用（避免并发请求互相盖掉结果）', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), busy: 'backup' };
  const tree = renderFull(ui, { refresh: () => {} });
  const btn = buttonByText(tree, '重新统计');
  assert.equal(btn[0].props.disabled, true);
  assert.equal(buttonByText(tree, '开始备份')[0].props.disabled, true);
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

test('展开某个模块能看到逐文件清单（含相对路径与体积），并且每一行都能点开看内容', () => {
  // 插件卡的「插件清单」与「文件清单」是两条独立链接，这里测的是后者。
  const ui = { ...initialUi(), loading: false, state: sampleState(), expanded: { 'plugins:files': true } };
  const opened = [];
  const tree = renderFull(ui, { openFile: (moduleId, relPath) => opened.push([moduleId, relPath]) });
  const text = textOf(tree);
  assert.ok(text.includes('收起文件'), '展开后按钮文案应变成「收起文件」');
  assert.ok(text.includes('package.json'), '应列出相对路径');
  assert.ok(text.includes('919 B'), '应列出体积');

  const rows = findAll(tree, (n) => n.type === 'li' && n.props['data-dbs-file'] === '1');
  assert.equal(rows.length, 2, '两行都要标成可点');
  assert.equal(rows[0].props.title, '点击查看内容：package.json', '悬停要提示这一行能点');
  rows[0].props.onClick();
  assert.deepStrictEqual(
    opened.map((x) => Array.from(x)),
    [['plugins', 'package.json']],
    '点击要把「哪个模块的哪个文件」原样传出去 —— 宿主的 /file 就是按这两个参数定位的',
  );
});

// ───────────────────────────────────────── 技能清单（展开技能卡）

/** 假定时器版的 clickGate：可以同步「让时间过去」，不用真的等 240ms。 */
function fakeGate(delayMs = 240) {
  const timers = [];
  const gate = internals().clickGate(delayMs, {
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1] !== undefined) timers[id - 1].cleared = true;
    },
  });
  const run = (t) => {
    if (t.cleared !== true) t.fn();
  };
  return { gate, timers, run };
}

test('技能卡展开后按「技能」分行：一行一个技能，显示文件数与体积，不再铺文件清单', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), expanded: { skills: true }, skills: sampleSkills() };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('收起技能'), '技能卡的展开按钮文案要说「技能」，不能说「文件」');
  assert.ok(text.includes('查看 10 个技能') === false, '展开后不该还写着「查看」');
  assert.ok(text.includes('cdp-browser-automation'), '要列出技能名');
  assert.ok(text.includes('2 个文件 · 3.0 KB'), '文件数与体积要一起给');
  assert.ok(text.includes('悬停看描述 · 单击查看详情 · 双击复制技能名'), '三种操作要教给用户');
  assert.ok(!text.includes('scripts/run.mjs'), '文件明细要收进弹窗，不铺在卡片上');
});

test('技能卡未展开时只给一个「查看 N 个技能」入口，且不主动去取清单', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState() };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('查看 10 个技能'), '计数要用宿主给的技能数（10），不是文件数');
  assert.ok(!text.includes('悬停看描述'), '没展开就不该有清单');
});

test('技能卡：清单还没取到 / 正在取 / 取失败 三种状态都要说清楚', () => {
  const base = { ...initialUi(), loading: false, state: sampleState(), expanded: { skills: true } };
  const idle = renderFull(base);
  assert.equal(findAll(idle, (n) => n.props?.['data-dbs-skills'] === 'idle').length, 1);
  assert.ok(textOf(idle).includes('展开后才会读取技能清单'));
  assert.equal(findAll(renderFull({ ...base, skillsLoading: true }), (n) => n.props?.['data-dbs-skills'] === 'loading').length, 1);
  const failedTree = renderFull({ ...base, skillsError: 'HTTP 500' });
  assert.equal(findAll(failedTree, (n) => n.props?.['data-dbs-skills'] === 'error').length, 1, '失败状态也要能被定位到');
  const failed = textOf(failedTree);
  assert.ok(failed.includes('技能清单读取失败'), '失败要有标题');
  assert.ok(failed.includes('HTTP 500'), '要带上宿主给的原因');
  assert.ok(failed.includes('备份时仍会照常打包'), '失败要说明不影响备份本身');
});

test('技能行：悬停出描述（title）；没有描述也不留空白', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), expanded: { skills: true }, skills: sampleSkills() };
  const rows = findAll(renderFull(ui), (n) => typeof n.props?.['data-dbs-skill'] === 'string');
  assert.equal(rows.length, 3, '三个技能三行');
  assert.equal(rows[0].props.title, '通过 DevTools 协议驱动一个已经在运行的 Chrome。');
  assert.equal(rows[1].props.title, 'cleaner', '只有标题的技能，悬停显示标题');
  assert.equal(rows[2].props.title, '（这个技能没有写描述）', '没有描述要明说，不能是空 tooltip');
  assert.equal(rows[2].props.className, 'dbs-skill');
});

test('技能行：缺 SKILL.md 要有徽标', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), expanded: { skills: true }, skills: sampleSkills() };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('缺 SKILL.md'), '缺入口文件的技能要能被一眼看出来');
});

test('技能行：单击延迟 240ms 才开弹窗（不延迟的话双击复制会先弹一个窗）', () => {
  const { gate, timers, run } = fakeGate();
  const fired = [];
  gate.click(() => fired.push('open'));
  assert.deepStrictEqual(fired, [], '单击不能立刻开弹窗');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 240);
  assert.equal(gate.pending(), true);
  run(timers[0]);
  assert.deepStrictEqual(fired, ['open']);
  assert.equal(gate.pending(), false, '定时器烧完要把句柄清掉，否则下一行就点不动了');
});

test('技能行：双击复制技能名，不会顺带开弹窗，之后还能正常单击', () => {
  const { gate, timers, run } = fakeGate();
  const fired = [];
  gate.click(() => fired.push('open')); // 第一次 click
  gate.click(() => fired.push('open')); // 第二次 click —— 取消待执行的单击
  gate.dblclick(); // 兜底
  timers.forEach(run);
  assert.deepStrictEqual(fired, [], '双击不该开弹窗');
  assert.equal(timers[0].cleared, true, '待执行的单击必须被取消');

  // 双击之后门要回到干净状态
  gate.click(() => fired.push('open'));
  timers.forEach(run);
  assert.deepStrictEqual(fired, ['open'], '双击之后再单击要能正常开弹窗');
});

test('技能行的 onClick / onDoubleClick 分别接到 skillClick / skillDblClick', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), expanded: { skills: true }, skills: sampleSkills() };
  const calls = [];
  const tree = renderFull(ui, {
    skillClick: (s) => calls.push(`click:${s.id}`),
    skillDblClick: (s) => calls.push(`dbl:${s.id}`),
  });
  const row = findAll(tree, (n) => n.props?.['data-dbs-skill'] === 'win-disk-cleaner')[0];
  row.props.onClick();
  row.props.onDoubleClick();
  assert.deepStrictEqual(calls, ['click:win-disk-cleaner', 'dbl:win-disk-cleaner']);
});

test('技能弹窗：给全名字/目录/文件数/入口文件/描述，并只列这个技能的文件', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), skill: sampleSkills()[0] };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('技能：cdp-browser-automation'));
  assert.ok(text.includes('C:\\Users\\x\\.agents\\skills\\cdp-browser-automation'), '目录要给绝对路径');
  assert.ok(text.includes('2 个文件 · 3.0 KB'));
  assert.ok(text.includes('有 SKILL.md'));
  assert.ok(text.includes('通过 DevTools 协议驱动一个已经在运行的 Chrome。'));
  assert.ok(text.includes('文件明细（2 个）'));
  assert.ok(text.includes('cdp-browser-automation/scripts/run.mjs'), '要列本技能的文件');
  assert.ok(!text.includes('win-disk-cleaner/SKILL.md'), '别的技能的文件不能混进来');
  assert.ok(text.includes('复制技能名'), '弹窗里也要能复制技能名');
});

test('技能弹窗：复制技能名的反馈只出现在技能区，不串到文件弹窗', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    skill: sampleSkills()[0],
    copyFeed: { skill: { ok: true, how: 'clipboard', label: 'cdp-browser-automation' } },
  };
  const tree = renderFull(ui);
  const feeds = findAll(tree, (n) => n.props?.['data-dbs-copyfeed'] === 'skill');
  assert.equal(feeds.length, 1);
  assert.ok(textOf(feeds[0]).includes('已复制技能名：cdp-browser-automation'));
  assert.equal(findAll(tree, (n) => n.props?.['data-dbs-copyfeed'] === 'file').length, 0);
});

// ───────────────────────────────────────── 插件清单（列出插件，不是只列清单文件）

/** 一份 /plugins 应答里的 plugins：五行覆盖「已启用 / 内置 / 仅依赖 / 未安装 / 本地目录」。 */
function samplePlugins() {
  return [
    {
      name: 'dsh-notify-me',
      title: '通知提醒',
      titleSource: 'zh',
      version: '1.5.3',
      spec: '^1.5.3',
      description: '审批、提问、回复完成时弹系统通知',
      kind: 'third-party',
      bundled: true,
      installed: true,
      local: false,
      dir: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\dsh-notify-me',
    },
    {
      name: '@deepseek-ai/dsh-base',
      title: 'Base bundle',
      titleSource: 'en',
      version: '0.2.0-rc.2',
      spec: null,
      description: null,
      kind: 'builtin',
      bundled: true,
      installed: false,
      local: false,
      dir: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai\\dsh-base',
    },
    {
      name: 'dsh-backup-sync',
      title: 'dsh-backup-sync',
      titleSource: 'name',
      version: '0.2.0',
      spec: 'link:D:/dsh-work/dsh-backup-sync',
      description: '把本机 DSH 配置与技能同步到另一台机器',
      kind: 'third-party',
      bundled: true,
      installed: true,
      local: true,
      dir: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\dsh-backup-sync',
    },
    {
      name: 'cosmokit',
      title: 'cosmokit',
      titleSource: 'name',
      version: '4.0.4',
      spec: '^4.0.4',
      description: null,
      kind: 'third-party',
      bundled: false,
      installed: true,
      local: false,
      dir: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\cosmokit',
    },
    {
      name: 'dsh-gone',
      title: 'dsh-gone',
      titleSource: 'name',
      version: null,
      spec: '^1.0.0',
      description: null,
      kind: 'third-party',
      bundled: true,
      installed: false,
      local: false,
      dir: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\dsh-gone',
    },
  ];
}

/** 一份 /plugins 应答里的元信息。 */
function samplePluginsMeta(over = {}) {
  return {
    profile: 'desktop',
    profileDir: 'C:\\Users\\x\\.dsh\\profiles\\desktop',
    bundles: ['@deepseek-ai/dsh-base', 'dsh-notify-me', 'dsh-backup-sync', 'dsh-gone'],
    totals: { all: 5, enabled: 4, thirdParty: 4, standalone: 3, missing: 1 },
    dependencyOnly: ['cosmokit'],
    orphans: [],
    ...over,
  };
}

/** 插件卡展开、清清单已取到的界面。 */
function pluginUi(over = {}) {
  return {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    expanded: { plugins: true },
    plugins: samplePlugins(),
    pluginsMeta: samplePluginsMeta(),
    ...over,
  };
}

test('★ 插件卡展开后列的是插件本身（名字 + 版本 + 状态），不是三个清单文件', () => {
  const text = textOf(renderFull(pluginUi()));
  assert.ok(text.includes('收起插件'), '展开按钮要换成「收起插件」');
  assert.ok(text.includes('通知提醒'), '要能看到插件在设置里显示的那个名字');
  assert.ok(text.includes('v1.5.3'), '版本要能看到');
  assert.ok(text.includes('悬停看说明 · 单击查看详情 · 双击复制插件名'), '三种操作要教给用户');
  assert.ok(text.includes('查看 2 个文件'), '文件清单是另一条链接，不能因为列了插件就消失');
  assert.ok(!text.includes('收起文件'), '文件清单没展开就不该显示它的收起按钮');
  assert.ok(!text.includes('pnpm-workspace.yaml'), '清单文件明细要留在文件链接里，不铺在插件行下面');
});

test('插件卡：清单还没取到时按钮说「列出插件」，不编一个数字出来', () => {
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: sampleState() }));
  assert.ok(text.includes('列出插件'), '没取到清单时只能说「列出插件」');
  assert.ok(!/列出 \d+ 个插件/.test(text), '数字要等真取到了才写');
  assert.ok(!text.includes('悬停看说明'), '没展开就不该有清单');
});

test('插件卡：清单取到后收起，按钮要带上真正的数量', () => {
  const text = textOf(renderFull({ ...pluginUi(), expanded: {} }));
  assert.ok(text.includes('列出 5 个插件'), '数量取宿主给的插件行数，不是文件数');
  assert.ok(!text.includes('收起插件'));
});

test('插件卡：三种状态都说清楚（没取 / 正在取 / 取失败），失败要能重试', () => {
  const base = { ...pluginUi(), plugins: null, pluginsMeta: null };
  const idle = renderFull(base);
  assert.equal(findAll(idle, (n) => n.props?.['data-dbs-plugins'] === 'idle').length, 1);
  assert.ok(textOf(idle).includes('展开后才会读取插件清单'));

  const loading = renderFull({ ...base, pluginsLoading: true });
  assert.equal(findAll(loading, (n) => n.props?.['data-dbs-plugins'] === 'loading').length, 1);
  assert.ok(textOf(loading).includes('正在读取插件清单'));

  const failedTree = renderFull({ ...base, pluginsError: 'HTTP 500' });
  assert.equal(findAll(failedTree, (n) => n.props?.['data-dbs-plugins'] === 'error').length, 1);
  const failed = textOf(failedTree);
  assert.ok(failed.includes('插件清单读取失败'), '失败要有标题');
  assert.ok(failed.includes('HTTP 500'), '要带上宿主给的原因');
  assert.ok(failed.includes('备份时仍会照常打包'), '失败要说明不影响备份本身');
  assert.ok(buttonByText(failedTree, '重试') !== null, '失败要能当场重试');
});

test('插件行：徽标要能一眼分出「已启用 / 仅依赖 / 未安装 / 内置 / 本地目录」', () => {
  const tree = renderFull(pluginUi());
  const rows = findAll(tree, (n) => typeof n.props?.['data-dbs-plugin'] === 'string');
  assert.equal(rows.length, 5, '五行插件');
  const byName = (name) => textOf(rows.find((r) => r.props['data-dbs-plugin'] === name));

  const notify = byName('dsh-notify-me');
  assert.ok(notify.includes('通知提醒'));
  assert.ok(notify.includes('dsh-notify-me'), '标题来自语言文件时要同时给出包名，用户才能和 npm / 清单对上');
  assert.ok(notify.includes('v1.5.3'));
  assert.ok(notify.includes('已启用'));
  assert.ok(!notify.includes('仅依赖') && !notify.includes('未安装'));

  assert.ok(byName('@deepseek-ai/dsh-base').includes('内置'), '内置 bundle 要标出来（它不在 profile 的 node_modules 里）');
  assert.ok(
    byName('@deepseek-ai/dsh-base').includes('随内核提供'),
    '内置 bundle 读不到版本是正常的，要说「随内核提供」，不能说「未安装」',
  );
  assert.ok(
    !byName('@deepseek-ai/dsh-base').includes('未安装'),
    '内置 bundle 本来就不在 profile 的 node_modules 里 —— 标成「未安装」会让每一台好机器都像坏了',
  );

  assert.ok(byName('cosmokit').includes('仅依赖'), '只在 dependencies 里的包宿主不会挂载');
  assert.ok(byName('dsh-backup-sync').includes('本地目录'), 'link: 装的是本机目录，换机不能照搬');
  assert.ok(byName('dsh-gone').includes('未安装'), 'bundles 里声明了但没装上');
});

test('插件行：悬停出说明；没有说明也不留空白', () => {
  const tree = renderFull(pluginUi());
  const rows = findAll(tree, (n) => typeof n.props?.['data-dbs-plugin'] === 'string');
  const tip = (name) => rows.find((r) => r.props['data-dbs-plugin'] === name).props.title;
  assert.equal(tip('dsh-notify-me'), '审批、提问、回复完成时弹系统通知');
  assert.equal(tip('dsh-gone'), '（这个插件没有写说明）', '没有说明要明说，不能是空 tooltip');
  assert.equal(rows.find((r) => r.props['data-dbs-plugin'] === 'cosmokit').props.className, 'dbs-skill');
});

test('插件卡：合计与两条提醒（仅依赖 / 装了但没写进清单）都要给', () => {
  const text = textOf(renderFull(pluginUi()));
  assert.ok(text.includes('4 个已启用'), '合计取 totals.enabled');
  assert.ok(text.includes('共 5 个'));
  assert.ok(text.includes('1 个声明了但没装上'), '缺包数量要说出来（只数第三方，内置 bundle 不算缺）');
  assert.ok(text.includes('C:\\Users\\x\\.dsh\\profiles\\desktop'), '配置目录要给绝对路径，方便对照');
  assert.ok(text.includes('另有 1 个包只是依赖'), '仅在 dependencies 里的要单独提一句');
  assert.ok(text.includes('cosmokit'));

  const orphan = textOf(
    renderFull(pluginUi({ pluginsMeta: samplePluginsMeta({ orphans: ['dsh-leftover'] }) })),
  );
  assert.ok(orphan.includes('node_modules 里有 1 个 DSH 插件没写进清单'), '装了但清单里没声明的要点名');
  assert.ok(orphan.includes('dsh-leftover'));
});

test('插件行的 onClick / onDoubleClick 分别接到 pluginClick / pluginDblClick', () => {
  const calls = [];
  const tree = renderFull(pluginUi(), {
    pluginClick: (p) => calls.push(`click:${p.name}`),
    pluginDblClick: (p) => calls.push(`dbl:${p.name}`),
  });
  const row = findAll(tree, (n) => n.props?.['data-dbs-plugin'] === 'dsh-notify-me')[0];
  row.props.onClick();
  row.props.onDoubleClick();
  assert.deepStrictEqual(calls, ['click:dsh-notify-me', 'dbl:dsh-notify-me']);
});

test('插件弹窗：包名 / 版本 / 来源 / 是否启用 / 装在哪 / 说明，并只列这个插件的字段', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), plugin: samplePlugins()[0] };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('插件：通知提醒'));
  assert.ok(text.includes('dsh-notify-me'));
  assert.ok(text.includes('1.5.3'));
  assert.ok(text.includes('^1.5.3'), '依赖里写的范围也要给，方便对照清单');
  assert.ok(text.includes('已启用（在 profile 的 bundles 里，宿主会挂载它）'));
  assert.ok(text.includes('C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\dsh-notify-me'), '安装位置要给绝对路径');
  assert.ok(text.includes('审批、提问、回复完成时弹系统通知'));
  assert.ok(text.includes('复制插件名'), '弹窗里也要能复制插件名');
  assert.ok(text.includes('从 npm 装') === false, '不要写没根据的来源');
});

test('插件弹窗：没装上的插件要说清后果，不能只说一句「没装」', () => {
  const gone = samplePlugins().find((p) => p.name === 'dsh-gone');
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: sampleState(), plugin: gone }));
  assert.ok(text.includes('未安装（bundles 里声明了，但这台机器上没有它）'));
  assert.ok(text.includes('依赖没装上'), '要说清后果：这个插件此刻是关着的');
});

test('插件弹窗：内置 bundle 读不到版本不算异常，别吓唬用户说「没装上」', () => {
  const base = samplePlugins().find((p) => p.name === '@deepseek-ai/dsh-base');
  const text = textOf(renderFull({ ...initialUi(), loading: false, state: sampleState(), plugin: base }));
  assert.ok(text.includes('随内核提供'), '状态要说明它由内核挂载');
  assert.ok(text.includes('DSH 内置 bundle（随内核走）'), '类型一行照旧');
  assert.ok(!text.includes('依赖没装上'), '内置 bundle 不在 node_modules 是设计如此，不能报成依赖没装上');
  assert.ok(!text.includes('这台机器上没有它'));
});

test('插件弹窗：复制插件名的反馈只出现在插件区，不串到技能 / 文件弹窗', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    plugin: samplePlugins()[0],
    copyFeed: { plugin: { ok: true, how: 'clipboard', label: 'dsh-notify-me' } },
  };
  const tree = renderFull(ui);
  const feeds = findAll(tree, (n) => n.props?.['data-dbs-copyfeed'] === 'plugin');
  assert.equal(feeds.length, 1);
  assert.ok(textOf(feeds[0]).includes('已复制插件名：dsh-notify-me'));
  assert.equal(findAll(tree, (n) => n.props?.['data-dbs-copyfeed'] === 'skill').length, 0);
});

test('插件卡：文件清单是独立的一条链接，能单独展开（插件行与文件行互不遮挡）', () => {
  const text = textOf(renderFull({ ...pluginUi(), expanded: { 'plugins:files': true } }));
  assert.ok(text.includes('收起文件'), '文件清单自己也有展开态');
  assert.ok(text.includes('列出 5 个插件'), '文件清单展开时插件清单仍是收起的');
  assert.ok(text.includes('pnpm-lock.yaml'), '文件明细还在原处，能逐条点开');
  assert.ok(!text.includes('悬停看说明'), '两个清单不互相带出');
});

// ───────────────────────────────────────── 文件内容弹窗

const FILE_VIEW_OK = {
  viewable: true,
  reason: null,
  guard: null,
  moduleId: 'config',
  relPath: 'settings.yaml',
  absPath: 'C:\\Users\\x\\.dsh\\settings.yaml',
  bytes: 5,
  mtimeMs: 1_760_000_000_000,
  text: 'a: 1\n',
  truncated: false,
  binary: false,
};

test('文件弹窗：能看就显示内容，并给「复制内容」按钮', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), file: { moduleId: 'config', relPath: 'settings.yaml' }, fileView: FILE_VIEW_OK };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('查看文件'));
  assert.ok(text.includes('C:\\Users\\x\\.dsh\\settings.yaml'), '要显示真实绝对路径');
  assert.ok(text.includes('5 B（5 字节）'), '字节数要给，方便判断是不是读全了');
  const pre = findAll(tree, (n) => n.props?.['data-dbs-filetext'] === '1');
  assert.equal(pre.length, 1);
  assert.deepStrictEqual(Array.from(pre[0].children), ['a: 1\n'], '内容要原样渲染');
  assert.ok(buttonByText(tree, '复制内容').length === 1);
});

test('文件弹窗：被安全闸拦下时不显示内容，只给原因和脱敏片段', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    file: { moduleId: 'plugins', relPath: '.npmrc' },
    fileView: {
      viewable: false,
      reason: '内容像凭据（疑似 npm token），已拒绝显示。',
      guard: { id: '内容闸', excerpt: 'npm_Ab…UV' },
      moduleId: 'plugins',
      relPath: '.npmrc',
      absPath: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\.npmrc',
      bytes: 54,
      mtimeMs: null,
      text: null,
      truncated: false,
      binary: false,
    },
  };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('这个文件不能在这里查看'));
  assert.ok(text.includes('内容像凭据'), '要给出宿主的原因');
  assert.ok(text.includes('内容闸') && text.includes('npm_Ab…UV'), '要给脱敏后的片段');
  assert.equal(findAll(tree, (n) => n.props?.['data-dbs-filetext'] === '1').length, 0, '被拦下时绝不能渲染内容');
  assert.equal(buttonByText(tree, '复制内容').length, 0, '被拦下时不给复制按钮');
  assert.equal(buttonByText(tree, '关闭').length, 1, '但一定要能关掉');
});

test('文件弹窗：截断要明说，别让用户以为文件就这么长', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    file: { moduleId: 'config', relPath: 'AGENTS.md' },
    fileView: { ...FILE_VIEW_OK, relPath: 'AGENTS.md', bytes: 900_000, truncated: true, text: '# 全局约定\n' },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('文件太大，只显示了开头'));
  assert.ok(text.includes('最多显示 512 KB'));
  assert.ok(text.includes('878.9 KB'), '要报出完整文件多大');
});

test('文件弹窗：二进制文件要提醒内容可能没意义', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    file: { moduleId: 'skills', relPath: 'x/blob.bin' },
    fileView: { ...FILE_VIEW_OK, moduleId: 'skills', relPath: 'x/blob.bin', binary: true, text: 'PK\u0003\u0004' },
  };
  assert.ok(textOf(renderFull(ui)).includes('看着是二进制'));
});

test('文件弹窗：还没答话时显示「正在读取…」，失败时把原因留在弹窗里', () => {
  const base = { ...initialUi(), loading: false, state: sampleState(), file: { moduleId: 'config', relPath: 'settings.yaml' } };
  assert.ok(textOf(renderFull(base)).includes('正在读取'));
  const failed = textOf(renderFull({ ...base, fileError: '会话已过期（HTTP 401）' }));
  assert.ok(failed.includes('读不出来'));
  assert.ok(failed.includes('会话已过期'));
});

test('文件弹窗：复制内容的反馈只出现在文件弹窗', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    file: { moduleId: 'config', relPath: 'settings.yaml' },
    fileView: FILE_VIEW_OK,
    copyFeed: { file: { ok: true, how: 'clipboard', label: '5 个字符' } },
  };
  const tree = renderFull(ui);
  const feeds = findAll(tree, (n) => n.props?.['data-dbs-copyfeed'] === 'file');
  assert.equal(feeds.length, 1);
  assert.ok(textOf(feeds[0]).includes('已复制文件内容：5 个字符'));
});

// ───────────────────────────────────────── 定时备份

test('定时备份：默认关闭，只给开关和一行摘要，不铺表单', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState() };
  const tree = renderFull(ui);
  const card = findAll(tree, (n) => n.props?.['data-dbs-sched'] === '1');
  assert.equal(card.length, 1, '备份页要有定时备份卡片');
  const text = textOf(card[0]);
  assert.ok(text.includes('定时备份'));
  assert.ok(text.includes('已关闭 · 保留 7 份'), '摘要要说清当前是关的、保留几份');
  assert.ok(!text.includes('下次运行'), '没开就不该显示下次运行时间');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-sched-enabled').length, 1);
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-sched-mode').length, 0);
});

test('定时备份：开关默认不勾选', () => {
  const tree = renderFull({ ...initialUi(), loading: false, state: sampleState() });
  const box = findAll(tree, (n) => n.props?.id === 'dbs-sched-enabled')[0];
  assert.equal(box.props.type, 'checkbox');
  assert.equal(box.props.checked, false, '定时备份必须默认关闭 —— 无人值守地自动写盘不能是默认行为');
});

test('定时备份：开启后给频率/时间/保留份数/下次运行/上次结果/两个按钮', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    sched: { enabled: true, mode: 'daily', at: '03:00', hours: 24, keep: 7 },
    schedView: sampleScheduleView({ nextRunAt: new Date(2026, 9, 15, 3, 0, 0).getTime() }),
  };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('每天 03:00 · 保留 7 份'));
  assert.ok(text.includes('下次运行：') && text.includes('2026-10-15 03:00'), '开启后必须显示下次运行时间');
  assert.ok(text.includes('上次运行：还没跑过'));
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-sched-mode').length, 1);
  const at = findAll(tree, (n) => n.props?.id === 'dbs-sched-at')[0];
  assert.equal(at.props.type, 'time');
  assert.equal(at.props.value, '03:00');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-sched-keep').length, 1);
  assert.equal(buttonByText(tree, '保存定时设置').length, 1);
  assert.equal(buttonByText(tree, '立即跑一次').length, 1);
});

test('★ 定时备份：取消勾选后仍然给得出「保存定时设置」——否则「关掉」这件事根本存不下去', () => {
  // 真机驱动 step15 抓到的：关闭态原来只渲染一句说明，保存按钮在开启分支里，
  // 于是一取消勾选，表单连同保存按钮一起消失，用户点不到任何按钮。
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    sched: { enabled: false, mode: 'interval', at: '03:00', hours: 6, keep: 3, moduleIds: null },
    schedDirty: true,
  };
  const tree = renderFull(ui);
  assert.equal(buttonByText(tree, '保存定时设置').length, 1, '关闭 + 有未保存改动时必须给保存按钮');
  assert.equal(buttonByText(tree, '立即跑一次').length, 0, '关着的时候不铺「立即跑一次」，免得和备份页签的按钮重复');
  assert.ok(textOf(tree).includes('有改动还没保存'));
  assert.equal(findAll(tree, (n) => n.props?.['data-dbs-sched-dirty'] === '1').length, 1);
});

test('定时备份：关闭且无改动时不铺按钮（默认状态保持干净）', () => {
  const tree = renderFull({ ...initialUi(), loading: false, state: sampleState() });
  assert.equal(buttonByText(tree, '保存定时设置').length, 0);
  assert.equal(findAll(tree, (n) => n.props?.['data-dbs-sched-dirty'] === '1').length, 0);
});

test('★ 备份选项：基线开关与输出目录必须有稳定定位（否则验收脚本会点到定时备份开关上）', () => {
  // 2026-10-14 真机上踩到：验收脚本按「模块卡之外的第一个勾选框」找基线开关，
  // M5 加了定时备份卡片之后抓到的是 #dbs-sched-enabled，于是基线从没被关掉，
  // 包里的 baselineIncluded 一直是 true。凡是「脚本要点的控件」都必须能唯一定位。
  const tree = renderFull({ ...initialUi(), loading: false, state: sampleState() });
  const baseline = findAll(tree, (n) => n.props?.id === 'dbs-include-baseline');
  assert.equal(baseline.length, 1, '基线开关要有 id=dbs-include-baseline');
  assert.equal(baseline[0].props['data-dbs-baseline'], '1', '并带 data-dbs-baseline 便于定位');
  assert.equal(baseline[0].props.type, 'checkbox');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-outdir').length, 1, '输出目录输入框要有 id');
});

test('定时备份：改成「每隔」时给小时选择，并如实显示间隔', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    sched: { enabled: true, mode: 'interval', at: '03:00', hours: 6, keep: 3 },
  };
  const tree = renderFull(ui);
  assert.ok(textOf(tree).includes('每隔 6 小时 · 保留 3 份'));
  const hours = findAll(tree, (n) => n.props?.id === 'dbs-sched-hours')[0];
  assert.equal(hours.props.value, '6');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-sched-at').length, 0, '按间隔跑就不该再要一个时间点');
});

test('定时备份：备份范围要照实说 —— 不固定时用的是各模块默认勾选，不是上面手动的勾选', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), sched: { enabled: true, mode: 'daily', at: '03:00', keep: 7, moduleIds: null } };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('技能、插件、配置、记忆、待办（各模块的默认勾选）'), '要说清默认范围是哪几个模块');
  assert.ok(text.includes('固定用上面勾选的模块'), '要给一个把范围钉死的开关');
  const pin = findAll(tree, (n) => n.props?.id === 'dbs-sched-pin')[0];
  assert.equal(pin.props.checked, false, '默认不固定');
  assert.ok(text.includes('「对话」永远不会进定时包'), '这是无人值守场景的硬闸，必须在界面上写明');
  assert.ok(text.includes('那一刻 DSH 没开就跳过，不补跑，也不重试'), '要写明不做补跑');
  assert.ok(text.includes('只删自己打的包'), '清理旧包的边界要说清');
});

test('定时备份：固定范围后按勾选列出模块，并允许取消固定', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    sched: { enabled: true, mode: 'daily', at: '03:00', keep: 7, moduleIds: ['skills', 'memory'] },
  };
  const tree = renderFull(ui);
  assert.ok(textOf(tree).includes('技能、记忆'), '固定的范围要按名字列出来');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-sched-pin')[0].props.checked, true);
  const none = renderFull({ ...ui, sched: { ...ui.sched, moduleIds: [] } });
  assert.ok(textOf(none).includes('一个模块都没选'), '空范围要如实预警，而不是假装会打包');
});

test('scheduleScopeText：三种形态', () => {
  const f = internals().scheduleScopeText;
  assert.ok(f({ moduleIds: null }).includes('默认勾选'));
  assert.equal(f({ moduleIds: ['skills', 'todo'] }), '技能、待办');
  assert.ok(f({ moduleIds: [] }).includes('一个模块都没选'));
  assert.equal(f({ moduleIds: ['weird'] }), 'weird', '认不出的 id 也要显示出来，不能悄悄吞掉');
});

test('★ schedulePatch：只发改动过的键（否则「只改保留份数」会被当成改了频率、锚点被推到现在）', () => {
  const f = internals().schedulePatch;
  const saved = {
    enabled: true,
    mode: 'daily',
    at: '03:00',
    hours: 24,
    keep: 7,
    moduleIds: null,
    includeBaseline: true,
  };

  // ① 只改保留份数 → body 里**只能有 keep**（一个计时键都不许出现）
  const keepOnly = f(saved, { ...saved, keep: 3 });
  assert.deepStrictEqual({ ...keepOnly }, { keep: 3 });

  // ② 计时字段变了就要发出去
  const timing = f(saved, { ...saved, mode: 'interval', hours: 6 });
  assert.deepStrictEqual({ ...timing }, { mode: 'interval', hours: 6 });

  // ③ 关掉定时：enabled 是计时键，必须发
  assert.deepStrictEqual({ ...f(saved, { ...saved, enabled: false }) }, { enabled: false });

  // ④ 完全没改 → 空对象（调用方据此直接清掉「未保存」提示，不发请求）
  assert.deepStrictEqual({ ...f(saved, { ...saved }) }, {});

  // ⑤ moduleIds 是数组，要按内容比（引用不同但内容相同 = 没改）
  assert.deepStrictEqual({ ...f(saved, { ...saved, moduleIds: null }) }, {});
  assert.deepStrictEqual({ ...f({ ...saved, moduleIds: ['skills'] }, { ...saved, moduleIds: ['skills'] }) }, {});
  assert.deepStrictEqual({ ...f({ ...saved, moduleIds: ['skills'] }, { ...saved, moduleIds: ['todo'] }) }, { moduleIds: ['todo'] });

  // ⑥ includeBaseline 缺省视为 true（与 normalizeSchedule 同口径），不许因为 undefined 就误发
  assert.deepStrictEqual({ ...f({ ...saved, includeBaseline: undefined }, { ...saved, includeBaseline: true }) }, {});
  assert.deepStrictEqual({ ...f(saved, { ...saved, includeBaseline: false }) }, { includeBaseline: false });

  // ⑦ 宿主还没给出 schedule（旧宿主/未重启）时，以默认表单为基线，改动照样发得出去
  assert.deepStrictEqual({ ...f(internals().DEFAULT_SCHEDULE_FORM, { ...internals().DEFAULT_SCHEDULE_FORM, keep: 5 }) }, { keep: 5 });
});

test('定时备份：表单有改动没保存要提示', () => {
  const base = { ...initialUi(), loading: false, state: sampleState(), sched: { enabled: true, mode: 'daily', at: '03:00', keep: 7 } };
  assert.equal(findAll(renderFull(base), (n) => n.props?.['data-dbs-sched-dirty'] === '1').length, 0);
  const dirty = renderFull({ ...base, schedDirty: true });
  assert.ok(textOf(dirty).includes('有改动还没保存'));
});

test('定时备份：保留 0 份要说「不清理」，不能显示「保留 0 份」', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), sched: { enabled: true, mode: 'daily', at: '03:00', keep: 0 } };
  const tree = renderFull(ui);
  assert.ok(textOf(tree).includes('不清理旧包'));
  const keep = findAll(tree, (n) => n.props?.id === 'dbs-sched-keep')[0];
  const labels = (keep.children ?? []).map((o) => textOf(o));
  assert.ok(labels.includes('不清理'), '0 要显示成「不清理」');
});

test('定时备份：「立即跑一次」的结果分「跑成功」和「没打包」两种说法', () => {
  const base = { ...initialUi(), loading: false, state: sampleState(), sched: { enabled: true, mode: 'daily', at: '03:00', keep: 7 } };
  const ok = textOf(
    renderFull({
      ...base,
      schedRun: {
        ran: true,
        archive: { name: 'dsh-sync-20261014-100000.tar.gz', bytesHuman: '190.0 KB', totals: { files: 50 } },
        pruned: ['dsh-sync-20261001-030000.tar.gz'],
      },
    }),
  );
  assert.ok(ok.includes('定时备份已执行'));
  assert.ok(ok.includes('dsh-sync-20261014-100000.tar.gz'));
  assert.ok(ok.includes('1 份'), '清理了几份要说出来');

  const no = textOf(renderFull({ ...base, schedRun: { ran: false, reason: 'failed', error: '定时备份没有可打包的模块' } }));
  assert.ok(no.includes('这次没有打包'));
  assert.ok(no.includes('定时备份没有可打包的模块'));
});

test('定时备份：宿主还没答话时卡片不空白', () => {
  const ui = { ...initialUi(), loading: true, state: null };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('定时备份') && text.includes('正在读取'));
});

test('定时备份：宿主是老版本（settings 里没有 schedule）也要能渲染出可用的表单', () => {
  // 插件升级后、DSH 还没重启时就是这个状态：宿主半边还是旧的。
  // 卡在「正在读取…」会让人以为功能坏了；给默认表单 + 保存时照实报错才是诚实的。
  const ui = { ...initialUi(), loading: false, state: sampleState({ settings: { outDir: null, syncDir: null, allowDelete: false, includeBaseline: true } }) };
  const text = textOf(renderFull(ui));
  assert.ok(!text.includes('正在读取'), '不能卡在读取中');
  assert.ok(text.includes('已关闭 · 保留 7 份'), '要用客户端默认值渲染出摘要');
  const box = findAll(renderFull(ui), (n) => n.props?.id === 'dbs-sched-enabled')[0];
  assert.equal(box.props.checked, false, '兜底表单也必须是关闭状态');
});

// ───────────────────────────────────────── 新纯函数

test('formatWhen：固定本地格式，无效值给破折号', () => {
  assert.equal(internals().formatWhen(new Date(2026, 9, 13, 18, 6, 57).getTime()), '2026-10-13 18:06');
  assert.equal(internals().formatWhen(new Date(2026, 0, 5, 3, 0, 0).getTime()), '2026-01-05 03:00');
  assert.equal(internals().formatWhen(null), '—');
  assert.equal(internals().formatWhen(0), '—');
  assert.equal(internals().formatWhen('2026-10-13'), '—');
});

test('scheduleSummary：四种形态', () => {
  const f = internals().scheduleSummary;
  assert.equal(f({ enabled: false, keep: 7 }), '已关闭 · 保留 7 份');
  assert.equal(f({ enabled: true, mode: 'daily', at: '03:00', keep: 7 }), '每天 03:00 · 保留 7 份');
  assert.equal(f({ enabled: true, mode: 'interval', hours: 6, keep: 3 }), '每隔 6 小时 · 保留 3 份');
  assert.equal(f({ enabled: true, mode: 'interval', hours: 48, keep: 0 }), '每隔 2 天 · 不清理旧包');
  assert.equal(f(null), '未配置');
});

test('scheduleReasonText：把人话给全，不要甩机器码', () => {
  const f = internals().scheduleReasonText;
  assert.ok(f({ due: true, reason: 'due' }).includes('已到点'));
  assert.equal(f({ due: false, reason: 'disabled' }), '定时备份已关闭');
  assert.equal(f({ due: false, reason: 'not-yet' }), '还没到点');
  assert.equal(f({ due: false, reason: 'already-ran' }), '这一次已经跑过了');
  assert.ok(f({ due: false, reason: 'missed' }).includes('不补跑'));
  assert.ok(f({ due: false, reason: 'anchored' }).includes('重新计时'));
  assert.equal(f(null), '');
  assert.equal(f({ due: false, reason: 'weird' }), 'weird');
});

test('scheduleLastText：没跑过 / 跑过 / 失败', () => {
  const f = internals().scheduleLastText;
  assert.equal(f({ state: {} }), '还没跑过');
  assert.equal(f(null), '还没跑过');
  const ran = f({
    state: {
      lastRunAt: new Date(2026, 9, 14, 3, 0, 0).getTime(),
      lastArchive: 'dsh-sync-20261014-030000.tar.gz',
      lastResult: { totals: { files: 50 }, bytesHuman: '190.0 KB' },
    },
  });
  assert.equal(ran, '2026-10-14 03:00 · dsh-sync-20261014-030000.tar.gz · 50 个文件 · 190.0 KB');
  assert.ok(f({ state: { lastError: '磁盘满了' } }).includes('上次失败：磁盘满了'));
});

test('copyLine：成功 / 空内容 / 剪贴板被拒 三种说法分开', () => {
  const f = internals().copyLine;
  assert.equal(f(null, '技能名'), null);
  const ok = f({ ok: true, how: 'clipboard', label: 'cdp' }, '技能名');
  assert.equal(ok.tone, 'good');
  assert.equal(ok.text, '已复制技能名：cdp');
  assert.ok(f({ ok: true, how: 'execCommand', label: 'cdp' }, '技能名').text.includes('兜底通道'));
  assert.ok(f({ ok: false, how: 'empty' }, '技能名').text.includes('内容为空'));
  assert.ok(f({ ok: false, how: 'failed' }, '技能名').text.includes('拒绝了剪贴板写入'));
  assert.ok(f({ ok: false, how: 'failed' }, '技能名').text.includes('Ctrl+C'), '失败要给出下一步动作');
});

test('skillFiles：只筛这个技能目录下的文件', () => {
  const f = internals().skillFiles;
  const ui = { state: sampleState() };
  assert.deepStrictEqual(
    Array.from(f(ui, { id: 'cdp-browser-automation' })).map((e) => e.relPath),
    ['cdp-browser-automation/SKILL.md', 'cdp-browser-automation/scripts/run.mjs'],
  );
  assert.equal(f(ui, { id: 'win-disk-cleaner' }).length, 1);
  assert.equal(f(ui, { id: 'nope' }).length, 0, '不存在的技能不能退化成「全部文件」');
  assert.equal(f({ state: null }, { id: 'x' }).length, 0);
});

test('skillMeta / skillTooltip / fileSizeText 的兜底', () => {
  const I = internals();
  assert.equal(I.skillMeta({ files: 3, bytesHuman: '1.0 KB' }), '3 个文件 · 1.0 KB');
  assert.equal(I.skillMeta({ files: 3, bytes: 2048 }), '3 个文件 · 2.0 KB', '没有 bytesHuman 就自己算');
  assert.equal(I.skillMeta(null), '0 个文件 · —');
  assert.equal(I.skillTooltip({ description: '  有描述  ' }), '有描述');
  assert.equal(I.skillTooltip({ description: '   ' }), '（这个技能没有写描述）');
  assert.equal(I.skillMissingBadge({ hasSkillMd: true }), null);
  assert.equal(I.skillMissingBadge({ hasSkillMd: false }), '缺 SKILL.md');
  assert.equal(I.fileSizeText({ bytes: 1536 }), '1.5 KB（1536 字节）');
  assert.equal(I.fileSizeText({}), '—');
});

test('fileRowLabel：路径缺失时不渲染成空白行', () => {
  assert.equal(internals().fileRowLabel({ relPath: 'package.json' }), 'package.json');
  assert.equal(internals().fileRowLabel({}), '（路径未知）');
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

// ─────────────────────────── 导入页签：把云端（WebDAV）的包也列进「备份包」

/** 云端列目录的一份包 —— 形状与 `/cloud/list` 的 files 一致。 */
function sampleCloudFile(over = {}) {
  return {
    name: 'dsh-sync-20261015-210000.tar.gz',
    bytes: 181_900,
    bytesHuman: '177.6 KB',
    mtimeMs: 1_762_000_000_000,
    mtimeLocal: '2026-10-15 21:00:04',
    isOwn: true,
    localExists: false,
    localBytes: null,
    localSha256: null,
    remoteNewer: true,
    ...over,
  };
}

/** 导入页签里那个「备份包」下拉。 */
function importSelect(tree) {
  return findAll(tree, (n) => n.type === 'select')[0];
}

test('★ 导入下拉：云端那几份也列出来，分「本机 / 云端」两组，云端项的值带 cloud: 前缀', () => {
  const local = [
    { name: 'dsh-sync-20261017-103937.tar.gz', path: 'D:\\b\\dsh-sync-20261017-103937.tar.gz', bytesHuman: '181 KB', mtimeLocal: '2026-10-17 10:39:37' },
  ];
  const ui = {
    ...initialUi(),
    loading: false,
    tab: 'import',
    state: sampleState({ archives: local }),
    importCloud: {
      ok: true,
      url: 'http://100.66.1.1:5005/',
      remoteDir: 'dsh-backup',
      dirMissing: false,
      files: [
        sampleCloudFile({ name: 'dsh-sync-20261015-180337.tar.gz', mtimeLocal: '2026-10-15 18:03:37', localExists: true }),
        sampleCloudFile({ name: 'dsh-sync-20261013-192512.tar.gz', mtimeLocal: '2026-10-13 19:25:12' }),
      ],
    },
  };
  const tree = renderFull(ui);
  const select = importSelect(tree);
  assert.ok(select, '有云端包时必须有下拉');

  const groups = findAll(select, (n) => n.type === 'optgroup');
  assert.deepEqual(groups.map((g) => g.props.label), ['本机', '云端（WebDAV）']);

  const byValue = new Map(
    findAll(select, (n) => n.type === 'option').map((o) => [o.props.value, textOf(o)]),
  );
  // 本机那组的值仍是裸包名 —— 历史版本页的「导入」按钮直接拿包名，不能变。
  assert.ok(byValue.has('dsh-sync-20261017-103937.tar.gz'), `本机项的值要保留裸包名，实得：${[...byValue.keys()]}`);
  assert.ok(byValue.has('cloud:dsh-sync-20261015-180337.tar.gz'), '云端项要带 cloud: 前缀，避免与本机同名包撞值');
  assert.ok(byValue.get('cloud:dsh-sync-20261015-180337.tar.gz').includes('本机已有'), '本机已经有一份要说清');
  assert.ok(byValue.get('cloud:dsh-sync-20261013-192512.tar.gz').includes('本机没有'), '本机没有的也要说清');
  assert.ok(byValue.get('cloud:dsh-sync-20261013-192512.tar.gz').includes('2026-10-13 19:25:12'), '时间要显示');
});

test('★ 导入下拉：本机一份都没有时也要给下拉 —— 换机场景就是「本地空、云端有」', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    tab: 'import',
    state: sampleState({ archives: [] }),
    importCloud: { ok: true, dirMissing: false, files: [sampleCloudFile()] },
  };
  const text = textOf(renderFull(ui));
  assert.ok(importSelect(renderFull(ui)), '云端有包就必须渲染下拉，不能退化成「没有包」提示');
  assert.ok(text.includes('本机备份目录里还没有包'), `要说清本机是空的，实得：${text}`);
  assert.ok(!text.includes('备份目录里没有包，可在下面直接填一个包的绝对路径'), '云端有包时说「没有包」是错的');
});

test('导入下拉：选了云端那份，「分析差异」就该能点', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    tab: 'import',
    state: sampleState({ archives: [] }),
    importCloud: { ok: true, files: [sampleCloudFile()] },
    importSource: 'cloud:dsh-sync-20261015-210000.tar.gz',
  };
  const go = buttonByText(renderFull(ui), '分析差异');
  assert.equal(go.length, 1);
  assert.equal(go[0].props.disabled, false);
});

test('★ 导入下拉：云端读不出来时如实说一句，本机选项照常可用（不许整块消失）', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    tab: 'import',
    state: sampleState({ archives: [{ name: 'a.tar.gz', bytesHuman: '1 KB', mtimeLocal: '2026-10-17 10:00:00' }] }),
    importCloud: null,
    importCloudError: '列不出远端：认证失败（HTTP 401）',
  };
  const tree = renderFull(ui);
  const text = textOf(tree);
  assert.ok(text.includes('云端备份没读出来'), `要说清云端这次没读到，实得：${text}`);
  assert.ok(text.includes('401'), '原因要如实带上');
  assert.ok(text.includes('本机备份照常可选'), '要告诉用户本机那部分没受影响');
  assert.ok(importSelect(tree), '本机有包时下拉必须还在');
});

test('导入下拉：正在读云端时说清在等什么；读回来几份要说清会自动下载', () => {
  const base = {
    ...initialUi(),
    loading: false,
    tab: 'import',
    state: sampleState({ archives: [{ name: 'a.tar.gz', bytesHuman: '1 KB', mtimeLocal: '2026-10-17 10:00:00' }] }),
  };
  const waiting = textOf(renderFull({ ...base, importCloudLoading: true }));
  assert.ok(waiting.includes('正在读取云端备份'), `实得：${waiting}`);

  const ready = textOf(
    renderFull({ ...base, importCloud: { ok: true, files: [sampleCloudFile(), sampleCloudFile({ name: 'b.tar.gz', localExists: true })] } }),
  );
  assert.ok(ready.includes('云端 2 份'), `实得：${ready}`);
  assert.ok(ready.includes('自动下载'), '要说明本机没有的会先自动下载');
});

test('★ 解析导入目标：云端那份本机没有 → 先下载，再按裸包名分析（执行导入要用同一个名字）', async () => {
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    return { ok: true, name: 'x.tar.gz', path: 'D:\\dsh-backups-sync\\x.tar.gz', bytes: 1024, verified: true };
  };
  const seen = [];
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState({ archives: [] }),
    importCloud: { ok: true, files: [sampleCloudFile({ name: 'x.tar.gz' })] },
    importSource: 'cloud:x.tar.gz',
  };
  const target = await internals().resolveImportTarget(ui, call, { onDownload: (name) => seen.push(name) });

  assert.equal(calls.length, 1, '只该发一次下载请求');
  assert.equal(calls[0][0], '/cloud/download');
  assert.equal(calls[0][1].name, 'x.tar.gz');
  assert.equal(target.archiveName, 'x.tar.gz', '分析阶段要用裸包名，不能把 cloud: 前缀带下去');
  assert.equal(target.archivePath, undefined);
  assert.equal(target.download.path, 'D:\\dsh-backups-sync\\x.tar.gz');
  assert.equal(target.download.verified, true);
  assert.deepEqual(seen, ['x.tar.gz'], '下载前要能切一次忙碌提示「正在从云端下载」');
});

test('★ 解析导入目标：云端那份本机已有 → 不重复下载，直接分析本机那份', async () => {
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    return {};
  };
  const seen = [];
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState({ archives: [{ name: 'x.tar.gz', bytesHuman: '1 KB', mtimeLocal: '2026-10-17 10:00:00' }] }),
    importCloud: { ok: true, files: [sampleCloudFile({ name: 'x.tar.gz', localExists: true })] },
    importSource: 'cloud:x.tar.gz',
  };
  const target = await internals().resolveImportTarget(ui, call, { onDownload: (name) => seen.push(name) });

  assert.deepEqual(calls, [], '本机已有就不该再下一遍（大包几百 MB）');
  assert.deepEqual(seen, []);
  assert.equal(target.archiveName, 'x.tar.gz');
  assert.equal(target.download, null);
});

test('解析导入目标：本机项与「或绝对路径」原样透传，不碰云端接口', async () => {
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    return {};
  };

  const local = await internals().resolveImportTarget(
    { ...initialUi(), importSource: 'a.tar.gz', importPath: '' },
    call,
  );
  assert.deepEqual(calls, []);
  assert.equal(local.archiveName, 'a.tar.gz');
  assert.equal(local.archivePath, undefined);
  assert.equal(local.download, null);

  const byPath = await internals().resolveImportTarget(
    { ...initialUi(), importSource: '', importPath: '  D:\\x\\y.tar.gz  ' },
    call,
  );
  assert.equal(byPath.archiveName, undefined);
  assert.equal(byPath.archivePath, 'D:\\x\\y.tar.gz', '路径要 trim，但不要改写');
  assert.equal(byPath.download, null);

  const nothing = await internals().resolveImportTarget({ ...initialUi(), importSource: '', importPath: '' }, call);
  assert.equal(nothing.archiveName, undefined);
  assert.equal(nothing.archivePath, undefined);
});

test('★ 云端下载完要报出落在哪儿（并说清有没有核对哈希）', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'import',
    importSource: 'x.tar.gz',
    importFlight: { name: 'x.tar.gz', path: 'D:\\dsh-backups-sync\\x.tar.gz', bytes: 181_900, verified: true },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('已从云端下载'), `实得：${text}`);
  assert.ok(text.includes('D:\\dsh-backups-sync\\x.tar.gz'), '要给出落盘路径');
  assert.ok(text.includes('哈希核对通过'), '核对过了就要说核对过了');

  const unverified = textOf(renderFull({ ...ui, importFlight: { name: 'y.tar.gz', path: 'D:\\b\\y.tar.gz', bytes: 1, verified: false } }));
  assert.ok(unverified.includes('远端没有 .sha256'), `没得核对时必须说出来，实得：${unverified}`);
});

test('导入下拉：换包/换路径要把上一次的下载结论与差异结果一起清掉，别让旧结论留在屏幕上', () => {
  const next = internals().importPickState({ importSource: 'a.tar.gz', importPath: '' });
  assert.equal(next.importSource, 'a.tar.gz');
  assert.equal(next.importFlight, null, '上一次「已从云端下载」的结论必须清掉');
  assert.equal(next.preview, null);
  assert.equal(next.applyResult, null);
  // 用键数判断：bundle 跑在独立的 vm 上下文里，跨 realm 的 {} 过不了 deepStrictEqual 的原型比对。
  assert.equal(Object.keys(next.resolutions).length, 0);
});

// ───────────────────────────────────────── 同步页签

test('同步页签：说清这是「复制到文件夹」，WebDAV 也在这一屏', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), tab: 'sync' };
  const tree = renderFull(ui);
  const text = textOf(tree);

  assert.ok(text.includes('最小的同步方式'));
  assert.ok(text.includes('U 盘、OneDrive、坚果云'));
  assert.ok(text.includes('.sha256 与 .meta.json'), '要说清边车也一起复制');
  assert.ok(!text.includes('二期'), 'WebDAV 已经做完了，不能再写「二期的事」');
  assert.equal(
    findAll(tree, (n) => n.props?.['data-dbs-cloud'] === '1').length,
    1,
    '同步页签里要有云端（WebDAV）卡片',
  );

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

// ───────────────────────────────────────── 云端（WebDAV）

/** 宿主 `/cloud/state` 里那份 `cloud` 视图（密码只以 hasPassword 出现）。 */
function sampleCloud(over = {}) {
  return {
    kind: 'webdav',
    enabled: false,
    url: 'http://192.168.3.9:5005/dav/',
    username: 'dsh',
    remoteDir: 'dsh-backup',
    insecureTLS: false,
    autoUpload: false,
    hasPassword: true,
    credentialsCorrupted: false,
    ready: true,
    lastUpload: null,
    lastCheck: { at: 1_762_000_000_000, atLocal: '2026-10-15 21:03:11', ok: true },
    settingsPath: 'C:\\Users\\x\\.dsh\\backup-sync\\settings.json',
    credentialsPath: 'C:\\Users\\x\\.dsh\\backup-sync\\cloud-credentials.json',
    remoteUrl: 'http://192.168.3.9:5005/dav/dsh-backup',
    ...over,
  };
}

/** 远端一份包的列表行。 */
function sampleRemoteRow(over = {}) {
  return {
    name: 'dsh-sync-20261015-210000.tar.gz',
    bytes: 181_900,
    bytesHuman: '177.6 KB',
    mtimeMs: 1_762_000_000_000,
    mtimeLocal: '2026-10-15 21:00:04',
    isOwn: true,
    localExists: false,
    localBytes: null,
    localSha256: null,
    remoteNewer: null,
    ...over,
  };
}

test('云端：七个控件与三个按钮都在，密码框类型必须是 password', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState(), tab: 'sync', cloud: sampleCloud() };
  const tree = renderFull(ui);

  for (const id of [
    'dbs-cloud-enabled',
    'dbs-cloud-url',
    'dbs-cloud-user',
    'dbs-cloud-pass',
    'dbs-cloud-dir',
    'dbs-cloud-insecure',
    'dbs-cloud-autoupload',
  ]) {
    assert.equal(findAll(tree, (n) => n.props?.id === id).length, 1, `缺少控件 ${id}`);
  }
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-cloud-pass')[0].props.type, 'password');

  for (const id of ['dbs-cloud-save', 'dbs-cloud-upload', 'dbs-cloud-refresh']) {
    const found = findAll(tree, (n) => n.type === 'button' && n.props?.id === id);
    assert.equal(found.length, 1, `缺少按钮 ${id}`);
    assert.equal(found[0].props.disabled, false);
  }

  // 三个开关的默认值：都必须是关的 —— 自动上传尤其不能默认打开。
  for (const id of ['dbs-cloud-enabled', 'dbs-cloud-insecure', 'dbs-cloud-autoupload']) {
    assert.equal(findAll(tree, (n) => n.props?.id === id)[0].props.checked, false, `${id} 应默认关闭`);
  }
});

test('云端：地址与账号回显自宿主，密码框永远不显示已存的密码', () => {
  const tree = renderFull({
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    cloud: sampleCloud(),
  });

  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-cloud-url')[0].props.value, 'http://192.168.3.9:5005/dav/');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-cloud-user')[0].props.value, 'dsh');
  assert.equal(findAll(tree, (n) => n.props?.id === 'dbs-cloud-dir')[0].props.value, 'dsh-backup');

  const pass = findAll(tree, (n) => n.props?.id === 'dbs-cloud-pass')[0];
  assert.equal(pass.props.value, '', '密码框内容必须始终为空');
  assert.equal(pass.props.placeholder, '已保存，留空则不变');
  assert.ok(!textOf(tree).includes('secret'), '界面上不该出现任何密码字面量');
});

test('云端：状态文案把「缺地址 / 缺密码 / 没启用 / 已启用」分开说', () => {
  const { cloudStatusText } = internals();
  assert.match(cloudStatusText(null), /正在读取/);
  assert.equal(cloudStatusText(sampleCloud({ url: null, ready: false })), '还没填云端地址');
  assert.equal(cloudStatusText(sampleCloud({ hasPassword: false, ready: false })), '地址有了，还缺密码');
  assert.equal(cloudStatusText(sampleCloud()), '已配置（未启用）：dsh-backup');
  assert.equal(cloudStatusText(sampleCloud({ enabled: true })), '已启用：dsh-backup');
  assert.match(cloudStatusText(sampleCloud({ credentialsCorrupted: true })), /凭据文件读不出来/);
});

test('云端：表单草稿只在用户改过时接管，没改过就跟着宿主走', () => {
  const { cloudFormOf } = internals();

  // 没草稿：由宿主实况派生，密码恒为空串（= 这次不改密码）。
  const derived = cloudFormOf({ cloud: sampleCloud() });
  assert.equal(derived.url, 'http://192.168.3.9:5005/dav/');
  assert.equal(derived.username, 'dsh');
  assert.equal(derived.remoteDir, 'dsh-backup');
  assert.equal(derived.password, '');
  assert.equal(derived.enabled, false);
  assert.equal(derived.autoUpload, false);

  // 宿主什么都没答（首屏）：不能崩，也不能渲染出 undefined。
  const empty = cloudFormOf({ cloud: null });
  assert.equal(empty.url, '');
  assert.equal(empty.remoteDir, '');
  assert.equal(empty.insecureTLS, false);

  // 有草稿：草稿说了算，宿主那边再变也不冲掉用户正在填的内容。
  const draft = cloudFormOf({ cloud: sampleCloud({ url: 'http://old/dav/' }), cloudForm: { ...empty, url: 'http://new/dav/' } });
  assert.equal(draft.url, 'http://new/dav/');
});

test('云端：保存请求里密码只在填了的时候才带上（留空 = 不改密码）', () => {
  const { cloudSaveBody, cloudFormOf } = internals();
  const base = cloudFormOf({ cloud: sampleCloud() });

  const blank = cloudSaveBody(base);
  assert.equal(blank.save, true, '必须带上 save:true —— 测的就是要存下来的那份配置');
  assert.ok(!('password' in blank), '留空不能提交 password（否则会把已存的密码抹掉）');
  assert.equal(blank.url, 'http://192.168.3.9:5005/dav/');
  assert.equal(blank.remoteDir, 'dsh-backup');

  const typed = cloudSaveBody({ ...base, password: 'app-pass', url: '  http://192.168.3.9:5005/dav/  ' });
  assert.equal(typed.password, 'app-pass');
  assert.equal(typed.url, 'http://192.168.3.9:5005/dav/', '地址两端空白要去掉');
});

test('云端：连接测试失败要给出 HTTP 状态，且同时落进红条', () => {
  const { cloudTestOutcome } = internals();
  const body = { url: 'http://192.168.3.9:5005/dav/', remoteDir: 'dsh-backup' };

  const bad = cloudTestOutcome({ ok: false, status: 401, error: '认证失败（HTTP 401）' }, body);
  assert.equal(bad.cloudResult.ok, false);
  assert.equal(bad.cloudResult.status, 401, '401 要能从界面上看到');
  assert.equal(bad.cloudError, '认证失败（HTTP 401）', '失败必须同时进红条，不能只写一句「连接失败」');
  assert.equal(bad.cloudResult.title, '云端连接失败');

  const good = cloudTestOutcome({ ok: true, url: body.url, remoteDir: body.remoteDir, created: true }, body);
  assert.equal(good.cloudResult.created, true);
  assert.equal(good.cloudError, null);

  // 展开成测试侧的对象再比：bundle 跑在 vm 里，跨 realm 的 deepStrictEqual 会因为
  // 原型不同而报「same structure but not reference-equal」。
  assert.deepEqual({ ...cloudTestOutcome(null, body) }, { cloudResult: null, cloudError: null });
});

test('云端：远端列表每行带包名与下载/删除按钮，状态用徽标说清', () => {
  const remote = {
    ok: true,
    dirMissing: false,
    files: [
      sampleRemoteRow(),
      sampleRemoteRow({ name: 'dsh-sync-20261014-090000.tar.gz', localExists: true, remoteNewer: true }),
      sampleRemoteRow({ name: 'dsh-sync-20261013-090000.tar.gz', localExists: true, remoteNewer: false }),
    ],
  };
  const tree = renderFull({
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    cloud: sampleCloud(),
    cloudRemote: remote,
  });

  const rows = findAll(tree, (n) => typeof n.props?.['data-dbs-remote'] === 'string');
  assert.deepEqual(
    rows.map((r) => r.props['data-dbs-remote']),
    remote.files.map((f) => f.name),
  );

  // 每一行的两个按钮都带着这一行的包名 —— 一屏 N 个「下载」必须能分清是谁。
  for (const f of remote.files) {
    const dl = findAll(tree, (n) => n.props?.['data-dbs-download'] === f.name);
    assert.equal(dl.length, 1, `缺少「下载」按钮：${f.name}`);
    const rm = findAll(tree, (n) => n.props?.['data-dbs-remove'] === f.name);
    assert.equal(rm.length, 1, `缺少「删除」按钮：${f.name}`);
  }

  const text = textOf(tree);
  assert.ok(text.includes('本地没有'), '远端有、本地没有的包要标出来');
  assert.ok(text.includes('远端更新'));
  assert.ok(text.includes('本地已有'));
  assert.ok(!text.includes('未核对'), '列表阶段不该出现下载校验的措辞');
});

test('云端：删除要二次确认，确认前一个请求都不发', () => {
  const called = [];
  const actions = {
    cloudRemoveAsk: (name) => called.push(['ask', name]),
    cloudRemove: (name) => called.push(['remove', name]),
    cloudRemoveCancel: () => called.push(['cancel']),
    cloudDownload: (name) => called.push(['download', name]),
  };
  const base = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    cloud: sampleCloud(),
    cloudRemote: { ok: true, dirMissing: false, files: [sampleRemoteRow()] },
  };

  // 第一下点「删除」只是问一句，绝不直接删。
  const tree = renderFull(base, actions);
  findAll(tree, (n) => n.props?.['data-dbs-remove'] === sampleRemoteRow().name)[0].props.onClick();
  assert.deepEqual(called, [['ask', sampleRemoteRow().name]]);

  // 确认态：只出现「确认删除 / 取消」，下载按钮先让位。
  const confirming = renderFull({ ...base, cloudPendingRemove: sampleRemoteRow().name }, actions);
  assert.equal(findAll(confirming, (n) => n.props?.id === 'dbs-cloud-remove-yes').length, 1);
  assert.equal(findAll(confirming, (n) => n.props?.id === 'dbs-cloud-remove-no').length, 1);
  assert.equal(findAll(confirming, (n) => n.props?.['data-dbs-download'] === undefined).length > 0, true);
  assert.equal(findAll(confirming, (n) => n.props?.['data-dbs-download'] === sampleRemoteRow().name).length, 0);

  findAll(confirming, (n) => n.props?.id === 'dbs-cloud-remove-yes')[0].props.onClick();
  findAll(confirming, (n) => n.props?.id === 'dbs-cloud-remove-no')[0].props.onClick();
  assert.deepEqual(called, [['ask', sampleRemoteRow().name], ['remove', sampleRemoteRow().name], ['cancel']]);
});

test('云端：远端文件夹还没建时说清「第一次上传会建」，而不是假装列表为空', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    cloud: sampleCloud(),
    cloudRemote: { ok: true, dirMissing: true, files: [] },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('远端还没有这个文件夹'));
  assert.ok(text.includes('第一次上传时会自动创建'));

  const empty = textOf(renderFull({ ...ui, cloudRemote: { ok: true, dirMissing: false, files: [] } }));
  assert.ok(empty.includes('远端文件夹里还没有备份包'));

  const failed = textOf(renderFull({ ...ui, cloudRemote: { ok: false, error: '认证失败（HTTP 401）' } }));
  assert.ok(failed.includes('列不出远端'));
  assert.ok(failed.includes('401'));
});

test('云端：卡片上说清「上传最新备份」到底传哪一份', () => {
  const local = [{ name: 'dsh-sync-20261015-210000.tar.gz', bytesHuman: '177.6 KB', mtimeLocal: '2026-10-15 21:00:04' }];
  const withLocal = textOf(
    renderFull({ ...initialUi(), loading: false, state: sampleState(), tab: 'sync', cloud: sampleCloud(), cloudLocal: local }),
  );
  assert.ok(withLocal.includes('会传：dsh-sync-20261015-210000.tar.gz'));
  assert.ok(withLocal.includes('177.6 KB'));

  const none = textOf(
    renderFull({ ...initialUi(), loading: false, state: sampleState(), tab: 'sync', cloud: sampleCloud(), cloudLocal: [] }),
  );
  assert.ok(none.includes('本地备份目录里还没有包'));
});

test('云端：失败信息（含旧宿主 404）要在卡片里看得见', () => {
  const tree = renderFull({
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    cloud: null,
    cloudError: '当前运行的宿主里还没有这条接口（HTTP 404）。界面部分已经是最新的，宿主部分要重启一次 DSH 才会生效 —— 关掉 DSH 再打开即可。',
  });
  const notices = findAll(tree, (n) => n.props?.['data-tone'] === 'bad' && String(n.props?.className ?? '').includes('dbs-notice'));
  assert.ok(notices.length >= 1, '云端失败要有红色提示块');
  assert.ok(textOf(tree).includes('重启一次 DSH'));
});

test('云端：有改动没保存、以及密码提交后清空，都要看得见', () => {
  const dirty = renderFull({
    ...initialUi(),
    loading: false,
    state: sampleState(),
    tab: 'sync',
    cloud: sampleCloud(),
    cloudDirty: true,
  });
  assert.equal(findAll(dirty, (n) => n.props?.['data-dbs-cloud-dirty'] === '1').length, 1);

  const clean = renderFull({ ...initialUi(), loading: false, state: sampleState(), tab: 'sync', cloud: sampleCloud() });
  assert.equal(findAll(clean, (n) => n.props?.['data-dbs-cloud-dirty'] === '1').length, 0);
});

test('云端：上传成功后卡片的「上次上传」跟着更新', () => {
  const text = textOf(
    renderFull({
      ...initialUi(),
      loading: false,
      state: sampleState(),
      tab: 'sync',
      cloud: sampleCloud({
        lastUpload: {
          at: 1_762_000_180_000,
          atLocal: '2026-10-15 21:31:02',
          name: 'dsh-sync-20261015-210000.tar.gz',
          bytes: 181_900,
          remoteDir: 'dsh-backup',
        },
      }),
    }),
  );
  assert.ok(text.includes('dsh-sync-20261015-210000.tar.gz · 2026-10-15 21:31:02'));
});

test('★ 云端卡片的时间一律是人话，绝不许把 epoch 毫秒摆到脸上', () => {
  // 真机截图里出现过「上次测试 1792204738211」「上次上传 … · 1792204791660」——
  // 宿主写的 at 是 epoch 毫秒，界面必须读 atLocal。
  const text = textOf(
    renderFull({
      ...initialUi(),
      loading: false,
      state: sampleState(),
      tab: 'sync',
      cloud: sampleCloud({
        lastCheck: { at: 1_792_204_738_211, atLocal: '2026-10-17 10:38:58', ok: true },
        lastUpload: {
          at: 1_792_204_791_660,
          atLocal: '2026-10-17 10:39:51',
          name: 'dsh-sync-20261017-103937.tar.gz',
          bytes: 483_956,
        },
      }),
    }),
  );
  assert.ok(text.includes('2026-10-17 10:38:58'), '上次测试要显示 atLocal');
  assert.ok(text.includes('dsh-sync-20261017-103937.tar.gz · 2026-10-17 10:39:51'), '上次上传要显示 atLocal');
  assert.equal(/17\d{11}/.test(text), false, `界面上不该出现 epoch 毫秒：${text.match(/\d{10,}/g)}`);
});

test('云端卡片时间：老状态文件缺 atLocal 时按本机时区补，缺 at 时给兜底文案', () => {
  const { stampOf } = internals();
  const legacy = stampOf({ at: 1_792_204_738_211 }, '还没测过');
  assert.match(legacy, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `补出来的时间要长得像时间：${legacy}`);
  assert.equal(legacy, stampOf({ at: 1_792_204_738_211, atLocal: '' }, '还没测过'), '空字符串不算有效 atLocal');
  assert.equal(stampOf(null, '还没测过'), '还没测过');
  assert.equal(stampOf(undefined, '还没测过'), '还没测过');
  assert.equal(stampOf({ at: '2026-10-15 21:03:11' }, '时间未知'), '时间未知', 'at 是字符串时不许原样吐出来');
  assert.equal(stampOf({}, '时间未知'), '时间未知');
  assert.equal(stampOf({ at: Number.NaN }, '时间未知'), '时间未知');
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

test('★ 401 要说「会话已过期」，不能甩一句「不是 JSON」（真机踩过）', async () => {
  // 真机上 CDP 注入的签名 cookie 只有 1 小时有效期，过期后 /api/* 回的是**纯文本**
  // "authentication required"。原先统一报「接口返回的不是 JSON（HTTP 401）」，
  // 排查时被引向 JSON 解析，实际是会话过期 —— 这句话必须能让人直接去刷新页面。
  const fetch = fakeFetchOf([badJsonResponse(401), badJsonResponse(401)]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/state'), /会话已过期（HTTP 401）/);
  await assert.rejects(() => callApi('/state'), /刷新页面/);
});

test('403 要说是来源地址不被信任', async () => {
  const fetch = fakeFetchOf([badJsonResponse(403), badJsonResponse(403)]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/state'), /HTTP 403/);
  await assert.rejects(() => callApi('/state'), /来源地址/);
});

test('authHint 只对 401/403/404 特判，其余状态码照旧', () => {
  const { authHint } = loadBundle().module.__internals;
  assert.match(authHint(401), /会话已过期/);
  assert.match(authHint(403), /来源地址/);
  // ★ 404 必须给出「重启一次 DSH」这个动作。
  //   界面半边是 link: 安装的（刷新即生效），宿主半边不会热加载 ——
  //   新增接口在老宿主上就是 404。只说「返回的不是 JSON」会让人以为是功能坏了。
  assert.match(authHint(404), /重启一次 DSH/);
  assert.match(authHint(404), /HTTP 404/);
  assert.equal(authHint(500), '接口返回的不是 JSON（HTTP 500）');
  assert.equal(authHint(0), '接口返回的不是 JSON（HTTP 0）');
  assert.equal(authHint(undefined), '接口返回的不是 JSON（HTTP undefined）');
});

/** 造一个假 document，记录 textarea 的创建/移除与 execCommand 的返回值。 */
function fakeDocument({ execOk = true, hasExec = true } = {}) {
  const made = [];
  const removed = [];
  const doc = {
    body: {
      appendChild(el) { made.push(el); },
    },
    createElement(tag) {
      return {
        tag,
        value: '',
        style: {},
        selected: false,
        setAttribute() {},
        select() { this.selected = true; },
        remove() { removed.push(this); },
      };
    },
    execCommand(cmd) {
      doc.lastCommand = cmd;
      return execOk;
    },
  };
  if (!hasExec) delete doc.execCommand;
  return { doc, made, removed };
}

test('★ 剪贴板优先走 navigator.clipboard', async () => {
  const written = [];
  const { copyToClipboard } = loadBundle({
    globals: { navigator: { clipboard: { writeText: async (v) => { written.push(v); } } } },
  }).module.__internals;
  // ★ vm 域坑：copyToClipboard 在 vm 里造出来的对象带的是 vm 的 Object.prototype，
  // 直接 deepStrictEqual 会报「Values have same structure but are not reference-equal」。
  // 先摊成宿主域对象再比。本项目已在数组上踩过一次，这是第二次。
  assert.deepEqual({ ...(await copyToClipboard('D:\\a\\b.tar.gz')) }, { ok: true, how: 'clipboard' });
  assert.deepEqual([...written], ['D:\\a\\b.tar.gz']);
});

test('★ 没有 navigator.clipboard 时必须退到 execCommand —— 桌面端 dsh-app:// 下就是这个情况', async () => {
  // 真机风险：自定义协议只有被注册成 secure 才算安全上下文，否则 navigator.clipboard
  // 直接是 undefined。原先的 `navigator.clipboard?.writeText(...)` 连调用都不会发生，
  // 按钮点了毫无反应 —— 用户只会以为「复制坏了」。
  const { doc, made, removed } = fakeDocument();
  const { copyToClipboard } = loadBundle({ globals: { document: doc } }).module.__internals;
  assert.deepEqual({ ...(await copyToClipboard('D:\\x\\y.tar.gz')) }, { ok: true, how: 'execCommand' });
  assert.equal(made.length, 1, '应创建一个临时 textarea');
  assert.equal(made[0].value, 'D:\\x\\y.tar.gz');
  assert.equal(made[0].selected, true, '必须 select 后才有东西可复制');
  assert.equal(doc.lastCommand, 'copy');
  assert.equal(removed.length, 1, '临时元素必须移除，不能落在页面上');
});

test('★ writeText 抛错时也要退到 execCommand，而不是静默失败', async () => {
  const { doc, removed } = fakeDocument();
  const { copyToClipboard } = loadBundle({
    globals: {
      document: doc,
      navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } },
    },
  }).module.__internals;
  assert.deepEqual({ ...(await copyToClipboard('D:\\p')) }, { ok: true, how: 'execCommand' });
  assert.equal(removed.length, 1);
});

test('两条路都不通时如实报 failed，不谎报成功', async () => {
  const { doc, removed } = fakeDocument({ execOk: false });
  const { copyToClipboard } = loadBundle({ globals: { document: doc } }).module.__internals;
  assert.deepEqual({ ...(await copyToClipboard('D:\\p')) }, { ok: false, how: 'failed' });
  assert.equal(removed.length, 1, '即使 execCommand 失败也要移除临时元素');
});

test('连 document 都没有（宿主不给）时也是 failed，不抛异常', async () => {
  const { copyToClipboard } = loadBundle().module.__internals;
  assert.deepEqual({ ...(await copyToClipboard('D:\\p')) }, { ok: false, how: 'failed' });
});

test('空文本直接判 empty，不去碰剪贴板', async () => {
  let touched = 0;
  const { copyToClipboard } = loadBundle({
    globals: { navigator: { clipboard: { writeText: async () => { touched += 1; } } } },
  }).module.__internals;
  assert.deepEqual({ ...(await copyToClipboard('')) }, { ok: false, how: 'empty' });
  assert.deepEqual({ ...(await copyToClipboard(null)) }, { ok: false, how: 'empty' });
  assert.deepEqual({ ...(await copyToClipboard(undefined)) }, { ok: false, how: 'empty' });
  assert.equal(touched, 0);
  assert.equal(loadBundle().module.__internals.legacyCopy(''), false, '空串不必走老路');
});

test('★ 复制失败时界面必须把路径摊出来让人手动复制（不能只说一句失败）', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState({ archives: [ONE_ARCHIVE] }),
    tab: 'history',
    copyResult: { ok: false, how: 'failed', text: 'D:\\dsh-backups-sync\\dsh-sync-20261013-180657.tar.gz' },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('没能写进剪贴板'), `应提示复制失败，实得：${text}`);
  assert.ok(text.includes('dsh-sync-20261013-180657.tar.gz'), '失败时必须把路径本身显示出来');
});

test('复制成功时界面说清已复制，并带上路径', () => {
  const ui = {
    ...initialUi(),
    loading: false,
    state: sampleState({ archives: [ONE_ARCHIVE] }),
    tab: 'history',
    copyResult: { ok: true, how: 'clipboard', text: 'D:\\dsh-backups-sync\\dsh-sync-20261013-180657.tar.gz' },
  };
  const text = textOf(renderFull(ui));
  assert.ok(text.includes('已复制到剪贴板'), `应提示复制成功，实得：${text}`);
  assert.ok(!text.includes('没能写进剪贴板'));
});

test('没点过复制时不显示任何复制提示', () => {
  const ui = { ...initialUi(), loading: false, state: sampleState({ archives: [ONE_ARCHIVE] }), tab: 'history' };
  const text = textOf(renderFull(ui));
  assert.ok(!text.includes('已复制到剪贴板'));
  assert.ok(!text.includes('没能写进剪贴板'));
});

test('HTTP 非 2xx 但 body 是 JSON 且没写 ok:false 时，仍然要报错', async () => {
  const fetch = fakeFetchOf([jsonResponse(500, { message: '内部错误' })]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/state'), /HTTP 500/);
});

test('★ HTTP 401 但 body 是合法 JSON 时也要走「会话已过期」', async () => {
  const fetch = fakeFetchOf([jsonResponse(401, { message: 'nope' })]);
  const { callApi } = loadBundle({ globals: { fetch } }).module.__internals;
  await assert.rejects(() => callApi('/state'), /会话已过期（HTTP 401）/);
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
