// What a cache read, a cold re-write and a ping cost, and how those numbers are written down.
// List prices are facts; the shapes and wording here are WarmProof's own.

import { fmtCost, fmtTokens } from './extras'
import { conf } from './runtime'
import type { State } from './runtime'

/** Dollars per million tokens for one model family, as published in September 2026. */
export type Rates = { cacheRead: number; cacheWrite1h: number; output: number }

/**
 * Family rates, longest key first: a model id is matched by the first key it contains,
 * so `fable-5-1` cannot be swallowed by `fable-5`.
 */
const RATE_CARD: ReadonlyArray<readonly [string, Rates]> = [
  ['fable-5-1', { cacheRead: 0.25, cacheWrite1h: 20, output: 50 }],
  ['fable-5', { cacheRead: 1, cacheWrite1h: 20, output: 50 }],
  ['opus-5', { cacheRead: 0.5, cacheWrite1h: 10, output: 25 }],
  ['opus-4', { cacheRead: 0.5, cacheWrite1h: 10, output: 25 }],
  ['sonnet-5', { cacheRead: 0.2, cacheWrite1h: 4, output: 10 }],
  ['sonnet', { cacheRead: 0.3, cacheWrite1h: 6, output: 15 }],
  ['haiku', { cacheRead: 0.1, cacheWrite1h: 2, output: 5 }],
]

/** The rates for a model id, or null when the family is not one we have prices for. */
export function ratesFor(model: string | null): Rates | null {
  const id = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, rates] of RATE_CARD) {
    if (id.includes(family)) return rates
  }
  return null
}

/** `90m`, `3h`, `2h30m` in milliseconds; null when it is not a duration at all. */
export function parseDuration(text: string): number | null {
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!parts) return null
  const [, hours, minutes] = parts
  if (hours === undefined && minutes === undefined) return null
  return (Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60_000
}

/** Minutes as `45m`, hours as `3h00m`, and two days or more as `2d 3h`. */
export function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours === 0) return `${minutes}m`
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** Token counts for a human: `850`, `201k`, `1.4M`. */
export function fmtTok(n: number): string {
  return fmtTokens(n)
}

export function fmtUsd(usd: number | null): string {
  if (usd == null) return 'n/a'
  return '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

/** A price in whichever unit the options ask for: token counts by default, dollars on request. */
export function price(tokens: number, usd: number | null): string {
  return fmtCost(conf().costUnit, tokens, usd)
}

/** Dollars to re-write the whole context from cold. */
export function coldWriteUsd(s: State): number | null {
  const rates = ratesFor(s.lastModel)
  return rates ? (s.ctx * rates.cacheWrite1h) / 1e6 : null
}

/** Dollars for the same context read from a warm cache. */
export function warmReadUsd(s: State): number | null {
  const rates = ratesFor(s.lastModel)
  return rates ? (s.ctx * rates.cacheRead) / 1e6 : null
}

export type ForkUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * What one fork bills: the cached prefix it read, anything it had to write, its uncached
 * input at the base rate (half the one-hour write rate) and its own output.
 */
export function forkUsd(u: ForkUsage, rates: Rates): number {
  const read = u.cache_read_input_tokens * rates.cacheRead
  const written = u.cache_creation_input_tokens * rates.cacheWrite1h
  const fresh = (u.input_tokens * rates.cacheWrite1h) / 2
  const answered = u.output_tokens * rates.output
  return (read + written + fresh + answered) / 1e6
}

/**
 * How many cache-read pings fit inside the price of one cold re-write of the same context.
 * Null when the model is unpriced or there is no context to hold.
 */
export function pingsPerColdWrite(s: State): number | null {
  const rates = ratesFor(s.lastModel)
  if (!rates || s.ctx <= 0) return null
  return Math.floor(rates.cacheWrite1h / rates.cacheRead)
}
