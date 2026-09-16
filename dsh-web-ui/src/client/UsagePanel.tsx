/**
 * The account drawer's Usage block: what the current Session has spent.
 *
 * ## Where the numbers come from
 *
 * Not from this component's own folding. DSH's `token-meter` host unit publishes
 * two session projections — `tokenUsage` (provider-reported usage accumulated
 * across the COMPLETE durable log, not the loaded window) and `contextPressure`
 * (the newest request's prompt size paired with the newest advertised capacity)
 * — and the client keeps finished whole values per key. A root-scope seat has no
 * `useProjection` seat (that hook is part of the session-scoped kit), but it does
 * not need one: the session LIST snapshot carries each session's projection
 * values (`SessionSummary.projectionValues`), so `useSessions` reads the very
 * same host-computed values, and the durable ones at that. Nothing here is
 * estimated, and paging or compaction cannot move a figure.
 *
 * ## What it deliberately does not show
 *
 * Composition (`contextBreakdown`: system / tools / messages) is heuristic by
 * its own definition — its three figures are priced at a fixed density and do
 * not sum to the pressured total — so it is left out rather than presented as
 * accounting. Cache savings in currency are left out too: a price table is a
 * deployment fact this plugin has no way to read, and a guessed rate would be
 * worse than no number.
 *
 * `formatTokens`, `formatDuration` and the occupancy arithmetic mirror the
 * shipped conversation footer (`ui-conversation`'s StatsLine) so the same figure
 * reads the same in both places. They are reproduced rather than imported: a
 * client bundle may not import another plugin's values (see tsdown.config.ts).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ShellProps } from './contract.ts'

/**
 * Composed props: the two shares this block reads off the column that renders
 * it. Narrowed from {@link ShellProps} rather than restated — and deliberately
 * not `PropsRuntime<'some.seat'>`, because this block is rendered BY the column
 * and not registered into a seat, so it promises no owner share to anybody and
 * takes only the `useSessions` feed it actually reads.
 */
export type UsagePanelProps = Pick<ShellProps, 'useSessions' | 't'>

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns rounded integer percent, or null when no input was billed.
 */
export function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100)
}

/** The occupancy reading the bar renders. */
export interface Occupancy {
  /** Rounded percent, clamped to 100 — the numerator is a reference, not a measurement. */
  percent: number
  /** What the next request's prompt would cost. */
  usedTokens: number
  /** The newest advertised route capacity. */
  contextWindow: number
}

/**
 * Approximate context occupancy, with the shipped footer's rounding and upper
 * clamp. The numerator prefers `projectedTokens` — the provider sample carried
 * forward over everything the surface gained or lost since — so a compaction
 * shows immediately instead of waiting for the next request to report usage; it
 * falls back to the bare sample for a log whose projection predates that field.
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy with its numerator and denominator, or null until both are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): Occupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

/** One labelled figure in the grid. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div data-wui="usageFigure" title={hint}>
      <span data-wui="usageFigureLabel">{label}</span>
      <span data-wui="usageFigureValue">{value}</span>
    </div>
  )
}

/**
 * Render the Usage block.
 *
 * Three states, and the empty one matters: a Session that has not billed a
 * single token (brand new, or every request failed) must say so rather than
 * render a grid of zeros, because zeros read as a measurement.
 * @param props - the global kit and the translator.
 * @returns the usage block.
 */
export function UsagePanel({ useSessions, t }: UsagePanelProps): ReactNode {
  const current = useSessions(state => state.current)
  const values = useSessions((state) => {
    const id = state.current
    return id === undefined ? undefined : state.byId[id]?.projectionValues
  })

  const usage = values?.tokenUsage
  const occupancy = useMemo(() => contextOccupancy(values?.contextPressure), [values?.contextPressure])
  const billed = usage === undefined ? 0 : billedInputTokens(usage)
  const output = usage?.outputTokens ?? 0
  const cacheHit = usage === undefined ? null : cacheHitPercent(usage)
  const active = billed > 0 || output > 0

  if (current === undefined) {
    return <p data-wui="usageNote">{t('usage.noSession')}</p>
  }
  if (!active) {
    return <p data-wui="usageNote">{t('usage.noUsage')}</p>
  }

  return (
    <div data-wui="usage">
      {occupancy === null
        ? <p data-wui="usageNote">{t('usage.noContext')}</p>
        : (
            <div data-wui="usageContext">
              <div data-wui="usageContextHead">
                <span>{t('usage.context')}</span>
                <span data-wui="usageContextFigures">
                  {t('usage.contextFigures', {
                    used: formatTokens(occupancy.usedTokens),
                    window: formatTokens(occupancy.contextWindow),
                  })}
                </span>
              </div>
              {/* The bar is decorated with its own number rather than replacing
                  it: the percentage is the fact, and a 2px arc is not a reading
                  anyone should have to measure. */}
              <div
                data-wui="usageBar"
                role="progressbar"
                aria-label={t('usage.context')}
                aria-valuenow={occupancy.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div data-wui="usageBarFill" style={{ width: `${occupancy.percent}%` }} />
              </div>
              <span data-wui="usageBarLabel">{t('usage.percent', { percent: occupancy.percent })}</span>
            </div>
          )}
      <div data-wui="usageGrid">
        <Figure
          label={t('usage.input')}
          value={formatTokens(billed)}
          hint={t('usage.input.hint', {
            uncached: formatTokens(usage?.uncachedInputTokens ?? 0),
            read: formatTokens(usage?.cacheReadTokens ?? 0),
            write: formatTokens(usage?.cacheWriteTokens ?? 0),
          })}
        />
        <Figure label={t('usage.output')} value={formatTokens(output)} hint={t('usage.output.hint')} />
        {cacheHit !== null && (
          <Figure
            label={t('usage.cacheHit')}
            value={t('usage.percent', { percent: cacheHit })}
            hint={t('usage.cacheHit.hint')}
          />
        )}
      </div>
      <p data-wui="usageFoot">{t('usage.scope')}</p>
    </div>
  )
}
