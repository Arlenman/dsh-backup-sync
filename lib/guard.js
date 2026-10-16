/**
 * 凭据守卫 —— 保证「凭据永不进包、永不进基线」不是靠运气。
 *
 * 背景：备份根是按模块白名单挑的，`.credentials.yaml` 之所以没进包，只是因为
 * 恰好没有任何模块根覆盖 `dshHome` 根目录。一旦以后有人加一个根、或者用户把
 * 凭据挪了位置，明文 API key 就会静默打进包里再被推到云上。
 *
 * 两道闸：
 *  1. **文件名闸**（`inspectPath`）—— 名字本身就是凭据的，无条件拒绝，不看内容。
 *  2. **内容闸**（`inspectContent`）—— 高信号特征串，宁可误拦也要拦住。
 *
 * 命中一律**剔除该文件**并写进 `credentials` 列表，由界面显著提示。
 * 这里刻意不做「静默跳过」：用户必须知道少了哪个文件、为什么少。
 */

/** 文件名闸：命中即永不进包，不看内容。 */
const SECRET_BASENAMES = new Set([
  '.credentials.yaml',
  '.credentials.yml',
  '.credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'credentials.json',
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  'auth.json',
  'github.token',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  // 包管理器配置：既写机器本地绝对路径（`store-dir` / `prefix` / `cache`），
  // 又常藏 `_authToken`。跨机搬运两边都是坏消息 —— 真机实测（2026-10-14，WSL
  // 换机导入）：Windows 那台的 `.npmrc` 里 `store-dir=C:\Users\…\pnpm\store\v11`
  // 随包进了 Linux 那台的 profile，那个 profile 的 pnpm 立刻
  // `ERR_PNPM_UNEXPECTED_STORE`，插件都装不上了。
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  // 本插件自己的云备份密码（`~/.dsh/backup-sync/cloud-credentials.json`）。
  // 它天然在 dshHome 里，一旦以后有模块根覆盖到那一层，密码就会被打进包、
  // 再被推到云端 —— 那等于把保险箱密码贴在保险箱上。文件名入闸，无条件拒绝。
  'cloud-credentials.json',
]);

/** 后缀闸：私钥/证书容器。 */
const SECRET_SUFFIXES = ['.pem', '.key', '.pfx', '.p12', '.keystore', '.jks', '.ppk'];

/**
 * 内容闸：只放**高信号**特征，避免把用户的记忆/文档误拦。
 *
 * 刻意不收的宽泛规则：`api_key = <20+ 字符>`、`password:`、`token:` 之类 ——
 * 它们在记忆、技能文档、会话记录里遍地都是，会把备份拦成筛子。
 *
 * 更要紧的是**占位符**：本机实测踩过一次 —— 项目记忆里写
 * 「凭据以 `https://x-access-token:<token>@github.com` 写入 helper」，
 * 早期规则 `x-access-token:[^@\s/]+@` 把字面量 `<token>` 当成真令牌，
 * 直接把那份记忆文件挡在备份之外。所以凡是「密钥部分」都必须要求
 * **真实令牌的字符形态与长度**，占位符（`<...>`、`${...}`、`xxx`）一律不匹配。
 */
const SECRET_PATTERNS = [
  { id: '私钥文件头', re: /-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY-----/ },
  // 值必须是令牌形态；`_authToken=<YOUR_TOKEN>` 这类占位符不匹配
  { id: 'npm 认证令牌', re: /_auth(?:Token)?\s*=\s*[A-Za-z0-9_-]{16,}/ },
  { id: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { id: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'Slack 令牌', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  // JWT 的第三段（签名）在日志里常被截掉，所以签名段可选。
  // `eyJ` 是 `{"` 的 base64，出现两段基本就是 JWT，误报率极低。
  { id: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.?/ },
  // 同样要求真令牌形态，挡住 `x-access-token:<token>@`
  { id: '带令牌的 git 地址', re: /https?:\/\/x-access-token:[A-Za-z0-9_-]{20,}@/ },
  { id: '字面量 Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._-]{24,}/ },
];

/** 内容闸的体积上限：凭据都是小文件，巨型文件不读全文（只用文件名闸兜）。 */
export const MAX_GUARD_BYTES = 1024 * 1024;

/**
 * 每类文件「为什么不进包」的**具体**说法。
 *
 * 为什么要分开写：界面上原来一律显示「文件名属于凭据类」，
 * 用户看到自己的 `.npmrc`（里面只有一行 `store-dir`，一个密钥都没有）被拦下时，
 * 第一反应是「插件是不是坏了」。而这两类文件被拦的理由完全不同 ——
 * 一类是**泄密风险**，一类是**写死了本机路径、搬过去会坏事**。
 * 说不清理由的安全闸，用户只会想办法绕开它。
 *
 * 每一条都保留「凭据类」开头：它既是界面上的归类词，也是各处断言与日志
 * 识别「这句话来自哪个闸」的锚点，别为了文案好看把它删掉。
 * 同理要写明「文件名」——这道闸看的就是文件名，与内容闸的理由必须能分辨。
 */
const SECRET_REASONS = [
  [
    [
      '.credentials.yaml', '.credentials.yml', '.credentials.json',
      'credentials.yaml', 'credentials.yml', 'credentials.json',
      'secrets.yaml', 'secrets.yml', 'secrets.json',
    ],
    (b) => `凭据类 · 文件名就是凭据文件本体（${b}）：里面是明文 API key / 会话密钥`,
  ],
  [
    ['.env', '.env.local', '.env.production', '.env.development'],
    (b) => `凭据类 · 文件名是环境变量文件（${b}）：常见放密钥的位置`,
  ],
  [
    ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'],
    (b) => `凭据类 · 文件名是 ssh 私钥（${b}）：交出去等于把机器交出去`,
  ],
  [
    ['auth.json', 'github.token', '.netrc', '_netrc', '.git-credentials', '.htpasswd'],
    (b) => `凭据类 · 文件名是登录凭据（${b}）：里面是账号密码或访问令牌`,
  ],
  [
    ['.npmrc', '.yarnrc', '.yarnrc.yml'],
    (b) =>
      `凭据类 · 文件名是包管理器配置（${b}）：可能藏 _authToken，而且常写死这台机器的路径（store-dir 之类）——` +
      '搬到别的机器会让包管理器直接罢工',
  ],
  [
    ['cloud-credentials.json'],
    (b) => `凭据类 · 文件名是本插件的云备份密码（${b}）：等于保险箱密码，绝不进包`,
  ],
];

/** basename（小写）→ 具体理由。 */
const REASON_BY_NAME = new Map();
for (const [names, make] of SECRET_REASONS) {
  for (const n of names) REASON_BY_NAME.set(n, make);
}

/** 该 basename 是否是凭据类文件。 */
export function secretBasenameReason(basename) {
  const lower = String(basename).toLowerCase();
  if (SECRET_BASENAMES.has(lower)) {
    const make = REASON_BY_NAME.get(lower);
    return make === undefined ? `文件名属于凭据类（${basename}）` : make(basename);
  }
  for (const suf of SECRET_SUFFIXES) if (lower.endsWith(suf)) return `后缀属于凭据容器（${suf}）`;
  return null;
}

/**
 * 第一道闸：只看路径。
 *
 * @param {string} relPath 相对路径（posix 或平台分隔符都可）
 * @returns {string|null} 命中的原因，未命中返回 null
 */
export function inspectPath(relPath) {
  const parts = String(relPath).split(/[\\/]/).filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : String(relPath);
  return secretBasenameReason(base);
}

/**
 * 第二道闸：看内容。只对文本文件有意义。
 *
 * @param {string} text
 * @returns {string|null} 命中的规则名，未命中返回 null
 */
export function inspectContent(text) {
  const hit = inspectContentMatch(text);
  return hit === null ? null : hit.id;
}

/** 把命中的片段打码：留头 6 尾 2，中间省略。既能定位误报，又不复述密钥。 */
function maskExcerpt(s) {
  const t = String(s);
  if (t.length <= 10) return `${t.slice(0, 2)}…`;
  return `${t.slice(0, 6)}…${t.slice(-2)}`;
}

/**
 * 与 `inspectContent` 相同，但额外给出打码后的命中片段。
 *
 * 为什么要片段：内容闸必然有误报（本机就踩过一次 —— 记忆里记录了凭据**格式**
 * 而非凭据本身）。只报规则名，用户无法判断该不该放行；给出打码片段，
 * 一眼就能看出「这是占位符」还是「这是我的真令牌」。
 *
 * @param {string} text
 * @returns {{id: string, excerpt: string}|null}
 */
export function inspectContentMatch(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(text);
    if (m !== null) return { id: p.id, excerpt: maskExcerpt(m[0]) };
  }
  return null;
}

/**
 * 对一个待打包文件做完整判定。`readText` 由调用方注入，便于复用已经读过的内容。
 *
 * @param {{relPath: string, size?: number}} entry
 * @param {() => Promise<string|null>} [readText] 需要读内容时调用；返回 null 表示跳过内容闸
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
export async function guardEntry(entry, readText) {
  const byPath = inspectPath(entry.relPath);
  if (byPath !== null) return { blocked: true, reason: byPath };
  if (typeof readText !== 'function') return { blocked: false };
  if (typeof entry.size === 'number' && entry.size > MAX_GUARD_BYTES) return { blocked: false };
  let text;
  try {
    text = await readText();
  } catch {
    return { blocked: false }; // 读不到不该让守卫误判成凭据
  }
  if (text === null || text === undefined) return { blocked: false };
  const hit = inspectContentMatch(text);
  if (hit !== null) {
    return { blocked: true, reason: `内容命中「${hit.id}」（片段 ${hit.excerpt}）` };
  }
  return { blocked: false };
}
