/**
 * WebDAV 协议客户端 —— 零依赖，只用 `node:http` / `node:https`。
 *
 * ## 为什么不用某个 webdav npm 包
 * 本插件的整体承诺是「零运行时依赖」（目标机装完不用 pnpm install 任何东西），
 * 而我们真正需要的只有 6 个方法（OPTIONS/PROPFIND/MKCOL/PUT/GET/DELETE）。
 * 为此拉进一棵依赖树，代价远大于收益。
 *
 * ## 为什么不用 `fetch`
 * 三个现实原因：
 *  1. **自签名证书**：NAS 的 WebDAV 多半是 https + 自签。`fetch` 要关校验得塞
 *     undici 的 `Agent`（`dispatcher` 选项），跨 Node 版本行为不一致；而
 *     `https.request({rejectUnauthorized:false})` 是稳定的、语义明确的一行。
 *  2. **必须带 Content-Length**：不少 NAS/WebDAV 服务端不吃 `Transfer-Encoding: chunked`
 *     的 PUT（写进去是 0 字节或 411）。用 `http.request` + 显式 `content-length`
 *     最省事，也不会因为流式上传被 undici 改成 chunked。
 *  3. **要拿到原始状态码与响应头**（401 的 `WWW-Authenticate`、207 的 XML、
 *     301 的 `Location`），不想跟 fetch 的 Response 语义绕。
 *
 * ## 设计边界
 * 这一层**只懂协议，不懂业务**：不知道什么是「备份包」、不校验名字、不碰本地文件。
 * 目录名/文件名的合法性（谁是自己的包、路径能不能删）由 `cloud.js` 决定。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';

/** 控制类请求（列目录、建目录、删除、探测）的超时。 */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** 传输类请求（上传/下载）的超时。备份包最大几十 MB，5 分钟足够。 */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 5 * 60_000;
/** 最多跟随几次重定向。真服务器最多给一次（集合缺尾斜杠），给 3 次足够。 */
const MAX_REDIRECTS = 3;

/** WebDAV 层的错误：一定带得上「哪个方法、哪个路径、服务器回了什么」。 */
export class WebdavError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number|null, method?: string|null, path?: string|null, detail?: string, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'WebdavError';
    this.status = info.status ?? null;
    this.method = info.method ?? null;
    this.path = info.path ?? null;
    this.detail = info.detail ?? '';
  }
}

/**
 * 归一化 WebDAV 根地址。
 * 规则：必须是 http(s)、去掉路径里的重复斜杠、**末尾补一个斜杠**（否则
 * `new URL('a', 'http://h/dav')` 会把最后一段当文件名替换掉，路径全错）。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeBaseUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') throw new WebdavError('必须填写 WebDAV 地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WebdavError(`WebDAV 地址不是合法的 http/https 链接：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebdavError(`WebDAV 地址必须以 http:// 或 https:// 开头：${raw}`);
  }
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const withSlash = path.endsWith('/') ? path : `${path}/`;
  return `${url.protocol}//${url.host}${withSlash}${url.search}`;
}

/** XML 实体反转义（href 里 `&amp;` 很常见）。 */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 把 href 变成「解码后的路径」。
 * 既要吃 `%E4%B8%AD` 这种编码，也要吃服务器直接给中文的（解码是幂等的）；
 * **不把 `+` 当空格**（路径里的加号是字面量）。
 */
export function decodeHrefPath(href) {
  let path = unescapeXml(String(href).trim());
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      // 解析不了就按原样处理
    }
  }
  return path
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

/**
 * 解析 207 Multi-Status。
 * 命名空间前缀一律忽略（`D:` / `d:` / `lp1:` / 无前缀都见得到），
 * 只取 propstat 状态为 200 的属性（404 的那半截是「这个属性没有」）。
 *
 * @param {string} xml
 * @returns {{href: string, path: string, isDir: boolean, bytes: number|null, mtime: Date|null}[]}
 */
export function parseMultiStatus(xml) {
  const out = [];
  const blocks = String(xml).matchAll(/<([\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/([\w.-]+:)?response>/gi);
  for (const m of blocks) {
    const body = m[2];
    const hrefMatch = /<([\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/([\w.-]+:)?href>/i.exec(body);
    if (hrefMatch === null) continue;
    const href = unescapeXml(hrefMatch[2]).trim();

    let props = '';
    const propstats = body.matchAll(/<([\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/([\w.-]+:)?propstat>/gi);
    let sawPropstat = false;
    for (const ps of propstats) {
      sawPropstat = true;
      const chunk = ps[2];
      const statusMatch = /<([\w.-]+:)?status\b[^>]*>([\s\S]*?)<\/([\w.-]+:)?status>/i.exec(chunk);
      if (statusMatch !== null) {
        const code = Number(/\s(\d{3})\s/.exec(statusMatch[2])?.[1] ?? NaN);
        if (code !== 200) continue;
      }
      props += chunk;
    }
    // 少数服务器不给 propstat 包裹，退化成整个 response 当属性区
    if (!sawPropstat) props = body;

    const isDir = /<([\w.-]+:)?collection\b/i.test(props);
    const lenMatch = /<([\w.-]+:)?getcontentlength\b[^>]*>\s*(\d+)\s*</i.exec(props);
    const mtimeMatch = /<([\w.-]+:)?getlastmodified\b[^>]*>([\s\S]*?)<\//i.exec(props);
    const mtime = mtimeMatch === null ? null : new Date(unescapeXml(mtimeMatch[2]).trim());
    out.push({
      href,
      path: decodeHrefPath(href),
      isDir,
      bytes: lenMatch === null ? null : Number(lenMatch[2]),
      mtime: mtime !== null && !Number.isNaN(mtime.getTime()) ? mtime : null,
    });
  }
  return out;
}

/** 校验并编码一个相对路径；非法（绝对路径、`..`、反斜杠）一律拒绝。 */
export function encodeRelPath(rel) {
  const raw = typeof rel === 'string' ? rel.trim() : '';
  if (raw === '' || raw === '/') return '';
  if (raw.startsWith('/')) throw new WebdavError(`远端路径必须是相对路径，不能以 / 开头：${raw}`);
  if (raw.includes('\\')) throw new WebdavError(`远端路径不能包含反斜杠：${raw}`);
  const segments = raw.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new WebdavError(`远端路径不能包含 . 或 ..：${raw}`);
  }
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

/** 错误信息里给人看的路径：把 `%E4%B8%AD` 解回中文（编码后的路径不该出现在提示里）。 */
function displayPath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** 把状态码翻译成人话。 */
function explainStatus(status, method, path, detail) {
  path = displayPath(path ?? '');
  const tail = detail === '' ? '' : `；服务器返回：${detail.slice(0, 200)}`;
  switch (status) {
    case 401:
      return `认证失败（401）：账号或密码不对${tail}`;
    case 403:
      return `服务器拒绝访问（403）：这个账号没有权限写 ${path || '/'}${tail}`;
    case 404:
      return `远端不存在（404）：${path || '/'}${tail}`;
    case 405:
      return `服务器不接受 ${method}（405）${tail}`;
    case 409:
      return `远端目录不存在（409）：${path || '/'} 的父目录还没建好${tail}`;
    case 423:
      return `远端被锁定（423）：${path} 正被别的客户端占用${tail}`;
    case 507:
      return `远端空间不足（507）：NAS 上没有可用空间了${tail}`;
    default:
      return `${method} ${path || '/'} 失败（HTTP ${status}）${tail}`;
  }
}

/**
 * 造一个 WebDAV 客户端。
 *
 * @param {{
 *   url: string, username?: string, password?: string,
 *   insecureTLS?: boolean, timeoutMs?: number, transferTimeoutMs?: number,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function createWebdav(opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.url);
  const username = typeof opts.username === 'string' ? opts.username : undefined;
  const password = typeof opts.password === 'string' ? opts.password : '';
  const insecureTLS = opts.insecureTLS === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transferTimeoutMs = opts.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const parsedBase = new URL(baseUrl);
  const isHttps = parsedBase.protocol === 'https:';
  const agent = isHttps
    ? new HttpsAgent({ keepAlive: true, rejectUnauthorized: !insecureTLS })
    : new HttpAgent({ keepAlive: true });

  const authHeader =
    username === undefined
      ? null
      : `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

  function buildUrl(path) {
    // 相对路径按 base 拼；以 / 开头的绝对路径替换掉 base 的 path
    return new URL(path === '' ? './' : path, baseUrl).toString();
  }

  /**
   * 发一次请求（自动跟随重定向），返回状态码/头/体。
   * @returns {Promise<{status:number, headers:NodeJS.Dict<string|string[]>, body:Buffer, finalUrl:string}>}
   */
  function send({ method, url, headers = {}, body = null, timeout, redirectsLeft = MAX_REDIRECTS }) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const hdrs = { ...headers };
      if (authHeader !== null && hdrs.authorization === undefined) hdrs.authorization = authHeader;
      if (body !== null) hdrs['content-length'] = String(body.length);
      hdrs.host = target.host;

      const doRequest = isHttps ? httpsRequest : httpRequest;
      const req = doRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? undefined : target.port,
          path: `${target.pathname}${target.search}`,
          method,
          headers: hdrs,
          agent,
          // 自签证书由 agent 的 rejectUnauthorized 控制；这里再显式声明一次更直白
          ...(isHttps ? { rejectUnauthorized: !insecureTLS } : {}),
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const out = { status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: url };
            const location = res.headers.location;
            if (
              [301, 302, 303, 307, 308].includes(status) &&
              typeof location === 'string' &&
              redirectsLeft > 0
            ) {
              const next = new URL(location, url).toString();
              log(`${method} ${target.pathname} → ${status} 重定向到 ${next}`);
              resolve(
                send({
                  method,
                  url: next,
                  headers,
                  body,
                  timeout,
                  redirectsLeft: redirectsLeft - 1,
                }),
              );
              return;
            }
            resolve(out);
          });
        },
      );

      req.setTimeout(timeout, () => {
        req.destroy(new WebdavError(`${method} 超时（${Math.round(timeout / 1000)} 秒没有响应）：${target.href}`));
      });
      req.on('error', (err) => {
        if (err instanceof WebdavError) reject(err);
        else reject(new WebdavError(`${method} ${target.pathname} 连接失败：${err?.message ?? err}`, { cause: err }));
      });
      if (body !== null) req.write(body);
      req.end();
    });
  }

  /** 处理 401 的两种挑战：Basic 报「密码错」，Digest 报「暂不支持」。 */
  function checkAuthChallenge(res, method, path) {
    const challenge = String(res.headers['www-authenticate'] ?? '');
    if (/digest/i.test(challenge) && !/basic/i.test(challenge)) {
      throw new WebdavError(
        `服务器要求 Digest 认证，本插件暂不支持（${path || '/'}）。请在 NAS 上把 WebDAV 认证方式改成 Basic，或改用应用密码。`,
        { status: 401, method, path, detail: challenge },
      );
    }
    return null;
  }

  /** 统一的「非预期状态码」出口。 */
  function fail(method, path, res) {
    if (res.status === 401) {
      checkAuthChallenge(res, method, path);
    }
    throw new WebdavError(explainStatus(res.status, method, path, res.body.toString('utf8').trim()), {
      status: res.status,
      method,
      path,
    });
  }

  async function propfind(path, depth) {
    const url = buildUrl(path);
    const res = await send({
      method: 'PROPFIND',
      url,
      headers: { depth: String(depth), 'content-type': 'application/xml; charset=utf-8' },
      body: Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>',
        'utf8',
      ),
      timeout: timeoutMs,
    });
    return res;
  }

  return {
    baseUrl,
    insecureTLS,
    username,

    /** 列一个目录（Depth: 1）。目录不存在返回空数组 —— 调用方按「云端还没有包」处理。 */
    async list(rel = '', listOpts = {}) {
      const encoded = encodeRelPath(rel);
      const path = typeof listOpts.rawPath === 'string' ? listOpts.rawPath : encoded === '' ? '' : `${encoded}/`;
      const res = await propfind(path, 1);
      if (res.status === 404) return [];
      if (res.status !== 207) {
        if (res.status === 401) checkAuthChallenge(res, 'PROPFIND', path);
        fail('PROPFIND', path, res);
      }
      const collectionPath = decodeHrefPath(new URL(res.finalUrl).pathname);
      const prefix = collectionPath.endsWith('/') ? collectionPath : `${collectionPath}/`;
      const out = [];
      for (const item of parseMultiStatus(res.body.toString('utf8'))) {
        if (item.path === collectionPath || item.path === prefix) continue;
        if (!item.path.startsWith(prefix)) continue;
        const rest = item.path.slice(prefix.length);
        if (rest === '') continue;
        const name = rest.endsWith('/') ? rest.slice(0, -1) : rest;
        if (name === '' || name.includes('/')) continue; // 只要直接子项
        out.push({ name, isDir: item.isDir, bytes: item.bytes, mtime: item.mtime, href: item.href });
      }
      return out;
    },

    /**
     * 逐级建目录；已存在不算错。
     *
     * 「已存在」**必须验证**，不能只看 MKCOL 的状态码：绿联 NAS 的 WebDAV 把若干
     * 共享目录拼成一个只读的虚拟根，在根下 MKCOL 一个不存在的目录时它回 **405**
     * （标准语义 = 集合已存在），可目录根本没被创建，紧接着 PUT 又是 405。
     * 只看状态码就会报「目录就绪」，然后让用户在 PUT 那一步收到一句莫名其妙的
     * `服务器不接受 PUT（405）`，而真正的原因（目录不存在、这个服务不允许在根下新建）
     * 一个字都看不到。所以这里 PROPFIND 复核一次。
     */
    async ensureDir(rel) {
      const encoded = encodeRelPath(rel);
      const created = [];
      const existed = [];
      if (encoded === '') return { ok: true, created, existed };
      const segments = encoded.split('/');
      for (let i = 0; i < segments.length; i += 1) {
        const path = `${segments.slice(0, i + 1).join('/')}/`;
        const res = await send({ method: 'MKCOL', url: buildUrl(path), headers: {}, timeout: timeoutMs });
        if (res.status === 201) {
          created.push(path);
          continue;
        }
        if (res.status === 405 || res.status === 301 || res.status === 302) {
          // 复核：真的在才算「已存在」
          const there = await propfind(path, 0);
          const first = there.status === 207 ? parseMultiStatus(there.body.toString('utf8'))[0] : undefined;
          if (first !== undefined) {
            existed.push(path);
            continue;
          }
          throw new WebdavError(
            `远端目录建不出来：${path}（服务器对 MKCOL 回了 ${res.status}，但复核发现它并不存在）。` +
              '常见原因：这个 WebDAV 服务的根目录是只读的虚拟根（多个共享目录拼起来的），' +
              '不允许在根下新建文件夹 —— 请先在 NAS 上把目录建好，再把它的名字填进「远端目录」。',
            { method: 'MKCOL', path, status: res.status, detail: `${res.status} + PROPFIND ${there.status}` },
          );
        }
        fail('MKCOL', path, res);
      }
      log(`远端目录就绪：${baseUrl}${encoded}/（新建 ${created.length} 级）`);
      return { ok: true, created, existed };
    },

    /** 上传一个文件。**必须**带 Content-Length（不少 NAS 不吃 chunked）。 */
    async put(rel, body, putOpts = {}) {
      const encoded = encodeRelPath(rel);
      if (encoded === '') throw new WebdavError('必须指定要上传到的远端文件名');
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
      const res = await send({
        method: 'PUT',
        url: buildUrl(encoded),
        headers: { 'content-type': putOpts.contentType ?? 'application/octet-stream' },
        body: buf,
        timeout: transferTimeoutMs,
      });
      if (res.status !== 200 && res.status !== 201 && res.status !== 204) fail('PUT', encoded, res);
      return { ok: true, status: res.status, bytes: buf.length };
    },

    /** 下载一个文件，返回 Buffer。 */
    async get(rel) {
      const encoded = encodeRelPath(rel);
      if (encoded === '') throw new WebdavError('必须指定要下载的远端文件名');
      const res = await send({ method: 'GET', url: buildUrl(encoded), headers: {}, timeout: transferTimeoutMs });
      if (res.status !== 200) fail('GET', encoded, res);
      return res.body;
    },

    /** 看一个远端文件的属性；不存在返回 null。 */
    async stat(rel) {
      const encoded = encodeRelPath(rel);
      const res = await propfind(encoded, 0);
      if (res.status === 404) return null;
      if (res.status !== 207) {
        if (res.status === 401) checkAuthChallenge(res, 'PROPFIND', encoded);
        fail('PROPFIND', encoded, res);
      }
      const first = parseMultiStatus(res.body.toString('utf8'))[0];
      if (first === undefined) return null;
      return { name: encoded, isDir: first.isDir, bytes: first.bytes, mtime: first.mtime, href: first.href };
    },

    /** 删除。不存在也算「已经是想要的状态」，但把状态码如实带回去。 */
    async remove(rel) {
      const encoded = encodeRelPath(rel);
      if (encoded === '') throw new WebdavError('必须指定要删除的远端文件');
      const res = await send({ method: 'DELETE', url: buildUrl(encoded), headers: {}, timeout: timeoutMs });
      if (res.status === 404) return { ok: false, status: 404 };
      if (res.status !== 200 && res.status !== 204) fail('DELETE', encoded, res);
      return { ok: true, status: res.status };
    },

    /** 探测：能不能连、认证过不过、是不是 WebDAV。**不抛异常**（用于「保存并测试连接」）。 */
    async probe() {
      try {
        const res = await send({ method: 'OPTIONS', url: buildUrl(''), headers: {}, timeout: timeoutMs });
        if (res.status === 401) {
          checkAuthChallenge(res, 'OPTIONS', '');
          return { ok: false, status: 401, error: '认证失败（401）：账号或密码不对' };
        }
        if (res.status === 200 || res.status === 204) {
          return {
            ok: true,
            status: res.status,
            dav: res.headers.dav ?? null,
            url: baseUrl,
            insecureTLS,
          };
        }
        // 有些服务器不实现 OPTIONS，退回 PROPFIND Depth:0
        const fallback = await propfind('', 0);
        if (fallback.status === 207) return { ok: true, status: fallback.status, dav: null, url: baseUrl };
        if (fallback.status === 401) {
          checkAuthChallenge(fallback, 'PROPFIND', '');
          return { ok: false, status: 401, error: '认证失败（401）：账号或密码不对' };
        }
        return {
          ok: false,
          status: fallback.status,
          error: explainStatus(fallback.status, 'OPTIONS', '', fallback.body.toString('utf8').trim()),
        };
      } catch (err) {
        return { ok: false, status: err instanceof WebdavError ? err.status : null, error: err?.message ?? String(err) };
      }
    },

    /** 关闭连接池（测试与卸载时调用，避免 keepAlive 套接字拖着进程）。 */
    async close() {
      agent.destroy();
    },
  };
}
