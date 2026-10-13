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
 *   7. BackupSyncPage (hooks + fetch)   8. exports
 */
window.__ModuleLoader__.load({
  id: 'dsh-backup-sync',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // ─────────────────────────────────────────────────────────── 1. 常量

    /**
     * The one string that ties the sidebar row to the center panel: the
     * `sidebar.panellist` entry id addresses the `main` panel with the same
     * key. Never use `conversation` — it is taken by the built-in chat panel.
     */
    const PANEL_ID = 'backup-sync';

    /** Display name of the entry, shown in the sidebar's panel list. */
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

    // ────────────────────────────────────────────────────────── 3. 样式

    const PANEL_CSS = `
.dbs-root{--dbs-line:rgba(128,128,128,.28);--dbs-accent:#4c8dff;
  height:100%;overflow-y:auto;box-sizing:border-box;padding:18px 22px 48px;font-size:13px;line-height:1.6;
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
.dbs-bar-text{font-size:12.5px}
.dbs-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:900px){.dbs-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:620px){.dbs-grid{grid-template-columns:1fr}}
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

    /**
     * Sidebar icon. The owner passes `{ size, active }` — this component
     * renders the glyph only; the sidebar owns the button, the label and the
     * selected state.
     *
     * Geometry is deliberately simple (rects + straight-line paths) so it can
     * be verified by inspection: an archive box with a downward arrow.
     */
    function BackupSyncIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        // Lid.
        h('rect', { x: 1.6, y: 2, width: 12.8, height: 3.4, rx: 1.1, fill: 'currentColor' }),
        // Box body, outlined so the arrow stays visible inside it.
        h('rect', {
          x: 2.7,
          y: 6.6,
          width: 10.6,
          height: 7.4,
          rx: 1.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        // Arrow stem.
        h('path', {
          d: 'M8 8.2v3.1',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          fill: 'none',
        }),
        // Arrow head.
        h('path', { d: 'M6.3 10.2L8 11.9l1.7-1.7z', fill: 'currentColor' }),
      );
    }

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

    function FileList(props) {
      const entries = props.entries ?? [];
      if (entries.length === 0) return h('p', { className: 'dbs-note' }, '没有文件。');
      const shown = entries.slice(0, FILE_ROWS_LIMIT);
      return h(
        'div',
        null,
        h(
          'ul',
          { className: 'dbs-files' },
          ...shown.map((e, i) =>
            h(
              'li',
              { key: `${e.relPath}-${i}` },
              h('span', null, e.relPath),
              h('span', null, e.sizeHuman ?? formatBytes(e.size)),
            ),
          ),
        ),
        entries.length > shown.length
          ? h('p', { className: 'dbs-note' }, `还有 ${entries.length - shown.length} 个文件未列出。`)
          : null,
      );
    }

    function Overlay(props) {
      return h(
        'div',
        { className: 'dbs-overlay', role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { className: 'dbs-dialog' },
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
              m.pending !== true && m.entries.length > 0
                ? h(
                    'div',
                    null,
                    h('button', { type: 'button', className: 'dbs-link', onClick: () => actions.toggleExpand(m.id) }, open ? '收起文件' : `查看 ${m.entries.length} 个文件`),
                    open ? h(FileList, { entries: m.entries }) : null,
                  )
                : null,
            );
          }),
        ),
      );

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
              placeholder: ui.state?.settings?.outDir ?? ui.state?.outDir ?? '默认：D:\\dsh-backups-sync',
              onChange: (e) => actions.setOutDir(e.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dbs-check' },
            h('input', {
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
              placeholder: `${ui.state?.outDir ?? 'D:\\dsh-backups-sync'}\\dsh-sync-<日期>-<时间>.tar.gz`,
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
              placeholder: ui.state?.settings?.syncDir ?? '例如 D:\\OneDrive\\dsh-sync 或 U 盘盘符',
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
      };
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
        throw new Error(`接口返回的不是 JSON（HTTP ${res.status}）`);
      }
      if (data !== null && typeof data === 'object' && data.ok === false) {
        const msg = typeof data.error === 'string' && data.error !== '' ? data.error : null;
        if (msg !== null) throw new Error(msg);
        // `ok:false` 但没给 error：这是业务结论，不是调用失败，原样交回调用方渲染。
      }
      if (res.ok !== true) throw new Error(`HTTP ${res.status}`);
      return data;
    }

    /**
     * Center-column panel body. Refetches on every mount: the `main` slot may
     * unmount and remount when the user switches panels.
     */
    function BackupSyncPage() {
      const [ui, setUi] = React.useState(createInitialUiState);
      const patch = React.useCallback((next) => setUi((prev) => ({ ...prev, ...next })), []);

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

        refresh: () => load(requestOutDir(ui)),

        toggleModule: (id) => setUi((prev) => ({ ...prev, selected: toggleSelection(effectiveSelection(prev), id) })),
        toggleExpand: (id) => setUi((prev) => ({ ...prev, expanded: { ...prev.expanded, [id]: prev.expanded[id] !== true } })),
        setOutDir: (outDir) => patch({ outDir }),
        setIncludeBaseline: (includeBaseline) => patch({ includeBaseline }),

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
        copyText: (text) => {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(String(text)).catch(() => {});
          }
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

        // The sidebar owns `sidebar.panellist`; `inject` waits for its
        // declaration instead of racing it.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 50,
              label: PANEL_LABEL,
            },
            BackupSyncIcon,
          ),
        );

        // Same id as the panellist entry: that is what makes the sidebar row
        // open this panel.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            BackupSyncPage,
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
        fallbackModules,
        moduleRows,
        effectiveSelection,
        requestOutDir,
        toggleSelection,
        computeSelectionSummary,
        countRows,
        describeCounts,
        verifyDetailLines,
        emptyResolutions,
        setAllResolutions,
        unresolvedCount,
        effectiveCounts,
        effectiveWriteCount,
        groupActions,
        archiveLabel,
        createInitialUiState,
        callApi,
        renderPanel,
        BackupSyncPage,
        BackupSyncIcon,
        ensureStyles,
        syncTheme,
        PANEL_CSS,
      },
    };
  },
});
