# 会话记录：侧边栏适配说明归档 + 全局规则落地

- 日期：2026-09-17
- 项目空间：`/Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui`（git 仓库根是 `/Users/liyanhui/vscodeProjects/dsh-plugins`）
- 环境：DSH `0.1.0-rc.8`（检出 `/Users/liyanhui/vscodeProjects/deepseek-harness`，profile 在 `~/.dsh/profiles/web`）

## 一、这次会话做了三件事

### 1. 归档「适配 DSH 原生侧边栏 API」的说明

把口头说明整理成结构化中文笔记，写入 `.docs/native-sidebar.md`：要点表（右列归属、`ctx.sidebarRightTabs` 注册、`ctx.sidebarRight` 打开、文件走 `ctx.sidebarRight.openResource('dsh-resource://file/…')`、移除自绘右面板与旧浮窗、底部工作台与 `ctx.betterSidebar` 不变），末附原始文字留档。

**核对结果（重要）**：这份说明与本地代码不符——

- 在 `dsh-web-ui`、`my-sider`、整个 `dsh-plugins` 里都**搜不到** `sidebarRight` / `sidebarRightTabs` / `betterSidebar`；`my-sider` 当前对外的服务名是 `ctx.webSidebar`（`src/client/index.tsx:68-75`）。
- 本地 DSH 检出与已安装的 `dsh` 都是 `0.1.0-rc.8`，检出里也没有该 API；说明里写的「v0.19.0 起、DSH 0.1.5-rc.1+」在本地无从印证。

结论：该说明目前只能当**目标态/规格**看待，不是已落地状态。要落地属于新功能，需先过设计。

### 2. 查清「会话开始注入全局规则」有没有现成通道

结论：**不用写钩子，DSH 已内置**。三条路按省事程度排序：

| 方案 | 机制 | 代价 | 结论 |
| --- | --- | --- | --- |
| ① 放 `~/.dsh/AGENTS.md` | `@deepseek-ai/dsh-agent-instructions` | 零代码 | **采用** |
| ② 自写 Cordis 插件挂 `agent/session-start` | 类型化拦截点 + `agent.inject()` | 一个插件（约几十行） | 留作需要动态生成规则时再用 |
| ③ Claude Code / Codex shell 钩子桥接 | `hooks-claude-code` 把 `SessionStart` 映射到 `agent/session-start` | 桥接未默认挂载 + 已知缺陷 | 为塞固定文本不值得 |

内置加载器的行为（依据 `docs/config-catalog.md:107-133`、`packages/context/agent-instructions/README.md`）：

- 用户全局文件**固定**是 `$DSH_HOME/AGENTS.md`（= `~/.dsh/AGENTS.md`，无 local 覆盖层）；项目侧从项目根到会话 cwd 逐层读 `AGENTS.md` / `CLAUDE.md`，以及 `AGENTS.local.md` / `CLAUDE.local.md` 覆盖层。
- 触发点：每个 live session 的**第一次 `agent/pre-step`**，baseline 折进第一批消息，与首句提示词一起进 step 1、进第一个请求；resume 复用可见 baseline 只补差异。
- 预算 `maxBytes: 65536`（64 KiB）；超限先丢粗粒度文件，并在消息里明示被省略/截断的路径。
- 成功 `read`/`write`/`edit` 会触发核对：改文件 → `Updated instructions from: …`；删文件 → `Instructions removed: …`。没有 file watcher。
- profile 根那行 `agent-instructions` 是 `disabled: true`（`packages/bundle/web-app/cordis.patch.yml:422`），目的是避免每个 preset 各挂一份互相打架；真正的挂载在各 agent preset 里（`apps/cli/config/agent-presets/{standard,code,cordis}/agent.cordis.yml:30` 附近，`minimal` 没有）。

钩子路线的事实（依据 `packages/core/agent/README.md:51`、`packages/core/agent-loop/tests/interception.spec.ts:726`、`packages/hooks/hooks-claude-code/README.zh.md:39,90`）：

- `agent/session-start({ agent, source })` 是**第一个受支持的启动注入点**，`source` 只有 `'startup' | 'resume'`（`'clear'`/`'compact'` 预留未发射）。
- 它**同步、无否决权**，所以同步 `agent.inject()` 赶得上第一个请求；反过来，需要「异步查完再启动」的组合必须写在 factory 的 `setup(agentCtx)` 事务里，不能靠这个点。
- CC 桥接的 `SessionStart` 是**脱离运行**的，官方 README 自认上下文可能错过第一个请求（`TODO(session-start-gating)`），且只消费 JSON `additionalContext`；桥接在 `packages/bundle/*/cordis.patch.yml` 里没有默认挂载。

### 3. 建立并收敛全局规则文件 `~/.dsh/AGENTS.md`

- 第一版（1772 字节）：我按仓库里观察到的习惯拟了满配规则（中文交流/英文代码、提交格式 `<模块名>：<中文摘要>`、不擅自 commit/push、typecheck + smoke/harness 验证、pnpm/tsdown、不动 3080 服务等），逐条附证据后在会话里给用户确认，批准后写入。写入即被加载器注入当前会话，**实测链路通**。
- 第二版（218 字节，当前生效）：用户澄清「目前只有一条全局规则」，于是删掉其余全部推断规则，只留文档落点这一条：

```markdown
# 我的全局规则

- 我主动要求写的文档，统一放到当前项目空间目录下的 `.docs/` 目录里，便于集中管理。
  （不是我要的文档，例如代码注释、README，不受此限。）
```

- 实测确认了热更新的**替换语义**：注入帧为 `Updated instructions from: ~/.dsh/AGENTS.md` + “Use the following content instead of the previously loaded instructions”，即上一版的长规则在同一会话内同步失效。

## 二、过程中确认的环境事实（可复用）

- profile `~/.dsh/profiles/web`：bundles = `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-git-plugins`、`dsh-stage-gate`、`dsh-superpowers`、`dsh-better-sidebar`。
- `~/.dsh/settings.yaml`：默认模型 `deepseek-official / deepseek-v4-flash`（reasoningEffort high），主题 dark；没有 `agent-presets` 节点（即用 preset 默认值）。
- `dsh-plugins` 是**单个 git 仓库**（子目录不是独立仓库），作者 `李彦辉 <li.yh9@asiainfo-sec.com>`；无 CI、无 lint/format 配置，实际门禁是 `pnpm typecheck` 与 `scripts/smoke*.mjs` / `pnpm harness:*`。
- `dsh-web-ui` 下的 `.claude`、`.lingma`、`.qoder`、`.trae` 目录**都是空的**（`.agents/skills/` 里放的是技能，不是规则）。
- `~/.dsh/sessions/` 里的会话日志中搜不到 `agent-instructions` 事件——因为此前 `~/.dsh/` 和这些项目里一个 `AGENTS.md` 都不存在，没有内容可注入。
- `.docs/` 目录**没有被 `.gitignore` 忽略**，当前状态是未跟踪（`?? .docs/`）。

## 三、未决 / 后续可做

1. **`sidebarRight` 适配是否真要落地**：本地代码与安装版本都对不上说明文字。要做得先确认 DSH 侧确有该 API 与版本，再按新功能走设计。
2. **其他工具的规则文件**：`.claude` / `.lingma` / `.qoder` / `.trae` 是否要各放一份等价规则文件（本文件只对 DSH 生效）。
3. **`.docs/` 是否入库**：目前未跟踪、未忽略；要纳入版本管理就 `git add`，要本地私有就加进 `.gitignore`。
4. **全局规则是否要补回工程类约束**：提交格式、验证要求等已按用户要求删除，现属「靠会话内默认判断」状态。

## 四、产出文件清单

| 文件 | 说明 |
| --- | --- |
| `.docs/native-sidebar.md` | 侧边栏原生 API 适配说明的总结 + 原文留档（2333 字节） |
| `~/.dsh/AGENTS.md` | 全局规则，当前仅一条文档落点规则（218 字节） |
| `.docs/session-summary-2026-09-17.md` | 本文件 |
