/**
 * 技能清单：把「技能」模块的一堆文件，归拢成「一个技能一行」。
 *
 * ## 为什么要单独一层
 *
 * 扫描器给的是**扁平文件清单**，所以技能卡展开后看到的是一串
 * `cdp-browser-automation/SKILL.md`、`cdp-browser-automation/scripts/x.mjs`……
 * 对用户毫无意义 —— 他关心的是「我有哪几个技能、各自多大」。
 *
 * ## 为什么不自己走一遍目录
 *
 * 复用 `scan()` 的结果，而不是另写一个 walker：否则**计数口径会和技能卡对不上**
 * （卡片上写「10 个」，展开却只有 9 行），而且会绕过凭据守卫。
 * 这一层只做两件事：按第一段路径分组、读每个技能的 `SKILL.md` 拿描述。
 *
 * ## frontmatter 解析为什么要这么宽
 *
 * 技能文件是**人写的**，而技能规范只强制 `name` 与 `description` 两行。
 * 实测会遇到：BOM 开头、CRLF 换行、`description: >` 折行块、值带引号、
 * 甚至整个 frontmatter 缺失。任何一种都不该让整行技能消失 ——
 * 拿不到描述就退回正文第一段，再拿不到就显示「（没有描述）」。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scan } from './scan.js';

/** 描述最长显示多少字（超长描述会把弹窗撑爆）。 */
export const MAX_DESCRIPTION_CHARS = 600;

/** 去掉配对的引号。 */
function unquote(value) {
  const v = String(value).trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 解析 YAML frontmatter（只认顶层 `key: value`，不引第三方 YAML 库）。
 *
 * 刻意不做完整 YAML：技能文件里 frontmatter 只有两三个标量字段，
 * 引一个 YAML 依赖来解析它是过度设计，而且 YAML 的隐式类型转换
 * （`name: no` → 布尔 false）反而会咬人。
 *
 * @param {string} text
 * @returns {{data: Record<string,string>, body: string}}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return { data: {}, body: src };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: src };

  /** @type {Record<string,string>} */
  const data = {};
  let key = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    // 缩进行是上一行的续行（`description: >` 折行块、或普通折行）
    if (/^\s+\S/.test(line) && key !== null) {
      data[key] = `${data[key]} ${line.trim()}`.replace(/\s+/g, ' ').trim();
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    key = m[1];
    const value = m[2].trim();
    // 块标量指示符：内容在后续缩进行里
    if (/^[>|][+-]?$/.test(value)) {
      data[key] = '';
      continue;
    }
    data[key] = unquote(value);
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

/** 正文第一段：跳过空行、标题、以及引用块。 */
export function firstParagraph(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      if (out.length > 0) break;
      continue;
    }
    if (line.startsWith('#')) {
      if (out.length > 0) break;
      continue;
    }
    if (line.startsWith('>') || line.startsWith('<!--')) {
      if (out.length > 0) break;
      continue;
    }
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** 正文第一个标题的文本（很多技能文件只有一行标题，那就是它最像描述的东西）。 */
export function firstHeading(body) {
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw.trim());
    if (m !== null && m[1].trim() !== '') return m[1].trim();
  }
  return '';
}

/**
 * 从一个 `SKILL.md` 的正文里取出「叫什么、干什么」。
 *
 * 描述的兜底顺序：frontmatter.description → 正文第一段 → 正文第一个标题。
 * 加最后一级是因为实测很多技能文件就只有一行 `# 某技能` ——
 * 与其在悬停提示里显示「（没有描述）」，不如把标题当描述，那才是用户想看的。
 *
 * @param {string} text
 * @param {string|null} [fallbackName] frontmatter 里没写 name 时用什么
 * @returns {{name: string|null, description: string|null, descriptionSource: 'frontmatter'|'body'|'heading'|'none'}}
 */
export function describeSkill(text, fallbackName = null) {
  const { data, body } = parseFrontmatter(text);
  const rawName = typeof data.name === 'string' ? data.name.trim() : '';
  const name = rawName !== '' ? rawName : fallbackName !== null && fallbackName !== '' ? fallbackName : null;

  let description = typeof data.description === 'string' ? data.description.trim() : '';
  let descriptionSource = 'frontmatter';
  if (description === '') {
    description = firstParagraph(body);
    descriptionSource = description === '' ? 'none' : 'body';
  }
  if (description === '') {
    description = firstHeading(body);
    descriptionSource = description === '' ? 'none' : 'heading';
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`;
  }
  return { name, description: description === '' ? null : description, descriptionSource };
}

/**
 * 纯函数：把扫描结果里的「技能」模块归拢成一行一个技能。
 *
 * 行的排序按技能名，保证界面顺序稳定（否则每次刷新行序都在跳）。
 *
 * @param {any} scanResult `scan()` 的返回值
 * @returns {{id: string, dir: string, files: number, bytes: number, hasSkillMd: boolean, mtimeMs: number|null, entries: any[]}[]}
 */
export function buildSkillRows(scanResult) {
  const mod = scanResult?.modules?.skills;
  if (!mod || !Array.isArray(mod.entries)) return [];

  /** @type {Map<string, any>} */
  const byDir = new Map();
  for (const e of mod.entries) {
    const cut = String(e.relPath).indexOf('/');
    // 直接躺在技能库根下的散文件（没有目录）不算技能
    if (cut <= 0) continue;
    const dir = String(e.relPath).slice(0, cut);
    if (!byDir.has(dir)) {
      byDir.set(dir, { id: dir, dir, files: 0, bytes: 0, hasSkillMd: false, mtimeMs: null, entries: [] });
    }
    const row = byDir.get(dir);
    row.files += 1;
    row.bytes += Number(e.size) || 0;
    row.entries.push(e);
    if (e.relPath === `${dir}/SKILL.md`) row.hasSkillMd = true;
    if (Number.isFinite(e.mtimeMs) && (row.mtimeMs === null || e.mtimeMs > row.mtimeMs)) row.mtimeMs = e.mtimeMs;
  }

  return [...byDir.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 技能清单 + 描述。走 IO 的只有读 `SKILL.md` 这一步。
 *
 * @param {import('./paths.js').Roots} roots
 * @param {{scanResult?: any, warn?: (m: string) => void}} [opts]
 */
export async function listSkills(roots, opts = {}) {
  const result = opts.scanResult ?? (await scan(roots, { moduleIds: ['skills'] }));
  const rows = buildSkillRows(result);

  const out = [];
  for (const row of rows) {
    let name = row.id;
    let description = null;
    let descriptionSource = 'none';
    if (row.hasSkillMd) {
      const md = row.entries.find((e) => e.relPath === `${row.dir}/SKILL.md`);
      try {
        const text = await readFile(md.absPath, 'utf8');
        const parsed = describeSkill(text, row.id);
        name = parsed.name ?? row.id;
        description = parsed.description;
        descriptionSource = parsed.descriptionSource;
      } catch (err) {
        opts.warn?.(`读 ${row.dir}/SKILL.md 失败：${err?.code || err?.message}`);
      }
    }
    out.push({
      id: row.id,
      name,
      dir: row.dir,
      path: join(roots.agentsSkills, row.dir),
      description,
      descriptionSource,
      hasSkillMd: row.hasSkillMd,
      files: row.files,
      bytes: row.bytes,
      mtimeMs: row.mtimeMs,
    });
  }
  return out;
}
