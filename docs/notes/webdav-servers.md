# WebDAV 服务器方言实测记录

这个文件记录 `dsh-backup-sync` 的云端功能在**真实服务器**上跑出来的行为差异。
写它的原因很直接：WebDAV 是个「标准」协议，但各家实现的细节并不一致，
而这些细节恰好决定了上传/下载会不会失败。

> 本文件只写**实测过的**结论。没测过的一律标注「待实测」，不猜。

---

## 一、插件侧用到的协议面（很窄）

云端功能只依赖这几个动词，没有厂商私有 API：

| 用途 | 请求 | 说明 |
| --- | --- | --- |
| 测连接 | `OPTIONS /`，失败时退回 `PROPFIND /` `Depth: 0` | 只要求 2xx；返回的 `DAV:` 头会原样显示在界面上 |
| 列目录 | `PROPFIND <dir>` `Depth: 1` | **只取直接子项**；404 视为「目录不存在」（空数组） |
| 判断目录在不在 | `PROPFIND <dir>` `Depth: 0` | 列表为空时补这一发，用来区分「目录不存在」与「目录在、只是没包」 |
| 建目录 | `MKCOL <dir>` | 只在需要时建一层，不递归 |
| 上传 | `PUT <file>` | 带 `Content-Length`（**不用 chunked**），Basic 认证 |
| 下载 | `GET <file>` | 先写 `<name>.part-<随机>` 再改名，失败不留残骸 |
| 删除 | `DELETE <file>` | 删除包时连 `.sha256` / `.meta.json` 一起删 |

认证：**只支持 Basic**。服务器返回 `WWW-Authenticate: Digest` 时会明确报
「Digest 暂不支持」，不会静默失败（`lib/webdav.js`）。

---

## 二、本地假服务器（`test/fake-webdav.js`）的方言

这是仓库自带的测试服务器，`npm run e2e:cloud` 用的就是它（真进程、真端口、真 Basic 认证）。
它实现的是**按 RFC 4918 最朴素的一套行为**，可以当作「最小合规实现」的基线：

- `OPTIONS` 返回 `DAV: 1,2` + `Allow` 列表；
- `PROPFIND` 的 `Depth: 1` 返回直接子项（含集合），`Depth: 0` 只返回自身；
- 未知路径的 `PROPFIND` 返回 **404**（不是 207 空集合）；
- `PUT` 接受带 `Content-Length` 的请求体，写入按 basename 落盘；
- `DELETE` 对不存在的文件返回 404（插件侧把它当幂等成功）；
- 支持两种可开关的怪癖，用来测客户端的容错：`--trailing-slash-redirect`（集合缺尾斜杠时 301）
  与 `--chunked-put`（接受 `Transfer-Encoding: chunked`）。

实测结论（`scripts/cloud-e2e.mjs`，65 项断言全绿）：插件在**这套方言**上完整跑通
「打包 → 上传三件套 → 列远端 → 下载 → 整包校验 → 预览导入 → 删远端（幂等）」，
且全程 3 次 `PUT` 都带 `Content-Length`、日志里没有 `Authorization` 头。

---

## 三、真实服务器

### 绿联 NAS（UGOS Pro）

#### NAS 侧怎么开（照抄即可）

1. 浏览器登录 NAS，打开「控制面板」应用 → 【文件服务】 → 【WebDAV】 → 勾选「启用服务」→ 应用；
2. 需要时在「高级设置」里改端口 —— **默认 HTTP `5005`、HTTPS `5006`**（社区指南与官方教程中心口径一致，见文末来源）；
3. 建一个专供备份的共享文件夹（例如 `dsh-backup`），在「用户管理」里给它单独建一个用户，
   **只给这个文件夹读写权**（WebDAV 是 Basic 认证，口令随每个请求走，权限越小越安全）；
4. 插件里的四个字段：
   - 云端地址 —— 看你和 NAS 的相对位置：
     - **同一个局域网**：`http://<NAS 局域网 IP>:5005/`（内网用 http 就够）；
     - **不在同一个局域网（例如人在公司、NAS 在家里）**：填 **overlay 组网地址**
       `http://100.66.1.1:5005/`（节点小宝给 NAS 分配的组网 IP；
       DNS 别名 `ugreen-owjdxb.link` 也解析到它，但**填 IP 更稳**，别依赖别名解析）。
       组网隧道本身是加密的，明文 Basic 口令只存在于隧道内部，可以接受。
   - 账号 = 第 3 步那个专用用户
   - 口令 = 该用户的密码
   - 远端目录 = 第 3 步那个共享文件夹名（例如 `dsh-backup`）。
     想放进现成共享文件夹的子目录就写 `现有共享文件夹/dsh-backup` ——
     **本插件只 `MKCOL` 最后一级**，前面的目录要你在 NAS 上先建好。

> ⚠️ WebDAV 的 Basic 认证是把口令明文放在每个请求头里的。
> 局域网内 `http://NAS:5005/` 可接受；**不要把 5005 直接映射到公网** ——
> 那等于把口令挂到互联网上。要跨网就用 overlay/VPN 隧道（首选），
> 或者 HTTPS（`5006` + 自签证书，插件里勾「跳过证书校验」）。

> ⚠️ **走组网时有个必踩的坑：节点小宝的 GUI 客户端一关，`100.66.x.x/32` 的点对点路由会立刻消失**
> （只剩服务进程在跑是没用的），表现为「ping 不通 NAS、所有端口全不通」，
> 极易误判成 NAS 挂了或 WebDAV 没开。判定顺序：
> `Get-Process nblink` → `Get-NetRoute -AddressFamily IPv4 | ? DestinationPrefix -like '100.66*'`
> → `ping <组网IP>`。三条都对了再谈 WebDAV。
> 重启/退出客户端后要重新登录（本机靠 WMI 拉起即可：`([wmiclass]'Win32_Process').Create('"...\nblink.exe"')`，
> 直接用 `Start-Process` 起的会被 DSH 的进程树回收逻辑带走）。

#### 实测状态（2026-10-16，公司电脑 → 家里 NAS，走节点小宝组网）

已实测通过的部分：

| 项目 | 实测结果 |
| --- | --- |
| 组网可达性 | `100.66.1.1` ping 0% 丢包、**1ms**；DNS 别名 `ugreen-owjdxb.link` → `100.66.1.1` |
| 端口 `5005`（HTTP） | `OPTIONS /` → **`401 Unauthorized`**，`WWW-Authenticate: Basic realm="Restricted"`，body `Not authorized` |
| 端口 `5006`（HTTPS） | 同上（自签证书，需「跳过证书校验」或信任证书） |
| 管理面板 | `80`/`9999` → `307` 跳 `http://…:9999` → `https://…:9443/`；`443` → `307` 跳 `:9443` |
| 隧道假阳性 | `22/3000/5000/5001/5007/8000/8080/8443/9000` 的 TCP **握手全部"成功"但无任何 HTTP 响应** —— 组网网卡对任意地址都回 SYN，**不能只凭 TCP 连通判断端口开着**，必须拿到真实 HTTP 响应 |

还没有的（需要 NAS 上的专用账号）：

- 服务器返回的 `DAV:` 能力头（`401` 响应里没有，必须带账号再问一次；界面上「测试连接」会显示）；
- `PROPFIND` 响应里的命名空间前缀（`D:` / `d:` / 无前缀），用来确认解析器不是靠前缀猜的；
- 是否接受带 `Content-Length` 的 `PUT`（本插件不用 chunked，若服务器强制要求 chunked 则需适配）；
- `MKCOL` 建目录的行为 —— 尤其**根下能不能建**：多数 NAS 的顶层是「共享文件夹」，
  只能由 NAS 侧创建，WebDAV 客户端在根下 `MKCOL` 往往返回 403/409，
  所以正确姿势是**先在 NAS 建好文件夹，再把它的名字当远端目录**；
- 删掉最后一份包之后，目录是否还留着（验证 `dirMissing` 判定）。

### 其他（群晖 / 坚果云 / Nextcloud）

**待实测。** 结构与上面绿联那节相同。已知需要重点确认的差异点：

- 坚果云对 `PROPFIND` 的 `Depth` 取值较严格，可能需要 `Depth: 1` 之外的写法；
- 群晖的 WebDAV Server 套件默认路径带 `/webdav` 前缀，且集合缺尾斜杠时可能返回 301；
- Nextcloud 会返回自定义命名空间（`oc:`）外加 `D:` 前缀。

---

## 四、怎么自己测（复现方式）

第一步永远先在本地跑假服务器，把「插件的问题」和「服务器的问题」分开：

```bash
npm run e2e:cloud          # 起真进程的假 WebDAV，跑完整链路，65 项断言
npm run e2e:cloud -- --keep   # 保留现场目录，可以直接翻远端落盘的文件
```

第二步再对着真服务器做，最省事的入口是界面：**设置 → 备份同步 → 同步 → 云端（WebDAV）**。
填完点「保存并测试连接」——它会把地址、远端目录、服务器返回的 `DAV:` 头一起显示出来；
接着依次点「传最新一份上去」→「列出远端」→「下载到本机」，三步都过就说明这套方言兼容。

任何一步失败，界面上给的是**服务器原话**（状态码 + 响应片段，截断到 600 字符），
拿这一段就能判断是认证、路径还是权限问题。

要在命令行里单独摸某个服务器，可以直接用插件的客户端（`lib/webdav.js` 是纯函数式导出，
不依赖 DSH 运行时）：

```bash
node --input-type=module -e "
import { createWebdav } from './lib/webdav.js';
const c = createWebdav({ url: 'http://NAS:5005/', username: 'u', password: 'p' });
console.log(await c.probe());            // {ok, status, dav, url}；不抛异常
console.log(await c.list('dsh-backup')); // 直接子项（目录不存在返回 []）
await c.close();                         // 关掉 keepAlive 连接池，否则进程不退出
"
```

---

## 五、来源

- 绿联官方教程中心《文件服务概览与高级设置》（控制面板 → 文件服务 → WebDAV 的存在与定位）：
  <https://www.ugnas.com/tutorial-detail/id-194.html>
- 绿联 NAS 私有云社区《WebDAV 使用指南》（启用步骤 + 默认端口 5005/5006 + 专用共享文件夹的做法）：
  <https://club.ugnas.com/thread-2688-1-6.html>
- 《使用 UGREENlink 访问 NAS 上的 WebDAV》（确认服务在 NAS 本机是 `127.0.0.1:5005`）：
  <https://naomi233.github.io/code/exp/04.ugreenlink-webdav.html>

