# dsh-hello

A minimal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: it registers exactly one model-callable tool, `hello`, so the agent can greet someone by name.

`dsh-hello` is a real package, not a snippet — it declares `dsh.bundle`, ships its own configuration layer, and appears as its own row in **Web Settings → Plugins → Plugin list**.

## What it contributes

| Contribution | Surface | What you see |
| --- | --- | --- |
| `hello` tool | model-callable | `Hello, Ada! 👋` as the tool result |
| Startup log line | Host terminal | `[hello] plugin loaded (greeting: "Hello")` |
| `greeting` config | Loader row (`cordis.yml`) | default `Hello`, changeable per deployment |
| Loader entry `hello` | Web Settings plugin list | card titled `hello`, *enabled* tag, active status dot |

Nothing else: no browser half, no settings namespace, no persistent state.

## Layout

```
hello/
├── package.json        # name "dsh-hello", type module, dsh.bundle declaration
├── index.js            # the plugin: exports name, inject, Config, apply
├── cordis.patch.yml    # this package's bundle layer: inserts Loader entry `hello`
└── node_modules/       # dev link (git-ignored), see "Dependencies" below
```

## The tool

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'hello',
  description: 'Greet someone by name.',
  parameters: { name: { type: 'string', required: true, description: 'Who to greet' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) { return `${config.greeting}, ${args.name}! 👋` },
}))
```

`inject: ['tools']` holds the plugin in PENDING until the tool registry exists. `register()` returns the exact effect disposer, which Cordis owns, so unloading the plugin unregisters the tool with no cleanup code here.

Ask the agent to *"use the hello tool to greet Ada"* and the tool returns `Hello, Ada! 👋`.

## Configuration

```yaml
- insert:
    - id: hello
      name: dsh-hello
      config:
        greeting: Hi          # → "Hi, Ada! 👋"
```

The schema default is `Hello`. An invalid value fails the plugin's load with an actionable error rather than starting a half-configured plugin.

## Dependencies

This package lives outside the harness workspace, so Node's parent walk from its real path finds no `node_modules`. One runtime dependency needs a local link:

```sh
mkdir -p node_modules/@deepseek-ai
ln -s <checkout>/packages/core/tools node_modules/@deepseek-ai/dsh-tools
ln -s <checkout>/vendor/schemastery   node_modules/@deepseek-ai/schemastery
```

`<checkout>` is the harness checkout that is actually running (`/Users/liyanhui/vscodeProjects/deepseek-harness` in this deployment). Linking rather than copying keeps one module instance per package. The symlinks are read-only references; no harness file is modified.

## Install and uninstall

**Hot mount (what this deployment uses).** The profile's user patch layer is watched live, so an edit applies without restarting the Web server:

```sh
ln -s /Users/liyanhui/vscodeProjects/dsh-plugins/hello \
      ~/.dsh/profiles/web/node_modules/dsh-hello      # bare-name resolution
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: hello
      name: dsh-hello
```

To uninstall, remove the `insert` entry (an empty layer is `[]`, not an empty file) and delete the profile symlink.

**Bundle install (restart required).** Because the manifest declares `dsh.bundle`, the standard path also works:

```sh
pnpm dsh plugin --profile web add /Users/liyanhui/vscodeProjects/dsh-plugins/hello
```

That appends `dsh-hello` to the profile's `dsh.profile.bundles`, so the layer applies at boot. Remove the `insert` row from `cordis.patch.yml` first — otherwise the entry would be inserted twice.

## Verifying it is live

1. **Composition** — `pnpm dsh --profile web --dump-config` prints a `# == dsh-hello` layer containing the `hello` row.
2. **Mount** — reopen **Settings → Plugins → Plugin list**. The tab snapshots once per Settings mount, so a list opened before the edit will not show it; reopen Settings. The card reads `hello` (the module short name), tagged *enabled*, with an active status dot.
3. **Behaviour** — ask the agent to use the `hello` tool.

## Notes

- The card title is the Loader row's specifier with scope and `dsh-`/`cordis-plugin-` prefixes stripped — which is why the row uses the bare name `dsh-hello` and not an absolute path (that would render the whole path as the title).
- `name = 'hello'` is display metadata for Cordis diagnostics; it is not the Loader entry id (that is `id: hello` in the patch) and not the tool name.
