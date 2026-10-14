// 对真机跑一次扫描，看凭据守卫拦了什么、有没有误伤。
import { join, sep } from 'node:path';
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

// 关键：确认真正的凭据文件确实没进任何模块。
//
// ★ 这两条路径必须**从 roots 算出来**，绝不能写死。写死等于自检永远通过：
//   换一台机器跑，它查的是别人家的路径，永远查不到 → 一路 ✅ 但什么也没验证。
//   （2026-10-14 修：原实现硬编码了开发机上的绝对路径，公开仓库里更没意义。）
const flat = Object.values(r.modules).flatMap((m) => m.entries.map((e) => e.absPath.toLowerCase()));
const must = [
  join(roots.dshHome, '.credentials.yaml'),
  join(roots.dshHome, 'profiles', roots.profile, 'github.token'),
];
console.log('\n──── 红线自检 ────');
for (const p of must) {
  const hit = flat.includes(p.toLowerCase());
  console.log(`  ${hit ? '❌ 进包了' : '✅ 未进包'}  ${p}`);
}
const sessionHits = flat.filter((p) => p.includes(`${sep}sessions${sep}`)).length;
console.log(
  `  ℹ️  扫到 ${sessionHits} 个 sessions/ 文件 —— 它是「对话」模块，进不进包由勾选决定；` +
    `红线是**定时包永不包含它**（见 lib/schedule.js 的 sanitizeScheduledModules）。`,
);
