/**
 * Ask Feishu to describe the application this deployment is configured with.
 *
 * `20029 redirect_uri unmatch` has three possible causes — a wrong string, an
 * empty list, or a different application — and they are indistinguishable from
 * the error page alone. The application-info API settles it: the response
 * carries the app's **name**, its online version, its default ability, and the
 * `redirect_urls` list that is actually in effect. So this script answers "is
 * the id in my config the app whose console page I just edited, and does that
 * app really accept my callback?".
 *
 * It uses the app's own tenant access token (minted from the configured
 * id/secret), so it needs no console access and no extra scope, and it never
 * prints the secret.
 *
 * Usage: node scripts/probe-app.mjs
 *   node scripts/probe-app.mjs cli_xxxxxxxx   # check another application
 */
import { readAppId, readSecret } from './live.mjs'

const APP_INFO = 'https://open.feishu.cn/open-apis/application/v6/applications'
const APP_TOKEN = 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal'

const appId = process.argv[2] ?? readAppId()
const secret = readSecret()
if (appId === undefined || secret === undefined) {
  console.error('probe-app:需要 appId（配置里或命令行给）和 FEISHU_APP_SECRET 凭证。')
  process.exit(2)
}

const playwright = await import('playwright').catch(() => {
  console.error('probe-app: playwright is not resolvable — see README, "Verifying".')
  process.exit(2)
})

// Playwright's request context, not `node:fetch`: it uses the browser's network
// stack, which is the one that actually reaches open.feishu.cn on a machine
// behind a captive portal or a corporate proxy.
const api = await playwright.request.newContext()

const tokenResponse = await api.post(APP_TOKEN, {
  headers: { 'content-type': 'application/json; charset=utf-8' },
  data: { app_id: appId, app_secret: secret },
})
const token = await tokenResponse.json()
if (token.code !== 0) {
  console.error(`凭据无效或应用不存在：code=${String(token.code)} msg=${String(token.msg)}`)
  await api.dispose()
  process.exit(1)
}
console.log(`凭据有效：app_id 与 secret 属于同一个应用\n`)

const response = await api.get(`${APP_INFO}/${appId}?lang=zh_cn`, {
  headers: { authorization: `Bearer ${token.tenant_access_token}` },
})
const body = await response.json()
const app = body?.data?.app ?? {}

console.log(`app_id                 : ${appId}`)
console.log(`应用名                 : ${app.app_name ?? '(未知)'}`)
console.log(`状态                   : ${app.status === 1 ? '已启用' : String(app.status)}`)
console.log(`在线版本               : ${app.online_version_id ?? '（无：从未发布过，配置不会生效）'}`)
console.log(`桌面端默认能力         : ${app.pc_default_ability ?? '(未设置)'}`)
console.log(`移动端默认能力         : ${app.mobile_default_ability ?? '(未设置)'}`)
console.log(`主页地址               : ${JSON.stringify(app.back_home_url ?? '')}`)

/** The effective OAuth redirect list — empty means every callback is 20029. */
const redirects = app.redirect_urls ?? []
console.log(`生效的重定向 URL（${String(redirects.length)} 条）:`)
if (redirects.length === 0) {
  console.log('  （空）→ 任何回调地址都会被拒为 20029：要么没保存，要么没发版，要么改的是另一个应用')
} else {
  for (const entry of redirects) console.log(`  - ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`)
}

await api.dispose()
