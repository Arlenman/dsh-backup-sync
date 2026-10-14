/**
 * 文件查看接口的测试。
 *
 * 这是插件里唯一一条把文件内容回吐给界面的路径，所以测试重点全在**闸门**上：
 * 路径穿越、模块归属、凭据拒绝、体积截断。这些闸门只要漏一个，
 * 界面就成了「读任意文件」的入口。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_VIEW_BYTES, describeModuleFile, normalizeRelPath, resolveModuleFile } from '../lib/fileview.js';
import { withFixture } from './fixture.js';

// ───────────────────────── 路径形态闸 ─────────────────────────

test('normalizeRelPath：正常相对路径归一为 posix', () => {
  assert.equal(normalizeRelPath('a/b.md'), 'a/b.md');
  assert.equal(normalizeRelPath('a\\b.md'), 'a/b.md');
  assert.equal(normalizeRelPath('./a/b.md'), null, '带 . 段的一律拒绝，正常路径不该有');
  assert.equal(normalizeRelPath('  a/b.md  '), 'a/b.md');
});

test('★ normalizeRelPath：绝对路径、盘符、UNC、.. 一律拒绝', () => {
  for (const bad of [
    'C:\\Users\\x\\.dsh\\.credentials.yaml',
    'c:/x',
    '/etc/passwd',
    '\\windows\\system32',
    '//server/share/x',
    '\\\\server\\share\\x',
    '../outside.md',
    'a/../../outside.md',
    'a/..',
    '..',
    '',
    '   ',
    'a\0b',
  ]) {
    assert.equal(normalizeRelPath(bad), null, `应拒绝：${bad}`);
  }
  for (const notString of [null, undefined, 42, {}, []]) {
    assert.equal(normalizeRelPath(notString), null);
  }
});

// ───────────────────────── 解析闸 ─────────────────────────

test('resolveModuleFile：认得出来的文件解析到绝对路径', async () => {
  await withFixture(async (fx) => {
    const r = resolveModuleFile(fx.roots, 'config', 'settings.yaml');
    assert.equal(r.ok, true);
    assert.equal(r.absPath, join(fx.roots.dshHome, 'settings.yaml'));
    assert.equal(r.relPath, 'settings.yaml');
  });
});

test('★ resolveModuleFile：不认识的模块 id 直接拒绝', async () => {
  await withFixture(async (fx) => {
    const r = resolveModuleFile(fx.roots, 'credentials', '.credentials.yaml');
    assert.equal(r.ok, false);
    assert.match(r.reason, /不认识的模块/);
  });
});

test('★ resolveModuleFile：穿越路径拒绝（哪怕拼出来真存在）', async () => {
  await withFixture(async (fx) => {
    await writeFile(join(fx.roots.dshHome, '.credentials.yaml'), 'client-connection:\n  secret: x\n', 'utf8');
    for (const bad of ['../.credentials.yaml', '../../.credentials.yaml', 'C:\\Windows\\win.ini']) {
      const r = resolveModuleFile(fx.roots, 'config', bad);
      assert.equal(r.ok, false, `应拒绝：${bad}`);
    }
  });
});

test('★ resolveModuleFile：文件必须被该模块认领 —— 用错模块 id 读邻居的文件也要拒', async () => {
  await withFixture(async (fx) => {
    // memories/TODOS-life.md 属于「待办」，不属于「记忆」
    assert.equal(resolveModuleFile(fx.roots, 'memory', 'TODOS-life.md').ok, false);
    assert.equal(resolveModuleFile(fx.roots, 'todo', 'TODOS-life.md').ok, true);
    // 注意：relPath 是**相对模块根**的，不是相对 ~/.dsh。
    // profiles/desktop/package.json 在「插件」模块里就叫 package.json。
    assert.equal(resolveModuleFile(fx.roots, 'config', 'package.json').ok, false);
    assert.equal(resolveModuleFile(fx.roots, 'plugins', 'package.json').ok, true);
    // 「配置」有两个根（profile 与 ~/.dsh），各自只认自己的文件
    assert.equal(resolveModuleFile(fx.roots, 'config', 'cordis.patch.yml').ok, true);
    assert.equal(resolveModuleFile(fx.roots, 'config', 'settings.yaml').ok, true);
  });
});

test('resolveModuleFile：技能库在 ~/.dsh 之外，也必须能解析', async () => {
  await withFixture(async (fx) => {
    const r = resolveModuleFile(fx.roots, 'skills', 'cdp-browser-automation/SKILL.md');
    assert.equal(r.ok, true);
    assert.equal(r.absPath, join(fx.roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md'));
  });
});

test('resolveModuleFile：技能模块里不许读技能库根之外的路径', async () => {
  await withFixture(async (fx) => {
    const r = resolveModuleFile(fx.roots, 'skills', '../win-disk-cleaner/SKILL.md');
    assert.equal(r.ok, false);
  });
});

// ───────────────────────── 读取 ─────────────────────────

test('describeModuleFile：正常文本文件回内容与元信息', async () => {
  await withFixture(async (fx) => {
    const v = await describeModuleFile(fx.roots, { moduleId: 'config', relPath: 'settings.yaml' });
    assert.equal(v.viewable, true);
    assert.equal(v.text, 'a: 1\n');
    assert.equal(v.bytes, 5);
    assert.equal(v.truncated, false);
    assert.equal(v.binary, false);
    assert.equal(v.guard, null);
    assert.ok(typeof v.mtimeMs === 'number' && v.mtimeMs > 0);
  });
});

test('describeModuleFile：不存在的文件给中文原因，不抛错', async () => {
  await withFixture(async (fx) => {
    const v = await describeModuleFile(fx.roots, { moduleId: 'config', relPath: 'settings.yaml' });
    assert.equal(v.viewable, true);
    const missing = await describeModuleFile(fx.roots, { moduleId: 'config', relPath: 'AGENTS.md.bak' });
    assert.equal(missing.viewable, false);
    assert.match(missing.reason, /不存在|不属于/);
  });
});

test('describeModuleFile：目录不能当文件读', async () => {
  await withFixture(async (fx) => {
    const v = await describeModuleFile(fx.roots, { moduleId: 'memory', relPath: 'daily' });
    assert.equal(v.viewable, false);
    assert.ok(/普通文件|不属于/.test(v.reason), `原因应说明是目录，实得：${v.reason}`);
  });
});

test('★ describeModuleFile：.npmrc 里的认证令牌被内容闸拦下，片段打码', async () => {
  await withFixture(async (fx) => {
    await writeFile(
      join(fx.roots.dshHome, 'profiles', 'desktop', '.npmrc'),
      'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWx\n',
      'utf8',
    );
    const v = await describeModuleFile(fx.roots, { moduleId: 'plugins', relPath: '.npmrc' });
    assert.equal(v.viewable, false, '带 _authToken 的 .npmrc 必须被内容闸拦下');
    assert.ok(v.guard !== null);
    assert.ok(!String(v.guard.excerpt).includes('AbCdEfGhIjKlMnOpQrStUvWx'), '片段必须是打码的');
    assert.equal(v.text, null, '被拦下时不许回内容');
  });
});

test('describeModuleFile：不带令牌的 .npmrc 正常显示（守卫别误伤）', async () => {
  await withFixture(async (fx) => {
    const v = await describeModuleFile(fx.roots, { moduleId: 'plugins', relPath: '.npmrc' });
    assert.equal(v.viewable, true);
    assert.match(v.text, /registry\.npmjs\.org/);
  });
});

test('★ describeModuleFile：文件名闸对 .pem 之类的后缀无条件生效', async () => {
  await withFixture(async (fx) => {
    await writeFile(join(fx.roots.dshHome, 'AGENTS.md'), 'x\n', 'utf8');
    await mkdir(join(fx.roots.dshHome, 'memories'), { recursive: true });
    await writeFile(join(fx.roots.dshHome, 'memories', 'server.pem'), '-----BEGIN PRIVATE KEY-----\nAAA\n', 'utf8');
    const v = await describeModuleFile(fx.roots, { moduleId: 'memory', relPath: 'server.pem' });
    assert.equal(v.viewable, false);
    assert.equal(v.text, null);
    assert.match(v.reason, /凭据/);
    assert.equal(v.guard.id, '文件名闸');
  });
});

test('★ describeModuleFile：超过上限只读前一段，并明确标记 truncated', async () => {
  await withFixture(async (fx) => {
    const big = 'a'.repeat(MAX_VIEW_BYTES + 5000);
    await writeFile(join(fx.roots.dshHome, 'AGENTS.md'), big, 'utf8');
    const v = await describeModuleFile(fx.roots, { moduleId: 'config', relPath: 'AGENTS.md' });
    assert.equal(v.viewable, true);
    assert.equal(v.truncated, true, '必须标记截断，不能静默');
    assert.equal(v.bytes, big.length, '字节数报真实大小');
    assert.ok(v.text.length <= MAX_VIEW_BYTES);
  });
});

test('describeModuleFile：二进制文件不预览，如实说明', async () => {
  await withFixture(async (fx) => {
    await writeFile(join(fx.roots.dshHome, 'AGENTS.md'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
    const v = await describeModuleFile(fx.roots, { moduleId: 'config', relPath: 'AGENTS.md' });
    assert.equal(v.viewable, false);
    assert.equal(v.binary, true);
    assert.equal(v.text, null);
    assert.match(v.reason, /二进制/);
  });
});

test('describeModuleFile：缺参数不抛错，回中文原因', async () => {
  await withFixture(async (fx) => {
    const v = await describeModuleFile(fx.roots, {});
    assert.equal(v.viewable, false);
    assert.match(v.reason, /不认识的模块/);
  });
});

test('★ describeModuleFile：内容里的私钥块被拦，片段打码', async () => {
  await withFixture(async (fx) => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----\n';
    await writeFile(join(fx.roots.dshHome, 'memories', 'MEMORY.md'), pem, 'utf8');
    const v = await describeModuleFile(fx.roots, { moduleId: 'memory', relPath: 'MEMORY.md' });
    assert.equal(v.viewable, false);
    assert.ok(v.guard !== null);
    assert.ok(v.guard.excerpt.includes('…'), '片段必须是头 6 + … + 尾 2');
    assert.ok(!v.guard.excerpt.includes('1234567890'), '中间内容不能出现在片段里');
  });
});

test('describeModuleFile：假阳性不误伤（普通中文说明照常显示）', async () => {
  await withFixture(async (fx) => {
    await writeFile(
      join(fx.roots.dshHome, 'memories', 'MEMORY.md'),
      '# 记忆\n\n这条讲的是 token 这个词本身，不是令牌。\npassword: 见密码管理器\n',
      'utf8',
    );
    const v = await describeModuleFile(fx.roots, { moduleId: 'memory', relPath: 'MEMORY.md' });
    assert.equal(v.viewable, true);
    assert.match(v.text, /密码管理器/);
  });
});
