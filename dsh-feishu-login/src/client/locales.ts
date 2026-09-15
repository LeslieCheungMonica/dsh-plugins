/**
 * Copy for this plugin's browser surfaces.
 *
 * The namespace is `feishulogin`; it is registered by this plugin's apply and
 * read by nobody else, so a reload of this plugin can never strip a dictionary
 * another surface depends on.
 */

/** Chinese dictionary (the key source of truth). */
export const zh = {
  'gate.checking': '正在校验登录状态…',
  'gate.expired.title': '登录状态已失效',
  'gate.expired.message': '这个标签页的登录已过期，正在前往登录页…',
  'gate.action': '去登录',
  'chip.signedInAs': '已登录：{name}',
  'chip.logout': '退出登录',
  'chip.loggingOut': '正在退出…',
  'chip.failed': '退出失败，请重试',
  'chip.expiresAt': '有效期至 {time}',
}

/** English dictionary (same keys; the key union is taken from {@link zh}). */
export const en: Record<FeishuLoginKey, string> = {
  'gate.checking': 'Checking your session…',
  'gate.expired.title': 'Session expired',
  'gate.expired.message': 'This tab\'s session has expired. Taking you to the login page…',
  'gate.action': 'Go to login',
  'chip.signedInAs': 'Signed in as {name}',
  'chip.logout': 'Sign out',
  'chip.loggingOut': 'Signing out…',
  'chip.failed': 'Sign-out failed, please retry',
  'chip.expiresAt': 'Valid until {time}',
}

/** Every key this plugin's namespace carries. */
export type FeishuLoginKey = keyof typeof zh
