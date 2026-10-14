# DSH 客户端插件契约（`__ModuleLoader__` / `dsh.client` / 槽位）

> M2 Task 6 交付物。全部结论来自**本机内核源码**与**已在跑的第三方插件**，不是推测；每条都标了出处路径与行号，可复核。
> 目标内核版本：`0.2.0-rc.2`。内核源码解包位置：`<内核解包目录>\dsh\node_modules\@deepseek-ai\`。

---

## 0. 结论摘要

客户端插件就是一个**手写的 CJS 风格 bundle**，外壳固定为：

```js
window.__ModuleLoader__.load({
  id: '<包名>',                       // 必须严格等于 boot entry id = package.json 的 name
  factory: (require) => {
    const React = require('react');    // 从平台种子表取，不是 npm 安装
    return {
      inject: ['slots'],               // Cordis 服务名（硬门）
      apply(ctx) {
        // 在这里注册槽位
      },
    };
  },
});
```

**不需要打包器**：`require` 只认平台种子表 + 已注册的 boot 条目，手写 `React.createElement` 即可（官方模板就是这么写的）。
**不需要装 `@deepseek-ai/*` 依赖**：那些 bare specifier 由宿主虚拟模块表解析，本机磁盘上根本没有 `@deepseek-ai/dsh-tools` 之类的包。

---

## 1. 权威证据来源

| 证据 | 路径 | 说明 |
| --- | --- | --- |
| 官方模板（最小可用） | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{client.js,index.js,package.json}` | 内核自带，22 行 client.js 就是完整契约 |
| Loader 实现（带完整注释） | `@deepseek-ai/dsh-client-modules/lib/index.js`（981 行，未压缩） | 浏览器侧契约面 + 宿主侧服务 |
| Loader 浏览器运行时 | `@deepseek-ai/dsh-client-modules/lib/client.js`（884 行，未压缩） | `window.__ModuleLoader__` 的真实实现 |
| 平台种子表 | `@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js` 中 `function rM()` | 9 个种子词的唯一权威清单 |
| 官方槽位目录（90 条） | `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 约 5030 行起 | 每条槽位的 kind/scope/registerOptions/ownerProps/occupants/可运行示例 |
| 真实第三方插件 | `C:\Users\x\.dsh\profiles\desktop\node_modules\dsh-context\lib\client.js` | 已在本机跑通的完整范例（侧边栏入口 + 标签页） |
| 内核自带 UI 范例（**未压缩、可直接读**） | `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`（3786 行） | 「插件」页的 `sidebar.panellist` + `main` 注册全文 |
| 侧边栏消费端 | `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js:452-527` | 面板列表怎么读注册项、点击后干什么 |

槽位目录（90 条）可以从内核自己的 `dsh-cordis-client-runner/lib/client.js` 里再抽一遍，
抽取脚本没有随仓库发布（它读的是解包后的内核源码）；本文第 7 节按用途列了常用的那些槽位。

> 为什么不把抽出来的 225 KB 目录 JSON 放进仓库：那是对内核 TypeScript 声明文件的**逐字拷贝**，
> 属于第三方代码，放进本仓库（MIT）会造成许可混淆。要看全量目录，照上表的出处自己抽一遍即可。

---

## 2. 加载模型：懒注册 + 物化

`dsh-client-modules/lib/index.js:16-31` 原文：

- 执行一个插件 bundle **只是注册它的 factory**（`window.__ModuleLoader__.load({id, factory})`）。
- 模块体的所有副作用——**包括 CSS 注入**——都写在 factory 闭包里，在**物化（materialization）**时才跑，不是在 script 执行时。
- 物化 = `factory(require)` → exports，结果缓存在 `loadCache`，只跑一次。
- 一个 factory 去 require 另一个"已注册但未物化"的模块会**递归物化**，所以加载顺序不需要外部排序。

**实际影响**：把 CSS 字符串写在 factory 内部注入是安全的；写在 `load()` 外面（顶层）会在 bundle 一被 `<script>` 加载时就执行，那时平台可能还没准备好。

### 2.1 注册校验

`client.js:569-581` 的 `register(registration)`：

- `registration` 形状 = `{ id, factory, chunk? }`。
- `id` 先经 `stripClientSuffix()`：**结尾的 `/client` 会被剥掉**，所以 `load({id:'foo/client'})` 与 `load({id:'foo'})` 等价，都注册成 `foo`。
- `chunk` 若存在必须匹配包内分块名正则，否则抛 `invalid package-local chunk`。
- 同一 id 注册第二次直接抛：
  `duplicate factory registration for "<id>" (bundle executed twice without invalidate?)`
  —— 所以 bundle **不能执行两次**。

### 2.2 `id` 必须等于 boot entry id

`client.js:624-626` 与 `739`：

```
loaded without registering "<id>" via __ModuleLoader__.load
```

加载器按 boot 清单里的 `id` 去查 `this.factories.has(id)`；注册成别的名字 → 判定"没注册" → 该条目加载失败。

本机实测 boot 条目形状（`node <工具目录>\boot-grep.mjs '<regex>'`）：

```
boot entries=75
  dsh-memory-evolve  ->  plugins/??dsh-memory-evolve/client.js&rev=b916ee63d7e3
  dsh-context        ->  plugins/??dsh-context/client.js&rev=6452c2eaeaed
```

即条目 = `{ id, url, rev, inject }`，**`id` 就是包名**，URL 由宿主生成（`plugins/??<id>/client.js&rev=<hash>`）。
→ **我们的 bundle 必须写 `id: 'dsh-backup-sync'`**（与 `package.json` 的 `name` 完全一致）。

---

## 3. `factory(require)` 的 require 解析链

`client.js:697-715` 的 `makeRequire()`，**同步**，按顺序：

1. `this.seed.has(spec)` → 返回种子表里的实例；
2. `stripClientSuffix(spec)` 后在 `loadCache` 里 → 返回已物化的 exports；
3. 在 `factories` 里 → 递归 `materialize()` 后返回 exports；
4. 都不命中 → **抛错**：
   `require("<spec>") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`

注意第 3 步是**同步**物化：要求对方 factory **已经注册**。加载本身是异步的，所以一个"动态依赖"必须在消费者物化之前完成注册。

`require.async(spec)`（`client.js:707-713`）：

- `spec` 不以 `./` 开头 → 走异步 `import(spec)`（可以触发加载）；
- `spec` 形如 `./xxx` → 走包内动态分块 `importChunk`，分块名要匹配 `CLIENT_CHUNK` 正则。

异步 `import()`（`client.js:743-757`）的解析顺序是 seed → `loadCache` → boot 图行（触发 `arriveGraphRow` 后物化）→ 已注册 factory → 否则抛：
`cannot resolve "<spec>" — not a seed word, not a materialized module, and not a row in the boot graph (the runtime mirror of the bundle purity gate)`

### 3.1 平台种子表（9 项，完整清单）

来自 `dsh-web-frontend` 的 `function rM()`（去混淆后）：

```js
{
  "react":                                    Ef,
  "react/jsx-runtime":                        If,
  "react-dom":                                Rf,
  "react-dom/client":                         Df,
  "@deepseek-ai/cordis":                      sf,
  "@deepseek-ai/dsh-client-store":            lh,
  "@deepseek-ai/dsh-client-ui-slots":         hh,
  "@deepseek-ai/dsh-client-ui-primitives":    sE,
  "@deepseek-ai/dsh-client-ui-dockkit":       XS,
}
```

**只有这 9 个 bare specifier 可以不注册就直接 require。** 其余 `@deepseek-ai/dsh-client-*` 必须先作为 boot 条目到达并注册，否则 `require` 抛错。

> 注意：`@deepseek-ai/dsh-client-ui-slots` 在种子表里，所以 `require('@deepseek-ai/dsh-client-ui-slots')` 拿到的是**纯注册表核心**（`resolveSlotLabel` 等），不是 `ctx.slots` 服务。

---

## 4. 模块导出契约

factory 的返回值就是该模块的 exports，被宿主（vendored Cordis Loader 的 `EntryTree.import` → `internal.import`）消费。约定字段：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `inject` | 视需要 | **Cordis 服务名数组**（如 `['slots']`）。这是硬门：服务不存在 → 条目 pending → boot 审计失败。 |
| `apply(ctx)` | 是 | 注册逻辑入口，`ctx` 是 Cordis Context。 |
| `name` | 否 | 插件名（宿主侧插件用得多）。 |
| `Config` | 否 | Schemastery 配置 schema。 |

真实范例（`dsh-client-ui-plugin-manager/lib/client.js:3778-3782`，**未压缩**）：

```js
exports.NS = NS;
exports.PANEL_ID = PANEL_ID;
exports.apply = apply;
exports.inject = inject;
return module.exports;
```

其中 `inject` 是文件内的一个数组常量（`:3658-3667`）：

```js
const inject = [
  "slots", "locale", "remote", "remote.pluginManager",
  "remote.pluginInventory", "remote.pluginRegistryProbe",
  "configForms", "layout"
];
```

### 4.1 官方模板的等价简写

`templates/decoration/client.js` 用对象字面量直接返回，等价：

```js
factory(require) {
  const React = require('react');
  return {
    inject: ['slots'],
    apply(ctx) { /* ... */ },
  };
}
```

---

## 5. `package.json` 的 `dsh.client` 声明

校验函数：`dsh-client-modules/lib/index.js:61-75` 的 `parseDshClient()`。

```json
{
  "name": "dsh-backup-sync",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"],
      "immediately": true
    }
  }
}
```

字段规则（源码原文逐条）：

| 字段 | 类型 | 必需 | 校验 |
| --- | --- | --- | --- |
| `platform` | `string` | **是** | 非 string 抛 `dsh.client.platform must be a string`。本机全部插件都写 `"web"`。 |
| `inject` | `string[]` | 否 | 非字符串数组抛 `dsh.client.inject must be a string array`。 |
| `external` | `string[]` | 否 | 同上校验。 |
| `immediately` | `boolean` | 否 | 非 boolean 抛 `dsh.client.immediately must be a boolean`。 |

`exports` 里必须有 `"./client"` 指向客户端 bundle —— 这是宿主找到它的路径（`<pkg>/client` 与 `<pkg>` 在 require 里等价，见 §2.1）。

---

## 6. `inject` 与 `external` 的真实语义（源码级）

`client.js:643-661` 的 `arriveGraphRow(row)`：

```js
for (const request of row.external) {
  const id = stripClientSuffix(request);
  if (this.seed.has(request) || this.loadCache.has(id)) continue;
  const dependency = this.graphRows.get(id);
  if (dependency !== void 0) await this.arriveDependency(row.id, dependency, next, visited);
}
for (const packageName of row.inject) {
  const dependency = this.graphRows.get(packageName);
  if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
}
await this.arrive(row);
```

**关键结论（这是预检判据的源码依据）**：

- `inject` / `external` 里写的都是**模块 id**，不是 Cordis 服务名。
- 如果该 id **是** boot 图里的一行 → **硬依赖**：对方加载失败会级联抛出
  `"<消费者>" not loaded because dependency "<依赖>" failed: …`
- 如果该 id **不是** boot 图里的一行（典型：`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-runtime` 这类**共享库模块**）→ `dependency === undefined` → **静默跳过**，不报错。
  → 所以 `dsh.client.inject` 里出现非 boot 条目的模块 **是正常模式，不是缺依赖**；直接请求 `plugins/??<id>/client.js` 得到 404 也属正常。
- `external` 额外多一步：先看是不是种子词，是则跳过。
- 加载失败会重试一次同 URL；一个 bundle 若"执行了但没注册本行"则**不会重放**（避免重复注册报错）。

---

## 7. 客户端服务名清单（0.2.0-rc.2 实测）

服务名来自真实运行插件的 `inject` 数组，**不是猜的**：

| 服务名 | 佐证 |
| --- | --- |
| `slots` | 全部槽位注册插件 |
| `layout` | `dsh-client-ui-sidebar:436-442`、`dsh-client-ui-plugin-manager:3658-3667` |
| `uiWorkspace` | `dsh-client-ui-sidebar:436-442` |
| `locale` | `dsh-client-ui-sidebar`、`dsh-client-ui-plugin-manager` |
| `shortcuts` | `dsh-client-ui-sidebar:436-442` |
| `remote` | `dsh-client-ui-plugin-manager:3658-3667` |
| `remote.pluginManager` / `remote.pluginInventory` / `remote.pluginRegistryProbe` | 同上（`remote.<name>` 形态的子服务） |
| `configForms` | 同上 |
| `sessions` / `conversation` | `dsh-memory-evolve` 的 client.js：`inject = ["slots","locale","conversation","sessions"]` |
| `theme` / `connection` | 内核 client 服务面 |

**红线**：`inject` 里写一个**不存在的服务名** → 条目 pending → 渲染进程报 `web boot: N entries did not activate` → 触发「DeepSeek Harness 无法使用」致命恢复框（第三个按钮会备份并重置 `cordis.patch.yml` 与 `dsh.profile.bundles`）。
本机已确认**不存在** `settingsScope`（`dsh-ping` 1.9.0 因此必崩）。

**稳妥做法**：`inject` 只写 `['slots']`（我们只需要它），其余服务用 `ctx.get('<name>')` 懒解析并判空。

---

## 8. 槽位契约

### 8.1 `slots` 服务 API

来自 `dsh-client-ui-slots/lib/index.js` 的纯注册表核心 + 运行时 Service 外壳：

| 调用 | 说明 |
| --- | --- |
| `ctx.slots.inject(slotKey, callback)` | 等 `slotKey` 被声明后执行 `callback`。**`callback` 可以是普通函数，也可以是 generator**（Cordis effect 写法）。返回（或 `yield` 出）一个 disposer。 |
| `ctx.slots.register(options, Component)` | 注册一个槽位占位者，返回 disposer。**槽位未声明时直接抛** `slot "<name>" is not declared (a parent entry's children table must declare it)`。 |
| `ctx.slots.entriesOfSlot(key)` | 返回 `[{ options, component, ... }]`，侧边栏就是用它列出面板的。 |
| `ctx.slots.subscribe(key, fn)` | 订阅注册变化（微任务批量），返回 unsubscribe。 |
| `ctx.slots.getVersion(key)` | 单调版本号。 |
| `ctx.slots.declarationEpoch(key)` | 声明纪元（首次声明前为 0）。 |
| `ctx.slots.subscribeDeclaration(key, fn)` | 订阅声明生命周期边界（同步通知）。 |
| `resolveSlotLabel(label)` | 从 `@deepseek-ai/dsh-client-ui-slots` 导出；`typeof label === 'function' ? label() : label`。 |

注册时的冲突校验（`index.js:163-190`），按 kind 分派：

- `single`：同 `priority` 已有占位者 → 抛 `single slot "<name>" already has a registration at priority N — register at a different priority to shadow it (lowest renders)`。
- `keyed`：**必须给 `options.key`**，否则抛 `keyed slot "<name>" requires options.key`；同 key 同 priority 冲突。
- `list`：**必须给 `options.id`**，否则抛 `list slot "<name>" requires options.id`；同 id 同 priority 冲突。
- `chain`：**必须给 `options.select`**。

### 8.2 「备份同步」需要的两个槽位

这就是「上下文洞察」「插件」「自动化任务」那一行入口的实现方式 —— **两个槽位配对**：

#### ① 侧边栏图标行：`sidebar.panellist`

| 项 | 值 |
| --- | --- |
| kind | `list` |
| scope | `root` |
| 声明者 | `client-ui-sidebar` 的 `sidebar` 条目（`dsh-client-ui-sidebar/lib/client.js:503-506`），所以 sidebar 挂载期间它才存在 |
| registerOptions | `id`（**必需**）、`order`（可选，number，默认 0，升序）、`label`（可选，`string \| (() => string)`） |
| ownerProps | `{ size: number; active: boolean }` —— **组件渲染的是图标**，`size` 是请求的方形边长，`active` 表示该面板是否在主列被选中 |
| replaceRisk | `none` |
| 现有占位者 | `client-ui-plugin-manager PluginsPanelIcon`（id `plugins`）、`client-ui-schedule TaskManagerIcon`（id `schedules`） |

侧边栏消费端原文（`dsh-client-ui-sidebar/lib/client.js:452-461`）：

```js
const syncPanels = () => {
  const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
    const id = options.id;
    return {
      id,
      order: options.order ?? 0,
      label: resolveSlotLabel(options.label) ?? id
    };
  }).sort((a, b) => a.order - b.order);
  ...
};
```

**结论**：`label` 给**普通字符串**即可（`resolveSlotLabel` 对非函数原样返回），`?? id` 只是兜底。**不需要 `locale` 字段**。
点击行为（`:478-481`）：`selectPanel: (id) => ctx.layout.selectPanel(id)`。

#### ② 主列面板：`main`

| 项 | 值 |
| --- | --- |
| kind | `keyed` |
| scope | `root` |
| 声明者 | `client-ui-layout` 的 `root` 条目 |
| registerOptions | `key`（**必需**，string） |
| ownerProps | 无 |
| standardProps | hooks：`useResource` / `useWorkspaces` / `usePanelInfo` / `useSessions` / `useSessionStatus` / `useSessionRetainInfo` |
| keyDomain | `open: any string the owner dispatches (no compile-time key set)`；**已被占用：`conversation`** |
| replaceRisk | **`shadows-shipped-ui`**（会遮蔽内置 UI） |
| 现有占位者 | `client-ui-conversation`（key `conversation`）、`client-ui-plugin-manager`、`client-ui-schedule` |

**配对机制**：`sidebar.panellist` 的文档原文 —— "**Each list id addresses the matching main panel**"。侧边栏按钮用自己的 `id` 去 `ctx.layout.selectPanel(id)`，主列按同名字符串取 `main` 的 key。
→ 我们的 `panellist.id` 与 `main.key` **必须写成同一个字符串**（建议 `'backup-sync'`），且**绝不能用 `conversation`**。

### 8.3 内核自带范例（未压缩，照抄结构即可）

`dsh-client-ui-plugin-manager/lib/client.js:3712-3775`：

```js
ctx.slots.inject("main", function* () {
  const handle = createNavigationStore(), instance = handle.create();
  const store = { ...handle, create: () => instance };
  yield ctx.slots.register({
    name: "main",
    key: PANEL_ID,          // "plugins"
    locale: NS,
    store,
    inject: () => face,
    children: { /* 子槽位声明表，见下 */ }
  }, PluginManagerPage);
  yield ctx.layout.panelInfo.subscribe(() => { /* ... */ });
  const disposeNavigation = ctx.reflect.provide("pluginNavigation", { /* ... */ });
  yield () => { disposeNavigation(); };
});
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,
  order: 0,
  label: () => t("panel"),
  locale: NS
}, PluginsPanelIcon));
```

要点：
- `main` 的 `inject` 回调可以是 **generator**，用 `yield` 交出 disposer / 订阅 / 清理函数，Cordis 会在条目卸载时按序回收。
- `children: {...}` 是**声明子槽位**的表（`{kind, scope}`）。我们 v1 不需要子槽位，可省略。
- `store` 是可选的 per-entry store（`@deepseek-ai/dsh-client-store` 的 handle）。v1 不需要。

---

## 9. 可复制骨架（本项目 M2 Task 7 起点）

### 9.1 `package.json` 增量

```json
{
  "name": "dsh-backup-sync",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"]
    }
  }
}
```

`dsh.client.inject` 里两项都是 boot 条目（已用 `boot-grep.mjs` 核对），语义是"这两个模块先到达"，与 §8.2 的槽位声明者一致。

### 9.2 `lib/client.js`（骨架，无 JSX，无打包器）

```js
window.__ModuleLoader__.load({
  id: 'dsh-backup-sync',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'backup-sync';
    const PANEL_LABEL = '备份同步';

    /** 侧边栏图标：ownerProps = { size, active } */
    function BackupSyncIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', {
          d: 'M8 1.5a6.5 6.5 0 1 0 6.5 6.5h-1.6A4.9 4.9 0 1 1 8 3.1z',
          fill: 'currentColor',
        }),
        h('path', { d: 'M8 1.5v3.2l2.6-1.6z', fill: 'currentColor' }),
      );
    }

    /** 主列面板：v1 只做只读占位，M2 Task 8 再填真实内容 */
    function BackupSyncPage() {
      return h('div', { style: { padding: '16px 20px', fontSize: '13px' } },
        h('h2', { style: { margin: '0 0 8px', fontSize: '15px' } }, PANEL_LABEL),
        h('p', { style: { margin: 0, opacity: 0.7 } }, '面板骨架已挂载。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 50,
          label: PANEL_LABEL,
        }, BackupSyncIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, BackupSyncPage));
      },
    };
  },
});
```

### 9.3 宿主半边（占位，M2 之后才填）

```js
// lib/index.js
export const name = 'backup-sync';
export function apply() {}
```

`templates/decoration/index.js` 就是两行：`export function apply() {}`。**宿主半边可以完全空着**，客户端照常工作 —— 这正是「装饰件」模板的形态。

---

## 10. 坑清单（按踩到概率排序）

1. **`id` 写错** → `loaded without registering "<id>"` → 该条目加载失败。必须严格等于 `package.json` 的 `name`（且结尾不要多写 `/client`，虽然会被剥掉，但没必要）。
2. **`inject` 里写不存在的 Cordis 服务名** → 条目 pending → `web boot: N entries did not activate` → **致命恢复框**（第三个按钮会清掉用户的 `cordis.patch.yml` 和 `dsh.profile.bundles`）。只写 `['slots']`。
3. **`main` 用 `key: 'conversation'`** → 遮蔽内置对话面板（`replaceRisk: shadows-shipped-ui`）。
4. **`panellist.id` 与 `main.key` 不一致** → 侧边栏能点，但主列切不过去（或切到空白）。
5. **`keyed` 槽位漏 `key`、`list` 槽位漏 `id`** → `register` 直接抛错。
6. **bundle 被执行两次** → `duplicate factory registration`。热重载/手工插入 `<script>` 重复时要走 `invalidate`，不能重放。
7. **`require` 一个非种子、非 boot 条目的 specifier** → 抛 `missed the module table`。想用别的核心模块必须把它写进 `dsh.client.inject` **且它本身是 boot 条目**。
8. **在 `load()` 外面写副作用**（顶层跑 CSS 注入等） → 在平台未就绪时执行。副作用一律放 factory 内。
9. **误以为 `dsh.client.inject` 里的共享库模块（primitives / ui-slots / client-runtime）需要 404 校验** → 它们是种子表或静默跳过项，404 属正常。
10. **给 `panellist` 传 `locale` 命名空间但没注册对应字典** → 标签可能解析不到。v1 用普通字符串 `label`，不传 `locale`。
11. **用 JSX 直接写** → 没有打包器，浏览器不认。用 `React.createElement`，或 `require('react/jsx-runtime')` 后手工调 `jsx(type, props, key)`。

---

## 11. 待验证项（M2 Task 7/8 落地时实测确认）

1. `immediately` 的确切语义（推测与「不等依赖就立即加载」有关）—— 本机没有第三方插件用它，源码里只做了类型校验。**v1 不写这个字段。**
2. `platform` 除 `"web"` 外是否还有别的合法值 —— 本机全部插件都写 `"web"`。
3. `main` 面板组件收到的 standardProps hooks 的实际形状（`usePanelInfo` 等）—— v1 不需要，M2 Task 8 做真实 UI 时再探。
4. `sidebar.panellist` 的 `active` 何时为 true、图标是否被强制要求是 SVG（内核范例用 SVG，但契约只写了 `size`/`active`）。
5. 面板切换后 `main` 组件是否被卸载重挂（影响我们放多少状态在组件内）。

---

## 12. 一句话给未来的自己

**「照抄 `dsh-client-ui-plugin-manager` 的 `sidebar.panellist` + `main` 两段注册，把 `id`/`key` 换成 `backup-sync`，`inject` 只留 `['slots']`，其余别动。」**
