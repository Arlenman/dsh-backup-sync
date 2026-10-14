# `settings.section` 槽位契约（DSH 0.2.0-rc.2 实测）

写给「想让插件出现在 DSH 设置对话框左栏」的人。全部结论都来自本机内核源码与真机测量，
不是推断；出处标注了文件与行号（内核源码解包在 `<内核解包目录>\dsh\node_modules\@deepseek-ai\`）。

---

## 1. 槽位声明与消费

| 事实 | 出处 |
| --- | --- |
| 槽位由 `sidebar.settings` 声明：`"settings.section": { kind: "list", scope: "root" }` | `dsh-client-ui-settings-general/lib/client.js:1111-1146` |
| 消费者渲染：`active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })` | 同上 `:337` |
| **只在被选中时挂载** —— 切到别的分区会卸载，切回来重新挂载 | 同上（`only: active`） |
| 分区组件收到的 props 是 `{ close }`（一个关闭设置对话框的函数） | 同上 |
| 左栏导航行只读 `id` / `order` / `label` 三个字段，按 `order` 升序排列 | 同上 `:1016-1040` |
| `label` 直接当可见文字用，**不读 locale** | 同上（`resolveSlotLabel`） |
| 导航图标由外壳按 `id` 硬编码查表 `navIcon(id)`；**未知 id 回退齿轮图标** | 同上 `:244-267` |

⇒ **插件塞不进自定义图标**，只能用齿轮。想要别的图标只能等内核支持。

**最小可用的注册代码**：

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    { name: 'settings.section', id: 'backup-sync', order: 50, label: '备份同步' },
    SectionComponent,          // 收到 { close }，可以不用
  ),
);
```

`list` 槽位**必须**给 `id`（缺了直接抛错）；`keyed` 槽位必须给 `key`。

---

## 2. 几何尺寸（决定你的内容能用多宽）

| 元素 | 规则 | 出处 |
| --- | --- | --- |
| 面板 `.panel` | `width:800px; height:min(800px, calc(100vh - 2*max(24px, var(--dsh-frame-overlay-top,24px)))); max-width:calc(100vw - 48px)` | `dsh-client-ui-settings-general/lib/client.js` |
| 左栏 `.nav` | `width:188px; padding:22px 12px 0` | 同上 |
| 内容列 `.content` | `flex:1; min-width:0` | 同上 |
| 头部 `.header` | `height:54px` | 同上 |
| 内容区 `.options` | `flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto` | 同上 |

⇒ 内容宽 = 800 − 188 − 48 = **564px**；真机实测 **559px**（减去滚动条）。

**两条硬约束**：

1. **滚动由外壳负责**。你的根节点**不要**再写 `height:100%` / `overflow-y:auto`，
   否则会套出第二层滚动条，底部还会被外壳的 padding 截掉。
2. **不要用视口媒体查询做响应式**。设置弹窗里的视口仍然是 1920px，
   `@media (max-width:900px)` 这类规则**一次都不会命中**。
   真要按宽度折行只有容器查询一条路，但它带副作用（见第 4 节）——
   而更省心的做法是**干脆别折行**（本项目最终就改成了一列到底）。

---

## 3. 排序（本机已装分区的实测 order）

| order | 分区 | 来源 |
| --- | --- | --- |
| -10 | 账号与余额 | 内核 |
| 0 | 通用设置 | 内核 |
| 10 | 模型 | 内核 |
| 15 | 内置插件 | 内核 |
| 17 | 技能管理 | `@michengai/dsh-skills-manager` |
| 20 | Agent 预设 | 内核 |
| 30–40 | 插件市场 | `dshmarket` |
| 45 | 通知提醒 | `dsh-notify-me` |
| **50** | **备份同步** | 本插件 |
| 120 | 皮肤 | `@linxin666/dsh-client-ui-skin-center` |

⇒ **低频入口用 45–60**，会落在「通知提醒」与「皮肤」之间，也就是左栏靠下的位置。

---

## 4. 容器查询的陷阱（`contain:layout`）

`container-type:inline-size` **蕴含 `contain:layout`**，而 layout containment 会把
`position:fixed` 后代的**包含块从视口改成容器本身**。

本项目的浮层（`.dbs-overlay{position:fixed; inset:0}`）因此有一条铁律：

- 查询容器**绝不能**放在面板根节点（`.dbs-root`）上 —— 放上去，弹窗就会跟着内容滚、
  只盖住面板那一块；
- 浮层必须是查询容器的**兄弟**，不能是子孙。

**2026-10-15 之后本项目不再使用容器查询**（模块卡改一列，与宽度无关），
但这条陷阱留着 —— 单元测试仍然断言「`.dbs-root` 上不许有 `container-type`」
以及「浮层不在页签容器里」，作为将来有人再加回容器查询时的保险。

---

## 5. 驱动与测试要点

- 左栏导航行**没有** `data-*` 属性 ⇒ 只能按可见文字定位，且必须限定在
  `[data-shortcut-modal="settings"]` 里找 `button`（否则会命中页面别处的「设置」）。
- 打开设置对话框的入口按钮是 `button[class^="wCInkW_trigger"]`（类名带 hash 前缀，
  用前缀选择器）；快捷键 `Ctrl + Alt + ,`。
- **设置弹窗里的坐标点击（CDP `Input.dispatchMouseEvent`）确定性失效**：
  按钮 `disabled:false`、在视口内、`elementFromPoint` 命中的就是它本身，
  连点三轮一次都不响应；同一按钮改用页面内 `element.click()` 三次全开。
  结论：**一律页面内点击**（见 `docs/plans/2026-10-13-backup-sync-plan.md` 开发约定 23）。
- 弹窗可以叠放，定位一律取 `[...document.querySelectorAll('.dbs-dialog')].pop()`。
- 点击之后**等条件**（元素出现 / 文案变化），不要 `sleep(固定毫秒)` 再断言 ——
  本项目为此吃过三次假红（最近一次：技能弹窗实测要 ~1000ms 才渲染，脚本在 950ms 判定）。
- 分区**只在选中时挂载** ⇒ 「切走再切回会重新取一次状态」，计数不会停在旧值上；
  反过来说，**任何一次性初始化都必须放在组件挂载时**，不能指望它在后台常驻。

---

## 6. 与其他入口的关系

同一个插件可以同时挂多个槽位，但**不要**给同一个功能挂两个入口
（本项目原来挂了 `sidebar.panellist` + `main`，搬到 `settings.section` 后
把前两个和侧边栏图标一起删了，否则会出现两套入口、两套状态）。

`main` 槽位（整屏工作区）的 `key` **不能**用 `'conversation'`（内置对话占用，
该槽位 `replaceRisk` 为 `shadows-shipped-ui`）。
