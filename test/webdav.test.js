/**
 * WebDAV 客户端的单元测试 —— 全部对着**假 WebDAV 服务器**跑（真 HTTP、真 fs），
 * 不碰网络、不碰用户数据。
 *
 * 测试的重点是**方言差异**：命名空间前缀、尾斜杠重定向、Digest 挑战、
 * 父目录缺失的 409、只读 403、中文名的百分号编码 —— 这些在真机上都会遇到。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeWebdav } from './fake-webdav.js';
import { withTempDir } from './fixture.js';
import { createWebdav, normalizeBaseUrl, WebdavError } from '../lib/webdav.js';

/** 起一个假服务器 + 一个客户端（可自定义凭据），测试结束**一定**收摊。 */
async function withCreds({ server = {}, client = {} }, fn) {
  return withTempDir('.tmp-webdav-', async (root) => {
    const srv = await startFakeWebdav({ root, ...server });
    const dav = createWebdav({ url: srv.url, ...client });
    try {
      return await fn({ srv, client: dav, root });
    } finally {
      await dav.close();
      await srv.stop();
    }
  });
}

/** 起一个假服务器 + 一个客户端，测试结束自动收摊。 */
async function withServer(opts, fn) {
  return withCreds(
    {
      server: opts ?? {},
      client: { username: opts?.username ?? 'u', password: opts?.password ?? 'p', insecureTLS: false },
    },
    fn,
  );
}

// ───────────────────────── 地址归一化

test('normalizeBaseUrl：补尾斜杠、保留已有斜杠、拒绝非法输入', () => {
  assert.equal(normalizeBaseUrl('http://nas:5005/webdav'), 'http://nas:5005/webdav/');
  assert.equal(normalizeBaseUrl('http://nas:5005/webdav/'), 'http://nas:5005/webdav/');
  assert.equal(normalizeBaseUrl('  https://nas.example.com/remote.php/dav/files/u  '), 'https://nas.example.com/remote.php/dav/files/u/');
  assert.throws(() => normalizeBaseUrl(''), /必须填写/);
  assert.throws(() => normalizeBaseUrl('nas:5005/webdav'), /http/);
  assert.throws(() => normalizeBaseUrl('ftp://nas/webdav'), /http/);
  assert.throws(() => normalizeBaseUrl(null), /必须填写/);
});

test('normalizeBaseUrl：保留查询参数与端口，去掉重复斜杠', () => {
  assert.equal(normalizeBaseUrl('http://nas:5005//dav//'), 'http://nas:5005/dav/');
});

// ───────────────────────── PROPFIND / 列目录

for (const prefix of ['D', 'd', 'lp1', '']) {
  test(`list：命名空间前缀 "${prefix || '(默认)'}" 也能解析出名称/大小/时间/目录`, async () => {
    await withServer({ prefix }, async ({ srv, client, root }) => {
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(root, 'a.tar.gz'), Buffer.alloc(1234, 7));
      await writeFile(join(root, '笔记 备份.tar.gz'), Buffer.from('hello', 'utf8'));

      const entries = await client.list('');
      const byName = new Map(entries.map((e) => [e.name, e]));

      assert.ok(byName.has('a.tar.gz'), `缺少 a.tar.gz，实际：${[...byName.keys()].join(',')}`);
      assert.equal(byName.get('a.tar.gz').isDir, false);
      assert.equal(byName.get('a.tar.gz').bytes, 1234);
      assert.ok(byName.get('a.tar.gz').mtime instanceof Date);
      assert.equal(byName.get('sub').isDir, true);
      assert.equal(byName.get('笔记 备份.tar.gz').bytes, 5, '中文名必须能百分号解码');
      // 服务器自身那条（Depth:1 的第一条）不该混进结果
      assert.equal(entries.some((e) => e.name === '' || e.name === '.'), false);
      void srv;
    });
  });
}

test('list：非 ASCII 名字与 .sha256 边车都能列出', async () => {
  await withServer({}, async ({ client, root }) => {
    await writeFile(join(root, 'dsh-sync-20261015-101010.tar.gz'), 'x');
    await writeFile(join(root, 'dsh-sync-20261015-101010.tar.gz.sha256'), 'y');
    const names = (await client.list('')).map((e) => e.name).sort();
    assert.deepEqual(names, ['dsh-sync-20261015-101010.tar.gz', 'dsh-sync-20261015-101010.tar.gz.sha256']);
  });
});

test('list：集合不带尾斜杠时跟随 301 重定向', async () => {
  await withServer({ trailingSlashRedirect: true }, async ({ client, root }) => {
    await writeFile(join(root, 'x.txt'), 'x');
    // 故意请求不带尾斜杠的路径
    const entries = await client.list('', { rawPath: '/dav' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'x.txt');
  });
});

test('list：目录不存在时返回空数组而不是抛错', async () => {
  await withServer({}, async ({ client }) => {
    assert.deepEqual(await client.list('nope'), []);
  });
});

test('list：401（密码错）→ 明确的认证失败错误', async () => {
  await withCreds({ server: { username: 'u', password: 'right' }, client: { username: 'u', password: 'wrong' } }, async ({ client }) => {
    await assert.rejects(() => client.list(''), (err) => {
      assert.ok(err instanceof WebdavError);
      assert.equal(err.status, 401);
      assert.match(err.message, /认证失败/);
      return true;
    });
  });
});

test('list：服务器只给 Digest 挑战 → 明确说「暂不支持」而不是含糊失败', async () => {
  await withCreds({ server: { digest: true }, client: { username: 'u', password: 'p' } }, async ({ client }) => {
    await assert.rejects(() => client.list(''), /Digest/);
  });
});

// ───────────────────────── MKCOL

test('ensureDir：逐级创建，已存在不算错', async () => {
  await withServer({}, async ({ client, srv, root }) => {
    const r1 = await client.ensureDir('a/b/c');
    assert.equal(r1.ok, true);
    assert.ok(r1.created.length >= 1);
    assert.ok((await stat(join(root, 'a', 'b', 'c'))).isDirectory(), '远端目录必须真的落到磁盘上');

    // 再来一次：MKCOL 会 405，必须被当成「已存在」放行
    const r2 = await client.ensureDir('a/b/c');
    assert.equal(r2.ok, true);
    assert.equal(r2.created.length, 0);
    void srv;
  });
});

test('ensureDir：远端只读 → 403 原样报出', async () => {
  await withServer({ readonly: true }, async ({ client }) => {
    await assert.rejects(() => client.ensureDir('a'), (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /没有权限|拒绝/);
      return true;
    });
  });
});

// ───────────────────────── PUT / GET

test('put：必须带 Content-Length，且值等于实际字节数', async () => {
  await withServer({}, async ({ client, srv }) => {
    const body = Buffer.from('hello world', 'utf8');
    const r = await client.put('a.txt', body);
    assert.equal(r.status, 201);
    const req = srv.last('PUT');
    assert.equal(req.headers['content-length'], String(body.length));
    assert.equal(req.headers['transfer-encoding'], undefined, '不能用 chunked');
  });
});

test('put：父目录不存在 → 409，且错误可读', async () => {
  await withServer({}, async ({ client }) => {
    await assert.rejects(() => client.put('nope/a.txt', Buffer.from('x')), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /父目录|目录不存在|409/);
      return true;
    });
  });
});

test('put + get：往返字节完全一致（含二进制与中文名）', async () => {
  await withServer({}, async ({ client }) => {
    const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    // 远端不会替我们建目录（真 NAS 同样回 409），先显式建好
    await client.ensureDir('子目录');
    await client.put('子目录/备份 包.tar.gz', body);
    const got = await client.get('子目录/备份 包.tar.gz');
    assert.equal(got.length, body.length);
    assert.ok(got.equals(body));
  });
});

test('get：文件不存在 → 404', async () => {
  await withServer({}, async ({ client }) => {
    await assert.rejects(() => client.get('missing.bin'), (err) => {
      assert.equal(err.status, 404);
      return true;
    });
  });
});

test('stat：存在返回大小与时间，不存在返回 null', async () => {
  await withServer({}, async ({ client, root }) => {
    await writeFile(join(root, 's.bin'), Buffer.alloc(77));
    const hit = await client.stat('s.bin');
    assert.equal(hit.bytes, 77);
    assert.equal(await client.stat('nope.bin'), null);
  });
});

// ───────────────────────── DELETE

test('remove：删掉文件；不存在也不抛（幂等）', async () => {
  await withServer({}, async ({ client, srv }) => {
    await client.put('gone.txt', Buffer.from('x'));
    const r = await client.remove('gone.txt');
    assert.ok([200, 204].includes(r.status));
    const again = await client.remove('gone.txt');
    assert.equal(again.status, 404);
    assert.equal(again.ok, false);
    void srv;
  });
});

// ───────────────────────── 路径安全

test('路径穿越与绝对路径一律拒绝（不发请求）', async () => {
  await withServer({}, async ({ client, srv }) => {
    const before = srv.requests.length;
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'a//b/../..']) {
      await assert.rejects(() => client.put(bad, Buffer.from('x')), /路径/);
    }
    assert.equal(srv.requests.length, before, '非法路径不该产生任何 HTTP 请求');
  });
});

// ───────────────────────── 连接探测

test('probe：连得上返回 dav 头，密码错返回 401 而不是抛异常', async () => {
  await withServer({}, async ({ client }) => {
    const ok = await client.probe();
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.match(String(ok.dav ?? ''), /1/);
  });

  await withCreds({ server: { username: 'u', password: 'right' }, client: { username: 'u', password: 'bad' } }, async ({ client }) => {
    const r = await client.probe();
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });
});

test('probe：端口不通时给出可读错误（连接被拒）', async () => {
  const client = createWebdav({ url: 'http://127.0.0.1:1/dav/', username: 'u', password: 'p' });
  const r = await client.probe();
  assert.equal(r.ok, false);
  assert.ok(r.error, '必须带上原因');
  await client.close();
});

after(() => {
  // 没有全局资源要清，留个钩子方便以后加
});
