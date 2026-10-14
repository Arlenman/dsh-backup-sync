/**
 * 凭据守卫测试。
 *
 * 这一组是**安全红线**的守卫：`.credentials.yaml` 里是本机明文 API key 与会话密钥，
 * 一旦进包就可能被推到云端。测试既要证明该拦的拦住，也要证明**不该拦的没被误拦**
 * —— 误拦会让备份悄悄少文件，同样是事故。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_GUARD_BYTES,
  guardEntry,
  inspectContent,
  inspectPath,
  secretBasenameReason,
} from '../lib/guard.js';
import { scan } from '../lib/scan.js';
import { buildManifest } from '../lib/archive.js';

// ────────────────────────────────────────────── 文件名闸

test('文件名闸：凭据类文件名一律拒绝', () => {
  const bad = [
    '.credentials.yaml',
    '.credentials.yml',
    '.credentials.json',
    'credentials.json',
    'auth.json',
    'github.token',
    '.netrc',
    '.git-credentials',
    'id_rsa',
    'id_ed25519',
    '.env',
    'secrets.yaml',
    // 包管理器配置：既写机器本地绝对路径（store-dir/prefix/cache），又常藏 `_authToken`。
    // 真机实测（2026-10-14，WSL 换机导入）：Windows 那台的 .npmrc 随包进了 Linux 那台
    // 的 profile，那个 profile 的 pnpm 立刻 ERR_PNPM_UNEXPECTED_STORE，插件都装不上。
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    // 大小写不敏感
    '.CREDENTIALS.YAML',
    'Id_Rsa',
  ];
  for (const name of bad) {
    assert.ok(inspectPath(name) !== null, `${name} 应被文件名闸拦下`);
    assert.ok(inspectPath(`deep/nested/${name}`) !== null, `${name} 在子目录里也应被拦下`);
    assert.ok(inspectPath(`deep\\nested\\${name}`) !== null, `${name} 用反斜杠路径也应被拦下`);
  }
});

test('文件名闸：私钥/证书后缀一律拒绝', () => {
  for (const name of ['server.pem', 'private.key', 'cert.pfx', 'store.p12', 'a.jks', 'id.ppk']) {
    assert.ok(inspectPath(name) !== null, `${name} 应被后缀闸拦下`);
  }
});

test('文件名闸：正常文件不得误拦', () => {
  const ok = [
    'SKILL.md',
    'MEMORY.md',
    'KEY.md',
    'cordis.patch.yml',
    'package.json',
    'pnpm-lock.yaml',
    '2026-10-13.todo.md',
    'state.json',
    'README.md',
    'keyboard.md', // 不能因为含 "key" 就被拦
    'monkey.yaml',
    'environment.md',
  ];
  for (const name of ok) {
    assert.equal(inspectPath(name), null, `${name} 不该被拦`);
  }
});

test('secretBasenameReason 对普通文件返回 null', () => {
  assert.equal(secretBasenameReason('SKILL.md'), null);
});

// ────────────────────────────────────────────── 内容闸

test('内容闸：高信号凭据特征命中', () => {
  const cases = [
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE...', '私钥文件头'],
    ['//registry.npmjs.org/:_authToken=npm_abcdefghijklmnop', 'npm 认证令牌'],
    ['token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'GitHub 令牌'],
    ['github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', 'GitHub 细粒度令牌'],
    ['OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'OpenAI 风格密钥'],
    ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'AWS Access Key'],
    // GitHub 的推送保护（GH013）会把「假但形状像」的 Slack 令牌字面量当成真凭据拦下来，
    // 所以这里拆成两段拼接：扫描器看不到完整形态，而测试要的「令牌形态」一点没少。
    ['xox' + 'b-123456789012-abcdefghijklmnop', 'Slack 令牌'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'JWT'],
    // 注意用无前缀令牌：`ghs_...` 会先命中「GitHub 令牌」规则（也对，只是测不到本条）
    ['url = https://x-access-token:AbCdEf0123456789AbCdEf0123456789AbCdEf01@github.com/o/r.git', '带令牌的 git 地址'],
    ['header = Bearer abcdefghijklmnopqrstuvwxyz012345', '字面量 Bearer 令牌'],
  ];
  for (const [text, rule] of cases) {
    assert.equal(inspectContent(text), rule, `应命中「${rule}」`);
  }
});

test('★ 内容闸不得误伤本机真实的记忆/技能文本', () => {
  // 这些片段都真实出现在本机的记忆与文档里。它们提到凭据，但**不含凭据本身**。
  const benign = [
    '`auth.json`（`{"OPENAI_API_KEY":"sk-..."}`）可能被应用启动流程消耗掉',
    'external-controller 127.0.0.1:9097 secret=`set-your-secret`',
    '`dsh-backup` 的 token 三种来源：`<root>/github.token` / 环境变量 / 面板命令',
    'repo 用 `/backup github repo owner/repo` 设',
    '凭据文件永不进包、永不进基线',
    'password: 请向管理员索取',
    'api_key = <你的密钥>',
    'token: ${GITHUB_TOKEN}',
    'Authorization: Bearer <token>',
    'sk-...',
    '-----BEGIN PUBLIC KEY-----', // 公钥不是凭据
    // ★ 真实事故：本机项目记忆里就是这么写的，早期规则把它整份挡在备份之外
    '凭据以 `https://x-access-token:<token>@github.com` 写入 git credential helper',
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
    '//registry.npmjs.org/:_authToken=<YOUR_TOKEN>',
  ];
  for (const text of benign) {
    assert.equal(inspectContent(text), null, `不该误拦：${text}`);
  }
});

test('内容闸：空内容与非字符串安全返回', () => {
  assert.equal(inspectContent(''), null);
  assert.equal(inspectContent(null), null);
  assert.equal(inspectContent(undefined), null);
  assert.equal(inspectContent(123), null);
});

// ────────────────────────────────────────────── guardEntry 组合

test('guardEntry：路径闸优先，且不需要读内容', async () => {
  let read = 0;
  const v = await guardEntry({ relPath: '.credentials.yaml', size: 10 }, async () => {
    read += 1;
    return 'harmless';
  });
  assert.equal(v.blocked, true);
  assert.equal(read, 0, '路径已判定时不该再读内容');
});

test('guardEntry：内容命中即拦下，并给出规则名', async () => {
  const v = await guardEntry({ relPath: 'notes.md', size: 100 }, async () => 'key: sk-abcdefghijklmnopqrstuvwxyz012345');
  assert.equal(v.blocked, true);
  assert.match(v.reason, /OpenAI 风格密钥/);
});

test('guardEntry：超大文件只走路径闸，不读全文', async () => {
  let read = 0;
  const v = await guardEntry({ relPath: 'big.jsonl', size: MAX_GUARD_BYTES + 1 }, async () => {
    read += 1;
    return 'sk-abcdefghijklmnopqrstuvwxyz012345';
  });
  assert.equal(v.blocked, false);
  assert.equal(read, 0, '超过上限不该读全文');
});

test('guardEntry：读内容抛错时不误判为凭据', async () => {
  const v = await guardEntry({ relPath: 'x.md', size: 10 }, async () => {
    throw new Error('EACCES');
  });
  assert.equal(v.blocked, false);
});

// ────────────────────────────────────────────── 与 scan / buildManifest 的接线

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dbs-guard-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('★ scan 会把凭据文件剔除并如实记录（绝不静默跳过）', async () => {
  await withTmp(async (dir) => {
    const dshHome = join(dir, 'dsh');
    const agentsSkills = join(dir, 'agents', 'skills');
    await mkdir(join(dshHome, 'memories'), { recursive: true });
    await mkdir(join(agentsSkills, 'demo'), { recursive: true });

    // 一个正常文件 + 一个文件名像凭据的 + 一个内容含令牌的
    await writeFile(join(dshHome, 'memories', 'MEMORY.md'), '# 正常记忆\n', 'utf8');
    await writeFile(join(dshHome, 'memories', 'auth.json'), '{"OPENAI_API_KEY":"x"}', 'utf8');
    await writeFile(join(agentsSkills, 'demo', 'SKILL.md'), 'token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n', 'utf8');

    const roots = { dshHome, userHome: dir, profile: 'desktop', agentsSkills };
    const result = await scan(roots, { moduleIds: ['memory', 'skills'] });

    const memFiles = result.modules.memory.entries.map((e) => e.relPath);
    assert.deepEqual([...memFiles], ['MEMORY.md'], 'auth.json 不该进清单');
    const skillFiles = result.modules.skills.entries.map((e) => e.relPath);
    assert.deepEqual([...skillFiles], [], '内容含令牌的技能文件不该进清单');

    assert.equal(result.credentials.length, 2, '两个被拦的文件都要有记录');
    const reasons = result.credentials.map((c) => `${c.relPath} <- ${c.reason}`);
    assert.ok(reasons.some((r) => r.includes('auth.json') && r.includes('文件名')), reasons.join(' | '));
    assert.ok(reasons.some((r) => r.includes('SKILL.md') && r.includes('内容命中')), reasons.join(' | '));

    // 计数也要跟着少，不能出现「说 2 个文件、实际打 1 个」
    assert.equal(result.modules.memory.files, 1);
    assert.equal(result.modules.skills.files, 0);
  });
});

test('★ buildManifest 是第二道闸：即使 entries 被手工塞进凭据也不进清单', () => {
  const roots = { dshHome: 'C:/dsh', userHome: 'C:/u', profile: 'desktop', agentsSkills: 'C:/u/.agents/skills' };
  const result = {
    modules: {
      memory: {
        id: 'memory',
        label: '记忆',
        countKind: 'file',
        count: 2,
        files: 2,
        bytes: 20,
        entries: [
          {
            moduleId: 'memory',
            base: 'C:/dsh/memories',
            relPath: 'MEMORY.md',
            absPath: 'C:/dsh/memories/MEMORY.md',
            size: 10,
            mtimeMs: 1,
            sha256: 'a'.repeat(64),
          },
          {
            moduleId: 'memory',
            base: 'C:/dsh/memories',
            relPath: '.credentials.yaml',
            absPath: 'C:/dsh/memories/.credentials.yaml',
            size: 10,
            mtimeMs: 1,
            sha256: 'b'.repeat(64),
          },
        ],
      },
    },
  };
  const manifest = buildManifest({ roots, result, moduleIds: ['memory'] });
  assert.deepEqual(
    [...manifest.files.map((f) => f.key)],
    ['memory:MEMORY.md'],
    '凭据文件绝不能出现在清单里',
  );
  assert.equal(manifest.blocked.length, 1, '被拦下的要留痕');
  assert.equal(manifest.blocked[0].relPath, '.credentials.yaml');
});
