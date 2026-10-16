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

### 绿联 NAS（UGREEN）

**待实测。** 需要的信息：WebDAV 服务开关位置、对外端口、地址是否要带尾斜杠、
账号用登录账号还是应用专用密码、父目录不存在时 `MKCOL` 的返回码、
`PROPFIND` 命名空间前缀是否需要严格匹配。

拿到上面这些之后，这一节要补的内容是：

- 服务器返回的 `DAV:` 能力头（界面上「测试连接」会显示）；
- `PROPFIND` 响应里的命名空间前缀（`D:` / `d:` / 无前缀），用来确认解析器不是靠前缀猜的；
- 是否接受带 `Content-Length` 的 `PUT`（本插件不用 chunked，若服务器强制要求 chunked 则需适配）；
- `MKCOL` 建多级目录的行为（本插件只建一级）；
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
