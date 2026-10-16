// Where WarmProof meets Claude Code. Every call that touches the engine lives in this file,
// because the mod API follows `$` only within the file it was handed to. The decisions,
// formatting and state shapes live in the pure modules beside it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register } from 'claude-code'

import type { Runtime } from '../types'
import { HANDOFF_PROMPT, configDir, folderName, inWorkHours, ntfyButtonsReady, ntfyReady, ntfyRequest } from './extras'
import { breakVerdict } from './ledger'
import type { LedgerRow } from './ledger'
import { fmtDuration, fmtTok, fmtUsd, forkUsd, parseDuration, pingsPerColdWrite, ratesFor } from './money'
import {
  appleScriptString, billingMode, breakMinutes, coldCause, dayKey, denyToolDuringPing, digestDue, limitsOf, parseIdleSeconds,
  peakPlanUsage, pendingWork, phoneAction, projectPolicy, spendKey, spendTokens, staleSpendKeys,
  learnedEveryMinutes, rivalsInFolder, sessionOfLogFile, sleptMinutes, suggestWindowMs, sumSpend, tokensInReplies, ttlFromTail, typingNow, wakesItself, weekKey,
  windowFromWords,
  worthPinging,
} from './policy'
import type { BackgroundTask, ReportRow } from './policy'
import {
  AFTER_COLD_WRITE_MS, BREAK_HISTORY_DAYS, CACHE_LIFE_MS, DAY_MS, KIB, NOTE_DEADLINE_MS, PER_SESSION,
  SHORT_CACHE_LIFE_MS, cacheLifeMs,
  PHONE_POLL_MS, PING_DEADLINE_MS, PING_FLOOR_MS, PING_PROMPT, PING_TURN_WINDOW_MS, PROOF_FLOOR_TOKENS, SHARED, TICK_MS,
  TTL_RECHECK_MS, applyRuntime, clearTimer, conf, forgetConversation, freshState, loadConfig, snapshotRuntime,
} from './runtime'
import type { PhoneAction, State } from './runtime'
import { markGlyph, markInk, markSvg } from './status-icons'
import type { CacheMark } from './status-icons'
import {
  armedLine, card, coldSendWarning, exportFrom, isCold, reportFrom, seedFromResume, sessionsFrom, stateLine,
  worthGuarding,
} from './views'
import type { SessionSketch } from './views'

// The host-state slot the reload-surviving slice lives in. The validator reads `atom` only in the
// file that calls update/read on it, so it is declared here rather than beside the State it mirrors.
const runtimeSlot = atom({ plugin: 'warmproof', key: 'runtime' } as const, null)

// ---------- the evidence log, and the four ways to spend anything

/**
 * Appends one evidence row, stamped with the moment it happened. No profile folder, no log.
 * Past `evidenceMaxKb` the file is rolled into `<session>.1.jsonl` so a long session cannot
 * grow without limit; the roll keeps one generation, and the older one is overwritten.
 */
async function note($: EngineInterface, s: State, row: LedgerRow): Promise<void> {
  if (!s.paths.ledger) return
  const path = `${s.paths.ledger}/${s.logName}.jsonl`
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...row }) + '\n'
  try {
    let existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const limit = conf().evidenceMaxKb * KIB
    if (limit > 0 && existing.length >= limit) {
      await $.fs.write(`${s.paths.ledger}/${s.logName}.1.jsonl`, existing)
      existing = ''
    }
    await $.fs.write(path, existing + line)
  } catch {
    // A log that cannot be written must not take the session down with it.
  }
}

function because(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Fork = Awaited<ReturnType<EngineInterface['model']['fork']>>

/**
 * A side request to the model, raced against `deadlineMs`. 'lost' means the deadline won:
 * the request may still have been billed, which is why that case is logged too.
 */
async function askModel($: EngineInterface, s: State, prompt: string, what: string, deadlineMs: number): Promise<Fork | 'lost'> {
  let countdown: { cancel: () => void } | undefined
  const lost = new Promise<'lost'>(resolve => {
    countdown = $.clock.after(deadlineMs, () => resolve('lost'))
  })
  let outcome: Fork | 'lost'
  try {
    outcome = await Promise.race([$.model.fork({ prompt }), lost])
  } catch (err) {
    await note($, s, { kind: 'request', via: 'fork', what, ok: false, error: because(err) })
    throw err
  } finally {
    countdown?.cancel()
  }
  const answered = outcome !== 'lost' && outcome !== null && outcome.isAnswered !== false
  const usage = outcome !== 'lost' && outcome && 'usage' in outcome ? outcome.usage : undefined
  await note($, s, {
    kind: 'request', via: 'fork', what, ok: answered, timedOut: outcome === 'lost',
    ...(usage
      ? {
        read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens,
        input: usage.input_tokens, output: usage.output_tokens,
      }
      : {}),
  })
  return outcome
}

/** A ping sent as a real turn. Logged like any other spend. */
async function askModelTurn($: EngineInterface, s: State, text: string, what: string) {
  try {
    const result = await $.prompt.submit({ text })
    await note($, s, { kind: 'request', via: 'fork', what: `${what} (as a turn)`, ok: true })
    return result
  } catch (err) {
    await note($, s, { kind: 'request', via: 'fork', what: `${what} (as a turn)`, ok: false, error: because(err) })
    throw err
  }
}

/** A compaction WarmProof asked for itself. */
async function askCompact($: EngineInterface, s: State, what: string) {
  try {
    const result = await $.session.compact({})
    await note($, s, { kind: 'request', via: 'compact', what, ok: !('skip' in result && Boolean(result.skip)) })
    return result
  } catch (err) {
    await note($, s, { kind: 'request', via: 'compact', what, ok: false, error: because(err) })
    throw err
  }
}

/** A host command. Only its exit code is logged, never its output. */
async function askHost($: EngineInterface, s: State, argv: readonly string[], what: string) {
  try {
    const result = await $.process.run(argv, { timeoutMs: 10_000 })
    await note($, s, { kind: 'request', via: 'process', what, ok: result.exitCode === 0, status: result.exitCode })
    return result
  } catch (err) {
    await note($, s, { kind: 'request', via: 'process', what, ok: false, error: because(err) })
    throw err
  }
}

/** A network request. Only the status is logged, never the body. */
async function askWeb($: EngineInterface, s: State, url: string, init: HttpInit | undefined, what: string) {
  try {
    const result = await $.http.fetch(url, init)
    await note($, s, { kind: 'request', via: 'http', what, ok: result.ok, status: result.status })
    return result
  } catch (err) {
    await note($, s, { kind: 'request', via: 'http', what, ok: false, error: because(err) })
    throw err
  }
}

// ---------- state that outlives a reload, and the profile's own files

async function keepRuntime($: EngineInterface, s: State) {
  try {
    await update($, runtimeSlot, () => snapshotRuntime(s))
  } catch {
    // Two timers can save in the same instant and one loses the race. This slice only has to
    // survive a reload, and the next save rewrites all of it, so a lost write costs nothing.
  }
}

async function recoverRuntime($: EngineInterface, s: State): Promise<boolean> {
  let saved: Runtime | null = null
  try {
    saved = await read($, runtimeSlot)
  } catch {
    return false
  }
  return applyRuntime(s, saved)
}

async function readProjects($: EngineInterface, s: State): Promise<Record<string, unknown>> {
  if (!s.paths.projects || !(await $.fs.exists(s.paths.projects))) return {}
  try {
    const parsed = JSON.parse(await $.fs.read(s.paths.projects)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const deadlineKey = (sid: string) => `${PER_SESSION.deadline}:${sid}`
const everyKey = (sid: string) => `${PER_SESSION.every}:${sid}`

/**
 * Drops this session's window keys when the deadline they name has passed, plus the bare keys an
 * older store still holds. Other sessions' keys are left alone: a read then a delete cannot be
 * made atomic against their renewal.
 */
async function dropDeadWindows($: EngineInterface, s: State, now: number) {
  for (const key of [PER_SESSION.deadline, deadlineKey(s.sid)]) {
    const saved = await $.store.get(key)
    if (saved === undefined) continue
    if (typeof saved === 'number' && saved > now) continue
    await $.store.delete(key)
    await $.store.delete(PER_SESSION.every + key.slice(PER_SESSION.deadline.length))
  }
}

/** Every row this profile logged in the last `days` days. */
async function readRows($: EngineInterface, s: State, now: number, days: number): Promise<ReportRow[]> {
  const rows: ReportRow[] = []
  const dir = s.paths.ledger
  if (!dir || !(await $.fs.exists(dir))) return rows
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    if (entry.mtimeMs < now - days * DAY_MS) continue
    for (const line of (await $.fs.read(`${dir}/${entry.name}`)).split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push({ ...(JSON.parse(line) as ReportRow), file: entry.name })
      } catch {
        // A line torn by a crash mid-write is skipped, not fatal.
      }
    }
  }
  return rows
}

async function reportText($: EngineInterface, s: State, now: number, days: number): Promise<string> {
  if (!s.paths.ledger || !(await $.fs.exists(s.paths.ledger))) return 'warmproof: no evidence logged yet'
  return reportFrom(await readRows($, s, now, days), now, days)
}

async function sessionsText($: EngineInterface, s: State, now: number): Promise<string> {
  const seen = new Map<string, SessionSketch>()
  seen.set(s.sid, { sid: s.sid, folder: folderName(s.cwd), lastTurnAt: s.lastTurnAt, ctx: s.ctx, deadline: s.deadline || null, mine: true })
  for (const row of await readRows($, s, now, 1)) {
    const file = typeof row.file === 'string' ? row.file : ''
    // A rolled log is not another session, and `<session>-<instance>` is the same session.
    if (/\.\d+\.jsonl$/.test(file)) continue
    const sid = sessionOfLogFile(file)
    if (!sid) continue
    const sketch = seen.get(sid) ?? { sid, folder: '?', lastTurnAt: 0, ctx: 0, deadline: null, mine: sid === s.sid }
    if (row.kind === 'start' && typeof row.cwd === 'string') sketch.folder = folderName(row.cwd)
    if (row.kind === 'turn') {
      const at = Date.parse(row.at)
      if (Number.isFinite(at) && at > sketch.lastTurnAt) sketch.lastTurnAt = at
      if (typeof row.ctx === 'number' && !sketch.mine) sketch.ctx = row.ctx
    }
    seen.set(sid, sketch)
  }
  for (const sketch of seen.values()) {
    if (sketch.mine) continue
    const saved = await $.store.get(deadlineKey(sketch.sid))
    sketch.deadline = typeof saved === 'number' ? saved : null
  }
  return sessionsFrom([...seen.values()], now)
}

// ---------- the daily budget, shared across the profile's sessions

/** Adds a fork's spend to this session's own slice of today, so no update is ever lost. */
async function addSpend($: EngineInterface, s: State, now: number, tokens: number) {
  const key = spendKey(dayKey(new Date(now)), s.sid)
  const before = await $.store.get(key)
  await $.store.set(key, (typeof before === 'number' ? before : 0) + tokens)
}

async function spentToday($: EngineInterface, now: number): Promise<number> {
  const day = dayKey(new Date(now))
  const entries: Array<[string, unknown]> = []
  for (const key of await $.store.keys()) {
    if (key.startsWith(`spend:${day}:`)) entries.push([key, await $.store.get(key)])
  }
  return sumSpend(day, entries)
}

// ---------- the handoff note

/** Asks for a summary of this session and saves it. Returns the path, or null with a logged reason. */
async function writeNote($: EngineInterface, s: State): Promise<string | null> {
  const dir = s.paths.notes
  if (!dir) {
    $.ui.log('warmproof: no handoff written, neither CLAUDE_CONFIG_DIR nor HOME is set')
    return null
  }
  const answer = await askModel($, s, HANDOFF_PROMPT, 'handoff', NOTE_DEADLINE_MS)
  if (answer === 'lost' || answer === null || answer.isAnswered === false || !answer.text || !answer.text.trim()) {
    const reason = answer === 'lost'
      ? `no answer within ${fmtDuration(NOTE_DEADLINE_MS)}`
      : answer === null ? 'the engine did not run it' : 'it came back empty'
    $.ui.log(`warmproof: no handoff written, ${reason}`)
    return null
  }
  const u = answer.usage
  if (u) {
    await addSpend($, s, await $.clock.now(), spendTokens({
      read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, input: u.input_tokens, output: u.output_tokens,
    }))
  }
  const path = `${dir}/${s.sid}.md`
  const stamp = new Date(await $.clock.now()).toISOString()
  await $.fs.write(path, `<!-- session ${s.sid} · ${s.cwd} · ${stamp} -->\n\n${answer.text.trim()}\n`)
  s.notePath = path
  return path
}

// ---------- the window

/** Pushes the state line to whichever surface this session has: the band, or the status area. */
function refreshStatus($: EngineInterface, s: State, now: number) {
  const line = stateLine(s, now)
  if (s.hasBand) {
    $.ui.invalidate('ui.render')
    return
  }
  $.ui.status(line)
}

/**
 * Other sessions of this profile already warming this folder. Two windows on one folder ping the
 * same conversation lineage twice, so the second one is spend for a cache the first already holds.
 */
async function rivalWindows($: EngineInterface, s: State, now: number): Promise<string[]> {
  if (!s.paths.ledger) return []
  const folders = new Map<string, string>()
  for (const row of await readRows($, s, now, 1)) {
    const file = typeof row.file === 'string' ? row.file : ''
    if (/\.\d+\.jsonl$/.test(file)) continue
    const sid = sessionOfLogFile(file)
    if (row.kind === 'start' && typeof row.cwd === 'string') folders.set(sid, folderName(row.cwd))
  }
  const seen: Array<{ sid: string; folder: string; deadline: number | null }> = []
  for (const [sid, folder] of folders) {
    const saved = await $.store.get(deadlineKey(sid))
    seen.push({ sid, folder, deadline: typeof saved === 'number' ? saved : null })
  }
  return rivalsInFolder(seen, { sid: s.sid, folder: folderName(s.cwd) }, now)
}

/** Opens a window of `windowMs`, pinging after every `every` of idle. */
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  s.every = every
  if (every === conf().everyMs) await $.store.delete(everyKey(s.sid))
  else await $.store.set(everyKey(s.sid), every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s.sid), s.deadline)
  if (conf().adaptPingPeriod) {
    const pings = (await readRows($, s, now, BREAK_HISTORY_DAYS))
      .filter(row => row.kind === 'ping' && typeof row.warm === 'boolean' && typeof row.idleMin === 'number')
      .map(row => ({ warm: row.warm === true, idleMin: row.idleMin as number }))
    const learned = learnedEveryMinutes(pings, Math.round(s.every / 60_000))
    if (learned !== null && learned * 60_000 !== s.every) {
      const was = s.every
      s.every = learned * 60_000
      await $.store.set(everyKey(s.sid), s.every)
      $.ui.log(`warmproof: pinging every ${fmtDuration(s.every)} instead of ${fmtDuration(was)}, from ${pings.length} pings on record`)
    }
  }
  const rivals = await rivalWindows($, s, now)
  if (rivals.length) {
    const names = rivals.map(sid => sid.split('-')[0] ?? sid).join(', ')
    $.ui.log(`warmproof: ${rivals.length === 1 ? 'session' : 'sessions'} ${names} ${rivals.length === 1 ? 'is' : 'are'} ` +
      `already keeping ${folderName(s.cwd)} warm, so both windows will ping the same conversation (/keepwarm off here to leave it to them)`)
  }
  await schedule($, s)
}

/** Closes the window. `why` shows in the status line; null means it simply ended. */
async function stopWindow($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  s.deadline = 0
  s.stopped = why
  s.fromBackground = false
  clearTimer(s, 'ping')
  clearTimer(s, 'turnPing')
  clearTimer(s, 'proof')
  await $.store.delete(deadlineKey(s.sid))
  await $.store.delete(everyKey(s.sid))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(SHARED.always)
  }
  // With no window holding it, the nudge before expiry becomes useful again.
  await scheduleAlert($, s)
  refreshStatus($, s, await $.clock.now())
}

/**
 * Sets the next timer for an open window: the ping when one can still land, otherwise just the
 * end of the window. Called after every turn, ping and compaction.
 */
async function schedule($: EngineInterface, s: State) {
  clearTimer(s, 'ping')
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return finishWindow($, s)
  // A ping period of 50 minutes cannot reach a cache that dies in five, so a window here would
  // sit and never fire. Say so instead, unless this is a proof run that wants the short bucket.
  if (s.shortTtl && !s.provingFast) {
    return stopWindow($, s, 'this session uses the 5-minute cache, which pings cannot hold')
  }
  clearTimer(s, 'alert')
  // A proof run sends its own ping on its own timer, so the window must not send a second one.
  const canPing = !s.headless && !s.proving && s.lastRequestAt > 0 && !s.compacted && !isCold(s, now)
  if (canPing) {
    const untilCold = s.lastRequestAt + cacheLifeMs(s) - now
    const untilDue = Math.max(1000, s.lastRequestAt + s.every - now)
    s.timers.ping = $.clock.after(Math.min(s.deadline - now, untilCold, untilDue), () => { void sendPing($, s) })
  } else {
    s.timers.ping = $.clock.after(s.deadline - now, () => { void schedule($, s) })
  }
  refreshStatus($, s, now)
}

function unanswered(answer: { reason?: string | null; status?: number | null }): string {
  if (answer.reason === 'nothing-to-fork') return 'there is no conversation to keep warm yet'
  if (answer.reason === 'api-error') return `the API call failed${answer.status == null ? '' : ` (${answer.status})`}`
  if (answer.reason === 'aborted') return 'the ping was interrupted'
  return 'the ping came back with no text'
}

/** One tool-less fork that reads the cached prefix and writes almost nothing. */
async function sendPing($: EngineInterface, s: State) {
  s.timers.ping = null
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return finishWindow($, s)
  if (isCold(s, now)) return schedule($, s)
  // A turn landed while this timer waited, so it is early: let the new schedule take over.
  if (now - s.lastRequestAt < s.every - 1000) return schedule($, s)
  // A wake-up this session booked will read the cache anyway; wait until just after it.
  if (s.wakeAt !== null && wakesItself(s.wakeAt, now, s.lastRequestAt + cacheLifeMs(s))) {
    s.timers.ping = $.clock.after(s.wakeAt + 2 * 60_000 - now, () => { void sendPing($, s) })
    return
  }
  const blocked = await pingBlockedBy($, s, now, 'idle')
  if (blocked) return stopWindow($, s, blocked)
  if (conf().afterHours === 'handoff' && !inWorkHours(new Date(now), conf())) {
    const saved = conf().handoff && worthGuarding(s) && !s.notePath ? await writeNote($, s) : null
    return stopWindow($, s, saved ? `outside working hours, handoff saved: ${saved}` : 'outside working hours')
  }

  const fired = await firePing($, s, now, 'ping')
  if (typeof fired === 'string') return stopWindow($, s, fired)
  if (!fired.held) {
    await benchVersion($, s, 'a ping missed the cache')
    const dollars = conf().costUnit === 'usd' ? ` (${fmtUsd(fired.usd)})` : ''
    return stopWindow($, s, `the ping read ${fmtTok(fired.read)} and wrote ` +
      `${fmtTok(fired.write)} tokens${dollars}, so the cache had already gone`)
  }
  s.autoPingsSinceTurn++
  s.lastRequestAt = now
  await schedule($, s)
}

export type PingOutcome = { held: boolean; read: number; write: number; usd: number | null; spend: number }

/**
 * Sends one ping, accounts for it and logs it. Returns what the cache served, or the reason it
 * could not be sent. Shared by the idle timer and `/warmproof ping`, so both spend identically.
 */
/**
 * The other mechanism, for comparison: a real turn carrying the ping prompt, which is what every
 * other keep-warm tool does. It adds a turn to your conversation, which is why it is opt-in — the
 * point is to measure whether it holds the cache better than a fork, not to use it by default.
 */
async function firePingAsTurn($: EngineInterface, s: State, now: number, what: string): Promise<PingOutcome | string> {
  // Claimed before the turn is submitted, because turn.complete may land before this returns.
  s.pingTurnAt = now
  try {
    await askModelTurn($, s, PING_PROMPT, what)
  } catch (err) {
    s.pingTurnAt = 0
    return `the ping turn failed, ${because(err)}`
  }
  // A real turn's usage arrives through turn.complete, which writes the ping row with the figures
  // that turn reports and leaves the break clock alone. Nothing is counted here.
  return { held: true, read: 0, write: 0, usd: null, spend: 0 }
}

async function firePing($: EngineInterface, s: State, now: number, what: string): Promise<PingOutcome | string> {
  // A proof run names the mechanism it is testing; otherwise the option decides.
  const via = s.proveVia ?? conf().pingVia
  if (via === 'turn') return firePingAsTurn($, s, now, what)
  const restoreTtl = conf().pingSubagentTtl1h ? await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL') : undefined
  let answer: Fork | 'lost'
  s.pinging = true
  if (conf().pingSubagentTtl1h) await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h')
  try {
    answer = await askModel($, s, PING_PROMPT, what, PING_DEADLINE_MS)
  } catch (err) {
    return `the ping failed, ${because(err)}`
  } finally {
    s.pinging = false
    if (conf().pingSubagentTtl1h) await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', restoreTtl)
  }
  if (answer === 'lost') {
    return `the ping did not answer within ${fmtDuration(PING_DEADLINE_MS)}; it may still have been billed`
  }
  if (answer === null) return 'the engine did not send the ping, either the snapshot was cold or the call failed'
  if (answer.isAnswered === false) return unanswered(answer)

  const u = answer.usage
  const rates = ratesFor(s.lastModel)
  // Warm means it read the prefix and wrote only its own message; a tenth or more means the prefix broke.
  const held = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = rates ? forkUsd(u, rates) : null
  s.lastPing = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm: held }
  s.pingsSinceTurn++
  const spend = spendTokens({
    read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, input: u.input_tokens, output: u.output_tokens,
  })
  await addSpend($, s, now, spend)
  await note($, s, {
    kind: 'ping', read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens,
    input: u.input_tokens, output: u.output_tokens, warm: held,
    idleMin: s.lastTurnAt ? Math.round((now - s.lastTurnAt) / 60_000) : 0,
    spend, limits: limitsOf((await $.session.usage()).rateLimits),
  })
  await keepRuntime($, s)
  return { held, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, spend }
}

/** Whatever is typed in the prompt box, or nothing when this host cannot say. */
async function draftText($: EngineInterface): Promise<boolean> {
  try {
    return typingNow((await $.prompt.read()).text)
  } catch {
    return false
  }
}

/**
 * A proof run's own ping, on a one-shot timer. It goes through the manual path, so it fires in a
 * headless or scripted session too: the gate that silences automatic pinging is not meant to
 * silence an experiment that was asked for by name.
 */
function scheduleProofPing($: EngineInterface, s: State, afterMs: number) {
  clearTimer(s, 'proof')
  s.timers.proof = $.clock.after(afterMs, () => { void proofPing($, s) })
}

async function proofPing($: EngineInterface, s: State) {
  s.timers.proof = null
  if (!s.proving) return
  const now = await $.clock.now()
  if (isCold(s, now)) {
    $.ui.log('warmproof: the proof ping is too late, the cache had already gone; start the run again')
    s.proving = false
    s.provingFast = false
    return
  }
  const blocked = await pingBlockedBy($, s, now, 'manual')
  if (blocked) {
    $.ui.log(`warmproof: the proof ping did not go out, ${blocked}`)
    s.proving = false
    s.provingFast = false
    return
  }
  const fired = await firePing($, s, now, 'ping for the proof')
  if (typeof fired === 'string') {
    $.ui.log(`warmproof: the proof ping failed, ${fired}`)
    s.proving = false
    s.provingFast = false
    return
  }
  if (!fired.held) {
    await benchVersion($, s, 'the proof ping missed the cache')
    s.proving = false
    s.provingFast = false
    return
  }
  s.lastRequestAt = now
  refreshStatus($, s, now)
}

/** Every reason a ping must not go out, in the order they are checked. */
async function pingBlockedBy($: EngineInterface, s: State, now: number, kind: 'idle' | 'turn' | 'manual'): Promise<string | null> {
  if (s.project === 'never') return 'pings are off for this project (/warmproof project auto)'
  if (s.paths.killSwitch && (await $.fs.exists(s.paths.killSwitch))) {
    return `kill switch file ${s.paths.killSwitch} is present`
  }
  if (s.billing !== 'subscription' && !conf().pingOnMeteredBilling) {
    return `this session bills per token (${s.billing}), where the cache lasts 5 minutes and a ping cannot hold it (pingOnMeteredBilling to override)`
  }
  if (s.shortTtl && !s.provingFast) {
    return 'this session uses the 5-minute cache, which pings cannot hold'
  }
  const benched = await $.store.get(SHARED.bench)
  if (benched && typeof benched === 'object' && (benched as { version?: unknown }).version === s.version) {
    const reason = (benched as { reason?: unknown }).reason ?? 'pings did not hold the cache'
    return `paused for Claude Code ${s.version}: ${reason} (/warmproof unbench to retry)`
  }
  // The cap exists to stop an abandoned session pinging forever, so only automatic pings count
  // against it. A ping you asked for is an instruction, and still counts as proof evidence.
  const sent = kind === 'turn' ? s.pingsThisTurn : s.autoPingsSinceTurn
  // Two ceilings: the one you configured, and the one this model's own prices impose — past that
  // many cache-read pings you have spent what a single cold re-write would have cost.
  const byModel = pingsPerColdWrite(s)
  const pingCap = byModel == null ? conf().maxPingsPerIdle : Math.min(conf().maxPingsPerIdle, byModel)
  if (sent >= pingCap) {
    return byModel != null && pingCap === byModel && byModel < conf().maxPingsPerIdle
      ? `${pingCap} pings on ${s.lastModel ?? 'this model'} already cost what one cold re-write would, the model limit`
      : `${pingCap} pings without a real turn, the idle limit`
  }
  if (conf().pauseAbovePlanPercent > 0) {
    const peak = peakPlanUsage((await $.session.usage()).rateLimits)
    if (peak && peak.percentUsed >= conf().pauseAbovePlanPercent) {
      return `plan usage is at ${Math.round(peak.percentUsed)}% of your ${peak.kind.replace(/_/g, '-')} limit, above the ${conf().pauseAbovePlanPercent}% you set for pinging`
    }
  }
  if (kind === 'idle' && conf().pingOnlyIfWorthIt && s.lastTurnAt) {
    const idleMin = (now - s.lastTurnAt) / 60_000
    if (worthPinging(s.breaks, idleMin) === false) {
      return `at ${Math.round(idleMin)}m idle your past breaks say you are unlikely to be back within the hour, so a ping would not pay`
    }
  }
  if (kind === 'idle' && (await draftText($))) {
    return 'you are part-way through typing, so your own next message will read the cache'
  }
  const cap = conf().dailyPingBudget
  if (cap > 0) {
    const used = await spentToday($, now)
    if (used >= cap) return `today's ping budget is used (${fmtTok(used)} of ${fmtTok(cap)} input-equivalent tokens)`
  }
  return null
}

/** Stops automatic pings in every session of this profile until Claude Code's version changes. */
async function benchVersion($: EngineInterface, s: State, reason: string) {
  if (!s.version) return
  await $.store.set(SHARED.bench, { version: s.version, reason, at: new Date(await $.clock.now()).toISOString() })
  $.ui.log(`warmproof: pings paused for Claude Code ${s.version}, ${reason}. /warmproof unbench to retry.`)
}

/** The window ran out: take the chosen parting action while still warm, then close. */
async function finishWindow($: EngineInterface, s: State) {
  const now = await $.clock.now()
  const stillWarm = s.lastRequestAt > 0 && !s.compacted && !isCold(s, now)
  let why: string | null = null
  if (stillWarm && conf().endOfWindow === 'compact' && s.ctx >= conf().compactMinTokens && !s.turnRunning) {
    try {
      const result = await askCompact($, s, 'window end')
      why = 'skip' in result && result.skip
        ? `window ended, compaction skipped: ${result.skip}`
        : 'window ended, compacted while warm'
    } catch (err) {
      why = `window ended, compaction failed: ${because(err)}`
    }
  } else if (stillWarm && conf().endOfWindow === 'handoff' && conf().handoff && !s.notePath && worthGuarding(s)) {
    const saved = await writeNote($, s)
    why = saved ? `window ended, handoff saved: ${saved}` : null
  }
  return stopWindow($, s, why)
}

// ---------- pings inside one long turn

async function scheduleTurnPing($: EngineInterface, s: State) {
  clearTimer(s, 'turnPing')
  if (!conf().warmDuringLongTurns || s.headless || !s.turnRunning || !s.lastRequestAt) return
  const now = await $.clock.now()
  s.timers.turnPing = $.clock.after(Math.max(1000, s.lastRequestAt + s.every - now), () => { void turnPing($, s) })
}

async function turnPing($: EngineInterface, s: State) {
  s.timers.turnPing = null
  if (!s.turnRunning) return
  const now = await $.clock.now()
  if (now - s.lastRequestAt < s.every - 1000) return scheduleTurnPing($, s)
  if (isCold(s, now)) return
  const blocked = await pingBlockedBy($, s, now, 'turn')
  if (blocked) {
    $.ui.log(`warmproof: no ping during this long turn, ${blocked}`)
    return
  }
  let answer: Fork | 'lost'
  try {
    answer = await askModel($, s, PING_PROMPT, 'ping during turn', PING_DEADLINE_MS)
  } catch {
    return
  }
  if (answer === 'lost' || answer === null || answer.isAnswered === false) return
  const u = answer.usage
  const held = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  s.pingsThisTurn++
  const spend = spendTokens({
    read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, input: u.input_tokens, output: u.output_tokens,
  })
  await addSpend($, s, now, spend)
  await note($, s, {
    kind: 'ping', read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens,
    input: u.input_tokens, output: u.output_tokens, warm: held,
    idleMin: Math.round((now - s.lastRequestAt) / 60_000), spend, during: 'turn',
  })
  if (!held) return benchVersion($, s, 'a ping during a long turn missed the cache')
  s.lastRequestAt = now
  await scheduleTurnPing($, s)
}

// ---------- the nudge before the cache expires

async function scheduleAlert($: EngineInterface, s: State) {
  clearTimer(s, 'alert')
  if (s.headless || s.deadline || conf().alertMs <= 0) return
  if (!ntfyReady(conf()) && !conf().desktopNotify) return
  if (!s.lastRequestAt || s.compacted || !worthGuarding(s)) return
  const now = await $.clock.now()
  const due = s.lastRequestAt + cacheLifeMs(s) - conf().alertMs - now
  if (due <= 0) return
  const stamp = s.lastRequestAt
  s.timers.alert = $.clock.after(due, () => { void fireAlert($, s, stamp) })
}

async function fireAlert($: EngineInterface, s: State, stamp: number) {
  s.timers.alert = null
  // A newer turn, a window, or a shrunken context means this alert is no longer the right one.
  if (s.deadline || s.lastRequestAt !== stamp || s.alertedFor === stamp) return
  const now = await $.clock.now()
  if (isCold(s, now) || !worthGuarding(s) || !inWorkHours(new Date(now), conf())) return
  s.alertedFor = stamp
  const left = fmtDuration(s.lastRequestAt + cacheLifeMs(s) - now)
  const message = `Cache goes cold in ${left} in ${folderName(s.cwd)} (${fmtTok(s.ctx)} tokens to re-write). Run /keepwarm to hold it.`
  const away = conf().desktopNotify ? await isAway($, s) : null
  if (conf().desktopNotify && away === false) {
    await note($, s, { kind: 'notify', channel: 'desktop', away })
    const script = `display notification "${appleScriptString(message)}" with title "WarmProof"`
    try {
      await askHost($, s, ['osascript', '-e', script], 'desktop notification')
    } catch {
      // A failed notification is not worth interrupting anything for.
    }
    return
  }
  if (!ntfyReady(conf())) return
  await note($, s, { kind: 'notify', channel: 'phone', away })
  await pushToPhone($, s, 'WarmProof', message, await mintButtons($, s))
}

/** Seconds since the last keyboard or mouse event decide phone versus desktop. */
async function isAway($: EngineInterface, s: State): Promise<boolean | null> {
  try {
    const out = await askHost($, s, ['ioreg', '-c', 'IOHIDSystem', '-d', '4'], 'read input idle')
    if (out.exitCode !== 0) return null
    const idle = parseIdleSeconds(out.stdout)
    return idle === null ? null : idle * 1000 >= conf().awayMs
  } catch {
    return null
  }
}

async function pushToPhone($: EngineInterface, s: State, title: string, message: string, actions: readonly object[]) {
  const request = ntfyRequest(conf(), title, message, actions)
  if (!request) return
  try {
    const sent = await askWeb($, s, request.url, {
      method: 'POST', body: request.body, headers: { 'content-type': 'application/json' },
    }, 'phone alert')
    if (!sent.ok) $.ui.log(`warmproof: the phone alert failed (HTTP ${sent.status})`)
  } catch (err) {
    $.ui.log(`warmproof: the phone alert failed, ${because(err)}`)
  }
}

/** Three one-time buttons, alive only as long as the cache they speak for. */
async function mintButtons($: EngineInterface, s: State): Promise<readonly object[]> {
  if (!ntfyButtonsReady(conf())) return []
  const group = crypto.randomUUID()
  const expiresAt = s.lastRequestAt + cacheLifeMs(s)
  const buttons: Array<[PhoneAction, string]> = [['warm2h', 'Keep warm 2h'], ['compact', 'Compact'], ['leave', 'Leave']]
  const actions = buttons.map(([action, label]) => {
    const token = crypto.randomUUID()
    s.phone.set(token, { action, group, exp: expiresAt })
    return phoneAction(label, conf().ntfyServer, conf().ntfyReplyTopic, token)
  })
  await keepRuntime($, s)
  watchPhone($, s)
  return actions
}

function watchPhone($: EngineInterface, s: State) {
  if (s.timers.phone || !s.phone.size) return
  s.timers.phone = $.clock.every(PHONE_POLL_MS, () => { void readTaps($, s) })
}

async function readTaps($: EngineInterface, s: State) {
  const now = await $.clock.now()
  for (const [token, held] of [...s.phone]) {
    if (held.exp <= now) s.phone.delete(token)
  }
  if (!s.phone.size) {
    clearTimer(s, 'phone')
    await keepRuntime($, s)
    return
  }
  let body = ''
  try {
    const polled = await askWeb($, s, `${conf().ntfyServer}/${conf().ntfyReplyTopic}/json?poll=1&since=${s.phoneSince}`, undefined, 'poll phone replies')
    if (!polled.ok) return
    body = polled.text
  } catch {
    return
  }
  // ntfy's `since` is in whole seconds: move it on so the next poll fetches only newer messages
  // instead of replaying the whole topic every 20 seconds.
  s.phoneSince = Math.floor(now / 1000)
  for (const token of tokensInReplies(body)) {
    const held = s.phone.get(token)
    if (!held || held.exp <= now) continue
    // The first tap spends every button in its group, so a second tap cannot act twice.
    for (const [issued, sibling] of [...s.phone]) {
      if (sibling.group === held.group) s.phone.delete(issued)
    }
    await note($, s, { kind: 'phone', action: held.action })
    await applyTap($, s, held.action)
    break
  }
  await keepRuntime($, s)
}

async function applyTap($: EngineInterface, s: State, action: PhoneAction) {
  const folder = folderName(s.cwd)
  if (action === 'warm2h') {
    await startWindow($, s, 2 * 60 * 60_000, conf().everyMs)
    await pushToPhone($, s, 'WarmProof', `Keeping ${folder} warm for 2h.`, [])
    return
  }
  if (action === 'compact') {
    try {
      await askCompact($, s, 'phone button')
      await pushToPhone($, s, 'WarmProof', `Compacted ${folder} while warm.`, [])
    } catch {
      await pushToPhone($, s, 'WarmProof', `Could not compact ${folder}.`, [])
    }
    return
  }
  // Leave means let it go cold, so it writes no away plan: that key means "hold it until", which
  // would tell this session and every other one to start warming instead. A plan another session
  // announced between the alert and this tap is marked seen, so the next tick cannot adopt it and
  // re-arm what you just stopped. shortcut: that race is not covered by a test, since the harness
  // does not expose $.store.set; upgrade when it does.
  const standing = await $.store.get(SHARED.leave)
  if (standing && typeof standing === 'object') {
    const { id } = standing as { id?: unknown }
    if (typeof id === 'string') s.leaveSeen = id
  }
  await pushToPhone($, s, 'WarmProof', `Left ${folder} to cool.`, [])
  await stopWindow($, s, 'you chose to leave it cooling')
}

// ---------- once-a-minute housekeeping

async function tick($: EngineInterface, s: State) {
  const now = await $.clock.now()
  // shortcut: no test stages this, since a mock clock replays every interval instead of skipping
  // them as a sleeping host does; upgrade when the kit can drop timers.
  const slept = sleptMinutes(s.lastTickAt, now, TICK_MS)
  s.lastTickAt = now
  if (slept !== null) {
    // A proof measures what a ping held across a gap. A gap the machine slept through proves
    // nothing either way, so the run is voided rather than reported as a result.
    const voided = s.proving
    s.proving = false
    s.provingFast = false
    await note($, s, { kind: 'wake', sleptMin: slept, provingVoided: voided })
    $.ui.log(`warmproof: the Mac was asleep for about ${fmtDuration(slept * 60_000)}, so nothing could ping` +
      (voided ? '. The proof run is void: start it again while the Mac stays awake' : ''))
    await keepRuntime($, s)
  }
  if (conf().showCountdown) refreshStatus($, s, now)
  if (conf().followLeave) await followLeave($, s, now)
  if (conf().weeklyDigest) await maybeDigest($, s, now)
}

async function followLeave($: EngineInterface, s: State, now: number) {
  const plan = await $.store.get(SHARED.leave)
  if (!plan || typeof plan !== 'object') return
  const { id, until } = plan as { id?: unknown; until?: unknown }
  if (typeof id !== 'string' || id === s.leaveSeen || typeof until !== 'number') return
  s.leaveSeen = id
  if (until <= now || s.deadline || !s.lastRequestAt) return
  if (isCold(s, now) || !worthGuarding(s) || s.project === 'never') return
  await startWindow($, s, until - now, conf().everyMs)
  await note($, s, { kind: 'leave', until: new Date(until).toISOString() })
}

async function maybeDigest($: EngineInterface, s: State, now: number) {
  const lastSent = await $.store.get(SHARED.digestWeek)
  if (!digestDue(new Date(now), typeof lastSent === 'string' ? lastSent : null, conf().digestWeekday, conf().digestMinute)) return
  // Nothing logged, nothing to digest: pushing "no evidence logged yet" to your phone and then
  // marking the week sent would spend the week's one digest on an empty report.
  if (!s.paths.ledger || !(await $.fs.exists(s.paths.ledger))) return
  const week = weekKey(new Date(now))
  const text = await reportText($, s, now, 7)
  if (s.paths.ledger) await $.fs.write(`${s.paths.ledger}/digest-${week}.md`, text + '\n')
  if (ntfyReady(conf())) await pushToPhone($, s, 'WarmProof weekly', text, [])
  // Recorded last: a failure above leaves the week owed, so the next tick tries again rather
  // than skipping the digest for good.
  await $.store.set(SHARED.digestWeek, week)
  await note($, s, { kind: 'digest', week })
}

// ---------- the band above the prompt

function markFor(s: State, now: number): CacheMark | 'stopped' {
  if (s.stopped) return 'stopped'
  if (!s.lastRequestAt || s.compacted) return 'unknown'
  return isCold(s, now) ? 'cold' : 'warm'
}

export const register: Register = (on, options) => {
  loadConfig(options)
  const s = freshState()
  let theme: 'light' | 'dark' = 'dark'
  let plain = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny === undefined) {
        theme = typeof result.value === 'string' && result.value.startsWith('light') ? 'light' : 'dark'
        if (s.hasBand) $.ui.invalidate('ui.render')
      }
    } catch {
      // Repainting the band is never worth failing a settings change for.
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return below
    const now = await $.clock.now()
    const line = stateLine(s, now)
    if (!line || (s.deadline && now >= s.deadline)) return below
    const mark = markFor(s, now)
    const drawable: CacheMark = mark === 'stopped' ? 'unknown' : mark
    const ink = plain ? undefined : markInk[theme][drawable]
    const { Box, Text, Svg } = $.ui.resolve(e)
    const badge = plain || e.surface === 'terminal'
      ? Text({ color: ink, bold: true, children: [markGlyph[drawable]] })
      : Svg({ source: markSvg(drawable, theme), width: 18, height: 18, alt: `cache ${drawable}` })
    return Box({
      flexDirection: 'column',
      children: [
        below,
        Box({
          flexDirection: 'row',
          alignItems: 'center',
          children: [
            Box({ flexShrink: 0, children: [badge] }),
            Text({ children: [' warmproof · ', Text({ color: ink, bold: true, children: [mark] }), ` · ${line}`] }),
          ],
        }),
      ],
    })
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (s.hasBand) {
      const saved = (await $.config.list()).find(row => row.key === 'theme')?.value
      theme = typeof saved === 'string' && saved.startsWith('light') ? 'light' : 'dark'
      plain = Boolean(await $.env.get('NO_COLOR'))
      $.ui.status(undefined)
    }
    s.sid = await $.session.id()
    // Per instance, not per session: a reload or a host upgrade mid-session would otherwise have
    // two writers replacing one file, which shreds rows (the file API has no append).
    s.logName = `${s.sid}-${crypto.randomUUID().slice(0, 8)}`
    s.cwd = e.cwd
    s.headless = !e.isInteractive
    // Resolved once: no redraw or turn ever reads the environment again.
    const profile = configDir(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
    s.paths = {
      ledger: profile ? `${profile}/warmproof` : null,
      killSwitch: profile ? `${profile}/warmproof-off` : null,
      projects: profile ? `${profile}/warmproof-projects.json` : null,
      notes: profile ? `${profile}/handoffs` : null,
    }
    s.project = projectPolicy(await readProjects($, s), e.cwd)
    if (await recoverRuntime($, s)) watchPhone($, s)
    try {
      s.version = (await $.session.version()).version
    } catch {
      s.version = null
    }
    const ttlEnv = (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) ?? null
    const forced5m = Boolean(await $.env.get('FORCE_PROMPT_CACHING_5M'))
    s.shortTtl = ttlEnv === '5m' || forced5m
    s.ttlSource = ttlEnv || forced5m ? 'env' : 'assumed'
    // Which backend pays for this session: only a subscription gets the one-hour cache.
    s.billing = billingMode({
      CLAUDE_CODE_USE_BEDROCK: await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      CLAUDE_CODE_USE_VERTEX: await $.env.get('CLAUDE_CODE_USE_VERTEX'),
      CLAUDE_CODE_USE_FOUNDRY: await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
      ANTHROPIC_BASE_URL: await $.env.get('ANTHROPIC_BASE_URL'),
      ANTHROPIC_API_KEY: await $.env.get('ANTHROPIC_API_KEY'),
      ANTHROPIC_AUTH_TOKEN: await $.env.get('ANTHROPIC_AUTH_TOKEN'),
    })
    await note($, s, {
      kind: 'start', version: s.version, ttlEnv, headless: s.headless, cwd: s.cwd, project: s.project,
      subagentTtlEnv: (await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')) ?? null,
      billing: s.billing,
    })
    const now = await $.clock.now()
    for (const key of staleSpendKeys(await $.store.keys(), new Date(now))) await $.store.delete(key)
    await dropDeadWindows($, s, now)
    const savedDeadline = await $.store.get(deadlineKey(s.sid))
    const savedEvery = await $.store.get(everyKey(s.sid))
    const savedGuard = await $.store.get(SHARED.guard)
    s.deadline = typeof savedDeadline === 'number' && savedDeadline > now ? savedDeadline : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= PING_FLOOR_MS ? savedEvery : conf().everyMs
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(SHARED.always)) === true
    s.breaks = breakMinutes(await readRows($, s, now, BREAK_HISTORY_DAYS), now - BREAK_HISTORY_DAYS * DAY_MS)
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    // One timer carries the countdown, the away plan and the digest; none starts when none is wanted.
    if (!s.headless && !s.timers.tick && (conf().showCountdown || conf().followLeave || conf().weeklyDigest)) {
      s.timers.tick = $.clock.every(TICK_MS, () => { void tick($, s) })
    }
    // `always` means a full window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, conf().windowMs, conf().everyMs)
    else if (s.project === 'always' && !s.headless && !s.deadline) await startWindow($, s, conf().windowMs, conf().everyMs)

    await $.command.register({
      name: 'keepwarm',
      description: 'Hold the prompt cache: bare for the default window, a length such as 90m, auto, always, off, or status (warmproof)',
      argumentHint: '[6h | for 3h | until 18:00 | auto | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'warmproof',
      description: 'Cache state, what a cold resume costs, and the evidence behind it (warmproof)',
      argumentHint: '[status | ping | prove [fast] | report [days] | export [days] | sessions | leave 2h | breaks | project always|auto|never | unbench | guard warn|refuse | forget confirm]',
      immediate: true,
    })
    await $.command.register({
      name: 'handoff',
      description: 'Save a handoff note for this session, or load one back: load [latest | <session-id>] (warmproof)',
      argumentHint: '[load [latest | <session-id>]]',
    })
    refreshStatus($, s, now)
    return started
  })

  on('classic.SessionStart', async ($, e, next) => {
    const started = await next(e)
    if (e.source === 'clear') {
      await stopWindow($, s, null)
      forgetConversation(s)
      s.sid = await $.session.id()
      refreshStatus($, s, await $.clock.now())
      return started
    }
    try {
      const notice = seedFromResume(s, e, await $.clock.now())
      // A resume payload may omit the model, and without it a cold write cannot be priced.
      if (!s.lastModel) s.lastModel = await $.session.model()
      if (notice) $.ui.log(`warmproof: ${notice}`)
      // The seeded clock decides whether a restored window may ping before the first turn.
      if (s.deadline) await schedule($, s)
      else await scheduleAlert($, s)
    } catch {
      // A session must start even when none of the above can be worked out.
    }
    return started
  })

  // A command's reply is printed by the host under this plugin's name, so these texts carry no
  // `warmproof:` of their own. Lines sent through $.ui.log are not prefixed and still say it.
  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    const [first, second, third] = words

    if (first === 'off') {
      const wasAlways = s.always
      await stopWindow($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (first === 'always') {
      s.always = true
      await $.store.set(SHARED.always, true)
      await startWindow($, s, conf().windowMs, conf().everyMs)
      const cold = isCold(s, now)
        ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
        : ''
      return { text: `keepwarm always on: every session opens a ${fmtDuration(conf().windowMs)} window; /keepwarm off ends that${cold}` }
    }
    if (first === 'auto') {
      const learned = suggestWindowMs(s.breaks)
      const held = learned ?? conf().windowMs
      await startWindow($, s, held, conf().everyMs)
      const how = learned ? 'learned from your breaks' : 'not enough long breaks logged yet, default length'
      return { text: `${armedLine(s, now, held)} (${how})` }
    }
    if (!first) {
      await startWindow($, s, conf().windowMs, conf().everyMs)
      return { text: armedLine(s, now, conf().windowMs) }
    }
    if (first === 'for' || first === 'until') {
      const held = windowFromWords(words, new Date(now), parseDuration)
      if (held == null) return { text: 'keepwarm for takes a length such as 3h; until takes a time such as 18:00' }
      await startWindow($, s, held, conf().everyMs)
      return { text: armedLine(s, now, held) }
    }
    if (first === 'status') return { text: stateLine(s, now) ?? 'keepwarm is off' }

    const held = parseDuration(first)
    if (held == null) return { text: 'keepwarm takes a window such as 6h or 90m, or auto, always, off, or status' }
    // `every 2m` is a testing knob: it lasts only for the window it was given with.
    let every = conf().everyMs
    if (second === 'every') {
      const period = parseDuration(third ?? '')
      if (period == null || period < PING_FLOOR_MS) return { text: 'every takes a period of at least 1m' }
      every = period
    }
    await startWindow($, s, held, every)
    return { text: armedLine(s, now, held) }
  })

  on('command.run', { command: 'warmproof' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    const [first, second, words3] = words

    if (first === 'project') {
      if (second !== 'always' && second !== 'auto' && second !== 'never') {
        return { text: `this folder is ${s.project}; /warmproof project always|auto|never` }
      }
      if (!s.paths.projects) return { text: 'no profile folder to save a project setting in' }
      const saved = await readProjects($, s)
      if (second === 'auto') delete saved[s.cwd]
      else saved[s.cwd] = second
      await $.fs.write(s.paths.projects, JSON.stringify(saved, null, 2) + '\n')
      s.project = projectPolicy(saved, s.cwd)
      if (s.project === 'never' && s.deadline) await stopWindow($, s, 'pings are off for this project')
      if (s.project === 'always' && !s.deadline && !s.headless) await startWindow($, s, conf().windowMs, conf().everyMs)
      const tail = s.project === 'always' ? ', a window opens at every session start'
        : s.project === 'never' ? ', no pings here'
        : ''
      return { text: `${folderName(s.cwd)} is now ${s.project}${tail}` }
    }
    if (first === 'sessions') return { text: await sessionsText($, s, now) }
    if (first === 'breaks') {
      const learned = suggestWindowMs(s.breaks)
      const long = s.breaks.filter(minutes => minutes > 60).length
      const tail = learned ? `; /keepwarm auto holds ${fmtDuration(learned)}` : '; not enough long breaks to learn a window'
      return { text: `${s.breaks.length} breaks of 10m+ in ${BREAK_HISTORY_DAYS} days, ${long} over an hour${tail}` }
    }
    if (first === 'leave') {
      const away = parseDuration(second ?? '')
      if (away == null) return { text: '/warmproof leave takes a length such as 2h or 90m' }
      const until = now + away
      const id = crypto.randomUUID()
      await $.store.set(SHARED.leave, { id, until })
      s.leaveSeen = id
      if (s.lastRequestAt && !isCold(s, now) && worthGuarding(s) && s.project !== 'never') {
        await startWindow($, s, away, conf().everyMs)
      }
      await note($, s, { kind: 'leave', until: new Date(until).toISOString() })
      return { text: `away for ${fmtDuration(away)}; every open session with a warm, worthwhile cache holds it until then` }
    }
    // The experiment the whole mod rests on, as one command: arm, ping, wait out the hour, and
    // read the verdict from the next real message.
    if (first === 'prove') {
      const words = [second, words3].filter((word): word is string => typeof word === 'string')
      const fast = words.includes('fast')
      const via = words.includes('turn') ? 'turn' : words.includes('fork') ? 'fork' : null
      if (words.some(word => !['fast', 'fork', 'turn'].includes(word))) {
        return { text: '/warmproof prove takes fast, fork or turn: prove, prove fast, prove fast turn' }
      }
      if (!s.lastRequestAt) return { text: 'nothing to prove yet: send a real message first, so there is a cache to hold' }
      if (fast && !s.shortTtl) {
        return {
          text: 'the fast proof runs on the five-minute cache, and this session is on the one-hour one. ' +
            'Relaunch with CLAUDE_CODE_PROMPT_CACHE_TTL=5m and run it there, or use /warmproof prove for the hour.',
        }
      }
      if (isCold(s, now)) return { text: `the cache went cold ${fmtDuration(now - s.lastRequestAt - cacheLifeMs(s))} ago; send a message and run this again` }
      if (!worthGuarding(s)) {
        return { text: `the context is ${fmtTok(s.ctx)}, below the ${fmtTok(conf().minContextTokens)} worth proving anything about; build more first` }
      }
      // The fast run has to be allowed past the short-TTL gate before anything is armed.
      if (fast) s.provingFast = true
      const blocked = await pingBlockedBy($, s, now, 'manual')
      if (blocked) {
        s.provingFast = false
        return { text: `cannot prove it here: ${blocked}` }
      }
      s.proving = true
      s.proveVia = via
      if (fast) {
        // The ping has to land near the end of the lifetime, as it does on the hour. One sent at
        // the start would hold the cache only as long as an unpinged one lives anyway, so it
        // would prove nothing. The window therefore pings a minute before the five are up, and
        // the measured message comes two minutes after an unpinged cache would have died.
        const every = SHORT_CACHE_LIFE_MS - 60_000
        await startWindow($, s, 20 * 60_000, every)
        scheduleProofPing($, s, every)
        await keepRuntime($, s)
        const wait = fmtDuration(SHORT_CACHE_LIFE_MS + 2 * 60_000)
        return {
          text: `fast proof armed with ${fmtTok(s.ctx)} of context, testing the ${via ?? conf().pingVia} mechanism. ` +
            `A ping goes out after ${fmtDuration(every)} of idle, ` +
            `a minute before the five-minute cache would lapse. Leave this session alone for ${wait} with the Mac awake, ` +
            'then send any message: the reply will say proven or NOT proven.',
        }
      }
      const window = cacheLifeMs(s) + 30 * 60_000
      await startWindow($, s, window, conf().everyMs)
      scheduleProofPing($, s, conf().everyMs)
      await keepRuntime($, s)
      const idle = fmtDuration(cacheLifeMs(s) + 10 * 60_000)
      return {
        text: `proof armed for ${fmtDuration(window)} with ${fmtTok(s.ctx)} of context. A ping goes out after ` +
          `${fmtDuration(s.every)} of idle. Now leave this session alone for ${idle} with the Mac awake, then send any ` +
          'message: the reply will say proven or NOT proven. /warmproof report sums it afterwards.',
      }
    }
    if (first === 'unbench') {
      await $.store.delete(SHARED.bench)
      return { text: 'automatic pings are allowed again; the next miss pauses them once more' }
    }
    // One ping now, on demand: the only way to see what the cache serves without waiting out the idle.
    if (first === 'ping') {
      if (!s.lastRequestAt) return { text: 'nothing to ping yet, no request has gone out this session' }
      if (isCold(s, now)) {
        return { text: `the cache went cold ${fmtDuration(now - s.lastRequestAt - cacheLifeMs(s))} ago, so a ping would only re-write it` }
      }
      const blocked = await pingBlockedBy($, s, now, 'manual')
      if (blocked) return { text: `no ping, ${blocked}` }
      const fired = await firePing($, s, now, 'ping on request')
      if (typeof fired === 'string') return { text: `${fired}` }
      if (!fired.held) {
        await benchVersion($, s, 'a ping on request missed the cache')
        return { text: `NOT warm. The ping read ${fmtTok(fired.read)} and wrote ${fmtTok(fired.write)} tokens, so the prefix did not survive` }
      }
      s.lastRequestAt = now
      if (s.deadline) await schedule($, s)
      else await scheduleAlert($, s)
      refreshStatus($, s, now)
      return {
        text: `warm. The ping read ${fmtTok(fired.read)} from the cache and wrote ${fmtTok(fired.write)}, ` +
          `${fmtTok(fired.spend)} input-equivalent tokens spent; the hour restarts now`,
      }
    }
    // Clears the evidence this profile has collected. Settings and the away plan are left alone.
    if (first === 'forget') {
      if (second !== 'confirm') {
        return { text: '/warmproof forget confirm clears this profile\'s evidence logs, the version pause and today\'s spend. Settings and handoffs are kept.' }
      }
      let cleared = 0
      if (s.paths.ledger && (await $.fs.exists(s.paths.ledger))) {
        for (const entry of await $.fs.list(s.paths.ledger)) {
          if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
          // There is no delete in the file API, so an emptied file is as far as this goes.
          await $.fs.write(`${s.paths.ledger}/${entry.name}`, '')
          cleared++
        }
      }
      let keys = 0
      for (const key of await $.store.keys()) {
        if (!key.startsWith('spend:') && key !== SHARED.bench && key !== SHARED.digestWeek) continue
        await $.store.delete(key)
        keys++
      }
      s.breaks = []
      s.coldWrites = []
      s.lastPing = null
      return { text: `emptied ${cleared} evidence file${cleared === 1 ? '' : 's'} and dropped ${keys} stored key${keys === 1 ? '' : 's'}` }
    }
    if (first === 'report') return { text: await reportText($, s, now, Number(second ?? 7) || 7) }
    // For an issue: the totals plus every verdict and miss, with nothing in it worth redacting.
    if (first === 'export') {
      const days = Number(second ?? 7) || 7
      if (!s.paths.ledger || !(await $.fs.exists(s.paths.ledger))) return { text: 'no evidence logged yet' }
      return { text: exportFrom(await readRows($, s, now, days), now, days) }
    }
    if (first === 'guard') {
      if (second !== 'warn' && second !== 'refuse') return { text: '/warmproof guard takes warn or refuse' }
      s.guard = second
      await $.store.set(SHARED.guard, s.guard)
      return {
        text: s.guard === 'refuse'
          ? 'guard set to refuse once: the first cold send is held with its price, the next one goes through'
          : 'guard set to warn: a cold send goes through with its price shown',
      }
    }
    return { text: card(s, now) }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const [verb = '', which = 'latest'] = String(e.args ?? '').trim().split(/\s+/)
    if (verb === 'load') {
      const dir = s.paths.notes
      if (!dir || !(await $.fs.exists(dir))) return { text: 'no handoffs folder yet' }
      const notes = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
      const wanted = which === 'latest'
        ? [...notes].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name
        : notes.find(entry => entry.name === `${which.replace(/\.md$/, '')}.md`)?.name
      if (!wanted) {
        return { text: `no handoff ${which === 'latest' ? 'saved yet' : `named ${which}`} in ${dir}` }
      }
      const body = await $.fs.read(`${dir}/${wanted}`)
      return {
        text: `loaded ${dir}/${wanted}`,
        context: [`Handoff from an earlier session. Carry on from it:\n\n${body}`],
      }
    }
    const path = await writeNote($, s)
    return { text: path ? `handoff saved to ${path}` : 'no handoff written, see the line above' }
  })

  on('prompt.submit', async ($, e, next) => {
    // Your own typing means you are back, so the next after-hours stop writes a fresh note.
    if (e.origin.kind === 'composer') s.notePath = null
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    try {
      const now = await $.clock.now()
      if (!isCold(s, now) || !worthGuarding(s)) return next(e)
      // A proof run was told to let the cache lapse, and this message is the measurement.
      // Holding it would drop the very verdict the run exists to produce.
      if (s.proving) {
        s.coldWritePending = true
        return next(e)
      }
      const hold = conf().autoArmOnColdWrite ? `, and keepwarm will then hold it for ${fmtDuration(AFTER_COLD_WRITE_MS)}` : ''
      if (s.guard === 'warn') {
        $.ui.log(`warmproof: ${coldSendWarning(s, now)} Sending anyway${hold}.`)
        s.coldWritePending = true
        return next(e)
      }
      if (s.guardShownFor === s.lastRequestAt) {
        s.guardShownFor = 0
        s.coldWritePending = true
        return next(e)
      }
      s.guardShownFor = s.lastRequestAt
      return { drop: `warmproof: ${coldSendWarning(s, now)} Send it again to pay it${hold}. Or /clear and start from a note.` }
    } catch {
      // The guard exists to save money, not to stand between you and your own prompt.
      return next(e)
    }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      s.lastRequestAt = await $.clock.now()
      if (e.effort !== undefined) s.effort = String(e.effort)
      await scheduleTurnPing($, s)
    }
    yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    s.turnRunning = true
    s.pingsThisTurn = 0
    await scheduleTurnPing($, s)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A ping's own fork is not the person working, and must never count as a turn.
    if (e.agentId || s.pinging) return done
    s.turnRunning = false
    clearTimer(s, 'turnPing')
    s.pingsThisTurn = 0
    const now = await $.clock.now()
    // turn.step stamps the exact request; when no step did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.guardShownFor = 0
    s.alertedFor = 0
    // A stop reason is news until you work again. Keeping it after a real turn would leave the
    // status line stuck on it for the rest of the session and hide the cache countdown.
    s.stopped = null

    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const previousCtx = s.ctx
      const written = u.cache_creation_input_tokens
      // A turn's usage sums its responses, so the engine's live figure is preferred when it has one.
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      const rewroteMost = previousCtx > PROOF_FLOOR_TOKENS && written >= 0.5 * previousCtx
      const idleMs = s.lastTurnAt ? now - e.durationMs - s.lastTurnAt : 0

      // A ping WarmProof sent as a real turn. It has to be booked as a ping and nothing else:
      // treating it as your own turn would restart the break it was sent to carry, so the figures
      // would show a warm cache and no proof would ever be written.
      if (s.pingTurnAt > 0) {
        const mine = now - s.pingTurnAt <= PING_TURN_WINDOW_MS
        s.pingTurnAt = 0
        if (mine) {
          const read = u.cache_read_input_tokens
          const held = read > 0 && written < 0.1 * read
          const rates = ratesFor(s.lastModel)
          const usd = rates ? forkUsd(u, rates) : null
          s.lastPing = { at: now, read, write: written, usd, warm: held }
          s.pingsSinceTurn++
          const spend = spendTokens({ read, write: written, input: u.input_tokens, output: u.output_tokens })
          await addSpend($, s, now, spend)
          await note($, s, {
            kind: 'ping', read, write: written, input: u.input_tokens, output: u.output_tokens,
            warm: held, via: 'turn', spend,
            idleMin: s.lastTurnAt ? Math.round(idleMs / 60_000) : 0,
            limits: limitsOf((await $.session.usage()).rateLimits),
          })
          await keepRuntime($, s)
          refreshStatus($, s, now)
          return done
        }
      }

      // The proof: the first real request after a pinged break longer than the cache's life.
      if (s.pingsSinceTurn > 0 && idleMs > cacheLifeMs(s) && s.ctxAtTurn > PROOF_FLOOR_TOKENS) {
        const verdict = breakVerdict(s.ctxAtTurn, u.cache_read_input_tokens, written)
        const pings = `${s.pingsSinceTurn} ping${s.pingsSinceTurn === 1 ? '' : 's'}`
        await note($, s, {
          kind: 'break-check', verdict, idleMin: Math.round(idleMs / 60_000), pings: s.pingsSinceTurn,
          read: u.cache_read_input_tokens, write: written, prevCtx: s.ctxAtTurn,
        })
        const asked = s.proving ? 'the proof you asked for: ' : ''
        $.ui.log(verdict === 'extended'
          ? `warmproof: ${asked}proven, after ${fmtDuration(idleMs)} idle and ${pings} this message read ${fmtTok(u.cache_read_input_tokens)} from the cache`
          : `warmproof: ${asked}NOT proven, after ${fmtDuration(idleMs)} idle and ${pings} this message re-wrote ${fmtTok(written)} tokens; the pings did not hold the cache`)
        s.proving = false
        if (verdict === 'not-extended') {
          await benchVersion($, s, 'the first message after a pinged break re-wrote the context')
        }
      }

      const cause = rewroteMost
        ? coldCause({
          hasPrevTurn: s.lastTurnAt > 0, prevModel: s.prevTurnModel, model: s.lastModel,
          prevEffort: s.prevTurnEffort, effort: s.effort, compactedSince: s.compactedSinceTurn,
          idleMs, ttlMs: cacheLifeMs(s),
        })
        : undefined
      await note($, s, {
        kind: 'turn', read: u.cache_read_input_tokens, write: written, input: u.input_tokens, output: u.output_tokens,
        ctx: s.ctx, model: s.lastModel, idleMin: s.lastTurnAt ? Math.round(idleMs / 60_000) : null,
        ...(cause ? { cause } : {}), limits: limitsOf((await $.session.usage()).rateLimits),
      })

      if (s.lastTurnAt && idleMs >= 10 * 60_000) s.breaks.push(Math.round(idleMs / 60_000))
      s.lastTurnAt = now
      s.ctxAtTurn = s.ctx
      s.pingsSinceTurn = 0
      s.autoPingsSinceTurn = 0
      s.compactedSinceTurn = false
      s.prevTurnModel = s.lastModel
      s.prevTurnEffort = s.effort
      if (s.wakeAt !== null && s.wakeAt <= now) s.wakeAt = null

      if (rewroteMost || s.coldWritePending) {
        const rates = ratesFor(s.lastModel)
        const usd = rates ? (written * rates.cacheWrite1h) / 1e6 : null
        s.coldWrites.push({ at: now, tokens: written, usd })
        // Pinging never starts by itself unless that was asked for.
        if (conf().autoArmOnColdWrite && !s.headless && s.deadline < now + AFTER_COLD_WRITE_MS) {
          await startWindow($, s, AFTER_COLD_WRITE_MS, s.every)
          const dollars = conf().costUnit === 'usd' ? ` (${fmtUsd(usd)})` : ''
          $.ui.log(`warmproof: ${fmtTok(written)} tokens re-written${dollars}. Holding the cache for ` +
            `${fmtDuration(AFTER_COLD_WRITE_MS)} so it is not paid twice; /keepwarm off to stop.`)
        }
      }
    }
    s.coldWritePending = false
    if (s.deadline) await schedule($, s)
    else await scheduleAlert($, s)
    await keepRuntime($, s)
    refreshStatus($, s, now)
    return done
  })

  on('classic.Stop', async ($, e, next) => {
    const stopped = await next(e)
    if (s.headless) return stopped
    const now = await $.clock.now()
    // The TTL the cache really used, from the transcript's newest cache write.
    if (e.transcript_path && now - s.ttlCheckedAt >= TTL_RECHECK_MS) {
      s.ttlCheckedAt = now
      try {
        const tail = await askHost($, s, ['tail', '-c', '262144', e.transcript_path], 'read cache ttl')
        const seen = tail.exitCode === 0 ? ttlFromTail(tail.stdout) : null
        if (seen) {
          s.shortTtl = seen === '5m'
          s.ttlSource = 'transcript'
        }
      } catch {
        // An unknown TTL keeps the last one; a ping's own read check still catches a miss.
      }
    }
    try {
      const waiting = pendingWork((e.background_tasks ?? []) as readonly BackgroundTask[])
      if (waiting.length && conf().warmDuringBackgroundWork && !s.deadline) {
        s.fromBackground = true
        await startWindow($, s, conf().backgroundWarmMs, conf().everyMs)
        $.ui.log(`warmproof: keeping the cache warm while ${waiting.length} background ` +
          `task${waiting.length === 1 ? '' : 's'} run (up to ${fmtDuration(conf().backgroundWarmMs)})`)
      } else if (!waiting.length && s.fromBackground) {
        await stopWindow($, s, null)
      }
      await keepRuntime($, s)
    } catch {
      // Nothing here is worth holding up the end of a turn.
    }
    return stopped
  })

  // A ping asks for one word and must not act. Anything a non-main loop tries while one is in
  // flight is refused, so a ping can never run a tool on your behalf.
  on('tool.call', async ($, e, next) => {
    if (!denyToolDuringPing({ enabled: conf().denyToolsDuringPing, pinging: s.pinging, agentId: e.agentId })) {
      return next(e)
    }
    $.ui.log(`warmproof: refused ${e.tool} while a ping was in flight; a ping must not run tools`)
    await note($, s, { kind: 'request', via: 'fork', what: `denied tool ${e.tool} during a ping`, ok: false })
    return { deny: 'warmproof: a keep-warm ping must not call tools' }
  })

  // A wake-up this session booked will read the cache by itself, so a ping would be waste.
  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const called = await next(e)
    try {
      const out = called as { result?: { scheduledFor?: unknown; stopped?: unknown }; isError?: unknown }
      if (out.isError) return called
      if (e.stop || out.result?.stopped) s.wakeAt = null
      else if (typeof out.result?.scheduledFor === 'number') s.wakeAt = out.result.scheduledFor
      await keepRuntime($, s)
    } catch {
      // The wake-up is only an optimisation; a changed shape costs one ping.
    }
    return called
  })

  // A model switch reports the TTL the new cache uses; pings cannot hold a five-minute one.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const switched = await next(e)
    try {
      const ttl = (e as { cache_ttl?: unknown }).cache_ttl
      if (ttl === '5m' || ttl === '1h') {
        s.shortTtl = ttl === '5m'
        s.ttlSource = 'model-switch'
      }
    } catch {
      // The TTL is an optimisation; a model switch must go through regardless.
    }
    return switched
  })

  on('session.compact', async ($, e, next) => {
    let now = 0
    try {
      now = await $.clock.now()
    } catch {
      // Without a clock there is no way to know a window is live, so never hold the compaction.
      return next(e)
    }
    const idle = !s.turnRunning
    // Claude Code's own idle compaction arrives as trigger 'auto' with nothing running. A window
    // means the person asked for this context to be kept whole.
    const hold = !e.agentId && conf().blockIdleCompaction && e.trigger === 'auto' && idle && s.deadline > now
    if (!e.agentId) await note($, s, { kind: 'compact', trigger: e.trigger, idle, blocked: hold, ctx: s.ctx })
    if (hold) {
      return { skip: 'warmproof: a keep-warm window is on, so idle compaction is held until it ends (/keepwarm off to allow it)' }
    }
    const compacted = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.compactedSinceTurn = true
      s.ctx = 0
      s.guardShownFor = 0
      clearTimer(s, 'ping')
      if (s.deadline) await schedule($, s)
      await keepRuntime($, s)
    }
    return compacted
  })
}
