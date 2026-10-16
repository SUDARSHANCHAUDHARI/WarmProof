// The options as the engine receives them, turned into values the rest of WarmProof can trust:
// every number clamped to a usable range, every choice narrowed to the ones that exist. Also the
// small shared conversions — a clock string, a token count, a cost, the profile folder — and the
// shape of an ntfy publish.
//
// Nothing here touches `$`, so every rule in this file is testable on its own.

import type { PluginOptions } from 'claude-code'

export type CostUnit = 'tokens' | 'usd'
export type AfterHours = 'handoff' | 'keep-pinging'
export type EndOfWindow = 'nothing' | 'compact' | 'handoff'
/** How a ping reaches the model: a side request, or a real turn as other keep-warm tools do. */
export type PingVia = 'fork' | 'turn'

/** Milliseconds in a minute. Options are written in minutes and hours; the engine works in ms. */
const MINUTE = 60_000

/** Every option, resolved: durations in milliseconds, clock times in minutes past midnight. */
export type Config = {
  costUnit: CostUnit
  windowMs: number
  everyMs: number
  minContextTokens: number
  workStart: number
  workEnd: number
  workdaysOnly: boolean
  afterHours: AfterHours
  handoff: boolean
  ntfyServer: string
  ntfyTopic: string
  alertMs: number
  blockIdleCompaction: boolean
  autoArmOnColdWrite: boolean
  maxPingsPerIdle: number
  warmDuringBackgroundWork: boolean
  backgroundWarmMs: number
  endOfWindow: EndOfWindow
  compactMinTokens: number
  dailyPingBudget: number
  ntfyReplyTopic: string
  showCountdown: boolean
  pingSubagentTtl1h: boolean
  warmDuringLongTurns: boolean
  desktopNotify: boolean
  awayMs: number
  pingOnlyIfWorthIt: boolean
  weeklyDigest: boolean
  digestWeekday: number
  digestMinute: number
  followLeave: boolean
  pingOnMeteredBilling: boolean
  pauseAbovePlanPercent: number
  evidenceMaxKb: number
  denyToolsDuringPing: boolean
  adaptPingPeriod: boolean
  pingVia: PingVia
}

/** What a session is asked to summarise when the working day ends with the cache still warm. */
export const HANDOFF_PROMPT = `Write the note a new session would need tomorrow to continue this work without reading the transcript. Markdown, brief, no preamble, under these headings exactly:
## Where this stands
## What was decided, and why
## Still open
## Start here next
## Files that matter (path:line)
## Commands and setup worth knowing`

/**
 * "HH:MM" as minutes past midnight, or `fallback` when it is not a time in range.
 * Midnight through 24:00 is accepted; 24:00 means the end of the day.
 */
export function parseClock(text: string, fallback: number): number {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!parts) return fallback
  const hours = Number(parts[1])
  const minutes = Number(parts[2])
  if (minutes > 59) return fallback
  const total = hours * 60 + minutes
  return total <= 24 * 60 ? total : fallback
}

/** One stored option, or the default when it is absent or of the wrong kind. */
function given<T extends string | number | boolean>(options: PluginOptions, key: string, fallback: T): T {
  const stored = options[key]
  return (typeof stored === typeof fallback ? stored : fallback) as T
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** One of `allowed`, else the first of them. */
function oneOf<T extends string>(options: PluginOptions, key: string, allowed: readonly [T, ...T[]]): T {
  const stored = given<string>(options, key, allowed[0])
  return allowed.find(choice => choice === stored) ?? allowed[0]
}

export function readConfig(options: PluginOptions): Config {
  const minutes = (key: string, fallback: number, low = 0, high = Number.MAX_SAFE_INTEGER) =>
    clamp(given(options, key, fallback), low, high) * MINUTE
  const hours = (key: string, fallback: number, low = 1, high = 24) =>
    clamp(given(options, key, fallback), low, high) * 60 * MINUTE
  const tokens = (key: string, fallback: number) => Math.max(0, given(options, key, fallback))

  return {
    costUnit: oneOf(options, 'costUnit', ['tokens', 'usd']),
    windowMs: hours('windowHours', 6, 1, 24),
    // Never at or past the hour: a ping that lands after the cache has gone only re-writes it.
    everyMs: minutes('pingEveryMinutes', 50, 1, 55),
    minContextTokens: tokens('minContextTokens', 50_000),
    workStart: parseClock(given(options, 'workStart', '09:00'), 9 * 60),
    workEnd: parseClock(given(options, 'workEnd', '18:30'), 18 * 60 + 30),
    workdaysOnly: given(options, 'workdaysOnly', true),
    afterHours: oneOf(options, 'afterHours', ['handoff', 'keep-pinging']),
    handoff: given(options, 'handoff', true),
    ntfyServer: given(options, 'ntfyServer', 'https://ntfy.sh').replace(/\/+$/, ''),
    ntfyTopic: given(options, 'ntfyTopic', '').trim(),
    alertMs: minutes('alertMinutes', 5, 0, 30),
    blockIdleCompaction: given(options, 'blockIdleCompaction', true),
    autoArmOnColdWrite: given(options, 'autoArmOnColdWrite', false),
    maxPingsPerIdle: clamp(given(options, 'maxPingsPerIdle', 8), 1, 24),
    warmDuringBackgroundWork: given(options, 'warmDuringBackgroundWork', false),
    backgroundWarmMs: hours('backgroundWarmHours', 3, 1, 12),
    endOfWindow: oneOf(options, 'endOfWindow', ['nothing', 'compact', 'handoff']),
    compactMinTokens: tokens('compactMinTokens', 200_000),
    dailyPingBudget: tokens('dailyPingBudget', 1_000_000),
    ntfyReplyTopic: given(options, 'ntfyReplyTopic', '').trim(),
    showCountdown: given(options, 'showCountdown', true),
    pingSubagentTtl1h: given(options, 'pingSubagentTtl1h', false),
    warmDuringLongTurns: given(options, 'warmDuringLongTurns', false),
    desktopNotify: given(options, 'desktopNotify', false),
    awayMs: minutes('awayMinutes', 5, 1, 120),
    pingOnlyIfWorthIt: given(options, 'pingOnlyIfWorthIt', false),
    weeklyDigest: given(options, 'weeklyDigest', false),
    digestWeekday: clamp(Math.round(given(options, 'digestWeekday', 1)), 0, 6),
    digestMinute: parseClock(given(options, 'digestTime', '09:30'), 9 * 60 + 30),
    followLeave: given(options, 'followLeave', true),
    // A metered backend caches for five minutes, so a 50-minute ping always arrives too late.
    pingOnMeteredBilling: given(options, 'pingOnMeteredBilling', false),
    pauseAbovePlanPercent: clamp(given(options, 'pauseAbovePlanPercent', 0), 0, 100),
    evidenceMaxKb: Math.max(0, given(options, 'evidenceMaxKb', 1024)),
    denyToolsDuringPing: given(options, 'denyToolsDuringPing', true),
    adaptPingPeriod: given(options, 'adaptPingPeriod', false),
    pingVia: oneOf(options, 'pingVia', ['fork', 'turn']),
  }
}

/** Is this moment inside the working day? Local wall clock, weekends out unless allowed. */
export function inWorkHours(at: Date, cfg: Pick<Config, 'workStart' | 'workEnd' | 'workdaysOnly'>): boolean {
  const weekday = at.getDay()
  if (cfg.workdaysOnly && (weekday === 0 || weekday === 6)) return false
  const sinceMidnight = at.getHours() * 60 + at.getMinutes()
  return sinceMidnight >= cfg.workStart && sinceMidnight < cfg.workEnd
}

/** A token count a person can read at a glance: `850`, `201k`, `1.4M`. */
export function fmtTokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`
  return String(count)
}

/** The same amount in whichever unit was asked for: tokens moved, or list-price dollars. */
export function fmtCost(unit: CostUnit, tokens: number, usd: number | null): string {
  if (unit === 'tokens') return `${fmtTokens(tokens)} tokens`
  if (usd == null) return 'n/a'
  return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`
}

/** This profile's folder: CLAUDE_CONFIG_DIR when it is set, otherwise ~/.claude. */
export function configDir(configured: string | undefined, home: string | undefined): string | null {
  const explicit = configured?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const base = home?.trim()
  return base ? `${base.replace(/\/+$/, '')}/.claude` : null
}

/** The last segment of a path: all that ever leaves the machine, since a topic may be public. */
export function folderName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

// A topic goes straight into a URL, so only characters that are safe there are allowed.
const SAFE_TOPIC = /^[A-Za-z0-9_-]{1,64}$/

/** Can a phone alert go out? Only with a topic that is safe to put in a URL. */
export function ntfyReady(cfg: Pick<Config, 'ntfyTopic'>): boolean {
  return SAFE_TOPIC.test(cfg.ntfyTopic)
}

/** Can the alert carry buttons? Only with a second, different topic for the replies. */
export function ntfyButtonsReady(cfg: Pick<Config, 'ntfyTopic' | 'ntfyReplyTopic'>): boolean {
  return ntfyReady(cfg) && SAFE_TOPIC.test(cfg.ntfyReplyTopic) && cfg.ntfyReplyTopic !== cfg.ntfyTopic
}

/**
 * One ntfy publish: a JSON POST to the server root. Sent through `$.http.fetch` so an
 * organisation's own web policy still applies to it. Null when no topic is configured.
 */
export function ntfyRequest(
  cfg: Pick<Config, 'ntfyServer' | 'ntfyTopic'>,
  title: string,
  message: string,
  actions: readonly object[] = [],
): { url: string; body: string } | null {
  if (!ntfyReady(cfg)) return null
  const payload = {
    topic: cfg.ntfyTopic,
    title,
    message,
    tags: ['snowflake'],
    ...(actions.length ? { actions } : {}),
  }
  return { url: cfg.ntfyServer, body: JSON.stringify(payload) }
}
