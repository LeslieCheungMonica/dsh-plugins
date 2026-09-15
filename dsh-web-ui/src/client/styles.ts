/**
 * This plugin's stylesheets, as one string injected by apply.
 *
 * Two layers, deliberately separated:
 *
 * 1. `GLOBAL SKIN` — page-wide changes. It stays token-level on purpose: the
 *    semantic `--dsw-alias-*` / `--dsw-specific-*` contract is the only
 *    sanctioned way to move a surface this plugin does not own (the shipped
 *    conversation and workspace surfaces keep their own CSS). The `html body`
 *    selectors are load-bearing: ui-theme declares the same properties on
 *    `body` / `body[data-ds-dark-theme]`, and an extra type selector wins the
 *    cascade regardless of which stylesheet landed last.
 *
 * 2. `SHELL` — this plugin's own column, marked with `data-wui` attributes and
 *    `wui-` class names. Everything here is owned by this plugin, so it may use
 *    geometry and its own local custom properties (`--dsh-web-ui-*`).
 *
 * Adding a component library or Tailwind is out of scope by project rule; the
 * local token names are prefixed so they cannot collide with ui-theme's.
 */

/** `data-plugin-css` id of this plugin's injected style tag. */
export const STYLE_TAG_ID = 'dsh-web-ui/skin'

const GLOBAL_SKIN = `
/* Sidebar surface: this plugin owns the column, and a tinted, slightly
   deeper surface is what separates the new shell from the shipped one. */
html body {
  --dsw-specific-sidebar-fill: #f4f6fb;
}
html body[data-ds-dark-theme] {
  --dsw-specific-sidebar-fill: #12141b;
}

/* The accent this plugin paints its own controls with. DeepSeek blue in both
   themes, so the primary action reads the same either way. */
html body {
  --dsh-web-ui-accent: rgb(65, 118, 230);
  --dsh-web-ui-accent-hover: rgb(48, 100, 214);
  --dsh-web-ui-accent-label: #ffffff;
  --dsh-web-ui-accent-soft: rgba(65, 118, 230, 0.12);
}
html body[data-ds-dark-theme] {
  --dsh-web-ui-accent: rgb(90, 140, 246);
  --dsh-web-ui-accent-hover: rgb(65, 118, 230);
  --dsh-web-ui-accent-label: #0b0d12;
  --dsh-web-ui-accent-soft: rgba(90, 140, 246, 0.18);
}
`

const SHELL = `
[data-wui='column'] {
  --dsh-web-ui-gap: 8px;
  --dsh-web-ui-radius: 10px;
  /* Nested scroll regions follow the pointer: the column draws its bars only
     while the pointer is over it (ui-theme rebinds through these two names). */
  --dsh-scrollbar-thumb: transparent;
  --dsh-scrollbar-thumb-hover: transparent;

  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 6px 12px;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  overflow: hidden;
}

[data-wui='column']:hover {
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

[data-wui='column'][data-rail='true'] {
  padding: 18px 10px 6px;
}

/* Collapse phase 1: the frozen-width content fades out in place while the
   frame slides the track, so nothing reflows mid-slide. */
[data-wui='column'][data-fading='true'] > * {
  opacity: 0;
  transition: opacity 150ms var(--ds-ease-in-out);
}

/* Wide-only content fades back in on expand remount. */
[data-wui='column']:not([data-rail='true']) [data-wui-wide='true'] {
  animation: wui-wide-in 200ms var(--ds-ease-in-out);
}

@keyframes wui-wide-in {
  from { opacity: 0; }
}

/* At the rail settle the controls enter from the former rail edge, matching
   the shipped shell's entry so the two shells are interchangeable. */
[data-wui='column'][data-rail-in='true'] [data-wui-rail-in='true'] {
  animation: wui-rail-in 150ms var(--ds-ease-in-out) backwards;
}

@keyframes wui-rail-in {
  from {
    opacity: 0;
    transform: translateX(49px);
  }
}

/* ── header: brand + collapse ─────────────────────────────────────────── */

[data-wui='header'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  margin-bottom: var(--dsh-web-ui-gap);
  overflow: hidden;
}

[data-wui='column'][data-rail='true'] [data-wui='header'] {
  height: 36px;
  margin-bottom: 12px;
  justify-content: flex-start;
}

[data-wui='brand'] {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
}

[data-wui='brandMark'] {
  display: inline-flex;
  flex: none;
  align-items: center;
}

/* The mark ARTWORK, wherever this plugin's mark is rendered — including the
   conversation hero, whose host class this plugin does not own. That class
   carries a hover "swim" animation drawn for the shipped fish; an emblem that
   walks into the page's brand row must hold still, so the motion is cancelled
   while the host's ink (its color) is left alone. */
[data-wui='brandMarkArt'] {
  animation: none !important;
}

[data-wui='brandName'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

[data-wui='brandRevision'] {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
}

/* ── shared icon control ─────────────────────────────────────────────── */

[data-wui='iconButton'] {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background-color 120ms var(--ds-ease-in-out), color 120ms var(--ds-ease-in-out);
}

[data-wui='iconButton']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

[data-wui='iconButton']:disabled {
  opacity: 0.5;
  cursor: default;
}

[data-wui='iconButton']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

[data-wui='column'][data-rail='true'] [data-wui='iconButton'] {
  width: 36px;
  height: 36px;
}

/* The New Project control carries the accent — it is the one action that
   changes what this column is about. */
[data-wui-accent='true'] {
  color: var(--dsh-web-ui-accent);
}

[data-wui-accent='true']:hover:not(:disabled) {
  background: var(--dsh-web-ui-accent-soft);
  color: var(--dsh-web-ui-accent);
}

/* ── project row ─────────────────────────────────────────────────────── */

[data-wui='projectRow'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  margin-bottom: var(--dsh-web-ui-gap);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsh-web-ui-radius);
  background: var(--dsw-alias-bg-layer-1);
}

[data-wui='column'][data-rail='true'] [data-wui='projectRow'] {
  /* The rail stacks its controls (36px boxes, 12px rhythm) instead of laying
     them out in a row: a row would push the New Project button past the 56px
     track and clip it. */
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 0;
  margin-bottom: 12px;
  border-color: transparent;
  background: transparent;
}

[data-wui='projectTrigger'] {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms var(--ds-ease-in-out);
}

[data-wui='projectTrigger']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='projectTrigger']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

[data-wui='projectIcon'] {
  flex: none;
  display: inline-flex;
  color: var(--dsh-web-ui-accent);
}

[data-wui='projectTitle'] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}

[data-wui='projectTitle'][data-empty='true'] {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
}

[data-wui='projectChevron'] {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='column'][data-rail='true'] [data-wui='projectTrigger'] {
  width: 36px;
  height: 36px;
  justify-content: center;
  padding: 0;
}

/* ── new session ─────────────────────────────────────────────────────── */

[data-wui='newSession'] {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  padding: 8px 16px;
  margin: 0 2px var(--dsh-web-ui-gap);
  box-sizing: border-box;
  border: none;
  border-radius: var(--dsh-web-ui-radius);
  background: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent-label);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  transition: background-color 120ms var(--ds-ease-in-out);
}

[data-wui='newSession']:hover:not(:disabled) {
  background: var(--dsh-web-ui-accent-hover);
}

[data-wui='newSession']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

[data-wui='newSession']:disabled {
  opacity: 0.6;
  cursor: default;
}

[data-wui='column'][data-rail='true'] [data-wui='newSession'] {
  align-self: flex-start;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0 0 12px;
  background: transparent;
  color: var(--dsh-web-ui-accent);
}

[data-wui='column'][data-rail='true'] [data-wui='newSession']:hover:not(:disabled) {
  background: var(--dsh-web-ui-accent-soft);
}

[data-wui='newSessionLabel'] {
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ── error strip ─────────────────────────────────────────────────────── */

[data-wui='error'] {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: var(--dsh-web-ui-gap);
  padding: 8px 8px 8px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

[data-wui='errorText'] {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

/* ── region + foot seats ─────────────────────────────────────────────── */

[data-wui='region'] {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-left: -4px;
  margin-right: -12px;
  padding-left: 4px;
  overflow: hidden;
}

/* The region's two halves. Each one is a flex column of its own so its occupant
   keeps its internal scroll, and the split is the sibling grow factors the
   column writes as inline styles (a percentage height would need a definite
   parent height the flex chain does not promise). */
[data-wui='regionTop'],
[data-wui='regionBottom'] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 0;
}

[data-wui='regionBottom'] {
  border-top: 1px solid var(--dsw-alias-border-l1);
}

/* The drag handle between them: a hairline with a grab area wide enough to hit,
   painted on hover and while dragging. */
[data-wui='splitter'] {
  flex: none;
  height: 9px;
  margin: 2px 0;
  border-radius: 4px;
  cursor: row-resize;
  touch-action: none;
  background: transparent;
  transition: background 120ms ease;
}

[data-wui='splitter']:hover,
[data-wui='splitter'][data-dragging='true'] {
  background: var(--dsh-web-ui-accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  [data-wui='splitter'] { transition: none; }
}

[data-wui='column'][data-rail='true'] [data-wui='region'] {
  margin-left: 0;
  margin-right: 0;
  padding-left: 0;
}

[data-wui='foot'] {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  margin-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='column'][data-rail='true'] [data-wui='foot'] {
  border-top-color: transparent;
}

/* ── project-scoped session list ─────────────────────────────────────── */

[data-wui='sessionList'] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

[data-wui='sessionHeader'] {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px 6px 4px;
}

[data-wui='sessionHeaderTitle'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='sessionHeaderCount'] {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='sessionSearch'] {
  flex: none;
  padding: 0 4px 6px 0;
}

[data-wui='sessionScroll'] {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}

[data-wui='sessionRow'] {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 8px;
  margin-bottom: 1px;
}

[data-wui='sessionRow']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='sessionRow'][data-current='true'] {
  background: var(--dsh-web-ui-accent-soft);
}

[data-wui='sessionRow'][data-current='true']::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--dsh-web-ui-accent);
}

[data-wui='sessionRow'][data-archived='true'] {
  opacity: 0.55;
}

[data-wui='sessionOpen'] {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 4px 7px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

[data-wui='sessionOpen']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: -2px;
}

[data-wui='sessionDot'] {
  flex: none;
  display: inline-flex;
}

[data-wui='sessionTitle'] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='sessionRow'][data-current='true'] [data-wui='sessionTitle'] {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

[data-wui='sessionSubagents'] {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 16px;
}

[data-wui='sessionTime'] {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

/* Row actions stay out of the way: revealed on hover, and always reachable by
   keyboard (focus-within), never only by pointer. */
[data-wui='sessionMenuButton'] {
  flex: none;
  width: 22px;
  height: 22px;
  margin-right: 4px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms var(--ds-ease-in-out), background-color 120ms var(--ds-ease-in-out);
}

[data-wui='sessionRow']:hover [data-wui='sessionMenuButton'],
[data-wui='sessionRow']:focus-within [data-wui='sessionMenuButton'] {
  opacity: 1;
}

[data-wui='sessionMenuButton']:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
}

[data-wui='sessionMenuButton']:focus-visible {
  opacity: 1;
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

[data-wui='sessionEmpty'] {
  padding: 18px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

[data-wui='sessionEmpty'] p {
  margin: 0;
}

[data-wui='sessionEmptyAction'] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: var(--dsh-web-ui-accent-soft);
  color: var(--dsh-web-ui-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

[data-wui='sessionArchivedLabel'] {
  padding: 10px 6px 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='sessionArchivedToggle'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 5px 8px 5px 4px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

[data-wui='sessionArchivedToggle']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* The chevron is the toggle's own state indicator (the control is a button, so
   the flip is driven by the ARIA state rather than a class). */
[data-wui='sessionArchivedToggle'][aria-expanded='true'] svg {
  transform: rotate(180deg);
}

[data-wui='sessionRail'] {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

[data-wui='railBadge'] {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent-label);
  font-size: 9px;
  line-height: 14px;
  text-align: center;
}

/* ── project menu cells ──────────────────────────────────────────────── */

[data-wui='menuCell'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

[data-wui='menuTitle'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='menuPath'] {
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

/* ── folder browser (the picker fallback) ────────────────────────────── */

[data-wui='browseCrumbs'] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='browsePath'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

[data-wui='browseList'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow: auto;
  padding: 2px;
}

[data-wui='browseRow'] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

[data-wui='browseRow']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='browseEmpty'] {
  padding: 12px 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

[data-wui='newFolderRow'] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

/* Fallback brand-row placement (only used when the shipped sidebar shell is
   still mounted): keep the controls compact and neutralize the host button's
   own click, which starts a session. */
[data-wui='brandRowFallback'] {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

/* ── Feishu document panel (the region's lower half) ─────────────────── */

[data-wui='larkPanel'] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

[data-wui='larkHeader'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 6px 4px;
}

[data-wui='larkTitle'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='larkCount'] {
  flex: 1;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='larkHeader'] [data-wui='iconButton'] {
  flex: none;
  width: 22px;
  height: 22px;
}

[data-wui='larkHeader'] [data-wui='iconButton'][aria-busy='true'] {
  animation: wui-lark-spin 1.1s linear infinite;
}

@keyframes wui-lark-spin {
  to { transform: rotate(360deg); }
}

/* Identity strip: who is signed in, and which knowledge base is open. */
[data-wui='larkIdentity'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 2px 6px 4px;
}

[data-wui='larkAvatar'] {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--dsh-web-ui-accent-soft);
}

[data-wui='larkAvatar'][data-fallback='true'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--dsh-web-ui-accent);
}

[data-wui='larkUserName'] {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='larkSpaceTrigger'] {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  padding: 2px 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

[data-wui='larkSpaceTrigger']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

[data-wui='larkSpaceName'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='larkScroll'] {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}

[data-wui='larkRow'] {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 7px;
  margin-bottom: 1px;
  /* Depth indentation is written inline by the row (one level is 11px); this
     is only the base, so a row without a depth still lines up. */
  padding-left: 4px;
}

[data-wui='larkRow']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='larkRowMain'] {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 2px 5px 2px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

[data-wui='larkChevron'] {
  flex: none;
  width: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-dimmed);
}

/* The type chip: what the node IS. DOC/SHT/FILE are language-neutral on
   purpose — one table then serves both dictionaries. */
[data-wui='larkBadge'] {
  flex: none;
  min-width: 26px;
  padding: 1px 3px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  /* A translucent neutral reads correctly in both themes, so a 9px chip needs
     no theme-specific surface token of its own. */
  background: rgba(127, 127, 127, 0.12);
  border: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='larkBadge'][data-type='docx'] { color: #2f6bd8; border-color: rgba(47, 107, 216, 0.35); }
[data-wui='larkBadge'][data-type='sheet'] { color: #1f8a4c; border-color: rgba(31, 138, 76, 0.35); }
[data-wui='larkBadge'][data-type='bitable'] { color: #7a4bd0; border-color: rgba(122, 75, 208, 0.35); }
[data-wui='larkBadge'][data-type='slides'] { color: #c4711a; border-color: rgba(196, 113, 26, 0.35); }
[data-wui='larkBadge'][data-type='mindnote'] { color: #1c8f8a; border-color: rgba(28, 143, 138, 0.35); }

[data-wui='larkNodeTitle'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
}

[data-wui='larkRow'][data-dir='true'] [data-wui='larkNodeTitle'] {
  color: var(--dsw-alias-label-secondary);
}

[data-wui='larkOpenButton'] {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 2px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-dimmed);
  cursor: pointer;
  opacity: 0;
}

[data-wui='larkRow']:hover [data-wui='larkOpenButton'],
[data-wui='larkOpenButton']:focus-visible {
  opacity: 1;
}

[data-wui='larkOpenButton']:hover {
  color: var(--dsh-web-ui-accent);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* Inline notes: loading, load-more, and a per-level failure all speak here. */
[data-wui='larkNote'] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='larkNote'][data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='larkNoteAction'] {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

[data-wui='larkNoteAction']:hover {
  border-color: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent);
}

[data-wui='larkError'] {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 4px 4px 0 2px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: rgba(127, 127, 127, 0.07);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='larkErrorText'] {
  word-break: break-word;
}

[data-wui='larkErrorHint'] {
  color: var(--dsw-alias-label-dimmed);
}

`

/** The complete stylesheet this plugin injects into `document.head`. */
export const STYLES = `${GLOBAL_SKIN}${SHELL}`
