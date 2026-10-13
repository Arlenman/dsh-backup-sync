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
├─ lib\
│   ├─ index.js           宿主半边入口：apply(ctx)，注册工具/命令/HTTP 路由
│   ├─ paths.js           根路径解析（DSH_HOME / USER_HOME 可注入，便于测试）
│   ├─ modules.js         【M1】模块 → 文件清单映射（纯函数）
│   ├─ scan.js            【M1】扫描 + sha256 + 计数（纯逻辑，可注入根）
│   ├─ baseline.js        【M1】基线库读写（纯逻辑）
│   ├─ diff.js            【M3】三方比较 → 动作计划（纯函数）
│   ├─ archive.js         【M3】tar.gz + sha256 边车
│   ├─ apply.js           【M3】按计划写盘（先备份后写）
│   ├─ server.js          【M3】loopback HTTP 路由
│   └─ client.js          【M2】客户端 bundle（手写外壳）
└─ test\
    ├─ modules.test.js
    ├─ scan.test.js
    ├─ baseline.test.js
    └─ diff.test.js
```

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

### Task 6: 逆向 `__ModuleLoader__` 契约 ★全项目最大未知

**Files:**
- Read: `C:\Users\x\.dsh\profiles\desktop\node_modules\dsh-context\lib\client.js`
- Read: `...\@michengai\dsh-skills-manager\lib\client.js`（更小，更好读）
- Output: `<仓库目录>\docs\notes\module-loader-contract.md`

**必须回答的问题（逐条给出证据行号）：**
1. `factory` 的返回值/副作用是什么？模块如何导出 `apply` / `inject` / `name`？
2. `e(...)` 能 require 哪些 id？哪些来自 boot entries，哪些来自共享库？
3. 面板列表（与 Plugins、Automation tasks 同级）注册在哪个 slot？API 签名是什么？
4. 中央栏整页面板注册在哪个 slot？
5. `inject` 里**绝对不能写**的服务名是什么？（写错 → 条目 pending → 触发「应用无法使用」致命恢复框；现存的客户端服务是 `slots / locale / theme / configForms / connection / remote / sessions / conversation`）

**方法:** 优先读 `.map` 文件或未压缩源码；若只有压缩产物，用 `prettier`/`js-beautify` 展开后再读。**不要靠猜。**

---

### Task 7: 客户端 bundle 外壳

**Files:**
- Create: `lib/client.js`

**要求:** 手写 `window.__ModuleLoader__.load({ id:'dsh-backup-sync', factory })` 外壳，工厂体内用 `React.createElement`（**不用 JSX**）。先用最小内容验证「能被加载、能注册一个 slot」，再填 UI。

**验证:** 装进 dev profile → `GET /` 的 `__DSH_BOOT__` 里出现本插件条目 → 面板列表出现「备份同步」。

---

### Task 8: 面板 UI（只读）

**Files:**
- Modify: `lib/client.js`
- Create: `lib/server.js`（GET 路由，返回扫描结果）

**要求:** 六张模块卡片显示条目数、总大小；「对话」卡片标注「本地专用 · 不上云」且默认不勾选。**先只读，不做备份按钮。**

---

## M3 · 归档 / 差分 / 增量导入（一期目标达成）

### Task 9: `archive.js`
`tar -czf` 到 `.tmp-<uuid>` → 算 sha256 → 原子改名 → 写 `.sha256` 与 `.meta.json` 边车（`meta` 含模块清单、条目数、机器名、时间）。**与 dsh-backup 同构，保证交叉可恢复。**

### Task 10: `diff.js` —— 三方比较 ★核心
**Files:** Create `lib/diff.js`, Test `test/diff.test.js`

实现设计 §4.2 的**十种情况**，返回动作计划 `[{key, moduleId, relPath, action: 'import'|'keep'|'delete'|'conflict', reason}]`。
**测试：十种情况逐个断言，一种不漏。** 这是全项目最容易出错的逻辑。

### Task 11: `apply.js` —— 执行计划
先整树快照到 `backup-sync/pre-restore-<时间戳>/`，再按计划写盘。分模块粒度：技能=目录级、配置=文件级、插件=JSON 字段级、记忆/待办=条目级（`KEY.md` 按 `mem-id` 主键、待办按 8 位 id、`MEMORY.md`/`USER.md` 按内容行去重）。

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
