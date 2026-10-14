# 备份同步（dsh-backup-sync）实施计划

> **给执行者的必读**：设计见同目录 `2026-10-13-backup-sync-design.md`。本计划按 TDD 推进：每个 Task 先写失败测试 → 跑一次看到它失败 → 写最小实现 → 跑通 → 提交。

**Goal:** 造一个 DSH 插件，用「上下文洞察」式的中央栏面板，可视化地备份/恢复本机 DSH 资产（技能、插件、配置、记忆、待办、对话），并支持带基线的增量导入。

**Architecture:** 宿主半边（Node，零依赖）负责扫描 / 归档 / 基线 / 三方差分 / 执行；客户端半边（手写 `window.__ModuleLoader__` bundle，不引打包器）负责中央栏面板。以 HTTP loopback 路由连通两侧。

**Tech Stack:** 纯 ESM JavaScript（Node 24/25）· `node:test` + `node:assert` · `node:crypto` · 系统 `tar`（bsdtar）· `git` 子进程 · React（由模块加载器提供，手写 `createElement`）

**工程目录:** `<仓库目录>\`
**开发 profile:** `dev`（用 `dsh --from-default-profile web dev` 建，**不碰 desktop profile**）

---

## 文件布局

```
<仓库目录>\
├─ package.json
├─ cordis.patch.yml
├─ docs\plans\            设计 + 本计划
├─ scripts\
│   ├─ scan-report.mjs    真机只读扫描报告
│   ├─ backup-now.mjs     真机打真包（命令行版备份）
│   └─ verify-restore.mjs 真机验收：真包 → 空机器 → 四遍核对 ★
├─ lib\
│   ├─ index.js           宿主半边入口：apply(ctx)，注册工具/命令/HTTP 路由
│   ├─ paths.js           根路径解析（DSH_HOME / USER_HOME 可注入，便于测试）
│   ├─ hash.js            流式 sha256（大文件不爆内存）
│   ├─ modules.js         【M1】模块 → 文件清单映射（纯函数）
│   ├─ scan.js            【M1】扫描 + sha256 + 计数（纯逻辑，可注入根）
│   ├─ baseline.js        【M1】基线库读写（纯逻辑）
│   ├─ diff.js            【M3】三方比较 → 动作计划（纯函数）
│   ├─ archive.js         【M3】tar.gz + sha256 边车
│   ├─ apply.js           【M3】按计划写盘（先快照后写，写完回算哈希）
│   ├─ server.js          【M3】loopback HTTP 路由
│   └─ client.js          【M2】客户端 bundle（手写外壳）
└─ test\
    ├─ fixture.js         共享仿真树夹具（含 empty:true 造「全新空机器」）
    ├─ modules.test.js
    ├─ scan.test.js
    ├─ baseline.test.js
    ├─ diff.test.js
    ├─ archive.test.js
    └─ apply.test.js
```

**跑测试**：`node --test`（**不要**带 `test/` 位置参数 —— Node 会把它当成模块去 require 而报 `Cannot find module`）。
**跑真机验收**：`node scripts/verify-restore.mjs`（只写临时目录，不碰真实 `~/.dsh`）。

---

## M1 · 引擎地基（零网络依赖，纯 Node 可测）

### Task 1: 工程骨架

**Files:**
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `.gitignore`

**不要**声明 `peerDependencies` 里的 `@deepseek-ai/dsh*` —— 内核只校验这个，范围对不上会拒装；本地插件不声明最省事（见设计 §2.3 与全局踩坑记录）。

`package.json` 要点：`"type":"module"`、`main: "lib/index.js"`、`exports` 暴露 `.` 与 `./cordis.patch.yml`、`dsh.bundle.patch` 指向 patch 文件、`scripts.test = "node --test test/"`。

**验证:** `node --test test/` 能跑（此时无测试文件，0 pass 0 fail）。

---

### Task 2: `paths.js` —— 根路径解析

**Files:**
- Create: `lib/paths.js`
- Test: 无独立测试（被 scan 测试间接覆盖）

**要求:** 导出 `resolveRoots(env)`，返回 `{ dshHome, userHome, profile, agentsSkills }`。
- `dshHome` 取 `env.DSH_HOME`，缺省 `~/.dsh`
- `userHome` 取 `env.USERPROFILE` / `env.HOME`
- `agentsSkills` = `<userHome>/.agents/skills` —— **关键：技能不在 `~/.dsh` 里**
- 允许调用方整体覆盖，以便测试注入 fixture 根

---

### Task 3: `modules.js` —— 模块 → 文件清单映射 ★核心

**Files:**
- Create: `lib/modules.js`
- Test: `test/modules.test.js`

**导出:**
- `MODULE_IDS = ['skills','plugins','config','memory','todo','sessions']`
- `MODULE_META`：每个模块的 `{ label, defaultChecked, countKind }`
  - `todo` / `memory` 用 `countKind: 'file'`（条目数在 scan 阶段另算）
  - `sessions.defaultChecked = false`（红线：公司对话记录不上云）
- `isTodoPath(relPath)` → boolean，判定 `memories/` 下的相对路径是否属待办
- `matchModule(moduleId, relPath)` → boolean
- `listModuleRoots(roots)` → `[{ moduleId, base, include, exclude }]`

**待办模式（必须精确）：**
```
TODOS-life.md
TODOS-work.md
projects/<hash>/TODOS.md
daily/YYYY-MM-DD.todo.md
```
**记忆 = `memories/**` 减去上述四条。**

**测试必须覆盖的断言：**
1. `daily/2026-10-13.md` → 记忆；`daily/2026-10-13.todo.md` → 待办
2. `projects/0c4f6561d62a/MEMORY.md` → 记忆；`projects/0c4f6561d62a/TODOS.md` → 待办
3. `projects/0c4f6561d62a/KEY.md` → 记忆
4. `TODOS-life.md` / `TODOS-work.md` → 待办
5. `MEMORY.md` / `USER.md` / `SUGGESTIONS.jsonl` / `advisor/**` → 记忆
6. **互斥性**：遍历 fixture 里每一个相对路径，断言它**恰好**属于一个模块（防止将来加模式时切重）

---

### Task 4: `scan.js` —— 扫描 + 哈希 + 计数

**Files:**
- Create: `lib/scan.js`
- Test: `test/scan.test.js`

**导出 `scan(roots, { modules })` →**
```js
{
  modules: {
    skills: { entries: [ {relPath, absPath, size, mtimeMs, sha256} ], count: 10, bytes: 140432 },
    todo:   { entries: [...], count: 23, bytes: 8192 },
    // …
  },
  warnings: [ { path, reason } ],
  totals: { count, bytes }
}
```
- 递归遍历每个模块根的 `include`，套 `exclude`
- 每文件算 sha256（`node:crypto`，流式，避免大文件吃内存）
- **读不到的文件不抛异常**，记入 `warnings`（权限/占用是常态）
- `todo.count` 是**条目数**而非文件数：解析 `TODOS*.md` / `*.todo.md` 中带 8 位 id 的行

**测试：** 用 `fs.mkdtemp` 造 fixture 树 → 断言记忆与待办被正确分开、哈希稳定、警告不致命。

---

### Task 5: `baseline.js` —— 基线库读写

**Files:**
- Create: `lib/baseline.js`
- Test: `test/baseline.test.js`

**导出:** `loadBaseline(file)` / `saveBaseline(file, data)` / `keyOf(moduleId, relPath)`
- 文件缺失 → 返回空基线（**不是错误**）
- JSON 解析失败 → 返回 `{ ok:false, corrupted:true }`，**不静默当空**（界面要显式警告）
- 写入用 `.tmp-<uuid>` + 原子改名
- `keyOf` = `` `${moduleId}:${relPath}` ``

**测试：** 缺失文件、损坏 JSON、正常往返、原子写入不产生残留 tmp。

---

## M2 · 客户端面板（先逆向契约，再写 UI）

### Task 6: 逆向 `__ModuleLoader__` 契约 ✅ 已完成 ★全项目最大未知

**产出**：`docs/notes/module-loader-contract.md`（12 节，全部结论带出处行号）。内核自带的 90 条槽位目录只在开发时抽出来对照，**不随仓库发布**（那是对内核声明文件的逐字拷贝，属第三方代码）。

**五个问题的答案：**

1. **模块导出**：`factory(require)` 的**返回值就是 exports**，宿主读 `exports.apply` / `exports.inject`。真实范例 `dsh-client-ui-plugin-manager/lib/client.js:3778-3782` 写 `exports.apply = apply; exports.inject = inject; return module.exports;`；官方模板用对象字面量 `{ inject:['slots'], apply(ctx){} }`，等价。执行 bundle **只注册 factory**，模块体副作用（含 CSS 注入）在**物化**时才跑。
2. **`require` 能拿到什么**：解析链 = 平台种子表 → `loadCache` → 已注册 factory（同步物化）→ 否则抛错。**种子表只有 9 项**：`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-dockkit`。其余 `@deepseek-ai/*` 必须先作为 boot 条目到达。`dsh.client.inject` 里**不是 boot 条目的模块会被静默跳过**（源码 `client.js:656-659` 的 `if (dependency !== void 0)`）→ 404 属正常，不是缺依赖。
3. **面板列表槽位** = `sidebar.panellist`（kind `list`, scope `root`），注册选项 `{id 必需, order, label: string|(()=>string)}`，组件收到 `{size, active}` 且**渲染的是图标**。`label` 给普通字符串即可（侧边栏用 `resolveSlotLabel(options.label) ?? id`，**不读 `locale`**）。
4. **中央栏面板槽位** = `main`（kind `keyed`, scope `root`），注册选项 `{key 必需}`。配对机制是文档原文「**Each list id addresses the matching main panel**」→ 侧边栏按钮用自己的 `id` 调 `ctx.layout.selectPanel(id)`，主列按同一字符串取 `main` 的 key。`conversation` 已被内置对话占用，`replaceRisk: shadows-shipped-ui`。
5. **服务名红线**：`inject` 写不存在的服务 → 条目 pending → `web boot: N entries did not activate` → 致命恢复框。本机**不存在** `settingsScope`（`dsh-ping` 1.9.0 因此必崩）。**本插件只写 `['slots']`**，其余服务用 `ctx.get()` 懒解析。

**关键方法（可复用）**：内核源码已解包在 `<内核解包目录>\dsh\node_modules\@deepseek-ai\`，其中 `dsh-client-modules`、`dsh-client-ui-sidebar`、`dsh-client-ui-plugin-manager` 等都是**未压缩**的（带 JSDoc 注释和源码行号），直接读即可，不必展开压缩产物。
新增工具：`<工具目录>\strings.mjs <file> <regex> [before] [after]`（从单行压缩 bundle 里带上下文抽字符串）、`<工具目录>\extract-slot-catalog.mjs`（抽出内核 90 条槽位目录）。

**实测核对**：`@deepseek-ai/dsh-client-ui-sidebar` 与 `@deepseek-ai/dsh-client-ui-layout` 均确认为 boot 条目（`boot-grep.mjs`，75 条中命中 2 条），故可安全写进 `dsh.client.inject`。

---

### Task 7: 客户端 bundle 外壳 ✅ 已完成（离线部分；真机验证待做）

**产出**：`lib/client.js`（约 200 行）、`package.json` 加 `exports["./client"]` + `dsh.client`、`test/client.test.js`（14 项离线契约测试）。

**实现要点**：
- 外壳 `window.__ModuleLoader__.load({ id:'dsh-backup-sync', factory })`，`id` 严格等于包名。
- 模块导出 `inject: ['slots']`（**只此一项**），其余服务一律不用；`apply(ctx)` 里注册两个槽位。
- `sidebar.panellist`：`{ name, id:'backup-sync', order:50, label:'备份同步' }` + 内联 SVG 图标（`rect` + 直线 `path`，几何简单到可肉眼验证）。**不传 `locale`**（侧边栏用 `resolveSlotLabel(label) ?? id`，普通字符串即可）。
- `main`：`{ name, key:'backup-sync' }` —— 与 panellist 的 `id` 同一字符串，这是配对机制。
- 面板为只读骨架：六张模块卡片（技能/插件/配置/记忆/待办/对话），对话卡片带「本地专用 · 不上云」徽标，计数先显示 `—`（数据接入是 Task 8）。
- 全部样式走内联 `style`，不用 CSS 注入，避免 factory 外的副作用。

**离线验证（`node --test`，14 项，123/123 全绿）**：用 `node:vm` 造假的 `window.__ModuleLoader__` 与假 `require`，把 bundle 原样跑一遍，覆盖：
① `id` 等于包名；② 只 require 平台种子词或 `dsh.client.inject` 已声明的条目；③ `dsh.client` 声明合法且 `inject` 里不是服务名（模块 id 与服务名混淆是经典错误）；④ `exports["./client"]` 存在；⑤ `inject` 恰为 `['slots']`；⑥ 恰好注册两个槽位；⑦ `panellist` 有 `id`、`label` 是字符串、不传 `locale`；⑧ `main` 有 `key` 且与 `id` 一致；⑨ `main.key !== 'conversation'`；⑩ 图标在 `{size,active}`/`undefined`/`{}` 下都渲染出 `svg`；⑪ 非法 `size` 回退 16；⑫ SVG `d` 属性语法合法且只用简单图元；⑬ 面板含六张卡片与「本地专用 · 不上云」；⑭ 顶层无副作用（在无 `document` 的假 window 里跑不抛错）。

**待做（真机）**：装进 dev profile → `GET /` 的 `__DSH_BOOT__` 出现本插件条目 → 面板列表出现「备份同步」→ 点击后主列切到本插件面板。

---

### Task 8a: 宿主半边（HTTP 接口 + 业务层）✅ 已完成 ★原计划外的关键补课

原计划把 Task 8 写成「`lib/server.js` 一个 GET 路由」，真动手才发现**接口契约必须先逆向**，否则写出来根本注册不上：路由 API 是 `ctx.get('connection').fetch.register({ path, methods, requestBody, fetch })`，带三条硬约束（路径必须在 `/api/` 下且每段匹配 `[A-Za-z0-9_$.-]+`、方法非空不重复、同路径只能注册一次），鉴权由内核自动套上。全部记在 `docs/notes/module-loader-contract.md`。
桌面端更省事：Electron 主进程把 `dsh-app://app/*` 的请求全量转发给本地 Host 并**自己注入 cookie**（`main.js` 的 `forwardWebRequest`），所以客户端里 `fetch('/api/dsh-backup-sync/state')` 就够了，不用碰凭据。

**实际结果（4 个新文件 + 1 处改动，21 项新测试，全仓 144/144 通过）：**
- `lib/service.js` —— 业务层，与 HTTP 完全解耦所以能离线测：`collectState` / `runBackup` / `previewImport` / `applyImport` / `verifyArchiveFull` / `syncCopy` / `syncList`
- `lib/routes.js` —— `/api/dsh-backup-sync/` 下 8 条路由：`state` / `settings` / `backup` / `import/preview` / `import/apply` / `verify` / `sync/push` / `sync/list`。异常一律转成 `{ok:false,error}`，界面上不会出现英文堆栈
- `lib/settings.js` —— 自己的设置放 `~/.dsh/backup-sync/settings.json`。**刻意不写 `cordis.patch.yml`**：那是 DSH 托管配置，写坏会触发致命恢复并把用户全部自定义重置
- `lib/index.js` —— 宿主入口 `export { name, inject, apply }`（对照已装的 `dsh-context`）。`inject` **留空**，路由在 `apply` 里用 `ctx.inject(['connection'], …)` 懒等：服务没到位只是少个接口，不会让插件停在 pending
- `lib/paths.js` 加 `launchEnvReader` / `rootsFromContext` —— 根路径优先从内核的 `launchEnvironment` 服务取，`process.env` 兜底。解析错了会备份到空目录、导入时写错位置，所以另有 `sanityOf()` 做写前体检：**profile 目录不存在就拒绝一切写操作**

★ **两处实测得出的重要订正（方向都是真丢数据，已写进代码注释）：**

1. **基线更新必须「只覆盖本次参与的模块」，不能整份重写。** 原 `scripts/backup-now.mjs` 是整份重写 —— 一次「只备份技能」会把插件/记忆的基线键抹掉，下次导入那些模块就退化成「首次导入」，可能拿旧包覆盖本机新改动。
2. **首次导入时基准必须留空，绝不能拿包内基线当基准。** 包内基线描述的是「打包那台机器当时的文件」，不是本机的历史。拿它当基准会在新机器上把「本地根本没有这个文件」判成「本地已删除、归档未改动 → 保持删除」（`diff.js` 里 `o===null && t===b` 那条分支）→ **首次导入一个文件都不写，而界面还显示成功** —— 静默失效比报错更糟。真机验收脚本 `verify-restore.mjs` 第一遍用的正是空基准，与此一致。包内基线仍读出来，但只用于**溯源展示**（这包来自哪台机器、上次同步时间）。测试里专门有一条「源机已同步过、包内基线非空」的用例守这个点。

---

### Task 8: 面板 UI ✅ 已完成
**Files:** Modify: `lib/client.js`（宿主半边见 Task 8a）

**实际结果（约 1100 行客户端 bundle，47 项离线契约测试，全仓 187/187 通过）**：一个面板，四个页签。

- **备份**：六张模块卡片（勾选框 + 条目数 + 文件数 + 体积 + 逐文件清单可展开），对话卡片标注「本地专用 · 不上云」且默认不勾；汇总条实时算「已选 N 个模块 · M 个文件 · X KB」；备份目录可改；「基线进包」开关；**二次确认弹框**把模块名、文件数、原始大小、输出目录、命名规则一次列清，勾了对话会额外警告内容随包外流；完成后摆出包名/大小/路径/完整 sha256/边车校验结果。
- **历史版本**：列出每份包的名称、时间、大小、来源机器、模块数、文件数，每行给「校验 / 导入 / 复制路径」；校验结果如实报「逐文件重算哈希 N 个、不符 M 个」并逐条列出不符项。
- **导入**：选包（下拉历史包 或 填绝对路径）→「分析差异」→ 计数网格六格（含 0，避免用户以为漏了一格）+ **比较基准来源说明**（本机没同步过时明说「全部按新增处理」，并注明包内基线「仅用于溯源，不参与比较」）→ 冲突逐条列出（模块·相对路径、本地/归档/基准三方哈希前缀、宿主给的原因、两个单选项）→ 动作明细按动作分组可展开 →「执行导入」→ 二次确认 → 结果（写入数、写入后校验数、快照目录、未裁决冲突、基线路径、失败项）。
- **同步**：同步文件夹 + 「推送最新备份过去 / 列出文件夹里的包」；明确写清这是「复制到文件夹」（U 盘 / OneDrive / 坚果云目录），边车文件一起复制，git 与 WebDAV 是二期。

**两条设计上的硬约束（都有测试守着）：**

1. **冲突默认「未裁决」，绝不预选任何一侧。** 预选等于替用户做决定；不选时宿主按「保留本地（安全默认）」处理并在结果里报 `conflictsUnresolved`，所以一路点下去也覆盖不掉用户自己的改动。
2. **删除本地文件默认关闭**，且开关一打开文案立刻从「默认不删任何本地文件」换成警告，写清只有「归档删了、本地一直没改过」的才会删。

★ **测试期间抓到并修掉的一个真缺陷**：`renderImportTab` 原来在 `preview === null` 时直接 `return`，而执行导入成功后代码会把 `preview` 清空 —— 结果就是**导入明明成功，用户却看不到任何结果**。已把「导入结果」块拆成独立的 `renderApplyResult()`，与 preview 解耦。

★ **测试方法上的一个坑**：`renderPanel` 是纯函数，但它返回的树里 `h(Button, ...)`、`h(KeyValues, {pairs})` 这些**函数组件只是个壳**，props 里的内容（pairs/entries/counts）根本不在 `children` 上，直接 `textOf` 断言会全部落空 —— 这是最容易写出「假绿灯」的地方。测试里因此写了一个 `expand()` 迷你渲染器把组件递归展开成最终 DOM 形状，断言才真正落到用户看得见的文字上。

---

## M3 · 归档 / 差分 / 增量导入（一期目标达成）

### Task 9: `archive.js` ✅ 已完成
`tar -czf` 到 `.tmp-<uuid>` → 算 sha256 → 原子改名 → 写 `.sha256` 与 `.meta.json` 边车（`meta` 含模块清单、条目数、机器名、时间）。

**实际结果（433 行，22 项测试）**：包内布局是**自描述**的 `manifest.json` + `RESTORE.md` + `dsh/` + `agents/` + `sync/state.json`，仍是任何工具都能直接打开的普通 `tar.gz`。
⚠️ **订正原计划的一句话**：「与 dsh-backup 同构，保证交叉可恢复」是**不成立的** —— dsh-backup 的 `restore` 只认它自己的布局，跨工具恢复只能手工拷文件。所以这里不再宣称自动兼容，改为「布局自描述 + 有 RESTORE.md 指引 + 附带 sha256 边车」。
额外落地的护栏：清单校验拒绝路径穿越（`../`、绝对路径、`C:` 盘符），打包用 spawn 数组传参（不过 shell），staging 与 `.part-` 临时名保证同盘原子改名。
另加 `prefixForAbs()` 反查（绝对路径 → 包内前缀），供快照复用同一套布局。

### Task 10: `diff.js` —— 三方比较 ★核心 ✅ 已完成
**Files:** `lib/diff.js`, `test/diff.test.js`

**实际结果（126 行，19 项测试）**：存在性组合按 14 行真值表穷举，落到 **4 种**真冲突（原计划写「十种情况」，是估的，实际以真值表为准）：① 双方各自新增同名不同内容 ② 本地删了但归档改了 ③ 归档删了但本地改了 ④ 双方都改了且结果不同。
★ 额外发现并写进设计 §4.2.1 的**选择性备份陷阱**：归档只含勾选模块时，未勾选模块的文件在 `incoming` 里全体缺席，不加保护就会被判成「归档已删除」→ 删掉本地记忆/配置/对话。因此 `diffFiles` **必须**收到归档声明的 `modules`，范围外一律 `skip`。
`allowDelete` 默认 **false**（恢复不该删本地的东西）。
`shaOf()` 容忍 `{key:{sha256}}` 与 `{key:'sha'}` 两种写法 —— 只认前者时误传后者会静默把每个文件判成「本地已删除」，方向正好是删数据。

### Task 11: `apply.js` —— 执行计划 ✅ 已完成
**实际结果（294 行，24 项测试）**：三条写入不变量 ——
① **先快照**：只快照**本次会被覆盖或删除的文件**（原计划写「整树快照」，实测没必要且会让快照膨胀几十倍），落到 `backup-sync/pre-restore-<时间戳>/`，**沿用归档布局**（`dsh/` + `agents/`）→ 那份快照本身就是一个能原样还原的包；写完校验不过也用它回滚。
② **冲突未裁决 = 一个字都不改**，如实记进 `conflictsUnresolved`。
③ **写完回算 sha256**，不符则回滚（有快照就还原、本来不存在就删掉半成品）并计入 `failed`。
★ **一个反直觉但很关键的点**：冲突裁决为「保留本地」之后，基线要记**归档版本**当共同祖先，**不能记本地版本**。记本地版本会让下次导入判成「归档改了、本地没动」→ 擅自把用户刚裁决保留的版本覆盖掉，等于裁决白做；记归档版本则判成「只有本地改了」→ 静默保留、不再打扰。
另加 `resolveAbs()`：键 → 绝对路径必须过模块自己的 `include` 谓词（记忆与待办共用 `memories` 一个根，只差文件后缀，不判谓词就会写错位置），并挡路径穿越。
`allowDelete` 在这里是**第二道锁**：计划里出现 `delete` 但没开删除时，执行器自己再拒一次。

### Task 11b: 真机验收脚本 ✅ 已完成（原计划外，但这是唯一算数的证明）
`scripts/verify-restore.mjs` —— 拿**真实备份包**在全新空目录上跑四遍，全程不碰真实 `~/.dsh`：
1. **首次导入** → 49/49 文件哈希校验通过，与包内内容逐文件一致
2. **幂等**：同一个包再导入 → 49 个全 `same`，0 导入 0 冲突，文件无任何变动
3. **单方改动**：目标机改一个文件再导入 → 静默保留本地，不问也不改
4. **真冲突**：源侧也改同一个文件并重新打包 → 恰好 1 个冲突；裁决采用归档版后本地换成归档版、**原件进了快照**、裁决后与源机逐文件一致
真机实测（`dsh-sync-20261013-180657.tar.gz`，181.9 KB / 49 文件）：**四遍全通过**。

### Task 12: 冲突裁决 UI + 备份按钮 + 历史版本 ✅ 已完成（并入 Task 8）
接 M2 的面板：勾选 → 汇总 → 二次确认 → 生成包；导入 → 差异预览 → 冲突逐项裁决。全部落在 `lib/client.js`，详见 Task 8 的实际结果。

---

## M3.5 · 真机验收与缺陷修复（2026-10-13 夜，原计划外）

一期功能齐了之后，真机跑动暴露出**三个原计划没预见的缺陷**和一个**关键运维事实**。全部已修并有回归测试。

### 补课 1：凭据守卫 `lib/guard.js`（159 行，13 项测试）★安全底线

**触发原因**：打包清单里出现了 `.npmrc`。查过内容只有 `store-dir=…`（54 B），没泄露；但它暴露了一个事实 —— **扫描器对凭据零过滤**。`.credentials.yaml`（明文 API key + DSH 会话密钥）没进包，纯粹是因为「恰好没有任何模块根覆盖 `dshHome` 根目录」。这种**靠巧合的安全**等于没有安全：以后任何人加一个根、或用户挪一次文件位置，明文密钥就会静默进包、再被推到云上。

两道闸（命中一律**剔除文件**并记进 `result.credentials`，由界面显著提示，绝不静默跳过）：

| 闸 | 位置 | 规则 | 代价 |
|---|---|---|---|
| 文件名闸 | `inspectPath(relPath)` | 23 个 basename（`.credentials.*`/`credentials.*`/`secrets.*`/`auth.json`/`github.token`/`.netrc`/`.git-credentials`/`id_rsa` 等）+ 7 个后缀（`.pem/.key/.pfx/.p12/.keystore/.jks/.ppk`） | 不看内容，零误报风险 |
| 内容闸 | `inspectContentMatch(text)` | 10 条**高信号**规则：私钥文件头 / npm 令牌 / GitHub 令牌 / GitHub 细粒度令牌 / OpenAI 风格密钥 / AWS Access Key / Slack 令牌 / JWT / 带令牌的 git 地址 / 字面量 Bearer | 必然有误报，故只收真令牌形态 |

体积上限 `MAX_GUARD_BYTES = 1 MiB`（凭据都是小文件，超限的只走文件名闸）。

★ **一次真实误报，教训写进代码注释**：首版规则 `x-access-token:[^@\s/]+@` 把项目记忆里那句
「凭据以 `https://x-access-token:<token>@github.com` 写入 git credential helper」的**字面量占位符**当成真令牌，
直接把那份记忆文件挡在备份之外。修法是**凡是「密钥部分」都要求真实令牌的字符形态与长度**（`[A-Za-z0-9_-]{20,}`），
占位符（`<...>`、`${...}`、`xxx`）一律不匹配；并把这两句占位符写进测试的良性样本表。
真机复验：**0 个拦截**。

★ 还加了**打码片段**：只报规则名，用户无法判断「这是占位符」还是「这是我的真令牌」；
给出 `头6…尾2` 的片段，一眼可辨，同时 reason 字符串本身不成为新的泄露面。

### 补课 2：UI 显示的是宿主原始计数 → 冲突裁决后数字不对（真机缺陷）

**症状**：导入页点「全部采用归档」后，计数格仍显示「待裁决 1 / 导入 0」，二次确认弹窗写「将写入 没有任何差异」，
**但点下去真的写了 1 个文件**。

**根因**：`diff.js` 的 `counts` 里 `conflict` 是**独立键**，**不折算进** `import`/`keep`；
而 `apply.js` 的 `counts.import` **是**包含「冲突裁决为归档」的那些文件的。界面直接渲染宿主的 `preview.counts`，
于是「预览」与「实际写入」两套口径打架。

**修法**：客户端新增纯函数 `effectiveCounts(preview, resolutions)` —— 拷贝一份 `preview.counts`，
逐条读 `resolutions[c.key]`：`archive` → `import += 1`；`local` → `keep += 1`；其余 → `unresolved += 1`；
最后 `counts.conflict = unresolved`（永不改宿主对象）。配套 `effectiveWriteCount(c) = import + delete`。
8 项回归测试锁住。

★ **同时锁住三条 UI 级不变量**：冲突永不预选；未裁决按保留本地处理且**没东西可写时「执行导入」保持禁用**；
删除开关默认关闭，一旦打开文案立刻切成警告。

### 补课 3：换目录备份后「历史版本」是空的（真机缺陷）

**症状**：在输出目录里填了自定义目录、备份成功，切到「历史版本」点刷新 —— 空。再切回来，**看起来像备份丢了**。

**两个原因叠加**：
1. `POST /backup` **从不持久化** `outDir` —— 打完包一切换页签，客户端重新 `/state` 时不带 `outDir`，弹回默认目录；
2. 「历史版本」的刷新按钮调 `load()` **不带参数**，把输入框里刚打的字丢了。

**修法**：
- `lib/routes.js`：只持久化**显式传进来**的 `outDir`（`requested !== '' && requested !== settings.outDir` 才写）。
  **默认值绝不固化进 `settings.json`** —— 否则以后改默认目录，老用户永远拿不到新默认值。
- `lib/client.js`：抽出 `requestOutDir(ui)`（空/空白 → `undefined`，让宿主走设置/默认值；否则 trim），
  四处调用点全部改走它。**漏掉的那一处正是「历史版本」的刷新按钮** —— 所以另加一条**源码扫描测试**：
  断言 `lib/client.js` 里不再出现手写的 `ui.outDir.trim() === ''` 三元表达式。

### 关键运维事实：客户端热重载，**宿主半边不热重载**

这一条坑掉了一整轮验收，必须记下来。

| 半边 | 是否热重载 | 机制 / 证据 |
|---|---|---|
| `lib/client.js`（面板 UI） | ✅ 会 | `@deepseek-ai/dsh-client-hmr` 每 500 ms stat 每个图行的 bundle，变了就 `clientModules.rebuilt(id)` 并经 SSE `/plugins/events` 推 `{type:"rebuilt",id,rev}`；客户端 `entries.reload(id, rev)` → `invalidate` + `removeOwnedStyles` + `reconcile`。**实测：改完不刷新页面，新行为立刻出现。** |
| `lib/index.js` / `lib/routes.js`（宿主） | ❌ 不会 | `@deepseek-ai/dsh-hmr` 的 `Config.ignored` 默认含 `**/node_modules`，且派发处 `isExcluded = url => url.startsWith("node:") \|\| url.includes("/node_modules/")` —— 插件经 `profiles/*/node_modules` 的 **junction** 加载，`/node_modules/` 命中即被排除；watcher 本身也 prune 掉 `**/node_modules`。唯一活重载路径 `reconcileProfilePatches`（`dsh-app-boot/lib/index.js:3468`）只由 `setBundleEnabled`/`setPluginEnabled` 驱动。 |

**实测证据**：`touch` 掉 `lib/index.js`、`lib/routes.js`（真路径与经 `profiles/desktop/node_modules/…` 两条都试）后
`POST /backup {outDir}` 仍返回 `settings.outDir = null`；`GET /state` 的 `scan` 键里**没有 `credentials`** ——
说明跑着的宿主是 19:2x 的代码，只有客户端半边是最新的。

**结论（写进验收纪律）**：**验宿主改动必须重启宿主**。桌面应用不能重启（它托管着当前会话，且启动失败会弹
「DeepSeek Harness 无法使用」的致命恢复框、第三个按钮会把用户的 `cordis.patch.yml` 改名并重置 bundles），
所以验收环境改为**另起一个独立 web 实例**：

```
dsh plugin --profile web add link:<仓库目录>   # 空壳 web profile，装完即用
dsh web --port 19399 --no-open                                   # 与 19387 的桌面实例并存，互不干扰
```
注意 `dsh web` **已隐含 `--profile web`**，再写一次会报 `select a profile only once`。
会话 cookie 用同一个 `~/.dsh/.credentials.yaml` 里的 secret，但 authority 换成 `127.0.0.1:19399`。

（试过的另一条路 —— 把 `profiles/desktop` 整树复制到 D 盘独立 `DSH_HOME` —— **不可行**：
系统 `LongPathsEnabled = 0`，而 pnpm 的 `.pnpm/<pkg>@<ver>/node_modules/<pkg>/…` 已经贴着 260 字符上限，
目标路径一长就复制失败，实测 `.pnpm` 只进去 1 项。`profiles/web` 路径比 `desktop` 还短 4 字符，所以安全。）

#### 追加实测（2026-10-14 00:09）：桌面实例到底旧在哪一版，已经钉死了

上面那句「跑着的宿主是 19:2x 的代码」当时是**推断**，不是实测。00:09 用
`probe-desktop-host.mjs` 把它变成了**可复现的判定**，判据挑的是「只有真打一次包才观察得到」的那处行为
（`POST /backup` 持久化显式 outDir，commit `9763114` / `lib/routes.js` 20:58）：

| 探针 | 桌面实例 19387 的结果 | 说明 |
|---|---|---|
| `POST /state` | 200，`roots.profile = "desktop"`，`sanity.safe = true` | 入口与根目录解析**在桌面端是好的** |
| `scan` 计数 | `skills=10 plugins=4 config=2 memory=22 todo=4 sessions=56` | 与真机实际一致 |
| `POST /backup {moduleIds:["config"], outDir:<临时目录>}` | 200，包**确实落到了我指定的临时目录** | 备份链路在桌面端是通的 |
| 打完包后读 `settings.json` | `outDir` 仍是 `null` ❌ | **桌面宿主跑的是 20:58 之前的 `routes.js`** |

先做这一步还有个副作用是好的：它顺手证明了**桌面端 `/state`、`/backup` 两条路都活着**，
不是「只有 19399 能用」。

**这条陈旧对用户的真实影响，比一开始想的小**：`9763114` 修的是两个原因，第 2 条（「历史版本」刷新按钮
调 `load()` 不带参数）**是客户端半边**，而客户端半边是**按需从磁盘读 + HMR、永远最新**。
所以「填自定义目录 → 备份 → 切到历史版本」这条主路在桌面端**是通的**；残留的缺口只有一个：
**刷新页面/重开应用后，输入框清空 → `/state` 回到默认目录 → 历史版本列出的是默认目录**，需要重打一次目录。

**为什么不用 RPC 直接热重载掉这次重启**：查过 `reconcileProfilePatches`
（`dsh-app-boot/lib/index.js:3468`）—— 它把**整份新补丁表**交给根 Include 条目 `entry.update({config})`，
loader 只重建 **options 变了**的条目；本插件的补丁行是 `{id: backup-sync, name: dsh-backup-sync}`，
模块 URL 不变 ⇒ 复用原 fiber ⇒ **不会重新 import，拿不到新代码**。
`setBundleEnabled` 走的就是这条路。而在**无人值守**时关掉再打开插件行，万一重挂载失败就是
「客户端条目 pending → 下次开页面触发 `web boot: N entries did not activate` 致命恢复框」，
**没人能点那个「重启」**。风险与收益不成比例，所以选择让用户明早**手动重启一次 DSH**
（重启前已用 `check-client-bundles.mjs`（全 200）+ `verify-profile.mjs`（13 bundles / 依赖齐 /
`include:backup-sync` phase=active / 页面载荷 FOUND）验过 profile 完整，重启不会失败）。

### 真机验收结果（2026-10-13 夜）

**路由级（对 19399 的当前宿主，16/16 通过）**：`/backup` 自定义目录 → `settings.json` 已持久化 →
`GET /state` 不带 `outDir` 仍指向它且历史列表就是那个目录 → `/verify` 逐文件重算通过 →
`/import/preview` 返回 `{import:0,keep:0,delete:0,conflict:0,same:46,skip:4}` → `/settings` 可写可清空。

**界面级 `step11.mjs`（对 19399，30→36 项）**：备份页 6 张卡片 / 默认勾选 5 个 / 对话默认不勾且带「本地专用 · 不上云」/
汇总行「已选 5 个模块 · 50 个文件 · 436.5 KB」/ 二次确认弹窗逐项正确；
**凭据守卫端到端**：真造 `.env`（文件名闸）+ `notes.md`（内容闸，GitHub 令牌形态）→ 界面出现红色提示
「凭据守卫拦下 2 个文件」并逐条列出 `zz-guard-probe/.env —— 文件名属于凭据类（.env）`、
`zz-guard-probe/notes.md —— 内容命中「GitHub 令牌」（片段 ghp_Ab…Cd）`，**打码片段不复述完整令牌**；
删掉命中文件再刷新 → 提示消失（无误伤残留）；
**自定义目录往返**：打字 → 备份 `dsh-sync-20261013-214124.tar.gz` → 切「历史版本」刷新**能看到它**（缺陷回归）；
`settings.json` 确已持久化；历史行三按钮「校验 / 导入 / 复制路径」齐全，「校验」返回「逐文件重算哈希 50 个 · 不符 0 个」。

**边车命名（真机核实）**：`<archive>.tar.gz`、`<archive>.tar.gz.sha256`、`<archive>.tar.gz.meta.json` —— 后缀在 `.tar.gz` **之后**。

### 增量导入与冲突裁决的真机验收（2026-10-13 深夜补做）

一期最核心的两个承诺此前**只验到「预览算得对」，没验到「真的写对了盘」**。补了两轮界面驱动。

**为什么要绕一大圈**：`runBackup` 每次都会把基线改写成「刚扫到的内容」，
所以**普通备份之后再导入，任何本地改动都会被判成 `keep`**，永远写不出一个字节。
要制造真实写入，必须让归档内容与**当前基线**不一致 —— 于是两轮脚本都是
「打 A → 存基线 → 改文件 → 打 B → 把文件改回去 + 基线还原成 A 时刻」。
这条约束不写下来，下一个人会以为脚本在故弄玄虚。

**`step12.mjs`（增量导入写盘，21/21）**：预览「导入 1 / 无变化 50」→ 二次确认框
「将写入 导入 1」→ 执行后界面「导入完成 导入 1 · 无变化 50 / 写入后校验 1 个，失败 0 个 /
写前快照 `…pre-restore-20261013-222015`（1 个文件）」→ **磁盘上探针确实变成了归档里的 V2**，
快照里是被覆盖前的 V1 → 同一份包再分析一次得到「没有需要写入的内容，无需导入。」且按钮禁用（幂等）。

**`step13.mjs`（冲突裁决，34/34）**：构造 `本地 V3 / 基准 V1 / 归档 V2` 的真三方分叉。
逐项验到：报出 **1 处**冲突并把模块+路径摊开（`skills · zz-e2e-conflict/SKILL.md`）/
三行哈希互不相同 / 原因写明「双方都改了 → 需裁决」/
**两个单选绝不预选** / 未裁决时计数「待裁决 1、导入 0」且**「执行导入」禁用** /
提示写明「没选的会按「保留本地」处理」/ 「全部保留本地」→ 待裁决归零、计数「保留本地 1」、
**仍然不可写**（没有要写的东西）/ 「全部采用归档」→ 计数「导入 1」、按钮可用 /
**再切回保留本地又变回不可用（裁决可反复，不是单向闩锁）** / 逐条单选同样有效 /
执行后磁盘上是 V2、快照里是 V3（本地版没丢）/ 真实备份目录未被波及。

**结论**：`diff.js` 的 14 行真值表在界面上确实能走通，且三条红线（冲突不预选、
未裁决不可写、删除默认关）在真实交互里成立。

### 补课 4：两处「静默失效」（原计划外，都是真机照出来的）

**（a）401 被报成「接口返回的不是 JSON」，把排查引向错误方向。**
驱动脚本注入的签名 cookie 只有 1 小时有效期（`auth.mjs` 的 `expiresAt`），过期后
宿主回的是**纯文本** `authentication required`，`callApi` 走进 `res.json()` 的 catch，
报出「接口返回的不是 JSON（HTTP 401）」。**这害我误判了一整轮 step13 失败**
（真因是 cookie 过期，不是产品缺陷）。现在抽了纯函数 `authHint(status)`：
`401 → 会话已过期，刷新页面重新登录`；`403 → 来源地址不在信任列表`；其余照旧。

**（b）「复制路径」在剪贴板不可用时是个死按钮。**
原实现 `navigator.clipboard?.writeText(...).catch(() => {})` ——
自定义协议 `dsh-app://` 若不是安全上下文，`navigator.clipboard` **直接是 undefined**，
那个可选链连调用都不会发生，按钮点了毫无反应、也不报错。
现在 `copyToClipboard()` 先试现代 API，失败退 `execCommand` 老路（临时 textarea），
两条都不行才报失败，且**界面必须把路径本身摊出来让人手动复制**，不许只说一句「复制失败」。
（真机核实：桌面端 19387 与浏览器端 19399 的 `isSecureContext` 都是 `true`、
`navigator.clipboard.writeText` 都在 —— 所以老路是保险不是主路，但静默失效是真的。）

### 补课 5：备份页签补「重新统计」按钮

面板只在挂载时取一次数。用户改完磁盘上的技能/配置再切回来，汇总条显示的还是改之前的
数字 —— 而汇总条的整个意义就是「备份前看清有几条要备份」。截图逐个核对界面元素时发现缺这个入口。
忙碌时与「开始备份」一起禁用；`.dbs-bar-text` 加 `flex:1`（汇总条现在左右各有按钮，
靠 `space-between` 会把两个按钮撑成两端）。

---

## M5 · 定时备份 + 技能清单交互 + 文件只读查看（2026-10-14，已完成）

四条需求里第一条（把入口收进设置弹窗）**被撤回了**——想清楚后意识到 `备份同步`
是个完整工作区，塞进设置那个约 600 px 宽的内容列会把两件事都做坏。所以入口原地不动，
M5 只做剩下三件。

### Task 14: `lib/schedule.js` —— 纯逻辑（无 IO、无定时器）✅
`parseAt` / `normalizeSchedule` / `sanitizeScheduledModules` / `dueInfo` / `computeNextRun` /
`describeSchedule` / `pruneKeep` / `isOwnArchiveName`。
两条要害：① `sanitizeScheduledModules` **无条件剥掉 `sessions`**（无人值守硬闸）；
② `normalizeSchedule` 必须**幂等**——`saveSettings` 会再归一化一次，不幂等就会出现
「第一次存 `['sessions']` → `[]`，第二次存 `[]` → `null`」这种**静默扩大范围**的升级。

### Task 15: `lib/scheduler.js` —— 心跳状态机 ✅
`createScheduler({roots, loadSettings, runBackup, listArchiveDir, now, log})` →
`{tick, runNow, status, start, stop, execute}`。60 s tick，启动后延迟 15 s 起跳。
`schedule.json` 与 `settings.json` **分开放**（运行状态 vs 用户意图）。
★ 真机抓到的 bug：`missed` 分支不推进 `lastPointAt` ⇒ 错过一次之后**永远不再跑**。

### Task 16: `lib/skills.js` + `lib/fileview.js` ✅
`listSkills(roots)` → 一行一个技能（`{id, name, dir, path, description, descriptionSource,
files, bytes, mtimeMs}`），描述四级回退（frontmatter → 首段 → 首标题 → 无）。
`describeModuleFile(roots, {moduleId, relPath})` → 五道闸，`relPath` 相对**模块根**而非 `~/.dsh`；
所有拒绝都是 `viewable:false` + 中文 `reason`（域答案，不是接口失败）。

### Task 17: 宿主路由 + 界面 ✅
`/schedule`（GET/POST）、`/schedule/run-now`、`/skills`（GET/POST）、`/file`（POST），
`/state` 增加 `scheduleView`。界面：定时备份卡片（默认关、显式保存按钮、pin 范围开关、
立即跑一次）、技能卡改一行一个技能、技能弹窗、文件内容弹窗（可叠放）。

### Task 18: 真机验收 ✅
`step15.mjs`（40 项，定时备份含真出包与 `tar -tzf` 反查）、`step16.mjs`（37 项，
技能/文件交互），都进了 `run-all-verify.mjs`；套件改为每步还原
`settings.json` + `state.json` + `schedule.json`。

### Task 19: 验收期发现并修掉的真缺陷 —— 只发改动过的定时字段 ✅
`saveSchedule()` 原先把**整个表单**POST 给 `/schedule`，而宿主用 `k in body` 判断
「这次有没有改计时字段」→ 整表单提交时永远为真 → **每次保存都把计时起点重置成「现在」**，
设计里「改保留份数不动锚点」是死代码（`step15` 新增的硬断言把它逼了出来）。
修法：客户端纯函数 `schedulePatch(saved, form)` 只发**真正变动过**的键
（`moduleIds` 按 `JSON.stringify` 比、`includeBaseline` 缺省即 `true`），
一个键都没变就**不发请求**；`__internals` 导出，7 组单元测试锁死。

### Task 20: 收尾验收 ✅
`node --test` **422/422**；`node run-all-verify.mjs` 10 个脚本 **269/269 全绿、exit 0**
（`verify-19399-api` 16、`step5` 12、`step9` 28、`step10` 29、`step11` 38、`step16` 37、
`step14` 14、`step12` 21、`step13` 34、`step15` 40）。两个脚本红了 5 轮才全绿，
原因全在验收工具与历史残留，只有 Task 19 一条是真缺陷 —— 逐条记在
设计文档 §11.9 / §11.10 与下面第 22–27 条开发约定里。

### Task 21: 老宿主的 404 要说人话 ✅
界面半边（`link:` 安装）刷新即生效，宿主半边不热加载 → 「刚更新还没重启」时
界面新、接口旧，点新功能拿到 HTTP 404，而原文案 `接口返回的不是 JSON（HTTP 404）`
把「宿主是旧的」说成了「返回格式不对」。`authHint(404)` 改成给出动作：
「宿主里还没有这条接口…… 宿主部分要重启一次 DSH 才会生效」。
真机证据（带签名 cookie）：19387 三条新接口全 404、19399 全 200。
这属于交付物的一部分 —— 功能做完却留一句误导性报错，等于把调试留给用户。

---

## M6 · 入口搬进「设置」（2026-10-15，用户要求）

用户看到面板占着侧边栏最上面那一格，提出：

> 我感觉还是放在设置这里面好，因为不是高频操作，放在左侧菜单的左上角有点浪费空间，
> 未来可能需要留更多空间给到别的高频使用的插件入口

（早先他一度因为「设置里塞不下完整工作区」而放弃这个想法，看过截图后确认内容栏够用，
于是这个方向重新成立。）

### Task 22: `sidebar.panellist` + `main` → `settings.section` ✅
- **契约先读源码再动手**（内核 `dsh-client-ui-settings-general/lib/client.js`）：
  list 槽位只读 `id/order/label`；分区**只在选中时渲染**并收到 `{close}`；
  弹窗 800px − 左栏 188px − 内边距 48px = **内容宽 564px**；滚动由外壳 `.options` 负责；
  图标由外壳按 id 内置（未知 id 回退齿轮，塞不进自定义图标）。
- **注册**：只留 `settings.section`（`id: backup-sync`、`order: 50`、label 普通字符串），
  删掉两个老注册与只给侧边栏用的 `BackupSyncIcon`；`apply` 的 `inject` 从
  `['sidebar.panellist','main']` 收成 `['settings.section']`。
- **响应式**：`.dbs-grid` 的折行从**视口**媒体查询改成**容器查询**
  （查询容器 = `[data-dbs-tabbody]`；容器不能放 `.dbs-root` 上 —— `contain:layout`
  会把 `.dbs-overlay{position:fixed}` 的包含块改成容器本身，弹窗就跟着内容滚）。
  `.dbs-root` 去掉 `height:100%` / `overflow-y:auto` / 左右 22px 内边距（外壳已经给了）。
  ⇒ **同日晚些时候被 Task 24 推翻**：用户看过两列的效果后要求一列到底，容器查询整条撤掉。
- **测试**：注册类断言全部重写（只注册一个槽位、不再注册侧边栏与中栏、order 排在内核分区之后、
  分区组件收到 `{close}` 也照常渲染）；新增三条护栏 —— 网格不许按视口折行、根节点不许自带高度与滚动、
  浮层必须留在页签容器**外面**（CSS 断言 + DOM 结构断言双向锁死）。
- **驱动**：`ui.mjs` 的 `clickPanelEntry()` 改成「开设置 → 点左栏那一行」，两步都走页面内
  `element.click()`；`step5.mjs` 新增 4 条入口位置断言，并把页签切换从坐标点击改成页面内点击 +
  校验 `data-on="1"`。

### Task 23: 真机验收 ✅
`node --test` **423/423**（删 3 条图标用例、加 4 条）；`node run-all-verify.mjs`
（`DBS_UI_ORIGIN=http://127.0.0.1:19387`，桌面端宿主已重启、四条新接口全 200）
10 个脚本 **273/273 全绿、exit 0**。真机实测左栏顺序
`通用设置 / 模型 / 内置插件 / 技能 / Agent 预设 / 插件市场 / 通知提醒 / 备份同步 / 皮肤`，
分区宽 **559px**、侧边栏里已无同名入口。
（第一轮总跑是 7/10，三处红全是**驱动缺陷**、不是产品缺陷 —— 见 Task 24 第 2 条。）

### Task 24: 模块卡改一列 + 修掉三处驱动缺陷 ✅
- **决定做成一列**（两列在 559px 内容宽下每列只剩 ~270px，卡片挤成两行）。
  `.dbs-grid{grid-template-columns:1fr}`，删三列模板 / 两条 `@container` / `container-type`
  （一列与宽度无关；`container-type` 还带着 `contain:layout` 的浮层陷阱）。
  单测里「折行按容器宽度」改写为「一列到底」，浮层那条降级为结构保险。
- **修掉的三处驱动缺陷**（都会伪装成「产品坏了」，逐条都有实测数字）：
  1. **设置弹窗里坐标点击确定性失效** —— `ui.mjs` 的 `clickByText` 一直发合成鼠标事件；
     实测「开始备份」按钮 `hitOk:true` 却连点三轮不开弹窗，改用页面内 `element.click()`
     立刻三次全开。默认路径改成页面内点击，坐标路径留在 `{pointer:true}`。
  2. **`closeAllDialogs` 只认「关闭」** —— 备份确认框只有「取消 / 确认备份」，
     清不掉就把遮罩留在面板上，后面每次点击都打在遮罩上（`hitOk:false`）。
     改成按「关闭 → 取消」找。
  3. **固定 sleep + 立刻断言** —— `step16` 第二次开技能弹窗实测 ~1000ms 才渲染，
     脚本在 950ms 判定 → 报「0 行」。改成 `waitFor` 等条件。
- **回归**：单测 423/423；UI 总跑 **10/10 脚本 273/273，exit 0**（单列零回归）。
- **审核产物**：`<验收工具目录>\review-m6\`（9 张图 + `M6-审核清单.md`），
  入口/布局断言 16/16 —— 含「面板在设置弹窗里」「分区 559px」「列数=1」「每张卡独占整行」
  「`container-type=normal`」「`.dbs-overlay` fixed 且盖满 1920×945」。

---

## M4 · 同步适配器（二期）

### Task 13: 同步可插拔
`sync/` 目录下三个适配器：`local-dir`（默认，最安全）、`git`（GitHub 私有仓库，需 Clash 代理）、`webdav`（坚果云，免代理）。统一接口 `push()/pull()/status()`。

---

## 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| `__ModuleLoader__` 契约逆向不出来 | UI 做不了，退回纯命令 | Task 6 先行，失败则降级为 `/backup-sync` 命令 + 文本输出 |
| 客户端 `inject` 写了不存在的服务名 | **触发致命恢复框，重置用户 cordis.patch.yml** | 只用已验证存在的服务名；装进 **dev profile** 先验，绝不先在 desktop 上试 |
| **宿主半边不热重载** | 改了 `lib/index.js`/`lib/routes.js` 却以为生效，验收全假绿 | 见 §M3.5「关键运维事实」；**验宿主必须重启宿主**，桌面端不能重启就另起独立 web 实例（19399） |
| 凭据被静默打进包 | 明文 API key 上云 | `lib/guard.js` 两道闸，命中即剔除 + 界面显著提示；真机复验 0 误伤 |
| 记忆条目无主键导致合并留重复 | 记忆变脏 | 已告知用户并获接受；提供「合并后报告」列出疑似重复项 |
| 桌面 profile 不能用 CLI 管理 | 无法自动化安装 | 开发全程用 dev profile；装 desktop 走应用内插件面板 |
| **无人值守时动插件图 = 单点致命** | `setBundleEnabled`/`setPluginEnabled` 失败会让条目 pending → 下次开页面弹「应用无法使用」，而恢复要靠点那个框 | **没人看着就不动插件图**。宿主陈旧宁可写进验收说明让用户手动重启（重启前先用 `check-client-bundles.mjs` + `verify-profile.mjs` 证明 profile 完整） |
| `pre-restore-*` 快照目录永不清理 | `~/.dsh/backup-sync/` 下的导入前快照会一直堆积 | 已知未做；后续在「导入」页签显示快照占用并给「清理旧快照」入口（按保留份数或天数） |
| GitHub 直连仅 ~8 KB/s | 同步超时 | M4 前先开 Clash Verge |

---

## 开发约定

1. 全程在 **dev profile** 开发，**不碰 desktop**
   ⚠️ **一期实际破了这条**：`link:` 安装先进了 desktop（当时判断是「客户端半边可热重载、风险可控」）。
   复盘：这个判断对客户端成立、对宿主**不成立**，代价是宿主长期停在旧代码、验收结果不可信。
   后续规矩：**宿主改动一律先在 `web` profile 的独立实例上验**（`dsh plugin --profile web add link:…` + `dsh web --port 19399`），
   确认无误再让 desktop 用上。
2. 每个 Task 一提交，commit message 用中文
3. 改 `cordis.patch.yml` 前先用 `D:\DSH-data\validate-yaml.js` 校验
4. 临时产物一律 `<仓库目录>\`
5. 装插件前预检：`pluginManager/inspect` → 对照 boot entries → 再装
6. **验收纪律**：界面断言写错会伪装成产品缺陷（本项目已误判 6 次）。失败先问「这是产品的错，还是我断言的错」，
   再去读真实文案/真实返回；UI 断言必须打印**实际文本**，否则无法分辨。
7. **驱动 UI 的那一轮里不许改 `lib/client.js`**。客户端半边有 HMR：文件一改，面板就重挂载，
   正在跑的驱动里 `applyResult`、打开着的确认 `<dialog>`、以及输入框里的字全部被丢掉 ——
   表现成「写盘了却显示没写」「快照没留」这类**假红**。`step13` 曾因此报 30/32（实际产品 34/34 全对）。
   要改就先停驱动。
8. **CDP 会话 cookie 只有 1 小时**（`auth.mjs:23`，`expiresAt = issuedAt + 3600_000`）。
   过期后页面照常渲染（HTML 是导航时取回来的），但每个 `/api/*` 都返回**纯文本 401**，
   面板上表现为「出错了：接口返回的不是 JSON（HTTP 401）」—— 很容易误判成后端 JSON 序列化坏了。
   所以每个驱动入口都要先 `ensureAuth(page)`（`ui.mjs` 的 `ensurePanel` 已经内置）。
9. **探针必须自带超时**：调试浏览器里 `navigator.clipboard.readText()` 在**没有读权限**时
   **不 reject，而是挂住等一个永远不会出现的授权弹窗** —— 整轮脚本就此卡死（`step14` 因此废掉两轮）。
   凡是「不保证会失败」的异步原语，一律包 `Promise.race([p, sleep(3000)])`，截图之类的附赠步骤同样要包。
10. **`node x.mjs *> file` 看不到增量输出**：pwsh 会缓冲整个重定向，
    `job_output` 一直是空的、`job_list` 一直 running，很容易误判成卡死。要看进度就读那个文件的
   大小/mtime，别等 job。
11. **★ 宿主侧解析 profile 名必须走 `profileContext` 服务，不能用 `process.env.DSH_PROFILE`**。
   `DSH_PROFILE` / `DSH_PROFILE_DIR` 是 `dsh-shell-env` 在**每次 shell 工具执行时**现算的
   （`dsh-shell-env/lib/index.js` 的 `collect()` 从 `ctx.get("profileContext")` 取），
   宿主进程的环境变量里根本没有 → `env.DSH_PROFILE || 'desktop'` 永远落到 `desktop`。
   真机后果：在 `dsh web`（profile = web）实例上打的包，里面装的是 `profiles/desktop/*`；
   换一台只有 web profile 的机器，`sanityOf()` 会因为 `profiles/desktop` 不存在而**拒绝一切
   备份与导入**。权威来源是 `dsh/lib/profile-boot-*.js` 里的
   `hostCtx.provide("profileContext", {name, dir, patchPath, …})`（`dsh-shell-env`、
   `dsh-config-editor`、`dsh-settings`、`dsh-plugin-manager` 全都这么取）。
   凡是「宿主侧拿环境事实」的地方，都先查一遍内核有没有对应的**服务**。
12. **★ 面板里凡是「关掉就消失」的控件，必须检查「关掉」这个动作还能不能存下去**。
   真机 bug：定时备份的「保存」按钮写在开启分支里 → 一取消勾选，按钮跟着消失，
   用户**没有任何办法把「关掉」存进配置**。判据应该是「草稿和已存的不一样」，
   而不是「开关是不是开着」。
13. **★ 交付前必须有一条「界面文案 vs 宿主真实行为」的对账**。真机 bug：卡片写
   「备份内容跟随上面的勾选」，而宿主在 `moduleIds: null` 时用的是**各模块的默认勾选** ——
   界面在撒谎，而且是最危险的那种（用户以为只备份了勾上的，实际备份了更多）。
   做法：把文案里每个承诺映射到一行宿主代码，映射不出来就改文案或改行为。
14. **★ 验收脚本自己的断言也会错，两种错法都要当心**：
   ① **过宽**：把 `.npmrc` 当成凭据文件名（它是「插件」模块的正常配置文件，本机只有一行
   `store-dir=`），于是产品是对的、脚本报红；
   ② **选错元素**：弹窗可以叠放（技能弹窗里点文件 → 文件弹窗压在上面），
   `document.querySelector('.dbs-dialog')` 拿的是**最下面**那个，会把「文件弹窗开出来了」
   误判成「点了没反应」。凡是可能叠放的容器，一律取 `all[all.length - 1]`。
   判定顺序永远是：先读真实 DOM / 真实返回，再决定是产品错还是断言错。
15. **★ 每条安全闸都要有「接在链路上」的测试，不能只有单元测试**。
   `guard.js` 的 13 项单测证明函数对，但证明不了**扫描时真的调用了它**。
   补的扫描级测试：往 fixture 的 `.npmrc` 写 `_authToken=`，断言它从计划里消失、
   出现在 `credentials[]` 里、原因带打码片段（`_authT…Wx`）。
16. **★ CDP 驱动的收尾必须是 `await Promise.resolve(page?.close?.())`**。
   CDP 的 `page.close()` 返回 `undefined` 而不是 Promise，直接 `.catch()` 会抛
   `TypeError: Cannot read properties of undefined (reading 'catch')`，
   把一次全绿的验收变成 `exit 1`（`step15` 第一轮就是这么红的）。
17. **★ 复用标签页的驱动一律 `ensurePanel(page, {reload:true})`**。
   调试浏览器里那个标签页跑的是**改动之前**的客户端 bundle，不刷新就可能拿旧界面验新代码
   （假红与假绿都出现过）。
18. **★ 界面里「脚本或用户要去点」的控件必须有稳定定位（id 或 `data-dbs-*`）**。
   真机 bug：基线开关从来就没有 id，验收脚本靠「模块卡之外的第一个勾选框」兜底找它；
   M5 把定时备份卡片插在前面之后，兜底抓到的是**定时备份开关**，于是基线从没被关掉、
   包里 `baselineIncluded` 一直是 `true` —— 而断言只查「找得到勾选框」，
   一直是**绿的**。已给基线开关补 `id="dbs-include-baseline"` + `data-dbs-baseline`，
   并把断言改成「点完必须真的从 true 变 false」。
19. **★ 定位方式变了要连断言一起改，别只改定位**。同一处：兜底选择器换成 id 之后，
   还要加一条「关掉这件事真的发生了」的断言，否则下次还会以另一种方式假绿。
20. **★ 默认落盘路径绝不能是「整机共享的固定路径」而不校验 roots 真假**。
   `defaultArchiveDir()` 原先只看「有没有 D 盘」，于是**夹具 roots 也会落到
   `D:\dsh-backups-sync`**（用户真实备份目录）。2026-10-14 11:01 真目录里就多出一个
   4 KB 的包，`tar -tzf` 一看全是夹具种子树（`projects/0c4f6561d62a/…`）——
   用户点「恢复」就可能把测试数据盖到真数据上。已加 `looksLikeRealInstall()`
   （`DSH_HOME` 必须在 `userHome` 之下才算真实安装），真实用户口径零变化，
   夹具自动落到自己的临时目录里。
21. **★ 排查「状态被污染」类失败，先看**文件 mtime**再看结论**。
   `settings.json` 显示 `outDir=vh-conflict-out` 一度像是「总跑没还原」，
   实际是我在总跑**还没结束时**读的中间态（脚本每步前后都在还原，收尾也还原）。
   同理 `step12/13` 的 `exit=null` 是 10 分钟超时被杀，不是断言失败 ——
   `spawnSync` 超时后 `status` 就是 `null`，要按「被杀」而不是「跑红」来查。
22. **★★ 截图会挂死：后台标签页刷新之后，`Page.captureScreenshot` 永远等不到合成帧。**
   2026-10-14 实测同一个 19399 标签页：不刷新直接截 79 ms 成功；
   `Page.reload` + 3.5 s 后用默认参数截 → **9 s 超时（永不返回）**；
   刷新后 `fromSurface:false` → 293 ms 成功；刷新后 `Page.bringToFront` + 默认参数 → 88 ms 成功；
   刷新后**立刻**截 → 又挂。危害不是少一张图：`send()` 的 Promise 永不 settle，
   整个脚本卡住，总跑把它记成 `exit=null` —— **上一轮 step12/step13 的「超时」真凶就是它，
   不是点击、也不是断言**。`ui.mjs` 的 `shot()` 已改成 `bringToFront` + `fromSurface:false`
   + 8 s 超时 + 3 次重试：任何一次挂死最多慢 8 秒，不会再拖死全局。
   **推论**：凡是用 CDP 的地方，任何一次 `send()` 都要带超时，否则一个静默挂死会伪装成功能缺陷。
23. **★ 面板内的坐标点击不可靠，一律改成页面内 `element.click()`。**
   已踩**五次**（侧边栏入口、设置入口被 mask 吃掉、`查看 N 个技能`、
   `开始备份 / 确认备份`）：坐标点击能拿到 rect、`hitOk` 也是真，但元素就是不响应。
   最后一次的后果最像产品坏了 —— 确认框压根没开，断言读到 `null`，
   然后卡在「等备份结果」上超时（总跑里 `step9`/`step10` 一起红）。
   **第五次是决定性的**：面板搬进设置弹窗后，坐标点击从「偶发打空」升级为**确定性失效** ——
   「开始备份」按钮 `disabled:false`、在视口内、`elementFromPoint` 命中的就是它本身，
   坐标点击**连点三轮弹窗一次都没开**；紧接着用页面内 `element.click()` 点同一个按钮，
   **三次全部立刻打开**。设置弹窗这一层（`data-shortcut-modal` + 自绘遮罩 + 焦点陷阱）
   把合成鼠标事件吃掉了。**2026-10-15 再收一刀**：`clickByText` 的**默认路径**也改成
   页面内点击（坐标路径留在 `{pointer:true}` 下备用，返回值仍带 `hitOk/hitTag` 便于诊断）——
   它是所有脚本的公共入口，留着坐标默认值就等于留着这个雷。
   统一收敛成 `ui.mjs` 的 `clickIn(page, sel, label)`：在指定容器里按可见文字找按钮、
   **页面内 click**，容器命中多个时取**最后一个**（弹窗会叠放）；
   `step9`/`step10` 里两份按坐标点击的本地副本已删除。
   配套：点击之后**等条件成立**（`waitFor` 状态位），不要 `sleep(500)` 猜时长 ——
   单击走 `clickGate` 的 240 ms 分流延迟，套件里机器忙时会晚于 500 ms，
   `step16` 因此把「单击没反应」误判成产品缺陷，还连带双击那 4 条一起红。
24. **★ 不许断言「调度器会合法覆盖掉的中间态」。**
   `step15` 原来断言「改计时字段后 `schedule.json` 的 `lastPointAt === null`」，
   真机读到的是 `1791954664103`（≈ 现在）。宿主确实写了 `null`，但**调度器下一个 tick
   立刻把它锚成「现在」**（`scheduler.js:231-233`，这正是「第一次启用先把起点落盘」的设计）。
   已改成「起点是 null 或距今 < 2 分钟」，并**补了一条更硬的断言**：
   跑过一次（锚点已是具体时间）之后只改保留份数，起点必须**一模一样**——
   这才是「改保留份数不动锚点」这条设计规则真正的确定性证明。
25. **★ 断言不要写死环境数量，要比集合。**
   `step10` 原来写「含 10 个技能」，被超时杀掉的那一轮留在真实技能库里的夹具
   （`zz-e2e-import` / `zz-e2e-conflict`）把它顶成 12 个 → 假红。
   已改成「包内技能集合 == 真实技能库目录集合」，个数多少都成立，差集还会打出来。
   同理 `step16` 的悬停判据不能写「title 一定比名字长」——夹具技能描述只有 `V1`，
   已改成「title ≠ 名字，且（明显更长 或 是『没有写描述』的诚实兜底）」。
26. **★ 测试夹具落在用户真实目录里时，必须「先清再建」。**
   `step12/step13` 的探针技能建在 `~/.agents/skills/zz-e2e-*`（真实技能库），
   被超时杀掉的那一轮把残骸留了下来，之后每一份真包都会把它打进去。
   两个脚本都已加「进场景先 `rm` 一次」，收尾仍照旧删。
27. **★ 弹窗会叠放：上一步崩了会把弹窗留给下一步，下一步的定位就读到错的东西。**
   `step16` 崩在 `waitFor is not defined`，技能弹窗留在页面上；`step12`/`step13`
   定位「确认框」时取的是**最上面那个** `.dbs-dialog`，于是读到技能详情，
   报出「确认框里是技能详情」——看着像产品坏了，其实是级联污染。
   `ui.mjs` 的 `ensurePanel()` 现在开局先 `closeAllDialogs()`：
   只点弹窗自己的「关闭」按钮（不动 DOM —— 摘节点会让 React 状态与界面不一致），
   最多 6 层，没有「关闭」按钮就原样留着并打一行日志。
    **2026-10-15 补一刀**：只认「关闭」是不够的 —— **备份确认框的按钮是「取消 / 确认备份」，
    根本没有「关闭」**，于是那个 `.dbs-overlay` 清不掉，遮罩一直扣在面板上，
    后面每一次点击都打在遮罩上（实测 `hitOk:false`，按钮永远点不动）。
    现在按「关闭 → 取消」顺序找，两者都是非破坏性的（取消不写盘）。
   顺带一条同类规则：**改 `lib/client.js` 时不要在 UI 驱动跑动中改** ——
   客户端半是 `link:` 安装、会热重载，驱动中途换代码会让这一轮的结论作废。

