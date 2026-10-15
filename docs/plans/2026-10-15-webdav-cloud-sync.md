# WebDAV 云备份/云同步 实施计划

> **REQUIRED SUB-SKILL:** `executing-plans`（或本会话内自行按任务逐个执行）

**Goal:** 给 `dsh-backup-sync` 加上「云端」能力：把备份包上传到 WebDAV（首个目标 = 绿联 NAS），在另一台机器上从云端列出、下载、校验、导入；transport 抽象成可扩展形态，后续接坚果云/群晖/Nextcloud 只是加配置而不是改架构。

**Architecture:** 三层，逐层可单测：
1. `lib/webdav.js` —— 纯协议客户端（PROPFIND/MKCOL/PUT/GET/DELETE/HEAD），零依赖，`node:http`/`node:https`，Basic 认证，可关证书校验；
2. `lib/cloud.js` —— 业务编排（配置读写、凭据隔离、上传/列远端/下载/删除、远端与本地包的对账）；
3. `lib/routes.js` + `lib/client.js` —— HTTP 接口与「同步」页签里的「云端」区块；
4. `lib/scheduler.js` —— 打完包可自动上传（可选开关）。

**为什么先做 WebDAV：** 绿联 NAS / 坚果云 / 群晖 / Nextcloud 全支持；国内直连不需要 Clash（这正是压过 GitHub 路线的关键）；协议标准，一套实现覆盖多家。

**Tech Stack:** Node ≥22 ESM、`node:test`、零运行时依赖（与现有代码一致）。

---

## 不可动摇的约束（违反即回滚）

1. **密码永不进包、不进基线、不进任何接口响应**：密文单独存 `~/.dsh/backup-sync/cloud-credentials.json`，该文件名加入 `SECRET_BASENAMES`；`GET /cloud/state` 只回 `hasPassword: boolean`。
2. **远端删除只允许删自己的包**：复用 `schedule.js` 的 `isOwnArchiveName()`，非本插件命名一律拒绝。
3. **不自动导入**：云端有新包只提示、可一键下载到本地备份目录，**导入仍由人在「导入」页签确认**（三方合并要人裁决冲突）。
4. **不写 `cordis.patch.yml`**：云端配置只写 `~/.dsh/backup-sync/settings.json`。
5. **上传必须带 `Content-Length`**（不用 chunked），避免服务器不支持 chunked PUT；上传后用 PROPFIND 核对远端字节数，不一致即报错。
6. **失败可见**：所有云端错误都带 HTTP 状态码与服务器原文片段，不吞。

---

## Task 1: WebDAV 协议客户端 + 假服务器夹具（TDD）

**Files:**
- Create: `lib/webdav.js`
- Create: `test/fake-webdav.js`（零依赖假 WebDAV 服务器，可配置方言/怪癖）
- Test: `test/webdav.test.js`

**Step 1: 先写假服务器 + 失败测试**
假服务器用 `node:http` 实现，支持 `PROPFIND`(Depth 0/1)、`MKCOL`、`PUT`、`GET`、`DELETE`、`HEAD`，并可用开关模拟：
- 命名空间前缀 `D:` / `d:` / `lp1:` / 默认命名空间；
- 目录不带尾斜杠时 301；
- 无 `Authorization` 时 401 + `WWW-Authenticate: Basic realm="x"`（另有 Digest 模式用于断言我们给出明确错误）；
- 父目录不存在时 PUT 返回 409；
- MKCOL 已存在返回 405；
- 只读模式返回 403。

断言清单（每条一个 test）：
- `normalizeBase()` 补尾斜杠、拒绝非 http(s)、拒绝空；
- `list()` 正确解析各家前缀的 207，取出 name / isDir / bytes / mtime，且正确处理 href 的 URL 编码与中文名；
- `ensureDir('a/b/c')` 逐级 MKCOL，已存在（405）不报错；
- `put()` 发出的请求带 `Content-Length` 且值等于文件字节数；
- `get()` 下载字节与源文件一致；`sha256` 校验失败时抛错；
- 401 → 抛「认证失败」，Digest → 抛「暂不支持 Digest」；
- 403/409/507 → 各自可读的中文错误；
- `remove()` 拒绝非自有命名。

**Step 2: 跑测试确认失败** `node --test test/webdav.test.js`

**Step 3: 实现 `lib/webdav.js`** —— 最小实现让上面全绿。要点：`rejectUnauthorized` 由选项控制；控制类请求 15s 超时、传输类 5min；`href` 解析用「前缀无关」正则 `/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/g`，并做 XML 实体与百分号解码（不把 `+` 当空格）。

**Step 4: 跑测试确认全绿**，`node --test test/webdav.test.js`

**Step 5: 提交** `feat: WebDAV 协议客户端（零依赖，含假服务器测试）`

---

## Task 2: 云端编排层 `lib/cloud.js`（TDD）

**Files:**
- Create: `lib/cloud.js`
- Modify: `lib/settings.js`（`DEFAULT_SETTINGS.cloud = {kind:'webdav', url:null, username:null, remoteDir:'dsh-backup', insecureTLS:false, autoUpload:false, enabled:false}`）
- Modify: `lib/guard.js`（`SECRET_BASENAMES` 加 `cloud-credentials.json`）
- Test: `test/cloud.test.js`

要点与断言：
- `saveCloudConfig(roots, patch)`：只写非密字段；`url` 校验协议与尾斜杠；`remoteDir` 归一为 `/a/b`（去首尾多余斜杠），空则拒。
- `saveCloudPassword(roots, password)` / `loadCloudCredentials(roots)`：单独文件、权限尽力收紧（Windows 上忽略失败）；密码为空 = 清除。
- `cloudView(roots)`：返回配置 + `hasPassword` + `lastUpload`/`lastCheck` 摘要，**断言序列化结果里不含密码**。
- `testConnection(roots)`：认证 + 目录可达（必要时 `ensureDir`），返回 `{ok, url, remoteDir, created}`。
- `uploadArchive(roots, {name?})`：默认最新包；上传 `.tar.gz` + `.sha256` + `.meta.json`；远端字节数核对；写 `settings.cloud.lastUpload`。
- `listRemote(roots)`：远端列表 → 标注 `{name, bytes, mtime, isOwn, localExists, isNewer}`。
- `downloadRemote(roots, name)`：只允许 `isOwnArchiveName`；下载到 `outDir`，若远端有 `.sha256` 则校验，失败即删残文件并报错。
- `removeRemote(roots, name)`：只允许自有命名。

**Step: 跑 `node --test test/cloud.test.js`；提交** `feat: 云端编排层（WebDAV 上传/列远端/下载/删除 + 凭据隔离）`

---

## Task 3: HTTP 接口

**Files:** Modify `lib/routes.js`（新增 `/cloud/state`、`/cloud/config`、`/cloud/password`、`/cloud/test`、`/cloud/upload`、`/cloud/list`、`/cloud/download`、`/cloud/remove`）；Test `test/routes.test.js`

断言：每个端点存在且形状正确；`/cloud/state` 不含密码；`/cloud/download` 对非自有命名返回错误；`/cloud/remove` 同理。

**提交** `feat: 云端 HTTP 接口`

---

## Task 4: 定时备份后自动上传

**Files:** Modify `lib/scheduler.js`（`execute()` 成功后，若 `settings.cloud.enabled && autoUpload` 且有 `deps.uploadArchive` 则上传，失败只记 `lastError`，**不影响"备份成功"这个事实**）；Test `test/scheduler.test.js`

断言：开关关 → 不调用；开 → 调用一次且传入刚生成的包名；上传抛错 → `lastResult` 仍为成功、`cloudError` 记录原因。

**提交** `feat: 定时备份后可选自动上传云端`

---

## Task 5: 界面（「同步」页签里的「云端」区块）

**Files:** Modify `lib/client.js`；Test `test/client.test.js`

控件（都要稳定 id，供 CDP 驱动断言使用）：
`dbs-cloud-enabled`（开关）、`dbs-cloud-url`、`dbs-cloud-user`、`dbs-cloud-pass`（`type="password"`，只写不回显，占位文案「已保存，留空则不变」）、`dbs-cloud-dir`、`dbs-cloud-insecure`、`dbs-cloud-autoupload`；按钮 `dbs-cloud-save`（保存并测试连接）、`dbs-cloud-upload`、`dbs-cloud-refresh`；远端列表每行 `data-dbs-remote="<name>"` + 「下载」按钮 `data-dbs-download="<name>"`。

**提交** `feat: 界面加云端区块（WebDAV 配置 / 上传 / 远端列表 / 下载）`

---

## Task 6: 本地端到端（真协议、真网络栈）

- 起 `test/fake-webdav.js` 当服务器（`node test/fake-webdav.js --port 19700 --dir <tmp> --user u --pass p`）；
- 用 `node` 脚本走完整链路：`testConnection` → `uploadArchive` → `listRemote` → `downloadRemote`（到另一棵夹具树）→ 对下载包跑 `verifyArchiveFull` → `previewImport` 确认能识别内容；
- 断言下载包 sha256 == 上传包 sha256；断言远端目录里就是 3 个文件。
- 证据落盘 `D:\dsh-work\dsh-backup-sync-cloud\e2e-local.md`。

---

## Task 7: 真机（绿联 NAS WebDAV）

前置（需用户提供/操作）：在 NAS 上开启 WebDAV、拿到 `http(s)://<地址>:<端口>/<路径>`、账号（**优先用应用密码/专用账号**，不要用管理员登录密码）。
- 先测连接 → 上传 → 列出 → 在家里那台 DSH 上列出并下载 → 导入预览；
- 记录 NAS 的实际方言（前缀、认证、是否自签、是否要 `MKCOL` 子目录）到 `docs/notes/webdav-servers.md`。

---

## Task 8: 发布（v0.2.0）

- `package.json` 版本 0.2.0；`CHANGELOG.md` 记「新增：WebDAV 云端备份」；
- README 加「云端同步（WebDAV）」章节与截图；
- `pnpm pack` → 校验 → 打 tag `v0.2.0` → GitHub Release 带 tgz → 核对服务端 digest；
- 社区目录（awesome-dsh-plugin 的一个 yml / dsh-plugin.org 提交）作为发布后的独立小任务。

---

## 验证口径（每个任务都要过）

| 层 | 命令 | 通过标准 |
|---|---|---|
| 单元 | `node --test test/*.test.js` | 全绿，且**新增测试数 > 0** |
| 本地 E2E | Task 6 脚本 | 上传→下载→校验→导入预览全通 |
| 真机 E2E | Task 7 | 绿联 NAS 上出现 3 个文件，另一台能下载并导入 |
| 界面 | `D:\dsh-work\dsh-backup-sync-ui` 的 CDP 驱动 | 云端区块可点、错误态可见、无 console 报错 |
| 安全 | 断言序列化响应不含密码；远端删除越权被拒 | 必过 |
