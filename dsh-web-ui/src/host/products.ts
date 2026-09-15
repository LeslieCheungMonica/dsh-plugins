/**
 * The product-card catalogue: the products a project can be attached to.
 *
 * The New Project dialog asks what a project IS — a brand-new product, an
 * existing one, or not yet decided — and "an existing one" then asks WHICH card.
 * This module owns that list on the HOST side, because the browser half is a
 * page: it cannot read the operator's files, and a card list is deployment data
 * (which products this tenant builds), not something a page should invent.
 *
 * ## Where the cards come from
 *
 * The catalogue is configuration, in this order:
 *
 * 1. `DSH_WEB_UI_PRODUCT_CARDS` — a JSON array of `{ id, name, detail? }`, for a
 *    deployment that wants the list in its own environment;
 * 2. `products.json` beside the project records
 *    (`DSH_WEB_UI_PROJECTS_FILE`'s directory, else `~/.dsh/storages/`) — the
 *    file an operator can edit and version;
 * 3. nothing: an EMPTY catalogue, which the dialog renders as a first-class
 *    "no cards configured" state rather than an error. A deployment that has not
 *    filled this in is not broken — two of the three answers need no card.
 *
 * A malformed source is reported as a FAILURE, not as an empty list: "you have
 * no cards" and "your cards file is broken" are different operator problems, and
 * the second one silently degrading to the first is how a typo goes unnoticed for
 * a week.
 *
 * @module dsh-web-ui/host/products
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectsDirectory } from './projects.ts'

/** One product card an operator can attach a project to. */
export interface ProductCard {
  /** Stable id recorded with the project; the value the form submits. */
  readonly id: string
  /** What the operator sees in the dropdown. */
  readonly name: string
  /** Optional second line: a code, an owner, a stage. */
  readonly detail?: string
}

/** What one read of the catalogue produced. */
export type ProductCardResult =
  | { readonly ok: true; readonly cards: readonly ProductCard[] }
  | {
    readonly ok: false
    /** `failed` is a real read/parse failure; never "not configured". */
    readonly reason: 'failed'
    /** One line a human can act on. */
    readonly message: string
  }

/** Environment variable holding the catalogue inline, as JSON. */
const CARDS_ENV = 'DSH_WEB_UI_PRODUCT_CARDS'

/** File name of the catalogue, beside the project records. */
const CARDS_FILE = 'products.json'

/**
 * Narrow one raw card.
 * @param raw - the raw entry.
 * @returns the card, or undefined when it carries no usable id and name.
 */
function toCard(raw: unknown): ProductCard | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = record['id']
  const name = record['name']
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') return undefined
  const detail = record['detail']
  return typeof detail === 'string' && detail !== ''
    ? { id, name, detail }
    : { id, name }
}

/**
 * Narrow a parsed catalogue.
 *
 * Accepts both a bare array and `{ cards: [...] }`, because a file an operator
 * edits by hand grows a wrapper the moment it needs a version or a comment —
 * refusing the wrapped form would be a rule with no value.
 * @param parsed - the parsed document.
 * @returns the cards, or a failure sentence.
 */
function asCards(parsed: unknown): ProductCardResult {
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { cards?: unknown }).cards)
      ? (parsed as { cards: unknown[] }).cards
      : undefined
  if (rows === undefined) return { ok: false, reason: 'failed', message: 'the product-card catalogue must be an array of cards' }
  const cards = rows.flatMap((row) => {
    const card = toCard(row)
    return card === undefined ? [] : [card]
  })
  // A duplicate id would make the form's selection ambiguous, and the second one
  // unreachable; refusing loudly beats silently dropping a row.
  const ids = new Set(cards.map(card => card.id))
  if (ids.size !== cards.length) {
    return { ok: false, reason: 'failed', message: 'the product-card catalogue has duplicate ids' }
  }
  return { ok: true, cards }
}

/**
 * Read this deployment's product cards.
 * @returns the catalogue, or why it could not be read.
 */
export async function readProductCards(): Promise<ProductCardResult> {
  const inline = process.env[CARDS_ENV]
  if (inline !== undefined && inline.trim() !== '') {
    try {
      return asCards(JSON.parse(inline) as unknown)
    } catch {
      return { ok: false, reason: 'failed', message: `\`${CARDS_ENV}\` is not valid JSON` }
    }
  }

  // Beside the project records, wherever those were pinned: a deployment that
  // moved its records expects the catalogue to move with them, and a test that
  // pins one must not read the other from the operator's real home.
  const file = join(projectsDirectory(), CARDS_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // No catalogue configured: an empty one, not a failure. Two of the form's
    // three answers need no card, so this is a usable deployment.
    return { ok: true, cards: [] }
  }
  try {
    return asCards(JSON.parse(text) as unknown)
  } catch {
    return { ok: false, reason: 'failed', message: `${file} is not valid JSON` }
  }
}
