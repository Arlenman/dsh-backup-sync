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

**产出**：`docs/notes/module-loader-contract.md`（12 节，全部结论带出处行号）+ `docs/notes/dsh-slot-catalog.json`（内核自带 90 条槽位目录，225 KB）。

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

### Task 8: 面板 UI
**Files:** Modify: `lib/client.js`（宿主半边见 Task 8a）

六张模块卡片显示条目数、总大小；「对话」卡片标注「本地专用 · 不上云」且默认不勾选。**只读骨架**已随 Task 7 落地（14 项离线契约测试）；**完整 UI —— 备份勾选 + 汇总 + 二次确认、历史版本列表、导入差异预览、冲突逐条裁决、同步入口 —— 待做**，宿主侧接口已全部就绪。

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

### Task 12: 冲突裁决 UI + 备份按钮 + 历史版本
接 M2 的面板：勾选 → 汇总 → 二次确认 → 生成包；导入 → 差异预览 → 冲突逐项裁决。

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
| 记忆条目无主键导致合并留重复 | 记忆变脏 | 已告知用户并获接受；提供「合并后报告」列出疑似重复项 |
| 桌面 profile 不能用 CLI 管理 | 无法自动化安装 | 开发全程用 dev profile；装 desktop 走应用内插件面板 |
| GitHub 直连仅 ~8 KB/s | 同步超时 | M4 前先开 Clash Verge |

---

## 开发约定

1. 全程在 **dev profile** 开发，**不碰 desktop**
2. 每个 Task 一提交，commit message 用中文
3. 改 `cordis.patch.yml` 前先用 `D:\DSH-data\validate-yaml.js` 校验
4. 临时产物一律 `<仓库目录>\`
5. 装插件前预检：`pluginManager/inspect` → 对照 boot entries → 再装
