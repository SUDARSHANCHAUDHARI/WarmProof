// Everything WarmProof says about itself: the one-line state, the cold-send warning,
// the resume notice and the /warmproof card.

import { inWorkHours } from './extras'
import { coldWriteUsd, fmtDuration, fmtTok, fmtUsd, price, pingsPerColdWrite, ratesFor, warmReadUsd } from './money'
import { suggestWindowMs, summarise } from './policy'
import type { Report, ReportRow } from './policy'
import { BREAK_HISTORY_DAYS, CACHE_LIFE_MS, DAY_MS, conf } from './runtime'
import type { State } from './runtime'

/** The cache is cold once a full lifetime has passed with no request reading it. */
export function isCold(s: State, now: number): boolean {
  if (!s.lastRequestAt || s.compacted) return false
  return now - s.lastRequestAt >= CACHE_LIFE_MS
}

/** Is there enough context in play for a cold resume to be worth warning about? */
export function worthGuarding(s: State): boolean {
  return s.ctx >= conf().minContextTokens
}

/** What the next message will cost now that the cache has gone, said in the chosen unit. */
export function coldSendWarning(s: State, now: number): string {
  const gone = fmtDuration(now - s.lastRequestAt - CACHE_LIFE_MS)
  const tokens = s.ctx.toLocaleString('en-US')
  if (conf().costUnit === 'tokens') {
    return `the prompt cache went cold ${gone} ago. Sending this re-writes up to ${tokens} tokens ` +
      '(a warm turn would only have read them from the cache).'
  }
  const rates = ratesFor(s.lastModel)
  const rate = rates ? `$${rates.cacheWrite1h}/MTok` : 'the cache-write rate'
  const warm = warmReadUsd(s)
  const comparison = warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`
  return `the prompt cache went cold ${gone} ago. Sending this re-writes up to ${tokens} tokens ` +
    `at ${rate} = ${fmtUsd(coldWriteUsd(s))}${comparison}.`
}

/** The countdown shown when no window is on: what is left, and what losing it would cost. */
function cacheCountdown(s: State, now: number): string | undefined {
  if (!s.lastRequestAt || s.compacted || !worthGuarding(s)) return undefined
  const cost = price(s.ctx, coldWriteUsd(s))
  if (isCold(s, now)) return `cache cold · the next message re-writes ${cost}`
  return `cache ${fmtDuration(s.lastRequestAt + CACHE_LIFE_MS - now)} left · cold resume ${cost}`
}

/** When the next ping is due, or why none is coming yet. */
function nextPingNote(s: State, now: number): string {
  if (!s.lastRequestAt) return ' · waiting for the first turn'
  if (s.compacted) return ' · waiting for the first turn after compaction'
  if (isCold(s, now)) return ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
  return ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
}

function lastPingNote(s: State): string {
  if (!s.lastPing) return ''
  const dollars = conf().costUnit === 'usd' ? ' ' + fmtUsd(s.lastPing.usd) : ''
  return ` · last ping read ${fmtTok(s.lastPing.read)}${dollars}`
}

/** The single line the status area carries: stopped, armed, or just the countdown. */
export function stateLine(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return conf().showCountdown ? cacheCountdown(s, now) : undefined
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextPingNote(s, now)}${lastPingNote(s)}`
}

/** What a freshly armed window reports back. */
export function armedLine(s: State, now: number, windowMs: number): string {
  const held = fmtDuration(windowMs)
  if (isCold(s, now)) {
    return `keepwarm on for ${held}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  }
  return `keepwarm on for ${held}, a ping every ${fmtDuration(s.every)} of idle keeps the context read instead of re-written`
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/**
 * A resumed or forked session knows its own age before any turn runs. Seeds the state from
 * those fields and returns the line to log when the person is resuming into a cold cache.
 */
export function seedFromResume(s: State, fields: ResumeFields, now: number): string | null {
  if (fields.source !== 'resume' && fields.source !== 'fork') return null
  if (typeof fields.context_tokens === 'number' && fields.context_tokens > 0) s.ctx = fields.context_tokens
  if (typeof fields.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - fields.seconds_since_last_response * 1000
  }
  if (typeof fields.model === 'string') s.lastModel = fields.model
  s.compacted = false
  if (fields.prompt_cache_likely_expired !== true || !worthGuarding(s)) return null
  const usd = typeof fields.estimated_cache_write_usd === 'number' ? fields.estimated_cache_write_usd : coldWriteUsd(s)
  const amount = conf().costUnit === 'usd' ? `, about ${price(s.ctx, usd)}` : ''
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens${amount}. ` +
    '/clear and paste a summary if you only need the conclusions.'
}

/** How the lifetime was established, so you can tell a measurement from an assumption. */
function ttlNote(s: State): string {
  const life = s.shortTtl ? '5m' : '1h'
  const how = s.ttlSource === 'env' ? 'from the environment'
    : s.ttlSource === 'transcript' ? 'seen in the transcript'
    : s.ttlSource === 'model-switch' ? 'reported by a model switch'
    : 'assumed, not yet observed'
  return `${life} cache, ${how}`
}

function cacheRow(s: State, now: number): string {
  const ttl = ttlNote(s)
  if (s.compacted) return `compaction reset it, waiting for the first turn · ${ttl}`
  if (!s.lastRequestAt) return `nothing requested yet this session · ${ttl}`
  if (isCold(s, now)) return `gone, last request ${fmtDuration(now - s.lastRequestAt)} ago · ${ttl}`
  return `holding, ${fmtDuration(s.lastRequestAt + CACHE_LIFE_MS - now)} left · ${ttl}`
}

function windowRow(s: State, now: number): string {
  const everywhere = s.always ? ' (always)' : ''
  if (s.deadline) {
    const line = (stateLine(s, now) ?? '').replace(/^keepwarm /, 'on, ')
    return line + everywhere
  }
  if (s.stopped) return `stopped, ${s.stopped}${everywhere}`
  if (s.always) return `off until the next session start, which arms ${fmtDuration(conf().windowMs)} (always)`
  return `off (/keepwarm arms ${fmtDuration(conf().windowMs)})`
}

const label = (text: string) => text.padEnd(12)

/** The /warmproof card: where the cache stands, what it would cost, and what is holding it. */
export function card(s: State, now: number): string {
  const rows: string[] = [s.lastModel ?? 'model not seen yet']
  rows.push(label('cache') + cacheRow(s, now))
  rows.push(label('context') + `${s.ctx.toLocaleString('en-US')} tokens`)
  rows.push(label('if it goes') + (conf().costUnit === 'tokens'
    ? `${price(s.ctx, null)} re-written on the next message`
    : `${fmtUsd(coldWriteUsd(s))} to re-write, against ${fmtUsd(warmReadUsd(s))} warm`))
  rows.push(label('keepwarm') + windowRow(s, now))
  const budgetPings = pingsPerColdWrite(s)
  if (budgetPings != null) {
    rows.push(label('worth it') + `${budgetPings} pings cost one cold write, so about ${fmtDuration(budgetPings * s.every)} of idle pays for itself`)
  }
  rows.push(label('guard') + (s.guard === 'refuse'
    ? 'holds the first cold send (/warmproof guard warn to only price it)'
    : 'prices a cold send and lets it through (/warmproof guard refuse to be held once)'))
  const paidTokens = s.coldWrites.reduce((sum, write) => sum + write.tokens, 0)
  const paidUsd = s.coldWrites.reduce((sum, write) => sum + (write.usd ?? 0), 0)
  rows.push(label('paid here') + `${s.coldWrites.length} cold write${s.coldWrites.length === 1 ? '' : 's'}, ${price(paidTokens, paidUsd)}`)
  rows.push(label('hours') + (inWorkHours(new Date(now), conf()) ? 'inside working hours' : 'outside working hours') +
    (conf().afterHours === 'handoff' ? ', after which a handoff replaces the ping' : ''))
  if (s.notePath) rows.push(label('handoff') + s.notePath)
  rows.push(label('billing') + (s.billing === 'subscription'
    ? 'subscription, which is the one-hour cache'
    : `${s.billing}, billed per token on a 5-minute cache${conf().pingOnMeteredBilling ? ' (pinging anyway, as asked)' : ', so pings are off'}`))
  rows.push(label('project') + s.project + (s.project === 'auto' ? '' : ' (/warmproof project auto to reset)'))
  const learned = suggestWindowMs(s.breaks)
  rows.push(label('breaks') + `${s.breaks.length} logged over ${BREAK_HISTORY_DAYS} days` +
    (learned ? `, /keepwarm auto would hold ${fmtDuration(learned)}` : ''))
  return rows.join('\n')
}

const column = (text: string) => text.padEnd(13)

/**
 * What a ping costs in plan allowance, measured rather than guessed: the rise in each limit's
 * percentage across the pings on record. Nobody documents this, so the only honest source is
 * your own log. Omitted until there is a sample.
 */
function planCostLine(totals: Report): string[] {
  const measured = Object.entries(totals.planPerPing)
  if (!measured.length) return []
  const parts = measured
    .sort((a, b) => b[1] - a[1])
    .map(([kind, points]) => `${points.toFixed(1)}% of ${kind.replace(/_/g, '-')}`)
  return [column('plan cost') + `about ${parts.join(', ')} per ping, from your own log`]
}

/** The totals: what pinging cost, what it proved, and what got re-written anyway. */
export function reportFrom(rows: readonly ReportRow[], now: number, days: number): string {
  const totals = summarise(rows, now - days * DAY_MS)
  const causes = Object.entries(totals.causes).map(([cause, count]) => `${cause} ${count}`).join(', ') || 'none'
  return [
    `warmproof report, last ${days} day${days === 1 ? '' : 's'}`,
    column('pings') + `${totals.pings} (${totals.warmPings} warm), ${fmtTok(totals.pingSpend)} input-equivalent tokens spent`,
    column('proof') + `${totals.breakChecks} break checks: ${totals.proven} proven, ${totals.notProven} not proven`,
    column('kept') + `${fmtTok(totals.tokensKept)} tokens of context read from the cache after a proven break`,
    column('cold writes') + `${totals.coldWrites}, ${fmtTok(totals.coldTokens)} tokens re-written (causes: ${causes})`,
    column('held') + `${totals.compactionsHeld} idle compaction${totals.compactionsHeld === 1 ? '' : 's'} held during a window`,
    ...planCostLine(totals),
  ].join('\n')
}

/** One session of this profile, as /warmproof sessions lists it. */
export type SessionSketch = {
  sid: string
  folder: string
  lastTurnAt: number
  ctx: number
  deadline: number | null
  mine: boolean
}

function hhmm(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/** Folder, last turn, context and window for every session seen in the last day. */
export function sessionsFrom(sketches: readonly SessionSketch[], now: number): string {
  const lines = ['warmproof sessions, last 24h']
  for (const one of [...sketches].sort((a, b) => b.lastTurnAt - a.lastTurnAt)) {
    const window = one.deadline && one.deadline > now ? `window ${fmtDuration(one.deadline - now)} left` : 'no window'
    const turn = one.lastTurnAt ? `last turn ${hhmm(one.lastTurnAt)}` : 'no turn yet'
    const short = one.sid.split('-')[0] ?? one.sid
    lines.push(`${short}  ${one.folder}  ${turn}  ctx ${fmtTok(one.ctx)}  ${window}${one.mine ? '  (this one)' : ''}`)
  }
  return lines.join('\n')
}
