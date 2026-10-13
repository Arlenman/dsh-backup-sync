#!/usr/bin/env node
/**
 * 对**真实机器**跑一次扫描并打印报告。
 *
 * 这是 M1 的验收工具：不需要 DSH、不需要装插件、不写任何文件，
 * 只回答一个问题 —— 「如果现在备份，六个模块各有多少条数据、各占多大」。
 *
 * 用法：
 *   node scripts/scan-report.mjs                      # 默认 desktop profile
 *   node scripts/scan-report.mjs --json               # 输出 JSON
 *   node scripts/scan-report.mjs --modules todo,memory
 */
import { resolveRoots } from '../lib/paths.js';
import { scan, summarize } from '../lib/scan.js';

function parseArgs(argv) {
  const out = { json: false, modules: null, profile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--modules') out.modules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--profile') out.profile = argv[++i];
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const args = parseArgs(process.argv.slice(2));
const roots = resolveRoots(process.env, args.profile ? { profile: args.profile } : {});
const result = await scan(roots, args.modules ? { moduleIds: args.modules } : {});

if (args.json) {
  console.log(JSON.stringify({ roots: result.roots, summary: summarize(result), warnings: result.warnings, totals: result.totals }, null, 2));
  process.exit(0);
}

console.log('备份同步 · 扫描报告');
console.log(`  时间       ${new Date(result.scannedAt).toLocaleString('zh-CN')}`);
console.log(`  DSH_HOME   ${roots.dshHome}`);
console.log(`  USER_HOME  ${roots.userHome}`);
console.log(`  profile    ${roots.profile}`);
console.log(`  技能库     ${roots.agentsSkills}`);
console.log('');

const rows = summarize(result);
const wLabel = Math.max(4, ...rows.map((r) => r.label.length * 2));
const wCount = Math.max(5, ...rows.map((r) => String(r.count).length));

console.log(`${'模块'.padEnd(wLabel)}  ${'条目'.padStart(wCount)}  ${'文件'.padStart(6)}  ${'体积'.padStart(10)}  勾选  说明`);
console.log('-'.repeat(wLabel + wCount + 42));
for (const r of rows) {
  const box = r.defaultChecked ? '[x]' : '[ ]';
  console.log(
    `${r.label.padEnd(wLabel)}  ${String(r.count).padStart(wCount)}  ${String(r.files).padStart(6)}  ${human(r.bytes).padStart(10)}  ${box}   ${r.note}`,
  );
  // 根不存在时要显式说出来，否则「0 条」会被误读成「没有数据」
  for (const b of r.bases) {
    if (!b.exists) console.log(`${' '.repeat(wLabel)}  ⚠ 根不存在：${b.base}`);
  }
  if (Object.keys(r.tracks).length > 0) {
    const t = Object.entries(r.tracks).map(([k, v]) => `${k}=${v}`).join('  ');
    console.log(`${' '.repeat(wLabel)}  ↳ 轨道分布：${t}`);
  }
}
console.log('-'.repeat(wLabel + wCount + 42));
console.log(`${'合计'.padEnd(wLabel)}  ${''.padStart(wCount)}  ${String(result.totals.files).padStart(6)}  ${human(result.totals.bytes).padStart(10)}`);

const checked = rows.filter((r) => r.defaultChecked);
const checkedBytes = checked.reduce((n, r) => n + r.bytes, 0);
console.log('');
console.log(`默认勾选 ${checked.length} 个模块，共 ${checked.reduce((n, r) => n + r.files, 0)} 个文件 / ${human(checkedBytes)}`);

if (result.warnings.length > 0) {
  console.log('');
  console.log(`⚠ ${result.warnings.length} 条警告：`);
  for (const w of result.warnings.slice(0, 20)) console.log(`   ${w.path} → ${w.reason}`);
  if (result.warnings.length > 20) console.log(`   …另有 ${result.warnings.length - 20} 条`);
}
