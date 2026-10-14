/**
 * 技能清单的测试。
 *
 * 关键点：技能行的**文件数与体积必须与技能卡上的计数同源**（都来自 `scan()`），
 * 否则界面会出现「卡片写 10 个、展开只有 9 行」这种对不上的情况。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildSkillRows, describeSkill, firstParagraph, listSkills, parseFrontmatter } from '../lib/skills.js';
import { scan } from '../lib/scan.js';
import { withFixture } from './fixture.js';

// ───────────────────────── frontmatter ─────────────────────────

test('parseFrontmatter：标准两字段', () => {
  const { data, body } = parseFrontmatter('---\nname: foo\ndescription: 干这个的\n---\n\n正文\n');
  assert.equal(data.name, 'foo');
  assert.equal(data.description, '干这个的');
  assert.equal(body.trim(), '正文');
});

test('parseFrontmatter：BOM、CRLF、带引号的值都能吃', () => {
  const crlf = parseFrontmatter('\uFEFF---\r\nname: "bar"\r\ndescription: \'带 空格\'\r\n---\r\nbody\r\n');
  assert.equal(crlf.data.name, 'bar');
  assert.equal(crlf.data.description, '带 空格');
});

test('parseFrontmatter：description 折行块（> 与 |）拼成一行', () => {
  const folded = parseFrontmatter('---\nname: x\ndescription: >\n  第一行\n  第二行\n---\n');
  assert.equal(folded.data.description, '第一行 第二行');
  const literal = parseFrontmatter('---\nname: x\ndescription: |\n  a\n  b\n---\n');
  assert.equal(literal.data.description, 'a b');
});

test('parseFrontmatter：没有 frontmatter 时原样返回正文，不抛错', () => {
  const none = parseFrontmatter('# 只有标题\n\n内容\n');
  assert.deepEqual({ ...none.data }, {});
  assert.match(none.body, /只有标题/);
  assert.deepEqual({ ...parseFrontmatter('').data }, {});
  assert.deepEqual({ ...parseFrontmatter(null).data }, {});
});

test('parseFrontmatter：只有开头 --- 没有结尾 --- 时不当成 frontmatter', () => {
  const { data, body } = parseFrontmatter('---\nname: x\n没有结尾\n');
  assert.deepEqual({ ...data }, {});
  assert.match(body, /name: x/);
});

test('parseFrontmatter：值里的冒号不被当成新字段', () => {
  const { data } = parseFrontmatter('---\nname: x\ndescription: 用法：先这样，再那样\n---\n');
  assert.equal(data.description, '用法：先这样，再那样');
});

// ───────────────────────── firstParagraph ─────────────────────────

test('firstParagraph：跳过空行与标题，取第一段', () => {
  assert.equal(firstParagraph('# 标题\n\n这是第一段。\n第二行。\n\n第二段。'), '这是第一段。 第二行。');
  assert.equal(firstParagraph('# 标题\n直接开始\n'), '直接开始');
  assert.equal(firstParagraph(''), '');
  assert.equal(firstParagraph(null), '');
  assert.equal(firstParagraph('<!-- 注释 -->\n\n真内容'), '真内容');
});

// ───────────────────────── describeSkill ─────────────────────────

test('describeSkill：frontmatter 齐全时直接用', () => {
  const d = describeSkill('---\nname: a\ndescription: b\n---\n\n正文\n', 'dir-name');
  assert.equal(d.name, 'a');
  assert.equal(d.description, 'b');
  assert.equal(d.descriptionSource, 'frontmatter');
});

test('describeSkill：没写 description 就退回正文第一段', () => {
  const d = describeSkill('---\nname: a\n---\n\n# 标题\n\n这个技能用来干某件事。\n', 'dir-name');
  assert.equal(d.description, '这个技能用来干某件事。');
  assert.equal(d.descriptionSource, 'body');
});

test('describeSkill：既没有 frontmatter 也没有正文时 description 是 null，name 退回目录名', () => {
  const d = describeSkill('', 'my-skill');
  assert.equal(d.name, 'my-skill');
  assert.equal(d.description, null);
  assert.equal(d.descriptionSource, 'none');
});

test('★ describeSkill：只有一行标题时把标题当描述（比显示「没有描述」有用得多）', () => {
  const d = describeSkill('# win-disk-cleaner\n', 'win-disk-cleaner');
  assert.equal(d.description, 'win-disk-cleaner');
  assert.equal(d.descriptionSource, 'heading');
  const d2 = describeSkill('## 二级标题也行 ##\n', 'x');
  assert.equal(d2.description, '二级标题也行');
});

test('describeSkill：正文第一段优先于标题（标题只是最后兜底）', () => {
  const d = describeSkill('# 标题\n\n真正的说明。\n', 'x');
  assert.equal(d.description, '真正的说明。');
  assert.equal(d.descriptionSource, 'body');
});

test('describeSkill：超长描述被截断，避免把弹窗撑爆', () => {
  const long = 'x'.repeat(2000);
  const d = describeSkill(`---\nname: a\ndescription: ${long}\n---\n`, 'a');
  assert.equal(d.description.length, 601);
  assert.ok(d.description.endsWith('…'));
});

// ───────────────────────── buildSkillRows ─────────────────────────

test('buildSkillRows：按第一段路径分组，数出文件数与体积', () => {
  const rows = buildSkillRows({
    modules: {
      skills: {
        entries: [
          { relPath: 'a/SKILL.md', size: 10, mtimeMs: 100 },
          { relPath: 'a/scripts/x.mjs', size: 20, mtimeMs: 300 },
          { relPath: 'b/SKILL.md', size: 5, mtimeMs: 200 },
        ],
      },
    },
  });
  assert.deepEqual(
    rows.map((r) => ({ id: r.id, files: r.files, bytes: r.bytes, hasSkillMd: r.hasSkillMd, mtimeMs: r.mtimeMs })),
    [
      { id: 'a', files: 2, bytes: 30, hasSkillMd: true, mtimeMs: 300 },
      { id: 'b', files: 1, bytes: 5, hasSkillMd: true, mtimeMs: 200 },
    ],
  );
});

test('buildSkillRows：根目录下的散文件不算技能；没有 SKILL.md 的目录也算一行但被标记', () => {
  const rows = buildSkillRows({
    modules: {
      skills: {
        entries: [
          { relPath: 'README.md', size: 1, mtimeMs: 1 },
          { relPath: 'no-md/notes.txt', size: 2, mtimeMs: 2 },
        ],
      },
    },
  });
  assert.deepEqual(rows.map((r) => r.id), ['no-md']);
  assert.equal(rows[0].hasSkillMd, false);
});

test('buildSkillRows：没有技能模块时返回空数组', () => {
  assert.deepEqual(buildSkillRows(null), []);
  assert.deepEqual(buildSkillRows({ modules: {} }), []);
  assert.deepEqual(buildSkillRows({ modules: { skills: {} } }), []);
});

test('★ buildSkillRows 的行数与技能卡的计数口径一致（都是顶层目录数）', async () => {
  await withFixture(async (fx) => {
    const result = await scan(fx.roots, { moduleIds: ['skills'] });
    const rows = buildSkillRows(result);
    assert.equal(rows.length, result.modules.skills.count, '展开后的行数必须等于卡片上的「技能 N 个」');
    assert.equal(
      rows.reduce((n, r) => n + r.files, 0),
      result.modules.skills.files,
      '各行文件数之和必须等于模块文件总数',
    );
    assert.equal(
      rows.reduce((n, r) => n + r.bytes, 0),
      result.modules.skills.bytes,
      '各行体积之和必须等于模块总字节数',
    );
  });
});

// ───────────────────────── listSkills（真目录） ─────────────────────────

test('listSkills：读出真实技能的名字与描述', async () => {
  await withFixture(async (fx) => {
    await writeFile(
      join(fx.roots.agentsSkills, 'cdp-browser-automation', 'SKILL.md'),
      '---\nname: cdp-browser-automation\ndescription: 用 CDP 驱动浏览器\n---\n\n正文\n',
      'utf8',
    );
    const list = await listSkills(fx.roots);
    const cdp = list.find((s) => s.id === 'cdp-browser-automation');
    assert.equal(cdp.name, 'cdp-browser-automation');
    assert.equal(cdp.description, '用 CDP 驱动浏览器');
    assert.equal(cdp.descriptionSource, 'frontmatter');
    assert.equal(cdp.hasSkillMd, true);
    assert.equal(cdp.files, 2, 'SKILL.md + scripts/run.mjs，node_modules 被跳过');
    assert.ok(cdp.path.endsWith(join('.agents', 'skills', 'cdp-browser-automation')));
  });
});

test('listSkills：没有 SKILL.md 的技能也出现，描述为 null（不能让它凭空消失）', async () => {
  await withFixture(async (fx) => {
    await mkdir(join(fx.roots.agentsSkills, 'half-baked'), { recursive: true });
    await writeFile(join(fx.roots.agentsSkills, 'half-baked', 'notes.md'), 'x\n', 'utf8');
    const list = await listSkills(fx.roots);
    const half = list.find((s) => s.id === 'half-baked');
    assert.ok(half !== undefined, '没有 SKILL.md 的技能目录也必须出现');
    assert.equal(half.hasSkillMd, false);
    assert.equal(half.description, null);
    assert.equal(half.name, 'half-baked', '名字退回目录名');
  });
});

test('listSkills：按技能名排序，顺序稳定', async () => {
  await withFixture(async (fx) => {
    const list = await listSkills(fx.roots);
    const ids = list.map((s) => s.id);
    assert.deepEqual(ids, [...ids].sort());
  });
});

test('listSkills：技能库不存在时返回空数组，不抛错', async () => {
  await withFixture({ empty: true }, async (fx) => {
    const list = await listSkills(fx.roots);
    assert.deepEqual(list, []);
  });
});
