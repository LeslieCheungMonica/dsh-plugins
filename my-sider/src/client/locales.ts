/**
 * Copy for this plugin's two panels and its launcher.
 *
 * The dictionary namespace is `mysider`, registered by this plugin's apply. The
 * Chinese dictionary is the key source of truth; the English one is typed as
 * exactly the same key set, so a key added to one and forgotten in the other is
 * a type error rather than a raw key rendered to the operator.
 *
 * @module my-sider/client/locales
 */

/** Chinese dictionary (the key source of truth). */
export const zh = {
  // ── the launcher ─────────────────────────────────────────────────────
  'launcher.aria': 'my-sider 面板控制',
  'launcher.web': '侧边栏',
  'launcher.web.hint': '打开 / 关闭侧边栏：每个标签页打开一个网页地址',
  'launcher.shell': '下侧边栏',
  'launcher.shell.hint': '打开 / 关闭下侧边栏：输入并执行 bash 命令',

  // ── the web sidebar ──────────────────────────────────────────────────
  'web.title': '网页侧边栏',
  'web.newTab': '新建标签页',
  'web.tab.untitled': '新标签页',
  'web.tab.close': '关闭标签页 {title}',
  'web.close': '关闭侧边栏',
  'web.resize': '拖动调整侧边栏宽度',
  'web.address.placeholder': '输入网址，例如 https://example.com 或 localhost:5173',
  'web.go': '打开',
  'web.reload': '重新加载',
  'web.back': '后退',
  'web.forward': '前进',
  'web.external': '在浏览器新标签页打开',
  'web.mode': '加载方式',
  'web.mode.direct': '直接嵌入',
  'web.mode.relay': '宿主代理',
  'web.mode.direct.hint': '浏览器直接加载目标站点：保留该站点的登录态与脚本，但对方禁止被嵌入时页面会是空的。',
  'web.mode.relay.hint': '由 DSH 宿主取回页面再交给浏览器：能显示禁止被嵌入的站点，但页面是匿名的（不带登录态），重脚本应用可能不完整。',
  'web.empty': '还没有标签页。点上面的「+」，输入一个网址。',
  'web.empty.hint': '适合放：本地开发服务器、内部文档、公开网页。',
  'web.blocked': '该站点禁止被嵌入（X-Frame-Options / CSP frame-ancestors），直接嵌入会是空白页。',
  'web.blocked.switch': '改用宿主代理',
  'web.unreachable': '宿主无法访问该地址：{reason}',
  'web.invalid': '请输入可用的网址（http:// 或 https://）',
  'web.external.hint': '在新标签页打开',

  // ── the bottom command panel ─────────────────────────────────────────
  // No 'run' / 'runs' / 'empty' / 'noOutput' copy: there is no Run button, no run
  // tabs and no placeholder sentence in the transcript — the prompt line is the
  // whole empty state, and the shell's own status line stands in for the rest.
  'shell.title': '下侧边栏 · 命令',
  'shell.resize': '拖动调整面板高度',
  'shell.close': '关闭下侧边栏',
  'shell.placeholder': '输入 bash 命令，例如 ls -la',
  'shell.stop': '停止',
  'shell.clear': '清屏',
  'shell.waiting': '命令正在执行…',
  'shell.dir': '工作目录',
  'shell.dir.hint': '命令在这个目录下执行。这里显示的就是当前位置（默认取当前会话所在项目）；直接修改即改为其他目录，点 ⟳ 恢复默认。',
  'shell.dir.reset': '恢复默认目录',
  'shell.mode': '沙箱 {mode}',
  'shell.mode.hint': '这次运行实际使用的文件策略（由宿主解析并回报）',
  'shell.status.running': '运行中',
  'shell.status.ok': '成功',
  'shell.status.failed': '失败（退出码 {code}）',
  'shell.status.signalled': '被信号终止（{signal}）',
  'shell.status.timeout': '超时被终止',
  'shell.truncated': '输出已截断',
  'shell.truncated.hint': '宿主只保留了这条命令最近的一段输出。',
  'shell.gap': '…… 宿主已丢弃前面的 {bytes} 字节输出 ……',
  'shell.jump': '跳到最新',
  'shell.recall.hint': '↑ / ↓ 调用历史命令',
  'shell.disabled': '本部署关闭了命令面板（config.shell.enabled: false）。',
  'shell.notMounted': '命令面板的宿主路由没有挂载：请先构建插件并重启 dsh web。',
} as const

/** Every dictionary key of this namespace. */
export type MySiderKey = keyof typeof zh

/** English dictionary: exactly the Chinese key set. */
export const en = {
  'launcher.aria': 'my-sider panel controls',
  'launcher.web': 'Sidebar',
  'launcher.web.hint': 'Open / close the sidebar: every tab opens a web address',
  'launcher.shell': 'Bottom panel',
  'launcher.shell.hint': 'Open / close the bottom panel: type and run bash commands',

  'web.title': 'Web sidebar',
  'web.newTab': 'New tab',
  'web.tab.untitled': 'New tab',
  'web.tab.close': 'Close tab {title}',
  'web.close': 'Close sidebar',
  'web.resize': 'Drag to resize the sidebar',
  'web.address.placeholder': 'Enter an address, e.g. https://example.com or localhost:5173',
  'web.go': 'Open',
  'web.reload': 'Reload',
  'web.back': 'Back',
  'web.forward': 'Forward',
  'web.external': 'Open in a browser tab',
  'web.mode': 'Load mode',
  'web.mode.direct': 'Direct frame',
  'web.mode.relay': 'Host relay',
  'web.mode.direct.hint': 'The browser loads the site itself: its login state and scripts survive, but a site that forbids framing shows nothing.',
  'web.mode.relay.hint': 'The DSH host fetches the page and hands it back: framing bans no longer apply, but the page is anonymous (no login state) and script-heavy apps may be incomplete.',
  'web.empty': 'No tabs yet. Press “+” above and enter an address.',
  'web.empty.hint': 'Good candidates: a local dev server, internal docs, public pages.',
  'web.blocked': 'This site forbids framing (X-Frame-Options / CSP frame-ancestors), so a direct frame would stay blank.',
  'web.blocked.switch': 'Load through the host relay',
  'web.unreachable': 'The host could not reach that address: {reason}',
  'web.invalid': 'Enter a usable address (http:// or https://)',
  'web.external.hint': 'Open in a browser tab',

  'shell.title': 'Bottom panel · shell',
  'shell.resize': 'Drag to resize the panel',
  'shell.close': 'Close the bottom panel',
  'shell.placeholder': 'Type a bash command, e.g. ls -la',
  'shell.stop': 'Stop',
  'shell.clear': 'Clear',
  'shell.waiting': 'The command is running…',
  'shell.dir': 'Working directory',
  'shell.dir.hint': 'Commands run here. The field shows where that is (the current session\u2019s project by default); edit it to run somewhere else, or press \u21bb to go back to the default.',
  'shell.dir.reset': 'Reset to the default directory',
  'shell.mode': 'sandbox {mode}',
  'shell.mode.hint': 'The file policy this run actually executed under (resolved and reported by the host)',
  'shell.status.running': 'running',
  'shell.status.ok': 'exit 0',
  'shell.status.failed': 'failed (exit {code})',
  'shell.status.signalled': 'killed by {signal}',
  'shell.status.timeout': 'stopped on timeout',
  'shell.truncated': 'output truncated',
  'shell.truncated.hint': 'The host retained only the tail of this run\u2019s output.',
  'shell.gap': '… the host dropped the preceding {bytes} bytes of output …',
  'shell.jump': 'Jump to latest',
  'shell.recall.hint': '↑ / ↓ recalls earlier commands',
  'shell.disabled': 'This deployment switched the command panel off (config.shell.enabled: false).',
  'shell.notMounted': 'The command panel\u2019s host routes are not mounted: build the plugin and restart dsh web.',
} satisfies Record<MySiderKey, string>
