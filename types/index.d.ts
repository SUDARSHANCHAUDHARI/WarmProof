// The one slice of WarmProof's session state that is kept in host state.
//
// Module variables start over when these hooks are reloaded, which would lose exactly the facts
// the proof rests on: when your last real turn was, how large the context was then, and how many
// pings have gone out since. Those live here, so a reload cannot quietly reset the evidence.
// Everything else is cheap to rebuild and is deliberately not persisted.

/** One live phone button: what it does, which alert issued it, when it stops counting. */
export type PhoneToken = {
  /** Hold the cache two more hours, compact it now, or let it cool. */
  action: 'warm2h' | 'compact' | 'leave'
  /** The alert it came from. The first tap spends the whole group, so no button acts twice. */
  group: string
  /** Epoch ms it expires, which is when the cache it speaks for would expire. */
  exp: number
}

/** What survives a reload of these modules. */
export type Runtime = {
  /** Epoch ms of your last real turn: the clock every break is measured from. */
  lastTurnAt: number
  /** Context size at that turn, which the next request is compared against. */
  ctxAtTurn: number
  /** Pings sent since then; a break with none of them proves nothing either way. */
  pingsSinceTurn: number
  /** A wake-up this session booked, which will read the cache without any help. */
  wakeAt: number | null
  /** Whether the open window was opened by background work rather than by you. */
  bgWindow: boolean
  /** Whether a compaction landed since that turn, which would explain a re-write. */
  compactedSinceTurn: boolean
  /** That turn's model and effort, so a change of either can be named as a cause. */
  prevTurnModel: string | null
  prevTurnEffort: string | null
  /** The note already written for this session, so one break writes only one handoff. */
  handoffPath: string | null
  /** Whether a /warmproof prove run is still waiting for its verdict. */
  proving?: boolean
  /** Live phone buttons as pairs, with the poll cursor they were last read at. */
  phone: Array<[string, PhoneToken]>
  phoneSince: number
}

declare module 'claude-code' {
  interface PluginState {
    warmproof: {
      runtime: Runtime | null
    }
  }
}
