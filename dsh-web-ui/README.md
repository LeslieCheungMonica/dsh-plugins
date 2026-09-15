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
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # typecheck
```

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

Two smoke tests drive the real GUI with Playwright (dev-only; symlinked into
`node_modules` from a checkout, since it is not a dependency of the plugin):

```sh
CHROME=<chromium> node scripts/smoke.mjs              # structure, rail, plugin list
CHROME=<chromium> node scripts/smoke-new-project.mjs  # New Project flow, host mocked at the wire
```

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

## Known limitations

- **The browsing region no longer hosts the shipped browser.** It is split in
  two (sessions above, Feishu documents below), and the upper half is this
  plugin's own list. Search is local (title match within the project), not the
  host's content search, and fork / reorder are absent (see above). If you want
  the shipped browser back, delete the `ctx.slots.inject('sidebar.workspaces', …)`
  block in `src/client/index.tsx` — the shipped registration is still on the
  ledger and renders again immediately.
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
