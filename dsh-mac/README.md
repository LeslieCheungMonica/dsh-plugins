# DSH Web — macOS app + DMG

A native macOS window for the DeepSeek Harness web UI, packaged as an
installable `.app` inside a `.dmg`.

```sh
scripts/build.sh            # → dist/DSH Web.app and dist/DSH-Web-0.1.0.dmg
```

The window is a `WKWebView` — no Electron, no Node runtime, no dependencies —
so the DMG is about **360 KB**: it wraps the DSH you already have instead of
carrying a copy of it.

## What it does at launch

1. **Attaches** to a DSH server that is already serving — it probes
   3080…3090 and uses the first one that answers with the DSH index.
2. **Starts one** only when nothing answers anywhere: it picks a free port and
   runs `dsh web --port <port> --no-open`, showing progress in the window, then
   loads the UI.
3. **Quits cleanly**: a host the app started is terminated on quit (SIGTERM,
   then SIGKILL after 8s); a host it merely attached to is left running.

Step 1 before step 2 is a safety property, not a convenience. Two hosts sharing
one `$DSH_HOME` write the same storage files (`storages/workspace.json`,
`storages/session_projcache.json`) with last-writer-wins semantics and no lock,
so a second host started beside a live one can clobber its state. The app never
starts a host while any DSH server is reachable, and it stops only its own
child.

## Install

```sh
open dist/DSH-Web-0.1.0.dmg      # then drag “DSH Web” into Applications
```

Because the build is **ad-hoc signed, not notarized**, the first launch needs
one explicit approval:

- right-click the app in Applications → **打开** (Open), or
- `xattr -dr com.apple.quarantine "/Applications/DSH Web.app"`

After that it launches normally, including from Launchpad.

## Verifying

```sh
# Discovery, attach probe, free-port pick — no GUI, no side effects. The
# discovery half is hermetic: it builds a throwaway nvm/pnpm/volta tree under
# /tmp and asserts each install is found, so it passes on a machine with no
# DSH at all.
"dist/DSH Web.app/Contents/MacOS/DSHWeb" --selftest

# Also start and stop a real host, against an isolated DSH_HOME and an unused
# port, so nothing touches your own server or ~/.dsh:
DSH_SELFTEST_SPAWN=1 DSH_HOME=/tmp/dsh-app-test DSH_WEB_PORT=3199 \
  "dist/DSH Web.app/Contents/MacOS/DSHWeb" --selftest
```

`CFFIXED_USER_HOME` redirects the home every `~` in discovery resolves against
(Foundation ignores `$HOME`, so `env -i HOME=…` does *not* work). That makes the
recipient's machine reachable from yours — an nvm-only install, with no
well-known shim and no checkout to fall back on:

```sh
H=/tmp/dsh-recipient
mkdir -p "$H/.nvm/versions/node/v22.22.2/bin"
printf '#!/bin/sh\nexit 0\n' > "$H/.nvm/versions/node/v22.22.2/bin/dsh"
chmod +x "$H/.nvm/versions/node/v22.22.2/bin/dsh"
CFFIXED_USER_HOME="$H" DSH_CHECKOUT=/nonexistent PATH=/usr/bin:/bin \
  "dist/DSH Web.app/Contents/MacOS/DSHWeb" --selftest
# → selftest: cli=/tmp/dsh-recipient/.nvm/versions/node/v22.22.2/bin/dsh
```

The running app also reports what its window is rendering, four seconds after
the first page load:

```
[2026-…] page health: {"title":"DSH Local Build","bootGraph":true,"routedToHost":"3080",
  "sidebarColumn":true,"projectRow":true,"newSession":true,
  "browserSeat":1,"settingsSeat":1,"slotErrors":0,"conversation":true}
```

That line is the quickest way to tell "the window is blank" apart from "the
window is showing a page whose plugins failed".

## Configuration

Every knob is an environment variable, so it can be set for one launch
(`VAR=x open -a "DSH Web"`) or per app bundle via `launchctl setenv`:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_WEB_PORT` | `3080` | Preferred port: probed first, and the base of the probe band |
| `DSH_WEB_HOST` | `127.0.0.1` | Address the app talks to |
| `DSH_BIN` | auto | Explicit `dsh` executable, beating all discovery |
| `DSH_NODE` | auto | Explicit `node`, when the fallback CLI path is used |
| `DSH_CHECKOUT` | unset | Checkout whose `apps/cli/lib/bin.js` is the last-resort CLI. No guess is made when it is unset: the app is shipped to other machines, and the builder's own checkout path exists on none of them. |
| `DSH_START_TIMEOUT` | `180` | Seconds to wait for a freshly started host to serve |

CLI discovery order: `$DSH_BIN` → `~/.local/bin/dsh` → `/usr/local/bin/dsh` →
`/opt/homebrew/bin/dsh` → `~/bin/dsh` → `dsh` on `PATH` → a `dsh` beside the node
this app would use → `~/Library/pnpm/dsh` → `~/.volta/bin/dsh` → every
`~/.nvm/versions/node/*/bin/dsh` (highest version first) → `node
$DSH_CHECKOUT/apps/cli/lib/bin.js`, and that last one **only** when
`DSH_CHECKOUT` is set.

The node-manager entries matter more than they look. A Finder-launched app
inherits a minimal `PATH`, so a `dsh` installed by nvm, fnm, volta or pnpm is
invisible to it: `npm i -g @deepseek-ai/dsh` under nvm lands in
`~/.nvm/versions/node/<version>/bin/dsh`, which no shell startup file can hand
to an app launched from Launchpad. The node-adjacent rule covers fnm and volta
(whose installs can live outside the home entirely) by looking beside the `node`
binary the app already resolved.

A Finder-launched app also cannot see the shell's `PATH` for the child process,
so the child is handed an environment whose `PATH` starts with the directory of
the `node` binary that belongs to the discovered CLI — including nvm-managed
installs under `~/.nvm/versions/node`, which are otherwise invisible to it.

## Files

| Path | Role |
|---|---|
| `Sources/main.m` | Entry point, the headless `--selftest`, the app delegate, window, menus, web view |
| `Sources/DSHServer.m` | Host resolution: probing, free-port pick, CLI discovery, spawn/stop, output tail |
| `Sources/WebPages.m` | The loading and error documents (inline HTML, no resources) |
| `Sources/Log.m` | Logger: stderr + `~/Library/Logs/DSHWeb.log` |
| `Sources/DSHWeb.h` | Shared declarations |
| `Resources/Info.plist` | Bundle manifest, ATS loopback exceptions, single-instance flag |
| `scripts/make-icon.m` | Draws `AppIcon.iconset` (gradient tile + monogram, bubble below 64px) |
| `scripts/build.sh` | Icon → universal compile → bundle → ad-hoc sign → DMG |

## Why Objective-C and not Swift

This machine's Command Line Tools ship a Swift compiler that refuses the
installed SDK's module interfaces (`failed to build module 'AppKit'; this SDK is
not supported by the compiler`), which makes any Swift build fail in a way no
amount of source fixing can help. `clang` compiles the same AppKit + WebKit code
in about a second with nothing to install, so the app is plain Objective-C with
ARC. Nothing here is Swift-specific; the file layout would port either way.

## Changing things

- **App name / bundle id / version** live in `Resources/Info.plist` (the build
  script reads the version from it for the DMG name).
- **Icon**: `scripts/make-icon.m` draws every size; the gradient and monogram are
  constants there.
- **Menus**: `-buildMenu` in `Sources/main.m`. The Edit menu is not decorative —
  it carries the responder-chain actions the composer needs for Cmd+C/V/A.
- **Window chrome**: the app uses a standard opaque title bar on purpose. A
  full-size content view puts the traffic lights on top of the page's own
  top-left corner (the sidebar's brand row); if you want that look, add top
  padding to the page rather than letting the buttons overlap it.
- **Signing**: replace the ad-hoc step in `scripts/build.sh` with
  `codesign --force --options runtime --sign "Developer ID Application: …"`,
  then notarize (`xcrun notarytool submit … --wait` and
  `xcrun stapler staple`). The rest of the build does not change.

## Known limitations

- **The DMG carries no DSH.** The app is a viewer for a `dsh web` host, so an
  operator needs the CLI first: `npm i -g @deepseek-ai/dsh`. Without it the
  window explains that and offers a retry, but it cannot install one. The npm
  package named plain `dsh` is an unrelated third-party shell — installing that
  will not help.
- **Unsigned/notarization-free** — the first launch needs the operator's
  approval, and on a machine with a stricter Gatekeeper policy the app may be
  refused outright until it is signed. On macOS 15+ the old right-click → Open
  shortcut no longer bypasses Gatekeeper; use System Settings → Privacy &
  Security → Open Anyway.
- **The window is a viewer, not a supervisor.** If the attached host dies, the
  page stops updating until you reload (⌘R) — the app will re-resolve then, and
  start a host if none is left.
- **No menu-bar item, no auto-launch, no dock badge.** The app is deliberately
  one window with one job.
- **Ports 3080–3090 are the probe band.** A DSH server outside that band is not
  discovered, and the app would start its own host instead — set
  `DSH_WEB_PORT` to move the band.
- **Universal (`arm64` + `x86_64`), macOS 13+.** The DMG is not notarized, so
  distribution beyond this machine means signing it first.
