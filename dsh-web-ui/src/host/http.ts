/**
 * The HTTP plumbing this plugin's route modules share.
 *
 * Every route this plugin registers answers one of two things: a domain value,
 * or a bounded JSON request body. Three route modules writing those four
 * helpers each would be three places to fix the next time the envelope, the
 * cache header, or the body cap moves — so they live here, and the modules that
 * serve git and the terminal both import them. (`src/host/routes.ts` predates
 * this file and keeps its own copies plus the Lark-specific outcome projection
 * it needs; leaving it alone was the smaller change.)
 *
 * @module dsh-web-ui/host/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
/** Content type of every JSON response this plugin writes. */
export const JSON_TYPE = 'application/json; charset=utf-8'

/** Largest request body these routes will read, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - the value to serialize.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    // These routes answer questions about state that changes on the next click;
    // a cached answer would show the tree before the button was pressed.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Answer a request whose method this route does not accept.
 * @param res - the response.
 * @param allow - the method it does accept.
 */
export function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

/**
 * Read the query string of a request.
 * @param req - the request.
 * @returns the parsed parameters (a malformed URL yields an empty set).
 */
export function query(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * Read one query parameter, treating an empty string as absent.
 * @param params - the parsed query.
 * @param key - the parameter name.
 * @returns the value, or undefined.
 */
export function param(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)
  return value === null || value === '' ? undefined : value
}

/**
 * Read a JSON request body under a hard byte cap.
 * @param req - the request.
 * @returns the parsed value, or a sentence describing why it could not be read.
 */
export async function readJsonBody(req: IncomingMessage): Promise<
  { ok: true; value: unknown } | { ok: false; message: string }
> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    // Refused without being read to the end: a stuck or hostile client must not
    // be able to grow the host's heap through this route.
    if (size > MAX_BODY_BYTES) return { ok: false, message: `the request body exceeds ${String(MAX_BODY_BYTES)} bytes` }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: false, message: 'the request body is empty' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, message: 'the request body is not valid JSON' }
  }
}

/**
 * Narrow a value to a JSON object.
 * @param value - the parsed body.
 * @returns the record, or a sentence describing what it should have been.
 */
export function asRecord(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'the body must be a JSON object' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}
