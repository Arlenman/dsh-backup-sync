/**
 * 假 WebDAV 服务器（测试夹具，零依赖）。
 *
 * 为什么要自己写一个：真实服务器的方言差异极大（命名空间前缀、尾斜杠重定向、
 * Digest 认证、父目录不存在时的 409、已存在时的 405……），而这些差异恰恰是
 * 客户端最容易写错的地方。把方言做成**可开关的选项**，就能在离线状态下把所有
 * 分支都测一遍 —— 真机（绿联 NAS）只用来做最终确认，不用来发现这些问题。
 *
 * 支持的方法：OPTIONS / PROPFIND(Depth 0|1) / MKCOL / PUT / GET / HEAD / DELETE。
 *
 * @example
 *   const srv = await startFakeWebdav({ root: tmpDir, prefix: 'lp1', trailingSlashRedirect: true });
 *   … srv.url … srv.requests … await srv.stop();
 */
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const METHODS = ['OPTIONS', 'PROPFIND', 'MKCOL', 'PUT', 'GET', 'HEAD', 'DELETE'];

/** 把 URL pathname 里的每一段百分号解码后再落到文件系统上，绝不越过 root。 */
function fsPathOf(root, rootPath, pathname) {
  // `/dav` 与 `/dav/` 必须映射到同一个目录：否则「集合缺尾斜杠」会被当成不存在的
  // 路径直接 404，301 重定向这条分支永远测不到。
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  const bare = prefix.slice(0, -1);
  const rel =
    pathname === bare || pathname === prefix
      ? ''
      : pathname.startsWith(prefix)
        ? pathname.slice(prefix.length)
        : pathname.replace(/^\/+/, '');
  const segments = rel
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decodeURIComponent(s));
  if (segments.some((s) => s === '..' || s.includes('/') || s.includes('\\'))) {
    throw Object.assign(new Error('bad path'), { code: 'EBADPATH' });
  }
  const abs = resolve(root, ...segments);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) throw Object.assign(new Error('escape'), { code: 'EBADPATH' });
  return { abs, segments };
}

/** 由文件系统路径反推出 href（逐段百分号编码，目录补尾斜杠）。 */
function hrefOf(rootPath, segments, isDir) {
  const enc = segments.map((s) => encodeURIComponent(s)).join('/');
  const base = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return `${base}${enc}${isDir && enc !== '' ? '/' : ''}`;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 读整个请求体（慢，但夹具只用在小文件上）。 */
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}

/**
 * @param {{
 *   root: string,                      必填：服务器内容落的本地目录
 *   port?: number,                     0 = 随机端口
 *   rootPath?: string,                 默认 /dav/
 *   username?: string, password?: string
 *   requireAuth?: boolean,             默认 true
 *   digest?: boolean,                  true = 只发 Digest 挑战（用来断言客户端明确报错）
 *   prefix?: string,                   XML 命名空间前缀：'D' | 'd' | 'lp1' | ''（默认命名空间）
 *   trailingSlashRedirect?: boolean,   true = 集合不带尾斜杠时 301（很多真服务器这样）
 *   readonly?: boolean,                true = 一切写操作 403
 *   davHeader?: string,                OPTIONS 返回的 DAV 头，默认 '1, 2'
 * }} opts
 */
export async function startFakeWebdav(opts = {}) {
  const root = resolve(opts.root);
  const rootPath = opts.rootPath ?? '/dav/';
  const username = opts.username ?? 'u';
  const password = opts.password ?? 'p';
  const requireAuth = opts.requireAuth !== false;
  const prefix = opts.prefix ?? 'D';
  const tag = (name) => (prefix === '' ? name : `${prefix}:${name}`);
  const nsAttr = prefix === '' ? 'xmlns="DAV:"' : `xmlns:${prefix}="DAV:"`;
  const trailingSlashRedirect = opts.trailingSlashRedirect !== false;
  const readonly = opts.readonly === true;

  await mkdir(root, { recursive: true });

  /** @type {{method:string,path:string,headers:any,bodyBytes:number,status:number}[]} */
  const requests = [];

  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

  function authorized(req) {
    if (!requireAuth) return true;
    // digest:true 表示「这台服务器只认 Digest」——Basic 一律不认，
    // 否则测不出客户端对 Digest 挑战的明确报错。
    if (opts.digest === true) return false;
    return req.headers.authorization === expectedAuth;
  }

  function challenge(res) {
    res.writeHead(401, {
      'WWW-Authenticate': opts.digest === true
        ? `Digest realm="dav", nonce="abc123", qop="auth"`
        : 'Basic realm="dav"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('unauthorized');
  }

  function propstatFor(href, st, isDir) {
    const props = [];
    if (isDir) props.push(`<${tag('resourcetype')}><${tag('collection')}/></${tag('resourcetype')}>`);
    else props.push(`<${tag('resourcetype')}/>`);
    props.push(`<${tag('getlastmodified')}>${st.mtime.toUTCString()}</${tag('getlastmodified')}>`);
    if (!isDir) props.push(`<${tag('getcontentlength')}>${st.size}</${tag('getcontentlength')}>`);
    return [
      `  <${tag('response')}>`,
      `    <${tag('href')}>${xmlEscape(href)}</${tag('href')}>`,
      `    <${tag('propstat')}>`,
      `      <${tag('prop')}>${props.join('')}</${tag('prop')}>`,
      `      <${tag('status')}>HTTP/1.1 200 OK</${tag('status')}>`,
      `    </${tag('propstat')}>`,
      `  </${tag('response')}>`,
    ].join('\n');
  }

  async function multiStatus(res, entries) {
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<${tag('multistatus')} ${nsAttr}>`,
      ...entries,
      `</${tag('multistatus')}>`,
      '',
    ].join('\n');
    res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(body);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    let target;
    try {
      target = fsPathOf(root, rootPath, pathname);
    } catch {
      requests.push({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 400 });
      res.writeHead(400).end('bad path');
      return;
    }

    const finish = (status, headers, body) => {
      requests.push({ method, path: pathname, headers: req.headers, bodyBytes: 0, status });
      res.writeHead(status, headers ?? {});
      res.end(body ?? '');
    };

    if (!authorized(req)) {
      requests.push({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 401 });
      challenge(res);
      return;
    }

    let st = null;
    try {
      st = await stat(target.abs);
    } catch {
      st = null;
    }

    // 集合不带尾斜杠 → 301（真服务器常见行为，客户端必须能跟）
    if (trailingSlashRedirect && st?.isDirectory() && !pathname.endsWith('/')) {
      requests.push({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 301 });
      res.writeHead(301, { Location: `${pathname}/` });
      res.end();
      return;
    }

    if (method === 'OPTIONS') {
      finish(200, { DAV: opts.davHeader ?? '1, 2', Allow: METHODS.join(', '), 'content-length': '0' });
      return;
    }

    if (method === 'PROPFIND') {
      if (st === null) {
        finish(404);
        return;
      }
      const depth = String(req.headers.depth ?? '1');
      const isDir = st.isDirectory();
      const entries = [propstatFor(hrefOf(rootPath, target.segments, isDir), st, isDir)];
      if (depth !== '0' && isDir) {
        const names = await readdir(target.abs);
        for (const name of names) {
          const childAbs = join(target.abs, name);
          const cst = await stat(childAbs);
          entries.push(propstatFor(hrefOf(rootPath, [...target.segments, name], cst.isDirectory()), cst, cst.isDirectory()));
        }
      }
      await multiStatus(res, entries);
      requests.push({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 207 });
      return;
    }

    if (method === 'MKCOL') {
      if (readonly) return finish(403);
      if (st !== null) return finish(405);
      const parent = await stat(resolve(target.abs, '..')).catch(() => null);
      if (parent === null || !parent.isDirectory()) return finish(409);
      await mkdir(target.abs);
      return finish(201);
    }

    if (method === 'PUT') {
      if (readonly) return finish(403);
      const parent = await stat(resolve(target.abs, '..')).catch(() => null);
      if (parent === null || !parent.isDirectory()) return finish(409);
      if (st?.isDirectory()) return finish(405);
      const body = await readBody(req);
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared !== body.length) {
        // 夹具自己也要防一手：声明长度与实收不一致就是客户端错了
        requests.push({ method, path: pathname, headers: req.headers, bodyBytes: body.length, status: 400 });
        res.writeHead(400).end('length mismatch');
        return;
      }
      await writeFile(target.abs, body);
      finish(st === null ? 201 : 204, {}, '');
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      if (st === null || st.isDirectory()) return finish(404);
      const body = await readFile(target.abs);
      if (method === 'HEAD') {
        finish(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' });
        return;
      }
      finish(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' }, body);
      return;
    }

    if (method === 'DELETE') {
      if (readonly) return finish(403);
      if (st === null) return finish(404);
      await rm(target.abs, { recursive: true, force: true });
      return finish(204);
    }

    finish(405, { Allow: METHODS.join(', ') });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`fake webdav error: ${err?.message ?? err}`);
    });
  });

  await new Promise((ok) => server.listen(opts.port ?? 0, '127.0.0.1', ok));
  const port = server.address().port;

  return {
    port,
    root,
    rootPath,
    url: `http://127.0.0.1:${port}${rootPath}`,
    requests,
    /** 相对 rootPath 的文件清单（用 posix 风格），便于断言 */
    async files() {
      const out = [];
      const walk = async (dir) => {
        for (const name of await readdir(dir)) {
          const abs = join(dir, name);
          const s = await stat(abs);
          if (s.isDirectory()) await walk(abs);
          else out.push({ name: relative(root, abs).split(sep).join('/'), bytes: s.size });
        }
      };
      await walk(root);
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    /** 断言用：某次请求的原始头 */
    last(method) {
      for (let i = requests.length - 1; i >= 0; i -= 1) if (requests[i].method === method) return requests[i];
      return null;
    },
    /**
     * 收摊。**必须掐掉 keep-alive 连接**：`server.close()` 只停止接受新连接，
     * 已建立的长连接会让它永远不回调 —— 表现成整个测试进程跑完不退出。
     */
    async stop() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((ok) => server.close(() => ok()));
    },
  };
}
