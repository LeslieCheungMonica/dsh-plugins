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

/* The FDE flow's own green (see stage.ts). It is declared HERE, on the page
   root, and not on the column like the other --dsh-web-ui-* values: the flow
   panel is portaled to the page body (the column clips its own overflow, so
   the panel cannot live inside it), and a custom property set on the column
   would not reach it. The halo is a pair — on and off — because a keyframe
   cannot interpolate to transparent: green's own transparent is used instead,
   which is what keeps the pulse from fading through grey. */
html body {
  --dsh-web-ui-stage-on-solid: #ffffff;
  --dsh-web-ui-stage-halo: rgba(34, 197, 94, 0.3);
  --dsh-web-ui-stage-halo-off: rgba(34, 197, 94, 0);
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

/* ── FDE stage tag ────────────────────────────────────────────────────────
   The current stage of the selected project, between the project row and the
   New Session button. It is a STATUS row rather than a second primary action:
   it keeps the column's quiet surface (the accent fill below belongs to New
   Session alone) and states where the project is twice — as a ring, and as
   words. The flow panel it opens is portaled out of the column, so its rules
   below use theme tokens only. */

[data-wui='stageTag'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  margin: 0 2px var(--dsh-web-ui-gap);
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsh-web-ui-radius);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  cursor: pointer;
  overflow: hidden;
  transition: background-color 120ms var(--ds-ease-in-out);
}

[data-wui='stageTag']:hover,
[data-wui='stageTag'][data-open='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='stageTag']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

/* The ring: the reached share of the flow is a green arc, the rest is the
   hairline colour. Masked rather than layered, so it is a true ring over
   whatever surface the tag sits on (the column's fill, or the hover fill).
   The fill fractions are per-step rules below — an attribute, not an inline
   custom property, so the value is inspectable in the DOM like every other
   state this plugin renders. One sixth is the FIRST stage, not zero: sitting on
   stage one is one step of six, done. */
[data-wui='stageRing'] {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: conic-gradient(
    var(--dsw-alias-state-success-primary) var(--wui-stage-fill, 16.667%),
    var(--dsw-alias-border-l2) 0
  );
  -webkit-mask: radial-gradient(circle closest-side, transparent 72%, #000 76%);
  mask: radial-gradient(circle closest-side, transparent 72%, #000 76%);
}

[data-wui='stageTag'][data-step='0'] [data-wui='stageRing'] { --wui-stage-fill: 16.667%; }
[data-wui='stageTag'][data-step='1'] [data-wui='stageRing'] { --wui-stage-fill: 33.333%; }
[data-wui='stageTag'][data-step='2'] [data-wui='stageRing'] { --wui-stage-fill: 50%; }
[data-wui='stageTag'][data-step='3'] [data-wui='stageRing'] { --wui-stage-fill: 66.667%; }
[data-wui='stageTag'][data-step='4'] [data-wui='stageRing'] { --wui-stage-fill: 83.333%; }
[data-wui='stageTag'][data-step='5'] [data-wui='stageRing'] { --wui-stage-fill: 100%; }

[data-wui='stageTagLabel'] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
}

[data-wui='stageTagCount'] {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

[data-wui='stageTagChevron'] {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 150ms var(--ds-ease-in-out);
}

[data-wui='stageTag'][data-open='true'] [data-wui='stageTagChevron'] {
  transform: rotate(180deg);
}

/* In the rail there is no room for words: the tag becomes the ring alone, on
   the same 36px grid as the project trigger and New Session beneath it. */
[data-wui='column'][data-rail='true'] [data-wui='stageTag'] {
  align-self: flex-start;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0 0 12px;
  justify-content: center;
  border-color: transparent;
}

[data-wui='column'][data-rail='true'] [data-wui='stageTag'] [data-wui='stageRing'] {
  width: 18px;
  height: 18px;
}

/* ── FDE flow panel (portaled to the page body) ───────────────────────────
   The flow, top to bottom in delivery order. The rail that ties the nodes
   together is drawn by each row's own pseudo-elements, split around the node so
   the line never runs UNDER a marker — that is what lets an unreached node stay
   a hollow circle with the panel's surface showing through it. Adjacent rows
   are flush, so the segments of two neighbours meet and read as one line. */

[data-wui='stagePanel'] {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: 268px;
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-shadow-lv3);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  /* Elevated surface: it takes the l2 elevation scrollbar tokens, like the
     shared Menu's own card. */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  animation: wui-stage-in 140ms var(--ds-ease-in-out);
}

/* The panel opens downward from the tag, so it arrives from just above. */
@keyframes wui-stage-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

[data-wui='stagePanelHead'] {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 2px;
}

[data-wui='stagePanelTitle'] {
  font-weight: 600;
}

[data-wui='stagePanelCount'] {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

[data-wui='stagePanelScope'] {
  padding: 0 6px 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='stageList'] {
  /* --wui-stage-rail is where the connector line sits: the marker cell is
     42px wide and holds a centred 18px node, so the node's centre — and the
     line's, one pixel either side of it — is 21px in. */
  --wui-stage-rail: 20px;

  margin: 0;
  padding: 4px 0 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
  list-style: none;
}

[data-wui='stageRow'] {
  position: relative;
  border-radius: 8px;
  transition: background-color 120ms var(--ds-ease-in-out);
}

[data-wui='stageRow']:not([data-state='current']):hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='stageRow']::before,
[data-wui='stageRow']::after {
  content: '';
  position: absolute;
  left: var(--wui-stage-rail);
  width: 2px;
  background: var(--dsw-alias-border-l2);
  pointer-events: none;
}

/* Split around the node: from the row's top edge to 11px above its centre, and
   from 11px below the centre to its bottom edge. 11 = the node's half (9) plus
   the 2px of breathing room that keeps the line clear of a hollow marker. */
[data-wui='stageRow']::before {
  top: 0;
  height: calc(50% - 11px);
}

[data-wui='stageRow']::after {
  top: calc(50% + 11px);
  bottom: 0;
}

/* No line above the first node or below the last one: the flow starts and ends
   at a node, it does not run off the card. */
[data-wui='stageRow']:first-child::before,
[data-wui='stageRow']:last-child::after {
  display: none;
}

/* The line behind the current node is green because the node above it is done;
   the line below it is not, because the next node has not started. That one
   asymmetry is the whole reason the states are read from the row. */
[data-wui='stageRow'][data-state='done']::before,
[data-wui='stageRow'][data-state='done']::after,
[data-wui='stageRow'][data-state='current']::before {
  background: var(--dsw-alias-state-success-primary);
}

[data-wui='stageRow'][data-state='current'] {
  background: var(--dsw-alias-state-success-tertiary);
}

[data-wui='stageNodeButton'] {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 8px 0 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

[data-wui='stageNodeButton']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: -2px;
}

/* The node's cell: its width is what the connector line above is measured
   against --wui-stage-rail, so it is fixed rather than content-sized. */
[data-wui='stageNodeCell'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
}

/* 18px: big enough for the shipped 12px check outline to read as a glyph rather
   than a hairline, and small enough that the marker stays a node in a list. */
[data-wui='stageNode'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border-radius: 50%;
}

/* Reached: a green disc with a white check — this stage AND everything behind
   it, the current one included (it is reached, and it is still running). */
[data-wui='stageRow'][data-state='done'] [data-wui='stageNode'],
[data-wui='stageRow'][data-state='current'] [data-wui='stageNode'] {
  background: var(--dsw-alias-state-success-primary);
  color: var(--dsh-web-ui-stage-on-solid);
}

/* Ahead: an empty circle, deliberately with no fill of its own — the line stops
   short of it, so the panel's own surface is what shows through. */
[data-wui='stageRow'][data-state='pending'] [data-wui='stageNode'] {
  /* Lighter than the reached disc on purpose: an unreached node is a place in
     the flow, not a piece of work that is under way. */
  border: 1.5px solid var(--dsw-alias-border-l2);
}

/* Running: the node breathes. The halo starts at the node's own edge and fades
   out at 7px, which is what makes "this one is live" readable at a glance
   without motion you have to wait for. */
[data-wui='stageRow'][data-state='current'] [data-wui='stageNode'] {
  animation: wui-stage-pulse 1.9s var(--ds-ease-in-out) infinite;
}

@keyframes wui-stage-pulse {
  0% { box-shadow: 0 0 0 0 var(--dsh-web-ui-stage-halo); }
  60% { box-shadow: 0 0 0 7px var(--dsh-web-ui-stage-halo-off); }
  100% { box-shadow: 0 0 0 7px var(--dsh-web-ui-stage-halo-off); }
}

[data-wui='stageLabel'] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='stageStatus'] {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}

/* Ahead of the flow: grey words. Behind it: ordinary text, because finished
   work is not dimmed — it is what the operator has. */
[data-wui='stageRow'][data-state='pending'] [data-wui='stageLabel'],
[data-wui='stageRow'][data-state='pending'] [data-wui='stageStatus'] {
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='stageRow'][data-state='current'] [data-wui='stageLabel'] {
  font-weight: 600;
}

[data-wui='stageRow'][data-state='current'] [data-wui='stageStatus'] {
  color: var(--dsw-alias-state-success-primary);
  font-weight: 600;
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

/* ── Feishu folder failure strip ─────────────────────────────────────────
   ONE state, and only one: a failure. A creation that worked is announced by the
   shell's own system banner instead of by a row here (see ProjectFolderToast), so
   this strip never has to argue about tone — a row of the column means "act on
   this", and a success is not that. */

[data-wui='formPath'][data-locked='true'] {
  color: var(--dsw-alias-label-secondary);
  /* Read-only: the directory identifies the project, so it is shown as a FACT
     rather than as a field waiting to be edited. */
  cursor: default;
}

[data-wui='folderNotice'] {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: var(--dsh-web-ui-gap);
  padding: 8px 8px 8px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

[data-wui='folderNoticeText'] {
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

/* The session list's search row. It carries the count beside the field, which is
   where the list's own header used to carry it: the header row is gone (the
   project's name belongs to the dropdown above, and a row of the column is not
   worth a number), so one row now holds the control the operator uses AND the
   fact the count states. */
[data-wui='sessionSearch'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 6px 0;
}

/* The field takes the room the count does not need. Wrapping the primitive keeps
   this rule independent of its internals: the wrapper is what flex sizes. */
[data-wui='sessionSearchField'] {
  flex: 1;
  min-width: 0;
  display: block;
}

[data-wui='sessionCount'] {
  flex: none;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
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

/* The project's folder, in the identity strip: who is reading, and which folder
   they are reading. A link rather than a picker — the panel's subject is fixed
   to the selected project — so it keeps the trigger's shape and drops the
   chevron's room. */
[data-wui='larkFolderLink'] {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  padding: 2px 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

[data-wui='larkFolderLink']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

[data-wui='larkFolderName'] {
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

[data-wui='larkBadge'][data-type='doc'] { color: #2f6bd8; border-color: rgba(47, 107, 216, 0.35); }
[data-wui='larkBadge'][data-type='docx'] { color: #2f6bd8; border-color: rgba(47, 107, 216, 0.35); }
[data-wui='larkBadge'][data-type='sheet'] { color: #1f8a4c; border-color: rgba(31, 138, 76, 0.35); }
[data-wui='larkBadge'][data-type='bitable'] { color: #7a4bd0; border-color: rgba(122, 75, 208, 0.35); }
[data-wui='larkBadge'][data-type='slides'] { color: #c4711a; border-color: rgba(196, 113, 26, 0.35); }
[data-wui='larkBadge'][data-type='mindnote'] { color: #1c8f8a; border-color: rgba(28, 143, 138, 0.35); }
/* A folder is the one chip worth reading at a glance: it is the row that
   expands, so it carries the directory's own colour rather than the neutral. */
[data-wui='larkBadge'][data-type='folder'] { color: #b07d16; border-color: rgba(176, 125, 22, 0.4); }
[data-wui='larkBadge'][data-type='shortcut'] { color: var(--dsw-alias-label-secondary); }

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
  /* A failure's sentence, its fix, and its Retry are three long pieces of text:
     in a column this narrow, wrapping beats truncating any of them. */
  flex-wrap: wrap;
}

/* "This project has no folder" and "several folders could be it" are STATES, not
   failures: they stack their sentence above the actions that answer them, and
   they wrap rather than truncate, because the operator has to read them. */
[data-wui='larkNote'][data-tone='empty'] {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 4px;
  line-height: 1.5;
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

[data-wui='larkNoteAction'][disabled] {
  opacity: 0.5;
  cursor: default;
}

[data-wui='larkNoteAction'][disabled]:hover {
  border-color: var(--dsw-alias-border-l1);
  color: inherit;
}

/* The primary of a pair — creating the folder the project is supposed to have. */
[data-wui='larkNoteAction'][data-primary='true'] {
  border-color: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent);
}

[data-wui='larkNoteAction'][data-primary='true']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='larkActions'] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* The paste-a-link escape hatch: an operator who has the folder open in Feishu
   has a URL and nothing else. */
[data-wui='larkAttach'] {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

[data-wui='larkInput'] {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 11px;
}

[data-wui='larkInput']:focus {
  outline: none;
  border-color: var(--dsh-web-ui-accent);
}

/* The candidates of an ambiguous adoption: one row per same-named folder. */
[data-wui='larkCandidates'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
}

[data-wui='larkCandidate'] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 7px;
}

[data-wui='larkCandidate']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='larkCandidateName'] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
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

/* ── action bar ──────────────────────────────────────────────────────── */

/* One always-on group, pinned under the deploy's account chip.

   The login gate parks that chip at 12px/14px with a 32px capsule (20px avatar
   plus 5px of padding either side and a 1px border), so its lower edge is at
   44px and this bar starts at 52px — 8px of air. It is inset a little further
   from the right edge than the chip is (24px against the chip's 14px) so the
   controls do not read as part of the chip itself. Both offsets are custom
   properties, so a deployment whose chip differs can move the bar without
   touching the rules below. */
[data-wui='actionBar'] {
  position: fixed;
  top: var(--dsh-web-ui-bar-top, 52px);
  right: var(--dsh-web-ui-bar-right, 24px);
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  /* The overlay layer as a whole is click-through, so a floating group must
     claim its own hits. */
  pointer-events: auto;
}

[data-wui='actionButton'] {
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
  transition: background-color 120ms ease, color 120ms ease;
}

[data-wui='actionButton']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

[data-wui='actionButton']:disabled {
  opacity: 0.45;
  cursor: default;
}

/* The open panel's own control reads as pressed — the one state that answers
   "why is that panel there". */
[data-wui='actionButton'][aria-pressed='true'] {
  border-color: var(--dsh-web-ui-accent);
  background: var(--dsw-alias-interactive-bg-hover-accent);
  color: var(--dsw-alias-label-primary);
}

[data-wui='actionButtonLabel'] {
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* ── bottom command bar ──────────────────────────────────────────────── */

[data-wui='termPanel'] {
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
  animation: wui-term-in 160ms ease-out;
}

@keyframes wui-term-in {
  from { transform: translateY(18px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* The grab strip: a hairline with a hit area tall enough to actually catch. */
[data-wui='termResize'] {
  flex: none;
  height: 6px;
  margin-top: -3px;
  cursor: ns-resize;
}

[data-wui='termResize']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='termHead'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='termTitle'] {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='termDir'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='termSpacer'] {
  flex: 1;
  min-width: 0;
}

[data-wui='termChip'] {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

[data-wui='termChip'][data-tone='running'] {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='termChip'][data-tone='ok'] {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

[data-wui='termChip'][data-tone='failed'] {
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-label-primary-foreground);
}

[data-wui='termChip'][data-tone='warn'] {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='termChip'][data-tone='muted'] {
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='termButton'] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

[data-wui='termButton']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
}

[data-wui='termButton']:disabled {
  opacity: 0.45;
  cursor: default;
}

[data-wui='termButton'][data-tone='danger']:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='termHead'] [data-wui='iconButton'] {
  flex: none;
  width: 22px;
  height: 22px;
}

[data-wui='termRuns'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  padding: 4px 12px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='termRun'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 4px 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  cursor: pointer;
}

[data-wui='termRun']:hover {
  color: var(--dsw-alias-label-primary);
}

[data-wui='termRun'][data-active='true'] {
  border-bottom-color: var(--dsh-web-ui-accent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

[data-wui='termRunText'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='termRunDot'] {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-border-l3);
}

[data-wui='termRunDot'][data-tone='running'] { background: var(--dsw-alias-state-warn-primary); }
[data-wui='termRunDot'][data-tone='ok'] { background: var(--dsw-alias-state-success-primary); }
[data-wui='termRunDot'][data-tone='failed'] { background: var(--dsw-alias-state-error-primary); }

[data-wui='termPane'] {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  position: relative;
  padding: 8px 12px;
  background: var(--dsw-alias-markdown-code-block);
}

[data-wui='termOut'] {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
}

[data-wui='termNote'] {
  font-size: 11.5px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='termError'] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-label-primary-foreground);
  font-size: 11.5px;
}

[data-wui='termJump'] {
  position: absolute;
  right: 20px;
  bottom: 54px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  cursor: pointer;
}

[data-wui='termInputRow'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='termPrompt'] {
  flex: none;
  color: var(--dsh-web-ui-accent);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 13px;
  font-weight: 700;
}

[data-wui='termInput'] {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 12.5px;
}

[data-wui='termInput']:focus {
  outline: none;
  border-color: var(--dsh-web-ui-accent);
}

[data-wui='termRunButton'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent-label);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

[data-wui='termRunButton']:hover:not(:disabled) {
  background: var(--dsh-web-ui-accent-hover);
}

[data-wui='termRunButton']:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── git drawer ──────────────────────────────────────────────────────── */

/* A click-through positioning layer: the drawer floats over the app without
   blocking it, and without dismissing on an outside click. */
[data-wui='gitLayer'] {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}

[data-wui='gitDrawer'] {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: min(420px, 92vw);
  height: 100%;
  min-height: 0;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.16);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  animation: wui-git-in 160ms ease-out;
}

@keyframes wui-git-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

[data-wui='gitHeader'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='gitMark'] {
  display: inline-flex;
  color: var(--dsh-web-ui-accent);
}

[data-wui='gitHeaderText'] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

[data-wui='gitRepoName'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
}

[data-wui='gitBranchLine'] {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

[data-wui='gitBranchChip'] {
  flex: none;
  max-width: 190px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary-bluish);
  font-size: 11px;
  font-weight: 600;
}

[data-wui='gitBranchChip'][data-detached='true'] {
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gitTrack'] {
  flex: none;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

[data-wui='gitTrack'][data-tone='ahead'] {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

[data-wui='gitTrack'][data-tone='behind'] {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gitTrack'][data-tone='warn'] {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gitTrack'][data-tone='muted'] {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitTrackRow'] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

[data-wui='gitQuick'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='gitQuickButton'] {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
}

[data-wui='gitQuickButton']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

[data-wui='gitQuickButton']:disabled {
  opacity: 0.45;
  cursor: default;
}

[data-wui='gitQuick'] [data-wui='iconButton'] {
  flex: none;
  width: 26px;
  height: 26px;
}

[data-wui='gitTabs'] {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='gitTab'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 9px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  cursor: pointer;
}

[data-wui='gitTab']:hover {
  color: var(--dsw-alias-label-primary);
}

[data-wui='gitTab'][data-active='true'] {
  border-bottom-color: var(--dsh-web-ui-accent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

[data-wui='gitCount'] {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent-label);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
}

[data-wui='gitBody'] {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

[data-wui='gitTabHost'],
[data-wui='gitTabPane'] {
  min-height: 0;
}

[data-wui='gitTabPane'][data-hidden='true'] {
  display: none;
}

[data-wui='gitSection'] {
  display: flex;
  flex-direction: column;
  padding: 8px 12px 4px;
  gap: 6px;
}

[data-wui='gitSectionHead'] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitSectionHead'] > span:first-child {
  flex: 1;
  min-width: 0;
}

/* A section head whose label is a disclosure button rather than a span: the
   button takes the free space so the section's own action stays at the right
   edge instead of crowding the label. */
[data-wui='gitSectionHead'] [data-wui='gitDisclosure'] {
  flex: 1;
  min-width: 0;
}

[data-wui='gitRemoteName'] {
  flex: none;
  font-weight: 600;
  color: var(--dsw-alias-label-primary-bluish);
}

[data-wui='gitSectionTitle'] {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitDisclosure'] {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
}

[data-wui='gitDisclosure']:hover {
  color: var(--dsw-alias-label-primary);
}

/* The current-branch card: the one entry whose actions are not "move here". */
[data-wui='gitCard'] {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

[data-wui='gitCardHead'] {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

[data-wui='gitCardLabel'] {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitBranchName'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
}

[data-wui='gitCardMeta'] {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

[data-wui='gitCardSubject'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='gitRows'] {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

[data-wui='gitRow'] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  border-radius: 6px;
}

[data-wui='gitRow']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='gitRow'][data-current='true'] {
  background: var(--dsw-alias-interactive-bg-hover-accent);
}

[data-wui='gitRow'][data-tone='error'] [data-wui='gitRowName'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='gitRowMain'] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 6px;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

[data-wui='gitRowMain']:disabled {
  cursor: default;
}

[data-wui='gitRowMain'][data-static='true'] {
  cursor: default;
}

[data-wui='gitRowTitle'] {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

[data-wui='gitRowMeta'] {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='gitRowName'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}

[data-wui='gitRowName'][data-muted='true'] {
  color: var(--dsw-alias-label-secondary);
}

[data-wui='gitRowName'][data-code='true'] {
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 11px;
}

[data-wui='gitRowSubject'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='gitRowSubject'][data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='gitRowTime'] {
  flex: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

[data-wui='gitRowToggle'] {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='gitBranchDot'] {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-border-l3);
}

[data-wui='gitBranchDot'][data-current='true'] {
  background: var(--dsh-web-ui-accent);
}

[data-wui='gitSha'],
[data-wui='gitStashRef'] {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--dsw-alias-markdown-inline-code);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 10.5px;
}

[data-wui='gitRefChip'] {
  flex: none;
  max-width: 150px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
}

[data-wui='gitRowActions'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
}

[data-wui='gitRowAction'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

[data-wui='gitRowAction']:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
}

[data-wui='gitTinyAction'] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

[data-wui='gitTinyAction']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-primary);
}

[data-wui='gitTinyAction']:disabled {
  opacity: 0.45;
  cursor: default;
}

[data-wui='gitTinyAction'][data-tone='danger']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='gitPrimaryButton'] {
  height: 28px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent-label);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

[data-wui='gitPrimaryButton']:hover:not(:disabled) {
  background: var(--dsh-web-ui-accent-hover);
}

[data-wui='gitPrimaryButton']:disabled {
  opacity: 0.5;
  cursor: default;
}

[data-wui='gitStatusChipHost'] {
  flex: none;
}

[data-wui='gitStatusChip'] {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 10.5px;
  font-weight: 700;
  white-space: pre;
}

[data-wui='gitStatusChip'][data-side='staged'] {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

[data-wui='gitStatusChip'][data-side='unstaged'] {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gitStatusChip'][data-side='untracked'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitStatusChip'][data-side='conflict'] {
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-label-primary-foreground);
}

[data-wui='gitAlert'] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 12px 0;
  padding: 7px 9px;
  border-radius: 8px;
  font-size: 11.5px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gitAlert'][data-tone='error'] {
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-label-primary-foreground);
}

[data-wui='gitAlert'] > span {
  flex: 1;
  min-width: 0;
}

[data-wui='gitAlert'] [data-wui='gitTinyAction'] {
  flex: none;
  color: inherit;
  border-color: currentColor;
}

[data-wui='gitNote'] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitNote'][data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}

/* An explanatory note rather than a status: dimmer than a normal note, because
   it is orientation the reader needs once, not information about the tree. */
[data-wui='gitNote'][data-tone='hint'] {
  color: var(--dsw-alias-label-dimmed);
  font-size: 11px;
}

[data-wui='gitEmpty'] {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 34px 20px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='gitEmpty'][data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='gitEmptyTitle'] {
  font-size: 12.5px;
  word-break: break-word;
}

[data-wui='gitEmptyHint'] {
  font-size: 11.5px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='gitEmpty'] [data-wui='gitQuickButton'] {
  flex: none;
}

[data-wui='gitCommitBox'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

[data-wui='gitCommitInput'] {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
}

[data-wui='gitCommitInput']:focus {
  outline: none;
  border-color: var(--dsh-web-ui-accent);
}

[data-wui='gitCommitAll'] {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

[data-wui='gitCommitActions'] {
  display: flex;
  align-items: center;
  gap: 6px;
}

[data-wui='gitStashHead'] {
  display: flex;
  align-items: center;
  gap: 6px;
}

[data-wui='gitStashInput'] {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 5px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px;
}

[data-wui='gitStashInput']:focus {
  outline: none;
  border-color: var(--dsh-web-ui-accent);
}

[data-wui='gitPatch'] {
  flex-basis: 100%;
  padding: 0 6px 8px;
}

[data-wui='gitPatchText'] {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre;
  tab-size: 2;
}

[data-wui='gitCommitFiles'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='gitNumstat'] {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

[data-wui='gitNumstat'] [data-wui='gitRowName'] {
  flex: 1;
}

[data-wui='gitAdd'] {
  flex: none;
  color: var(--dsw-alias-state-success-primary);
  font-variant-numeric: tabular-nums;
}

[data-wui='gitDel'] {
  flex: none;
  min-width: 26px;
  color: var(--dsw-alias-state-error-primary);
  font-variant-numeric: tabular-nums;
}

[data-wui='gitSelect'] {
  flex: none;
  height: 22px;
  padding: 0 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
}

[data-wui='gitFooter'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 6px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='gitFooterBusy'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  animation: wui-git-pulse 1.2s ease-in-out infinite;
}

@keyframes wui-git-pulse {
  50% { opacity: 0.55; }
}

[data-wui='gitFooterStatus'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--dsw-alias-state-success-primary);
}

[data-wui='gitFooterStatus'][data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='gitFooterText'] {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='gitFooterIdle'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ── New Project form ────────────────────────────────────────────────────
   The dialog's own field vocabulary. It is NOT the column's: a modal renders
   into document.body, outside the column element, so the column's scoped
   tokens are not in scope here and every value below is either a global
   --dsw-alias-* token or a literal. */

/* The shared modal card is 380px wide, which is right for a one-field prompt
   and too narrow for this form: its folder line is a path the operator reads
   back plus a button beside it.
 *
 * The card is reached from the FORM rather than from the card's own class,
 * because that class is a hashed CSS-module name this plugin does not own —
 * the :has() selector asks the structural question instead (the modal that
 * contains this form), so an upstream class rename cannot silently un-widen
 * the dialog. */
.dsh-web-ui-new-project:has([data-wui='form']) {
  width: min(520px, 100%);
}

[data-wui='form'] {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 100%;
  min-width: 0;
}

/* The card takes the focus on open (so the dialog is keyboard-usable), which
   must not draw a focus ring around the whole form. */
[data-wui='form']:focus {
  outline: none;
}

[data-wui='formField'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

[data-wui='formLabel'] {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='formHint'] {
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

/* The folder field is a chosen VALUE plus the control that changes it: the path
   itself is a fact the operator reads back, not a string they may edit. */
[data-wui='formPathRow'] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

[data-wui='formPath'] {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 8px;
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  font-size: 12px;
  line-height: 20px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='formPath'][data-empty='true'] {
  border-style: dashed;
  font-family: inherit;
  color: var(--dsw-alias-label-dimmed);
}

[data-wui='formError'] {
  padding: 7px 9px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  font-size: 12px;
  line-height: 17px;
  word-break: break-word;
  color: var(--dsw-alias-label-primary);
}

/* A fieldset reset: the browser's default border and padding are what make a
   native group look unlike the rest of these fields. */
[data-wui='formFieldset'] {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

[data-wui='formRadios'] {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 7px;
}

/* Each answer is a chip the whole of which is the hit target (the label wraps
   the input), so the radio dot and the word are one control. */
[data-wui='formRadio'] {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

[data-wui='formRadio']:hover {
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

[data-wui='formRadio'][data-checked='true'] {
  border-color: var(--dsh-web-ui-accent);
  background: var(--dsh-web-ui-accent-soft);
  color: var(--dsh-web-ui-accent);
}

[data-wui='formRadio'] input {
  margin: 0;
  accent-color: var(--dsh-web-ui-accent);
}

[data-wui='formRadio']:has(input:focus-visible) {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

[data-wui='formRadioLabel'] {
  white-space: nowrap;
}

[data-wui='formSelect'] {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

[data-wui='formSelect']:disabled {
  opacity: 0.5;
  cursor: default;
}

[data-wui='formSelect']:focus-visible {
  outline: none;
  border-color: var(--dsh-web-ui-accent);
}

/* The card row's own states: loading, and the two ways there is nothing to
   pick. This is where the still-open product-card seam shows itself, so it is a
   sentence rather than an error icon. */
[data-wui='formCardNote'] {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.06);
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='formCardNote'][data-tone='error'] {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-label-primary);
}

[data-wui='formCardNoteText'] {
  min-width: 0;
  word-break: break-word;
}


`

/** The complete stylesheet this plugin injects into `document.head`. */
export const STYLES = `${GLOBAL_SKIN}${SHELL}`
