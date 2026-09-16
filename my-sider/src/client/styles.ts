/**
 * This plugin's stylesheet, as one string injected by `apply`.
 *
 * Everything here belongs to this plugin: the two panels and the launcher bar
 * are this plugin's own surfaces, marked with `data-ms` attributes and
 * `--dsh-my-sider-*` local properties. Nothing is re-styled that this plugin
 * does not own — the frame, the conversation, and the shipped sidebar keep their
 * own CSS, and this file only consumes ui-theme's semantic tokens
 * (`--dsw-alias-*`) to sit inside that design instead of beside it.
 *
 * Two structural facts worth stating:
 *
 * - The panels are rendered through a portal onto `document.body`, so they are
 *   `position: fixed` against the viewport and cannot be trapped inside a
 *   column's transform or scroll container.
 * - The launcher bar lives inside the frame's `shell.overlay` layer, which is
 *   click-through by design; a floating group in it must claim its own hits.
 *
 * @module my-sider/client/styles
 */

/** `data-plugin-css` id of this plugin's injected style tag. */
export const STYLE_TAG_ID = 'my-sider/panels'

export const STYLES = `
[data-ms] {
  --dms-radius: 10px;
  --dms-gap: 8px;
  --dms-accent: rgb(65, 118, 230);
  --dms-accent-label: #ffffff;
  box-sizing: border-box;
}

body[data-ds-dark-theme] [data-ms],
[data-ms] {
  --dms-accent-label: #ffffff;
}

body[data-ds-dark-theme] [data-ms] {
  --dms-accent: rgb(90, 140, 246);
}

/* ── launcher bar (inside the frame's overlay layer) ──────────────────── */

[data-ms='bar'] {
  position: fixed;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 6px;
  /* The overlay layer as a whole is click-through, so a floating group must
     claim its own hits. */
  pointer-events: auto;
  transition: right 180ms ease-out;
}

/* In the shared strip this plugin owns no geometry at all: the row that hosts it
   decides where the group sits, and every offset above is the PINNED bar's. What
   is left is the flex row of two buttons, which is what the strip lays out. The
   sidebar-reserve trick changes shape here too — instead of moving itself, the
   launcher writes the strip's own shift property so the whole row steps aside
   (see Launcher.tsx and BAR_SHIFT_PROPERTY). */
[data-ms='bar'][data-inline='true'] {
  position: static;
  z-index: auto;
  transition: none;
}

[data-ms='barButton'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

[data-ms='barButton']:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

[data-ms='barButton'][data-active='true'] {
  border-color: var(--dms-accent);
  background: var(--dms-accent);
  color: var(--dms-accent-label);
}

[data-ms='barButtonLabel'] {
  white-space: nowrap;
}

/* ── shared panel chrome ─────────────────────────────────────────────── */

[data-ms='head'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

[data-ms='title'] {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}

[data-ms='spacer'] {
  flex: 1;
  min-width: 4px;
}

[data-ms='iconButton'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

[data-ms='iconButton']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

[data-ms='iconButton']:disabled {
  opacity: 0.4;
  cursor: default;
}

[data-ms='chip'] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  white-space: nowrap;
  max-width: 22em;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-ms='chip'][data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
[data-ms='chip'][data-tone='failed'] { color: var(--dsw-alias-state-error-primary); }
[data-ms='chip'][data-tone='running'] { color: var(--dsw-alias-label-primary-bluish); }
[data-ms='chip'][data-tone='warn'] { color: var(--dsw-alias-state-warn-label); }

[data-ms='notice'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
}

[data-ms='notice'][data-tone='error'] {
  background: var(--dsw-alias-state-error-secondary);
}

[data-ms='notice'] button {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  cursor: pointer;
}

/* ── the web sidebar ─────────────────────────────────────────────────── */

[data-ms='webPanel'] {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  min-width: 280px;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: -10px 0 28px rgba(0, 0, 0, 0.14);
  animation: dms-web-in 160ms ease-out;
}

@keyframes dms-web-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* The grab strip: a hairline with a hit area wide enough to actually catch. */
[data-ms='webResize'] {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 7px;
  cursor: ew-resize;
}

[data-ms='webResize']:hover {
  background: var(--dsw-alias-interactive-bg-hover-accent);
}

[data-ms='webTabs'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

[data-ms='webTab'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  max-width: 190px;
  height: 26px;
  padding: 0 4px 0 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-bottom-color: transparent;
  border-radius: 7px 7px 0 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  cursor: pointer;
}

[data-ms='webTab'][data-active='true'] {
  border-color: var(--dsw-alias-border-l2);
  border-bottom-color: transparent;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

[data-ms='webTabTitle'] {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-ms='webTabClose'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

[data-ms='webTabClose']:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

[data-ms='webToolbar'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-ms='webAddress'] {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

[data-ms='webAddress']:focus {
  outline: none;
  border-color: var(--dms-accent);
}

[data-ms='modeButton'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

[data-ms='modeButton'][data-mode='relay'] {
  border-color: var(--dms-accent);
  color: var(--dsw-alias-label-primary-bluish);
}

[data-ms='webBody'] {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
}

[data-ms='webFrame'] {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #ffffff;
}

[data-ms='webEmpty'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.7;
}

/* ── the bottom command panel ────────────────────────────────────────── */

[data-ms='shellPanel'] {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 55;
  display: flex;
  flex-direction: column;
  min-height: 120px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 -8px 28px rgba(0, 0, 0, 0.14);
  animation: dms-shell-in 160ms ease-out;
}

@keyframes dms-shell-in {
  from { transform: translateY(18px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

[data-ms='shellResize'] {
  flex: none;
  height: 6px;
  margin-top: -3px;
  cursor: ns-resize;
}

[data-ms='shellResize']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-ms='shellDir'] {
  flex: none;
  width: 22em;
  max-width: 40vw;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

[data-ms='shellRuns'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  overflow-x: auto;
  scrollbar-width: thin;
}

[data-ms='shellRun'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  max-width: 240px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  cursor: pointer;
}

[data-ms='shellRun'][data-active='true'] {
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

[data-ms='shellRunText'] {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-ms='shellRunDot'] {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}

[data-ms='shellRunDot'][data-tone='ok'] { background: var(--dsw-alias-state-success-primary); }
[data-ms='shellRunDot'][data-tone='failed'] { background: var(--dsw-alias-state-error-primary); }
[data-ms='shellRunDot'][data-tone='running'] { background: var(--dsw-alias-label-primary-bluish); }

[data-ms='shellPane'] {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 8px 10px;
  overflow: auto;
  background: var(--dsw-alias-markdown-code-block);
}

[data-ms='shellOut'] {
  margin: 0;
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-primary);
}

[data-ms='shellNote'] {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

[data-ms='shellError'] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

[data-ms='shellJump'] {
  position: absolute;
  right: 16px;
  bottom: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
}

[data-ms='shellInputRow'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

[data-ms='shellPrompt'] {
  flex: none;
  color: var(--dsw-alias-label-primary-bluish);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

[data-ms='shellInput'] {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

[data-ms='shellInput']:focus {
  outline: none;
  border-color: var(--dms-accent);
}

[data-ms='shellRunButton'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dms-accent);
  border-radius: 7px;
  background: var(--dms-accent);
  color: var(--dms-accent-label);
  font-size: 12px;
  cursor: pointer;
}

[data-ms='shellRunButton']:disabled {
  opacity: 0.45;
  cursor: default;
}

[data-ms='panelButton'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
}

[data-ms='panelButton']:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

[data-ms='panelButton']:disabled {
  opacity: 0.4;
  cursor: default;
}

[data-ms='panelButton'][data-tone='danger'] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
`
