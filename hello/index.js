/**
 * dsh-hello — the smallest useful DeepSeek Harness plugin: it contributes one
 * model-callable `hello` tool and nothing else.
 *
 * A Cordis plugin is a module that named-exports `apply(ctx, config)`.
 * Everything registered through `ctx` is an effect owned by this plugin, so
 * unloading it (an HMR config edit, a Loader re-compose) unregisters the tool
 * without any cleanup code here.
 *
 * Plain ESM JavaScript on purpose: this package lives outside the harness
 * workspace, so it ships no build step and depends on no TypeScript runtime.
 *
 * @module dsh-hello
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

/** Display metadata: labels this plugin in Cordis diagnostics. */
export const name = 'hello'

/**
 * Hard dependency. Declaring it holds this plugin in PENDING until the tool
 * registry exists, so `apply` never runs against a missing service.
 */
export const inject = ['tools']

/**
 * Configuration owned by this plugin's Loader row.
 * @typedef {object} Config
 * @property {string} greeting Word prefixed to every greeting. Anything two
 * deployments may want to set differently belongs here rather than in a module
 * constant.
 */

/**
 * Runtime validator Cordis uses to fill defaults and reject bad config.
 * `Config` is read by the Cordis Loader as a Standard Schema, so it must be
 * this schema object rather than a plain object literal.
 */
export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
})

/**
 * Register the `hello` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx The plugin context every
 * contribution is registered through.
 * @param {Config} config Validated configuration from the Loader row.
 * @returns {void}
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'hello',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    /**
     * @param {{ name: string }} args Validated model arguments.
     * @returns {Promise<string>} The greeting the model sees as this call's result.
     */
    async execute(args) {
      return `${config.greeting}, ${args.name}! 👋`
    },
  }))

  console.log(`[hello] plugin loaded (greeting: ${JSON.stringify(config.greeting)})`)
}
