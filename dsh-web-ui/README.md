# dsh-web-ui

A DeepSeek Harness **web UI plugin** that replaces the left column and re-skins
the shell:

- the **sidebar column is this plugin's** — header, geometry, spacing, rail;
- a **project dropdown** (`项目 / current project`) and a **New Project** button
  sit at the head of the column, above the FDE stage tag and the New Session
  button;
- the session list below them shows **only the selected project's sessions** —
  no other project's sessions appear, and switching projects re-scopes it;
- the New Session button starts its session **in the selected project**;
- an **FDE stage tag** sits between the project row and that button, showing where
  the project is in the delivery flow — and opens the flow itself, node by node,
  when clicked (see [The FDE stage tag](#the-fde-stage-tag));
- choosing a project's folder is the **New Project form** (`+` in the project
  row, or `新增项目…` in its menu): name the project, choose a local folder as
  its workspace, and say whether it is a new product, an existing one, or not
  decided yet — then the folder is registered as a DSH workspace and a session
  opens in it (see [The New Project form](#the-new-project-form));
- the **lower half of the column is the Feishu document panel**: the selected
  project's own folder in Feishu — the one created when the project was created —
  with the signed-in `lark-cli` user, its subdirectories and documents one lazy
  level at a time, and the actions for a project that has no folder yet (see
  [The Feishu document panel](#the-feishu-document-panel));
- a **Git button sits in the session header's right-hand utilities** and opens a
  right-hand drawer for the current session's project: branches, changes, commit
  history, and a journal of every git command the drawer ran (see
  [The git drawer](#the-git-drawer));
- the shipped **settings panel and brand** keep rendering — inside this plugin's
  column, unchanged;
- the plugin appears as `web-ui` in **Settings → Plugins → Plugin list**.

## The project scope

The column is scoped to ONE project, and that scope is a single fact both the
header and the list read (`src/client/project.ts`):

- **the dropdown writes it** — picking a project scopes the list. It does NOT
  mint a session (the shipped browser's picker does, which is why the shipped
  flow leaks empty sessions); open a session, or press New Session, to work.
- **it follows the current session** — open a session in another project and the
  scope moves there, so the list always contains the session you are looking at.
- **a manual pick holds** until the session moves again, and the value is
  persisted, so a reload keeps the project you were browsing. A stored value
  that no longer resolves (deleted workspace) falls back to the current
  session's project, then to the most recently active one.

Membership is the project's own account (`WorkspaceView.sessionIds`) plus any
session whose `cwd` is the project's path, so a session that failed to attach
still shows up here instead of nowhere. Visibility follows the shipped tree's
rules: subagent-origin rows never appear, archived sessions are hidden behind a
*Show archived* toggle, and among blank sessions only the current one does.

### What the project-scoped list keeps, and what it drops

It shadows the shipped workspace browser (`sidebar.workspaces`), because that
browser groups every project together and publishes no filter hook — a scoped
list is a different projection of the same stores, not a setting of it. Kept:
open, live status dot (waiting / running / running subagents / finished), the
current-session highlight, search, rename, archive. Dropped on purpose: fork, the
host-side content search, manual reordering, and the per-workspace
expand/collapse tree. Project **edit and delete** moved to the dropdown, which
carries them as rows acting on the selected project (the shipped browser used to
own the rename dialog). The dropdown's rows are: the projects, **新增项目…**, then
**编辑项目…** and **删除项目** for the selected one — see
[Editing a project](#editing-a-project) for what the edit form changes.

The list has **no header row**. It used to open with one naming the selected
project — which the dropdown directly above the New Session button already names,
so it was a second copy of one fact — and then with that same row carrying the
session count alone, which spent a row of the column on a number. The count now
rides the SEARCH row (`[data-wui='sessionCount']`, beside the field, never
wrapping and never shrinking — the field gives up the room instead), so the list
starts with a control the operator uses. What the scope is stays visible:
`data-project` on the list carries it, the count's tooltip carries the project's
path, and the dropdown trigger keeps that path in its own tooltip and spells it
out in its menu.

`project` is this plugin's word for a DSH **workspace**: a host-registered
directory whose sessions share its path.

## The FDE stage tag

Directly above **New Session** sits one row carrying the project's stage in the
FDE delivery flow (`src/client/StageTag.tsx`, `src/client/stage.ts`):

```
◔ 需求明确                        3/6  ⌄
```

Clicking it opens the flow itself, top to bottom, in delivery order: 需求明确 →
技术选型与详设 → 代码开发与自测 → 测试环境验收 → 上线部署 → 上线验收.

What the panel says is POSITIONAL, and that is the whole rule — one index decides
every node, so nothing can go inconsistent:

| Where a stage sits | Marker | Connecting rail | Row |
|---|---|---|---|
| behind the current stage | filled green disc with a white check | green on both sides | plain, **已完成** |
| **the current stage** | the same disc, a size larger, breathing a halo | green above, grey below | tinted, bold label, **运行中** |
| ahead of the current stage | hollow grey circle | grey on both sides | greyed out, **待开始** |

- **The tag's ring is the reached share of the flow** (1/6 … 6/6, the current
  stage counting as reached), so the column states progress with the panel shut.
- **Clicking a node moves the project to that stage.** The panel stays open and
  re-states the flow around it, which is the feedback for the click.
- **The stage is per PROJECT**, keyed by workspace id in `localStorage`, for the
  same reason the project selection is a client fact: nothing on the host records
  delivery progress, and inventing a record would make the tag claim work the
  operator has not done here. A project with no record starts at 需求明确. A
  record the plugin cannot trust — a truncated write, a hand-edited value, a stage
  index that no longer exists — degrades to the first stage and is repaired by the
  next click, never by an error.
- **In the rail** the tag becomes a 36px square carrying the ring alone (no words
  fit in the track), and its `aria-label` still names the stage and the step, so
  collapsing the column hides the flow's words without losing the flow.

The panel is PORTALED to the page body and positioned from the tag's viewport
rect, because the column clips its own overflow — it is a sliding track — so an
in-place panel would be cut off at the 56px rail edge. That portal explains two
things the component has to own rather than inherit:

- **the outside-click dismiss checks BOTH the trigger and the panel**, since the
  shared `useDismissOnOutsidePointer` takes a single root and would close the
  panel on every click *inside* it;
- **opening moves focus onto the running stage**, and only once the panel has been
  PLACED — it is `visibility: hidden` until then, and a hidden subtree cannot take
  focus at all. Without the move, Tab from the trigger would land on the New
  Session button and walk away from the panel the operator just opened.

## The git drawer

The frame carries an **action bar**: one always-on group of panel controls,
pinned under the deploy's account chip at the top-right. It currently carries one
control.

| Control | What it does |
|---|---|
| **Git** | opens the drawer below — the branch / changes / history / journal panel for the current session's project |

Two further controls were built and are **off**, at the operator's request:

- a **right-panel** control for the frame's `details` column (the tool-call
  inspector). Its machinery is gone with it — it was a dozen lines, and the
  column belongs to `ui-conversation`, which already opens it when a tool call is
  clicked, so removing the control restored the previous behaviour exactly.
- a **terminal** control for the bottom command bar. **Its implementation is
  intact** — see [The bottom command bar](#the-bottom-command-bar) — but nothing
  imports its component (so it is not in the client bundle at all) and the host
  registers none of its routes unless the plugin row opts in.

The bar is ONE registration into `shell.overlay`, a root-scope additive
click-through list seat, and that single-ness is the design:

- **One place, both states.** The bar lives in the frame, not in the session
  header, so it does not come and go with the header's chrome. A blank session's
  hero renders the header as `display: none` — the state a brand-new project
  opens in — and a control that lived in the header would vanish exactly there.
  The account chip it sits under has the same two homes (fixed in the corner with
  no session, in the header flow with one) and lands in the same place either
  way, so "under it" is one position, not two.
- **No shared state to lose.** With one registration the drawer's open flag is
  ordinary component state. An earlier two-trigger version needed a hand-rolled
  observable because the slot core refuses one store handle under two scopes
  (*"one handle, one scope"*) — the second registration threw, the throw was
  caught to protect the page, and the header button silently did not exist. One
  registration removes the whole failure mode.
- **The bar asks the shell, not itself.** Whether the details column is open is
  the shell's fact, and the shell also changes it on its own. The bar reads the
  frame's published `data-details-collapsed` marker rather than tracking a flag
  that would disagree with the frame within one click and turn the next one into
  a no-op. It distinguishes *"no shell yet"* (the first render, before the frame
  is committed) from *"the shell says open"* by the root outlet's own
  `data-slot="root"` marker — conflating those two was a real bug: the control
  guessed "open" on the first render and its first click called `closeDetails()`
  on an already-closed column.

It is about the **current session's project**: the repository is resolved from
the workspace that accounts for the open session, so switching sessions switches
repositories without a picker.

### Host half (`src/host/git.ts`, `src/host/git-routes.ts`)

A browser cannot run `git`, so the drawer only ever asks questions:

| Route | Answers |
|---|---|
| `GET /dsh-web-ui/git/overview` | repository identity (root, git dir, in-progress operation), HEAD (`branch`, `upstream`, `ahead`, `behind`), change counts, remotes, stash and tag totals |
| `GET /dsh-web-ui/git/branches` | every local and remote-tracking branch, with upstream, ahead/behind, `gone`, tip commit and tip date |
| `GET /dsh-web-ui/git/log?limit=&ref=` | one page of commit history (`1`–`200`) |
| `GET /dsh-web-ui/git/commit?sha=` | one commit's metadata, `--numstat` per-file counts, and its patch |
| `GET /dsh-web-ui/git/changes` | every changed path with both status letters, the stash stack, and the action in flight |
| `GET /dsh-web-ui/git/diff?file=&staged=&ref=` | one path's unified diff (refused with a reason for an untracked path) |
| `GET /dsh-web-ui/git/records` | this plugin's journal for that repository |
| `POST /dsh-web-ui/git/action` | one mutation, selected by `action` and parameterised by `args` |

The mutation set is 30 verbs: `init`, `remote-add` / `remote-set-url` /
`remote-rename` / `remote-remove`, `checkout`, `create-branch`, `rename-branch`,
`delete-branch`, `merge`, `rebase`, `cherry-pick`, `reset`, `fetch`, `pull`,
`push`, `push-branch`, `stage`, `unstage`, `discard`, `clean`, `commit`,
`amend`, `stash-save` / `-pop` / `-apply` / `-drop`, `tag-create`, `tag-delete`,
`abort`.

`init` is the one action that runs in a directory which is **not** a work tree
yet — that is the whole point of it — so it is the one action whose directory is
not resolved to a work tree first. Every other action refuses outside a
repository with a `not-a-repo` value.

Four rules shape the host half, and each one is load-bearing:

1. **No shell, ever.** Every command is a `spawn('git', argv)` with an array
   built on the host, and every path travels after `--`. The drawer sends a
   directory, a branch name, and a message; a shell string built from those would
   be a remote-code-execution surface, and an argv array is not.
2. **Names are validated by git, not by a regex here.** A branch name goes
   through `git check-ref-format --branch`, a revision through
   `git rev-parse --verify`, and a tag through `git check-ref-format
   refs/tags/…`, because git's rules are the only correct ones. Anything
   starting with `-` is refused everywhere, which is how an argument becomes an
   option.
3. **A domain failure is a value, not a status code.** "Not a repository", "the
   merge conflicted", and "your branch is behind" come back as HTTP 200 with
   `{ ok: false, error }`, because they are *content* the drawer renders where
   the button was pressed. A 500 stays reserved for a bug in this plugin.
4. **Every mutation is journalled**, in a bounded per-repository ring held by the
   service instance (not module state, so a reloaded plugin does not inherit the
   previous process's claims about what *it* ran).

Reads are briefly cached (2 s) so opening the drawer costs one `git status`, not
one per tab; a settled mutation invalidates the whole cache for its repository,
so a reader never sees the tree it just changed.

### Requirements and limits

- `git` must be on the host's PATH; the `git` plugin suite below is *not*
  required — the drawer shells out to the same binary directly.
- Authentication is whatever the `git` CLI already has. Commands run with
  `GIT_TERMINAL_PROMPT=0`, so a fetch needing credentials **fails with git's own
  message** instead of holding the request open.
- The drawer shows **no** blame, interactive rebase, conflict resolution editor,
  or submodule support. A conflict is surfaced as a bucket plus an *abort*
  action; resolving it is the operator's job in an editor.
- The journal is in memory: restarting `dsh web` clears it.

## The bottom command bar

> **Currently OFF.** The bar has no terminal control, and the host registers none
> of the routes below, because this plugin's row does not set
> `terminal.enabled: true`. The implementation is kept whole and still
> type-checked; enabling it is two edits, described at the end of this section.

The **Terminal** control opens a panel pinned to the bottom of the viewport. It
is a **command bar, not a terminal emulator**: one command line at a time, no
pty, no full-screen curses programs, no interactive prompt. That scope is stated
in the UI rather than implied — the input is a command LINE, and the header shows
the sandbox mode the commands actually run under.

What it does:

- **Run a command line** in the current session's project, with `bash -lc` (a
  login shell, so the operator's PATH applies).
- **Watch its output**, stdout and stderr merged, in the pane. Output follows the
  tail while the operator is at the tail; scrolling up stops the follow and
  reveals a *jump to the end* control.
- **Stop it** — the only way to end a command that has not decided to end.
- **Keep the last few runs** in a strip: each with its status dot, click to
  switch. The list survives a page reload, because the host still holds it.
- **Recall typed lines** with ↑/↓ in the input.

### Sandbox, and why the mode is on screen

The command line is the one input on this plugin's surface that a shell
evaluates — quoting, pipes and globs are the point of a command bar, and
pretending otherwise would make it useless. So the consequences are handled
rather than wished away:

- the argv goes through `ctx.sandbox.confine` with the policy `ctx.sandboxPolicy`
  resolves, whose workspace boundary is the project directory;
- by default that is a **sessionless** resolve, which yields the **deployment's
  configured mode** — deliberately *not* the running session's own override,
  because a command typed into this bar belongs to no agent session. On this
  deployment that resolves to `workspace-write`, so commands are confined to the
  project directory even though the session beside them may run wider;
- `config.terminal.mode` pins it instead (`read-only` / `workspace-write` /
  `danger-full-access`), and `danger-full-access` skips confinement entirely;
- **the mode a run executed under is reported on every run and shown in the
  panel header.** Confinement the operator cannot see is confinement that turns a
  write failure into a mystery.

### Host half (`src/host/term.ts`, `src/host/term-routes.ts`)

| Route | Answers |
|---|---|
| `POST /dsh-web-ui/term/run` | starts one command; answers with the run's id and state |
| `GET /dsh-web-ui/term/poll?id=&from=` | everything the run produced after byte offset `from`, plus the offset to send next |
| `POST /dsh-web-ui/term/kill` | stops one run (safe on a command that already exited) |
| `GET /dsh-web-ui/term/list` | every run the host still holds, newest first |

**The transport is polling, not SSE** — a deliberate trade. A command's output is
bursty, a 400 ms poll is indistinguishable from a stream at human scale, and it
keeps the transport to the same plain request the rest of this plugin uses: no
long-lived sockets to be buffered by a proxy, capped by a browser, or leaked when
a panel unmounts. Offsets are **absolute**, so a reader that reloads or falls
behind asks again from where it was.

Output lives in a bounded per-run ring. `bytes` counts every byte ever produced,
so an offset stays meaningful after the host drops the front of the buffer: a poll
whose offset slid out of the window is answered from the window's start and the
panel prints a gap line there, rather than a silently short log. The window's cut
is adjusted to a character boundary, so a retained tail never begins mid-codepoint.

### Turning it back on

Two edits, and one of them is a config flag because a disabled feature must not
leave a live command-execution endpoint registered:

1. **The host.** Add the config block below to this plugin's row in the profile
   patch. `enabled` is the switch; while it is false (the default) none of the
   four routes exist, so there is nothing to reach even by hand.
2. **The client.** In `src/client/ActionBar.tsx`, add a `BarButton` for it beside
   the Git one (five lines, copied from it) and mount `<TerminalBar>` beside
   `<GitPanel>`. Nothing else changes: `TerminalBar.tsx`, `termapi.ts`,
   `src/host/term.ts`, and `src/host/term-routes.ts` all stay compiled and
   type-checked while the feature is off.

```yaml
- id: dsh-web-ui
  name: dsh-web-ui
  config:
    terminal:
      enabled: true       # the switch; false (default) registers no routes
      mode: auto          # auto | read-only | workspace-write | danger-full-access
      timeoutMs: 900000   # one command's budget before it is terminated
      bufferBytes: 262144 # output retained per run (the tail)
      shell: /bin/bash
      history: 20         # settled runs the host remembers
```

Values are validated at boot and a bad one fails loudly with the field named
(this plugin carries no runtime dependencies, so the check is hand-written rather
than a schema).

While off, the panel's stylesheet block (~6.8 KB of source CSS) still ships in
the injected stylesheet — the cost of keeping `TerminalBar.tsx` re-enable-able
without also restoring its rules.

## The Feishu document panel

The column's lower half is a Feishu (Lark) **folder** browser: it shows the
Feishu folder that belongs to the project this column is scoped to — the folder
this deployment created for the project when the project was created. It is the
one part of this plugin that needs the **host**: a page cannot run `lark-cli`, and
Feishu credentials must not reach a browser. So the work is split.

**Host half** (`src/host/lark.ts`, `src/host/routes.ts`, mounted by `apply`):

| Route | Answers |
|---|---|
| `GET /dsh-web-ui/lark/state` | the signed-in user (`auth status` + `contact +get-user`) |
| `GET /dsh-web-ui/lark/folder?path=…&name=…` | **which folder this project owns** — from the project's record, or adopted from the archive by name (below) |
| `GET /dsh-web-ui/lark/files?folder=…&pageToken=…` | one page of one folder's children (`drive files list`, page size 50) |
| `POST /dsh-web-ui/lark/folder` `{path, name?}` | create the project's folder in the deployment's Feishu archive folder, **and record it** — see [The project's Feishu folder](#the-projects-feishu-folder) |
| `POST /dsh-web-ui/lark/folder/attach` `{path, folderToken, name?, url?}` | use a folder the archive already holds for this project |

Three properties make that seam safe to expose to a page:

- **no shell** — every call is `execFile` with an argv array, and tokens are
  validated against the CLI's own alphabet first (in `createFolder`, in the
  `files` route, and in `attach`), so nothing from a query string can become a
  shell word or a folder name;
- **serialized** — the CLI refreshes an expiring user token on the first user
  call, and two concurrent refreshes race on one credential file, so calls go
  through one queue;
- **failure is data** — a missing binary, an expired login, a login missing a
  scope, a transport failure (the CLI's own `"type": "network"`), and a stale
  token are returned as typed codes the panel renders, never as an empty list or
  a 500.

**Browser half** (`src/client/LarkDocsPanel.tsx`) renders the header strip (user
name + avatar + the project's folder name as a link into Feishu + refresh), then
the tree. The host answers "which folder?" with one of four outcomes, and each
one owes the operator a different affordance:

| Outcome | What the panel shows |
|---|---|
| `record` / `adopted` | the folder's contents, one lazy level per expansion |
| `missing` | *this project has no folder in the archive yet* — plus **create it**, or paste the link of one that already exists |
| `ambiguous` | every same-named folder found, each with **use this folder** and a link |
| a Feishu failure | the reason, plus the fix for that reason (a missing scope names the scope) |

An entry whose `type` is `folder` — or a `shortcut` whose target is a folder —
behaves as a **directory** (the row expands and fetches that level); anything
else is a **leaf** (the row opens its Feishu link in a new tab, as does the hover
button). One level is one request, results are cached briefly on the host, and
every in-flight read carries the generation it was issued in — a reply that lands
after a refresh or a project switch is dropped rather than painted into the new
project. The recursion carries its own ancestry, so a shortcut pointing back up
its branch renders as a row that opens instead of one that expands: a listing is
remote data, and remote data does not get to decide this component's stack depth.

Notes for operators:

- **`space:document:retrieve` is required** on the `lark-cli` login to list a
  Drive folder's contents. A login made for the older knowledge-base panel may
  not carry it; the panel then says so and names the scope, and the fix is
  `lark-cli auth login --scope "space:document:retrieve"`. Creating a folder
  still needs only `space:folder:create`, and adopting an existing one needs the
  listing scope too, because it is a listing;
- a folder can be **empty** — the panel says so, which is the honest answer;
- `DSH_WEB_UI_LARK_CLI` pins the executable path when it is not on `PATH` (the
  host also probes `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`);
- the routes are **optional capability**: `apply` reaches `webServer` through
  `ctx.inject(['webServer'], …)`, so a deployment without one keeps the whole
  sidebar and simply has no document panel;
- the host half is loaded by the Loader **once per process**: editing
  `src/host/**` needs `dsh web` restarted, while the browser half only needs a
  rebuild and a reload.

## The New Project form

`+` in the project row (and `新增项目…` in its menu) opens a form
(`src/client/NewProjectDialog.tsx`) instead of jumping straight to the OS folder
dialog. It asks the three things a project needs a record of:

| Field | What it is |
|---|---|
| **项目名称 / Project name** | the workspace's TITLE — what the column shows. The folder is where the code is; the name is what the project is called. |
| **工作空间目录 / Workspace folder** | an existing absolute directory, chosen the old way (below): the host's native chooser, or this plugin's in-app browser when the host has none. |
| **产品背景 / Product background** | one of **新项目** (new product), **已有产品** (existing product), **不确定** (not decided yet). |

**`已有产品` reveals a fourth row: the product card** (`产品卡`). The cards come
from the HOST (`GET /dsh-web-ui/lark/cards`, see
[Editing a project](#editing-a-project) for where that list comes from), so the
row is a real `<select>` when the deployment configured a catalogue, and says
"no cards configured" — not an error — when it did not.

Two behaviours are worth stating because they are not obvious from the layout:

- **the draft lives in the flow, not in the dialog** (`projectFlow.ts`). The page
  has one modal layer, so opening the in-app browser CLOSES the form; the folder
  it reports comes back to a form that still holds everything already typed, and
  an empty name field takes the folder's last segment as its default (the same
  name the host would have derived).
- **nothing is created until the form is submitted.** Feeding in a path is one
  field, not a project: `workspace.create` runs on confirm, and the project name
  follows as `workspace.rename` only when it differs from the folder's own last
  segment — a form left at its defaults costs no second round trip.
- **the submission also RECORDS the project** (`POST /dsh-web-ui/lark/project`):
  a DSH workspace holds a path and a title, so the background and the card are
  stored by this plugin — otherwise the edit form would prefill from a record
  that was never written.

## Editing a project

The dropdown's **编辑项目…** row opens the same form that creates a project, in
EDIT mode: it prefills from what was recorded and saves over it. The menu no
longer has a rename row of its own (the name is one of the form's fields) and no
longer has a "browse folders" row (choosing a directory is the form's folder
field, for a project that is being created).

What the form changes, and what it refuses to:

| Field | Behaviour while editing |
|---|---|
| Project name | Editable. Saved through `workspace.rename`, so the sidebar, the workspace title and the Feishu folder name all move together |
| Workspace directory | **Read-only.** A workspace IS its path and sessions belong to it, so "changing the folder" would not edit a project — it would move it and orphan its history. The form says so instead of offering a chooser |
| Product background | Editable: 新项目 / 已有产品 / 不确定 |
| Product card | Editable, and asked only for 已有产品 — the same conditional row as in creation. A card that was recorded but is no longer offered stays selectable rather than being silently dropped |

**Where those answers live.** A DSH workspace is `{ path, title }` and nothing
else, so this plugin keeps its own record beside the harness's storages:

- `~/.dsh/storages/web_ui_projects.json` (or `DSH_WEB_UI_PROJECTS_FILE`), one
  document, records keyed by the project's **path** — what the operator
  recognizes and what survives a registry rebuild;
- each write goes through a sibling temporary file and a rename, so a crash
  mid-write leaves the previous records intact;
- `GET /dsh-web-ui/lark/project?path=…` reads one record (`null` when the project
  has none, which is a real state for projects that predate this store), and
  `POST` writes one;
- the record's `name` is a COPY of the registry's title, kept so the edit form can
  prefill; the registry stays the authority, and the same save writes both — the
  rename first, because it is the half the operator sees.

**The product-card catalogue** is deployment data, served to the form by
`GET /dsh-web-ui/lark/cards` from, in order: `DSH_WEB_UI_PRODUCT_CARDS` (inline
JSON), then `products.json` beside the project records, else an EMPTY catalogue —
which the form renders as "no cards configured", not as an error. A malformed
catalogue is reported as a failure, because "you have no cards" and "your cards
file is broken" are different problems. Two of the form's three background
answers need no card, so an unconfigured deployment is a usable one.

## The project's Feishu folder

Creating a project also creates a **same-named folder in this deployment's
Feishu folder** — the archive folder
`https://asiainfo-sec.feishu.cn/drive/folder/IE6SfqKh3lRv2odSLkHccYh5nog`
(`FDE实施资产沉淀汇总`), where every project gets one directory of its own.

It is a side effect of the flow, never a gate on it
(`src/client/projectFlow.ts` + `POST /dsh-web-ui/lark/folder`):

1. the form's confirmed path is registered and a session opens in it — the
   project is usable;
2. the folder request is fired, **not awaited**, and reports itself: a creation
   through the shell's **system banner** (top center, portalled to `document.body`,
   fades on its own — the same transient surface the shipped UI uses), and a
   FAILURE through a warning strip under the project row, because a failure
   carries a fix (a permission, a re-login, the network) that has to stay on
   screen until it is read.

A Feishu outage therefore costs a notice, not a project. Neither report is a row
of the column when things go right: the sidebar is a navigation surface, and a
success there would push the session list down for four seconds on every project
creation. A repeated success re-announces itself (the banner is keyed per show).

**No duplicate check on the CREATE path, on purpose.** The host does not look for
an existing folder of that name before creating: it calls `drive +create-folder`
once and reports what Feishu made (`createFolder` in `src/host/lark.ts`). Feishu
Drive accepts two sibling folders with the same name and never refuses the
second, so "already taken" can never be an answer a create call receives — the
only way to know is to LIST the parent. The consequence is deliberate and worth
stating plainly: **if a folder of that name is already there, POSTing creates a
SECOND one**. Re-adding the same project adds a folder rather than reusing the
first.

**The panel is where looking happens.** `GET /dsh-web-ui/lark/folder` is the
other half of that decision, and it is what makes the panel show the folder a
project already owns:

1. the folder's token is **recorded on the project** when it is created
   (`larkFolderToken`/`larkFolderUrl` in `~/.dsh/storages/web_ui_projects.json`),
   so the common case is answered from the record — no listing, and not affected
   by a later rename in Feishu;
2. a project with **no recorded folder** (created before the plugin recorded one,
   or whose create failed) makes the host read the archive once and look for
   folders whose name IS the project's name. Exactly one match is **adopted**: it
   is written to the record, so the project shows the folder it created instead
   of a fresh duplicate, and the lookup happens once rather than on every open;
3. **none** and **several** are reported as states rather than guessed at — the
   operator is offered *create a folder* or *paste the link of one that exists*,
   and for several, the candidates themselves. This plugin cannot tell "the
   folder is gone" from "someone renamed it in Feishu", and between two
   same-named folders it has no basis to prefer one.

**The folder is named after the PROJECT.** The panel sends the project's
`name` — what the operator typed into the New Project form, which is also the
workspace's title and what the sidebar shows — and that is the folder's name. It
is deliberately not the directory's last segment: the form's name field only
SUGGESTS that segment, so a project called `陕西代码模型` living in `~/work/sx-model`
gets `陕西代码模型` in the archive. `path` travels with the name so a request still
makes sense without a title, and the path's segment is the fallback when the
panel has no name to send. The same name is what the archive is searched for when
adopting.

**The parent is the host's decision.** The host always uses its own configured
parent token, so a caller cannot address another folder — a browser-supplied
parent would let the page write anywhere the login can reach. The `name` itself
is validated as a NAME rather than as a path (a separator, `.` or `..` is a 400,
never a silent rewrite), because the sidebar and the archive disagreeing about
what a project is called is exactly the confusion this feature exists to remove.

**An adopted folder is only ever a pointer this plugin stores.** `attach` accepts
a folder token and an http(s) link and records them; it does NOT verify the folder
exists and it does not move anything, because the listing that follows reports a
token Feishu cannot resolve in the panel's own words — and a page that could make
the host move files would be a far bigger surface than this feature needs.

What IS still enforced before anything is written: the parent token and the name
are validated on the host (the name must be non-blank, free of control
characters, and within Feishu's 256-byte ceiling); a folder token is checked
against the CLI's own alphabet in every route that takes one; and a create whose
answer carries no `folder_token` is reported as a failure rather than as a
success.

Requirements and knobs:

| Fact | Detail |
|---|---|
| Folder name | the project's name from the New Project form (workspace title); the path's last segment when no name is sent |
| Scope | creating needs **`space:folder:create`**; the panel's listing and its adoption pass need **`space:document:retrieve`**, because both are listings |
| CLI | the same `lark-cli` the document panel uses; `DSH_WEB_UI_LARK_CLI` pins its path |
| Parent folder | `DSH_WEB_UI_LARK_FOLDER` overrides the token for another tenant or another archive folder (default: the folder above) |
| Where the token is recorded | the project's record, beside the name and the product answers — `larkFolderToken` / `larkFolderUrl` |
| Identity | `--as user` — the folder is created as the signed-in operator, so it inherits their permissions |
| Failure answer | HTTP 200 with `{ ok: false, error: { code, message } }` inside — content the strip renders. Only a malformed request is a 4xx |

## Why it can replace the column without losing anything

DSH's UI is a slot tree. Rendering a slot is *ownership*: a slot's occupant is
chosen by priority, and a slot key has exactly one **declarer**, which is the
only entry allowed to render it. So the naive "replace the sidebar" move —
registering `sidebar` at a lower priority — renders your component *alone*: the
seats the shipped shell declared (`sidebar.workspaces`, `sidebar.settings`, …)
collapse with it, and the workspace browser and settings panel vanish from the
page.

This plugin takes the other route:

1. `cordis.patch.yml` **disables the `ui-sidebar` row**, so the `sidebar` slot
   key is left undeclared.
2. This plugin registers `sidebar` itself **and re-declares the same five child
   seats** in that one call.
3. The shipped occupants (`ui-workspace`, `ui-settings-general`,
   `ui-brand-official`, footer actions) register into those seats through
   `ctx.slots.inject(...)`, exactly as before — only now they render inside
   this plugin's column, which decides the header, the project row, the New
   Session button, and the column's styling.

Nothing is imported from the shipped shell (a cross-plugin value import is
forbidden by the client-bundle purity rule), so this stays a real plugin: it
depends on the *slot contract*, not on `ui-sidebar`'s code.

## Install

The plugin must be resolvable from the profile directory that owns `cordis.yml`
(`~/.dsh/profiles/web` here) and must be listed as a Loader row.

### Path A — symlink + user patch (what this checkout uses)

```sh
ln -sfn /Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui \
        ~/.dsh/profiles/web/node_modules/dsh-web-ui
```

Then add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: ui-sidebar
  disabled: true

- insert:
    - id: dsh-web-ui
      name: dsh-web-ui
```

The profile patch is watched: the host picks the new row up immediately, and a
**page reload** is enough — no server restart. (A reload is required because the
boot graph `window.__DSH_BOOT__` is injected per index render.)

### Path B — bundle install

`dsh.bundle.patch` points at this package's `cordis.patch.yml`, which contains
both entries above:

```sh
dsh plugin --profile web add /Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui
```

Restart `dsh web` afterwards (bundle membership is fixed at start). Do **not**
combine the two paths: the row would be inserted twice.

### Requirements

- The `ui-sidebar` row must be disabled. This plugin's takeover needs the
  `sidebar` key (and its five child keys) undeclared. If it cannot get them, it
  retries for ~5s and then degrades to putting the project row in the *shipped*
  shell's brand row, so the page never loses navigation.
- Baseline client modules only: `react`, `react/jsx-runtime`,
  `@deepseek-ai/dsh-client-ui-primitives`. No `dsh.client.external` requests.
- Type-only imports of `…-ui-layout/client`, `…-ui-sidebar/client`, and
  `…-ui-conversation/client` for their `SlotMap` merges: erased at build, never a
  runtime request. The first two are already symlinked for the shell's contract;
  the third is needed by the hero brand-mark registration.
- No runtime npm dependencies. The host half imports only `node:*` plus a
  **type-only** `@deepseek-ai/dsh-host-webserver` (for the `ctx.webServer`
  augmentation) and needs `@types/node` to typecheck; both are dev-time,
  symlinked into `node_modules` exactly like the sibling plugins do.

## Build

```sh
node node_modules/tsdown/dist/run.mjs      # or: npm run build
npm run typecheck                          # or: tsc -p tsconfig.host.json && tsc -p tsconfig.client.json
```

**Two type-check units, never one program.** `tsconfig.host.json` and
`tsconfig.client.json` each cover one half (plus `src/shared/**`, which is
deliberately inert — types and strings only, so it is safe in both), and
`tsconfig.json` is a solution file with `files: []` and references to the two.
The reason is not tidiness: the host and the browser merge the *same* cordis
`Context` keys (`ctx.sessions`, `ctx.terminal`, …), so a single program sees both
declarations at once and silently retypes one half with the other's service —
which is exactly what happened the first time a host type import was added here.
The harness's own `tsconfig.json` carries the same warning.

`lib/client.js` is the browser half: a classic script that registers a closure
factory via `window.__ModuleLoader__.load({ id: 'dsh-web-ui', … })`. Its `id`
must equal the Loader row's `name`, which is also the `/plugins/<id>/client.js`
route. `packages/client/tsdown.client.ts` (the in-repo preset that emits this
artifact) is not published, so `tsdown.config.ts` here reproduces its contract:
CJS output, the banner/footer/intro wrapper, baseline specifiers kept external,
everything else inlined, and a purity gate that refuses other `@deepseek-ai/*`
value imports.

Dev loop: run the build, then reload the page. `client-hmr` is in this
composition, so a rebuilt bundle is re-hashed and served without a restart
(`lib/client.js` is the artifact the graph watches — edit and rebuild).

`lib/index.js` is the **host** half, and it is imported once per process by the
Loader (this composition runs with `hmr` disabled, and the loader's import is a
plain `import(url)` — Node's ESM cache keys on the URL, so there is nothing to
invalidate). The rule that follows: a change under `src/client/**` needs only a
rebuild + page reload, while a change under `src/host/**` or `src/index.ts`
needs `dsh web` restarted before the new code is live.

## Verifying

```sh
node scripts/smoke-git.mjs                            # the git drawer: routes + DOM, no GUI needed
pnpm harness:folder-route                             # the Feishu folder routes, no GUI needed
pnpm harness:project-record                           # the project record (incl. its Feishu folder), no GUI needed
pnpm harness:new-project-form                         # the New Project form, no GUI needed
pnpm harness:lark-panel                               # the Feishu folder panel, no GUI needed
CHROME=<chromium> node scripts/smoke.mjs              # structure, rail, plugin list
CHROME=<chromium> node scripts/smoke-new-project.mjs  # New Project flow, host mocked at the wire
CHROME=<chromium> node scripts/preview/measure-form.mjs  # the form's geometry, in a real browser
CHROME=<chromium> node scripts/preview/measure-stage-tag.mjs  # the stage tag: flow states + painted pixels
```

`smoke-git.mjs` needs no running GUI and **no login**: it is the only test here
that runs unattended. It creates a scratch repository under `$TMPDIR`, then walks
both boundaries of the git drawer —

1. **host** — every route over a real socket: statuses, envelopes, method guards,
   the malformed-request arm, the body cap, and the refusals that matter (an
   option-shaped `ref`, a path escaping the work tree, a branch name git
   rejects, a non-hex commit id). It asserts the argv git actually received by
   reading back the journal, and that a *refused* action is not journalled at all;
2. **browser** — the BUILT `lib/client.js`, loaded through the shell's own
   registration protocol, applied against a stub client context, and rendered
   into a real DOM (`jsdom`). Clicks are dispatched at real nodes: stage →
   unstage → commit → read the commit back in history → read the command back in
   the journal → create a branch through the drawer's own prompt, plus the
   not-a-repository answer.

The shipped UI primitives are the one stub (their node builds import CSS modules
Node cannot load — the shell answers them from a browser module table instead).
The stub renders real buttons, a real checkbox, and a real menu, so every click
lands on this plugin's own control.

`jsdom` is dev-only and symlinked into `node_modules` from a checkout, like
`playwright`, since neither is a dependency of the plugin. `react`, `react-dom`,
and `@types/react-dom` are symlinked for the same reason: the bundle keeps them
external (`require()` from the shell's module table), so nothing here declares
them, but the typecheck and the DOM test both need them present.

`smoke.mjs` asserts the takeover, that the shipped seats still render inside the
column, the row order (project row → stage tag → New Session, and the rail's
square stage tag beside it), **that switching project
re-scopes the session list with zero overlap between the two projects**, that the
scope survives a reload, that a row's rename dialog reaches `session.rename` with
the clicked session's id, the rail geometry, and that the plugin is listed in
Settings → Plugins. It answers `session.rename` and `workspace.archiveSession` at
the wire so the row actions can be exercised without writing to real sessions.

`smoke-new-project.mjs` mocks `host.pickDirectory` as unavailable,
`host.listDirectory`, `workspace.create`, `workspace.rename`, and
`session.create`, then walks the whole chain through the FORM — `+` → the form →
its folder chooser → the in-app browser → back to the form → confirm →
`workspace.create {path}` → `session.create {workspaceId}` → the list re-scopes to
the new project — without touching the operator's real workspace registry and
without opening an OS dialog. It asserts the form's own copy, the three product
backgrounds, and the conditional product-card row. It also mocks
`POST /dsh-web-ui/lark/folder` and asserts both halves of the folder side effect:
a created folder is reported as an informational strip, and a Feishu scope
failure is reported as a warning **while the project is still created**.

Four offline harnesses cover the folder side effect without a running host, which
matters here because this deployment's GUI sits behind the QR login gate:

| Command | What it pins down |
|---|---|
| `pnpm harness:project-record` | the project record's storage and routes: a write round-trips through the pinned document, a project with no record answers `null`, the Feishu folder a form write does not carry SURVIVES that write, a record from before folders existed reads as "no folder", a malformed/empty/future-versioned document degrades to "no records" and is repaired by the next write, a bad request never touches the file (and is a 400), and the card catalogue distinguishes "none configured" from "broken" and refuses duplicate ids |
| `pnpm harness:folder-route` | the hosts's folder routes: the methods, 400s for every malformed request (a path-shaped name, an argv-shaped token, a non-http URL — none of which reach the CLI), the folder named from the request's `name` (the project's name) with the path's segment as the fallback, **exactly one create and ZERO parent-folder reads** per create (the create-only rule, asserted rather than assumed), the deployment's parent token travelling to the CLI even when the request names another, a create RECORDING the folder and a recorded folder answered with no listing at all, all four resolution outcomes (`record`/`adopted`/`missing`/`ambiguous`) including that adoption is written once and ambiguity writes nothing, the listing's page and its folder token inside the command's `--params`, and a Feishu failure — including a missing scope — answered as 200/`ok:false` |
| `pnpm harness:folder-flow` | the browser flow: the exact request it sends (path **and** project name), that the session opens **before** the folder call, that a success leaves the sidebar strip EMPTY and announces itself through the system banner (re-announced on a repeat run), that a failure goes to the strip and NOT to the banner, every failure sentence read from the real dictionary, and that no dedup copy is reachable any more |
| `pnpm harness:new-project-form` | the form itself, driven by clicks in jsdom: what it asks for, that opening it touches nothing, the product-card row appearing for `已有产品` and for nothing else (fed by the host's catalogue, which this harness answers), the folder field falling back to the browser on a host with no native chooser, the draft surviving that round trip, what the submission sends — and EDIT mode end to end: the prefill from the record, the read-only directory, the save reaching both `workspace.rename` and the record |
| `pnpm harness:lark-panel` | the panel itself, driven by clicks in jsdom over mocked routes: nothing read when no project is selected, one listing per folder opened and none twice, the project's folder name as the link it opens in Feishu, documents opening in Feishu, "load more" asking for the page token the host offered, the MISSING state's create round trip (POST then re-resolve) and its pasted-link round trip, the AMBIGUOUS state offering each candidate and recording the chosen one, a shortcut that points back up its own branch rendering as a row that opens rather than a stack overflow, and a `scope-missing` refusal rendered with the scope to ask for |

`harness:folder-route` drives the real `registerLarkRoutes` against a fake
webserver that hands back the handler, with a stubbed `lark-cli` on disk; the
adapter's create path was additionally probed against the real tenant, which is
where two facts came from: the live `scope-missing` envelope (what a missing
permission looks like end to end) and that Feishu happily accepts two sibling
folders with the same name — which is why "already exists" could never have been
answered by the create call itself, and why the panel's adoption looks for one
instead. `harness:folder-flow`, `harness:new-project-form`, and
`harness:lark-panel` render the real flow, the real dialog, and the real panel
from source in jsdom (bundled by `scripts/harness/tsdown.mjs`, whose
UI-primitives stub is generated from the real package's icon declarations so a
new icon can never silently break the harness) with the runtime's project
services stubbed and `fetch` answering the way the host's routes do.

`scripts/preview/measure-form.mjs` is the LAYOUT check, and it needs a browser
but no host: it renders the dialog's markup to a standalone HTML file
(`new-project-dialog.html`, same plugin stylesheet, same shipped theme tokens),
then reads the geometry back out — the widened card, the folder row's ellipsis,
the three answers on one line, the accent on the chosen answer. It exists because
a jsdom render has no cascade, so no other test here can tell a styled form from
an unstyled one.

`scripts/preview/measure-stage-tag.mjs` is the same idea for the FDE flow, with
one difference that matters: it renders the REAL component (`stage-tag-entry.tsx`,
bundled by `stage-tag.mjs` with the primitives aliased to the checkout's own
source, so the shipped icons and the shipped placement hook are what run), serves
it over HTTP — a `file://` origin refuses `localStorage`, and the tag's stage lives
there — and then seeds a stage and drives it. It asserts the whole positional
contract per scenario (which nodes are checked, which one is running, which are
grey), the rail's geometry down to the node centres, the placement and
clamping of the portaled panel, that Escape and an outside click close it, that a
click moves and persists the stage, that a rail tag still announces the stage it
no longer spells out, that the dark theme re-tints the flow, and that an
unreadable stored record degrades to the first stage and is repaired by the next
click. It also reads the SCREENSHOT's pixels (`pixel.mjs` decodes a 1×1-capable
PNG with `node:zlib`): a computed style is a promise, not a picture, so the green
arc, the white check on a green disc, the hollow unreached node and the tinted
running row are confirmed as PAINTED — which is the only way this deployment can
check them, since every model configured here takes text and nothing can look at
the image. `stage-tag.html` is the artifact to open by eye.

The Feishu panel is verified in three places, because it is the part whose
subject comes from outside this plugin:

- **the host routes**, offline: `pnpm harness:folder-route` registers the real
  routes against a fake webserver with `lark-cli` stubbed on disk and the project
  record pinned to a temporary file, and checks what a reviewer would otherwise
  have to trust — the methods, every malformed request (a path-shaped name, an
  argv-shaped token, a `javascript:` URL), that creating reads NOTHING first while
  resolving does, that a create RECORDS the folder and a recorded folder is then
  answered without any listing, all four resolution outcomes, and that a Feishu
  refusal — including a missing scope — travels as content rather than as a
  transport failure;
- **the panel**, offline: `pnpm harness:lark-panel` renders the real component in
  jsdom with `fetch` answering the way the routes do, and drives it the way an
  operator would — nothing read when no project is selected, one listing per
  folder opened (and none twice), documents opening in Feishu, "load more"
  asking for the page the host offered, the create and paste-a-link round trips,
  choosing between several same-named folders, a shortcut that points back up its
  own branch rendering as a row that opens rather than a stack overflow, and a
  refusal rendered with the scope to ask for;
- **the live host**, by hand: `curl '127.0.0.1:3080/dsh-web-ui/lark/state'` (the
  signed-in user), `…/lark/folder?path=…&name=…` (the resolution), and
  `…/lark/files?folder=…` (a listing) against the real `lark-cli` — the last two
  only once the login carries `space:document:retrieve`.

Note that the deployment's login gate (`dsh-feishu-login`) sits in front of the
GUI: a browser check needs either a real scan or `gate: false` on that plugin's
row in the profile patch (which is hot-reloaded, so it is a live toggle — put it
back afterwards).

## Customizing

| What | Where |
|---|---|
| Palette / page-wide tokens | `src/client/styles.ts`, the `GLOBAL SKIN` block (`--dsw-specific-sidebar-fill`, `--dsh-web-ui-accent`, …) |
| Column layout, spacing, rail | `src/client/styles.ts`, the `SHELL` block (`[data-wui='…']` selectors) |
| Column structure | `src/client/Shell.tsx` |
| Region split (sessions above, Feishu below) | `Shell.tsx` — `DEFAULT_SPLIT`/`MIN_SPLIT`/`MAX_SPLIT`, key `dsh-web-ui.split`; drag the divider, double-click it to reset |
| Project dropdown + New Project flow | `src/client/ProjectRow.tsx` |
| The New Project form (fields, copy, conditional card row) | `src/client/NewProjectDialog.tsx` |
| The New Project flow (draft, chooser, submission, Feishu folder) | `src/client/projectFlow.ts` |
| Where product cards come from | `src/host/products.ts` (host) → `GET /dsh-web-ui/lark/cards` → `src/client/productCards.ts` (types) |
| Project scope (selection store + follow rule) | `src/client/project.ts` |
| The project-scoped session list | `src/client/SessionList.tsx` |
| The Feishu document panel | `src/client/LarkDocsPanel.tsx` (+ `src/client/larkapi.ts`) |
| The Feishu read routes | `src/host/routes.ts` (+ the `lark-cli` adapter, `src/host/lark.ts`) |
| The git drawer | `src/client/GitPanel.tsx` (chrome), `GitBranches.tsx`, `GitChanges.tsx`, `GitHistory.tsx`, `GitRecords.tsx`, `src/client/gitapi.ts` |
| The action bar (placement, controls) | `src/client/ActionBar.tsx` (+ its one registration in `src/client/index.tsx`) |
| The command bar (panel, currently unmounted) | `src/client/TerminalBar.tsx` (+ `src/client/termapi.ts`) |
| The command runner (spawn, sandbox, output window) | `src/host/term.ts`, config in `readTerminalOptions` |
| The command bar's routes | `src/host/term-routes.ts` (+ the shared HTTP plumbing in `src/host/http.ts`) |
| Bar offsets, button chrome | `src/client/styles.ts`, `[data-wui='actionBar']` / `[data-wui='actionButton']`; the `--dsh-web-ui-bar-top` / `--dsh-web-ui-bar-right` custom properties |
| The git write/serve half | `src/host/git.ts` (argv building, parsing, journal), `src/host/git-routes.ts` |
| The git wire contract (both halves) | `src/shared/gitwire.ts` |
| Which verbs the drawer offers | `buildAction()` in `src/host/git.ts`, and the per-row menus in `GitBranches.tsx` |
| Initialize-a-repository empty state | the `gitEmpty` block in `GitPanel.tsx` (the `not-a-repo` arm) |
| The remotes section | `GitBranches.tsx`, `remoteAddressItems()` + the remotes `<section>` |
| Which folder the panel shows | the project's own folder: `GET /dsh-web-ui/lark/folder` resolves it from the record (`larkFolderToken`) or adopts it by name; `src/host/routes.ts` `resolveFolder` |
| The project record (store + routes) | `src/host/projects.ts`, `POST`/`GET /dsh-web-ui/lark/project` |
| The product-card catalogue | `src/host/products.ts` (`DSH_WEB_UI_PRODUCT_CARDS`, else `products.json` beside the records) |
| The project form (create + edit) | `src/client/NewProjectDialog.tsx`, driven by `src/client/projectFlow.ts` |
| Delete dialog | `src/client/ConfirmDialog.tsx` |
| Fallback folder browser | `src/client/BrowseFoldersDialog.tsx` |
| Copy (zh + en) | `src/client/locales.ts` (namespace `webui`) |
| Brand mark (AsiaInfo emblem) | `src/client/AsiaInfoMark.tsx` |
| Product name on the brand row | `BRAND_NAME` in `src/client/Shell.tsx` |
| Hero brand-mark occupant | the `conversation.hero.brand.mark` registration in `src/client/index.tsx` |
| Degraded brand-row mode | `src/client/FallbackBrandControls.tsx` |

### Branding

The page ships as **ForgeX** with AsiaInfo's mark:

- **The mark** (`src/client/AsiaInfoMark.tsx`) is the emblem cut out of
  AsiaInfo's published single-colour logo (`asiainfo.com/include/images/
  logo-white.svg`, its `单色黑logo` group): the three paths that draw the emblem,
  on the ink box they occupy, with the vendor's `AsiaInfo` wordmark and
  `亚信科技` line dropped — the row pairs the mark with this deployment's own
  product name instead. Its ink rides `currentColor`, so it follows the theme
  (label-primary) rather than pinning the artwork's white fill, which would
  vanish on the light sidebar.
- **The name** is `BRAND_NAME` in `Shell.tsx`, the `sidebar.brand.name` seat's
  fallback. Both seats keep their occupant protocol: a deployment that registers
  its own occupant still overrides this rebrand.
- **The empty-state hero** (`conversation.hero.brand.mark`) belongs to
  `ui-conversation`, so the mark arrives there as an occupant at priority `-1`
  — the same move that shadows the shipped workspace browser. The stylesheet
  also cancels that seat's hover "swim" animation for the mark
  (`[data-wui='brandMarkArt']`): the motion was drawn for the shipped fish, not
  for a vendor emblem.

To go back to the shipped branding: restore the `FishLogo` / `'DSH Local Build'`
fallbacks in `Shell.tsx` and delete the hero `ctx.slots.inject(…)` block in
`index.tsx`.

Styling rule of thumb: this plugin owns the column, so its own CSS may use
geometry and local `--dsh-web-ui-*` properties. Anything outside the column is
another package's surface — reach it through the semantic `--dsw-alias-*` /
`--dsw-specific-*` tokens only (that is what the `html body` overrides do, and
the extra type selector is what wins against ui-theme's own `body` rule).

## The dsh-git plugin suite

This deployment also installs [dsh-git-plugins](https://github.com/sakthiveltofficial/dsh-git-plugins),
the model-facing git capability: 8 typed agent tools (`git_repo`, `git_inspect`,
`git_pr`, `git_issues`, `git_release`, `git_security`, `git_ci`, `git_memory`)
over local git and five hosted platforms.

```sh
dsh plugin --profile web add github:sakthiveltofficial/dsh-git-plugins
```

It is a **bundle**: the patch it carries inserts its own Loader rows, so
`dsh plugin add` also appends `dsh-git-plugins` to the profile's
`dsh.profile.bundles`, and the whole set composes on the next `dsh web` start.
Verify with:

```sh
dsh --profile web --dump-config | grep -i git
```

Two operational notes from this machine, both worth knowing before the next
install:

- `dsh plugin` forwards to whatever `pnpm` is first on PATH. The profile's
  `node_modules` was linked by pnpm 10 (store `v10`), so a pnpm 11 forwarder
  stops with `ERR_PNPM_UNEXPECTED_STORE` before installing anything. Prefix the
  command with the matching pnpm, e.g.
  `PATH=/opt/homebrew/bin:$PATH dsh plugin --profile web add …`, or the install
  never runs.
- Platform tokens are credential *references*, not secrets: `GITHUB_TOKEN`,
  `GITLAB_TOKEN`, `BITBUCKET_APP_PASSWORD`, `AZURE_DEVOPS_PAT`, `GITEA_TOKEN`.
  With a reference unset, reads of public repositories still work and writes
  fail loud with `GIT_AUTH_FAILED`.

The two capabilities are independent by design. The agent tools go through
`@dsh-git/local` with approval and sandbox policy; the drawer in this plugin
shells out to the same `git` binary itself, validates every name through git,
and answers a browser. Installing either one without the other leaves the other
working.

## Known limitations

- **The browsing region no longer hosts the shipped browser.** It is split in
  two (sessions above, Feishu documents below), and the upper half is this
  plugin's own list. Search is local (title match within the project), not the
  host's content search, and fork / reorder are absent (see above). If you want
  the shipped browser back, delete the `ctx.slots.inject('sidebar.workspaces', …)`
  block in `src/client/index.tsx` — the shipped registration is still on the
  ledger and renders again immediately.
- **The command bar is not an interactive terminal.** No pty, no full-screen
  programs (`vim`, `top`, an interactive REPL), no persistent shell session
  between commands — each entry is one `bash -lc`. DSH does ship a PTY service
  (`@deepseek-ai/dsh-terminal` + `dsh-terminal-bash`), but it is line-oriented and
  **agent-owned** (`spawn(owner: Agent, …)` ties a session's lifetime to an
  agent), it is not composed in this profile, and the harness has no terminal
  client UI. An interactive panel is a separate feature, not a config change.
- **The command bar can execute anything the operator types.** That is what a
  command bar is for, and it is why the surface is confined by policy, shows the
  mode it ran under, and is reachable only through the deployment's own login
  gate. It is also why this plugin never passes a browser's text to a shell
  anywhere else.
- **The git drawer needs the host half live.** Everything under `src/client/**`
  is served fresh on a page reload, but `src/host/git.ts` and
  `src/host/git-routes.ts` are imported once per process: adding or changing a
  route needs `dsh web` restarted. Until then the drawer opens and answers *"the
  git routes are not mounted on this host — rebuild the plugin and restart `dsh
  web`"*, which is the honest state rather than an empty branch list.
- **The drawer manages a repository, it does not create the FOLDER.** *Initialize
  repository* runs `git init` in the project directory, but nothing here creates
  the directory itself, clones into it, or edits `.gitignore`. Cloning is the
  agent's `git_repo` tool (`action: 'clone'`), and the folder is the New Project
  form above.
- **The project record is this plugin's own sidecar, not a DSH fact.** The name
  and the folder ARE workspace fields (the title and the path), but the product
  background and the product card have no host field, so they live in a document
  this plugin owns (`~/.dsh/storages/web_ui_projects.json`, keyed by path — see
  [Editing a project](#editing-a-project)). Consequences worth knowing: a project
  created before this store existed has no record until it is edited (the form
  says so rather than inventing an answer), the record's name is a copy that the
  registry can overtake if something else renames the workspace, and moving the
  project's directory is deliberately NOT offered, because a workspace is
  identified by its path.
- **The git drawer cannot resolve conflicts.** Conflicts are surfaced as a
  bucket, with an *abort* action for the operation that produced them; there is
  no merge editor, no interactive rebase, and no submodule support.
- **The Feishu panel is only as available as `lark-cli`.** It reads the
  operator's own login: no signed-in user, no installed binary, a login without
  `space:document:retrieve`, or a host that cannot reach Feishu (a TLS-inspecting
  proxy or a disconnected VPN) is rendered as that fact — with the fix for that
  particular failure and a Retry — never as an empty folder. A host-half change
  also needs `dsh web` restarted, unlike the browser half.
- **The panel shows one project's folder, and only what the listing says.** Its
  subject is the selected project, so a project with no folder gets the create /
  paste-a-link actions rather than another project's tree; and the rows are the
  folder's DIRECT children, expanded one level at a time. The scope a listing
  needs (`space:document:retrieve`) is also what the adoption pass needs, so a
  login that cannot list cannot adopt either — and the panel says which scope to
  ask for instead of failing silently.
- **The conversation surface keeps its shipped look.** It belongs to
  `ui-conversation`, which renders into the frame's `conversation` slot; a
  plugin cannot re-host another plugin's slot, so the centre column is
  restyled only through theme tokens — the one exception is the hero's brand
  mark, which this plugin fills as an ordinary occupant (see *Branding*). Taking
  that over too means replacing the
  frame itself (disable `ui-layout`, declare `root` plus `sidebar` /
  `conversation` / `details` / `shell.overlay`, and provide a compatible
  `ctx.layout` service and theme presenter) — a deliberate next step, not this
  plugin's scope.
- **The project row is derived, never stored.** DSH has no host-side "active
  workspace": the shown project is the workspace owning the current session,
  falling back to the most recent one. That is why picking a project opens a
  session in it, and why the row never disagrees with the session list.
- **`pickDirectory` is the OS dialog** on a local macOS session; the in-app
  browser (reachable from the form's *选择本地目录*, and from the dropdown's
  *Browse folders…* row — which opens the form on the folder field) covers hosts
  whose directory capability is `browse` (SSH/LAN). Whichever route answers, the
  path is only a FIELD: the project is registered when the form is submitted, and
  picking an existing folder is the only create route, matching the host's
  `workspace.create` contract — it never creates directories except through the
  browser's own *New folder*.
- **No settings card.** The plugin appears in the plugin *list* (which is driven
  by Loader entries). A card in the *Plugin configuration* tab needs a host-side
  settings namespace plus a browser card; not implemented here.
- **One occupant per slot.** The takeover assumes this plugin is the only
  project-row plugin; another plugin registering `sidebar` without going through
  the same disable path will collide loudly at register time (by design).
- **Disabling this plugin alone leaves an empty column** — re-enable the
  `ui-sidebar` entry in the same edit that disables `dsh-web-ui`, since the
  shipped shell only registers when its own row is enabled.
- **The Feishu project folder is created without a duplicate check, and only for
  new projects.** The side effect runs at the end of the New Project flow, so a
  project added before this feature (or while the login lacked
  `space:folder:create`) has no folder until it is added again — and adding it
  again CREATES a folder rather than reusing an existing one. Two sibling folders
  can therefore end up with the same name, by design: Feishu does not refuse the
  second, and this deployment chose not to spend a `space:document:retrieve`
  listing to look for the first. Nothing here cleans that up either: Drive
  deletion is a `high-risk-write` the login here does not carry.
