// 对真机跑一次扫描，看凭据守卫拦了什么、有没有误伤。
import { resolveRoots } from '../lib/paths.js';
import { scan } from '../lib/scan.js';
import { human } from '../lib/service.js';

const roots = resolveRoots(process.env, {});
console.log('roots: ' + JSON.stringify(roots, null, 1));

const t0 = Date.now();
const r = await scan(roots, {});
console.log(`\n扫描用时 ${Date.now() - t0}ms`);
console.log(`文件 ${r.totals.files} 个 / ${human(r.totals.bytes)}`);

console.log('\n──── 各模块 ────');
for (const m of Object.values(r.modules)) {
  console.log(`  ${m.id.padEnd(9)} ${String(m.count).padStart(3)} ${m.countKind}  ${String(m.files).padStart(3)} 文件  ${human(m.bytes)}`);
}

console.log(`\n──── 凭据守卫拦截（${r.credentials.length} 个）────`);
if (r.credentials.length === 0) console.log('  （无）');
for (const c of r.credentials) console.log(`  [${c.moduleId}] ${c.relPath}\n      ${c.reason}`);

console.log(`\n──── 读取告警（${r.warnings.length} 条）────`);
for (const w of r.warnings.slice(0, 20)) console.log(`  ${w.path} → ${w.reason}`);

// 关键：确认真正的凭据文件确实没进任何模块
const flat = Object.values(r.modules).flatMap((m) => m.entries.map((e) => e.absPath.toLowerCase()));
const must = [
  'c:\\users\\x\\.dsh\\.credentials.yaml',
  'c:\\users\\x\\.dsh\\profiles\\desktop\\github.token',
];
console.log('\n──── 红线自检 ────');
for (const p of must) {
  console.log(`  ${flat.includes(p) ? '❌ 进包了' : '✅ 未进包'}  ${p}`);
}
console.log(`  ${flat.some((p) => p.includes('sessions')) ? '❌ 会话进了包' : '✅ 无会话文件'}  sessions/`);
