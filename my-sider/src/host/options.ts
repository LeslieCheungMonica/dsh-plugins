/**
 * This plugin's row config, validated once at boot.
 *
 * Hand-validated rather than schema-validated on purpose: the package carries no
 * runtime dependencies (every `@deepseek-ai/*` import in the host half is
 * type-only), and a Cordis `Config` schema object would have to be imported from
 * `@deepseek-ai/schemastery` at runtime. The effect is the same — a bad value
 * fails loudly at boot with the field NAMED, rather than being ignored and
 * discovered later as odd behaviour inside a panel.
 *
 * Both surfaces default to ENABLED. That is the opposite of `dsh-web-ui`'s
 * command bar, and deliberately so: there the bar is an extra nobody asked for,
 * here the operator installed this plugin precisely to get a command panel and a
 * web panel. Each can still be switched off — and switching the command panel
 * off removes its routes entirely rather than hiding its controls.
 *
 * @module my-sider/host/options
 */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** The command panel's decisions. */
export interface ShellOptions {
  /** Whether the command panel exists at all. */
  readonly enabled: boolean
  /**
   * File-effect policy for operator commands. `auto` follows whatever the
   * deployment resolves for a sessionless call — the default, and the only
   * choice that cannot surprise by disagreeing with the rest of the deployment.
   */
  readonly mode: SandboxMode | 'auto'
  /** How long one command may run before it is terminated, in milliseconds. */
  readonly timeoutMs: number
  /** How much output is retained per run, in bytes. */
  readonly bufferBytes: number
  /** The shell that evaluates the command line. */
  readonly shell: string
  /** How many settled runs the host remembers. */
  readonly history: number
}

/** The web panel's relay decisions. */
export interface RelayOptions {
  /**
   * Whether the host-side relay exists at all. With it off, the web panel still
   * works — every tab is then a direct iframe, and sites that refuse framing
   * simply refuse.
   */
  readonly enabled: boolean
  /** How long one upstream fetch may take, in milliseconds. */
  readonly timeoutMs: number
  /** Largest upstream body the relay will pass through, in bytes. */
  readonly maxBytes: number
  /**
   * Host allowlist for relayed URLs. Empty means any `http(s)` host, which is
   * the useful default on a single-operator machine; a deployment that exposes
   * its GUI beyond localhost should list the hosts it means to allow.
   */
  readonly allowHosts: readonly string[]
}

/** Everything this plugin's row may configure. */
export interface PluginOptions {
  /** The command panel's decisions. */
  readonly shell: ShellOptions
  /** The relay's decisions. */
  readonly relay: RelayOptions
}

/** Mode vocabulary accepted for `shell.mode`, in report order. */
const MODES: readonly (SandboxMode | 'auto')[] = ['auto', 'read-only', 'workspace-write', 'danger-full-access']

/**
 * Narrow a value to a config record.
 * @param raw - the value as loaded from the row.
 * @param label - the field path, for the error sentence.
 * @returns the record.
 */
function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`my-sider: ${label} must be an object`)
  }
  return raw as Record<string, unknown>
}

/**
 * Read one positive number field.
 * @param record - the config record.
 * @param key - the field name.
 * @param fallback - the value to use when absent.
 * @param label - the field path, for the error sentence.
 * @returns the validated value.
 */
function positive(record: Record<string, unknown>, key: string, fallback: number, label: string): number {
  const value = record[key] ?? fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`my-sider: ${label}.${key} must be a positive number`)
  }
  return Math.trunc(value)
}

/**
 * Read one boolean field.
 * @param record - the config record.
 * @param key - the field name.
 * @param fallback - the value to use when absent.
 * @param label - the field path, for the error sentence.
 * @returns the validated value.
 */
function boolean(record: Record<string, unknown>, key: string, fallback: boolean, label: string): boolean {
  const value = record[key] ?? fallback
  if (typeof value !== 'boolean') {
    throw new Error(`my-sider: ${label}.${key} must be a boolean`)
  }
  return value
}

/**
 * Read one non-empty string field.
 * @param record - the config record.
 * @param key - the field name.
 * @param fallback - the value to use when absent.
 * @param label - the field path, for the error sentence.
 * @returns the validated value.
 */
function text(record: Record<string, unknown>, key: string, fallback: string, label: string): string {
  const value = record[key] ?? fallback
  if (typeof value !== 'string' || value === '') {
    throw new Error(`my-sider: ${label}.${key} must be a non-empty string`)
  }
  return value
}

/**
 * Read this plugin's config from its Loader row.
 * @param raw - the row's `config`, as loaded.
 * @returns the validated options.
 */
export function readOptions(raw: unknown): PluginOptions {
  const root = asRecord(raw, 'config')
  const shellRecord = asRecord(root['shell'], 'config.shell')
  const mode = shellRecord['mode'] ?? 'auto'
  if (typeof mode !== 'string' || !MODES.includes(mode as SandboxMode | 'auto')) {
    throw new Error(`my-sider: config.shell.mode must be one of ${MODES.join(', ')}`)
  }

  const relayRecord = asRecord(root['relay'], 'config.relay')
  const rawHosts = relayRecord['allowHosts'] ?? []
  if (!Array.isArray(rawHosts) || rawHosts.some(host => typeof host !== 'string' || host === '')) {
    throw new Error('my-sider: config.relay.allowHosts must be an array of non-empty strings')
  }

  return {
    shell: {
      enabled: boolean(shellRecord, 'enabled', true, 'config.shell'),
      mode: mode as SandboxMode | 'auto',
      timeoutMs: positive(shellRecord, 'timeoutMs', 15 * 60_000, 'config.shell'),
      bufferBytes: positive(shellRecord, 'bufferBytes', 256 * 1024, 'config.shell'),
      shell: text(shellRecord, 'shell', '/bin/bash', 'config.shell'),
      history: positive(shellRecord, 'history', 20, 'config.shell'),
    },
    relay: {
      enabled: boolean(relayRecord, 'enabled', true, 'config.relay'),
      timeoutMs: positive(relayRecord, 'timeoutMs', 20_000, 'config.relay'),
      maxBytes: positive(relayRecord, 'maxBytes', 8 * 1024 * 1024, 'config.relay'),
      allowHosts: rawHosts as readonly string[],
    },
  }
}
