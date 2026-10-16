/**
 * 真机端到端：对真实 WebDAV 服务器（绿联 NAS / 群晖 / 坚果云 / Nextcloud）跑完整链路。
 *
 * 用的是插件自己的 `lib/webdav.js`，所以「跑通」即等于「插件能跑通」。
 * 顺序：probe → 根目录 list → 确保远端目录存在（MKCOL）→ 上传真包 → list/stat
 *       → 下载回来逐字节比 sha256 → 上传一个探针小文件再删掉（验证 DELETE 幂等）
 *
 * 用法（任选其一）：
 *   node scripts/nas-e2e.mjs --url http://100.66.1.1:5005/ --user dshsync --pass 'xxx' --dir dsh-backup
 *   DBS_NAS_URL=... DBS_NAS_USER=... DBS_NAS_PASS=... DBS_NAS_DIR=... node scripts/nas-e2e.mjs
 *
 * 附加参数：
 *   --archive <path>   要上传的真包（默认自动挑 <DSH_HOME>/backup-sync 之外最近的一份 dsh-sync-*.tar.gz）
 *   --keep             上传后不删除真包（默认保留，即这就是一次真的云端备份）
 *   --no-tls-skip      https 时不跳过证书校验（默认跳过，自签证书也能连）
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { createWebdav, WebdavError } from '../lib/webdav.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? process.env.DBS_NAS_URL;
const username = args.user ?? process.env.DBS_NAS_USER;
const password = args.pass ?? process.env.DBS_NAS_PASS;
const remoteDir = (args.dir ?? process.env.DBS_NAS_DIR ?? '').replace(/^\/+|\/+$/g, '');

if (!url || !username || !password) {
  console.error('缺少参数：需要 --url / --user / --pass（或 DBS_NAS_URL / DBS_NAS_USER / DBS_NAS_PASS）');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(text) {
  console.log(`  · ${text}`);
}

/** 找一个要上传的真包：优先 --archive，其次命令行给的，最后自动找。 */
async function pickArchive() {
  if (typeof args.archive === 'string') return args.archive;
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
  const dir = process.env.DBS_ARCHIVE_DIR ?? 'D:\\dsh-backups-sync';
  const { readdir, stat } = await import('node:fs/promises');
  try {
    const names = (await readdir(dir)).filter((n) => /^dsh-sync-\d{8}-\d{6}\.tar\.gz$/.test(n));
    if (!names.length) return null;
    const withTime = [];
    for (const n of names) withTime.push({ n, t: (await stat(join(dir, n))).mtimeMs });
    withTime.sort((a, b) => b.t - a.t);
    note(`自动选包：${join(dir, withTime[0].n)}`);
    return join(dir, withTime[0].n);
  } catch {
    note(`没找到可用真包（${dir}），改上传一份 1MB 的合成测试包`);
    return null;
  }
}

const tmpDir = join(process.env.TEMP ?? '.', 'dbs-nas-e2e');
let client;
try {
  await mkdir(tmpDir, { recursive: true });
  const secure = url.startsWith('https:');
  client = createWebdav({
    url,
    username,
    password,
    insecureTLS: args['no-tls-skip'] ? false : secure,
    log: (m) => note(`[webdav] ${m}`),
  });

  console.log(`\n=== 1. probe：${url} ===`);
  const probe = await client.probe();
  console.log(`  ${JSON.stringify(probe)}`);
  check('probe.ok', probe.ok === true, probe.ok ? `status=${probe.status} dav=${JSON.stringify(probe.dav)}` : `status=${probe.status} err=${probe.error ?? ''}`);
  if (!probe.ok) throw new Error(`probe 失败：${probe.error ?? probe.status}`);
  if (probe.dav) check('服务器声明了 DAV 能力头', true, `DAV: ${JSON.stringify(probe.dav)}`);
  else note('服务器没在 OPTIONS 响应里给 DAV 头（绿联 UGOS 实测未认证时就没有，属常见情况）—— 不作失败判定，后面的 PROPFIND 207 成功即可证明对方确实是 WebDAV');

  console.log(`\n=== 2. 列根目录 ===`);
  const root = await client.list('');
  note(`根下有 ${root.length} 个条目：${root.slice(0, 8).map((e) => e.name).join(', ')}${root.length > 8 ? ' …' : ''}`);
  check('根目录可列', Array.isArray(root));

  if (remoteDir) {
    console.log(`\n=== 3. 确保远端目录存在：${remoteDir} ===`);
    const parts = remoteDir.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const rel = parts.slice(0, i + 1).join('/');
      const exists = await client.stat(rel).catch(() => null);
      if (exists) {
        note(`${rel} 已存在（不重复建）`);
        continue;
      }
      try {
        await client.ensureDir(rel);
        note(`${rel} 新建成功`);
      } catch (e) {
        const status = e instanceof WebdavError ? e.status : undefined;
        check(`MKCOL ${rel}`, false, `status=${status} ${e.message}`);
        note('若这是根下的第一级：多数 NAS 的顶层是「共享文件夹」，只能由 NAS 侧创建 —— 去 NAS 上先建好，再重跑本脚本。');
        throw e;
      }
    }
    const st = await client.stat(remoteDir).catch(() => null);
    check(`远端目录 ${remoteDir} 可用`, Boolean(st));
  }

  console.log(`\n=== 4. 上传 → 列 → 下载 → 比对 ===`);
  let archive = await pickArchive();
  let payload;
  let name;
  if (archive) {
    payload = await readFile(archive);
    name = basename(archive);
  } else {
    payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    name = 'dsh-sync-e2e-synthetic.tar.gz';
    archive = join(tmpDir, name);
    await writeFile(archive, payload);
  }
  const localSha = sha256(payload);
  const remoteRel = remoteDir ? `${remoteDir}/${name}` : name;
  note(`本地：${archive}  ${payload.length} B  sha256=${localSha}`);

  const t0 = Date.now();
  await client.put(remoteRel, payload);
  note(`上传完成，用时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  check('PUT 成功', true);

  const listed = await client.list(remoteDir);
  const found = listed.find((e) => e.name === name);
  check('列目录能看到刚上传的包', Boolean(found), found ? `size=${found.bytes ?? '?'} mtime=${found.mtime ?? '?'}` : '');
  const head = await client.stat(remoteRel).catch(() => null);
  check('stat 能取到它', Boolean(head), head ? JSON.stringify(head).slice(0, 160) : '');

  const back = await client.get(remoteRel);
  const remoteSha = sha256(back);
  check('下载回来与本地逐字节一致', remoteSha === localSha, `remote sha256=${remoteSha}`);
  const half = Math.floor(back.length / 2);
  check('内容分段抽样一致', back.subarray(0, 1024).equals(payload.subarray(0, 1024)) && back.subarray(half, half + 4096).equals(payload.subarray(half, half + 4096)));

  console.log(`\n=== 5. DELETE 与幂等 ===`);
  const probeName = `dsh-sync-e2e-probe-${Date.now()}.txt`;
  const probeRel = remoteDir ? `${remoteDir}/${probeName}` : probeName;
  await client.put(probeRel, Buffer.from('probe\n', 'utf8'));
  const after = await client.list(remoteDir);
  check('探针文件上传成功', after.some((e) => e.name === probeName));
  await client.remove(probeRel);
  const after2 = await client.list(remoteDir);
  check('探针文件删除成功', !after2.some((e) => e.name === probeName));
  let idempotent = false;
  try {
    await client.remove(probeRel);
    idempotent = true;
  } catch (e) {
    const status = e instanceof WebdavError ? e.status : undefined;
    idempotent = status === 404;
    note(`重复删除返回 status=${status}（404 也算幂等）`);
  }
  check('重复删除是幂等的（不抛错或 404）', idempotent);

  // 收尾策略（2026-10-16 修正）：这里**默认保留**刚上传的那一份。
  // 之前写成 `if (!args.keep && archive !== join(tmpDir, name)) await client.remove(...)`，
  // 方向正好反了 —— 真包（本地备份目录里的那一份）被删，探针包反而留着，
  // 而且紧接着的断言写死了 true，删掉了也照样报绿。实际后果：这条脚本自己把用户
  // NAS 上唯一的云端备份删掉了（2026-10-16 实测踩到）。现在的规则：
  //   真包 → 永远保留（它就是一次真的云端备份，删掉等于毁数据）；
  //   本地临时生成的探针包 → 默认删掉，加 --keep 才留。
  const synthetic = archive === join(tmpDir, name);
  if (synthetic && !args.keep) {
    await client.remove(remoteRel);
    note('（上传的是本地临时生成的探针包，已删除；要留现场加 --keep）');
  } else {
    note(`（${synthetic ? '--keep：探针包保留' : '真包：本次上传即一次真的云端备份，保留'}）`);
  }
  const kept = await client.stat(remoteRel).catch(() => null);
  check(synthetic && !args.keep ? '探针包已删除' : '真包已留在远端', synthetic && !args.keep ? kept === null : kept !== null, remoteRel);

  console.log(`\n=== 6. 目录生命周期（回答「删掉最后一份包之后，界面该怎么说」）===`);
  const probeDirName = `_dbs-e2e-${Date.now()}`;
  const probeDir = remoteDir ? `${remoteDir}/${probeDirName}` : probeDirName;
  const mk = await client.ensureDir(probeDir);
  check('MKCOL 能新建目录', mk.created.length >= 1, `created=${mk.created.join(',')}`);
  const mkAgain = await client.ensureDir(probeDir);
  check('重复 ensureDir 不报错（已存在=405 被容忍，不会误判成失败）', mkAgain.created.length === 0, `existed=${mkAgain.existed.join(',')}`);
  await client.put(`${probeDir}/a.txt`, Buffer.from('x\n', 'utf8'));
  await client.remove(`${probeDir}/a.txt`);
  const emptyList = await client.list(probeDir);
  const stillThere = await client.stat(probeDir);
  check(
    '删掉目录里最后一个文件后，目录本身仍在',
    emptyList.length === 0 && stillThere !== null,
    `list=${emptyList.length} stat=${stillThere === null ? 'null' : 'ok'} → 界面该说「还没有备份包」，不是「目录不存在」`,
  );
  // 收尾：把探针目录删掉，别在用户 NAS 上留垃圾
  let dirGone = false;
  for (const candidate of [`${probeDir}/`, probeDir]) {
    try {
      await client.remove(candidate);
    } catch (e) {
      note(`DELETE ${candidate} 失败：${e?.message ?? e}`);
      continue;
    }
    if ((await client.stat(probeDir).catch(() => null)) === null) {
      dirGone = true;
      break;
    }
  }
  check('探针目录已清理干净', dirGone, dirGone ? '' : `未能删掉，请到 NAS 上手工删除 ${probeDir}`);

  console.log(`\n=== 汇总 ===`);
  const failed = results.filter((r) => !r.ok);
  console.log(`  断言 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`    ❌ ${f.name} ${f.detail}`);
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error(`\n致命错误：${e?.message ?? e}`);
  if (e instanceof WebdavError) console.error(`  status=${e.status} url=${e.url ?? ''}`);
  const failed = results.filter((r) => !r.ok);
  console.error(`  已跑断言 ${results.length} 项，失败 ${failed.length}`);
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
} finally {
  try {
    await client?.close();
  } catch {}
}
