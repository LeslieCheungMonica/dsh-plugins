/**
 * The product-card field's data source: the host's catalogue, fetched.
 *
 * The list itself is deployment data (which products this tenant builds), so it
 * lives on the host (`src/host/products.ts`) and this module is only the browser
 * half of that seam. It keeps the result SHAPE the dialog already renders — a
 * value or a reason — because the difference between "this deployment configured
 * no cards" and "the catalogue could not be read" is a difference the operator
 * needs to see.
 *
 * The card list arrives with the project record (one request per dialog), so
 * there is no separate round trip to keep in step: see `readProjectInfo` in
 * `larkapi.ts`.
 */

/** One product card an operator can attach a project to. */
export interface ProductCard {
  /** Stable id recorded with the project; the value the form submits. */
  readonly id: string
  /** What the operator sees in the dropdown. */
  readonly name: string
  /** Optional second line: a code, an owner, a stage. */
  readonly detail?: string
}

/** What one read of the card list produced. */
export type ProductCardResult =
  | { readonly ok: true; readonly cards: readonly ProductCard[] }
  | {
    readonly ok: false
    /** A real read/parse failure on the host; never "not configured". */
    readonly reason: 'failed'
    /** Detail for the dialog's own line; may be empty. */
    readonly message: string
  }
