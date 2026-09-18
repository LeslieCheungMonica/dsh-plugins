/**
 * This plugin's stylesheet, as one string injected by `apply`.
 *
 * Nearly everything here belongs to this plugin: the two panels and the launcher
 * bar are this plugin's own surfaces, marked with `data-ms` attributes and
 * `--dsh-my-sider-*` local properties. The frame, the conversation, and the
 * shipped sidebar keep their own CSS, and this file only consumes ui-theme's
 * semantic tokens (`--dsw-alias-*`) to sit inside that design instead of beside
 * it.
 *
 * THREE structural facts worth stating:
 *
 * - The panels are rendered through a portal onto `document.body`, so they are
 *   `position: fixed` against the viewport and cannot be trapped inside a
 *   column's transform or scroll container.
 * - The launcher bar lives inside the frame's `shell.overlay` layer, which is
 *   click-through by design; a floating group in it must claim its own hits.
 * - The command panel SPLITS the page rather than covering it, and that is the one
 *   exception to "only this plugin's own surfaces": the reserve is spent as
 *   padding on the app's MOUNT NODE (`#root`), which is the element the frame's
 *   percentage height descends from. A portal cannot be a grid track of the frame,
 *   and no layout seam exists for a bottom inset, so the space has to be taken
 *   from the app's own root. It is exactly one rule, it is inert unless the panel
 *   is open (the launcher writes `--ms-shell-h` on `<html>` only then), and it is
 *   marked below.
 *
 * @module my-sider/client/styles
 */

/** `data-plugin-css` id of this plugin's injected style tag. */
export const STYLE_TAG_ID = 'my-sider/panels'

export const STYLES = `
/* ── the split (the one host element this file sizes) ─────────────────────── */

/* See the module note: the open command panel's height is taken OUT of the page
   instead of floating over it. The mount node gives up exactly that much room at
   the bottom, and since the frame inside is \`height: 100%\`, the conversation is
   re-laid out above the panel rather than hidden behind it. Border-box is what
   makes the padding come out of the 100% height instead of being added to it. */
html body > #root {
  box-sizing: border-box;
  padding-bottom: var(--ms-shell-h, 0px);
  transition: padding-bottom 160ms var(--ds-ease-in-out, ease-out);
}

/* A drag writes the reserve at pointer cadence; easing that would detach the page
   from the handle, so the gesture suspends it (the frame's own columns do the
   same with data-dragging). */
html[data-ms-dragging] body > #root {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  html body > #root {
    transition: none;
  }
}

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

/* One command and its answer. Spacing, not borders: a scrollback has no boxes in
   it, and every box would spend a line of a panel that may only be 120px tall. */
[data-ms='shellEntry'] + [data-ms='shellEntry'] {
  margin-top: 10px;
}

/* An empty prompt line: the line the operator ended with nothing on it, reprinted
   where they ended it. Spaced like an entry so pressing Enter visibly moves the prompt
   down instead of looking like a panel that never heard the key. */
[data-ms='shellBlank'] {
  margin-top: 10px;
  color: var(--dsw-alias-label-primary);
}

/* The echo line is plain text, not two flex items: the space between the mark and
   the command is part of the line ('$ cmd'), because that is what a shell prints and
   what a copy of the line should give back. */
[data-ms='shellEcho'] {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-primary);
}

[data-ms='shellEchoMark'] {
  color: var(--dsw-alias-label-primary-bluish);
}

[data-ms='shellPane'] {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 8px 10px 10px;
  overflow: auto;
  background: var(--dsw-alias-markdown-code-block);
  /* The transcript is one monospace column, and the caret's line is its last line:
     the pane is text, not a list of cards. */
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary);
}

[data-ms='shellOut'] {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}

/* What a shell tells you between commands — how the last one ended, and how long it
   took. Muted, because it is the frame around the output rather than output. */
[data-ms='shellStatus'] {
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

[data-ms='shellStatus'][data-tone='failed'] { color: var(--dsw-alias-state-error-primary); }

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

/* The prompt line: the transcript's last line, and the panel's only input. */
[data-ms='shellPromptLine'] {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 10px;
}

[data-ms='shellPrompt'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  /* The prompt is the panel's own label for the input that follows it, so it must
     never win a width contest with the command line: it yields first. */
  max-width: 40%;
  color: var(--dsw-alias-label-primary-bluish);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

/* The directory half. The identifying part of a path is its TAIL, so the panel
   keeps the last two segments itself ('…/dsh-plugins/my-sider'); what is left for
   CSS is one absurdly long segment name overflowing the 40% cap, and that is
   clipped at the end. (The usual 'direction: rtl' trick would move the ellipsis to
   the left, and would also reorder a path containing an RTL directory name — not
   worth it for a label that is already shortened.) */
[data-ms='shellPromptDir'] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}

[data-ms='shellPromptMark'] {
  flex: none;
  color: var(--dsw-alias-label-primary-bluish);
}

/* A terminal has no input box: the caret sits in the scrollback on the prompt's own
   baseline, and the row it is on IS the field. So: no border, no background, the
   pane's own font, and no focus ring — the caret is the affordance. */
[data-ms='shellInput'] {
  flex: 1;
  min-width: 0;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  caret-color: var(--dsw-alias-label-primary);
}

[data-ms='shellInput']:focus {
  outline: none;
}

[data-ms='shellInput']::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

/* Disabled means one thing here — a command is running and this panel cannot queue
   another — and the placeholder says so, so the field must not fade into looking
   broken. */
[data-ms='shellInput']:disabled {
  opacity: 1;
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
