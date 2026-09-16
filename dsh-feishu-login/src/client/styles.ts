/**
 * The browser half's stylesheet.
 *
 * The gate lives in the frame's `shell.overlay` layer, which is
 * `pointer-events: none` with `pointer-events: auto` on its direct children —
 * so the gate is one fixed, opaque child that swallows every click.
 *
 * The account controls are NOT overlay children: they render into the sidebar
 * column's own seats (`sidebar.account` / `sidebar.account.menu`, declared by
 * `dsh-web-ui`), so this sheet styles their content and leaves their geometry to
 * the column that owns it. The one exception is the header capsule below, which
 * exists only as a fallback for a deployment with no such column.
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
 * The account controls have two homes, and only one of them is a corner.
 *
 * The PRIMARY home is the sidebar column's bottom-left account dock: the
 * identity is [data-dshfl='account'] (the content of a row dsh-web-ui owns —
 * this sheet deliberately styles the CONTENT only, never the row's geometry) and
 * the sign-out action is a [data-wui='drawerRow'] inside that dock's drawer, so
 * it wears the column's own row styling and only its disabled colour lives here.
 *
 * The FALLBACK home is the session header's utilities row
 * ([data-dshfl='chipHeader']), registered only while the account seats have not
 * appeared — a deployment that installs this plugin without dsh-web-ui.
 *
 * The old fixed, top-right corner capsule ([data-dshfl='chip']) is GONE with
 * its component: the account is not in that corner any more, and a stylesheet
 * rule for a surface nothing renders is a lie about what this plugin draws.
 */
[data-dshfl='account'] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
}
[data-dshfl='account'] .dshfl-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dshfl='account'] .dshfl-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex: 0 0 auto;
  object-fit: cover;
  background: var(--dsw-alias-bg-base, #0e1013);
}
[data-dshfl='account'] .dshfl-initial {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-brand-primary, #6f9dff);
  color: #0b1220;
  font-size: 12px;
  font-weight: 650;
}
/* Before the first probe answers. It must not read as a real identity: it is a
   word, not a name, and a visitor who is not signed in gets bounced by the gate
   rather than seeing a placeholder that looks like somebody. */
[data-dshfl='accountPending'] {
  color: var(--dsw-alias-label-tertiary, #7d8695);
  font-size: 13px;
}

/* The sign-out row, inside the column's drawer. Geometry, hover and icon slot
   are dsh-web-ui's [data-wui='drawerRow'] rules; this adds the one state that
   only this row has. */
[data-dshfl='signOut'][disabled] {
  cursor: default;
  opacity: .6;
}
[data-dshfl='signOut'][disabled]:hover {
  background: transparent;
}

/* The fallback capsule: the session header's utilities row. */
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
`
