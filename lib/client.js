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
 */
window.__ModuleLoader__.load({
  id: 'dsh-backup-sync',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /**
     * The one string that ties the sidebar row to the center panel: the
     * `sidebar.panellist` entry id addresses the `main` panel with the same
     * key. Never use `conversation` — it is taken by the built-in chat panel.
     */
    const PANEL_ID = 'backup-sync';

    /** Display name of the entry, shown in the sidebar's panel list. */
    const PANEL_LABEL = '备份同步';

    /** Module ids this panel will report on, in display order. */
    const MODULE_ROWS = [
      { id: 'skills', label: '技能', note: '~/.agents/skills' },
      { id: 'plugins', label: '插件', note: 'profile 依赖清单' },
      { id: 'config', label: '配置', note: 'cordis.patch.yml / AGENTS.md' },
      { id: 'memory', label: '记忆', note: 'MEMORY / USER / daily / projects' },
      { id: 'todo', label: '待办', note: 'daily / projects / 全局轨' },
      { id: 'sessions', label: '对话', note: '本地专用 · 不上云', localOnly: true },
    ];

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

    const S = {
      root: {
        padding: '20px 24px 32px',
        fontSize: '13px',
        lineHeight: 1.6,
        color: 'var(--dsh-text-primary, inherit)',
        overflowY: 'auto',
        height: '100%',
        boxSizing: 'border-box',
      },
      title: { margin: '0 0 4px', fontSize: '16px', fontWeight: 600 },
      subtitle: { margin: '0 0 18px', fontSize: '12px', opacity: 0.65 },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: '10px',
      },
      card: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
        borderRadius: '8px',
        padding: '10px 12px',
      },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      cardLabel: { fontWeight: 600 },
      cardCount: { fontSize: '12px', opacity: 0.6 },
      cardNote: { marginTop: '4px', fontSize: '12px', opacity: 0.6, wordBreak: 'break-all' },
      badge: {
        display: 'inline-block',
        marginTop: '6px',
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '11px',
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        opacity: 0.75,
      },
      foot: { marginTop: '18px', fontSize: '12px', opacity: 0.6 },
    };

    /**
     * Center-column panel body. Read-only skeleton: the real scan summary
     * arrives once the Host route exists (M2 Task 8). Owner props for the
     * `main` slot are empty; the standard hook props are not needed yet.
     */
    function BackupSyncPage() {
      return h(
        'div',
        { style: S.root, 'data-dsh-backup-sync': 'panel' },
        h('h2', { style: S.title }, PANEL_LABEL),
        h('p', { style: S.subtitle }, '可视化备份与增量导入 DSH 资产。当前为只读骨架，数据接入中。'),
        h(
          'div',
          { style: S.grid },
          ...MODULE_ROWS.map((row) =>
            h(
              'div',
              { key: row.id, style: S.card },
              h(
                'div',
                { style: S.cardHead },
                h('span', { style: S.cardLabel }, row.label),
                h('span', { style: S.cardCount }, '— 条'),
              ),
              h('div', { style: S.cardNote }, row.note),
              row.localOnly ? h('span', { style: S.badge }, '本地专用 · 不上云') : null,
            ),
          ),
        ),
        h('p', { style: S.foot }, '备份按钮与增量导入入口将在后续版本接入。'),
      );
    }

    return {
      /**
       * Hard gate: only `slots`. Adding a service name this kernel does not
       * provide leaves the entry pending and fails the boot audit, which
       * raises the "应用无法使用" recovery dialog.
       */
      inject: ['slots'],
      apply(ctx) {
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
    };
  },
});
