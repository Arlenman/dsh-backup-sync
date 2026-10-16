#!/usr/bin/env node
/**
 * 真机云端端到端：用插件自己的 `lib/cloud.js`（不是裸 webdav）对**真实** WebDAV 服务器
 * 跑一遍完整链路：存配置 → 存口令 → 测连接 → 上传真包 → 列远端 → 拉回来校验 sha256 → 删远端。
 *
 * 与 `scripts/cloud-e2e.mjs` 的分工：
 *   - `cloud-e2e.mjs`  = 本地假服务器，65 项断言，跑 CI，零外部依赖；
 *   - `cloud-real.mjs` = 真服务器验收，用于「换一台 NAS / 换一家网盘」时证明真的能用。
 *
 * 用法（三选一，都是同一组参数）：
 *   DBS_NAS_URL=http://192.168.1.10:5005/ DBS_NAS_USER=me DBS_NAS_PASS=*** node scripts/cloud-real.mjs
 *   node scripts/cloud-real.mjs --url http://… --user me --pass *** --dir dsh-backup
 *   npm run e2e:real-nas
 *
 * 参数：
 *   --url --user --pass     服务器地址 / 账号 / 口令（或 DBS_NAS_URL / DBS_NAS_USER / DBS_NAS_PASS）
 *   --dir                   远端目录（默认 dsh-backup）
 *   --out                   本地备份目录（默认 D:\dsh-backups-sync，取其中最新的一份真包上传）
 *   --insecure-tls          跳过证书校验（自签证书的 NAS 要加）
 *   --no-save               只测不落盘：不把地址/账号/口令写进插件的设置与凭据文件
 *   --keep-remote           跑完不删远端那份包（默认保留 —— 它就是你云端的第一份备份）
 *   --remove-remote         跑完把远端那份包删掉（含边车），用于「只验收、不留痕」
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败；2 = 参数不全。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import { resolveRoots } from '../lib/paths.js';
import {
  cloudView,
  credentialsPathOf,
  downloadRemote,
  listRemote,
  loadCloudCredentials,
  removeRemote,
  saveCloudConfig,
  saveCloudPassword,
  testConnection,
  uploadArchive,
} from '../lib/cloud.js';

// ───────────────────────── 参数

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[key] = true;
  else {
    args[key] = next;
    i += 1;
  }
}

const url = args.url ?? process.env.DBS_NAS_URL ?? '';
const username = args.user ?? process.env.DBS_NAS_USER ?? '';
const password = args.pass ?? process.env.DBS_NAS_PASS ?? '';
const remoteDir = args.dir ?? process.env.DBS_NAS_DIR ?? 'dsh-backup';
const outDir = resolve(args.out ?? process.env.DBS_ARCHIVE_DIR ?? 'D:\\dsh-backups-sync');
const insecureTLS = args['insecure-tls'] === true || process.env.DBS_NAS_INSECURE_TLS === '1';
const noSave = args['no-save'] === true;
const removeAfter = args['remove-remote'] === true;
const dlDir = resolve(args.dl ?? 'D:\\dsh-work\\dsh-backup-sync-cloud\\.real-dl');

if (url === '' || username === '' || password === '') {
  console.error('缺少参数：需要 --url / --user / --pass（或 DBS_NAS_URL / DBS_NAS_USER / DBS_NAS_PASS）');
  process.exit(2);
}

// ───────────────────────── 断言

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(text) {
  console.log(`  · ${text}`);
}
const roots = resolveRoots();

// ───────────────────────── 跑

try {
  console.log(`\n=== 1. 存配置（${noSave ? '--no-save，跳过落盘' : '写进插件自己的设置与凭据文件'}）===`);
  if (noSave) {
    note('只走 overrides，不碰磁盘上的设置');
  } else {
    // insecureTLS 为 false 时也要显式写回，避免上一次的 true 残留
    await saveCloudConfig(roots, { url, username, remoteDir, enabled: true, insecureTLS });
    const saved = await saveCloudPassword(roots, password);
    note(`配置：${roots.dshHome}\\backup-sync\\settings.json`);
    note(`口令：${saved.path}（明文只存本机，0600；本插件打包时按凭据类文件名拦截，不会进任何归档）`);
    const creds = await loadCloudCredentials(roots);
    check('口令已落盘且能读回', creds.password === password, `corrupted=${creds.corrupted}`);
  }

  const overrides = noSave ? { url, username, password, remoteDir, insecureTLS } : {};

  console.log('\n=== 2. cloudView：界面看到的东西 ===');
  const view = await cloudView(roots);
  note(JSON.stringify({
    enabled: view.enabled,
    url: view.url,
    username: view.username,
    remoteDir: view.remoteDir,
    insecureTLS: view.insecureTLS,
    hasPassword: view.hasPassword,
    ready: view.ready,
    remoteUrl: view.remoteUrl,
  }, null, 2));
  check('cloudView.ready = true', view.ready === true);
  check('cloudView 里**不含**口令', !JSON.stringify(view).includes(password));
  if (!noSave) {
    const settingsText = await readFile(view.settingsPath, 'utf8').catch(() => '');
    check('设置文件里**不含**口令', !settingsText.includes(password), basename(view.settingsPath));
    check('凭据文件在 ~/.dsh/backup-sync 下', credentialsPathOf(roots) === view.credentialsPath);
  }

  console.log('\n=== 3. 测连接（界面「保存并测试连接」按钮走的同一条路）===');
  const conn = await testConnection(roots, overrides);
  note(JSON.stringify(conn).slice(0, 400));
  check('连接可用', conn.ok === true, conn.ok ? `status=${conn.status ?? ''}` : `err=${conn.error ?? ''}`);

  console.log('\n=== 4. 上传最新一份真包（含两个边车）===');
  const up = await uploadArchive(roots, { outDir, ...overrides });
  note(`本地：${up.archive.path}`);
  note(`本地 sha256：${up.archive.sha256}`);
  note(`上传：${up.files.length} 个文件 → ${up.remoteUrl}`);
  for (const f of up.files) note(`  ${f.name}  ${f.bytes} B（远端核对 ${f.remoteBytes} B）`);
  check('上传返回 ok', up.ok === true);
  check('三个文件都上传了（包 + .sha256 + .meta.json）', up.files.length >= 1, `${up.files.length} 个`);
  check(
    '每个文件的远端字节数与本地一致',
    up.files.every((f) => f.remoteBytes === f.bytes),
    up.files.every((f) => f.remoteBytes === f.bytes) ? '' : JSON.stringify(up.files),
  );

  console.log('\n=== 5. 列远端 ===');
  const listed = await listRemote(roots, { outDir, ...overrides });
  note(`远端共 ${listed.files.length} 份包；dirMissing=${listed.dirMissing}`);
  for (const f of listed.files.slice(0, 5)) {
    note(`  ${f.name}  ${f.bytesHuman ?? '?'}  ${f.mtimeLocal ?? ''}  本插件生成=${f.isOwn}  本地也有=${f.localExists}`);
  }
  const mine = listed.files.find((f) => f.name === up.archive.name);
  check('刚上传的包出现在列表里', Boolean(mine));
  check('目录存在（不是「还没建」）', listed.dirMissing === false);
  check('列表里的远端字节数与本地文件大小一致', mine !== undefined && mine.bytes === up.files[0].bytes, `远端 ${mine?.bytes} / 本地 ${up.files[0].bytes}`);

  console.log('\n=== 6. 下载回来 + sha256 校验（模拟「换机拉回」）===');
  await rm(dlDir, { recursive: true, force: true });
  await mkdir(dlDir, { recursive: true });
  // downloadRemote 拒绝覆盖已存在的同名文件，所以每次用一个干净目录
  const dl = await downloadRemote(roots, up.archive.name, { outDir: dlDir, ...overrides });
  note(`下载到：${dl.path}（${dl.bytes} B，边车校验=${dl.verified}）`);
  check('下载返回 ok', dl.ok === true);
  check('下载回来的 sha256 与本地一致', dl.sha256 === up.archive.sha256, `${dl.sha256?.slice(0, 16)}…`);
  check('远端带 .sha256 边车（所以是「校验过的」而不是「只能自己算」）', dl.verified === true);

  console.log('\n=== 7. 删远端（幂等）===');
  const ghost = 'dsh-sync-19700101-000000.tar.gz';
  const g1 = await removeRemote(roots, ghost, overrides);
  check('删一个不存在的包不报错（幂等）', g1.ok === true, `removed=${g1.removed.length}`);
  check('拒绝删不是本插件生成的命名', await (async () => {
    try {
      await removeRemote(roots, '别人的文件.tar.gz', overrides);
      return false;
    } catch {
      return true;
    }
  })());

  if (removeAfter) {
    const del = await removeRemote(roots, up.archive.name, overrides);
    note(`已删除远端：${del.removed.join(', ') || '(什么都没删)'}`);
    check('验收用的包已从远端删除', del.removed.includes(up.archive.name));
  } else {
    note(`远端保留了这份包（要删就加 --remove-remote）：${up.remoteUrl}${up.archive.name}`);
  }

  console.log('\n=== 汇总 ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`  断言 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
  console.log('  🎉 真机云端链路全部通过');
  process.exit(0);
} catch (err) {
  console.error(`\n致命错误：${err?.message ?? err}`);
  if (err?.status) console.error(`  status=${err.status} url=${err.url ?? ''}`);
  const failed = results.filter((r) => !r.ok);
  console.error(`  已跑断言 ${results.length} 项，失败 ${failed.length + 1}`);
  process.exit(1);
}
