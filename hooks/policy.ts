// Every decision WarmProof makes that does not need the engine: when a ping is pointless, what a
// re-write cost, why the cache went, which window your own habits justify. No `$` appears here, so
// each rule is exercised directly by the suite instead of through a mocked session.

const MINUTE = 60_000

// ---------- work the session is waiting on

/** A background task as the Stop hook reports it; only in-flight work is listed. */
export type BackgroundTask = { type: string; status?: string; command?: string; description?: string }

/**
 * Shells that are meant to outlive the turn. A dev server or a file watcher is not work the
 * session is waiting for, so it must not open a keep-warm window.
 */
const NEVER_FINISHES = /\b(dev|serve|server|start|watch|tail\s+-f|nodemon|vite|next\s+dev|webpack\s+serve|storybook|tsc\s+-w|jest\s+--watch|vitest(?!\s+run))\b/i

/** The work this session is genuinely waiting on: shells, subagents and workflows still going. */
export function pendingWork(tasks: readonly BackgroundTask[] | undefined): BackgroundTask[] {
  return (tasks ?? []).filter(task => {
    if (task.status && !/^(running|pending)$/i.test(task.status)) return false
    if (task.type === 'monitor') return false
    const isShell = task.type === 'shell'
    if (isShell && NEVER_FINISHES.test(`${task.command ?? ''} ${task.description ?? ''}`)) return false
    return isShell || task.type === 'subagent' || task.type === 'workflow'
  })
}

/**
 * A wake-up this session booked for itself (ScheduleWakeup, `/loop`) will read the cache on its
 * own. A ping before it is waste, so one is only wasted if the wake lands with room to spare.
 */
export function wakesItself(wakeAt: number | null, now: number, expiresAt: number, marginMs = 3 * MINUTE): boolean {
  if (wakeAt === null || wakeAt <= now) return false
  return wakeAt <= expiresAt - marginMs
}

// ---------- what things cost, in one comparable unit

/**
 * One call's spend as base-input-equivalent tokens, so a read, a write and an answer can be
 * added together: a cached read is a tenth of base input, a one-hour write is double it, and
 * output is five times it.
 */
export function spendTokens(usage: { read: number; write: number; input: number; output: number }): number {
  const read = usage.read * 0.1
  const written = usage.write * 2
  const answered = usage.output * 5
  return Math.round(read + written + usage.input + answered)
}

/** A local calendar day as YYYY-MM-DD; the key the daily budget is counted under. */
export function dayKey(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The store key for one session's spend on one day. Each session writes only its own key, so two
 * sessions renewing at the same moment cannot lose each other's update.
 */
export function spendKey(day: string, sessionId: string): string {
  return `spend:${day}:${sessionId}`
}

/** Everything every session of this profile has spent on the given day. */
export function sumSpend(day: string, entries: ReadonlyArray<readonly [string, unknown]>): number {
  const prefix = `spend:${day}:`
  let total = 0
  for (const [key, value] of entries) {
    if (key.startsWith(prefix) && typeof value === 'number') total += value
  }
  return total
}

/** Spend keys for days gone by, safe to drop: no session ever writes a past day again. */
export function staleSpendKeys(keys: readonly string[], today: Date, keepDays = 7): string[] {
  const oldest = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - keepDays))
  return keys.filter(key => key.startsWith('spend:') && (key.split(':')[1] ?? '') < oldest)
}

// ---------- why a context was re-written

export type ColdCause = 'session-start' | 'model-changed' | 'effort-changed' | 'compaction' | 'ttl-expired' | 'other'

/**
 * Why this turn had to re-write most of its context. The order matters: a cause that was always
 * going to break the prefix is reported ahead of the clock running out, so an expired cache is
 * never blamed for a model switch.
 */
export function coldCause(args: {
  hasPrevTurn: boolean
  prevModel: string | null
  model: string | null
  prevEffort?: string | null
  effort?: string | null
  compactedSince: boolean
  idleMs: number
  ttlMs: number
}): ColdCause {
  if (!args.hasPrevTurn) return 'session-start'
  if (args.prevModel && args.model && args.prevModel !== args.model) return 'model-changed'
  if (args.prevEffort && args.effort && args.prevEffort !== args.effort) return 'effort-changed'
  if (args.compactedSince) return 'compaction'
  if (args.idleMs >= args.ttlMs) return 'ttl-expired'
  return 'other'
}

// ---------- what the window commands mean

/**
 * `for 3h` or `until 18:00`, as a length in milliseconds from now. A time already past today
 * means tomorrow. Null when the words are not a window at all.
 */
export function windowFromWords(
  words: readonly string[],
  now: Date,
  parseDuration: (text: string) => number | null,
): number | null {
  const [verb, value = ''] = words
  if (verb === 'for') return parseDuration(value)
  if (verb !== 'until') return null
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!clock) return null
  const hour = Number(clock[1])
  const minute = Number(clock[2])
  if (hour > 23 || minute > 59) return null
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

// ---------- what the transcript says the cache really did

/**
 * The lifetime the main conversation last wrote with, read from the tail of a transcript: the
 * newest main-thread cache write, and which bucket it landed in. Side-chain rows are skipped,
 * since a subagent's write says nothing about your own cache. Null when no write is in view.
 */
export function ttlFromTail(tail: string): '1h' | '5m' | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"ephemeral_')) continue
    try {
      const row = JSON.parse(line) as {
        isSidechain?: boolean
        message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
      }
      if (row.isSidechain) continue
      const written = row.message?.usage?.cache_creation
      if (!written) continue
      if ((written.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
      if ((written.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
    } catch {
      // The first line of a tail is usually cut mid-object; keep walking backwards.
    }
  }
  return null
}

// ---------- plan limits

export type RateLimit = { kind: string; percentUsed: number }

/** Plan usage as a flat record, e.g. `{ five_hour: 42.1, seven_day: 12 }`. */
export function limitsOf(rateLimits: readonly RateLimit[] | undefined): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const limit of rateLimits ?? []) usage[limit.kind] = limit.percentUsed
  return usage
}

/** The limit closest to its ceiling, which is the one worth pausing for. Null when none is reported. */
export function peakPlanUsage(rateLimits: readonly RateLimit[] | undefined): RateLimit | null {
  let worst: RateLimit | null = null
  for (const limit of rateLimits ?? []) {
    if (!worst || limit.percentUsed > worst.percentUsed) worst = { kind: limit.kind, percentUsed: limit.percentUsed }
  }
  return worst
}

// ---------- reading the evidence back

/** One logged row, as the report reads it: a timestamp, a kind, and whatever that kind carries. */
export type ReportRow = { at: string; kind: string; [field: string]: unknown }

export type Report = {
  pings: number
  warmPings: number
  pingSpend: number
  /** Mean plan-usage points one ping costs, per limit, measured from the logged percentages. */
  planPerPing: Record<string, number>
  breakChecks: number
  proven: number
  notProven: number
  tokensKept: number
  coldWrites: number
  coldTokens: number
  causes: Record<string, number>
  compactionsHeld: number
}

/**
 * The totals over a stretch of evidence. Context counts as kept only where a break check proved
 * it was read back: without that proof it is an assumption, which is what this mod exists to avoid.
 */
/** Plan usage carried on a row, when it has any. */
function limitsOn(row: ReportRow): Record<string, number> | null {
  const limits = row.limits
  if (!limits || typeof limits !== 'object') return null
  const out: Record<string, number> = {}
  for (const [kind, used] of Object.entries(limits as Record<string, unknown>)) {
    if (typeof used === 'number') out[kind] = used
  }
  return Object.keys(out).length ? out : null
}

export function summarise(rows: readonly ReportRow[], sinceMs: number): Report {
  const report: Report = {
    pings: 0, warmPings: 0, pingSpend: 0, planPerPing: {},
    breakChecks: 0, proven: 0, notProven: 0, tokensKept: 0,
    coldWrites: 0, coldTokens: 0, causes: {}, compactionsHeld: 0,
  }
  // A ping's plan cost is the rise in usage since the row before it, so the walk must be ordered.
  const ordered = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const planRise: Record<string, { points: number; samples: number }> = {}
  let previousLimits: Record<string, number> | null = null
  for (const row of ordered) {
    if (Date.parse(row.at) < sinceMs) continue
    const number = (field: string) => (typeof row[field] === 'number' ? (row[field] as number) : 0)
    const limits = limitsOn(row)
    if (row.kind === 'ping' && limits && previousLimits) {
      for (const [kind, used] of Object.entries(limits)) {
        const before = previousLimits[kind]
        // Only a rise counts: a limit window that reset would otherwise read as a saving.
        if (typeof before === 'number' && used >= before) {
          const seen = planRise[kind] ?? { points: 0, samples: 0 }
          seen.points += used - before
          seen.samples += 1
          planRise[kind] = seen
        }
      }
    }
    if (limits) previousLimits = limits
    if (row.kind === 'ping') {
      report.pings++
      if (row.warm === true) report.warmPings++
      report.pingSpend += spendTokens({
        read: number('read'), write: number('write'), input: number('input'), output: number('output'),
      })
    } else if (row.kind === 'break-check') {
      report.breakChecks++
      if (row.verdict === 'extended') {
        report.proven++
        report.tokensKept += number('prevCtx')
      } else {
        report.notProven++
      }
    } else if (row.kind === 'turn' && typeof row.cause === 'string') {
      report.coldWrites++
      report.coldTokens += number('write')
      report.causes[row.cause] = (report.causes[row.cause] ?? 0) + 1
    } else if (row.kind === 'compact' && row.blocked === true) {
      report.compactionsHeld++
    }
  }
  for (const [kind, seen] of Object.entries(planRise)) {
    if (seen.samples > 0) report.planPerPing[kind] = seen.points / seen.samples
  }
  return report
}

// ---------- the phone

/** One ntfy action button: tapping it POSTs a single-use token to the reply topic. */
export function phoneAction(label: string, server: string, replyTopic: string, token: string) {
  return {
    action: 'http',
    label,
    url: `${server}/${replyTopic}`,
    method: 'POST',
    body: JSON.stringify({ warmproof: token }),
    clear: true,
  }
}

/** The tokens found in ntfy's polled output, which is one JSON message per line. */
export function tokensInReplies(text: string): string[] {
  const found: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const envelope = JSON.parse(line) as { event?: string; message?: string }
      if (envelope.event && envelope.event !== 'message') continue
      const payload = JSON.parse(envelope.message ?? '') as { warmproof?: unknown }
      if (typeof payload.warmproof === 'string') found.push(payload.warmproof)
    } catch {
      // Someone else's message, or not JSON at all. Not ours to read.
    }
  }
  return found
}

/**
 * Is a ping pointless because you are mid-sentence? Text in the prompt box means a real request
 * is seconds away, and that request will read the cache itself.
 */
export function typingNow(draft: string): boolean {
  return draft.trim().length > 0
}

/** A tool call a ping must never make: refused only for another loop, and only mid-ping. */
export function denyToolDuringPing(args: { enabled: boolean; pinging: boolean; agentId: string | undefined }): boolean {
  return args.enabled && args.pinging && args.agentId !== undefined
}

/**
 * Other sessions of this profile that are holding a window on the same folder. Two sessions
 * warming one folder ping the same lineage twice over, which is double spend for one cache.
 */
export function rivalsInFolder(
  sessions: ReadonlyArray<{ sid: string; folder: string; deadline: number | null }>,
  mine: { sid: string; folder: string },
  now: number,
): string[] {
  return sessions
    .filter(other => other.sid !== mine.sid && other.folder === mine.folder)
    .filter(other => other.deadline !== null && other.deadline > now)
    .map(other => other.sid)
}

/**
 * The session id a log file belongs to. A file is named `<session>-<instance>.jsonl`, because the
 * file API can only replace a whole file: two instances sharing one name would shred each other's
 * rows. A roll adds `.1`, and both suffixes come off here.
 */
export function sessionOfLogFile(name: string): string {
  return name
    .replace(/\.jsonl$/, '')
    .replace(/\.\d+$/, '')
    .replace(/-[0-9a-f]{8}$/, '')
}

// ---------- who is paying

/**
 * The backend behind this session. Only a subscription gets the one-hour cache; the rest bill per
 * token and cache for five minutes, where a 50-minute ping always arrives too late to read anything.
 */
export type Billing = 'subscription' | 'api-key' | 'relay' | 'bedrock' | 'vertex' | 'foundry'

/** Whether an environment variable is set to something meaning "on". */
function switchedOn(value: string | undefined): boolean {
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  return text !== '' && text !== '0' && text !== 'false'
}

/** The first backend the environment names, else a plain subscription session. */
export function billingMode(env: Readonly<Record<string, string | undefined>>): Billing {
  if (switchedOn(env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (switchedOn(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (switchedOn(env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  const base = (env.ANTHROPIC_BASE_URL ?? '').trim()
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/i.test(base)) return 'relay'
  if (switchedOn(env.ANTHROPIC_API_KEY) || switchedOn(env.ANTHROPIC_AUTH_TOKEN)) return 'api-key'
  return 'subscription'
}

/** How the cache lifetime in force was established, strongest first. */
export type TtlSource = 'env' | 'model-switch' | 'transcript' | 'assumed'

/**
 * Minutes the machine was asleep, inferred from a tick that arrived far later than its interval.
 * Timers do not run while a Mac sleeps, so a gap here is not idle time: nothing pinged, and any
 * cache that expired during it did so unattended. Null when the tick was merely late.
 */
export function sleptMinutes(lastTickAt: number, now: number, tickMs: number): number | null {
  if (!lastTickAt) return null
  const gap = now - lastTickAt
  // Two and a half intervals: late enough that a missed tick cannot explain it.
  if (gap < tickMs * 2.5) return null
  return Math.round(gap / 60_000)
}

// ---------- learning from your own breaks

/** The idle gaps between real turns, in minutes. Ten minutes or more counts as a break. */
export function breakMinutes(rows: readonly ReportRow[], sinceMs: number): number[] {
  const breaks: number[] = []
  for (const row of rows) {
    if (row.kind !== 'turn' || Date.parse(row.at) < sinceMs) continue
    const idle = row.idleMin
    if (typeof idle === 'number' && idle >= 10) breaks.push(idle)
  }
  return breaks
}

/**
 * A window long enough to cover most of your real long breaks: the 80th percentile of the breaks
 * over an hour, rounded up to the half hour and held between 1h and 12h. Null until three such
 * breaks exist, since two of them say nothing about a habit.
 */
export function suggestWindowMs(breaks: readonly number[]): number | null {
  const long = breaks.filter(minutes => minutes > 60).sort((a, b) => a - b)
  if (long.length < 3) return null
  const index = Math.min(long.length - 1, Math.ceil(0.8 * long.length) - 1)
  const percentile = long[index] ?? 60
  const rounded = Math.ceil(percentile / 30) * 30
  return Math.min(12 * 60, Math.max(60, rounded)) * MINUTE
}

/**
 * Is one more ping worth sending, `idleMin` into a break? A ping reads the context at a tenth of
 * base input and a rebuild writes it at double, so it pays while the chance of being back inside
 * the hour is better than one in twenty. Null — no opinion — until five breaks are on record.
 */
export function worthPinging(breaks: readonly number[], idleMin: number): boolean | null {
  if (breaks.length < 5) return null
  const stillAway = breaks.filter(minutes => minutes > idleMin)
  if (!stillAway.length) return false
  const backWithinTheHour = stillAway.filter(minutes => minutes <= idleMin + 60).length
  return backWithinTheHour / stillAway.length > 0.05
}

/**
 * The ping period this session's own history justifies, in minutes.
 *
 * 50 minutes is a guess with a ten-minute margin. Pings that keep holding say the margin is
 * bigger than it needs to be, so the period creeps later and each idle stretch costs fewer
 * pings. A single miss is the expensive outcome, so one pulls the period back hard and the
 * creep starts again from there. Null while there is too little history to argue with.
 */
export function learnedEveryMinutes(
  pings: ReadonlyArray<{ warm: boolean; idleMin: number }>,
  current: number,
  ceiling = 55,
  floor = 20,
): number | null {
  const recent = pings.slice(-8)
  if (recent.length < 4) return null
  const missed = recent.filter(ping => !ping.warm)
  if (missed.length) {
    // Back off to well inside the shortest idle that still missed.
    const earliest = Math.min(...missed.map(ping => ping.idleMin))
    return Math.max(floor, Math.min(current, earliest - 10))
  }
  if (recent.every(ping => ping.warm)) return Math.min(ceiling, current + 2)
  return null
}

// ---------- at the Mac, or away

/** Seconds since the last keyboard or mouse event, from `ioreg -c IOHIDSystem -d 4`. */
export function parseIdleSeconds(ioregOutput: string): number | null {
  const found = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput)
  if (!found) return null
  // HIDIdleTime counts nanoseconds.
  return Math.floor(Number(found[1]) / 1e9)
}

/** Text made safe to sit inside a double-quoted AppleScript string. */
export function appleScriptString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
}

// ---------- per-folder policy

export type ProjectPolicy = 'always' | 'auto' | 'never'

/**
 * The policy for a folder: the longest configured path containing it wins, so a setting on one
 * project is not overruled by a broader one above it. `auto` when nothing covers it.
 */
export function projectPolicy(saved: Readonly<Record<string, unknown>>, cwd: string): ProjectPolicy {
  let deepest = ''
  let chosen: ProjectPolicy = 'auto'
  for (const [path, value] of Object.entries(saved)) {
    const folder = path.replace(/\/+$/, '')
    const contains = cwd === folder || cwd.startsWith(`${folder}/`)
    const known = value === 'always' || value === 'auto' || value === 'never'
    if (contains && known && folder.length > deepest.length) {
      deepest = folder
      chosen = value
    }
  }
  return chosen
}

// ---------- the weekly digest

/** The Monday opening the local week of `at`, as YYYY-MM-DD: one digest per week key. */
export function weekKey(at: Date): string {
  const sinceMonday = (at.getDay() + 6) % 7
  const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate() - sinceMonday)
  return dayKey(monday)
}

/**
 * Is a digest due? Once the chosen weekday and time have passed in a week whose digest has not
 * gone out yet — including later in that week, so a machine that was asleep on the day still
 * sends one when it wakes.
 */
export function digestDue(at: Date, lastWeekSent: string | null, weekday: number, minuteOfDay: number): boolean {
  if (lastWeekSent === weekKey(at)) return false
  const todayFromMonday = (at.getDay() + 6) % 7
  const targetFromMonday = (weekday + 6) % 7
  if (todayFromMonday !== targetFromMonday) return todayFromMonday > targetFromMonday
  return at.getHours() * 60 + at.getMinutes() >= minuteOfDay
}
