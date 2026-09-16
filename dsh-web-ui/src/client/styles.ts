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

/* The FDE flow's own colours (see stage.ts). They are declared HERE, on the page
   root, and not on the column like the other --dsh-web-ui-* values: the flow
   panel is portaled to the page body (the column clips its own overflow, so the
   panel cannot live inside it), and a custom property set on the column would not
   reach it.

   THREE of them exist only because the shipped tokens they would otherwise use
   are unreadable on these surfaces, which is worth stating so nobody "simplifies"
   them back:

   - --dsh-web-ui-stage-live-text — the word 运行中. --dsw-alias-state-success-
     primary is a FILL colour: as text on the light panel and on its own green
     tint it measures 2.09:1. This is the same green, dark enough to read.
   - --dsh-web-ui-stage-idle — the connector rail and the hollow unreached node.
     --dsw-alias-border-l2 is a hairline: measured against these cards it is
     1.26:1 (light) and 1.46:1 (dark), i.e. the parts of the flow that are NOT
     reached were effectively invisible. Raised to a boundary the eye can follow
     (>= 3:1 in both themes).
   - the halo is a pair — on and off — because a keyframe cannot interpolate to
     transparent: green's own transparent is used instead, which is what keeps
     the pulse from fading through grey.

   Every value here was chosen by measuring, and measure-stage-tag.mjs asserts
   the resulting contrast ratios in both themes so they cannot drift back. */
html body {
  --dsh-web-ui-stage-on-solid: #ffffff;
  --dsh-web-ui-stage-halo: rgba(34, 197, 94, 0.3);
  --dsh-web-ui-stage-halo-off: rgba(34, 197, 94, 0);
  --dsh-web-ui-stage-live-text: rgb(20, 110, 55);
  --dsh-web-ui-stage-idle: rgba(15, 17, 21, 0.46);
  --dsh-web-ui-stage-idle-soft: rgba(15, 17, 21, 0.22);
}
html body[data-ds-dark-theme] {
  --dsh-web-ui-stage-live-text: var(--dsw-static-green-400);
  --dsh-web-ui-stage-idle: rgba(255, 255, 255, 0.4);
  --dsh-web-ui-stage-idle-soft: rgba(255, 255, 255, 0.22);
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
   state this plugin renders. ONE STEP is the FIRST stage, not zero: sitting on
   stage one is one step of the flow, done. These are per-step rules because the
   flow's LENGTH is a fact this stylesheet has to know (see STAGE_COUNT in
   stage.ts): adding a stage means adding a row here and re-fractioning the rest. */
[data-wui='stageRing'] {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: conic-gradient(
    var(--dsw-alias-state-success-primary) var(--wui-stage-fill, 16.667%),
    var(--dsh-web-ui-stage-idle) 0
  );
  -webkit-mask: radial-gradient(circle closest-side, transparent 72%, #000 76%);
  mask: radial-gradient(circle closest-side, transparent 72%, #000 76%);
}

[data-wui='stageTag'][data-step='0'] [data-wui='stageRing'] { --wui-stage-fill: 14.286%; }
[data-wui='stageTag'][data-step='1'] [data-wui='stageRing'] { --wui-stage-fill: 28.571%; }
[data-wui='stageTag'][data-step='2'] [data-wui='stageRing'] { --wui-stage-fill: 42.857%; }
[data-wui='stageTag'][data-step='3'] [data-wui='stageRing'] { --wui-stage-fill: 57.143%; }
[data-wui='stageTag'][data-step='4'] [data-wui='stageRing'] { --wui-stage-fill: 71.429%; }
[data-wui='stageTag'][data-step='5'] [data-wui='stageRing'] { --wui-stage-fill: 85.714%; }
[data-wui='stageTag'][data-step='6'] [data-wui='stageRing'] { --wui-stage-fill: 100%; }

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
  background: var(--dsh-web-ui-stage-idle);
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
  /* Hollow rather than filled, so "no work here yet" reads at a glance — but
     drawn in the same idle grey as the rail, which is a boundary, not a hairline
     (see the token block: the hairline measured 1.26:1). */
  border: 1.5px solid var(--dsh-web-ui-stage-idle);
}

/* The flow's END, while it is still ahead: a second hairline ring around the
   hollow marker, so 完成 reads as the destination the line runs to rather than as
   one more step. It is scoped to the UNREACHED case because the reached one is
   already a filled disc with a check — and because the running node's halo is a
   box-shadow too, which the pulse animation owns. */
[data-wui='stageRow'][data-final='true'][data-state='pending'] [data-wui='stageNode'] {
  /* Two rings, BOTH in the flow's idle grey. The shipped hairlines this used to
     draw with measure 1.26:1 (light) and 1.66:1 (dark) — which made the flow's
     destination the LEAST visible node on the card. The outer ring is the softer
     of the two greys, so the emphasis reads as a ring and not as a heavier node. */
  border-color: var(--dsh-web-ui-stage-idle);
  box-shadow: 0 0 0 2px var(--dsh-web-ui-stage-idle-soft);
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

/* Ahead of the flow: grey words. Behind it: ordinary text, because finished work
   is not dimmed — it is what the operator has. The grey is label-secondary
   (5.8:1 light, 8.0:1 dark) and NOT label-dimmed: that token is for text on a
   FILLED surface, and on these cards it measures 1.26:1 in both themes — the
   stage names were unreadable. */
[data-wui='stageRow'][data-state='pending'] [data-wui='stageLabel'],
[data-wui='stageRow'][data-state='pending'] [data-wui='stageStatus'] {
  color: var(--dsw-alias-label-secondary);
}

[data-wui='stageRow'][data-state='current'] [data-wui='stageLabel'] {
  font-weight: 600;
}

[data-wui='stageRow'][data-state='current'] [data-wui='stageStatus'] {
  /* A readable green, not the fill green: see the token block. */
  color: var(--dsh-web-ui-stage-live-text);
  font-weight: 600;
}

/* ── FDE stage gate ───────────────────────────────────────────────────────
   Two things live here: the LOCKED rows (every node that is neither the current
   stage nor the next one — see isStageLocked in stage.ts) and the GATE DIALOG a
   gated click opens. The lock is positional and the dialog is a modal, so
   neither is a fourth node state and the flow's colour rules above stay
   untouched. */

/* A locked row keeps its own words and colour — what is missing is the MOVE, not
   the stage — so the only change is the cursor and a hover that never promises a
   click. (The user agent's own disabled dimming is overridden below, because a
   greyed-out stage would read as "broken" rather than "not yet".) */
[data-wui='stageNodeButton'][data-locked='true'] {
  cursor: default;
}

[data-wui='stageNodeButton'][data-locked='true']:disabled {
  color: inherit;
}

[data-wui='stageRow']:has([data-wui='stageNodeButton'][data-locked='true']):hover {
  background: transparent;
}

/* The gate dialog: a page-level modal, portaled to the body for the same reason
   the flow panel is portaled (the column clips its own overflow). Its own markup
   rather than the shared Modal, because the checklist has structure the shared
   card does not carry — and because this plugin's stylesheet is what the preview
   measurement can see. */
[data-wui='gateOverlay'] {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}

[data-wui='gateDialog'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 420px;
  max-width: 100%;
  max-height: 100%;
  overflow-y: auto;
  padding: 14px 16px 12px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-shadow-lv3);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  animation: wui-gate-in 140ms var(--ds-ease-in-out);
}

@keyframes wui-gate-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
}

[data-wui='gateHead'] {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

[data-wui='gateHeading'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

[data-wui='gateTitle'] {
  font-size: 15px;
  font-weight: 600;
}

[data-wui='gateTarget'] {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

[data-wui='gateClose'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

[data-wui='gateClose']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

[data-wui='gateNote'] {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.5;
}

[data-wui='gateNote'][data-tone='warn'] {
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gateNoteIcon'] {
  flex: none;
  display: inline-flex;
  margin-top: 1px;
}

[data-wui='gateItems'] {
  margin: 0;
  padding: 0;
  list-style: none;
}

[data-wui='gateItem'] {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 0;
}

/* The mark is the whole verdict at a glance: a met item carries the flow's own
   success colour, an unmet one the warning that stopped the move. */
[data-wui='gateItemMark'] {
  flex: none;
  display: inline-flex;
  margin-top: 1px;
  color: var(--dsw-alias-state-success-primary);
}

[data-wui='gateItem'][data-met='false'] [data-wui='gateItemMark'],
[data-wui='gateManual'][data-met='false'] [data-wui='gateItemMark'] {
  color: var(--dsw-alias-state-warn-primary);
}

[data-wui='gateItemBody'] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

[data-wui='gateItemHeading'] {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

[data-wui='gateItemLabel'] {
  color: var(--dsw-alias-label-primary);
}

/* Where a line was answered: a drive and this machine are different places to go
   and look, so the checklist says which one each row is about. */
[data-wui='gateItemBadge'] {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 15px;
}

/* A workspace artifact's proof: a file on this host, which a page cannot open, so
   it is stated with its size rather than offered as a link that would do nothing. */
[data-wui='gateItemProof'] {
  align-self: flex-start;
  max-width: 100%;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='gateItemNote'] {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

/* The evidence is a BUTTON rather than an anchor: it opens a Feishu tab with
   window.open, like the folder panel's rows, so it must not look like a link the
   page cannot honour. */
[data-wui='gateEvidence'] {
  align-self: flex-start;
  max-width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-label-primary-bluish);
  font: inherit;
  font-size: 11px;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}

[data-wui='gateEvidence']:hover {
  text-decoration: underline;
}

/* The manual item: the one part of the checklist a folder cannot answer, so it is
   set apart from the read items by its own panel and by the accent the answer
   carries once it is given. */
[data-wui='gateManual'] {
  margin-top: 2px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
}

[data-wui='gateManual'][data-met='true'] {
  border-left-color: var(--dsw-alias-state-success-primary);
}

[data-wui='gateManualHead'] {
  display: flex;
  align-items: center;
  gap: 6px;
}

[data-wui='gateManualHead'] [data-wui='gateItemNote'] {
  margin-left: auto;
}

[data-wui='gateManualQuestion'] {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
}

/* The answers are chips the whole of which is the hit target (the label wraps the
   input), so the radio dot and the word are one control — the same pattern the
   New Project form's three answers use. */
[data-wui='gateChoices'] {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 7px;
}

[data-wui='gateChoice'] {
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

[data-wui='gateChoice']:hover {
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

[data-wui='gateChoice'][data-checked='true'] {
  border-color: var(--dsh-web-ui-accent);
  background: var(--dsh-web-ui-accent-soft);
  color: var(--dsh-web-ui-accent);
}

[data-wui='gateChoice'] input {
  margin: 0;
  accent-color: var(--dsh-web-ui-accent);
}

[data-wui='gateChoice']:has(input:focus-visible) {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

[data-wui='gateManualRecord'] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

[data-wui='gateWithdraw'] {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}

[data-wui='gateWithdraw']:hover:not(:disabled) {
  color: var(--dsw-alias-state-warn-label);
}

[data-wui='gateActions'] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}

/* Pushes the two exits to the right edge, so the actions read as
   "utilities … cancel / enter". */
[data-wui='gateSpacer'] {
  flex: 1;
}

[data-wui='gateFolder'],
[data-wui='gateRetry'],
[data-wui='gateCancel'] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

[data-wui='gateFolder']:hover,
[data-wui='gateRetry']:hover:not(:disabled),
[data-wui='gateCancel']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The one filled control in the dialog, and it is disabled until the checklist is
   satisfied: a gate with a "continue anyway" button is not a gate. */
[data-wui='gateEnter'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 14px;
  border: none;
  border-radius: 6px;
  background: var(--dsh-web-ui-accent);
  color: var(--dsh-web-ui-accent-label);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 120ms var(--ds-ease-in-out);
}

[data-wui='gateEnter']:hover:not(:disabled) {
  background: var(--dsh-web-ui-accent-hover);
}

[data-wui='gateFolder']:disabled,
[data-wui='gateRetry']:disabled,
[data-wui='gateCancel']:disabled,
[data-wui='gateEnter']:disabled {
  opacity: 0.5;
  cursor: default;
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

/* ── account dock: the bottom-left row and its upward drawer ──────────────
   The account used to be a capsule in the frame's TOP-RIGHT corner. It lives
   here now, because the column's foot is where a once-a-day control belongs and
   the top-right corner is the frame's own. The drawer is a sibling of the row,
   not a portal: it opens upward INSIDE the column, so the column's own clipping
   is what keeps it there, and the rail (56px, no width for it) reaches the same
   rows by expanding instead — see AccountDock.tsx. */

[data-wui='account'] {
  position: relative;
  flex: none;
}

[data-wui='accountDrawer'] {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-shadow-lv3);
  /* A short viewport must SCROLL the drawer, never clip it: the column clips its
     own overflow, so a drawer taller than the space above it would lose its top
     rows — and the two rows a reader comes here for are the bottom two. */
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  /* Elevated surface: it takes the l2 elevation scrollbar tokens, like every
     other card in this composition. */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);

  /* CLOSED is hidden, not unmounted (see AccountDock.tsx for why: the shipped
     Settings shell lives in here, and that shell is also what renders the
     body-portaled onboarding surface). visibility is doing the accessibility and
     hit-testing work — it takes the whole subtree out of the accessibility tree
     and out of the tab order, which opacity: 0 alone would not — and it is
     transitioned with a DELAY on the way out so the fade is visible, and with no
     delay on the way in. */
  visibility: hidden;
  opacity: 0;
  transform: translateY(6px);
  pointer-events: none;
  transition:
    opacity 120ms var(--ds-ease-in-out),
    transform 120ms var(--ds-ease-in-out),
    visibility 0s linear 120ms;
}

/* It opens upward, so it arrives from just below. */
[data-wui='accountDrawer'][data-open='true'] {
  visibility: visible;
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition:
    opacity 140ms var(--ds-ease-in-out),
    transform 140ms var(--ds-ease-in-out),
    visibility 0s;
}

@media (prefers-reduced-motion: reduce) {
  [data-wui='accountDrawer'],
  [data-wui='accountDrawer'][data-open='true'] { transition: none; }
}

/* One row of the drawer. The shipped Settings trigger is made to match this
   rhythm by the rule further down — the two must read as one list.

   flex: none is load-bearing rather than tidiness. The drawer is a column flex
   container with a max-height, so every child would otherwise SHRINK to fit
   before the drawer ever scrolled — and a row cannot fall back on the automatic
   minimum size, because the overflow: hidden above (which is what truncates a
   long name) sets that minimum to zero. Measured without it: a 36px row becomes
   8px at a 400px-tall viewport and 0px at 320px. */
[data-wui='drawerRow'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 0 8px;
  box-sizing: border-box;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

[data-wui='drawerRow']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='drawerRowIcon'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='drawerRowLabel'] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='drawerRowChevron'],
[data-wui='accountChevron'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
}

/* The chevron points UP while the surface below is closed (that is the way it
   will open) and flips once it is open. One glyph, two states, so the two
   chevrons in this corner cannot drift apart. */
[data-wui='drawerRowChevron'] svg,
[data-wui='accountChevron'] svg {
  transition: transform 140ms var(--ds-ease-in-out);
}

[data-wui='drawerRowChevron'][data-open='true'] svg,
[data-wui='accountChevron'][data-open='true'] svg {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  [data-wui='drawerRowChevron'] svg,
  [data-wui='accountChevron'] svg { transition: none; }
}

[data-wui='drawerDivider'] {
  flex: none;
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l1);
}

[data-wui='drawerBody'] {
  /* Same reason as the rows: content that shrinks is content that gets clipped
     instead of scrolled. */
  flex: none;
  padding: 2px 8px 6px;
}

/* The shipped Settings trigger (ui-settings-general's SettingsRoot), rendered
   INSIDE the drawer instead of the column's foot. Its own stylesheet sizes it
   as a 42px foot row with negative margins; this re-sizes it into the drawer's
   36px row rhythm. Two attribute selectors and an element beat its own
   .trigger (one class) and that rule's :hover, whatever order the two
   stylesheets landed in — which matters, because this sheet is injected by
   apply() and the shipped one by the shell.
 *
 * The CHILD combinator is load-bearing, not tidiness. SettingsRoot renders the
 * trigger AND the settings PANEL as siblings inside one slot wrapper, so without
 * it this rule also reaches every button inside the modal that panel draws —
 * measured: the Plugins page's 52px cards came out with the drawer row's 8px
 * padding and 10px gap. The direct-child combinator is the trigger and nothing
 * else.
 *
 * It is anchored on the SEAT, not on an attribute of the trigger: the seat key is
 * something THIS plugin declares and renders, so it cannot drift, whereas
 * aria-haspopup="dialog" is also the honest marking for this plugin's own Plugins
 * row — which opens a modal too, and must keep the drawer's ordinary rhythm. */
[data-wui='accountDrawer'] [data-slot='sidebar.settings'] > button {
  width: 100%;
  height: 36px;
  margin: 0;
  padding: 0 8px;
  gap: 10px;
  border-radius: 8px;
  font-size: 13px;
}

[data-wui='accountRow'] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 42px;
  margin: 4px -2px;
  padding: 0 10px 0 8px;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

[data-wui='accountRow']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The identity content the occupant renders fills what the chevron leaves, and
   truncates rather than pushing the chevron out of the row. */
[data-wui='accountIdentity'] {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}

[data-wui='accountFallback'] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='accountFallbackName'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* The rail row: the avatar alone, in the same 36x36 circle box as every other
   rail control. */
[data-wui='column'][data-rail='true'] [data-wui='accountRow'] {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  padding: 0;
  justify-content: center;
  gap: 0;
  border-radius: 50%;
}

/* ── usage block (inside the account drawer) ─────────────────────────── */

[data-wui='usage'] {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

[data-wui='usageNote'] {
  margin: 2px 0 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

[data-wui='usageContext'] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

[data-wui='usageContextHead'] {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

[data-wui='usageContextFigures'] {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}

[data-wui='usageBar'] {
  height: 6px;
  border-radius: 3px;
  background: var(--dsw-alias-border-l1);
  overflow: hidden;
}

[data-wui='usageBarFill'] {
  height: 100%;
  border-radius: 3px;
  background: var(--dsh-web-ui-accent);
  transition: width 200ms var(--ds-ease-in-out);
}

@media (prefers-reduced-motion: reduce) {
  [data-wui='usageBarFill'] { transition: none; }
}

[data-wui='usageBarLabel'] {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

[data-wui='usageGrid'] {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 6px;
}

[data-wui='usageFigure'] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='usageFigureLabel'] {
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='usageFigureValue'] {
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}

[data-wui='usageFoot'] {
  /* The scope sentence is the one line a reader must be able to check the
     figures against, so it stays legible rather than fading into the surface. */
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
}

/* ── plugins modal ──────────────────────────────────────────────────────
   The Settings → Plugins page's presentation, reproduced for the account
   drawer's own modal: a search row, a "插件列表" heading with its count, and a
   two-column card grid whose cards disclose their Loader entry and Cordis state
   in place. The geometry, the tokens AND the phase colours are that page's own,
   because a plugin must read the same in both places.

   The card is reached from the CONTENT rather than from the modal's own class:
   that class is a hashed CSS-module name this plugin does not own, so the :has()
   selector asks the structural question instead (the modal containing this
   tree), and an upstream class rename cannot silently un-widen the dialog. */
.dsh-web-ui-plugins:has([data-wui='pluginsDialog']) {
  width: min(720px, 100%);
}

[data-wui='pluginsDialog'] {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}

/* The catalogue scrolls inside a bounded region, so the modal's header and its
   search row stay put — the same split the settings panel makes between its
   fixed chrome and its scrolling options area. */
[data-wui='pluginSearch'],
[data-wui='pluginCatalogHeading'] {
  flex: none;
}

[data-wui='pluginSearchField'] {
  display: block;
  width: 100%;
}

[data-wui='pluginCatalogHeading'] {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 2px;
  padding: 0 2px;
}

[data-wui='pluginCatalogHeading'] h3 {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
}

[data-wui='pluginCatalogHeading'] span {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

[data-wui='pluginNote'] {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='pluginFailure'] {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='pluginFailure'] p {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

[data-wui='pluginFailure'] button {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 4px 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}

[data-wui='pluginFailure'] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='pluginCards'] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 10px;
  /* The list is ~180 entries in this deployment: it scrolls in its own region
     rather than growing the modal past the viewport. */
  max-height: min(440px, calc(100vh - 320px));
  overflow-y: auto;
  margin: 0;
  padding: 2px;
  list-style: none;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

/* One column when the modal is narrow (a small viewport caps the card), so a
   title never has to share 150px with a phase dot and two tags. */
@media (max-width: 620px) {
  [data-wui='pluginCards'] { grid-template-columns: minmax(0, 1fr); }
}

[data-wui='pluginCard'] {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}

[data-wui='pluginCard'][data-open='true'] {
  border-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-shadow-lv1);
}

[data-wui='pluginCardBody'] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  border: 0;
  padding: 12px 14px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

[data-wui='pluginCardBody']:hover,
[data-wui='pluginCard'][data-open='true'] > [data-wui='pluginCardBody'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='pluginCardBody']:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

[data-wui='pluginCardTitle'] {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-wui='pluginCardTrailing'] {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 7px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='pluginDot'] {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary);
}

[data-wui='pluginDot'][data-phase='active'] {
  background: var(--dsw-alias-state-success-primary);
}

[data-wui='pluginDot'][data-phase='failed'] {
  background: var(--dsw-alias-state-error-primary);
}

[data-wui='pluginDot'][data-phase='loading'] {
  background: var(--dsw-alias-state-business-primary);
}

[data-wui='pluginTag'] {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

/* Enabled is the ordinary state and reads as a quiet success chip; disabled is
   the exception the reader is looking for, so it is the one that keeps the
   neutral chip. */
[data-wui='pluginTag'][data-enabled='true'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

[data-wui='pluginChevron'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 140ms var(--ds-ease-in-out);
}

[data-wui='pluginCard'][data-open='true'] [data-wui='pluginChevron'] {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  [data-wui='pluginChevron'] { transition: none; }
}

[data-wui='pluginCardDetails'] {
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding: 10px 14px 12px;
  background: var(--dsw-alias-bg-module-platform);
}

[data-wui='pluginEntryId'] {
  display: block;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
}

[data-wui='pluginFacts'] {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 6px 10px;
  margin: 8px 0 0;
}

[data-wui='pluginFacts'] > div {
  display: contents;
}

[data-wui='pluginFacts'] dt {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 17px;
}

[data-wui='pluginFacts'] dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 17px;
}

/* ── skills modal ───────────────────────────────────────────────────────
   The account drawer's Skills modal: an installed block whose two scopes are
   TABS, a divider, and the public marketplace below it. It borrows the plugins
   modal's geometry and tokens (the same heading-plus-count row, the same card
   language) because the two are siblings opened from the same drawer, and the
   tab strip is the Git drawer's own strip re-scaled to a modal's rhythm rather
   than a third design for "two mutually exclusive views".

   The card is reached from the CONTENT rather than from the modal's own class:
   that class is a hashed CSS-module name this plugin does not own, so the :has()
   selector asks the structural question instead. */
.dsh-web-ui-skills:has([data-wui='skillsDialog']) {
  /* 936px = the 720px this started at, +30%. The host card's own width is
     min(380px, 100%) (Modal.module.css), which is right for a one-field prompt and
     far too narrow for a two-column card grid, so this rule has to beat it: a class
     selector plus :has() out-specifies the primitive's single class, and the :has()
     asks the structural question rather than naming a hashed CSS-module class this
     plugin does not own. A 100% cap still applies on a narrow viewport, inside the
     modal layer's own 24px padding. */
  width: min(936px, 100%);
}

[data-wui='skillsDialog'] {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}

/* The search row: fixed at the top of the body, above both sections, so it drives
   them without scrolling away. It does not shrink. */
[data-wui='skillSearch'] {
  flex: none;
}

[data-wui='skillSearchField'] {
  display: block;
  width: 100%;
}

[data-wui='skillInstalled'],
[data-wui='skillMarket'] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* The heading row is the plugins modal's: a section title with its count, so the
   two modals read as the same kind of surface. */
[data-wui='skillInstalledHeading'],
[data-wui='skillMarketHeading'] {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 0 2px;
}

[data-wui='skillInstalledHeading'] h3,
[data-wui='skillMarketHeading'] h3 {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
}

[data-wui='skillInstalledHeading'] span,
[data-wui='skillMarketHeading'] span {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

/* The scope strip. A full-width rule under it is what makes the two tabs read as
   views of the block above rather than as two more buttons. */
[data-wui='skillTabs'] {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

[data-wui='skillTab'] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  cursor: pointer;
}

[data-wui='skillTab']:hover {
  color: var(--dsw-alias-label-primary);
}

[data-wui='skillTab'][data-active='true'] {
  border-bottom-color: var(--dsh-web-ui-accent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

[data-wui='skillTab']:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

[data-wui='skillPane'] {
  min-width: 0;
}

/* Both lists scroll inside a bounded region, so the modal cannot grow past the
   viewport: the shared Modal card clips its own overflow, so an unbounded grid
   would silently cut the marketplace off the bottom of the screen. */
[data-wui='skillGrid'],
[data-wui='skillMarketGrid'] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /* STRETCH, not "start". The plugins modal's grid uses "start" because every card
     there is the same shape; a skill card is not — a description that wraps one
     more line than its neighbour's left the two bottoms 36px apart, which is the
     misalignment this rule exists to fix. A row's cards now share the row's
     height, and the row is as tall as its tallest card. */
  align-items: stretch;
  gap: 10px;
  max-height: min(200px, calc(100vh - 520px));
  overflow-y: auto;
  margin: 0;
  padding: 2px;
  list-style: none;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

/* One column when the modal is narrow (a small viewport caps the card), so a
   description never has to share 150px with its own name. */
@media (max-width: 620px) {
  [data-wui='skillGrid'],
  [data-wui='skillMarketGrid'] { grid-template-columns: minmax(0, 1fr); }
}

[data-wui='skillCard'],
[data-wui='skillMarketCard'] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 11px 14px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}

/* Name and tag share a row, so the tag never pushes the description down. */
[data-wui='skillCardHead'] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

[data-wui='skillName'] {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The marketplace's own label: a skill in the list that belongs to one person
   rather than to the deployment. Neutral, like the plugins modal's 已停用 chip —
   it is a fact about the asset, not a warning and not a success. */
[data-wui='skillTag'] {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

/* The identity line: which asset and which version, under the description (or in
   its place, when the marketplace had no description to give). Tertiary and small,
   because it is a fact to look up rather than something to read. */
[data-wui='skillMeta'] {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}

[data-wui='skillDescription'] {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

/* The action row a card carries when it can be acted on. The button is the
   marketplace's install control, and it sits at the card's foot so a two-column
   grid keeps its rows aligned on the name rather than on the button. */
[data-wui='skillCardActions'] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  /* "auto" pushes the row to the card's foot, which is what makes two buttons in
     one row sit at the same height when the text above them differs. */
  margin-top: auto;
  padding-top: 2px;
}

[data-wui='skillInstallButton'] {
  box-sizing: border-box;
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border: 1px solid var(--dsh-web-ui-accent);
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: var(--dsh-web-ui-accent);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

[data-wui='skillInstallButton']:hover {
  background: color-mix(in srgb, var(--dsh-web-ui-accent) 10%, transparent);
}

[data-wui='skillInstallButton']:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

/* Neither of these is a button: 已安装 is what the DISK says (the host refuses to
   touch a directory that exists), and the busy state is a request in flight. Both
   are states a reader reads rather than presses. */
/* The same 24px as the button they replace, so a card does not change height when
   its skill is installed — which is exactly what made an installed card sit 4px
   shorter than an installable one in the same row. */
[data-wui='skillInstallDone'],
[data-wui='skillInstallBusy'] {
  box-sizing: border-box;
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

[data-wui='skillInstallDone'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

[data-wui='skillInstallBusy'] {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}

/* A failed install says why IN the card it belongs to: the reader pressed a button
   labelled with that skill's name, and a sentence anywhere else would leave them
   looking for which one failed. */
[data-wui='skillInstallError'] {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 16px;
}

/* Which directories the scan looked in — the answer to "I installed it, where did
   it go", and the difference between "no skills" and "no roots". */
[data-wui='skillRoots'] {
  margin: 0;
  padding: 0 2px;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 17px;
}

/* An empty list is a sentence, not an empty grid — and each of the three says
   which one it is, because "nothing installed" and "nothing matches" are
   different facts about a deployment. The marketplace's identity line is the
   same type, one step quieter, because it is a scope note rather than a state. */
[data-wui='skillNote'],
[data-wui='skillMarketNote'],
[data-wui='skillMarketIdentity'] {
  margin: 0;
  padding: 0 2px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

[data-wui='skillMarketIdentity'] {
  font-size: 12px;
  line-height: 18px;
}

/* The marketplace's failure: the plugins modal's own failure row, so one
   deployment's two modals report a bad read the same way. */
[data-wui='skillFailure'] {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}

[data-wui='skillFailure'] p {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

[data-wui='skillFailure'] button {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 4px 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}

[data-wui='skillFailure'] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The two sections are read differently — one is what this deployment HAS, the
   other what it COULD install — so the rule between them says so. */
[data-wui='skillDivider'] {
  flex: none;
  height: 1px;
  margin: 2px 0;
  background: var(--dsw-alias-border-l1);
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

/* ── action row ──────────────────────────────────────────────────────── */

/* One always-on strip of controls, at the conversation header's right and ABOVE
   its hairline.

   The line the reader pointed at is ui-conversation's own: the header paints a
   1px ::after at bottom: 1px, which lands at y=74 at this frame's header
   height (12px top padding + a 32px title row + a 27px tab row). The row is 26px
   tall at top 40px, so its bottom is 66px — all of it above the line, where
   before the Git control straddled it (52…78) and the panel toggles sat under it
   (88…114).

   All three offsets are custom properties, so a deployment can move or clear the
   row without touching these rules:
     --dsh-web-ui-bar-top     the row's top edge (default 40px)
     --dsh-web-ui-bar-right   its inset from the viewport's right edge (24px)
     --dsh-web-ui-bar-shift   space RESERVED to its right, added to the inset.
                              A docked panel that covers the corner (my-sider's
                              sidebar) writes this while it is open, so the whole
                              row steps clear rather than being buried — the row
                              is one unit, so Git moves with the toggles that
                              pushed it aside. */
[data-wui='actionBar'] {
  position: fixed;
  top: var(--dsh-web-ui-bar-top, 40px);
  right: calc(var(--dsh-web-ui-bar-right, 24px) + var(--dsh-web-ui-bar-shift, 0px));
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  /* The overlay layer as a whole is click-through, so a floating group must
     claim its own hits — and so must the peer controls it hosts. */
  pointer-events: auto;
  transition: right 180ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  [data-wui='actionBar'] { transition: none; }
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

/* The header's repository name, when the project holds more than one: the same
   text, made clickable. It carries no border and no background until hovered, so
   the header looks identical whether or not there is anything to switch to. */
[data-wui='gitRepoSwitch'] {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

[data-wui='gitRepoSwitch']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

[data-wui='gitRepoSwitch']:focus-visible {
  outline: 2px solid var(--dsh-web-ui-accent);
  outline-offset: 1px;
}

/* The switcher's rows: the name the header shows, with the path that tells two
   same-named packages apart under it. */
[data-wui='gitRepoOption'] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  text-align: left;
}

[data-wui='gitRepoOptionName'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-wui='gitRepoOptionPath'] {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
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
