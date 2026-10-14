/**
 * Client half of dsh-backup-sync.
 *
 * This file is NOT bundled by a build step — it is loaded verbatim by the Host
 * as a classic script and only REGISTERS a factory with the client module
 * system. Every module-body side effect lives inside the factory closure and
 * runs at materialization, never at script execution.
 *
 * Contract reference: docs/notes/module-loader-contract.md
 *   - `id` must be exactly the package name (= the boot entry id), or the
 *     loader reports `loaded without registering "<id>"`.
 *   - `require` resolves only against the 9 platform seed words plus
 *     already-registered boot modules. `react` is a seed word.
 *   - No JSX (there is no bundler on this machine): React.createElement only.
 *   - `inject` lists Cordis SERVICE names (a hard gate). Only `slots` is
 *     needed; every other service is resolved lazily through `ctx.get()`.
 *
 * Data comes from the Host over relative `/api/dsh-backup-sync/...` requests.
 * No cookie handling is needed: in Electron the `dsh-app://` protocol handler
 * forwards every renderer request to the local Host and injects the auth
 * cookie itself; in the browser variant the page is same-origin.
 *
 * Structure of this file:
 *   1. constants            2. pure helpers (unit-tested via __internals)
 *   3. stylesheet           4. small presentational components
 *   5. tab renderers        6. renderPanel (pure)
 *   7. BackupSyncSection (hooks + fetch)   8. exports
 */
window.__ModuleLoader__.load({
  id: 'dsh-backup-sync',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // ─────────────────────────────────────────────────────────── 1. 常量

    /**
     * `settings.section` 的 id。左栏按 order 排序、按 id 选中，
     * 外壳把 `{ close }` 传进来（本面板不需要，弹窗用不着顺手关设置）。
     */
    const PANEL_ID = 'backup-sync';

    /** 显示名：设置左栏那一行 + 分区标题。 */
    const PANEL_LABEL = '备份同步';

    /** Host routes. Every path must stay under `/api/`. */
    const API = '/api/dsh-backup-sync';

    /** Module ids this panel reports on, in display order. */
    const MODULE_ROWS = [
      { id: 'skills', label: '技能', note: '~/.agents/skills', countKind: 'dir' },
      { id: 'plugins', label: '插件', note: 'profile 依赖清单（package.json / lock / .npmrc）', countKind: 'file' },
      { id: 'config', label: '配置', note: 'cordis.patch.yml / AGENTS.md', countKind: 'file' },
      { id: 'memory', label: '记忆', note: 'MEMORY / USER / daily / projects', countKind: 'file' },
      { id: 'todo', label: '待办', note: 'daily / projects / 全局轨', countKind: 'entry' },
      { id: 'sessions', label: '对话', note: '会话记录，体积大且含工作内容', countKind: 'dir', localOnly: true },
    ];

    /** Modules checked before the Host reports its own defaults. */
    const DEFAULT_SELECTED = MODULE_ROWS.filter((r) => r.localOnly !== true).map((r) => r.id);

    const TABS = [
      { id: 'backup', label: '备份' },
      { id: 'history', label: '历史版本' },
      { id: 'import', label: '导入' },
      { id: 'sync', label: '同步' },
    ];

    const COUNT_UNIT = { entry: '条', dir: '个', file: '个' };

    const COUNT_ROWS = [
      { key: 'import', label: '导入', tone: 'good' },
      { key: 'keep', label: '保留本地', tone: 'muted' },
      { key: 'delete', label: '删除本地', tone: 'warn' },
      { key: 'same', label: '无变化', tone: 'muted' },
      { key: 'skip', label: '跳过', tone: 'muted' },
      { key: 'conflict', label: '待裁决', tone: 'bad' },
    ];

    const ACTION_META = {
      import: { label: '导入', tone: 'good' },
      keep: { label: '保留本地', tone: 'muted' },
      delete: { label: '删除本地', tone: 'warn' },
      conflict: { label: '待裁决', tone: 'bad' },
      same: { label: '无变化', tone: 'muted' },
      skip: { label: '跳过', tone: 'muted' },
    };

    /** How many file rows to render per module before collapsing the rest. */
    const FILE_ROWS_LIMIT = 200;

    /** 定时备份的频率方式。文案与宿主的 `describeSchedule` 对齐。 */
    const SCHEDULE_MODES = [
      { id: 'daily', label: '每天' },
      { id: 'interval', label: '每隔' },
    ];

    /** 「每隔」可选的小时数（覆盖「一天内多次」到「每三天一次」）。 */
    const SCHEDULE_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72];

    /** 保留份数：0 = 不清理（绝不默认删用户的包）。 */
    const SCHEDULE_KEEP = [0, 1, 3, 5, 7, 14, 30];

    /**
     * 定时设置的兜底表单。
     *
     * 宿主的 `/state` 一定会带 `settings.schedule`（DEFAULT_SETTINGS 里有），
     * 但如果插件刚升级、宿主还没重启，这里就取不到 —— 那时候显示一个可用的
     * 默认表单，比永远卡在「正在读取…」诚实：用户至少能看见功能在哪，
     * 保存失败也会照实报错。
     */
    const DEFAULT_SCHEDULE_FORM = {
      enabled: false,
      mode: 'daily',
      at: '03:00',
      hours: 24,
      keep: 7,
      moduleIds: null,
      includeBaseline: true,
    };

    /**
     * 单击/双击分流器。
     *
     * 浏览器在双击时**先发两次 click**，如果单击立刻开弹窗，
     * 用户每复制一次技能名就要多关一次弹窗。所以单击延迟一小段再执行，
     * 期间来了第二次点击就取消它（那次走 dblclick）。
     *
     * 定时器从参数注入，测试里传假实现就能同步验证，不用等真实时间。
     */
    function clickGate(delayMs, timers) {
      let timer = null;
      const set = (timers && timers.setTimeout) || ((fn, ms) => setTimeout(fn, ms));
      const clear = (timers && timers.clearTimeout) || ((id) => clearTimeout(id));
      return {
        click(onSingle) {
          if (timer !== null) {
            // 第二次点击：这是双击的前半段，取消待执行的单击。
            clear(timer);
            timer = null;
            return;
          }
          timer = set(() => {
            timer = null;
            onSingle();
          }, delayMs);
        },
        dblclick() {
          if (timer !== null) {
            clear(timer);
            timer = null;
          }
        },
        pending() {
          return timer !== null;
        },
      };
    }

    // ───────────────────────────────────────────── 2. 纯函数（可离线测）

    /** Byte formatting. Must agree with the Host's `human()` so numbers match. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    function countUnit(countKind) {
      return COUNT_UNIT[countKind] ?? '项';
    }

    /** `12 个` / `— 条` while the Host has not answered yet. */
    function formatCount(count, countKind) {
      if (typeof count !== 'number' || !Number.isFinite(count)) return `— ${countUnit(countKind)}`;
      return `${count} ${countUnit(countKind)}`;
    }

    /** `sha256:ab12…` → `ab12…` for compact side-by-side display. */
    function shortHash(sha) {
      if (typeof sha !== 'string' || sha === '') return '—';
      return sha.slice(0, 12);
    }

    /**
     * Join a *hint* path (placeholder / example) with the separator the Host
     * actually uses. The Host may be Windows (`C:\…`) or Linux (`/home/…`), and
     * this file is served to both: a hardcoded `\` renders a path the Linux user
     * cannot paste back, and vice versa. A bare `name` with no dir stays bare.
     */
    function joinHint(dir, name) {
      const base = String(dir ?? '').trim().replace(/[\\/]+$/, '');
      if (base === '') return name;
      return base + (base.includes('\\') && !base.includes('/') ? '\\' : '/') + name;
    }

    /**
     * The six module rows. Before the Host answers we still render the full
     * grid from MODULE_ROWS so the panel never looks broken; counts show `—`.
     */
    function fallbackModules() {
      return MODULE_ROWS.map((r) => ({
        id: r.id,
        label: r.label,
        note: r.note,
        countKind: r.countKind,
        count: null,
        files: null,
        bytes: null,
        bytesHuman: '—',
        exists: false,
        entries: [],
        localOnly: r.localOnly === true,
        pending: true,
      }));
    }

    /** Merge the Host's scan rows onto our display order. */
    function moduleRows(state) {
      const byId = {};
      for (const m of state?.scan?.modules ?? []) byId[m.id] = m;
      return MODULE_ROWS.map((r) => {
        const m = byId[r.id];
        if (m === undefined) {
          return {
            id: r.id,
            label: r.label,
            note: r.note,
            countKind: r.countKind,
            count: null,
            files: null,
            bytes: null,
            bytesHuman: '—',
            exists: false,
            entries: [],
            localOnly: r.localOnly === true,
            pending: true,
          };
        }
        return {
          id: r.id,
          label: r.label,
          note: r.note,
          countKind: m.countKind ?? r.countKind,
          count: m.count,
          files: m.files,
          bytes: m.bytes,
          bytesHuman: m.bytesHuman ?? formatBytes(m.bytes),
          exists: m.exists === true,
          entries: m.entries ?? [],
          localOnly: r.localOnly === true,
          pending: false,
        };
      });
    }

    /** `ui.selected` wins; otherwise the Host defaults; otherwise our own. */
    function effectiveSelection(ui) {
      if (Array.isArray(ui.selected)) return ui.selected;
      const fromHost = ui.state?.defaults?.moduleIds;
      if (Array.isArray(fromHost)) return fromHost;
      return DEFAULT_SELECTED;
    }

    /**
     * 请求里该带哪个备份目录：输入框有内容就带上，空的就不带（让宿主用它的设置/默认值）。
     *
     * 抽出来是因为以前这段表达式在四个 action 里各写了一遍，结果「历史版本」的
     * 刷新按钮漏了 —— 它调 `load()` 不带目录，于是刚备份完切过去看是空的。
     */
    function requestOutDir(ui) {
      const typed = typeof ui?.outDir === 'string' ? ui.outDir.trim() : '';
      return typed === '' ? undefined : typed;
    }

    function toggleSelection(list, id) {
      return list.includes(id) ? list.filter((x) => x !== id) : list.concat([id]);
    }

    /** What the confirmation dialog and the summary bar both show. */
    function computeSelectionSummary(modules, selected) {
      const picked = [];
      let files = 0;
      let bytes = 0;
      let entries = 0;
      let unknown = 0;
      for (const m of modules) {
        if (!selected.includes(m.id)) continue;
        picked.push(m.id);
        if (typeof m.files !== 'number') {
          unknown += 1;
          continue;
        }
        files += m.files;
        bytes += m.bytes ?? 0;
        entries += m.count ?? 0;
      }
      return {
        moduleIds: picked,
        modules: picked.length,
        files,
        bytes,
        bytesHuman: formatBytes(bytes),
        entries,
        unknown,
      };
    }

    function countRows(counts) {
      return COUNT_ROWS.map((r) => ({ ...r, value: counts?.[r.key] ?? 0 }));
    }

    /** One-line summary of a diff/apply result, mirroring the Host's wording. */
    function describeCounts(counts, keys) {
      const order = keys ?? COUNT_ROWS.map((r) => r.key);
      const parts = [];
      for (const key of order) {
        const value = counts?.[key] ?? 0;
        if (value === 0) continue;
        const meta = COUNT_ROWS.find((r) => r.key === key) ?? ACTION_META[key];
        parts.push(`${meta?.label ?? key} ${value}`);
      }
      return parts.length > 0 ? parts.join(' · ') : '没有任何差异';
    }

    /**
     * 校验结果的补充说明行。
     *
     * 为什么需要：宿主的 `ok` 由**两个独立判据**合成 —— 边车 `.sha256` 对不对、
     * 逐文件重算哈希对不对。只报「不符 N 个」时，若失败原因是**边车不符而文件全对**，
     * 界面就会出现「红色提示 + 不符 0 个」这种自相矛盾的画面（真机踩过）。
     * 这里把两个判据分别说清楚，并在两者都解释不了时如实说明。
     */
    function verifyDetailLines(v) {
      const out = [];
      const bad = v?.bad ?? [];
      const sidecar = v?.sidecar;
      if (sidecar !== null && typeof sidecar === 'object' && sidecar.ok === false) {
        out.push(`边车 sha256 不符：期望 ${shortHash(sidecar.expected)}，实得 ${shortHash(sidecar.actual)}`);
      }
      if (v?.ok === false && bad.length === 0 && sidecar?.ok !== false) {
        out.push('逐文件哈希全部相符，却仍判为未通过 —— 请把这份结果反馈给开发者。');
      }
      return out;
    }

    /**
     * Conflict adjudication state. Deliberately starts EMPTY (nothing chosen):
     * the Host treats an absent resolution as 「保留本地（安全默认）」 and reports
     * it back in `conflictsUnresolved`, so clicking through without deciding can
     * never overwrite the user's own edits.
     */
    function emptyResolutions() {
      return {};
    }

    function setAllResolutions(conflicts, choice) {
      const out = {};
      for (const c of conflicts) out[c.key] = choice;
      return out;
    }

    function unresolvedCount(conflicts, resolutions) {
      let n = 0;
      for (const c of conflicts) if (resolutions[c.key] === undefined) n += 1;
      return n;
    }

    /** Group a plan's actions for the detail list, most interesting first. */
    function groupActions(actions) {
      const order = ['conflict', 'import', 'delete', 'keep', 'skip', 'same'];
      const groups = [];
      for (const action of order) {
        const items = (actions ?? []).filter((a) => a.action === action);
        if (items.length === 0) continue;
        groups.push({ action, label: ACTION_META[action]?.label ?? action, items });
      }
      return groups;
    }

    /** A short, human label for the archive currently being imported. */
    function archiveLabel(archive) {
      if (archive === null || archive === undefined) return '（未选择）';
      const when = archive.createdAtLocal ?? '时间未知';
      return `${archive.name} · ${when}`;
    }

    /**
     * 时间戳 → 本地 `YYYY-MM-DD HH:mm`。
     *
     * 不用 `toLocaleString`：它的输出随系统区域设置变，同一个界面在两台机器上
     * 会显示成不同样子，截图对比和断言都会飘。备份这种要跨机器核对的功能，
     * 固定格式比"本地化"重要。
     */
    function formatWhen(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 定时设置的摘要文案，例如 `每天 03:00 · 保留 7 份`。 */
    function scheduleSummary(schedule) {
      if (schedule === null || schedule === undefined) return '未配置';
      const keep = Number(schedule.keep);
      const tail = !Number.isFinite(keep) || keep <= 0 ? '不清理旧包' : `保留 ${keep} 份`;
      if (schedule.enabled !== true) return `已关闭 · ${tail}`;
      if (schedule.mode === 'interval') {
        const hours = Number(schedule.hours);
        const every = !Number.isFinite(hours) || hours <= 0 ? '—' : hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
        return `每隔 ${every} · ${tail}`;
      }
      return `每天 ${schedule.at ?? '—'} · ${tail}`;
    }

    /**
     * 「现在为什么不跑 / 什么时候跑」。
     *
     * 宿主只给一个机器可读的 `reason`，翻译成人话是界面的责任 ——
     * 直接显示 `missed` 这种词，用户只会以为坏了。
     */
    function scheduleReasonText(view) {
      if (view === null || view === undefined) return '';
      if (view.due === true) return '已到点，等待下一次心跳（最长 1 分钟）';
      switch (view.reason) {
        case 'disabled':
          return '定时备份已关闭';
        case 'not-yet':
          return '还没到点';
        case 'already-ran':
          return '这一次已经跑过了';
        case 'anchored':
          return '刚开启，正在重新计时';
        case 'missed':
          return '上一次的时间点已经错过（当时 DSH 没开），已跳过，不补跑';
        case 'busy':
          return '上一次还在跑';
        case 'failed':
          return '上一次失败了';
        default:
          return view.reason ?? '';
      }
    }

    /** 定时备份卡片上的「上次运行」一行。 */
    function scheduleLastText(view) {
      const state = view?.state ?? {};
      if (typeof state.lastError === 'string' && state.lastError !== '') return `上次失败：${state.lastError}`;
      if (state.lastRunAt === null || state.lastRunAt === undefined) return '还没跑过';
      const name = state.lastArchive ?? '（包名未记录）';
      const files = state.lastResult?.totals?.files;
      const size = state.lastResult?.bytesHuman;
      const bits = [name];
      if (typeof files === 'number') bits.push(`${files} 个文件`);
      if (typeof size === 'string' && size !== '') bits.push(size);
      return `${formatWhen(state.lastRunAt)} · ${bits.join(' · ')}`;
    }

    /**
     * 定时备份到底会打包哪些模块。
     *
     * `moduleIds === null` 时宿主用的是**各模块的默认勾选**（技能/插件/配置/记忆/待办），
     * 不是上面手动列表里当前的勾选状态 —— 界面上必须照实说，否则用户以为
     * 「我取消勾了对话，定时就不会带对话」，而他其实根本没影响定时那一路。
     */
    function scheduleScopeText(form) {
      const ids = Array.isArray(form?.moduleIds) ? form.moduleIds : null;
      if (ids === null) return '技能、插件、配置、记忆、待办（各模块的默认勾选）';
      if (ids.length === 0) return '一个模块都没选 —— 到点会直接跳过，不打包';
      return ids.map((id) => MODULE_ROWS.find((m) => m.id === id)?.label ?? id).join('、');
    }

    /** 技能行：没有描述时不要留空白，明说没有。 */
    function skillTooltip(skill) {
      const d = skill?.description;
      if (typeof d === 'string' && d.trim() !== '') return d.trim();
      return '（这个技能没有写描述）';
    }

    /**
     * 定时备份：只挑出**真的改了**的字段。
     *
     * ★ 为什么要挑：宿主用「body 里有没有出现计时键（enabled/mode/at/hours）」来决定
     * 要不要把计时起点重置到现在。整表单照发的话，用户只改「保留 7 份 → 3 份」也会被
     * 当成改了频率，下一次运行被白白推迟一个周期 —— 那条设计规则（改保留份数不动锚点）
     * 就成了一句写在宿主里、永远走不到的死代码。
     * 2026-10-14 的验收断言（step15 ④b）真机上就是这么红的：锚点从具体时间被推回了 null。
     */
    function schedulePatch(saved, form) {
      const before = saved ?? {};
      const keys = ['enabled', 'mode', 'at', 'hours', 'keep', 'moduleIds', 'includeBaseline'];
      /** @type {Record<string, unknown>} */
      const body = {};
      for (const key of keys) {
        const a = key === 'moduleIds' && Array.isArray(before[key]) ? JSON.stringify(before[key]) : before[key];
        const b = key === 'moduleIds' && Array.isArray(form[key]) ? JSON.stringify(form[key]) : form[key];
        // 缺省值口径：includeBaseline 缺省为 true，其余缺省为 false/null —— 与 normalizeSchedule 一致。
        const av = key === 'includeBaseline' && a === undefined ? true : a;
        const bv = key === 'includeBaseline' && b === undefined ? true : b;
        if (av !== bv) body[key] = form[key];
      }
      return body;
    }

    /** 技能行的体积/文件数摘要。 */
    function skillMeta(skill) {
      const files = Number(skill?.files);
      const n = Number.isFinite(files) ? files : 0;
      const bytes = typeof skill?.bytesHuman === 'string' && skill.bytesHuman !== '' ? skill.bytesHuman : formatBytes(skill?.bytes);
      return `${n} 个文件 · ${bytes}`;
    }

    /** 技能行缺 SKILL.md 时的徽标文案（null = 不显示）。 */
    function skillMissingBadge(skill) {
      return skill?.hasSkillMd === false ? '缺 SKILL.md' : null;
    }

    /**
     * 复制结果的提示行。`what` 是被复制的东西的名字（「技能名」「文件内容」）。
     *
     * 三个失败分支要分开说：空内容、剪贴板被拒、走了兜底通道。
     * 一律说「复制失败」用户不知道该干什么。
     */
    function copyLine(entry, what) {
      if (entry === null || entry === undefined) return null;
      if (entry.ok !== true) {
        const why = entry.how === 'empty' ? '内容为空，没什么可复制的' : '浏览器拒绝了剪贴板写入';
        return { tone: 'bad', text: `${why}。可以手动选中后按 Ctrl+C。` };
      }
      const via = entry.how === 'execCommand' ? '（走的是兜底通道）' : '';
      return { tone: 'good', text: `已复制${what}：${entry.label ?? ''}${via}` };
    }

    /** 文件行的展示名：技能模块带出技能目录，其它模块直接给相对路径。 */
    function fileRowLabel(entry) {
      const rel = entry?.relPath ?? '';
      return rel === '' ? '（路径未知）' : rel;
    }

    /**
     * 某个技能目录下的文件。
     *
     * 从首屏 `scan` 里筛，不再为弹窗多跑一次扫描 —— 同一份数据在两处显示，
     * 数字必须来自同一个快照，否则用户会看到「卡片说 3 个、弹窗说 4 个」。
     * 技能的 `id` 就是它相对技能库的第一段目录名。
     */
    function skillFiles(ui, skill) {
      const mod = (ui?.state?.scan?.modules ?? []).find((m) => m.id === 'skills');
      const entries = mod?.entries ?? [];
      const id = skill?.id;
      if (typeof id !== 'string' || id === '') return entries;
      const prefix = `${id}/`;
      return entries.filter((e) => typeof e?.relPath === 'string' && e.relPath.startsWith(prefix));
    }

    /** 弹窗里显示的文件大小。 */
    function fileSizeText(view) {
      if (view === null || view === undefined) return '—';
      if (typeof view.bytes !== 'number' || !Number.isFinite(view.bytes)) return '—';
      return `${formatBytes(view.bytes)}（${view.bytes} 字节）`;
    }

    // ────────────────────────────────────────────────────────── 3. 样式

    const PANEL_CSS = `
/* 面板挂在「设置」里的一个分区上（不是中栏面板）：
   设置弹窗固定 800px 宽、左栏 188px、分区左右各 24px 内边距 → 内容宽 564px。
   外壳的 .options 已经是 flex:1 + overflow-y:auto，所以这里**不能**再写
   height:100% / overflow-y:auto，否则会套出第二层滚动条、底部还会被截掉。 */
.dbs-root{--dbs-line:rgba(128,128,128,.28);--dbs-accent:#4c8dff;
  box-sizing:border-box;padding:0 0 8px;font-size:13px;line-height:1.6;
  color:var(--dbs-text,inherit)}
.dbs-h2{margin:0 0 2px;font-size:16px;font-weight:600}
.dbs-sub{margin:0 0 14px;font-size:12px;opacity:.65}
.dbs-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dbs-line);margin-bottom:16px}
.dbs-tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;padding:7px 13px;
  font:inherit;font-size:13px;color:inherit;opacity:.62;cursor:pointer}
.dbs-tab:hover{opacity:.9}
.dbs-tab[data-on="1"]{opacity:1;font-weight:600;border-bottom-color:var(--dbs-accent)}
.dbs-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;justify-content:space-between;
  border:1px solid var(--dbs-line);border-radius:8px;padding:9px 12px;margin-bottom:12px}
/* 汇总条：文字占满左侧，按钮靠右并排（有两个按钮，不能靠 space-between 撑开） */
.dbs-bar-text{font-size:12.5px;flex:1;min-width:180px}
/* 模块卡**一列到底**（2026-10-15 用户实测后要求）。
   分区内容宽只有 559px，两列时每列约 268px，「profile 依赖清单（package.json / lock /
   .npmrc）」这类说明会被折断成 .npmr 与 c 两行；一列让每张卡独占整行。
   注意：这段 CSS 在 JS 模板字符串里，注释中**不能出现反引号**（会截断字符串）。
   一列与宽度无关，所以折行逻辑、容器查询、container-type 全部撤掉 ——
   留着 container-type 只会白送一个 contain:layout 陷阱（见设计文档 §11.12）。 */
.dbs-grid{display:grid;grid-template-columns:1fr;gap:10px}
.dbs-card{border:1px solid var(--dbs-line);border-radius:8px;padding:10px 12px}
.dbs-card[data-on="1"]{border-color:var(--dbs-accent);box-shadow:0 0 0 1px var(--dbs-accent) inset}
.dbs-card[data-off="1"]{background:rgba(128,128,128,.07)}
.dbs-card-head{display:flex;align-items:center;gap:8px}
.dbs-card-head label{display:flex;align-items:center;gap:7px;cursor:pointer;font-weight:600;flex:1;min-width:0}
.dbs-card-count{font-size:12px;opacity:.62;white-space:nowrap}
.dbs-card-note{margin-top:4px;font-size:12px;opacity:.6;word-break:break-all}
.dbs-card-meta{margin-top:4px;font-size:12px;opacity:.72}
.dbs-badge{display:inline-block;margin-top:6px;padding:1px 6px;border-radius:4px;font-size:11px;
  border:1px solid var(--dbs-line);opacity:.78}
.dbs-badge[data-tone="warn"]{border-color:#c9a227;color:#c9a227;opacity:1}
.dbs-badge[data-tone="good"]{border-color:#3f9e5a;color:#3f9e5a;opacity:1}
.dbs-badge[data-tone="bad"]{border-color:#d05050;color:#d05050;opacity:1}
.dbs-btn{appearance:none;font:inherit;font-size:12.5px;padding:5px 12px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dbs-line);background:transparent;color:inherit}
.dbs-btn:hover:not(:disabled){border-color:var(--dbs-accent);color:var(--dbs-accent)}
.dbs-btn:disabled{opacity:.45;cursor:default}
.dbs-btn[data-kind="primary"]{background:var(--dbs-accent);border-color:var(--dbs-accent);color:#fff}
.dbs-btn[data-kind="primary"]:hover:not(:disabled){opacity:.88;color:#fff}
.dbs-btn[data-kind="danger"]{border-color:#d05050;color:#d05050}
.dbs-btn[data-size="sm"]{padding:2px 8px;font-size:11.5px;border-radius:5px}
.dbs-creds{margin:6px 0 0;padding-left:18px;font-size:12px;word-break:break-all}
.dbs-creds li{margin:2px 0}
.dbs-link{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:12px;color:inherit;
  opacity:.7;cursor:pointer;text-decoration:underline}
.dbs-link:hover{opacity:1;color:var(--dbs-accent)}
.dbs-field{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}
.dbs-field label{font-size:12.5px;opacity:.75;min-width:74px}
.dbs-input{font:inherit;font-size:12.5px;padding:5px 9px;border-radius:6px;min-width:280px;flex:1;
  border:1px solid var(--dbs-line);background:transparent;color:inherit}
.dbs-input:focus{outline:none;border-color:var(--dbs-accent)}
.dbs-select{font:inherit;font-size:12.5px;padding:5px 9px;border-radius:6px;flex:1;min-width:280px;
  border:1px solid var(--dbs-line);background:transparent;color:inherit}
.dbs-check{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer}
.dbs-note{font-size:12px;opacity:.62;margin:8px 0}
.dbs-notice{border:1px solid var(--dbs-line);border-left-width:3px;border-radius:6px;padding:8px 11px;
  margin:10px 0;font-size:12.5px}
.dbs-notice[data-tone="warn"]{border-left-color:#c9a227}
.dbs-notice[data-tone="bad"]{border-left-color:#d05050}
.dbs-notice[data-tone="good"]{border-left-color:#3f9e5a}
.dbs-notice ul{margin:4px 0 0;padding-left:18px}
.dbs-counts{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;margin:12px 0}
.dbs-count{border:1px solid var(--dbs-line);border-radius:6px;padding:7px 9px}
.dbs-count b{display:block;font-size:17px;font-weight:600;line-height:1.25}
.dbs-count span{font-size:11.5px;opacity:.66}
.dbs-count[data-tone="good"] b{color:#3f9e5a}
.dbs-count[data-tone="warn"] b{color:#c9a227}
.dbs-count[data-tone="bad"] b{color:#d05050}
.dbs-rows{border:1px solid var(--dbs-line);border-radius:8px;overflow:hidden}
.dbs-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 11px;font-size:12.5px;
  border-top:1px solid var(--dbs-line)}
.dbs-row:first-child{border-top:0}
.dbs-row-main{flex:1;min-width:180px;word-break:break-all}
.dbs-row-meta{font-size:11.5px;opacity:.62;white-space:nowrap}
.dbs-conflict{border:1px solid #d05050;border-radius:6px;padding:9px 11px;margin:8px 0}
.dbs-conflict-head{font-size:12.5px;word-break:break-all;margin-bottom:6px}
.dbs-conflict-hashes{font-size:11.5px;opacity:.62;margin-bottom:7px;font-family:ui-monospace,Consolas,monospace}
.dbs-choices{display:flex;gap:14px;flex-wrap:wrap}
.dbs-detail{margin-top:8px}
.dbs-detail summary{cursor:pointer;font-size:12.5px;opacity:.75}
.dbs-files{margin:6px 0 0;padding-left:0;list-style:none;max-height:220px;overflow-y:auto;
  border:1px solid var(--dbs-line);border-radius:6px}
.dbs-files li{display:flex;justify-content:space-between;gap:10px;padding:3px 9px;font-size:11.5px;
  font-family:ui-monospace,Consolas,monospace;border-top:1px solid var(--dbs-line)}
.dbs-files li:first-child{border-top:0}
.dbs-files li span:first-child{word-break:break-all}
.dbs-files li span:last-child{opacity:.6;white-space:nowrap}
.dbs-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all}
.dbs-overlay{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;
  justify-content:center;z-index:60;padding:24px}
.dbs-dialog{background:var(--dbs-surface,Canvas);color:var(--dbs-text,CanvasText);
  color-scheme:light dark;
  border:1px solid var(--dbs-line);border-radius:10px;padding:16px 18px;max-width:520px;width:100%;
  max-height:80vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.4)}
.dbs-dialog h3{margin:0 0 8px;font-size:14px;font-weight:600}
.dbs-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.dbs-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12.5px;margin:8px 0}
.dbs-kv dt{opacity:.62}
.dbs-kv dd{margin:0;word-break:break-all}
.dbs-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dbs-line);
  border-top-color:var(--dbs-accent);border-radius:50%;animation:dbs-spin .7s linear infinite;
  vertical-align:-1px;margin-right:6px}
@keyframes dbs-spin{to{transform:rotate(360deg)}}

/* ── 可点击的文件行：整行是个按钮，点开看内容 ── */
.dbs-files li[data-clickable="1"]{cursor:pointer}
.dbs-files li[data-clickable="1"]:hover{background:rgba(128,128,128,.12)}
.dbs-files li[data-clickable="1"]:hover span:first-child{color:var(--dbs-accent)}

/* ── 技能清单：一行一个技能 ── */
.dbs-skills{margin:6px 0 0;padding:0;list-style:none;border:1px solid var(--dbs-line);border-radius:6px;
  max-height:260px;overflow-y:auto}
.dbs-skill{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 9px;
  border-top:1px solid var(--dbs-line);cursor:pointer;font-size:12px}
.dbs-skill:first-child{border-top:0}
.dbs-skill:hover{background:rgba(128,128,128,.12)}
.dbs-skill-name{font-weight:600;word-break:break-all;flex:1;min-width:120px}
.dbs-skill:hover .dbs-skill-name{color:var(--dbs-accent)}
.dbs-skill-meta{font-size:11.5px;opacity:.62;white-space:nowrap}
.dbs-skill-hint{font-size:11.5px;opacity:.5;margin:5px 0 0}
.dbs-skill-badge{padding:0 5px;border-radius:4px;font-size:10.5px;border:1px solid #c9a227;color:#c9a227}

/* ── 定时备份卡片 ── */
.dbs-sched{border:1px solid var(--dbs-line);border-radius:8px;padding:10px 12px;margin-top:12px}
.dbs-sched-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.dbs-sched-head label{display:flex;align-items:center;gap:7px;cursor:pointer;font-weight:600;font-size:13px}
.dbs-sched-head .dbs-sched-sum{margin-left:auto;font-size:12px;opacity:.66}
.dbs-sched-body{margin-top:9px;padding-top:9px;border-top:1px solid var(--dbs-line)}
.dbs-sched-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0}
.dbs-sched-inline label{font-size:12.5px;opacity:.75}
.dbs-sched-inline .dbs-select{flex:0 0 auto;min-width:0}
.dbs-sched-inline .dbs-input{flex:0 0 auto;min-width:0;width:118px}
.dbs-sched-state{margin-top:9px;font-size:12.5px}
.dbs-sched-state b{font-weight:600}

/* ── 文件内容弹窗 ── */
.dbs-pre{margin:8px 0 0;padding:9px 11px;border:1px solid var(--dbs-line);border-radius:6px;
  background:rgba(128,128,128,.08);font-family:ui-monospace,Consolas,monospace;font-size:11.5px;
  line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:46vh;overflow:auto}
.dbs-dialog[data-wide="1"]{max-width:760px}
.dbs-dialog-actions{flex-wrap:wrap}
.dbs-dialog-actions .dbs-note{margin:0;flex:1;min-width:160px;text-align:left;align-self:center}
`;

    const STYLE_ID = 'dsh-backup-sync-styles';

    /**
     * Resolve the application's actual surface / text colours and publish them as
     * `--dbs-surface` / `--dbs-text`.
     *
     * The app defines essentially **no** theme CSS variables (verified on
     * 0.2.0-rc.2: the only `--dsh*` variable anywhere is
     * `--dsh-onboarding-border-angle`), so `var(--dsh-surface, <fallback>)` would
     * always take the fallback. A hard-coded dark fallback made the confirm
     * dialog dark-on-dark and effectively unreadable in the light theme.
     *
     * Reading the computed colours off `document.body` adapts to whatever theme
     * is actually in use; the CSS keeps `Canvas` / `CanvasText` as a last resort
     * so the dialog can never end up transparent-on-transparent.
     */
    function syncTheme() {
      if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return;
      const body = document.body;
      const root = document.documentElement;
      if (body === null || body === undefined || root === null || root === undefined || root.style === null) return;
      const cs = getComputedStyle(body);
      const opaque = (c) => typeof c === 'string' && c !== '' && c !== 'transparent' && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(c);
      if (opaque(cs.backgroundColor)) root.style.setProperty('--dbs-surface', cs.backgroundColor);
      if (opaque(cs.color)) root.style.setProperty('--dbs-text', cs.color);
    }

    /** Inject the stylesheet once, from apply() — never at module-body level. */
    function ensureStyles() {
      syncTheme();
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = PANEL_CSS;
      document.head.appendChild(el);
    }

    // ──────────────────────────────────────────────── 4. 小组件

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dbs-btn',
          'data-kind': props.kind ?? 'plain',
          'data-size': props.size ?? 'md',
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    function Badge(props) {
      return h('span', { className: 'dbs-badge', 'data-tone': props.tone ?? 'plain' }, props.children);
    }

    function Notice(props) {
      return h(
        'div',
        { className: 'dbs-notice', 'data-tone': props.tone ?? 'plain' },
        props.title !== undefined ? h('b', null, props.title) : null,
        props.children,
      );
    }

    function CountGrid(props) {
      const rows = countRows(props.counts).filter((r) => props.showZero === true || r.value > 0);
      if (rows.length === 0) return h('p', { className: 'dbs-note' }, '没有任何差异。');
      return h(
        'div',
        { className: 'dbs-counts' },
        ...rows.map((r) =>
          h(
            'div',
            { key: r.key, className: 'dbs-count', 'data-tone': r.tone },
            h('b', null, String(r.value)),
            h('span', null, r.label),
          ),
        ),
      );
    }

    function KeyValues(props) {
      const pairs = (props.pairs ?? []).filter((p) => p !== null && p !== undefined && p[1] !== null && p[1] !== undefined);
      if (pairs.length === 0) return null;
      return h(
        'dl',
        { className: 'dbs-kv' },
        ...pairs.flatMap(([k, v]) => [h('dt', { key: `k-${k}` }, k), h('dd', { key: `v-${k}` }, v)]),
      );
    }

    /**
     * 文件清单。`onOpen(entry)` 给了就把每一行变成可点的按钮。
     *
     * 行本身是 `<li>` 而不是 `<button>`：清单在窄卡片里，用 li + role/tabIndex
     * 能保住「一行一个文件」的排版，同时仍然可点、可聚焦、可键盘触发。
     */
    function FileList(props) {
      const entries = props.entries ?? [];
      if (entries.length === 0) return h('p', { className: 'dbs-note' }, '没有文件。');
      const shown = entries.slice(0, FILE_ROWS_LIMIT);
      const clickable = typeof props.onOpen === 'function';
      return h(
        'div',
        null,
        h(
          'ul',
          { className: 'dbs-files' },
          ...shown.map((e, i) =>
            h(
              'li',
              {
                key: `${e.relPath}-${i}`,
                'data-dbs-file': clickable ? '1' : '0',
                'data-clickable': clickable ? '1' : '0',
                role: clickable ? 'button' : undefined,
                tabIndex: clickable ? 0 : undefined,
                title: clickable ? `点击查看内容：${fileRowLabel(e)}` : undefined,
                onClick: clickable ? () => props.onOpen(e) : undefined,
                onKeyDown: clickable
                  ? (ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        props.onOpen(e);
                      }
                    }
                  : undefined,
              },
              h('span', null, fileRowLabel(e)),
              h('span', null, e.sizeHuman ?? formatBytes(e.size)),
            ),
          ),
        ),
        entries.length > shown.length
          ? h('p', { className: 'dbs-note' }, `还有 ${entries.length - shown.length} 个文件未列出。`)
          : null,
      );
    }

    /**
     * 技能清单：一行一个技能。
     *
     * 悬停看描述（`title`）、单击开弹窗、双击复制技能名。文件明细不在这里铺开，
     * 收进弹窗 —— 技能动辄几十个文件，铺开会把卡片撑成一面墙。
     */
    function SkillList(props) {
      const skills = props.skills ?? [];
      if (skills.length === 0) return h('p', { className: 'dbs-note' }, '技能库里还没有技能。');
      const shown = skills.slice(0, FILE_ROWS_LIMIT);
      return h(
        'div',
        null,
        h(
          'ul',
          { className: 'dbs-skills' },
          ...shown.map((s) =>
            h(
              'li',
              {
                key: s.id,
                className: 'dbs-skill',
                'data-dbs-skill': s.id,
                title: skillTooltip(s),
                onClick: () => props.onOpen(s),
                onDoubleClick: () => props.onCopyName(s),
              },
              h('span', { className: 'dbs-skill-name' }, s.name ?? s.id),
              h('span', { className: 'dbs-skill-meta' }, skillMeta(s)),
              skillMissingBadge(s) !== null ? h('span', { className: 'dbs-skill-badge' }, skillMissingBadge(s)) : null,
            ),
          ),
        ),
        h(
          'p',
          { className: 'dbs-skill-hint' },
          '悬停看描述 · 单击查看详情 · 双击复制技能名',
        ),
        shown.length < skills.length
          ? h('p', { className: 'dbs-note' }, `还有 ${skills.length - shown.length} 个技能未列出。`)
          : null,
      );
    }

    function Overlay(props) {
      return h(
        'div',
        { className: 'dbs-overlay', role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { className: 'dbs-dialog', 'data-wide': props.wide === true ? '1' : '0' },
          h('h3', null, props.title),
          props.children,
          h(
            'div',
            { className: 'dbs-dialog-actions' },
            ...(props.actions ?? []).map((a) =>
              h(Button, { key: a.label, kind: a.kind, onClick: a.onClick, disabled: a.disabled }, a.label),
            ),
          ),
        ),
      );
    }

    /** Full-panel loading / error / busy line. */
    function StatusLine(props) {
      if (props.error !== null && props.error !== undefined && props.error !== '') {
        return h(Notice, { tone: 'bad', title: '出错了：' }, props.error);
      }
      if (props.busy !== null && props.busy !== undefined) {
        return h('p', { className: 'dbs-note' }, h('span', { className: 'dbs-spin' }), props.busy);
      }
      if (props.loading === true) {
        return h('p', { className: 'dbs-note' }, h('span', { className: 'dbs-spin' }), '正在读取本机状态…');
      }
      return null;
    }

    // ───────────────────────────────────────────── 5. 页签渲染器

    /** 备份 */
    /**
     * 把「冲突裁决」折算进计数。
     *
     * 宿主给的 `counts` 是**裁决前**的原始差异（冲突单列一项），所以直接拿它显示
     * 会自相矛盾：用户点了「全部采用归档」，界面还写着「待裁决 1 · 导入 0」，
     * 二次确认甚至说「没有任何差异」—— 而实际上会写 1 个文件（真机实测踩到）。
     * 裁决是本地状态，必须在这里折算，界面数字才会跟着动。
     *
     * 折算规则：
     *   裁决为归档 → 计入「导入」   （这条会覆盖本地）
     *   裁决为本地 → 计入「保留本地」
     *   没裁决     → 仍计入「待裁决」（执行时按保留本地处理，但数字上单独显示）
     */
    function effectiveCounts(preview, resolutions) {
      const counts = { ...(preview?.counts ?? {}) };
      let toArchive = 0;
      let toLocal = 0;
      let unresolved = 0;
      for (const c of preview?.conflicts ?? []) {
        const r = resolutions?.[c.key];
        if (r === 'archive') toArchive += 1;
        else if (r === 'local') toLocal += 1;
        else unresolved += 1;
      }
      counts.import = (counts.import ?? 0) + toArchive;
      counts.keep = (counts.keep ?? 0) + toLocal;
      counts.conflict = unresolved;
      return counts;
    }

    /** 这次导入实际会写盘多少个文件（新增/覆盖 + 删除）。 */
    function effectiveWriteCount(counts) {
      return (counts?.import ?? 0) + (counts?.delete ?? 0);
    }

    /**
     * 技能卡展开后的内容。
     *
     * 清单是**展开时才去取**的：技能页不常看，没必要在每次刷新面板时多跑一次扫描。
     * 三个状态各自说清楚（加载中 / 失败 / 空），不要用一片空白糊过去。
     */
    function renderSkillPanel(ui, actions) {
      if (ui.skillsLoading === true) {
        return h('p', { className: 'dbs-note', 'data-dbs-skills': 'loading' }, h('span', { className: 'dbs-spin' }), '正在读取技能清单…');
      }
      if (ui.skillsError !== null && ui.skillsError !== undefined) {
        return h(
          'div',
          { 'data-dbs-skills': 'error' },
          h(
            Notice,
            { tone: 'warn', title: '技能清单读取失败：' },
            ui.skillsError,
            h('div', { className: 'dbs-note' }, '技能文件本身没受影响，备份时仍会照常打包。'),
          ),
        );
      }
      if (ui.skills === null || ui.skills === undefined) {
        return h('p', { className: 'dbs-note', 'data-dbs-skills': 'idle' }, '展开后才会读取技能清单。');
      }
      const line = copyLine(ui.copyFeed?.skill, '技能名');
      return h(
        'div',
        { 'data-dbs-skills': 'ready' },
        h(SkillList, {
          skills: ui.skills,
          onOpen: (s) => actions.skillClick(s),
          onCopyName: (s) => actions.skillDblClick(s),
        }),
        line !== null
          ? h('div', { 'data-dbs-copyfeed': 'skill' }, h(Notice, { tone: line.tone }, line.text))
          : null,
      );
    }

    /** 定时备份卡片。 */
    function renderScheduleCard(ui, actions) {
      const form =
        ui.sched ?? ui.state?.settings?.schedule ?? (ui.state === null || ui.state === undefined ? null : DEFAULT_SCHEDULE_FORM);
      const view = ui.schedView ?? ui.state?.scheduleView ?? null;
      const busy = ui.busy !== null;

      if (form === null) {
        return h(
          'div',
          { className: 'dbs-sched', 'data-dbs-sched': '1' },
          h('div', { className: 'dbs-sched-head' }, h('b', null, '定时备份'), h('span', { className: 'dbs-sched-sum' }, '正在读取…')),
        );
      }

      const on = form.enabled === true;
      const mode = form.mode === 'interval' ? 'interval' : 'daily';
      const out = [];

      out.push(
        h(
          'div',
          { className: 'dbs-sched-head', key: 'h' },
          h(
            'label',
            null,
            h('input', {
              id: 'dbs-sched-enabled',
              type: 'checkbox',
              checked: on,
              onChange: (e) => actions.setSched({ enabled: e.target.checked }),
            }),
            '定时备份',
          ),
          h('span', { className: 'dbs-sched-sum', 'data-dbs-sched-sum': '1' }, scheduleSummary(form)),
        ),
      );

      if (on) {
        const lines = [];
        lines.push(
          h(
            'div',
            { key: 'next' },
            h('b', null, '下次运行：'),
            view === null || view.nextRunAt === null || view.nextRunAt === undefined
              ? '还没排上（保存后按新设置重新计时）'
              : formatWhen(view.nextRunAt),
          ),
        );
        const reason = scheduleReasonText(view);
        if (reason !== '') lines.push(h('div', { key: 'why', className: 'dbs-note' }, `当前状态：${reason}`));
        lines.push(h('div', { key: 'last', className: 'dbs-note', 'data-dbs-sched-last': '1' }, `上次运行：${scheduleLastText(view)}`));

        out.push(
          h(
            'div',
            { className: 'dbs-sched-body', key: 'b' },
            h(
              'div',
              { className: 'dbs-sched-inline' },
              h('label', { htmlFor: 'dbs-sched-mode' }, '频率'),
              h(
                'select',
                {
                  id: 'dbs-sched-mode',
                  className: 'dbs-select',
                  value: mode,
                  onChange: (e) => actions.setSched({ mode: e.target.value }),
                },
                ...SCHEDULE_MODES.map((m) => h('option', { key: m.id, value: m.id }, m.label)),
              ),
              mode === 'daily'
                ? h('input', {
                    id: 'dbs-sched-at',
                    className: 'dbs-input',
                    type: 'time',
                    value: typeof form.at === 'string' ? form.at : '03:00',
                    onChange: (e) => actions.setSched({ at: e.target.value }),
                  })
                : h(
                    'select',
                    {
                      id: 'dbs-sched-hours',
                      className: 'dbs-select',
                      value: String(form.hours ?? 24),
                      onChange: (e) => actions.setSched({ hours: Number(e.target.value) }),
                    },
                    ...SCHEDULE_HOURS.map((x) => h('option', { key: x, value: String(x) }, `每隔 ${x} 小时`)),
                  ),
            ),
            h(
              'div',
              { className: 'dbs-sched-inline' },
              h('label', { htmlFor: 'dbs-sched-keep' }, '保留旧包'),
              h(
                'select',
                {
                  id: 'dbs-sched-keep',
                  className: 'dbs-select',
                  value: String(form.keep ?? 7),
                  onChange: (e) => actions.setSched({ keep: Number(e.target.value) }),
                },
                ...SCHEDULE_KEEP.map((x) => h('option', { key: x, value: String(x) }, x === 0 ? '不清理' : `保留 ${x} 份`)),
              ),
              h('span', { className: 'dbs-note' }, '只删自己打的包，别人的压缩包一律不碰'),
            ),
            h(
              'div',
              { className: 'dbs-sched-inline' },
              h('label', { htmlFor: 'dbs-sched-pin' }, '备份内容'),
              h(
                'label',
                { className: 'dbs-check' },
                h('input', {
                  id: 'dbs-sched-pin',
                  type: 'checkbox',
                  checked: Array.isArray(form.moduleIds),
                  onChange: (e) => actions.setSched({ moduleIds: e.target.checked ? effectiveSelection(ui) : null }),
                }),
                '固定用上面勾选的模块',
              ),
              h('span', { className: 'dbs-note', 'data-dbs-sched-scope': '1' }, scheduleScopeText(form)),
            ),
            h('div', { className: 'dbs-sched-state', 'data-dbs-sched-state': '1' }, ...lines),
            h(
              'div',
              { className: 'dbs-sched-inline' },
              h(Button, { kind: 'primary', disabled: busy, onClick: actions.saveSchedule }, '保存定时设置'),
              h(Button, { disabled: busy, onClick: actions.runScheduleNow }, '立即跑一次'),
              ui.schedDirty === true
                ? h('span', { className: 'dbs-note', 'data-dbs-sched-dirty': '1' }, '有改动还没保存')
                : null,
            ),
            h(
              'p',
              { className: 'dbs-note' },
              '到点才跑；那一刻 DSH 没开就跳过，不补跑，也不重试。「对话」永远不会进定时包（无人值守，硬闸剔除）。',
            ),
          ),
        );
      } else {
        out.push(
          h(
            'p',
            { className: 'dbs-note', key: 'off' },
            '开启后 DSH 会在后台按点自动打包。备份内容默认是各模块的默认勾选，「对话」永远不会进定时包。',
          ),
        );
        // ★ 关闭态也必须留保存按钮。
        // 曾经这里只有上面那句说明，于是「取消勾选 → 表单连同保存按钮一起消失」，
        // 用户**根本没有办法把「关掉」这件事存下去**（真机驱动 step15 抓到的：
        // 点不到「保存定时设置」，`[data-dbs-sched]` 里一个 button 都没有）。
        // 判据是「草稿和已存的不一样」而不是「开关是不是开着」。
        if (ui.schedDirty === true) {
          out.push(
            h(
              'div',
              { className: 'dbs-sched-inline', key: 'off-actions' },
              h(Button, { kind: 'primary', disabled: busy, onClick: actions.saveSchedule }, '保存定时设置'),
              h('span', { className: 'dbs-note', 'data-dbs-sched-dirty': '1' }, '有改动还没保存'),
            ),
          );
        }
      }

      if (ui.schedRun !== null && ui.schedRun !== undefined) {
        const r = ui.schedRun;
        out.push(
          h(
            'div',
            { key: 'run', 'data-dbs-sched-run': '1' },
            r.ran === true
              ? h(
                  Notice,
                  { tone: 'good', title: '定时备份已执行' },
                  h(KeyValues, {
                    pairs: [
                      ['包名', h('span', { className: 'dbs-mono' }, r.archive?.name ?? '—')],
                      ['大小', r.archive?.bytesHuman ?? '—'],
                      ['文件', `${r.archive?.totals?.files ?? '—'} 个`],
                      ['清理旧包', (r.pruned ?? []).length === 0 ? '没有需要清理的' : `${r.pruned.length} 份`],
                    ],
                  }),
                )
              : h(
                  Notice,
                  { tone: 'warn', title: '这次没有打包：' },
                  r.error ?? scheduleReasonText({ reason: r.reason, due: false }),
                ),
          ),
        );
      }

      return h('div', { className: 'dbs-sched', 'data-dbs-sched': '1' }, ...out);
    }

    function renderBackupTab(ui, actions) {
      const modules = ui.state === null ? fallbackModules() : moduleRows(ui.state);
      const selected = effectiveSelection(ui);
      const sum = computeSelectionSummary(modules, selected);
      const out = [];

      // 凭据守卫拦截提示：必须显眼。被拦下的文件不会进包，
      // 用户有权知道少了哪个文件、为什么少 —— 静默跳过是这里最坏的行为。
      const blocked = ui.state?.scan?.credentials ?? [];
      if (blocked.length > 0) {
        out.push(
          h(
            Notice,
            { key: 'creds', tone: 'bad', title: `凭据守卫拦下 ${blocked.length} 个文件，它们不会进包：` },
            h(
              'ul',
              { className: 'dbs-creds' },
              ...blocked
                .slice(0, 8)
                .map((c, i) => h('li', { key: i }, `${c.relPath} —— ${c.reason}`)),
              blocked.length > 8 ? h('li', { key: 'more' }, `还有 ${blocked.length - 8} 个，见扫描告警`) : null,
            ),
            h(
              'div',
              { className: 'dbs-note' },
              '这是安全红线：明文密钥一旦打进包，就可能被同步到云端且无法撤回。若确认是误报（例如文档里写了凭据「格式」而非凭据本身），改 lib/guard.js 的规则即可。',
            ),
          ),
        );
      }

      out.push(
        h(
          'div',
          { className: 'dbs-bar', key: 'bar' },
          h(
            'span',
            { className: 'dbs-bar-text' },
            `已选 ${sum.modules} 个模块 · ${sum.unknown > 0 ? '文件数待统计' : `${sum.files} 个文件`} · ${sum.unknown > 0 ? '—' : sum.bytesHuman}`,
          ),
          // 面板只在挂载时取一次数；用户改完磁盘上的技能/配置再回来，计数就是旧的。
          // 汇总条的意义就是「备份前看清有几条」，所以必须能手动重新统计。
          h(Button, { size: 'sm', disabled: ui.busy !== null, onClick: actions.refresh }, '重新统计'),
          h(
            Button,
            {
              kind: 'primary',
              disabled: ui.busy !== null || sum.modules === 0 || ui.state === null || ui.state.sanity?.safe === false,
              onClick: actions.beginBackup,
            },
            '开始备份',
          ),
        ),
      );

      out.push(
        h(
          'div',
          { className: 'dbs-grid', key: 'grid' },
          ...modules.map((m) => {
            const on = selected.includes(m.id);
            const open = ui.expanded[m.id] === true;
            return h(
              'div',
              {
                key: m.id,
                className: 'dbs-card',
                'data-dbs-module': m.id,
                'data-on': on ? '1' : '0',
                'data-off': on ? '0' : '1',
              },
              h(
                'div',
                { className: 'dbs-card-head' },
                h(
                  'label',
                  null,
                  h('input', {
                    type: 'checkbox',
                    checked: on,
                    onChange: () => actions.toggleModule(m.id),
                  }),
                  m.label,
                ),
                h('span', { className: 'dbs-card-count' }, formatCount(m.count, m.countKind)),
              ),
              h('div', { className: 'dbs-card-note' }, m.note),
              h(
                'div',
                { className: 'dbs-card-meta' },
                m.pending === true
                  ? '待统计'
                  : `${m.files} 个文件 · ${m.bytesHuman}${m.exists === false ? ' · 本机不存在' : ''}`,
              ),
              m.localOnly === true ? h(Badge, { tone: 'warn' }, '本地专用 · 不上云') : null,
              m.pending !== true && (m.entries.length > 0 || (m.id === 'skills' && m.count > 0))
                ? h(
                    'div',
                    null,
                    h(
                      'button',
                      { type: 'button', className: 'dbs-link', onClick: () => actions.toggleExpand(m.id) },
                      open
                        ? m.id === 'skills'
                          ? '收起技能'
                          : '收起文件'
                        : m.id === 'skills'
                          ? `查看 ${m.count} 个技能`
                          : `查看 ${m.entries.length} 个文件`,
                    ),
                    open
                      ? m.id === 'skills'
                        ? renderSkillPanel(ui, actions)
                        : h(FileList, {
                            entries: m.entries,
                            onOpen: (e) => actions.openFile(m.id, e.relPath),
                          })
                      : null,
                  )
                : null,
            );
          }),
        ),
      );

      out.push(renderScheduleCard(ui, actions));

      out.push(
        h(
          'div',
          { key: 'opts' },
          h(
            'div',
            { className: 'dbs-field' },
            h('label', { htmlFor: 'dbs-outdir' }, '备份目录'),
            h('input', {
              id: 'dbs-outdir',
              className: 'dbs-input',
              type: 'text',
              value: ui.outDir,
              placeholder: ui.state?.settings?.outDir ?? ui.state?.outDir ?? '默认目录（由 Host 决定）',
              onChange: (e) => actions.setOutDir(e.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dbs-check' },
            h('input', {
              id: 'dbs-include-baseline',
              'data-dbs-baseline': '1',
              type: 'checkbox',
              checked: ui.includeBaseline,
              onChange: (e) => actions.setIncludeBaseline(e.target.checked),
            }),
            '把基线库一并打进包（换机后第一次导入要靠它判断哪些是新增，不含任何凭据）',
          ),
          h('p', { className: 'dbs-note' }, '凭据文件永不进包、永不进基线；对话模块默认不勾选。'),
        ),
      );

      if (ui.backupResult !== null) {
        const r = ui.backupResult;
        out.push(
          h(
            'div',
            { key: 'result' },
            h(Notice, { tone: 'good', title: '备份完成' },
              h(KeyValues, {
                pairs: [
                  ['包名', h('span', { className: 'dbs-mono' }, r.archive.name)],
                  ['大小', r.archive.bytesHuman],
                  ['路径', h('span', { className: 'dbs-mono' }, r.archive.path)],
                  ['sha256', h('span', { className: 'dbs-mono' }, r.archive.sha256)],
                  ['模块', (r.archive.modules ?? []).join('、')],
                  ['文件', `${r.archive.totals?.files ?? '—'} 个`],
                  ['边车校验', r.sidecar?.ok === true ? '通过' : '未通过'],
                ],
              }),
            ),
          ),
        );
      }

      return out;
    }

    /** 历史版本 */
    function renderHistoryTab(ui, actions) {
      const out = [];
      const archives = ui.state?.archives ?? [];
      const dir = ui.state?.outDir ?? '';

      out.push(
        h(
          'div',
          { className: 'dbs-bar', key: 'bar' },
          h('span', { className: 'dbs-bar-text' }, `备份目录：${dir}${archives.length > 0 ? ` · ${archives.length} 份` : ''}`),
          h(Button, { onClick: actions.refresh, disabled: ui.busy !== null }, '刷新'),
        ),
      );

      if (ui.state !== null && ui.state.outDirExists === false) {
        out.push(h(Notice, { key: 'nope', tone: 'warn', title: '备份目录还不存在。' }, '第一次备份时才会创建。'));
      }

      if (archives.length === 0) {
        out.push(h('p', { key: 'empty', className: 'dbs-note' }, '备份目录里还没有备份包。去「备份」页签打一个。'));
        return out;
      }

      out.push(
        h(
          'div',
          { className: 'dbs-rows', key: 'rows' },
          ...archives.map((a) =>
            h(
              'div',
              { key: a.name, className: 'dbs-row' },
              h(
                'div',
                { className: 'dbs-row-main' },
                h('div', { className: 'dbs-mono' }, a.name),
                h(
                  'div',
                  { className: 'dbs-row-meta' },
                  `${a.mtimeLocal ?? '—'} · ${a.bytesHuman} · ${a.machine ?? '机器未知'} · ${
                    Array.isArray(a.modules) ? `${a.modules.length} 个模块` : '模块未知'
                  } · ${a.totals?.files ?? '—'} 个文件`,
                ),
              ),
              h(Button, { size: 'sm', onClick: () => actions.verifyArchive(a.name), disabled: ui.busy !== null }, '校验'),
              h(Button, { size: 'sm', onClick: () => actions.pickArchive(a.name) }, '导入'),
              h(Button, { size: 'sm', onClick: () => actions.copyText(a.path) }, '复制路径'),
            ),
          ),
        ),
      );

      // 复制的成败必须说出来。原先 copyText 把失败 catch 掉了，用户点「复制路径」
      // 在剪贴板不可用的环境里毫无反应，也无从判断是复制坏了还是按钮坏了。
      if (ui.copyResult !== null && ui.copyResult !== undefined) {
        const c = ui.copyResult;
        out.push(
          c.ok === true
            ? h(
              'p',
              { key: 'copied', className: 'dbs-note' },
              '已复制到剪贴板：',
              h('span', { className: 'dbs-mono' }, c.text),
            )
            : h(
              'div',
              { key: 'copyfail' },
              h(
                Notice,
                { tone: 'warn', title: '没能写进剪贴板，请手动选中复制：' },
                h('div', { className: 'dbs-mono' }, c.text),
              ),
            ),
        );
      }

      if (ui.verifyResult !== null) {
        const v = ui.verifyResult;
        const details = verifyDetailLines(v);
        out.push(
          h(
            'div',
            { key: 'v' },
            h(
              Notice,
              { tone: v.ok === true ? 'good' : 'bad', title: v.ok === true ? '校验通过' : '校验未通过' },
              `包：${v.archive?.name ?? '—'} · 逐文件重算哈希 ${v.checked ?? 0} 个 · 不符 ${(v.bad ?? []).length} 个`,
              details.length > 0 ? h('ul', null, ...details.map((d, i) => h('li', { key: `d${i}` }, d))) : null,
              (v.bad ?? []).length > 0
                ? h('ul', null, ...v.bad.slice(0, 20).map((b, i) => h('li', { key: i }, `${b.path}：${b.reason}`)))
                : null,
            ),
          ),
        );
      }

      return out;
    }

    /** 导入执行完的结果块。**与 preview 无关** —— 执行成功后 preview 会被清空。 */
    function renderApplyResult(r) {
      return h(
        'div',
        { key: 'applied' },
        h(
          Notice,
          { tone: r.ok === true ? 'good' : 'bad', title: r.ok === true ? '导入完成' : '导入有失败项' },
          describeCounts(r.counts, ['import', 'delete', 'keep', 'same', 'skip', 'failed']),
          h(KeyValues, {
            pairs: [
              ['写入后校验', `${r.verified?.checked ?? 0} 个，失败 ${r.verified?.failed ?? 0} 个`],
              ['写前快照', r.snapshotDir ?? '无（本次没有覆盖任何已有文件）'],
              ['快照文件', `${r.snapshotFiles ?? 0} 个`],
              ['未裁决冲突', (r.conflictsUnresolved ?? []).length > 0 ? (r.conflictsUnresolved ?? []).join('、') : '无'],
              ['基线', r.baselinePath ?? '（dryRun 未写）'],
            ],
          }),
          (r.errors ?? []).length > 0
            ? h('ul', null, ...r.errors.slice(0, 20).map((e, i) => h('li', { key: i }, `${e.key ?? ''}：${e.message ?? e}`)))
            : null,
        ),
      );
    }

    /** 导入 */
    function renderImportTab(ui, actions) {
      const out = [];
      const archives = ui.state?.archives ?? [];
      const p = ui.preview;
      const applied = ui.applyResult === null ? null : renderApplyResult(ui.applyResult);

      out.push(
        h(
          'div',
          { key: 'src' },
          h(
            'div',
            { className: 'dbs-field' },
            h('label', { htmlFor: 'dbs-src' }, '备份包'),
            archives.length > 0
              ? h(
                  'select',
                  {
                    id: 'dbs-src',
                    className: 'dbs-select',
                    value: ui.importSource,
                    onChange: (e) => actions.setImportSource(e.target.value),
                  },
                  h('option', { value: '' }, '— 请选择 —'),
                  ...archives.map((a) => h('option', { key: a.name, value: a.name }, `${a.name}（${a.mtimeLocal ?? '—'}）`)),
                )
              : h('span', { className: 'dbs-note' }, '备份目录里没有包，可在下面直接填一个包的绝对路径。'),
          ),
          h(
            'div',
            { className: 'dbs-field' },
            h('label', { htmlFor: 'dbs-srcpath' }, '或绝对路径'),
            h('input', {
              id: 'dbs-srcpath',
              className: 'dbs-input',
              type: 'text',
              value: ui.importPath,
              placeholder: joinHint(ui.state?.outDir, 'dsh-sync-<日期>-<时间>.tar.gz'),
              onChange: (e) => actions.setImportPath(e.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dbs-check' },
            h('input', {
              type: 'checkbox',
              checked: ui.allowDelete,
              onChange: (e) => actions.setAllowDelete(e.target.checked),
            }),
            '允许删除本地文件（归档里已删除的，本地也跟着删）',
          ),
          ui.allowDelete
            ? h(Notice, { tone: 'warn' }, '已开启删除。只有「归档删了、本地一直没改过」的文件才会被删；本地改过的一律报冲突交你裁决。')
            : h('p', { className: 'dbs-note' }, '默认不删任何本地文件 —— 导入只会新增和覆盖，不会让东西消失。'),
          h(
            'div',
            { className: 'dbs-field' },
            h(
              Button,
              {
                kind: 'primary',
                disabled: ui.busy !== null || ui.state === null || (ui.importSource === '' && ui.importPath.trim() === ''),
                onClick: actions.preview,
              },
              '分析差异',
            ),
            h(Button, { onClick: actions.refresh, disabled: ui.busy !== null }, '刷新列表'),
          ),
        ),
      );

      // 没有预览时后面那些差异区都没得渲染，但「导入结果」必须照常出现 ——
      // 执行成功后 preview 会被清空，一起 return 掉用户就永远看不到结果了。
      if (p === null) return applied === null ? out : out.concat([applied]);

      const effCounts = effectiveCounts(p, ui.resolutions);
      const effWrites = effectiveWriteCount(effCounts);
      const effUnresolved = effCounts.conflict ?? 0;

      out.push(
        h(
          'div',
          { key: 'preview' },
          h(KeyValues, {
            pairs: [
              ['包', h('span', { className: 'dbs-mono' }, p.archive?.name)],
              ['打出时间', p.archive?.createdAtLocal],
              ['来源机器', p.archive?.machine],
              ['模块', (p.archive?.modules ?? []).join('、')],
              ['文件', `${p.archive?.totals?.files ?? '—'} 个`],
              [
                '比较基准',
                p.baseSource?.used === 'local'
                  ? `本机基线（${p.baseSource.localKeys} 个文件）`
                  : '无 —— 本机还没同步过，全部按新增处理',
              ],
              [
                '包内基线',
                p.baseSource?.packRead === true
                  ? `${p.baseSource.packKeys} 个文件 · 来自 ${p.baseSource.packMachine ?? '未知机器'}（仅用于溯源，不参与比较）`
                  : '包内没有基线',
              ],
            ],
          }),
          h(CountGrid, { counts: effCounts, showZero: true }),
        ),
      );

      // 归档里带着凭据类文件（老版本打的包、别人给的包、手工塞的包）。
      // 宿主侧已经把它们判成「跳过」，这里必须说出来 —— 否则用户会以为
      // 「导入成功 = 全都进来了」，而少掉的那几个恰好是最要紧的几个。
      if ((p.blocked ?? []).length > 0) {
        const bl = p.blocked;
        out.push(
          h(
            Notice,
            { key: 'blocked', tone: 'warn', title: `归档里有 ${bl.length} 个凭据类文件，不会写进本机：` },
            h(
              'ul',
              { className: 'dbs-creds' },
              ...bl.map((b, i) => h('li', { key: i }, `${b.moduleId} · ${b.relPath} —— ${b.reason}`)),
            ),
            h(
              'div',
              { className: 'dbs-note' },
              '这类文件（.npmrc、.netrc、私钥……）既写机器本地绝对路径、又可能藏着令牌，跨机搬运只会把目标机的包管理器搞坏。它们仍然留在归档里，只是不落地。',
            ),
          ),
        );
      }

      if ((p.conflicts ?? []).length > 0) {
        const unresolved = effUnresolved;
        out.push(
          h(
            'div',
            { key: 'conflicts' },
            h(
              Notice,
              { tone: unresolved > 0 ? 'warn' : 'good', title: `需要你裁决 ${p.conflicts.length} 处冲突` },
              unresolved > 0
                ? `还有 ${unresolved} 处没选。没选的会按「保留本地」处理 —— 不会覆盖你自己的改动，但也不会导入归档版本。`
                : '已全部裁决。',
            ),
            h(
              'div',
              { className: 'dbs-field' },
              h(Button, { size: 'sm', onClick: () => actions.setAllResolutions('archive') }, '全部采用归档'),
              h(Button, { size: 'sm', onClick: () => actions.setAllResolutions('local') }, '全部保留本地'),
            ),
            ...p.conflicts.map((c) =>
              h(
                'div',
                { key: c.key, className: 'dbs-conflict' },
                h('div', { className: 'dbs-conflict-head' }, `${c.moduleId} · ${c.relPath}`),
                h(
                  'div',
                  { className: 'dbs-conflict-hashes' },
                  `本地 ${shortHash(c.ours)}　归档 ${shortHash(c.theirs)}　基准 ${shortHash(c.base)}`,
                ),
                h('div', { className: 'dbs-conflict-hashes' }, c.reason),
                h(
                  'div',
                  { className: 'dbs-choices' },
                  h(
                    'label',
                    { className: 'dbs-check' },
                    h('input', {
                      type: 'radio',
                      name: `dbs-c-${c.key}`,
                      checked: ui.resolutions[c.key] === 'archive',
                      onChange: () => actions.resolve(c.key, 'archive'),
                    }),
                    '采用归档版本（覆盖本地）',
                  ),
                  h(
                    'label',
                    { className: 'dbs-check' },
                    h('input', {
                      type: 'radio',
                      name: `dbs-c-${c.key}`,
                      checked: ui.resolutions[c.key] === 'local',
                      onChange: () => actions.resolve(c.key, 'local'),
                    }),
                    '保留本地版本',
                  ),
                ),
              ),
            ),
          ),
        );
      }

      const groups = groupActions(p.actions);
      if (groups.length > 0) {
        out.push(
          h(
            'details',
            { key: 'detail', className: 'dbs-detail' },
            h('summary', null, `动作明细（共 ${p.actions.length} 条）`),
            ...groups.map((g) =>
              h(
                'div',
                { key: g.action },
                h('p', { className: 'dbs-note' }, `${g.label} ${g.items.length} 条`),
                h(
                  'ul',
                  { className: 'dbs-files' },
                  ...g.items.slice(0, FILE_ROWS_LIMIT).map((a, i) =>
                    h(
                      'li',
                      { key: `${a.key}-${i}` },
                      h('span', null, `${a.moduleId} · ${a.relPath}`),
                      h('span', null, a.reason),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }

      // 「执行导入」的可点性必须按**折算后**的写入量判定：
      // 只有未裁决冲突时写入量是 0，此时应该先让用户去裁决，而不是让他点进确认框
      // 看到「没有任何差异」。宿主的 canApply 仍是一道上限（sanity 不过就不给点）。
      const canApply = p.canApply === true && effWrites > 0;
      const whyNot =
        p.canApply !== true
          ? '没有需要写入的内容，无需导入。'
          : effWrites > 0
            ? null
            : effUnresolved > 0
              ? `还有 ${effUnresolved} 处冲突没裁决。选「采用归档版本」才会写入。`
              : '裁决结果是「保留本地」，没有需要写入的内容。';

      out.push(
        h(
          'div',
          { key: 'go', className: 'dbs-field' },
          h(
            Button,
            { kind: 'primary', disabled: ui.busy !== null || !canApply, onClick: actions.beginApply },
            '执行导入',
          ),
          whyNot === null ? null : h('span', { className: 'dbs-note' }, whyNot),
        ),
      );

      if (applied !== null) out.push(applied);

      return out;
    }

    /** 同步 */
    function renderSyncTab(ui, actions) {
      const out = [];
      const listing = ui.syncListing;

      out.push(
        h(
          'div',
          { key: 'src' },
          h(
            'div',
            { className: 'dbs-field' },
            h('label', { htmlFor: 'dbs-syncdir' }, '同步文件夹'),
            h('input', {
              id: 'dbs-syncdir',
              className: 'dbs-input',
              type: 'text',
              value: ui.syncDir,
              placeholder: ui.state?.settings?.syncDir ?? '例如 ~/dsh-sync、D:\\OneDrive\\dsh-sync 或 U 盘盘符',
              onChange: (e) => actions.setSyncDir(e.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dbs-field' },
            h(Button, { kind: 'primary', disabled: ui.busy !== null || ui.syncDir.trim() === '', onClick: actions.syncPush }, '推送最新备份过去'),
            h(Button, { disabled: ui.busy !== null || ui.syncDir.trim() === '', onClick: actions.syncList }, '列出文件夹里的包'),
          ),
          h(
            'p',
            { className: 'dbs-note' },
            '这是最小的同步方式：把最新的包（连同 .sha256 与 .meta.json）复制到一个文件夹 —— U 盘、OneDrive、坚果云目录都行。',
          ),
          h(
            'p',
            { className: 'dbs-note' },
            '放在同步文件夹里的包，可以在「导入」页签用绝对路径直接导入。git 私有仓库 / WebDAV 适配器是二期的事。',
          ),
        ),
      );

      if (ui.syncResult !== null) {
        const r = ui.syncResult;
        out.push(
          h(
            'div',
            { key: 'r' },
            h(Notice, { tone: 'good', title: '已推送' },
              h(KeyValues, {
                pairs: [
                  ['包', h('span', { className: 'dbs-mono' }, r.archive)],
                  ['目标', h('span', { className: 'dbs-mono' }, r.target)],
                  ['文件', (r.copied ?? []).map((c) => c.name).join('、')],
                ],
              }),
            ),
          ),
        );
      }

      if (listing !== null) {
        out.push(
          h(
            'div',
            { key: 'l' },
            listing.exists === false
              ? h(Notice, { tone: 'warn' }, `文件夹不存在：${listing.target}`)
              : listing.archives.length === 0
                ? h('p', { className: 'dbs-note' }, `文件夹里没有备份包：${listing.target}`)
                : h(
                    'div',
                    { className: 'dbs-rows' },
                    ...listing.archives.map((a) =>
                      h(
                        'div',
                        { key: a.name, className: 'dbs-row' },
                        h(
                          'div',
                          { className: 'dbs-row-main' },
                          h('div', { className: 'dbs-mono' }, a.name),
                          h(
                            'div',
                            { className: 'dbs-row-meta' },
                            `${a.mtimeLocal ?? '—'} · ${a.bytesHuman} · ${a.machine ?? '机器未知'} · ${a.totals?.files ?? '—'} 个文件`,
                          ),
                        ),
                        h(Button, { size: 'sm', onClick: () => actions.importFrom(a.path) }, '去导入'),
                      ),
                    ),
                  ),
          ),
        );
      }

      return out;
    }

    const TAB_RENDERERS = {
      backup: renderBackupTab,
      history: renderHistoryTab,
      import: renderImportTab,
      sync: renderSyncTab,
    };

    // ──────────────────────────────────────── 6. renderPanel（纯函数）

    /**
     * The whole panel as a pure function of `ui` + `actions`. No hooks live
     * here on purpose: this is what the offline tests render, so the tests
     * never need a React renderer.
     */
    function renderPanel(ui, actions) {
      const act = actions ?? {};
      const out = [];

      out.push(h('h2', { key: 'h', className: 'dbs-h2' }, PANEL_LABEL));
      out.push(
        h(
          'p',
          { key: 's', className: 'dbs-sub' },
          '把技能、插件、配置、记忆、待办打包带走，换台电脑增量导入。',
        ),
      );

      const sanity = ui.state?.sanity;
      if (sanity !== null && sanity !== undefined && sanity.safe === false) {
        out.push(
          h(
            Notice,
            { key: 'sanity', tone: 'bad', title: '路径体检没通过，写操作已停用：' },
            h('ul', null, ...(sanity.warnings ?? []).map((w, i) => h('li', { key: i }, w))),
          ),
        );
      } else if (sanity !== null && sanity !== undefined && (sanity.warnings ?? []).length > 0) {
        out.push(
          h(
            Notice,
            { key: 'sanity', tone: 'warn' },
            h('ul', null, ...sanity.warnings.map((w, i) => h('li', { key: i }, w))),
          ),
        );
      }

      out.push(h(StatusLine, { key: 'st', loading: ui.loading, error: ui.error, busy: ui.busy }));

      out.push(
        h(
          'div',
          { key: 'tabs', className: 'dbs-tabs' },
          ...TABS.map((t) =>
            h(
              'button',
              {
                key: t.id,
                type: 'button',
                className: 'dbs-tab',
                'data-on': ui.tab === t.id ? '1' : '0',
                'data-dbs-tab': t.id,
                onClick: () => act.setTab(t.id),
              },
              t.label,
            ),
          ),
        ),
      );

      const render = TAB_RENDERERS[ui.tab] ?? renderBackupTab;
      out.push(h('div', { key: 'body', 'data-dbs-tabbody': ui.tab }, ...render(ui, act)));

      if (ui.confirmingBackup === true) out.push(renderBackupConfirm(ui, act));
      if (ui.confirmingApply === true) out.push(renderApplyConfirm(ui, act));
      // 弹窗放在最后：它们是浮层，顺序影响不了布局，但放最后能保证
      // 上面的 confirm 框永远先渲染，视觉上不会被盖住。
      if (ui.skill !== null && ui.skill !== undefined) out.push(renderSkillDialog(ui, act));
      if (ui.file !== null && ui.file !== undefined) out.push(renderFileDialog(ui, act));

      return h('div', { className: 'dbs-root', 'data-dsh-backup-sync': 'panel' }, ...out);
    }

    function renderBackupConfirm(ui, actions) {
      const modules = ui.state === null ? fallbackModules() : moduleRows(ui.state);
      const selected = effectiveSelection(ui);
      const sum = computeSelectionSummary(modules, selected);
      const names = modules.filter((m) => selected.includes(m.id)).map((m) => m.label);
      const outDir = ui.outDir.trim() !== '' ? ui.outDir.trim() : (ui.state?.outDir ?? '（默认目录）');
      const localOnlyPicked = modules.filter((m) => m.localOnly === true && selected.includes(m.id));
      const blockedCount = (ui.state?.scan?.credentials ?? []).length;

      return h(
        Overlay,
        {
          key: 'cb',
          title: '确认备份',
          actions: [
            { label: '取消', onClick: actions.cancelBackup },
            { label: '确认备份', kind: 'primary', onClick: actions.confirmBackup, disabled: ui.busy !== null },
          ],
        },
        h(KeyValues, {
          pairs: [
            ['模块', `${sum.modules} 个：${names.join('、')}`],
            ['文件', sum.unknown > 0 ? '待统计' : `${sum.files} 个`],
            ['原始大小', sum.unknown > 0 ? '待统计' : sum.bytesHuman],
            ['输出目录', h('span', { className: 'dbs-mono' }, outDir)],
            ['包名', '按备份时间自动命名，形如 dsh-sync-<日期>-<时间>.tar.gz'],
            ['基线库', ui.includeBaseline ? '一并打进包（不含凭据）' : '不打进包'],
            blockedCount > 0
              ? ['凭据守卫', `拦下 ${blockedCount} 个文件，不进包（见「备份」页签的红色提示）`]
              : null,
          ].filter((p) => p !== null),
        }),
        localOnlyPicked.length > 0
          ? h(
              Notice,
              { tone: 'warn', title: '注意：' },
              `你勾选了「${localOnlyPicked.map((m) => m.label).join('、')}」。这类内容体积大，且包含工作对话原文 —— 如果之后把包同步到个人云盘或 GitHub，等于把这些内容一起带出去。`,
            )
          : null,
        h('p', { className: 'dbs-note' }, '备份只读本机文件，不会修改任何东西。'),
      );
    }

    function renderApplyConfirm(ui, actions) {
      const p = ui.preview;
      // 和差异区用同一份折算后的计数，否则确认框会与页面上的数字打架
      const counts = effectiveCounts(p, ui.resolutions);
      const unresolved = counts.conflict ?? 0;
      const writes = effectiveWriteCount(counts);
      return h(
        Overlay,
        {
          key: 'ca',
          title: '确认导入',
          actions: [
            { label: '取消', onClick: actions.cancelApply },
            { label: '确认导入', kind: 'primary', onClick: actions.confirmApply, disabled: ui.busy !== null },
          ],
        },
        h(KeyValues, {
          pairs: [
            ['包', h('span', { className: 'dbs-mono' }, p?.archive?.name ?? '—')],
            ['将写入', writes === 0 ? '0 个（不会改动任何文件）' : describeCounts(counts, ['import', 'delete'])],
            ['保留本地', String(counts.keep ?? 0)],
            ['未裁决冲突', unresolved > 0 ? `${unresolved} 处（按保留本地处理）` : '无'],
            ['删除开关', ui.allowDelete ? '已开启' : '关闭（不会删本地文件）'],
          ],
        }),
        h(
          'p',
          { className: 'dbs-note' },
          '写入前会把将被覆盖或删除的文件快照到 ~/.dsh/backup-sync/pre-restore-<时间戳>/，写完还会逐个回算 sha256，不符就自动回滚。',
        ),
      );
    }

    /**
     * 技能详情弹窗。
     *
     * 文件明细放在这里而不是卡片上：技能动辄几十个文件，全铺在卡片里会把
     * 六宫格撑成一面墙，反而看不清有哪几个技能。
     */
    function renderSkillDialog(ui, actions) {
      const s = ui.skill;
      const entries = skillFiles(ui, s);
      const line = copyLine(ui.copyFeed?.skill, '技能名');
      return h(
        Overlay,
        {
          key: 'sk',
          wide: true,
          title: `技能：${s.name ?? s.id}`,
          actions: [
            { label: '复制技能名', onClick: () => actions.copySkillName(s) },
            { label: '关闭', kind: 'primary', onClick: actions.closeSkill },
          ],
        },
        h(KeyValues, {
          pairs: [
            ['技能名', h('span', { className: 'dbs-mono' }, s.name ?? s.id)],
            ['目录', h('span', { className: 'dbs-mono' }, s.path ?? s.dir ?? '—')],
            ['文件', skillMeta(s)],
            ['入口文件', s.hasSkillMd === false ? '缺 SKILL.md（模型不会自动加载它）' : '有 SKILL.md'],
            ['最近改动', formatWhen(s.mtimeMs)],
          ],
        }),
        h('p', { className: 'dbs-note', 'data-dbs-skill-desc': '1' }, skillTooltip(s)),
        h('h3', null, `文件明细（${entries.length} 个）`),
        h(FileList, { entries, onOpen: (e) => actions.openFile('skills', e.relPath) }),
        line !== null ? h('div', { 'data-dbs-copyfeed': 'skill' }, h(Notice, { tone: line.tone }, line.text)) : null,
      );
    }

    /**
     * 文件内容弹窗（只读）。
     *
     * 三种回答都要说清楚：能看、被安全闸拦下、读不出来。
     * 被拦下时**不显示内容**，只显示原因和脱敏后的片段 —— 这是和宿主
     * `lib/fileview.js` 的约定，前端不做任何"再试一次"的绕过。
     */
    function renderFileDialog(ui, actions) {
      const f = ui.file;
      const v = ui.fileView;
      const viewable = v !== null && v !== undefined && v.viewable === true;
      const out = [];

      out.push(
        h(KeyValues, {
          key: 'kv',
          pairs: [
            ['模块', f.moduleId],
            ['路径', h('span', { className: 'dbs-mono' }, v?.absPath ?? f.relPath)],
            ['大小', fileSizeText(v)],
            ['修改时间', formatWhen(v?.mtimeMs)],
          ],
        }),
      );

      if (ui.fileError !== null && ui.fileError !== undefined) {
        out.push(h(Notice, { key: 'err', tone: 'bad', title: '读不出来：' }, ui.fileError));
      } else if (v === null || v === undefined) {
        out.push(h('p', { key: 'load', className: 'dbs-note' }, h('span', { className: 'dbs-spin' }), '正在读取…'));
      } else if (viewable !== true) {
        const guard = v.guard ?? null;
        out.push(
          h(
            Notice,
            { key: 'no', tone: 'warn', title: '这个文件不能在这里查看：' },
            h('p', null, v.reason ?? '宿主没有给出原因。'),
            guard !== null
              ? h(
                  'p',
                  { className: 'dbs-note' },
                  `${guard.id ?? '安全闸'} 命中：`,
                  h('span', { className: 'dbs-mono' }, guard.excerpt ?? '（片段已脱敏）'),
                )
              : null,
            h('p', { className: 'dbs-note' }, '它仍然会（或不会）被备份，取决于它是不是凭据文件 —— 凭据一律不进包。'),
          ),
        );
      } else {
        if (v.truncated === true) {
          out.push(
            h(
              Notice,
              { key: 'trunc', tone: 'warn', title: '文件太大，只显示了开头：' },
              `完整文件 ${fileSizeText(v)}，这里最多显示 512 KB。复制按钮复制的也只是这段内容。`,
            ),
          );
        }
        if (v.binary === true) {
          out.push(h(Notice, { key: 'bin', tone: 'warn' }, '这个文件看着是二进制，下面按文本显示，内容可能没有意义。'));
        }
        out.push(h('pre', { key: 'text', className: 'dbs-pre', 'data-dbs-filetext': '1' }, v.text ?? ''));
        const line = copyLine(ui.copyFeed?.file, '文件内容');
        if (line !== null) out.push(h('div', { key: 'cp', 'data-dbs-copyfeed': 'file' }, h(Notice, { tone: line.tone }, line.text)));
      }

      return h(
        Overlay,
        {
          key: 'fd',
          wide: true,
          title: '查看文件',
          actions: [
            viewable ? { label: '复制内容', onClick: () => actions.copyFileContent(v.text) } : null,
            { label: '关闭', kind: 'primary', onClick: actions.closeFile },
          ].filter((a) => a !== null),
        },
        ...out,
      );
    }

    // ─────────────────────────────────────────── 7. 面板组件（带 hooks）

    /**
     * Initial UI state. Exported for the offline tests, which render
     * `renderPanel(createInitialUiState(), {})` without a React renderer.
     */
    function createInitialUiState() {
      return {
        tab: 'backup',
        loading: true,
        error: null,
        busy: null,
        state: null,
        selected: null,
        expanded: {},
        outDir: '',
        includeBaseline: true,
        confirmingBackup: false,
        backupResult: null,
        verifyResult: null,
        importSource: '',
        importPath: '',
        allowDelete: false,
        preview: null,
        resolutions: emptyResolutions(),
        confirmingApply: false,
        applyResult: null,
        syncDir: '',
        syncResult: null,
        syncListing: null,
        copyResult: null,
        // 定时备份：sched 是表单草稿（用户改过 schedDirty 就为 true），
        // schedView 是宿主给的调度实况，schedRun 是「立即跑一次」的结果。
        sched: null,
        schedDirty: false,
        schedView: null,
        schedRun: null,
        // 技能清单是展开技能卡时才去取的，null = 还没取。
        skills: null,
        skillsLoading: false,
        skillsError: null,
        skill: null,
        // 文件内容弹窗。
        file: null,
        fileView: null,
        fileError: null,
        // 复制反馈按来源分开存，否则「已复制路径」会串到文件弹窗里。
        copyFeed: {},
      };
    }

    /**
     * 把 HTTP 状态翻译成用户能照着做的说法。
     *
     * 401/403 是宿主 `dsh-client-connection` 的两道闸：前者是会话 cookie 过期，
     * 后者是 Host/Origin 校验没过。这两个数字对用户毫无意义，但「刷新页面重新登录」
     * 和「换个地址打开」是有用的动作。
     *
     * 404 是**本插件的宿主半边没跟上**：界面半边是 `link:` 安装的，改完刷新页面就是新的；
     * 宿主半边不会被热加载（两个 profile 都实测过），新增的接口要**重启一次 DSH**
     * 才会注册。直接报「接口返回的不是 JSON（HTTP 404）」会让人以为功能坏了，
     * 真实原因只是宿主还是旧的 —— 所以这里必须把动作说出来。
     */
    function authHint(status) {
      if (status === 401) return '会话已过期（HTTP 401）。刷新页面重新登录后再试。';
      if (status === 403) return '请求被宿主拒绝（HTTP 403）：来源地址不在信任列表里。';
      if (status === 404) {
        return '当前运行的宿主里还没有这条接口（HTTP 404）。界面部分已经是最新的，宿主部分要重启一次 DSH 才会生效 —— 关掉 DSH 再打开即可。';
      }
      return `接口返回的不是 JSON（HTTP ${status}）`;
    }

    /**
     * 老路兜底：临时 textarea + `document.execCommand('copy')`。
     *
     * 这条路不挑上下文，任何页面都能用，是 `navigator.clipboard` 不可用时的唯一退路。
     * 仅在被调用时才创建元素，且无论如何都移除，不留痕迹。
     */
    function legacyCopy(value) {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return false;
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try {
        ta.select();
        return typeof document.execCommand === 'function' && document.execCommand('copy') === true;
      } catch (err) {
        return false;
      } finally {
        ta.remove();
      }
    }

    /**
     * 把文本写进剪贴板，返回 `{ ok, how }`。
     *
     * ★ 为什么不能让 `navigator.clipboard.writeText` 单独承担这件事：
     * 桌面端页面跑在自定义协议 `dsh-app://app/` 下，自定义协议只有被注册成 secure 时
     * 才算安全上下文 —— 否则 `navigator.clipboard` **直接是 undefined**。
     * 原先的写法 `navigator.clipboard?.writeText(...).catch(() => {})` 在这种情况下
     * 连调用都不会发生，按钮点了毫无反应、也不报错，用户只会以为「复制坏了」。
     * 所以：先试现代 API，失败就退到 execCommand，两条都不行才如实报失败。
     */
    async function copyToClipboard(text) {
      const value = String(text === null || text === undefined ? '' : text);
      if (value === '') return { ok: false, how: 'empty' };
      const nav = typeof navigator === 'undefined' ? undefined : navigator;
      if (nav !== undefined && nav !== null && nav.clipboard !== undefined && nav.clipboard !== null
        && typeof nav.clipboard.writeText === 'function') {
        try {
          await nav.clipboard.writeText(value);
          return { ok: true, how: 'clipboard' };
        } catch (err) {
          // 落到兜底；失败原因对用户没意义，界面只报最终结果
        }
      }
      return legacyCopy(value) ? { ok: true, how: 'execCommand' } : { ok: false, how: 'failed' };
    }

    /**
     * Thin fetch wrapper: the Host always answers JSON, even on failure.
     *
     * ★ 这里只把**传输层/协议层**的失败当异常。判据是「`ok:false` **且**带非空 `error`」——
     * 因为宿主只有 `jsonFail(message)` 会产出那个形状。而 `/verify` 这类接口会正常返回
     * `{ok:false, bad:[…], sidecar:{…}}`：HTTP 200、`error` 缺席，意思是「调用成功了，
     * 答案是『校验没过』」。早先的写法 `data.ok === false` 一律抛错，于是把这种**正常结果**
     * 变成异常，界面上顶出一条「出错了：HTTP 200」，而真正有用的 `bad` 列表被整个丢掉。
     */
    async function callApi(path, body) {
      const res = await fetch(API + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data;
      try {
        data = await res.json();
      } catch (err) {
        // 401/403 时宿主回的是**纯文本**（"authentication required" 之类），不是 JSON。
        // 直接报「接口返回的不是 JSON（HTTP 401）」会把人引向错误的方向 —— 真实原因是
        // 会话过期或来源校验没过，跟 JSON 一点关系都没有。
        throw new Error(authHint(res.status));
      }
      if (data !== null && typeof data === 'object' && data.ok === false) {
        const msg = typeof data.error === 'string' && data.error !== '' ? data.error : null;
        if (msg !== null) throw new Error(msg);
        // `ok:false` 但没给 error：这是业务结论，不是调用失败，原样交回调用方渲染。
      }
      if (res.ok !== true) throw new Error(authHint(res.status));
      return data;
    }

    /**
     * 「设置 → 备份同步」分区的主体。
     *
     * 外壳只在**选中**这个分区时才渲染它（`renderSlot('settings.section', …,
     * { only: active })`），所以切走再切回来会重新挂载 —— 每次挂载都重新取一次
     * 状态，正好保证计数不会停留在上一次的旧值上。
     */
    function BackupSyncSection() {
      const [ui, setUi] = React.useState(createInitialUiState);
      const patch = React.useCallback((next) => setUi((prev) => ({ ...prev, ...next })), []);
      // 技能行的单击/双击分流器（见 clickGate 的注释）。
      const gate = React.useRef(null);
      if (gate.current === null) gate.current = clickGate(240);

      const load = React.useCallback(
        async (outDirOverride) => {
          patch({ loading: true, error: null });
          try {
            const state = await callApi('/state', { outDir: outDirOverride ?? undefined });
            setUi((prev) => ({
              ...prev,
              loading: false,
              error: null,
              state,
              // Only adopt the Host's outDir/syncDir when the user has not typed.
              outDir: prev.outDir === '' ? '' : prev.outDir,
              syncDir: prev.syncDir === '' ? (state.settings?.syncDir ?? '') : prev.syncDir,
              // 表单草稿只在用户没改过时才跟随宿主 —— 否则刷新一次就把
              // 正在编辑的时间/频率冲掉了。
              sched: prev.schedDirty === true ? prev.sched : (state.settings?.schedule ?? prev.sched),
              schedView: state.scheduleView ?? prev.schedView,
            }));
          } catch (err) {
            patch({ loading: false, error: err?.message ?? String(err) });
          }
        },
        [patch],
      );

      React.useEffect(() => {
        // Re-resolve the theme on every mount: the user may have switched themes
        // since boot, and apply() only ran once.
        syncTheme();
        if (typeof fetch !== 'function') {
          patch({ loading: false, error: '当前环境没有 fetch，无法连接宿主接口。' });
          return;
        }
        load();
      }, [load, patch]);

      /** Run a busy-labelled action, surfacing any error into the banner. */
      const run = React.useCallback(
        async (label, fn) => {
          patch({ busy: label, error: null });
          try {
            const result = await fn();
            patch({ busy: null });
            return result;
          } catch (err) {
            patch({ busy: null, error: err?.message ?? String(err) });
            return null;
          }
        },
        [patch],
      );

      const actions = {
        setTab: (tab) => patch({ tab }),

        refresh: () => {
          load(requestOutDir(ui));
          if (ui.skills !== null) actions.loadSkills();
        },

        toggleModule: (id) => setUi((prev) => ({ ...prev, selected: toggleSelection(effectiveSelection(prev), id) })),
        toggleExpand: (id) => {
          setUi((prev) => ({ ...prev, expanded: { ...prev.expanded, [id]: prev.expanded[id] !== true } }));
          // 技能清单是懒加载的：第一次展开技能卡才去问宿主。
          if (id === 'skills' && ui.skills === null && ui.skillsLoading !== true) actions.loadSkills();
        },
        setOutDir: (outDir) => patch({ outDir }),
        setIncludeBaseline: (includeBaseline) => patch({ includeBaseline }),

        // ── 技能清单 / 技能弹窗 ──
        loadSkills: async () => {
          patch({ skillsLoading: true, skillsError: null });
          try {
            const r = await callApi('/skills', {});
            patch({ skills: Array.isArray(r?.skills) ? r.skills : [], skillsLoading: false, skillsError: null });
          } catch (err) {
            patch({ skillsLoading: false, skillsError: err?.message ?? String(err) });
          }
        },
        openSkill: (skill) => patch({ skill }),
        closeSkill: () => patch({ skill: null }),
        // 单击延迟 240ms 开弹窗；期间来了第二次点击就取消，改走复制技能名。
        skillClick: (skill) => gate.current.click(() => patch({ skill })),
        skillDblClick: (skill) => {
          gate.current.dblclick();
          return actions.copySkillName(skill);
        },
        copySkillName: async (skill) => {
          const name = String(skill?.name ?? skill?.id ?? '');
          const r = await copyToClipboard(name);
          setUi((prev) => ({ ...prev, copyFeed: { ...prev.copyFeed, skill: { ok: r.ok, how: r.how, label: name } } }));
        },

        // ── 文件内容弹窗 ──
        openFile: async (moduleId, relPath) => {
          patch({ file: { moduleId, relPath }, fileView: null, fileError: null, busy: '正在读取文件…' });
          try {
            const r = await callApi('/file', { moduleId, relPath });
            patch({ busy: null, fileView: r?.view ?? null });
          } catch (err) {
            // 读文件失败只落在弹窗里，不污染顶部的错误条 —— 用户点的是一个
            // 只读预览，失败不该看起来像整个面板坏了。
            patch({ busy: null, fileError: err?.message ?? String(err) });
          }
        },
        closeFile: () => patch({ file: null, fileView: null, fileError: null }),
        copyFileContent: async (text) => {
          const value = String(text ?? '');
          const r = await copyToClipboard(value);
          setUi((prev) => ({
            ...prev,
            copyFeed: { ...prev.copyFeed, file: { ok: r.ok, how: r.how, label: `${value.length} 个字符` } },
          }));
        },

        // ── 定时备份 ──
        setSched: (change) =>
          setUi((prev) => ({
            ...prev,
            schedDirty: true,
            sched: { ...(prev.sched ?? prev.state?.settings?.schedule ?? DEFAULT_SCHEDULE_FORM), ...change },
          })),
        saveSchedule: async () => {
          const saved = ui.state?.settings?.schedule ?? DEFAULT_SCHEDULE_FORM;
          const form = ui.sched ?? saved;
          // ★ 只发改动过的键：宿主按「body 里有没有计时键」决定要不要重置计时起点，
          //   整表单照发会让「只改保留份数」也被当成改了频率（见 schedulePatch 的注释）。
          const body = schedulePatch(saved, form);
          if (Object.keys(body).length === 0) {
            patch({ schedDirty: false });
            return;
          }
          const r = await run('正在保存定时设置…', () => callApi('/schedule', body));
          if (r !== null) {
            patch({ sched: r.schedule ?? form, schedDirty: false, schedView: r.scheduleView ?? null, schedRun: null });
            load(requestOutDir(ui));
          }
        },
        runScheduleNow: async () => {
          const r = await run('正在执行定时备份…', () => callApi('/schedule/run-now', { outDir: requestOutDir(ui) }));
          if (r !== null) {
            patch({ schedRun: r, schedView: r.scheduleView ?? ui.schedView });
            load(requestOutDir(ui));
          }
        },

        beginBackup: () => patch({ confirmingBackup: true, backupResult: null }),
        cancelBackup: () => patch({ confirmingBackup: false }),
        confirmBackup: async () => {
          const moduleIds = effectiveSelection(ui);
          const body = {
            moduleIds,
            includeBaseline: ui.includeBaseline,
            outDir: requestOutDir(ui),
          };
          patch({ confirmingBackup: false });
          const r = await run('正在打包…', () => callApi('/backup', body));
          if (r !== null) {
            patch({ backupResult: r, tab: 'backup' });
            load(body.outDir);
          }
        },

        verifyArchive: async (archiveName) => {
          const r = await run('正在逐文件校验…', () => callApi('/verify', { archiveName }));
          if (r !== null) patch({ verifyResult: r, tab: 'history' });
        },
        copyText: async (text) => {
          const value = String(text === null || text === undefined ? '' : text);
          const r = await copyToClipboard(value);
          patch({ copyResult: { ok: r.ok, how: r.how, text: value } });
        },
        pickArchive: (archiveName) =>
          patch({ tab: 'import', importSource: archiveName, importPath: '', preview: null, applyResult: null, resolutions: {} }),

        setImportSource: (importSource) => patch({ importSource, importPath: '', preview: null, applyResult: null, resolutions: {} }),
        setImportPath: (importPath) => patch({ importPath, importSource: '', preview: null, applyResult: null, resolutions: {} }),
        setAllowDelete: (allowDelete) => patch({ allowDelete, preview: null, applyResult: null }),
        importFrom: (path) => patch({ tab: 'import', importPath: String(path), importSource: '', preview: null, applyResult: null, resolutions: {} }),

        preview: async () => {
          const body = {
            archiveName: ui.importSource === '' ? undefined : ui.importSource,
            archivePath: ui.importPath.trim() === '' ? undefined : ui.importPath.trim(),
            allowDelete: ui.allowDelete,
            outDir: requestOutDir(ui),
          };
          const r = await run('正在分析差异…', () => callApi('/import/preview', body));
          if (r !== null) patch({ preview: r, resolutions: emptyResolutions(), applyResult: null, tab: 'import' });
        },
        resolve: (key, choice) => setUi((prev) => ({ ...prev, resolutions: { ...prev.resolutions, [key]: choice } })),
        setAllResolutions: (choice) =>
          setUi((prev) => ({ ...prev, resolutions: setAllResolutions(prev.preview?.conflicts ?? [], choice) })),

        beginApply: () => patch({ confirmingApply: true }),
        cancelApply: () => patch({ confirmingApply: false }),
        confirmApply: async () => {
          const body = {
            archiveName: ui.importSource === '' ? undefined : ui.importSource,
            archivePath: ui.importPath.trim() === '' ? undefined : ui.importPath.trim(),
            allowDelete: ui.allowDelete,
            resolutions: ui.resolutions,
            outDir: requestOutDir(ui),
          };
          patch({ confirmingApply: false });
          const r = await run('正在写入…', () => callApi('/import/apply', body));
          if (r !== null) {
            patch({ applyResult: r, preview: null, resolutions: {} });
            load(body.outDir);
          }
        },

        setSyncDir: (syncDir) => patch({ syncDir }),
        syncPush: async () => {
          const r = await run('正在复制…', () => callApi('/sync/push', { targetDir: ui.syncDir.trim(), outDir: requestOutDir(ui) }));
          if (r !== null) patch({ syncResult: r, syncListing: null });
        },
        syncList: async () => {
          const r = await run('正在读取文件夹…', () => callApi('/sync/list', { targetDir: ui.syncDir.trim() }));
          if (r !== null) patch({ syncListing: r, syncResult: null });
        },
      };

      return renderPanel(ui, actions);
    }

    // ──────────────────────────────────────────────────────── 8. 导出

    return {
      /**
       * Hard gate: only `slots`. Adding a service name this kernel does not
       * provide leaves the entry pending and fails the boot audit, which
       * raises the "应用无法使用" recovery dialog.
       */
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();

        // 入口在「设置」里，不在侧边栏。
        //
        // 侧边栏最上面那一格留给高频入口（备份同步不是高频操作，占着它是浪费）；
        // 设置里的分区正好是「低频、需要完整工作区」这类功能的家。
        // 外壳（dsh-client-ui-settings-general）声明 settings.section 为 list 槽位，
        // 左栏按 order 排序，行上只读 id / order / label —— 图标由外壳按 id 内置
        // （未知 id 回退成齿轮），所以这里不用、也没法塞图标。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: PANEL_ID,
              // 内核自带：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20。
              // 排在它们后面 —— 低频入口不跟账号、模型、插件抢前面的位置。
              order: 50,
              label: PANEL_LABEL,
            },
            BackupSyncSection,
          ),
        );
      },

      /**
       * Pure helpers exposed for the offline test suite. The Host only reads
       * `inject` and `apply`; extra keys are ignored.
       */
      __internals: {
        PANEL_ID,
        PANEL_LABEL,
        MODULE_ROWS,
        DEFAULT_SELECTED,
        TABS,
        COUNT_ROWS,
        ACTION_META,
        formatBytes,
        formatCount,
        countUnit,
        shortHash,
        joinHint,
        fallbackModules,
        moduleRows,
        effectiveSelection,
        requestOutDir,
        toggleSelection,
        computeSelectionSummary,
        countRows,
        describeCounts,
        verifyDetailLines,
        authHint,
        legacyCopy,
        copyToClipboard,
        emptyResolutions,
        setAllResolutions,
        unresolvedCount,
        effectiveCounts,
        effectiveWriteCount,
        groupActions,
        archiveLabel,
        clickGate,
        formatWhen,
        scheduleSummary,
        scheduleReasonText,
        scheduleLastText,
        scheduleScopeText,
        schedulePatch,
        skillTooltip,
        skillMeta,
        skillMissingBadge,
        copyLine,
        fileRowLabel,
        fileSizeText,
        skillFiles,
        renderSkillPanel,
        renderScheduleCard,
        renderSkillDialog,
        renderFileDialog,
        FileList,
        SkillList,
        SCHEDULE_MODES,
        SCHEDULE_HOURS,
        SCHEDULE_KEEP,
        DEFAULT_SCHEDULE_FORM,
        createInitialUiState,
        callApi,
        renderPanel,
        BackupSyncSection,
        ensureStyles,
        syncTheme,
        PANEL_CSS,
      },
    };
  },
});
