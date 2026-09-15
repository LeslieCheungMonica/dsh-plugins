# dsh-web-ui

A DeepSeek Harness **web UI plugin** that replaces the left column and re-skins
the shell:

- the **sidebar column is this plugin's** — header, geometry, spacing, rail;
- a **project dropdown** (`项目 / current project`) and a **New Project** button
  sit directly above the New Session button;
- the session list below them shows **only the selected project's sessions** —
  no other project's sessions appear, and switching projects re-scopes it;
- the New Session button starts its session **in the selected project**;
- choosing the project's folder is the New Project flow: pick a workspace
  directory → register it as a DSH workspace → open a session in it;
- the **lower half of the column is the Feishu document panel**: the signed-in
  `lark-cli` user, their personal knowledge base (`个人知识库` / `my_library`),
  and its directories and documents, one lazy level at a time (see
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
expand/collapse tree. Project **rename and delete** moved to the dropdown, which
now carries them as rows acting on the selected project (the shipped browser used
to own those dialogs).

`project` is this plugin's word for a DSH **workspace**: a host-registered
directory whose sessions share its path.

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

The column's lower half is a Feishu (Lark) document browser, and it is the one
part of this plugin that needs the **host**: a page cannot run `lark-cli`, and
Feishu credentials must not reach a browser. So the work is split.

**Host half** (`src/host/lark.ts`, `src/host/routes.ts`, mounted by `apply`):

| Route | Answers |
|---|---|
| `GET /dsh-web-ui/lark/state` | the signed-in user (`auth status` + `contact +get-user`) and the personal knowledge base (`wiki spaces get space_id=my_library`) |
| `GET /dsh-web-ui/lark/spaces` | the readable knowledge spaces, personal library first (Feishu never returns `my_library` from `space-list`, so it is resolved separately) |
| `GET /dsh-web-ui/lark/nodes?space=…&parent=…&pageToken=…` | one page of one level of wiki nodes (`wiki +node-list`, page size 50) |

Three properties make that seam safe to expose to a page:

- **no shell** — every call is `execFile` with an argv array, and tokens are
  validated against the CLI's own alphabet first, so nothing from a query string
  can become a shell word;
- **serialized** — the CLI refreshes an expiring user token on the first user
  call, and two concurrent refreshes race on one credential file, so calls go
  through one queue;
- **failure is data** — a missing binary, an expired login, a transport failure
  (the CLI's own `"type": "network"`), and a stale node token are returned as
  typed codes the panel renders, never as an empty list or a 500.

**Browser half** (`src/client/LarkDocsPanel.tsx`) renders the header strip (user
name + avatar + knowledge-base switcher + refresh), then the tree. A node with
children behaves as a **directory** (the row expands and fetches that level); a
node without children is a **document** (the row opens
`https://feishu.cn/wiki/<node_token>` in a new tab, as does the hover button on
directory rows). One level is one request, results are cached briefly on the
host, and every in-flight read carries the generation it was issued in — a reply
that lands after a refresh or a space switch is dropped rather than painted into
the new space.

The user's personal knowledge base is the default view, because that is what the
panel is for; the switcher next to the user name offers the team knowledge
spaces too, which is where the real directory trees usually live.

Notes for operators:

- a personal library can be **flat** (documents at the root, no directories) —
  the panel then renders a file list, which is the honest answer;
- `DSH_WEB_UI_LARK_CLI` pins the executable path when it is not on `PATH` (the
  host also probes `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`);
- the routes are **optional capability**: `apply` reaches `webServer` through
  `ctx.inject(['webServer'], …)`, so a deployment without one keeps the whole
  sidebar and simply has no document panel;
- the host half is loaded by the Loader **once per process**: editing
  `src/host/**` needs `dsh web` restarted, while the browser half only needs a
  rebuild and a reload.

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
CHROME=<chromium> node scripts/smoke.mjs              # structure, rail, plugin list
CHROME=<chromium> node scripts/smoke-new-project.mjs  # New Project flow, host mocked at the wire
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
column, the row order (project row above New Session), **that switching project
re-scopes the session list with zero overlap between the two projects**, that the
scope survives a reload, that a row's rename dialog reaches `session.rename` with
the clicked session's id, the rail geometry, and that the plugin is listed in
Settings → Plugins. It answers `session.rename` and `workspace.archiveSession` at
the wire so the row actions can be exercised without writing to real sessions.

`smoke-new-project.mjs` mocks `host.pickDirectory` as unavailable,
`host.listDirectory`, `workspace.create`, and `session.create`, then asserts the
whole chain — picked folder → `workspace.create {path}` → `session.create
{workspaceId}` → the list re-scopes to the new project — without touching the
operator's real workspace registry and without opening an OS dialog.

The Feishu panel was verified the same way: the host routes answer
`/dsh-web-ui/lark/{state,spaces,nodes}` against the real `lark-cli` (checked
directly with a Node probe for the signed-in user, the personal library, a root
level, an expanded directory, and the two rejection paths for a malformed space
id and node token), and the browser half was driven with the three routes mocked
at the wire to assert the tree itself — root level, type chips, directory
chevrons, one-step indentation per level, expansion and collapse, the
`pageToken` "load more" append, `window.open` of `feishu.cn/wiki/<token>` from a
document row, the roster menu, and a space switch re-reading that space.

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
| Which knowledge base opens by default | `PERSONAL_SPACE_ID` in `src/client/larkapi.ts`; the host alias is `PERSONAL_LIBRARY` in `src/host/lark.ts` |
| Rename / delete dialogs | `src/client/TextPromptDialog.tsx`, `src/client/ConfirmDialog.tsx` |
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
  flow above.
- **The git drawer cannot resolve conflicts.** Conflicts are surfaced as a
  bucket, with an *abort* action for the operation that produced them; there is
  no merge editor, no interactive rebase, and no submodule support.
- **The Feishu panel is only as available as `lark-cli`.** It reads the
  operator's own login: no signed-in user, no installed binary, or a host that
  cannot reach Feishu (a TLS-inspecting proxy or a disconnected VPN) is rendered
  as that fact, with a Retry — never as an empty tree. A host-half change also
  needs `dsh web` restarted, unlike the browser half.
- **The tree lists what the node level says.** Feishu models a "directory" as a
  node with children (usually a `docx` page), so the panel follows `has_child`
  rather than a folder flag, and a personal library with no nested nodes renders
  as a flat list.
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
  browser (also reachable from the dropdown's *Browse folders…* row) covers
  hosts whose directory capability is `browse` (SSH/LAN). Picking an existing
  folder is the only create route, matching the host's `workspace.create`
  contract — it never creates directories except through the browser's own
  *New folder*.
- **No settings card.** The plugin appears in the plugin *list* (which is driven
  by Loader entries). A card in the *Plugin configuration* tab needs a host-side
  settings namespace plus a browser card; not implemented here.
- **One occupant per slot.** The takeover assumes this plugin is the only
  project-row plugin; another plugin registering `sidebar` without going through
  the same disable path will collide loudly at register time (by design).
- **Disabling this plugin alone leaves an empty column** — re-enable the
  `ui-sidebar` entry in the same edit that disables `dsh-web-ui`, since the
  shipped shell only registers when its own row is enabled.
