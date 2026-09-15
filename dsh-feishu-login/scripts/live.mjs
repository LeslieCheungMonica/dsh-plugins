/**
 * Shared helpers for the live scripts (`smoke-browser.mjs`, `verify-armed.mjs`).
 *
 * They answer two questions the scripts keep asking about a running GUI — is
 * the gate armed, and how do I get in without a phone — from the same sources
 * the host itself uses: the app id out of the profile patch, the secret out of
 * the credential document, and the session minted by the plugin's own
 * `issueSession` (so the signing scheme under test is the real one).
 *
 * Nothing here ever prints the secret.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { internals } from '../lib/index.js'

/** Base URL of the GUI under test. */
export const URL_BASE = (process.env['DSH_URL'] ?? 'http://127.0.0.1:3080').replace(/\/+$/u, '')

/** Profile directory that owns the loader tree. */
export const PROFILE_DIR = join(homedir(), '.dsh', 'profiles', 'web')

/** Credential reference the profile row uses. */
const SECRET_REF = 'DSH_FEISHU_LOGIN_SECRET'

/**
 * Read the configured app id from the profile patch.
 * @returns the app id, or undefined when the row carries none.
 */
export function readAppId() {
  let patch
  try {
    patch = readFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
  } catch {
    return undefined
  }
  // Only inside the feishu-login row, so another row's `appId` cannot be picked up.
  const row = /- insert:[\s\S]*?name:\s*dsh-feishu-login[\s\S]*?(?=\n- |\s*$)/u.exec(patch)?.[0] ?? ''
  return /^\s*appId:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/mu.exec(row)?.[1]
}

/**
 * Read the application secret from the same layering the host resolves.
 * @returns the secret, or undefined when it is not configured.
 */
export function readSecret() {
  if ((process.env[SECRET_REF] ?? '') !== '') return process.env[SECRET_REF]
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const value = new RegExp(`^${SECRET_REF}:\\s*(.+)$`, 'mu').exec(text)?.[1].trim()
    return value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * Ask the running host whether the gate is armed.
 * @returns the session probe body.
 */
export async function probeHost() {
  try {
    const response = await fetch(`${URL_BASE}/feishu-auth/session`, { redirect: 'manual' })
    const body = await response.json()
    return body !== null && typeof body === 'object' ? body : { configured: false, authenticated: false }
  } catch {
    return { configured: false, authenticated: false }
  }
}

/**
 * Mint a session for a synthetic identity, using the plugin's own signer.
 * @param {object} options - `name` for the identity.
 * @returns {{cookie: string, config: object} | undefined} the cookie pair, or
 * undefined when the deployment has no app id or secret to sign with.
 */
export function mintSession(options = {}) {
  const appId = readAppId()
  const secret = readSecret()
  if (appId === undefined || secret === undefined) return undefined
  const config = internals.resolveConfig({ appId, appSecretRef: SECRET_REF })
  const { token } = internals.issueSession(config, secret, {
    openId: 'ou_rehearsal_probe',
    name: options.name ?? '演练账号',
    email: 'rehearsal@example.com',
  })
  return {
    config,
    cookie: { name: config.cookieName, value: token, hint: config.hintCookieName },
  }
}

/**
 * Cookies ready for `context.addCookies`.
 * @param {object} session - the result of {@link mintSession}.
 * @returns {Array<object>} two cookie descriptors.
 */
export function cookieDescriptors(session) {
  return [
    { name: session.cookie.name, value: session.cookie.value, url: URL_BASE, httpOnly: true, sameSite: 'Lax' },
    { name: session.cookie.hint, value: '1', url: URL_BASE, sameSite: 'Lax' },
  ]
}
