#!/usr/bin/env node
/**
 * 云端（WebDAV）端到端验收 —— 一条命令跑完，零依赖。
 *
 *   node scripts/cloud-e2e.mjs [--keep] [--port 19700] [--dir <远端根>] [--pass <口令>]
 *
 * 跑的是真东西，不是桩：
 *   · 假的 WebDAV 服务器是**独立进程**（test/fake-webdav.js 的 CLI 模式），真端口、真 Basic 认证；
 *   · 两棵真的用户目录树（夹具）：A 机 = 有内容要备份的机器，B 机 = 还没同步过的新机器；
 *   · 全程走 lib/cloud.js 的公开接口，跟界面按按钮时执行的代码是同一条路径。
 *
 * 验的是「换机」这件事整条链：A 机打包 → 传云 → 列云 → B 机下载 → 校验 → 预览导入，
 * 外加几条安全红线（口令不外泄、不碰别人家的文件）。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture } from '../test/fixture.js';
import { MODULE_IDS } from '../lib/modules.js';
import { previewImport, runBackup, verifyArchiveFull } from '../lib/service.js';
import {
  cloudView,
  downloadRemote,
  listRemote,
  loadCloudCredentials,
  removeRemote,
  saveCloudConfig,
  saveCloudPassword,
  testConnection,
  uploadArchive,
} from '../lib/cloud.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FAKE_SERVER = join(REPO, 'test', 'fake-webdav.js');

/** 口令刻意做得“有特征”，这样「响应的 JSON 里没有它」才能被真正断言出来。 */
const PASS = 'dav-pass-9f2a-有特征';

// ─────────────────────────── 小断言器

/** `--report <file>` 时，输出的每一行都同时落到文件里 —— 验收记录由脚本自己写，不靠手抄。 */
let reportPath = null;
function emit(text) {
  process.stdout.write(text);
  if (reportPath !== null) appendFileSync(reportPath, text);
}

let checks = 0;
const failures = [];

function ok(label, cond, detail = '') {
  checks += 1;
  if (cond) {
    emit(`ok   ${label}\n`);
    return true;
  }
  failures.push(label);
  emit(`FAIL ${label}${detail === '' ? '' : `\n       ${detail}`}\n`);
  return false;
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return ok(label, a === e, `期望 ${e}，实得 ${a}`);
}

/** 断言某段代码抛错（且错误信息里含 needle）。 */
async function rejects(label, fn, needle = '') {
  try {
    await fn();
  } catch (err) {
    const msg = err?.message ?? String(err);
    return ok(label, needle === '' || msg.includes(needle), `错误信息里没有「${needle}」：${msg}`);
  }
  return ok(label, false, '本该抛错，却成功返回了');
}

/** 断言任何序列化结果里都不出现口令 —— 这是本功能的第一条红线。 */
function noPassword(label, value) {
  const text = JSON.stringify(value);
  return ok(label, !text.includes(PASS), `序列化结果里出现了口令：${text.slice(0, 300)}`);
}

// ─────────────────────────── 假服务器（独立进程）

function parseArgs(argv) {
  const out = { keep: false, port: 19700, dir: null, pass: PASS, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') out.keep = true;
    else if (argv[i] === '--port') out.port = Number(argv[i + 1]), (i += 1);
    else if (argv[i] === '--dir') out.dir = argv[i + 1], (i += 1);
    else if (argv[i] === '--pass') out.pass = argv[i + 1], (i += 1);
    else if (argv[i] === '--report') out.report = argv[i + 1], (i += 1);
  }
  return out;
}

/**
 * 起一台真的假服务器。返回 `{url, port, logPath, stop}`。
 *
 * 端口被占就依次试下一个 —— 上一轮跑崩留下的孤儿进程不该让这一轮直接红。
 */
async function startServer({ port, root, password }) {
  const logPath = join(dirname(root), 'requests.jsonl');
  await rm(logPath, { force: true });
  let lastError = null;
  for (let p = port; p < port + 10; p += 1) {
    const child = spawn(
      process.execPath,
      [FAKE_SERVER, '--port', String(p), '--dir', root, '--user', 'u', '--pass', password, '--log', logPath],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const ready = await new Promise((done) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => done({ ok: false, error: `等待 READY 超时（端口 ${p}）` }), 15_000);
      child.stdout.on('data', (c) => {
        out += c.toString('utf8');
        const m = /^READY url=(\S+)/m.exec(out);
        if (m) {
          clearTimeout(timer);
          done({ ok: true, url: m[1].replace(/\/$/, '') });
        }
      });
      child.stderr.on('data', (c) => {
        err += c.toString('utf8');
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        done({ ok: false, error: `服务器进程先退了（code=${code}）${err.trim()}` });
      });
    });
    if (ready.ok) {
      return {
        url: ready.url,
        port: p,
        logPath,
        async stop() {
          if (child.exitCode === null) child.kill();
          await new Promise((done) => {
            if (child.exitCode !== null) return done();
            child.on('exit', () => done());
            setTimeout(() => done(), 3000);
          });
        },
      };
    }
    lastError = ready.error;
    if (child.exitCode === null) child.kill();
    if (!/EADDRINUSE|超时/.test(ready.error)) break;
  }
  throw new Error(`起不了假服务器：${lastError}`);
}

async function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  const text = await readFile(logPath, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** 远端目录里有什么（服务器进程把内容落在 root 下，直接从磁盘看最可信）。 */
async function remoteDirFiles(root) {
  const walk = async (dir, prefix) => {
    const out = [];
    for (const name of await readdir(dir)) {
      const abs = join(dir, name);
      const s = await stat(abs);
      if (s.isDirectory()) out.push(...(await walk(abs, `${prefix}${name}/`)));
      else out.push({ name: `${prefix}${name}`, bytes: s.size });
    }
    return out;
  };
  if (!existsSync(root)) return [];
  return (await walk(root, '')).sort((a, b) => a.name.localeCompare(b.name));
}

// ─────────────────────────── 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.report !== null) reportPath = resolve(args.report);
  const pass = args.pass;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = args.dir === null ? join(REPO, `.tmp-cloud-e2e-${stamp}`) : resolve(args.dir);
  const remoteRoot = join(base, 'remote-root');

  emit(`# 云端端到端验收\n远端根目录：${remoteRoot}\n\n`);
  /** 结尾的「证据」段要用的实测数字，跑到哪记到哪（没跑到就是 null）。 */
  const facts = {};

  let server = null;
  let a = null;
  let b = null;
  try {
    server = await startServer({ port: args.port, root: remoteRoot, password: pass });
    emit(`假 WebDAV：${server.url}（独立进程，pid 已托管）\n\n`);

    // ── 1. A 机：写云端配置
    a = await makeFixture();
    b = await makeFixture({ empty: true });
    const outA = join(a.root, 'backups');
    const outB = join(b.root, 'backups');

    await saveCloudConfig(a.roots, {
      enabled: true,
      url: server.url,
      username: 'u',
      remoteDir: 'dsh-backup',
      insecureTLS: false,
      autoUpload: false,
    });
    await saveCloudPassword(a.roots, pass);

    const view = await cloudView(a.roots);
    eq('云配置写进去了（enabled / remoteDir）', [view.enabled, view.remoteDir], [true, 'dsh-backup']);
    eq('地址存下来时就归一化好了（带尾斜杠）', view.url, server.url.endsWith('/') ? server.url : `${server.url}/`);
    eq('界面显示的远端位置不会拼出双斜杠', view.remoteUrl, `${view.url}dsh-backup/`);
    eq('云视图知道口令已保存（但看不到口令本身）', view.hasPassword, true);
    noPassword('云视图里没有口令', view);
    eq('云配置存的是原始目录名（不带斜杠）', view.remoteDir.includes('/'), false);

    const cred = await loadCloudCredentials(a.roots);
    ok('口令真的落在了插件自己的凭据文件里', cred.password === pass);

    // ── 2. 传之前：远端目录还不存在，要说得出「还不存在」而不是「空的」
    const beforeFirst = await listRemote(a.roots, { outDir: outA });
    eq('第一次列远端：目录不存在', [beforeFirst.ok, beforeFirst.dirMissing, beforeFirst.files.length], [true, true, 0]);

    // ── 2. 连得上、连不上
    const conn = await testConnection(a.roots, {});
    eq('测试连接：通', [conn.ok, conn.remoteDir], [true, 'dsh-backup']);
    ok('测试连接带回 DAV 能力头', typeof conn.dav === 'string' && conn.dav.length > 0, `实得 ${JSON.stringify(conn.dav)}`);
    noPassword('测试连接的结果里没有口令', conn);

    const bad = await testConnection(a.roots, { password: 'wrong-password' });
    eq('测试连接：口令错 → 不是抛错，是 ok:false', bad.ok, false);
    eq('测试连接：口令错 → 报出 HTTP 401', bad.status, 401);
    noPassword('测试连接失败的结果里也没有口令', bad);

    const afterBad = await testConnection(a.roots, {});
    eq('用错口令试过之后，原来存的口令没被覆盖', afterBad.ok, true);

    const dead = await testConnection(a.roots, { url: `http://127.0.0.1:${server.port + 40}/dav/` });
    eq('连不上的地址 → ok:false（服务没起时不是崩，是报错）', dead.ok, false);
    ok('连不上时的错误信息非空', typeof dead.error === 'string' && dead.error.length > 0);

    // ── 3. A 机打包
    const ids = MODULE_IDS.filter((id) => id !== 'sessions');
    const backup = await runBackup(a.roots, { moduleIds: ids, outDir: outA });
    const name = backup.archive.name;
    facts.archive = { name, bytes: backup.archive.bytes, sha256: backup.archive.sha256, modules: backup.archive.modules };
    facts.credentials = backup.credentials.map((c) => c.relPath);
    ok('打出包了，且文件名是本插件的命名', /^dsh-sync-\d{8}-\d{6}\.tar\.gz$/.test(name), `实得 ${name}`);
    eq('本地三件套齐了（包 + .sha256 + .meta.json）', (await readdir(outA)).filter((f) => f.startsWith(name)).sort(), [
      name,
      `${name}.meta.json`,
      `${name}.sha256`,
    ]);
    eq('对话没进包（没人勾它）', backup.archive.modules.includes('sessions'), false);
    ok('凭据守卫确实拦下了东西（夹具里有 .npmrc）', backup.credentials.length > 0, '一条都没拦到，红线的证据链断了');
    noPassword('备份结果里没有云端口令', backup);

    const metaText = await readFile(backup.archive.metaPath, 'utf8');
    ok('包里没有 .npmrc', !metaText.includes('.npmrc'));
    ok('包里没有插件的云端凭据文件', !metaText.includes('cloud-credentials.json'));

    // ── 4. 传上去
    const up = await uploadArchive(a.roots, { name, outDir: outA });
    eq('上传成功，传了包本体 + 两个边车', up.files.length, 3);
    ok(
      '每个文件都做了「远端字节数 = 本地字节数」的核对',
      up.files.every((f) => f.remoteBytes === f.bytes && f.bytes > 0),
      JSON.stringify(up.files),
    );
    noPassword('上传结果里没有口令', up);

    const onDisk = await remoteDirFiles(remoteRoot);
    facts.remoteAfterUpload = onDisk;
    eq('远端目录里就是这 3 个文件', onDisk.map((f) => f.name).sort(), [
      `dsh-backup/${name}`,
      `dsh-backup/${name}.meta.json`,
      `dsh-backup/${name}.sha256`,
    ]);
    const log = await readLog(server.logPath);
    const puts = log.filter((r) => r.method === 'PUT');
    eq('PUT 一共 3 次', puts.length, 3);
    ok(
      '3 次 PUT 都带 Content-Length（不用 chunked —— 截断了才发现就晚了）',
      puts.length === 3 && puts.every((r) => r.contentLength !== null && r.transferEncoding === null),
      JSON.stringify(puts),
    );

    // ── 5. 列远端
    const list = await listRemote(a.roots, { outDir: outA });
    eq('列远端：只列出包本体（边车不单独列）', list.files.map((f) => f.name), [name]);
    eq('列远端：标成“本插件打的包”', list.files[0].isOwn, true);
    eq('列远端：知道本地也有这一份', list.files[0].localExists, true);
    eq('列远端：远端与本地字节数一致', list.files[0].bytes, backup.archive.bytes);
    noPassword('列远端的结果里没有口令', list);

    // ── 6. 删错东西：一律拒绝
    // 注意快照要在这里取：中间的 listRemote 自己会发 PROPFIND，拿几段之前的快照比会多算一笔。
    const beforeRejects = await readLog(server.logPath);
    await rejects('删远端：不是本插件命名的包 → 拒绝', () => removeRemote(a.roots, '别人的备份.tar.gz'), '本插件');
    await rejects('删远端：路径穿越 → 拒绝', () => removeRemote(a.roots, '../../etc/passwd.tar.gz'), '本插件');
    await rejects('下载：不是本插件命名的包 → 拒绝', () => downloadRemote(b.roots, 'evil.tar.gz', { outDir: outB }), '本插件');
    await rejects('上传：指定一个不是本插件命名的包 → 拒绝', () => uploadArchive(a.roots, { name: 'evil.tar.gz', outDir: outA }), '本插件');
    eq('被拒的这几次没动过远端一根毫毛', (await remoteDirFiles(remoteRoot)).length, 3);
    const afterRejects = await readLog(server.logPath);
    eq('被拒的这几次一个请求都没发出去', afterRejects.length, beforeRejects.length);

    // ── 7. B 机（新机器）下载
    await saveCloudConfig(b.roots, { enabled: true, url: server.url, username: 'u', remoteDir: 'dsh-backup' });
    await saveCloudPassword(b.roots, pass);

    const down = await downloadRemote(b.roots, name, { outDir: outB });
    facts.download = { path: down.path, sha256: down.sha256, verified: down.verified };
    eq('下载成功，并且用远端 .sha256 校验过', [down.ok, down.verified], [true, true]);
    eq('下下来的 sha256 与 A 机算出的完全一致', down.sha256, backup.archive.sha256);
    eq('B 机本地也落了 3 个文件', (await readdir(outB)).sort(), [name, `${name}.meta.json`, `${name}.sha256`]);
    noPassword('下载结果里没有口令', down);

    await rejects('同名的包再下一遍（不加确认）→ 拒绝覆盖', () => downloadRemote(b.roots, name, { outDir: outB }), '已存在同名');
    const again = await downloadRemote(b.roots, name, { outDir: outB, overwrite: true });
    eq('显式确认后可以重下', again.ok, true);
    eq('重下的文件还是那 3 个（不残留 .part-* 临时文件）', (await readdir(outB)).filter((f) => f.includes('.part-')).length, 0);

    // ── 8. B 机校验 + 预览导入
    const full = await verifyArchiveFull(b.roots, { archivePath: down.path });
    facts.checked = full.checked;
    eq('整包校验：逐文件哈希全对', full.ok, true);
    eq('整包校验：边车也对', full.sidecar.ok, true);
    ok('整包校验真的逐个文件算过哈希', full.checked > 0, `checked=${full.checked}`);
    eq('整包校验没有坏文件', full.bad, []);

    const preview = await previewImport(b.roots, { archivePath: down.path });
    eq('预览导入：算得出来', preview.ok, true);
    ok('预览导入：认得出内容（有要新增的文件）', preview.counts.import > 0, JSON.stringify(preview.counts));
    eq('预览导入：凭据守卫没拦下任何东西（自己打的包本来就干净）', preview.blocked, []);
    eq('预览导入：不会偷偷删 B 机的文件', preview.counts.delete, 0);
    noPassword('预览导入的结果里没有口令', preview);

    // ── 9. 口令红线：远端一个字节都不该沾
    const remoteFiles = await remoteDirFiles(remoteRoot);
    let leaked = [];
    for (const f of remoteFiles) {
      const buf = await readFile(join(remoteRoot, f.name));
      if (buf.includes(Buffer.from(pass, 'utf8'))) leaked.push(f.name);
    }
    eq('远端文件里没有口令', leaked, []);
    eq('远端目录里没有名字像凭据的文件', remoteFiles.filter((f) => /credential|secret|\.env|\.npmrc/i.test(f.name)).length, 0);
    const logText = await readFile(server.logPath, 'utf8');
    ok('服务器日志里没有 Authorization 头（Basic 头里就是口令）', !/authorization/i.test(logText));

    // ── 10. 收尾：删远端
    const removed = await removeRemote(a.roots, name);
    eq('删远端：成功', removed.ok, true);
    eq('删远端：包与边车一起删掉', await remoteDirFiles(remoteRoot), []);
    const again2 = await removeRemote(a.roots, name);
    eq('删远端：不存在也算成功（幂等，重复点不报错）', again2.ok, true);

    const listAfter = await listRemote(a.roots, { outDir: outA });
    eq('删干净之后再列：空了', listAfter.files.length, 0);
    eq('目录还在（只是没包）—— 不能报成“文件夹不存在”', listAfter.dirMissing, false);
  } finally {
    if (server !== null) {
      await server.stop();
      // 清理现场之前先把请求统计抓下来：base 目录马上就会被删掉。
      const byMethod = {};
      for (const r of await readLog(server.logPath)) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
      facts.byMethod = byMethod;
    }
    if (a !== null) await a.cleanup();
    if (b !== null) await b.cleanup();
    if (args.keep !== true) await rm(base, { recursive: true, force: true }).catch(() => {});
    else emit(`\n（保留现场：${base}）\n`);
  }

  emit(`\n# ${checks - failures.length}/${checks} 通过\n`);

  // 结尾这段是给人看的「这次到底测出了什么」，数字全部来自本轮实测，没有一个是写死的。
  const a1 = facts.archive ?? {};
  emit('\n## 本轮实测数据\n');
  emit(`- 备份包：${a1.name ?? '（没跑到）'}，${a1.bytes ?? '?'} 字节，模块 ${(a1.modules ?? []).join(' / ') || '?'}\n`);
  emit(`- 包 sha256：${a1.sha256 ?? '（没跑到）'}\n`);
  emit(`- B 机下载后重算：${facts.download?.sha256 ?? '（没跑到）'}${facts.download?.sha256 === a1.sha256 ? '（与 A 机一致）' : ''}\n`);
  emit(`- 整包逐文件校验：${facts.checked ?? '?'} 个文件\n`);
  emit(`- 凭据守卫挡在包外的文件：${(facts.credentials ?? []).join('、') || '无'}\n`);
  emit(`- 上传后远端目录：${(facts.remoteAfterUpload ?? []).map((f) => `${f.name}（${f.bytes} B）`).join('、') || '（没跑到）'}\n`);
  if (server !== null) {
    const byMethod = facts.byMethod ?? {};
    emit(`- 全程 HTTP 请求：${Object.entries(byMethod).map(([m, n]) => `${m}×${n}`).join('，') || '（没记到）'}\n`);
  }

  if (failures.length > 0) {
    emit(`# 失败项：\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(1);
  }
  emit('# 全部通过\n');
  process.exit(0);
}

main().catch((err) => {
  emit(`\n# 跑挂了：${err?.stack ?? err}\n`);
  process.exit(1);
});
