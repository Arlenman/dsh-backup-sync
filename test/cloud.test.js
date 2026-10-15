/**
 * 云端编排层的测试（`lib/cloud.js`）。
 *
 * 单位的划分：**协议**归 `webdav.js`（已有 22 项测试），**编排**归这里。
 * 所以这里不重复测 PROPFIND 怎么解析，只测：
 *  - 密码与配置**分家**（密码绝不进 settings.json、绝不进任何视图）；
 *  - 上传/下载/删除的**准入**（只认自己生成的包名）；
 *  - 传输后的**核对**（远端字节数、sha256）；
 *  - 失败时**不留残文件、不吞错误**。
 *
 * 包用**手工合成**的文件（不跑 tar）—— 云端层根本不解包，合成包更快也更干净；
 * 真正的「跑一次备份再上传」由最后一项集成测试和 T6 端到端负责。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeWebdav } from './fake-webdav.js';
import { withFixture } from './fixture.js';
import { settingsPathOf } from '../lib/settings.js';
import { inspectPath } from '../lib/guard.js';
import { sha256File, sha256Text } from '../lib/hash.js';
import { runBackup } from '../lib/service.js';
import {
  CLOUD_CREDENTIALS_BASENAME,
  cloudView,
  credentialsPathOf,
  downloadRemote,
  listRemote,
  loadCloudCredentials,
  normalizeRemoteDir,
  removeRemote,
  saveCloudConfig,
  saveCloudPassword,
  testConnection,
  uploadArchive,
} from '../lib/cloud.js';

/** 造一个「像真备份包」的三件套，不跑 tar。 */
async function seedArchive(outDir, name = 'dsh-sync-20261015-101010.tar.gz', bytes = 4096) {
  await mkdir(outDir, { recursive: true });
  const body = Buffer.alloc(bytes, 0x41);
  const full = join(outDir, name);
  await writeFile(full, body);
  const sha = sha256Text(body.toString('latin1')); // 仅占位，下面用真哈希覆盖
  const real = await sha256File(full);
  await writeFile(`${full}.sha256`, `${real}  ${name}\n`, 'utf8');
  await writeFile(
    `${full}.meta.json`,
    `${JSON.stringify({ format: 'dsh-backup-sync', name, sha256: real, totals: { bytes } }, null, 2)}\n`,
    'utf8',
  );
  void sha;
  return { name, path: full, sha256: real, bytes };
}

/** 夹具 + 假云 + 已保存的配置（一步到位，保证收摊）。 */
async function withCloud(opts, fn) {
  const { server = {}, config = {}, password = 'p' } = opts ?? {};
  return withFixture(async (fx) => {
    const davRoot = join(fx.root, 'dav-root');
    await mkdir(davRoot, { recursive: true });
    const outDir = join(fx.root, 'backups');
    const srv = await startFakeWebdav({ root: davRoot, ...server });
    // 建服务器之后的**每一行**都必须在 try 里：夹具自己抛错时若不收摊，
    // 监听中的 socket 会把这个测试进程永远吊住（表现成「跑完不退出」）。
    try {
      await saveCloudConfig(fx.roots, {
        enabled: true,
        url: srv.url,
        username: 'u',
        remoteDir: 'dsh-backup',
        ...config,
      });
      if (password !== null) await saveCloudPassword(fx.roots, password);
      return await fn({ ...fx, srv, davRoot, outDir });
    } finally {
      await srv.stop();
    }
  });
}

// ───────────────────────── 目录归一化

test('normalizeRemoteDir：去首尾与重复斜杠、反斜杠归一，空与 .. 一律拒绝', () => {
  assert.equal(normalizeRemoteDir('dsh-backup'), 'dsh-backup');
  assert.equal(normalizeRemoteDir('/dsh-backup/'), 'dsh-backup');
  assert.equal(normalizeRemoteDir('a//b/'), 'a/b');
  assert.equal(normalizeRemoteDir('dsh-backup\\sub'), 'dsh-backup/sub');
  assert.throws(() => normalizeRemoteDir(''), /不能为空/);
  assert.throws(() => normalizeRemoteDir('   '), /不能为空/);
  assert.throws(() => normalizeRemoteDir(null), /不能为空/);
  assert.throws(() => normalizeRemoteDir('a/../b'), /\.\./);
  assert.throws(() => normalizeRemoteDir('../x'), /\.\./);
});

// ───────────────────────── 配置与密码分家

test('saveCloudConfig：url 归一化、局部 patch 不丢字段、非法输入拒绝', async () => {
  await withFixture(async (fx) => {
    const a = await saveCloudConfig(fx.roots, {
      url: 'http://nas:5005/webdav',
      username: 'u',
      remoteDir: '/dsh-backup/',
    });
    assert.equal(a.cloud.url, 'http://nas:5005/webdav/', 'url 必须补尾斜杠');
    assert.equal(a.cloud.remoteDir, 'dsh-backup');
    assert.equal(a.cloud.enabled, false, '默认不开');

    const b = await saveCloudConfig(fx.roots, { autoUpload: true });
    assert.equal(b.cloud.autoUpload, true);
    assert.equal(b.cloud.url, 'http://nas:5005/webdav/', '局部 patch 不能把 url 抹掉');
    assert.equal(b.cloud.remoteDir, 'dsh-backup');

    // 落盘的 settings.json 里不该有 password 这个键
    const raw = JSON.parse(await readFile(settingsPathOf(fx.roots), 'utf8'));
    assert.equal('password' in raw.cloud, false);
    assert.equal(raw.cloud.username, 'u');

    await assert.rejects(() => saveCloudConfig(fx.roots, { url: 'nas:5005/webdav' }), /http/);
    await assert.rejects(() => saveCloudConfig(fx.roots, { remoteDir: '../evil' }), /\.\./);
  });
});

test('密码单独存文件：不进 settings.json、视图只回 hasPassword；空密码=清除', async () => {
  await withFixture(async (fx) => {
    await saveCloudConfig(fx.roots, { url: 'http://nas:5005/webdav/' });
    await saveCloudPassword(fx.roots, 'super-secret-pw');

    const creds = await loadCloudCredentials(fx.roots);
    assert.equal(creds.password, 'super-secret-pw');

    const view = await cloudView(fx.roots);
    assert.equal(view.hasPassword, true);
    assert.equal(JSON.stringify(view).includes('super-secret-pw'), false, '视图里绝不能出现密码');

    const settingsRaw = await readFile(settingsPathOf(fx.roots), 'utf8');
    assert.equal(settingsRaw.includes('super-secret-pw'), false, 'settings.json 里绝不能出现密码');

    // 凭据文件必须被守卫拦住 —— 否则它会被打进备份包、跟着包上云
    assert.equal(CLOUD_CREDENTIALS_BASENAME, 'cloud-credentials.json');
    assert.match(String(inspectPath(credentialsPathOf(fx.roots))), /凭据/);

    await saveCloudPassword(fx.roots, '');
    assert.equal((await cloudView(fx.roots)).hasPassword, false);
    assert.equal(existsSync(credentialsPathOf(fx.roots)), false, '清空密码必须把文件删掉');
  });
});

test('cloudView：配置齐全才算 ready；坏掉的凭据文件不致命', async () => {
  await withFixture(async (fx) => {
    const empty = await cloudView(fx.roots);
    assert.equal(empty.ready, false);
    assert.equal(empty.url, null);
    assert.equal(empty.remoteDir, 'dsh-backup', '默认远端目录');

    await saveCloudConfig(fx.roots, { url: 'http://nas:5005/webdav/', username: 'u' });
    assert.equal((await cloudView(fx.roots)).ready, false, '没密码不算就绪');
    await saveCloudPassword(fx.roots, 'p');
    assert.equal((await cloudView(fx.roots)).ready, true);

    await writeFile(credentialsPathOf(fx.roots), '{ 坏掉的 JSON', 'utf8');
    const creds = await loadCloudCredentials(fx.roots);
    assert.equal(creds.password, null);
    assert.equal(creds.corrupted, true);
    assert.equal((await cloudView(fx.roots)).ready, false);
  });
});

// ───────────────────────── 连接测试

test('testConnection：认证通过会建好远端目录；密码错则如实报 401', async () => {
  await withCloud({}, async ({ roots, srv }) => {
    const r = await testConnection(roots);
    assert.equal(r.ok, true);
    assert.equal(r.remoteDir, 'dsh-backup');
    assert.ok(existsSync(join(srv.root, 'dsh-backup')), '远端目录要被建出来');
    assert.match(String(r.dav ?? ''), /1/);
    assert.equal(r.url, srv.url);
  });

  await withCloud({ server: { username: 'u', password: 'right' }, password: 'wrong' }, async ({ roots }) => {
    const r = await testConnection(roots);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.match(String(r.error), /认证失败|401/);
  });
});

// ───────────────────────── 上传

test('uploadArchive：上传三件套并核对远端字节数', async () => {
  await withCloud({}, async ({ roots, srv, outDir }) => {
    const made = await seedArchive(outDir, 'dsh-sync-20261015-101010.tar.gz', 4096);
    const r = await uploadArchive(roots, { outDir });
    assert.equal(r.ok, true);
    assert.equal(r.archive.name, made.name);
    assert.equal(r.archive.bytes, made.bytes);
    assert.equal(r.archive.sha256, made.sha256);
    assert.deepEqual(
      r.files.map((f) => f.name).sort(),
      [made.name, `${made.name}.meta.json`, `${made.name}.sha256`].sort(),
    );
    for (const f of r.files) assert.equal(f.remoteBytes, f.bytes, `${f.name} 远端字节数必须与本地一致`);

    const onDisk = await readdir(join(srv.root, 'dsh-backup'));
    assert.deepEqual(onDisk.sort(), [made.name, `${made.name}.meta.json`, `${made.name}.sha256`].sort());
    assert.equal((await sha256File(join(srv.root, 'dsh-backup', made.name))), made.sha256);

    // 上传记录要落进 settings.cloud，界面刷新后能显示「上次上传」
    const view = await cloudView(roots);
    assert.equal(view.lastUpload.name, made.name);
    assert.equal(view.lastUpload.bytes, made.bytes);
    assert.ok(view.lastUpload.at > 0);
  });
});

test('uploadArchive：默认传最新那一份；没有包时给出人话错误', async () => {
  await withCloud({}, async ({ roots, outDir }) => {
    await assert.rejects(() => uploadArchive(roots, { outDir }), /没有找到|先去打一个包/);
    await seedArchive(outDir, 'dsh-sync-20261015-090000.tar.gz', 100);
    await new Promise((r) => setTimeout(r, 1100));
    const newer = await seedArchive(outDir, 'dsh-sync-20261015-101010.tar.gz', 200);
    const r = await uploadArchive(roots, { outDir });
    assert.equal(r.archive.name, newer.name, '默认必须传最新的那一份');
  });
});

test('uploadArchive：只认自己的命名，不给别人的压缩包上云', async () => {
  await withCloud({}, async ({ roots, outDir }) => {
    await seedArchive(outDir, '别人的备份.tar.gz', 64);
    await assert.rejects(() => uploadArchive(roots, { outDir, name: '别人的备份.tar.gz' }), /不是本插件|只认/);
  });
});

test('uploadArchive：远端拒绝（只读）时如实报错，且不写 lastUpload', async () => {
  await withCloud({ server: { readonly: true } }, async ({ roots, outDir }) => {
    await seedArchive(outDir);
    await assert.rejects(() => uploadArchive(roots, { outDir }), /没有权限|拒绝|403/);
    assert.equal((await cloudView(roots)).lastUpload, null);
  });
});

// ───────────────────────── 列远端

test('listRemote：标注是否自有、本地是否存在、远端是否更新', async () => {
  await withCloud({}, async ({ roots, outDir }) => {
    const made = await seedArchive(outDir, 'dsh-sync-20261015-101010.tar.gz', 2048);
    await writeFile(join(roots.dshHome, 'backup-sync', '..', 'x.txt'), 'x').catch(() => {});
    // outDir 必须显式传：云端那侧只认「你告诉它的本地备份目录」，
    // 真实调用里由路由层把设置里解析出来的目录传进来（同 /sync/list 的做法）
    const before = await listRemote(roots, { outDir });
    assert.equal(before.ok, true);
    assert.deepEqual(before.files, []);
    assert.equal(before.dirMissing, true, '远端目录还不存在时要能区分出来');

    await uploadArchive(roots, { outDir });
    const after = await listRemote(roots, { outDir });
    assert.equal(after.dirMissing, false);
    assert.equal(after.files.length, 1, '边车文件（.sha256/.meta.json）不该当备份包列出来');
    const row = after.files[0];
    assert.equal(row.name, made.name);
    assert.equal(row.isOwn, true);
    assert.equal(row.localExists, true);
    assert.equal(row.bytes, made.bytes);

    // 把本地包删掉 → localExists 变 false
    await rm(made.path, { force: true });
    const gone = await listRemote(roots, { outDir });
    assert.equal(gone.files[0].localExists, false);
    assert.equal(gone.files[0].isOwn, true);
  });
});

// ───────────────────────── 下载

test('downloadRemote：下载后 sha256 与源包一致；非自有命名拒绝', async () => {
  await withCloud({}, async ({ roots, outDir }) => {
    const made = await seedArchive(outDir, 'dsh-sync-20261015-101010.tar.gz', 5000);
    await uploadArchive(roots, { outDir });
    // 清掉本地，模拟「换台电脑从云端拉」
    await rm(made.path, { force: true });
    await rm(`${made.path}.sha256`, { force: true });
    await rm(`${made.path}.meta.json`, { force: true });

    const r = await downloadRemote(roots, made.name, { outDir });
    assert.equal(r.ok, true);
    assert.equal(r.verified, true, '远端有 .sha256 就必须校验');
    assert.equal(r.sha256, made.sha256);
    assert.equal(await sha256File(made.path), made.sha256);
    assert.ok(existsSync(`${made.path}.meta.json`), '边车要一起拉回来（导入页靠它显示摘要）');

    await assert.rejects(() => downloadRemote(roots, '../evil.tar.gz', { outDir }), /不是本插件|只认|路径/);
  });
});

test('downloadRemote：本地重名默认不覆盖；sha256 对不上要删残文件并报错', async () => {
  await withCloud({}, async ({ roots, srv, outDir }) => {
    const made = await seedArchive(outDir, 'dsh-sync-20261015-101010.tar.gz', 3000);
    await uploadArchive(roots, { outDir });
    await assert.rejects(() => downloadRemote(roots, made.name, { outDir }), /已存在/);
    const ok = await downloadRemote(roots, made.name, { outDir, overwrite: true });
    assert.equal(ok.ok, true);

    // 篡改远端内容但保留旧的 .sha256 → 必须校验失败且不留下半截文件
    await rm(made.path, { force: true });
    await writeFile(join(srv.root, 'dsh-backup', made.name), Buffer.alloc(3000, 0x42));
    await assert.rejects(() => downloadRemote(roots, made.name, { outDir, overwrite: true }), /哈希|sha256|校验/i);
    assert.equal(existsSync(made.path), false, '校验失败不能留下残文件');
    const leftovers = (await readdir(outDir)).filter((n) => n.includes('.part-'));
    assert.deepEqual(leftovers, [], '临时文件必须清掉');
  });
});

// ───────────────────────── 删除

test('removeRemote：只删自有命名，边车一起删；非自有命名拒绝', async () => {
  await withCloud({}, async ({ roots, srv, outDir }) => {
    const made = await seedArchive(outDir);
    await uploadArchive(roots, { outDir });
    const dir = join(srv.root, 'dsh-backup');
    assert.equal((await readdir(dir)).length, 3);

    await assert.rejects(() => removeRemote(roots, '别人的备份.tar.gz'), /不是本插件|只认/);
    const r = await removeRemote(roots, made.name);
    assert.equal(r.ok, true);
    assert.deepEqual(await readdir(dir), [], '包与两个边车都要删掉');

    // 再删一次不抛（幂等）
    const again = await removeRemote(roots, made.name);
    assert.equal(again.ok, true);
  });
});

// ───────────────────────── 与真备份产物对接

test('集成：runBackup 真产出的包能原样上云并拉回来', async () => {
  await withCloud({}, async ({ roots, srv, outDir }) => {
    const backup = await runBackup(roots, { moduleIds: ['skills'], outDir });
    const r = await uploadArchive(roots, { outDir, name: backup.archive.name });
    assert.equal(r.ok, true);
    assert.equal(r.archive.sha256, backup.archive.sha256);

    const pulled = join(srv.root, 'dsh-backup', backup.archive.name);
    assert.equal(await sha256File(pulled), backup.archive.sha256, '云端那一份必须与本地逐字节相同');
    assert.equal((await listRemote(roots, { outDir })).files[0].isOwn, true);
  });
});
