// What the session carries while it runs: the constants, the live options, the mutable record,
// and the pure conversions for the slice of it that must survive a hot reload.
//
// Nothing here touches the engine: the mod API requires every `$` call to stay in the file that
// receives it, so all of that lives in register.ts and everything testable lives out here.

import type { Runtime } from '../types'
import { readConfig } from './extras'
import type { Config } from './extras'
import type { Billing, TtlSource } from './policy'

/** The cache's idle lifetime on the one-hour bucket. */
export const CACHE_LIFE_MS = 60 * 60 * 1000
/** And on the five-minute one, which is what a metered or capped session gets. */
export const SHORT_CACHE_LIFE_MS = 5 * 60 * 1000
export const MINUTE_MS = 60 * 1000
/** A ping period below this is a typo, not an instruction. */
export const PING_FLOOR_MS = MINUTE_MS
/** How long `autoArmOnColdWrite` holds the cache after a re-write has been paid for. */
export const AFTER_COLD_WRITE_MS = 3 * 60 * MINUTE_MS
/** A ping with no answer by now is treated as lost, though it may still have been billed. */
export const PING_DEADLINE_MS = 2 * MINUTE_MS
/** How long a ping sent as a real turn is still expected to arrive through `turn.complete`. */
export const PING_TURN_WINDOW_MS = 3 * MINUTE_MS
/** A handoff is a real answer, so it gets longer than a ping. */
export const NOTE_DEADLINE_MS = 5 * MINUTE_MS
export const PHONE_POLL_MS = 20 * 1000
export const TICK_MS = MINUTE_MS
/** The transcript costs a host command to read, so it is re-read no more often than this. */
export const TTL_RECHECK_MS = 10 * MINUTE_MS
export const BREAK_HISTORY_DAYS = 14
export const DAY_MS = 86_400_000
/** Tool-less and one word long, so a ping reads the context and writes almost nothing. */
export const PING_PROMPT = 'Reply with the single word: warm'
/** Below this a context is too small for a re-write to be worth proving anything about. */
export const PROOF_FLOOR_TOKENS = 20_000
/** `evidenceMaxKb` is in kibibytes; an evidence file past that size is rolled over. */
export const KIB = 1024


/** Shared-store keys. The window is per session; everything else is per profile. */
export const SHARED = {
  always: 'always',
  guard: 'guard',
  bench: 'bench',
  leave: 'leave',
  digestWeek: 'digestWeek',
} as const
export const PER_SESSION = { deadline: 'deadline', every: 'every' } as const

let options: Config = readConfig({})

/** Called once by register() with the stored plugin options. */
export function loadConfig(raw: Parameters<typeof readConfig>[0]): Config {
  options = readConfig(raw)
  return options
}

/** The live options, read through a call so a hot reload cannot leave a stale copy behind. */
export function conf(): Config {
  return options
}

export type PhoneAction = 'warm2h' | 'compact' | 'leave'
export type PhoneToken = { action: PhoneAction; group: string; exp: number }
export type GuardMode = 'refuse' | 'warn'
export type ColdWrite = { at: number; tokens: number; usd: number | null }
export type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
export type Cancellable = { cancel: () => void }
export type ProjectPolicy = 'always' | 'auto' | 'never'

/** Where this profile keeps its files; all null when neither CLAUDE_CONFIG_DIR nor HOME is set. */
export type ProfilePaths = {
  ledger: string | null
  killSwitch: string | null
  projects: string | null
  notes: string | null
}

/** Every timer the session owns, so a stop can clear them without hunting through fields. */
export type Timers = {
  ping: Cancellable | null
  /** A proof run's own ping, which fires even where automatic pinging is off. */
  proof: Cancellable | null
  turnPing: Cancellable | null
  alert: Cancellable | null
  phone: Cancellable | null
  tick: Cancellable | null
}

export type State = {
  sid: string
  /** This instance's own log file name, without the folder or extension. */
  logName: string
  cwd: string
  version: string | null
  headless: boolean
  hasBand: boolean
  paths: ProfilePaths
  project: ProjectPolicy

  // What the cache is doing: the last request that read it, and what it holds.
  lastRequestAt: number
  lastModel: string | null
  effort: string | null
  ctx: number
  compacted: boolean
  shortTtl: boolean
  ttlSource: TtlSource
  ttlCheckedAt: number
  billing: Billing

  // The keep-warm window.
  deadline: number
  every: number
  always: boolean
  stopped: string | null
  fromBackground: boolean
  timers: Timers

  // Evidence for the proof: the last real turn, and what has been pinged since.
  lastTurnAt: number
  ctxAtTurn: number
  pingsSinceTurn: number
  /** Automatic pings only: a ping you asked for must not spend the idle cap. */
  autoPingsSinceTurn: number
  /** A `/warmproof prove` run is waiting for its verdict; the next break check is it. */
  proving: boolean
  /** A proof deliberately run on the five-minute bucket, which the usual gate would refuse. */
  provingFast: boolean
  /** The mechanism this proof run is testing, overriding the option for its own ping only. */
  proveVia: 'fork' | 'turn' | null
  /** When the once-a-minute tick last ran, so a sleeping Mac can be told from an idle one. */
  lastTickAt: number
  pingsThisTurn: number
  lastPing: PingRecord | null
  coldWrites: ColdWrite[]
  breaks: number[]

  // Turn bookkeeping.
  pinging: boolean
  /**
   * When a ping was sent as a real turn, the moment it was submitted. That turn arrives through
   * `turn.complete` like any other, where it has to be booked as a ping instead: counting it as
   * your own turn would reset the very break the ping was sent to carry, and no proof could ever
   * be written. Zero once that turn has landed, or once `PING_TURN_WINDOW_MS` has passed without
   * it, so a ping that never arrives cannot swallow a real turn later.
   */
  pingTurnAt: number
  turnRunning: boolean
  compactedSinceTurn: boolean
  prevTurnModel: string | null
  prevTurnEffort: string | null
  wakeAt: number | null

  // Guard, phone and notes.
  guard: GuardMode
  guardShownFor: number
  coldWritePending: boolean
  alertedFor: number
  phone: Map<string, PhoneToken>
  phoneSince: number
  notePath: string | null
  leaveSeen: string | null
}

export function freshState(): State {
  return {
    sid: '', logName: '', cwd: '', version: null, headless: false, hasBand: false,
    paths: { ledger: null, killSwitch: null, projects: null, notes: null }, project: 'auto',
    lastRequestAt: 0, lastModel: null, effort: null, ctx: 0, compacted: false,
    shortTtl: false, ttlSource: 'assumed', ttlCheckedAt: 0, billing: 'subscription',
    deadline: 0, every: conf().everyMs, always: false, stopped: null, fromBackground: false,
    timers: { ping: null, proof: null, turnPing: null, alert: null, phone: null, tick: null },
    lastTurnAt: 0, ctxAtTurn: 0, pingsSinceTurn: 0, autoPingsSinceTurn: 0, proving: false, provingFast: false, proveVia: null, lastTickAt: 0, pingsThisTurn: 0, lastPing: null, coldWrites: [], breaks: [],
    pinging: false, pingTurnAt: 0, turnRunning: false, compactedSinceTurn: false, prevTurnModel: null, prevTurnEffort: null, wakeAt: null,
    guard: 'refuse', guardShownFor: 0, coldWritePending: false, alertedFor: 0,
    phone: new Map(), phoneSince: 0, notePath: null, leaveSeen: null,
  }
}

/**
 * How long this session's cache actually lives. Reading it from the session rather than assuming
 * an hour is what lets a five-minute session show a true countdown — and what makes a proof on
 * the short bucket mean the same thing as one on the long bucket.
 */
export function cacheLifeMs(s: Pick<State, 'shortTtl'>): number {
  return s.shortTtl ? SHORT_CACHE_LIFE_MS : CACHE_LIFE_MS
}

/** Cancels one timer and forgets it. */
export function clearTimer(s: State, which: keyof Timers) {
  s.timers[which]?.cancel()
  s.timers[which] = null
}

/** A `/clear` keeps the process but starts a new conversation: nothing priced before it survives. */
export function forgetConversation(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.stopped = null
  s.guardShownFor = 0
  s.coldWritePending = false
  s.coldWrites = []
  s.notePath = null
  clearTimer(s, 'ping')
  clearTimer(s, 'alert')
}

/** The slice worth keeping across a reload. */
export function snapshotRuntime(s: State): Runtime {
  return {
    lastTurnAt: s.lastTurnAt,
    ctxAtTurn: s.ctxAtTurn,
    pingsSinceTurn: s.pingsSinceTurn,
    wakeAt: s.wakeAt,
    bgWindow: s.fromBackground,
    compactedSinceTurn: s.compactedSinceTurn,
    prevTurnModel: s.prevTurnModel,
    prevTurnEffort: s.prevTurnEffort,
    handoffPath: s.notePath,
    proving: s.proving,
    phone: [...s.phone].map(([token, held]) => [token, held] as [string, PhoneToken]),
    phoneSince: s.phoneSince,
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Puts a saved slice back. Returns true when phone buttons came back with it, so the caller
 * knows to start polling for taps again.
 */
export function applyRuntime(s: State, saved: Runtime | null): boolean {
  if (!saved || typeof saved !== 'object') return false
  s.lastTurnAt = numberOr(saved.lastTurnAt, 0)
  s.ctxAtTurn = numberOr(saved.ctxAtTurn, 0)
  s.pingsSinceTurn = numberOr(saved.pingsSinceTurn, 0)
  s.wakeAt = typeof saved.wakeAt === 'number' ? saved.wakeAt : null
  s.fromBackground = saved.bgWindow === true
  s.compactedSinceTurn = saved.compactedSinceTurn === true
  s.prevTurnModel = typeof saved.prevTurnModel === 'string' ? saved.prevTurnModel : null
  s.prevTurnEffort = typeof saved.prevTurnEffort === 'string' ? saved.prevTurnEffort : null
  s.notePath = typeof saved.handoffPath === 'string' ? saved.handoffPath : null
  s.proving = saved.proving === true
  s.phoneSince = numberOr(saved.phoneSince, 0)
  s.phone = new Map()
  for (const pair of saved.phone ?? []) {
    const [token, held] = pair
    if (typeof token === 'string' && held && typeof held.exp === 'number') s.phone.set(token, held)
  }
  // A turn that landed before the reload is still the clock the ping schedule hangs off.
  if (s.lastTurnAt > s.lastRequestAt) s.lastRequestAt = s.lastTurnAt
  if (s.ctxAtTurn > s.ctx) s.ctx = s.ctxAtTurn
  return s.phone.size > 0
}
