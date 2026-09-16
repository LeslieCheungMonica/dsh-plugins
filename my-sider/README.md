# my-sider

A DeepSeek Harness **web UI plugin** that adds two operator panels to the GUI,
opened from a floating launcher:

- a **sidebar** docked to the right edge whose every **tab opens a web address**
  and shows the page inside it (local dev servers, internal docs, public pages);
- a **bottom panel** that takes **bash command lines** and runs them in the
  current session's project, with live output, history, and a stop button.

The plugin appears as `my-sider` in **Settings → Plugins → Plugin list**, and
both surfaces can be switched off independently in its Loader row.

```text
┌───────────────────────────────────────────────┬──────────────────────┐
│  the session header        [Git][侧边栏][下侧边栏]                    │
│ ───────────────────────────────────────────── │ 网页侧边栏           │
│                  DSH chat                     │ ┌────┬────┬─┐        │
│                                               │ │tab │tab │+│        │
│                                               │ ├────┴────┴─┴──────┐ │
│                                               │ │ ← → ⟳  address ▸ │ │
│                                               │ ├──────────────────┤ │
│                                               │ │                  │ │
│                                               │ │   the page        │ │
│                                               │ │                  │ │
├───────────────────────────────────────────────┴─┴──────────────────┤
│ 下侧边栏 · 命令      /path/to/project        退出码 0  沙箱 …        │
│ ┌ $ echo hi ───────────────────────────────────────────────────────┐ │
│ │ $ echo hi                                                        │ │
│ │ hi                                                               │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ $ [ command … ]                                        [ 执行 ]       │
└─────────────────────────────────────────────────────────────────────┘
```

## The launcher, and the row it shares

Two controls — **侧边栏** and **下侧边栏** — that open the two panels below.

| Control | What it does |
|---|---|
| **侧边栏** | opens / closes the web sidebar |
| **下侧边栏** | opens / closes the bottom command panel |

They render into a **shared action row**: the one horizontal strip of controls at
the conversation header's right, above its hairline. That row is `dsh-web-ui`'s —
it declares a `shell.action` list seat inside its own ActionBar registration and
renders it in the strip — and this plugin registers ONE entry into it
(`inRow: true`). Two independently `position: fixed` bars cannot make one row:
each would have to know the other's width to know where to start, and that
arithmetic breaks silently the moment either side gains a control. So the row is
theirs and the controls are ours: this plugin still owns its buttons' look, its
open flags, and both panels.

**The fallback is bounded.** A deployment that installs this plugin WITHOUT
`dsh-web-ui` never declares `shell.action`, so the registration would simply never
land and the two toggles would not exist. After `STRIP_FALLBACK_MS` (2s — the strip
is declared synchronously in `dsh-web-ui`'s own apply, so anything measurable
already means it is absent) the launcher pins its own bar in `shell.overlay`
instead, at the same offsets, with `inRow: false`. The strip appearing later
disposes the pinned bar, and vice versa; the two homes are exclusive by
construction.

**One reservation crosses the boundary.** The sidebar is docked to the right edge
and would cover the row — including the Git control that is not this plugin's. A
peer cannot move someone else's row, so instead of shifting itself the launcher
writes the width of the open sidebar into `--dsh-web-ui-bar-shift`, the property
the row honors as *space reserved to its right*, and the whole strip steps clear.
Alone (the fallback), the bar keeps its own inline offset and needs none of this.

Both open flags, the sidebar width, the panel height, the tab list, and the
working-directory override are persisted in `localStorage`, so a reload comes
back to the same workspace.

### Other plugins can open a page in this sidebar

The sidebar is published as a client capability: `ctx.webSidebar.open(url)` shows
an address in the docked panel, opening it if it is closed. `dsh-web-ui` is the
caller today — every Feishu link its document panel and stage-gate dialog draw
goes through it, so a reader reads the document beside the conversation instead of
in another tab.

Two properties make it safe to depend on:

- **It answers.** `open` returns whether a MOUNTED launcher took the request. A
  capability that silently does nothing would turn a document click into a dead
  link, so the caller falls back on `false` and opens a tab. Requests that arrive
  with nothing listening are reported untaken rather than buffered — a buffer
  would deliver a stranger's click into a later mount.
- **It is optional, both ways.** A deployment without this plugin has no
  `ctx.webSidebar` at all and the caller simply opens tabs; a deployment with it
  but with the launcher unmounted gets `false` for the same reason.

The panel adds the address as a **direct** tab, not a relayed one: the point of
the feature is a site the reader is already signed in to, and only a same-site
frame carries that session.

`dsh-web-ui` opens two kinds of address through it today: a Feishu document (its
own document panel and stage-gate dialog) and a source file of the current
project (the transcript's file links). It also labels each tab by the LAST path
segment of the address, so a page that wants a readable tab should carry its name
in the URL path rather than in a query.

## The web sidebar

Every tab is one address, shown in an `<iframe>`. There are exactly two ways to
fill that frame, and the panel offers both because neither is a superset of the
other:

| Mode | How it loads | What you get | What you lose |
|---|---|---|---|
| **直接嵌入** (direct) | `src` = the address itself | the site as a first-class origin: its cookies, login state, and scripts all work | framing is the SITE's decision — a page sending `X-Frame-Options` or a `frame-ancestors` directive stays blank |
| **宿主代理** (relay) | `src` = `/my-sider/url/fetch?url=…` | pages that forbid framing render anyway | the page is **anonymous** (the host sends no cookies), and script-heavy apps that navigate by absolute URL or call APIs may be incomplete |

The panel **probes** the active address through the host before trusting the
frame. When the site turns out to forbid framing, it says so and offers the
other mode in one click — instead of leaving a white rectangle and no
explanation. The probe is the host's view of the site and the browser's may
differ, so its notices are advisory and the frame is always rendered anyway.

Details worth knowing:

- **Addresses may be bare.** `localhost:5173`, `127.0.0.1:8080`, or
  `docs.internal` are what people actually type, so the scheme is inferred:
  loopback / private-IP / port-bearing inputs get `http`, everything else
  `https`. An address with an explicit scheme is validated rather than guessed.
- **Back / forward move along your own entries**, not the frame's history — a
  cross-origin frame cannot be asked where it has been, and a relayed one has its
  own history. The trail is per tab, and navigating from the middle of it drops
  what came after, like every browser.
- **A relayed frame runs on an opaque origin** (the iframe is sandboxed WITHOUT
  `allow-same-origin`), so a page served from the GUI's own origin still cannot
  reach the GUI's DOM, storage, or the DSH API. A direct frame keeps its own
  origin, because that is what makes logins work.
- **Relayed pages are fetched fresh**, never cached, and are bounded in time
  (`config.relay.timeoutMs`) and size (`config.relay.maxBytes`).
- Whatever cannot be framed and cannot be relayed is one click from
  **在浏览器新标签页打开**.

## The bottom command panel

It is a **command panel, not a terminal emulator**: one command line at a time,
no pty, no full-screen curses programs, no interactive prompt. That scope is
stated in the UI rather than pretended away — the input is a command LINE, and
the header shows the directory and the file policy the command actually runs
under.

- **The command is evaluated by a login shell** (`bash -lc` by default), so
  quoting, pipes, globs, and `&&` all behave. That is the feature.
- **It runs under the deployment's file policy.** The argv goes through
  `ctx.sandbox.confine` with the policy `ctx.sandboxPolicy` resolves, whose
  workspace boundary is the directory the command runs in. `config.shell.mode`
  pins the mode instead; `danger-full-access` skips confinement. **The mode a run
  actually executed under is reported on every run and shown in the panel**,
  because confinement the operator cannot see turns a write failure into a
  mystery.
- **The directory** is the current session's project. A session no workspace
  accounts for has no project (a real state), so the panel falls back to the
  directory the host was started in — and the header's field lets you override
  either, persistently.
- **Output is a window with absolute offsets.** Each poll sends the byte offset
  already rendered and appends what followed, so a reload, a remount, or a slow
  frame resumes exactly where it was. When the host has dropped the front of a
  run's buffer it answers from a LATER offset and the panel prints a gap line
  there instead of pretending the output is whole.
- **Runs are retained** (the last `config.shell.history` settled ones), so
  switching to another tab and back, or reloading, does not lose a run.
- **Stopping is explicit and idempotent**, and safe on a command that already
  exited. A command that outlives `config.shell.timeoutMs` is terminated, and the
  panel says so rather than showing a log that just stops.

## Install

Prerequisites: a working DSH (`dsh web` runs), Node ≥ 20, and this checkout on
disk. The plugin ships no runtime dependencies: every `@deepseek-ai/*` import in
its host half is type-only and erased at build, so the Loader resolves the bare
package name without installing anything.

```sh
# 1. build (dev dependencies are symlinks into the harness checkout — see
#    node_modules/, which mirrors dsh-web-ui's layout)
cd /Users/liyanhui/vscodeProjects/dsh-plugins/my-sider
npm run build            # → lib/index.js (host) + lib/client.js (browser)

# 2. mount it in a profile
ln -s /Users/liyanhui/vscodeProjects/dsh-plugins/my-sider ~/.dsh/profiles/web/node_modules/my-sider
```

Then add the row to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: my-sider
      name: my-sider
```

The profile patch file is **watched**: editing it recomposes the plugin tree
live, so no `dsh web` restart is needed for the host half either. The browser
half is picked up on the next **hard refresh** (Cmd/Ctrl+Shift+R) — the shell
fetches `/plugins/my-sider/client.js` at boot.

`dsh.bundle.patch` is also declared, so adding `my-sider` to a profile's
`dsh.profile.bundles` mounts the row on its own. Install ONE way: doing both
mounts the row twice.

## Configuration

Everything is optional and lives on the plugin's Loader row. A value that is
present but wrong fails **at boot with the field named**.

```yaml
- insert:
    - id: my-sider
      name: my-sider
      config:
        shell:
          enabled: true            # false = no command routes exist at all
          mode: auto               # auto | read-only | workspace-write | danger-full-access
          shell: /bin/bash         # the shell that evaluates the command line
          timeoutMs: 900000        # one command's budget before it is terminated
          bufferBytes: 262144      # retained output per run
          history: 20              # settled runs the host remembers
        relay:
          enabled: true            # false = the sidebar is direct-frame only
          timeoutMs: 20000         # one upstream fetch
          maxBytes: 8388608        # largest upstream body passed through
          allowHosts: []           # empty = any http(s) host
```

Both surfaces default to **enabled** — that is the opposite of `dsh-web-ui`'s
command bar, and deliberately so: there the bar is an extra nobody asked for,
here you installed this plugin precisely to get these two panels. Switching a
surface off removes its routes rather than hiding its controls.

## Security posture

- **The command panel runs what you type, on purpose.** It is confined by the
  deployment's own policy (see above), reports the mode it used, and is the only
  place in this plugin where a shell is involved: everywhere else the operator's
  input is an address, and the host composes the request.
- **The relay is a relay, not a proxy.** It sends no cookies and forwards no
  `set-cookie`; it caches nothing; it answers GET only. A login-gated page
  therefore arrives logged out, which is the honest behaviour and what the
  panel's hint says.
- **It strips exactly the headers that exist to stop framing**
  (`x-frame-options`, `content-security-policy`) plus the connection-level ones
  that no longer describe what is sent. Nothing else is rewritten except the
  injected `<base>` element.
- **Only `http` and `https` can be relayed.** `file:`, `data:`, and `javascript:`
  are refused, so the host cannot be asked to read the filesystem on a page's
  behalf.
- **`config.relay.allowHosts`** narrows the relay to a list. Empty (the default)
  allows any http(s) host, which is the useful default on a machine whose GUI
  listens only on loopback; a deployment that exposes its GUI beyond localhost
  should fill it in.
- **Relayed content cannot touch the GUI**: the frame runs on an opaque origin.

## Layout

| Path | What lives there |
|---|---|
| `src/index.ts` | the host entry: two injection scopes — the relay needs only a webserver, the command panel additionally needs the process and confinement seams |
| `src/host/options.ts` | the row config, hand-validated at boot with the field named |
| `src/host/shell.ts` | the command service: spawn under the resolved policy, bounded output, absolute-offset ring buffer |
| `src/host/relay.ts` | the URL relay: bounded fetch, framing headers lifted, `<base>` injected, HTML errors that render inside the frame |
| `src/host/routes.ts` | every route, registered per surface, each handler wrapped so one throw cannot take the carrier down |
| `src/shared/wire.ts` | the wire contract both halves share |
| `src/client/index.tsx` | the browser entry: stylesheet, dictionaries, and the two-path launcher registration (the shared row, or this plugin's own pinned bar) |
| `src/client/Launcher.tsx` | the two controls, and the geometry both panels share |
| `src/client/WebPanel.tsx` | the sidebar: tabs, address bar, direct/relay, probe notices |
| `src/client/ShellPanel.tsx` | the bottom panel: input, output, run history, resize |
| `src/client/styles.ts` | every style this plugin owns, over ui-theme's semantic tokens |

It occupies no `single` seat, declares no child seats, and disables no shipped
row — so it can be installed beside other UI plugins without taking anything away.
Beside `dsh-web-ui` it fills that plugin's `shell.action` seat (the controls above
are then part of its action row); alone it keeps its own pinned bar.

## Verifying

```sh
npm run typecheck     # tsc over the host unit and the client unit, separately
npm run smoke         # host routes over a real socket + the built bundle in a DOM
```

The smoke test drives the real pieces: route handlers over HTTP, the relay
against a local upstream that forbids framing, and the BUILT `lib/client.js`
loaded through the shell's own registration protocol, rendered in jsdom, clicked
at real nodes — with the panel's own fetches re-anchored at the route server, so
a click in the DOM exercises the real host code. It requires `jsdom` and
`react-dom` to resolve from this package (dev-only, like `dsh-web-ui`).

## Known limits

- **Some sites cannot be shown at all**, in either mode: a relayed page that
  needs its own session, its own cookies, or absolute-URL navigation will render
  incompletely. The panel offers the browser tab for those.
- **No pty.** Interactive programs (`vim`, `top`, `ssh`, a REPL that expects a
  tty) do not work in the bottom panel; a real terminal is a different feature.
- **One command at a time per run** — the panel keeps history and lets you switch
  between runs, but does not multiplex stdin.
- **A session-less GUI has no project directory**, so the command panel falls
  back to the directory `dsh web` was started in until you set one.
