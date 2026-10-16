// The evidence log's shape: one JSON object per line in <profile>/warmproof/<session>.jsonl.
// Every row goes through a single writer in register.ts, so the log is never quieter than the
// spend. This file is what makes "the cache held" a measurement rather than a hope.

/** The four token counts a model call reports, in the API's own spelling. */
type Spend = { read: number; write: number; input: number; output: number }

/** Plan usage when a row was written, keyed by the limit's name. */
type PlanUsage = Record<string, number>

/** Did the pings hold the cache across a break, or did the next message pay for it? */
export type Verdict = 'extended' | 'not-extended'

export type LedgerRow =
  /** A real request of yours: what it read, what it re-wrote, and why when it re-wrote most. */
  | (Spend & {
    kind: 'turn'
    ctx: number
    model: string | null
    idleMin: number | null
    cause?: string
    limits?: PlanUsage
  })
  /** A keep-warm ping: whether the prefix survived, and what the ping itself cost. */
  | (Spend & {
    kind: 'ping'
    warm: boolean
    idleMin: number
    spend?: number
    limits?: PlanUsage
    during?: 'turn'
    /** Which mechanism sent it, when the A/B option is in use. */
    via?: 'fork' | 'turn'
  })
  /** The verdict on a break the pings were meant to carry. The point of the whole exercise. */
  | {
    kind: 'break-check'
    verdict: Verdict
    idleMin: number
    pings: number
    read: number
    write: number
    prevCtx: number
  }
  /** Anything WarmProof spent or sent, written by the wrapper that did it. */
  | {
    kind: 'request'
    via: 'fork' | 'turn' | 'compact' | 'http' | 'process'
    what: string
    ok: boolean
    timedOut?: boolean
    status?: number
    error?: string
    read?: number
    write?: number
    input?: number
    output?: number
  }
  /** A compaction, and whether a live window held it back. */
  | { kind: 'compact'; trigger: string; idle: boolean; blocked: boolean; ctx: number }
  /** The session opening: the build, the cache settings it starts with, and who pays for it. */
  | {
    kind: 'start'
    version: string | null
    ttlEnv: string | null
    subagentTtlEnv: string | null
    headless?: boolean
    cwd?: string
    project?: string
    billing?: string
  }
  /** A nudge sent before expiry, and down which channel. */
  | { kind: 'notify'; channel: 'phone' | 'desktop'; away: boolean | null }
  /** A button on a phone alert being tapped. */
  | { kind: 'phone'; action: string }
  /** An away plan this session adopted. */
  | { kind: 'leave'; until: string }
  /** The week a digest went out. */
  | { kind: 'digest'; week: string }
  /** The machine slept, so nothing could ping and no gap over it means anything. */
  | { kind: 'wake'; sleptMin: number; provingVoided: boolean }

/**
 * The proof, read from the first real request after a break the pings covered.
 *
 * It held only if that request read back most of the context standing before the break. Two
 * things say otherwise: re-writing half or more of that context, or reading back less than half
 * of it. Either way the pings failed, and the log records it rather than assuming success.
 */
export function breakVerdict(contextBefore: number, read: number, written: number): Verdict {
  const rewroteHalfOrMore = written >= 0.5 * contextBefore
  const readBackLessThanHalf = read < 0.5 * contextBefore
  return rewroteHalfOrMore || readBackLessThanHalf ? 'not-extended' : 'extended'
}
