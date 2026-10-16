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
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
 *   readonlyRoot?: boolean,            true = 只读的「虚拟根」：根下 MKCOL 回 405 但什么也不建，
 *                                      根下 PUT 也 405（2026-10-16 在绿联 NAS 实测的真形态：
 *                                      它的根是多个共享目录拼出来的虚拟根，不允许新建集合）
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
  const readonlyRoot = opts.readonlyRoot === true;
  /** 直接位于根下的路径（不含根自身）。 */
  const isAtRoot = (segments) => segments.length <= 1;

  await mkdir(root, { recursive: true });

  /** @type {{method:string,path:string,headers:any,bodyBytes:number,status:number}[]} */
  const requests = [];

  /**
   * 记一条请求。可选地把**脱敏后**的摘要追加到日志文件（CLI 模式用）：
   * 授权头是 `Basic base64(用户:口令)`，落盘就等于把口令写进明文日志，
   * 所以只记方法与长度这类元信息，绝不记 authorization。
   */
  function record(entry) {
    requests.push(entry);
    if (typeof opts.logPath === 'string' && opts.logPath !== '') {
      const h = entry.headers ?? {};
      appendFileSync(
        opts.logPath,
        `${JSON.stringify({
          method: entry.method,
          path: entry.path,
          status: entry.status,
          bodyBytes: entry.bodyBytes,
          contentLength: h['content-length'] ?? null,
          transferEncoding: h['transfer-encoding'] ?? null,
          depth: h.depth ?? null,
          contentType: h['content-type'] ?? null,
        })}\n`,
      );
    }
  }

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
      record({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 400 });
      res.writeHead(400).end('bad path');
      return;
    }

    const finish = (status, headers, body) => {
      record({ method, path: pathname, headers: req.headers, bodyBytes: 0, status });
      res.writeHead(status, headers ?? {});
      res.end(body ?? '');
    };

    if (!authorized(req)) {
      record({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 401 });
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
      record({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 301 });
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
      record({ method, path: pathname, headers: req.headers, bodyBytes: 0, status: 207 });
      return;
    }

    if (method === 'MKCOL') {
      if (readonly) return finish(403);
      if (st !== null) return finish(405);
      // 虚拟根：回 405（看起来像「已存在」）但目录根本没建 —— 客户端只看状态码
      // 就会误判成「目录就绪」，随后 PUT 一句莫名其妙的 405。
      if (readonlyRoot && isAtRoot(target.segments)) return finish(405);
      const parent = await stat(resolve(target.abs, '..')).catch(() => null);
      if (parent === null || !parent.isDirectory()) return finish(409);
      await mkdir(target.abs);
      return finish(201);
    }

    if (method === 'PUT') {
      if (readonly) return finish(403);
      const parent = await stat(resolve(target.abs, '..')).catch(() => null);
      // 父目录不存在：标准服务器回 409，绿联那个虚拟根回的是 405（实测）。
      // 两种都要能测，否则客户端很容易把 405 误读成「服务器不支持 PUT」。
      if (parent === null || !parent.isDirectory()) return finish(readonlyRoot ? 405 : 409);
      if (st?.isDirectory()) return finish(405);
      const body = await readBody(req);
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared !== body.length) {
        // 夹具自己也要防一手：声明长度与实收不一致就是客户端错了
        record({ method, path: pathname, headers: req.headers, bodyBytes: body.length, status: 400 });
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

// ─────────────────────────── CLI：把假服务器单独当进程跑起来
//
//   node test/fake-webdav.js --port 19700 --dir D:\tmp\dav --user u --pass p
//
// 端到端脚本（Task 6）需要一个「真进程、真端口、真 Basic 认证」的服务器：同进程内
// 起服务器会让人分不清失败是客户端的问题还是服务器没起来。这个模式不依赖测试框架，
// 打印一行 READY 供调用方等待，收到 SIGINT/SIGTERM 就退出。
//
// `--dir` 是服务器内容落的本地目录（= 远端文件系统的根），不传就用系统临时目录。
// 退出信号默认只认 SIGINT/SIGTERM —— **不要**顺手把 stdin 关闭也当退出信号：调用方
// 常常是 stdin 已经关掉的子进程（PowerShell 的 Start-Job、CI 里的 spawn），那样服务器
// 会刚打印 READY 就退出，症状是连接被拒（curl 返回 000）而日志看起来完全正常。
// 需要「父进程一关管道就跟着退」的调用方显式加 `--exit-on-stdin-close`。
function parseCliArgs(argv) {
  const out = { port: 0, dir: null, rootPath: '/dav/', user: 'u', pass: 'p', log: null, exitOnStdinClose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    const take = () => {
      i += 1;
      return val;
    };
    if (key === '--port') out.port = Number(take());
    else if (key === '--dir') out.dir = take();
    else if (key === '--path') out.rootPath = take();
    else if (key === '--user') out.user = take();
    else if (key === '--pass') out.pass = take();
    else if (key === '--log') out.log = take();
    else if (key === '--exit-on-stdin-close') out.exitOnStdinClose = true;
    else if (key === '--help' || key === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(
      'usage: node test/fake-webdav.js [--port 19700] [--dir <root>] [--path /dav/] [--user u] [--pass p] [--log <file>] [--exit-on-stdin-close]\n',
    );
    return;
  }
  const dir = args.dir ?? join(tmpdir(), 'dsh-fake-webdav');
  const srv = await startFakeWebdav({
    root: dir,
    port: Number.isFinite(args.port) ? args.port : 0,
    rootPath: args.rootPath,
    username: args.user,
    password: args.pass,
    logPath: args.log,
  });
  // 机器可读的一行：调用方 grep 出 url 就能用，不必猜端口。
  process.stdout.write(`READY url=${srv.url} root=${srv.root} user=${args.user}\n`);

  const bye = async () => {
    await srv.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  if (args.exitOnStdinClose === true) {
    process.stdin.on('end', bye);
    process.stdin.on('close', bye);
    process.stdin.resume();
  }
}

/**
 * 只有「直接被 node 执行」时才自动起服务。
 *
 * 两个坑都在这里挡掉：
 * ① `node --test` 不带参数时会把 `test/` 下的**每个**文件都当测试文件跑（Node 的默认
 *    匹配规则是 `**\/test\/**\/*.js`），于是这个文件会被当成测试文件执行一遍 —— 它的
 *    main() 会老老实实起一台服务器并常驻，整个测试进程就永远不退出（表现为 npm test
 *    卡死、无输出）。测试子进程里 Node 会设 `NODE_TEST_CONTEXT`，据此跳过。
 * ② 显式 `node --test test/fake-webdav.js` 同样会命中上面的情况，所以不能只判断 argv[1]。
 */
const underTestRunner = typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT !== '';

if (!underTestRunner && process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`fake-webdav: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
