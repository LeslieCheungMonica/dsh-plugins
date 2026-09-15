/**
 * The plugin's Loader-row configuration: one schema, its defaults, and the
 * normal form the rest of the host half reads (`ResolvedConfig`).
 *
 * Two rules shape this surface:
 *
 * 1. **The secret never lives here.** `appSecretRef` is a credential
 *    *reference* (a POSIX-style env name) resolved through `ctx.credentials`
 *    at each operation, exactly like the LLM adapters do — a rotated secret
 *    reaches the very next request with no restart. `appSecret` exists only as
 *    an escape hatch for a host without the credential seam.
 * 2. **An unconfigured gate is not a gate.** With no `appId` (or no resolvable
 *    secret) the plugin registers nothing that can lock a user out; it logs
 *    what is missing and stays inert. See `resolveConfig`.
 *
 * @module dsh-feishu-login/host/config
 */
import z from '@deepseek-ai/schemastery'
import type { Brand } from './feishu.ts'

/** How the QR code reaches the user. */
export type LoginMode = 'embed' | 'redirect'

/** Which embeddable QR technique the login page uses. */
export type QrEmbed = 'page' | 'sdk'

/** Plugin configuration (the Loader row's `config:` block). */
export interface Config {
  /** Feishu (Lark) application id, e.g. `cli_a1b2c3d4e5f6g7h8`. Required to activate. */
  appId?: string
  /**
   * Credential reference (POSIX-style env name) holding the application secret.
   * @default 'FEISHU_APP_SECRET'
   */
  appSecretRef?: string
  /** Inline secret for hosts without a credential provider. Prefer {@link appSecretRef}. */
  appSecret?: string
  /**
   * Which open platform the application belongs to. An application id is bound
   * to one brand — Feishu answers `20046 Brand inconsistency` for a Lark app
   * on a Feishu host and vice versa — so this is a deployment constant.
   * @default 'feishu'
   */
  brand?: Brand
  /**
   * Who may enter once Feishu has authenticated them. Empty means "anyone the
   * application can see". Rules: `*`, `open_id:<id>`, `union_id:<id>`,
   * `user_id:<id>`, `email:<address>`, `email:@<domain>`, `mobile:<number>`,
   * or a bare value matched against every identity field.
   */
  allow?: string[]
  /** Whether the gate is armed. `false` leaves the plugin loaded but transparent. */
  gate?: boolean
  /** Path of this plugin's login page. */
  loginPath?: string
  /** Path prefix of this plugin's JSON/OAuth endpoints (no trailing slash). */
  routePrefix?: string
  /** Product name printed on the login page and the account chip. */
  brandName?: string
  /** Render the brand mark beside {@link brandName}. */
  showBrandMark?: boolean
  /** Login-page headline. */
  title?: string
  /** Login-page supporting line. */
  subtitle?: string
  /** Session lifetime in hours. */
  sessionTtlHours?: number
  /** Session cookie name (the credential: HttpOnly + signed). */
  cookieName?: string
  /** Hint cookie name (readable by page scripts; carries no identity). */
  hintCookieName?: string
  /** Add `Secure` to both cookies; only for a TLS deployment. */
  cookieSecure?: boolean
  /** Show the signed-in identity chip after login. */
  accountChip?: boolean
  /**
   * Hide the shipped "Session log" download button from the session header, so
   * the account chip owns that corner instead of sharing it.
   * @default true
   */
  hideSessionLog?: boolean
  /** OAuth scopes requested on the authorize URL; omitted when empty. */
  scopes?: string
  /**
   * `embed` renders the QR inside this plugin's login page (the QR *is* the
   * page); `redirect` sends the whole tab to Feishu's hosted login page.
   * @default 'embed'
   */
  mode?: LoginMode
  /**
   * Which embeddable QR technique `embed` uses. `sdk` loads Feishu's official
   * QR SDK, which mounts the compact passport QR page in its own 250px frame —
   * the code lands fully inside a 300px box with no help from us, and Feishu
   * owns that layout. `page` iframes the `qrconnect` login page directly (no
   * third-party script), but that page stacks a language switcher and a title
   * above the code at narrow widths, so this plugin frames it by measurement
   * (see pages.ts) — correct today, and the thing to re-measure if that page
   * is ever redesigned.
   * @default 'sdk'
   */
  qrEmbed?: QrEmbed
  /**
   * Print the redirect URI that must be registered in the application's
   * console on the login page. Setup aid; silence it once configured.
   * @default true
   */
  showRedirectUri?: boolean
  /** Log every authenticated identity at login, so an allowlist can be filled in from the host log. */
  logIdentity?: boolean
  /** Served frontend `index.html`; resolved from the profile when omitted. */
  distIndex?: string
}

/** Validated, normal-form configuration the runtime works against. */
export interface ResolvedConfig {
  /** Application id (non-empty; {@link Config.appId} after trimming). */
  appId: string
  /** Credential reference for the application secret. */
  appSecretRef: string
  /** Inline secret, when configured. */
  appSecret: string | undefined
  /** Which open platform the application belongs to. */
  brand: Brand
  /** Allowlist rules (already trimmed, empties dropped). */
  allow: string[]
  /** A list that denies everyone: the operator asked for a locked door. */
  allowNobody: boolean
  /** Whether the gate is armed. */
  gate: boolean
  /** Login page path (always absolute, never `/`). */
  loginPath: string
  /** Endpoint prefix (always absolute, no trailing slash). */
  routePrefix: string
  /** Brand/product name. */
  brandName: string
  /** Whether to draw the brand mark. */
  showBrandMark: boolean
  /** Login headline. */
  title: string
  /** Login supporting line. */
  subtitle: string
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Session cookie name. */
  cookieName: string
  /** Hint cookie name. */
  hintCookieName: string
  /** Whether both cookies carry `Secure`. */
  cookieSecure: boolean
  /** Whether the signed-in chip renders. */
  accountChip: boolean
  /** Whether the shipped session-log header button is displaced. */
  hideSessionLog: boolean
  /** Requested OAuth scopes ('' = let the app decide). */
  scopes: string
  /** QR delivery mode. */
  mode: LoginMode
  /** Embeddable QR technique. */
  qrEmbed: QrEmbed
  /** Whether the login page prints the redirect URI to register. */
  showRedirectUri: boolean
  /** Whether the host log records each login's identity. */
  logIdentity: boolean
  /** Explicit `index.html` path, when configured. */
  distIndex: string | undefined
}

/** Default session lifetime: one working day. */
export const DEFAULT_TTL_HOURS = 12

/**
 * Cordis configuration schema. Roles and defaults are documented on
 * {@link Config}; every field without `.default()` is optional.
 */
export const Config: z<Config> = z.object({
  appId: z.string(),
  appSecretRef: z.string().default('FEISHU_APP_SECRET'),
  appSecret: z.string(),
  brand: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
  allow: z.array(String).default([]),
  gate: z.boolean().default(true),
  loginPath: z.string().default('/login'),
  routePrefix: z.string().default('/feishu-auth'),
  brandName: z.string().default('ForgeX'),
  showBrandMark: z.boolean().default(true),
  title: z.string(),
  subtitle: z.string(),
  sessionTtlHours: z.number().default(DEFAULT_TTL_HOURS),
  cookieName: z.string().default('dsh_feishu_session'),
  hintCookieName: z.string().default('dsh_feishu_hint'),
  cookieSecure: z.boolean().default(false),
  accountChip: z.boolean().default(true),
  hideSessionLog: z.boolean().default(true),
  scopes: z.string(),
  mode: z.union([z.const('embed'), z.const('redirect')]).default('embed'),
  qrEmbed: z.union([z.const('page'), z.const('sdk')]).default('sdk'),
  showRedirectUri: z.boolean().default(true),
  logIdentity: z.boolean().default(true),
  distIndex: z.string(),
})

/** The `*` rule: the only way to say "everyone" now that empty means "nobody" is not assumed. */
const ALLOW_ALL = '*'

/** The `none:` rule: an explicit, loud "deny everyone". */
const ALLOW_NOBODY = 'none'

/**
 * Trim a configured path into an absolute path with no trailing slash.
 * @param raw - the configured value.
 * @param fallback - the default when the value is empty or not absolute.
 * @returns the normalized path.
 */
function normalizePath(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim()
  if (value === '' || !value.startsWith('/')) return fallback
  const trimmed = value.replace(/\/+$/u, '')
  return trimmed === '' ? fallback : trimmed
}

/**
 * Normalize a validated {@link Config} into {@link ResolvedConfig}.
 * @param config - the Loader row's validated configuration.
 * @returns the normal form every consumer reads.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const rules = (config.allow ?? []).map(rule => rule.trim()).filter(rule => rule !== '')
  const allowNobody = rules.length === 1 && rules[0]?.toLowerCase() === ALLOW_NOBODY
  const loginPath = normalizePath(config.loginPath, '/login')
  const routePrefix = normalizePath(config.routePrefix, '/feishu-auth')
  const brandName = (config.brandName ?? '').trim() || 'ForgeX'
  return {
    appId: (config.appId ?? '').trim(),
    appSecretRef: (config.appSecretRef ?? '').trim() || 'FEISHU_APP_SECRET',
    appSecret: emptyToUndefined(config.appSecret),
    brand: config.brand === 'lark' ? 'lark' : 'feishu',
    allow: allowNobody ? [] : rules,
    allowNobody,
    gate: config.gate !== false,
    // A login page on `/` would shadow the GUI it guards; keep them distinct.
    loginPath: loginPath === '/' ? '/login' : loginPath,
    routePrefix,
    brandName,
    showBrandMark: config.showBrandMark !== false,
    title: (config.title ?? '').trim() || '扫码登录',
    subtitle: (config.subtitle ?? '').trim()
      || `请使用手机端飞书扫描二维码，登录后进入 ${brandName}`,
    sessionTtlSeconds: Math.max(60, Math.round((config.sessionTtlHours ?? DEFAULT_TTL_HOURS) * 3600)),
    cookieName: (config.cookieName ?? '').trim() || 'dsh_feishu_session',
    hintCookieName: (config.hintCookieName ?? '').trim() || 'dsh_feishu_hint',
    cookieSecure: config.cookieSecure === true,
    accountChip: config.accountChip !== false,
    hideSessionLog: config.hideSessionLog !== false,
    scopes: (config.scopes ?? '').trim(),
    mode: config.mode === 'redirect' ? 'redirect' : 'embed',
    qrEmbed: config.qrEmbed === 'page' ? 'page' : 'sdk',
    showRedirectUri: config.showRedirectUri !== false,
    logIdentity: config.logIdentity !== false,
    distIndex: emptyToUndefined(config.distIndex),
  }
}

/**
 * Treat a blank string as absent, so `appSecret: ''` cannot masquerade as a
 * configured credential (the credentials seam applies the same rule).
 * @param value - the raw configured value.
 * @returns the trimmed value, or undefined when blank.
 */
function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The identity fields a rule may address, and the scope each one needs.
 *
 * This table is what turns "everybody is denied and nobody knows why" into a
 * sentence: when a rule names a field Feishu did not return, the identity was
 * never missing from the allowlist, the *scope* was — see
 * {@link unmatchedRuleHints}.
 */
const RULE_FIELDS = {
  open_id: { scope: undefined, label: 'open_id' },
  union_id: { scope: undefined, label: 'union_id' },
  user_id: { scope: 'contact:user.employee_id:readonly', label: 'user_id' },
  email: { scope: 'contact:user.email:readonly', label: 'email' },
  mobile: { scope: 'contact:user.phone:readonly', label: 'mobile' },
} as const

/** One identity, in the shape the allowlist evaluates. */
export interface AllowIdentity {
  /** Feishu `open_id` (always present). */
  openId?: string | undefined
  /** Feishu `union_id`. */
  unionId?: string | undefined
  /** Feishu `user_id` (needs a scope). */
  userId?: string | undefined
  /** Primary email (needs a scope). */
  email?: string | undefined
  /** Enterprise email (needs a scope). */
  enterpriseEmail?: string | undefined
  /** Mobile number (needs a scope). */
  mobile?: string | undefined
}

/** Whether an email rule can be evaluated against this identity at all. */
function hasEmail(identity: AllowIdentity): boolean {
  return (identity.email ?? '') !== '' || (identity.enterpriseEmail ?? '') !== ''
}

/** Whether one rule kind has a value to compare against. */
function fieldPresent(kind: string, identity: AllowIdentity): boolean {
  if (kind === 'open_id') return (identity.openId ?? '') !== ''
  if (kind === 'union_id') return (identity.unionId ?? '') !== ''
  if (kind === 'user_id') return (identity.userId ?? '') !== ''
  if (kind === 'mobile') return (identity.mobile ?? '') !== ''
  if (kind === 'email') return hasEmail(identity)
  return true
}

/**
 * Explain why a configured allowlist could not have matched, which is the one
 * failure mode with no obvious cause from the outside: a rule that names a
 * field Feishu withheld.
 *
 * `authen/v1/user_info` returns `open_id`, `union_id`, `name` and the avatar
 * unconditionally, but `email`, `user_id` and `mobile` only when the
 * application holds the matching scope — and a withheld field is a *silent*
 * omission, not an error. Without this hint, an `email:@corp.com` allowlist on
 * an application without `contact:user.email:readonly` looks exactly like a
 * wrong allowlist.
 * @param resolved - normalized configuration.
 * @param identity - the identity that was refused.
 * @returns one operator-facing sentence per unusable rule kind.
 */
export function unmatchedRuleHints(resolved: ResolvedConfig, identity: AllowIdentity): string[] {
  const hints: string[] = []
  const seen = new Set<string>()
  for (const rule of resolved.allow) {
    const separator = rule.indexOf(':')
    const kind = (separator < 0 ? '' : rule.slice(0, separator)).toLowerCase()
    if (kind === '' || seen.has(kind)) continue
    if (fieldPresent(kind, identity)) continue
    seen.add(kind)
    const scope = (RULE_FIELDS as Record<string, { scope: string | undefined }>)[kind]?.scope
    hints.push(
      scope === undefined
        ? `白名单里的 ${kind} 规则无法匹配：user_info 没有返回该字段。`
        : `白名单里的 ${kind} 规则无法匹配：user_info 没有返回该字段。请在飞书后台开通 ${scope}，`
          + `并把该 scope 写进本插件的 scopes 配置。`,
    )
  }
  return hints
}

/**
 * Whether the allowlist accepts an identity.
 * @param resolved - normalized configuration.
 * @param identity - the fields a rule may match.
 * @returns true when the identity may enter.
 */
export function isAllowed(resolved: ResolvedConfig, identity: AllowIdentity): boolean {
  if (resolved.allowNobody) return false
  if (resolved.allow.length === 0) return true
  const emails = [identity.email, identity.enterpriseEmail]
    .filter((value): value is string => value !== undefined && value !== '')
    .map(value => value.toLowerCase())
  const fields = [
    identity.openId,
    identity.unionId,
    identity.userId,
    identity.mobile,
    ...emails,
  ].filter((value): value is string => value !== undefined && value !== '')

  for (const rule of resolved.allow) {
    if (rule === ALLOW_ALL) return true
    const separator = rule.indexOf(':')
    const kind = separator < 0 ? '' : rule.slice(0, separator).toLowerCase()
    const value = separator < 0 ? rule : rule.slice(separator + 1)
    if (value === '') continue
    if (kind === '') {
      if (fields.some(field => field.toLowerCase() === value.toLowerCase())) return true
      continue
    }
    if (kind === 'email') {
      const wanted = value.toLowerCase()
      // `email:@corp.com` matches the whole domain; `email:a@b.c` one address.
      if (wanted.startsWith('@')) {
        if (emails.some(email => email.endsWith(wanted))) return true
      } else if (emails.some(email => email === wanted)) return true
      continue
    }
    const wantedField = kind === 'open_id' ? identity.openId
      : kind === 'union_id' ? identity.unionId
        : kind === 'user_id' ? identity.userId
          : kind === 'mobile' ? identity.mobile
            : undefined
    if (wantedField !== undefined && wantedField === value) return true
  }
  return false
}
