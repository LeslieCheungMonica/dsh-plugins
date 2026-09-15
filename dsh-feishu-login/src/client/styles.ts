/**
 * The browser half's stylesheet.
 *
 * Both surfaces live in the frame's `shell.overlay` layer, which is
 * `pointer-events: none` with `pointer-events: auto` on its direct children —
 * so the gate is one fixed, opaque child that swallows every click, and the
 * chip is a second, small one that opts back in on its own box only.
 *
 * Colours ride the shell's semantic tokens (`--dsw-alias-*`) with hard-coded
 * fallbacks: this plugin may render on a composition whose theme plugin is not
 * the one it was written against, and a missing custom property must degrade to
 * a readable colour rather than to nothing.
 */

/** Identifier the stylesheet tag carries (plugin attribution + HMR eviction). */
export const STYLE_TAG_ID = 'dsh-feishu-login/styles'

/** The stylesheet body. */
export const STYLES = `
[data-dshfl='gate'] {
  position: fixed;
  inset: 0;
  z-index: 90;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-base, #0e1013);
  color: var(--dsw-alias-label-primary, #eef0f4);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
}
[data-dshfl='gate'] .dshfl-card {
  max-width: 380px;
  text-align: center;
}
[data-dshfl='gate'] .dshfl-spinner {
  width: 28px;
  height: 28px;
  margin: 0 auto 18px;
  border: 2.5px solid var(--dsw-alias-border-l2, rgba(128, 140, 160, .35));
  border-top-color: var(--dsw-alias-brand-primary, #6f9dff);
  border-radius: 50%;
  animation: dshfl-spin 0.9s linear infinite;
}
@keyframes dshfl-spin { to { transform: rotate(360deg); } }
[data-dshfl='gate'] h2 {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
}
[data-dshfl='gate'] p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #98a0ad);
}
[data-dshfl='gate'] .dshfl-action {
  display: inline-block;
  margin-top: 18px;
  padding: 8px 18px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 140, 160, .35));
  color: inherit;
  font: inherit;
  font-weight: 550;
  text-decoration: none;
  background: transparent;
  cursor: pointer;
}
[data-dshfl='gate'] .dshfl-action:hover {
  border-color: var(--dsw-alias-brand-primary, #6f9dff);
  color: var(--dsw-alias-brand-primary, #6f9dff);
}

/*
 * The chip has two homes. In the session header it sits in the flow (the
 * chipHeader variant below), which is where it belongs whenever a session is
 * open. With no session there is no header to sit in, so this variant parks it
 * in the frame's top-right corner instead — the same corner the account chip
 * took over from the shipped Session-log button.
 */
[data-dshfl='chip'] {
  position: fixed;
  right: 14px;
  top: 12px;
  z-index: 80;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  padding: 5px 10px 5px 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 140, 160, .28));
  background: var(--dsw-alias-bg-elevated, rgba(24, 27, 33, .92));
  color: var(--dsw-alias-label-secondary, #98a0ad);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  opacity: .55;
  transition: opacity .15s ease;
  backdrop-filter: blur(6px);
}
[data-dshfl='chip']:hover { opacity: 1; }
/* The in-header variant: same capsule, in the header row's own flow. */
[data-dshfl='chipHeader'] {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 240px;
  height: 32px;
  padding: 0 10px 0 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 140, 160, .28));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #98a0ad);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  margin-left: 4px;
}
[data-dshfl='chipHeader']:hover { color: var(--dsw-alias-label-primary, #eef0f4); }
[data-dshfl='chipHeader'] .dshfl-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dshfl='chipHeader'] button {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0 2px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
[data-dshfl='chipHeader'] button:hover { color: var(--dsw-alias-brand-primary, #6f9dff); }
[data-dshfl='chipHeader'] button[disabled] { cursor: default; opacity: .6; text-decoration: none; }
[data-dshfl='chipHeader'] .dshfl-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: 0 0 auto;
  object-fit: cover;
}
[data-dshfl='chipHeader'] .dshfl-initial {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-brand-primary, #6f9dff);
  color: #0b1220;
  font-size: 11px;
  font-weight: 650;
}

[data-dshfl='chip'] .dshfl-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: 0 0 auto;
  object-fit: cover;
  background: var(--dsw-alias-bg-base, #0e1013);
}
[data-dshfl='chip'] .dshfl-initial {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-brand-primary, #6f9dff);
  color: #0b1220;
  font-size: 11px;
  font-weight: 650;
}
[data-dshfl='chip'] .dshfl-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dshfl='chip'] button {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0 2px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
[data-dshfl='chip'] button:hover { color: var(--dsw-alias-brand-primary, #6f9dff); }
[data-dshfl='chip'] button[disabled] { cursor: default; opacity: .6; text-decoration: none; }
`
