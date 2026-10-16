// WarmProof's suite. It is also the contract: the engine was written to satisfy these, not the
// other way round, so a change in behaviour has to be argued for here first.
//
// Organised by concern rather than by feature: the rules that need no engine, then what the mod
// refuses to do, then the window, the proof, the evidence, the phone, and the clocks it trusts.

import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, PromptSubmitInput, SessionStartInput, TurnCompleteInput } from 'claude-code'

import {
  appleScriptString, billingMode, breakMinutes, coldCause, denyToolDuringPing, digestDue,
  parseIdleSeconds, peakPlanUsage, projectPolicy, suggestWindowMs, ttlFromTail, weekKey, worthPinging,
} from '../hooks/policy'
import { configDir, fmtCost, inWorkHours, ntfyButtonsReady, ntfyRequest, parseClock, readConfig } from '../hooks/extras'
import { exportFrom } from '../hooks/views'
import { breakVerdict } from '../hooks/ledger'
import { learnedEveryMinutes, rivalsInFolder, sessionOfLogFile, sleptMinutes, summarise } from '../hooks/policy'
import { fmtDuration, parseDuration, ratesFor } from '../hooks/money'
import { typingNow } from '../hooks/policy'

tier('user')

const MINUTE = 60_000
// Fixed local wall-clock moments, so the working-hours rules read as written.
// 14 October 2026 is a Wednesday; the 17th a Saturday; the 19th a Monday.
const WED_10AM = new Date(2026, 9, 14, 10, 0).getTime()
const WED_6PM = new Date(2026, 9, 14, 18, 0).getTime()
const SAT_10AM = new Date(2026, 9, 17, 10, 0).getTime()
const MON_0931 = new Date(2026, 9, 19, 9, 31).getTime()

const PROFILE = '/Users/me/claude-alt'
// This instance's log file carries a random suffix, so tests find it rather than name it.
const ledgerPath = (files: FakeFiles, roll = '') =>
  [...files.keys()].find(path => new RegExp(`/warmproof/S1-[0-9a-f]{8}${roll}\\.jsonl$`).test(path)) ?? ''
const HOME_ONLY = { HOME: '/Users/me' }
const DEFAULT_ENV = { ...HOME_ONLY, CLAUDE_CONFIG_DIR: PROFILE }
const PHONE = { ntfyTopic: 'wp-alerts' }
const PHONE_BUTTONS = { ntfyTopic: 'wp-alerts', ntfyReplyTopic: 'wp-replies' }

const session: SessionStartInput = { surface: null, isInteractive: true, cwd: '/repos/my-app' }

let turnCount = 0
/** One finished turn of yours: by default a big warm read, as a real session would report. */
const turn = (read = 200000, write = 500): TurnCompleteInput => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: `t${++turnCount}`,
  reason: 'answer',
  usage: {
    input_tokens: 2,
    output_tokens: 10,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    model: 'claude-fable-5-1',
  },
})

const run = (command: 'keepwarm' | 'warmproof' | 'handoff', args = ''): CommandRunInput => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

type FakeFiles = Map<string, { text: string; mtimeMs: number }>

type Fixture = {
  env?: Record<string, string>
  files?: FakeFiles
  /** What each ping finds in the cache, in order; the default is a healthy warm read. */
  pings?: Array<{ read: number; write: number }>
  /** What a reply-topic poll returns. */
  replies?: { text: string }
  /** Make the first n polls fail with a 503. */
  failPolls?: { n: number }
  /** A ping that never answers, to exercise the deadline. */
  hangPings?: boolean
  /** A wake-up this session has booked. */
  wakeAt?: number
  /** A runtime slice to restore, as a reload would. */
  runtime?: unknown
  /** A transcript tail for the TTL reader. */
  tail?: string
  /** Seconds of keyboard idle for the away check. */
  idleSec?: number
  store?: Record<string, unknown>
  limits?: Array<{ kind: string; percentUsed: number }>
  /** Make $.ui.log throw, to prove a gating hook fails open. */
  breakLogs?: boolean
  /** What is typed in the prompt box but not yet sent. */
  draft?: string
}

/**
 * The world beneath the mod: environment, files, store, processes, network, and a fork that
 * answers either a ping or a handoff. Everything the mod did is recorded for the assertions.
 */
function world(on: On, fixture: Fixture = {}) {
  const env = fixture.env ?? DEFAULT_ENV
  const files: FakeFiles = fixture.files ?? new Map()
  const posts: Array<{ url: string; body: { topic?: string; message?: string; actions?: Array<{ label: string; url: string; body: string }> } }> = []
  const polls: string[] = []
  const forks: string[] = []
  const forkTtlEnv: Array<string | undefined> = []
  const compactions: string[] = []
  const logs: string[] = []
  const status: Array<string | undefined> = []
  const envWrites: Array<[string, string | undefined]> = []
  const commands: string[][] = []

  // The store, ours to inspect: mock.store answers the ops but returns no handle, so a test
  // could not assert what was written to it.
  const store = new Map<string, unknown>(Object.entries(fixture.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))

  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('env.set', ($, e) => {
    envWrites.push([e.name, e.value])
    if (e.value === undefined) delete env[e.name]
    else env[e.name] = e.value
    return { value: undefined }
  })

  on('process.run', ($, e) => {
    commands.push([...e.argv])
    const tool = e.argv[0]
    const stdout = tool === 'ioreg'
      ? (fixture.idleSec === undefined ? '' : `  "HIDIdleTime" = ${fixture.idleSec * 1e9}`)
      : tool === 'tail' ? (fixture.tail ?? '') : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('prompt.read', () => ({ value: { text: fixture.draft ?? '', cursor: 0 } }))
  on('config.list', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.version', () => ({ value: { version: '2.1.294', base: '2.1.294', builtAt: '2026-10-14' } }))
  on('session.usage', () => ({
    value: {
      startedAt: WED_10AM,
      context: { window: 1000000, tokens: undefined },
      rateLimits: (fixture.limits ?? []).map(limit => ({ ...limit, source: 'test' })),
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  // A plugin's own compaction reaches the bottom with only its arguments; the engine would
  // add the trigger and the messages itself.
  on('session.compact', ($, e) => {
    compactions.push(e.trigger ?? 'plugin')
    return { messages: e.messages ?? [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('tool.call', () => ({ result: { scheduledFor: fixture.wakeAt ?? 0, clampedDelaySeconds: 0, wasClamped: false } }))
  on('ui.log', ($, e) => {
    if (fixture.breakLogs) throw new Error('the terminal is gone')
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [''] }))

  on('http.fetch', ($, e) => {
    const isPost = e.init?.method === 'POST'
    if (isPost) posts.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}') })
    else polls.push(e.url)
    if (!isPost && fixture.failPolls && fixture.failPolls.n > 0) {
      fixture.failPolls.n--
      return { value: { status: 503, ok: false, headers: {}, text: '' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: isPost ? '{}' : (fixture.replies?.text ?? '') } }
  })

  on('fs.write', ($, e) => { files.set(e.path, { text: e.text, mtimeMs: Date.now() }); return { value: undefined } })
  on('fs.read', ($, e) => ({ value: files.get(e.path)?.text ?? '' }))
  on('fs.exists', ($, e) => ({ value: [...files.keys()].some(path => path === e.path || path.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => ({
    value: [...files.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`))
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))

  if (fixture.runtime !== undefined) on('state.get', () => ({ value: { value: fixture.runtime, version: 1 } }))

  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    forkTtlEnv.push(env['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'])
    const isNote = e.prompt.startsWith('Write the note a new session')
    if (fixture.hangPings && !isNote) return new Promise(() => {})
    const served = isNote ? { read: 200000, write: 0 } : (fixture.pings?.shift() ?? { read: 200000, write: 0 })
    const value: ModelForkResult = {
      isAnswered: true,
      text: isNote ? '## Where this stands\nShip WarmProof' : 'warm',
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_read_input_tokens: served.read,
        cache_creation_input_tokens: served.write,
      },
    }
    return { value }
  })

  return { posts, polls, forks, forkTtlEnv, compactions, logs, status, files, envWrites, commands, store }
}

/** The evidence rows this session wrote, parsed. */
const evidence = (files: FakeFiles, path = '') =>
  (files.get(path || ledgerPath(files))?.text ?? '').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { kind: string; [field: string]: unknown })

/** Seed another session's evidence file, for the reports that read across sessions. */
const seedEvidence = (files: FakeFiles, sid: string, rows: object[], mtimeMs = Date.now()) =>
  files.set(`${PROFILE}/warmproof/${sid}.jsonl`, { text: rows.map(row => JSON.stringify(row)).join('\n') + '\n', mtimeMs })

const breakRow = (idleMin: number, at = new Date(WED_10AM - 60 * MINUTE).toISOString()) =>
  ({ at, kind: 'turn', idleMin, read: 0, write: 0, input: 0, output: 0, ctx: 200000 })

// ============================================================ the rules that need no engine

describe('rules that stand on their own', () => {
  test('the working day is local, and weekends are outside it unless allowed', async () => {
    const cfg = readConfig({})
    expect(inWorkHours(new Date(WED_10AM), cfg)).toBe(true)
    expect(inWorkHours(new Date(WED_6PM), cfg)).toBe(true)
    // 18:30 is the end, and the end is exclusive.
    expect(inWorkHours(new Date(2026, 9, 14, 18, 30), cfg)).toBe(false)
    expect(inWorkHours(new Date(2026, 9, 14, 8, 59), cfg)).toBe(false)
    expect(inWorkHours(new Date(SAT_10AM), cfg)).toBe(false)
    expect(inWorkHours(new Date(SAT_10AM), readConfig({ workdaysOnly: false }))).toBe(true)
  })

  test('a clock string falls back when it is not a time', async () => {
    expect(parseClock('09:00', 0)).toBe(540)
    expect(parseClock('24:00', 0)).toBe(1440)
    expect(parseClock('9:5', 77)).toBe(77)
    expect(parseClock('25:00', 77)).toBe(77)
    expect(parseClock('12:60', 77)).toBe(77)
    expect(parseClock('', 77)).toBe(77)
  })

  test('the ping period can never reach the hour, and costs are tokens by default', async () => {
    expect(readConfig({ pingEveryMinutes: 90 }).everyMs).toBe(55 * MINUTE)
    expect(readConfig({ pingEveryMinutes: 0 }).everyMs).toBe(1 * MINUTE)
    expect(readConfig({}).costUnit).toBe('tokens')
    expect(fmtCost('tokens', 330316, 6.61)).toBe('330k tokens')
    expect(fmtCost('usd', 330316, 6.61)).toBe('$6.61')
    expect(fmtCost('usd', 1, null)).toBe('n/a')
  })

  test('an unknown choice falls back to the first one', async () => {
    expect(readConfig({ endOfWindow: 'nonsense' }).endOfWindow).toBe('nothing')
    expect(readConfig({ afterHours: 'keep-pinging' }).afterHours).toBe('keep-pinging')
    expect(readConfig({ costUnit: 'usd' }).costUnit).toBe('usd')
  })

  test('the profile folder follows CLAUDE_CONFIG_DIR, else HOME', async () => {
    expect(configDir(`${PROFILE}/`, '/Users/me')).toBe(PROFILE)
    expect(configDir(undefined, '/Users/me')).toBe('/Users/me/.claude')
    expect(configDir('  ', undefined)).toBe(null)
  })

  test('a phone topic must be URL-safe, and buttons need a second one', async () => {
    const server = { ntfyServer: 'https://ntfy.sh' }
    expect(ntfyRequest({ ...server, ntfyTopic: '' }, 't', 'm')).toBe(null)
    expect(ntfyRequest({ ...server, ntfyTopic: 'a/../b' }, 't', 'm')).toBe(null)
    expect(ntfyRequest({ ...server, ntfyTopic: 'wp-alerts' }, 't', 'm')).toEqual({
      url: 'https://ntfy.sh',
      body: JSON.stringify({ topic: 'wp-alerts', title: 't', message: 'm', tags: ['snowflake'] }),
    })
    expect(ntfyButtonsReady({ ntfyTopic: 'a', ntfyReplyTopic: 'a' })).toBe(false)
    expect(ntfyButtonsReady({ ntfyTopic: 'a', ntfyReplyTopic: 'b' })).toBe(true)
  })

  test('durations parse and print symmetrically', async () => {
    expect(parseDuration('90m')).toBe(90 * MINUTE)
    expect(parseDuration('3h')).toBe(180 * MINUTE)
    expect(parseDuration('2h30m')).toBe(150 * MINUTE)
    expect(parseDuration('later')).toBe(null)
    expect(parseDuration('')).toBe(null)
    expect(fmtDuration(45 * MINUTE)).toBe('45m')
    expect(fmtDuration(180 * MINUTE)).toBe('3h00m')
    expect(fmtDuration(70 * MINUTE)).toBe('1h10m')
    expect(fmtDuration(51 * 60 * MINUTE)).toBe('2d 3h')
  })

  test('a model is priced by family, longest name first', async () => {
    expect(ratesFor('claude-fable-5-1')?.cacheRead).toBe(0.25)
    expect(ratesFor('claude-fable-5')?.cacheRead).toBe(1)
    expect(ratesFor('claude-sonnet-5-5')?.cacheWrite1h).toBe(4)
    expect(ratesFor('something-else')).toBe(null)
    expect(ratesFor(null)).toBe(null)
  })

  test('the verdict needs both a read back and no re-write', async () => {
    expect(breakVerdict(200000, 200000, 0)).toBe('extended')
    expect(breakVerdict(200000, 0, 200000)).toBe('not-extended')
    // Read back too little counts as a failure even with nothing re-written.
    expect(breakVerdict(200000, 10000, 0)).toBe('not-extended')
  })

  test('a cold write is blamed on the first cause that fits', async () => {
    const base = { hasPrevTurn: true, prevModel: 'm', model: 'm', compactedSince: false, idleMs: 0, ttlMs: 60 * MINUTE }
    expect(coldCause({ ...base, hasPrevTurn: false })).toBe('session-start')
    expect(coldCause({ ...base, prevModel: 'a', model: 'b' })).toBe('model-changed')
    expect(coldCause({ ...base, prevEffort: 'high', effort: 'low' })).toBe('effort-changed')
    expect(coldCause({ ...base, compactedSince: true })).toBe('compaction')
    expect(coldCause({ ...base, idleMs: 61 * MINUTE })).toBe('ttl-expired')
    expect(coldCause(base)).toBe('other')
    // A model change outranks a clock that also ran out.
    expect(coldCause({ ...base, prevModel: 'a', model: 'b', idleMs: 61 * MINUTE })).toBe('model-changed')
  })

  test('the newest main-thread write decides the lifetime', async () => {
    const written = (ttl: '1h' | '5m', sidechain = false) => JSON.stringify({
      isSidechain: sidechain,
      message: { usage: { cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? 500 : 0, ephemeral_5m_input_tokens: ttl === '5m' ? 500 : 0 } } },
    })
    // A torn first line is normal in a tail and must not stop the walk back.
    expect(ttlFromTail(`{"cut line\n${written('1h')}\n${written('5m')}`)).toBe('5m')
    // A subagent's write says nothing about your own cache.
    expect(ttlFromTail(`${written('5m')}\n${written('1h')}\n${written('5m', true)}`)).toBe('1h')
    expect(ttlFromTail('{"no":"usage"}')).toBe(null)
  })

  test('each backend is named, and a plain session is a subscription', async () => {
    expect(billingMode({})).toBe('subscription')
    expect(billingMode({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('bedrock')
    expect(billingMode({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe('vertex')
    expect(billingMode({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe('foundry')
    expect(billingMode({ ANTHROPIC_API_KEY: 'key' })).toBe('api-key')
    expect(billingMode({ ANTHROPIC_AUTH_TOKEN: 'token' })).toBe('api-key')
    expect(billingMode({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe('relay')
    // "Off" values, an empty key and the real endpoint are not metered backends.
    expect(billingMode({ CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_API_KEY: '' })).toBe('subscription')
    expect(billingMode({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe('subscription')
  })

  test('the plan limit closest to its ceiling is the one that counts', async () => {
    expect(peakPlanUsage(undefined)).toBe(null)
    expect(peakPlanUsage([])).toBe(null)
    expect(peakPlanUsage([{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 81 }]))
      .toEqual({ kind: 'seven_day', percentUsed: 81 })
  })

  test('a window is learned only from a real habit', async () => {
    expect(suggestWindowMs([90, 95, 120, 20, 30])).toBe(2 * 60 * MINUTE)
    expect(suggestWindowMs([70, 80])).toBe(null)
    expect(breakMinutes([
      { at: new Date(WED_10AM).toISOString(), kind: 'turn', idleMin: 5 },
      { at: new Date(WED_10AM).toISOString(), kind: 'turn', idleMin: 45 },
    ], 0)).toEqual([45])
  })

  test('a ping pays only while you might still be back inside the hour', async () => {
    expect(worthPinging([15, 20, 25, 30, 35], 50)).toBe(false)
    expect(worthPinging([70, 75, 80, 90, 100], 50)).toBe(true)
    expect(worthPinging([70], 50)).toBe(null)
  })

  test('a folder takes the deepest policy that contains it', async () => {
    expect(projectPolicy({ '/repos': 'always', '/repos/my-app': 'never' }, '/repos/my-app')).toBe('never')
    expect(projectPolicy({ '/repos': 'always', '/repos/my-app': 'never' }, '/repos/other')).toBe('always')
    // A longer name that merely starts the same way is a different folder.
    expect(projectPolicy({ '/repos': 'always' }, '/reposity')).toBe('auto')
    expect(projectPolicy({}, '/repos/my-app')).toBe('auto')
  })

  test('a digest is due once a week, and still goes out late', async () => {
    expect(weekKey(new Date(2026, 9, 21, 15, 0))).toBe('2026-10-19')
    expect(digestDue(new Date(MON_0931), null, 1, 9 * 60 + 30)).toBe(true)
    expect(digestDue(new Date(2026, 9, 19, 9, 0), null, 1, 9 * 60 + 30)).toBe(false)
    expect(digestDue(new Date(MON_0931), '2026-10-19', 1, 9 * 60 + 30)).toBe(false)
    // Thursday, with Monday's digest never sent: still owed.
    expect(digestDue(new Date(2026, 9, 22, 8, 0), '2026-10-12', 1, 9 * 60 + 30)).toBe(true)
  })

  test('a ping may not run a tool, and only a ping is stopped', async () => {
    const mid = { enabled: true, pinging: true, agentId: 'a1' }
    expect(denyToolDuringPing(mid)).toBe(true)
    // The main loop carries no agent id, so your own tools survive a ping during a long turn.
    expect(denyToolDuringPing({ ...mid, agentId: undefined })).toBe(false)
    expect(denyToolDuringPing({ ...mid, pinging: false })).toBe(false)
    expect(denyToolDuringPing({ ...mid, enabled: false })).toBe(false)
  })

  test('a quote in a message cannot break out of the AppleScript string', async () => {
    expect(appleScriptString('a "b" \\ c\nd')).toBe('a \\"b\\" \\\\ c d')
    expect(parseIdleSeconds('  "HIDIdleTime" = 1500000000000')).toBe(1500)
    expect(parseIdleSeconds('nothing here')).toBe(null)
  })
})

// ============================================================ what it refuses to do

describe('what it refuses to do', () => {
  test('a cold write of its own accord never starts pinging', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * 60 * MINUTE)
    const held = await $.prompt.submit(typed('recap'))
    expect('drop' in held ? held.drop : '').not.toMatch(/keepwarm will/)
    await $.prompt.submit(typed('recap'))
    await $.turn.complete(turn(0, 200000))
    await clock.advance(60 * MINUTE)
    expect(w.forks).toHaveLength(0)
  })

  test('a cold send is priced in tokens, with no dollars in sight', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * 60 * MINUTE)
    const dropped = await $.prompt.submit(typed('recap'))
    const text = 'drop' in dropped ? dropped.drop : ''
    expect(text).toMatch(/re-writes up to 200,502 tokens \(a warm turn would only have read them from the cache\)/)
    expect(text).not.toMatch(/\$/)
  })

  test('the second send of the same message goes through', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * 60 * MINUTE)
    expect('drop' in (await $.prompt.submit(typed('recap')))).toBe(true)
    expect('drop' in (await $.prompt.submit(typed('recap')))).toBe(false)
  })

  test('a ping that misses pauses every session on this build until unbenched', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { pings: [{ read: 0, write: 200000 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MINUTE)
    expect(w.logs.some(line => /pings paused for Claude Code 2\.1\.294, a ping missed the cache/.test(line))).toBe(true)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: paused for Claude Code 2\.1\.294/)
    await $.command.run(run('warmproof', 'unbench'))
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(2)
  })

  test('the ping cap closes the window', { options: { maxPingsPerIdle: 2 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(150 * MINUTE)
    expect(w.forks).toHaveLength(2)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: 2 pings without a real turn/)
  })

  test('the kill switch file stops everything', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map([[`${PROFILE}/warmproof-off`, { text: '', mtimeMs: 1 }]])
    const w = world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(new RegExp(`kill switch file ${PROFILE}/warmproof-off`))
  })

  test('a headless session is never pinged', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start({ ...session, isInteractive: false })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(60 * MINUTE)
    expect(w.forks).toHaveLength(0)
  })

  test('a five-minute cache cannot be held, however it was found', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/5-minute cache/)
  })

  test('a metered backend is refused by name, unless overridden', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, ANTHROPIC_API_KEY: 'key' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/bills per token \(api-key\)/)
    expect(evidence(w.files)[0]).toMatchObject({ kind: 'start', billing: 'api-key' })
  })

  test('the override pings on a metered backend anyway', { options: { pingOnMeteredBilling: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, ANTHROPIC_API_KEY: 'key' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('the daily budget stops pinging once it is used', { options: { dailyPingBudget: 20000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(100 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(w.status.at(-1)).toMatch(/today's ping budget is used \(20k of 20k/)
  })

  test('plan usage above the line pauses pinging', { options: { pauseAbovePlanPercent: 80 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { limits: [{ kind: 'seven_day', percentUsed: 85 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/plan usage is at 85% of your seven-day limit, above the 80%/)
  })

  test('plan usage below the line changes nothing', { options: { pauseAbovePlanPercent: 80 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { limits: [{ kind: 'seven_day', percentUsed: 42 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('your past breaks can veto a ping', { options: { pingOnlyIfWorthIt: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'OLD1', [15, 20, 25, 30, 35].map(minutes => breakRow(minutes)))
    const w = world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/unlikely to be back within the hour/)
  })

  test('a folder set to never is never pinged', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map([[`${PROFILE}/warmproof-projects.json`, { text: JSON.stringify({ '/repos/my-app': 'never' }), mtimeMs: 1 }]])
    const w = world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/pings are off for this project/)
  })
})

// ============================================================ the window

describe('the window', () => {
  test('a window pings inside working hours', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('keepwarm', '2h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MINUTE)
    expect(w.forks).toEqual(['Reply with the single word: warm'])
    expect(w.status.at(-1)).toMatch(/last ping read 200k$/)
  })

  test('for and until set the length, and nonsense is refused', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', 'for 3h'))).text).toMatch(/keepwarm on for 3h00m/)
    expect((await $.command.run(run('keepwarm', 'until 18:00'))).text).toMatch(/keepwarm on for 8h00m/)
    expect((await $.command.run(run('keepwarm', 'until 25:00'))).text).toMatch(/until takes a time/)
    expect((await $.command.run(run('keepwarm', 'sometime'))).text).toMatch(/keepwarm takes a window/)
  })

  test('auto uses the length your own breaks justify', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'OLD1', [breakRow(90), breakRow(95), breakRow(120), breakRow(20)])
    world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', 'auto'))).text).toMatch(/^keepwarm on for 2h00m, .* \(learned from your breaks\)$/)
    expect((await $.command.run(run('warmproof', 'breaks'))).text)
      .toMatch(/4 breaks of 10m\+ in 14 days, 3 over an hour; \/keepwarm auto holds 2h00m/)
  })

  test('off stops it, and always arms every session start', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', 'always'))).text).toMatch(/keepwarm always on/)
    expect((await $.command.run(run('keepwarm', 'off'))).text).toBe('keepwarm is off, and no longer arms itself at session start')
    expect((await $.command.run(run('keepwarm', 'status'))).text).toMatch(/^cache|keepwarm is off/)
  })

  test('a folder set to always opens a window at session start', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map([[`${PROFILE}/warmproof-projects.json`, { text: JSON.stringify({ '/repos': 'always' }), mtimeMs: 1 }]])
    const w = world(on, { files })
    await $.session.start(session)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toMatch(/^keepwarm 6h00m left/)
    expect((await $.command.run(run('warmproof', 'project never'))).text).toBe('my-app is now never, no pings here')
    expect(JSON.parse(w.files.get(`${PROFILE}/warmproof-projects.json`)?.text ?? '{}'))
      .toEqual({ '/repos': 'always', '/repos/my-app': 'never' })
  })

  test('a self-wake makes the ping wait until after it', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { wakeAt: WED_10AM + 54 * MINUTE })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w1', delaySeconds: 3240 })
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    await clock.advance(6 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('background work opens a window when asked, and its end closes it', { options: { warmDuringBackgroundWork: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't0', type: 'subagent', status: 'running', description: 'subagent' }] })
    expect(w.logs.some(line => /keeping the cache warm while 1 background task run/.test(line))).toBe(true)
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await clock.advance(60 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('background work is ignored by default', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't0', type: 'subagent', status: 'running', description: 'subagent' }] })
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
  })

  test('the end of a window can compact while still warm', { options: { endOfWindow: 'compact', compactMinTokens: 100000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '30m'))
    await clock.advance(31 * MINUTE)
    expect(w.compactions).toEqual(['plugin'])
    expect(w.status.at(-1)).toBe('keepwarm stopped: window ended, compacted while warm')
  })

  test('a context below the threshold is left alone at the end', { options: { endOfWindow: 'compact', compactMinTokens: 500000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '30m'))
    await clock.advance(31 * MINUTE)
    expect(w.status.at(-1)).toMatch(/^cache 29m left · cold resume 201k tokens$/)
  })

  test('a long turn is pinged only when asked', { options: { warmDuringLongTurns: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.start({ text: 'run the long suite', turnId: 'long1' })
    await clock.advance(50 * MINUTE)
    expect(w.forks).toEqual(['Reply with the single word: warm'])
    expect(evidence(w.files).find(row => row.kind === 'ping')).toMatchObject({ during: 'turn', warm: true })
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('a long turn is left alone by default', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.start({ text: 'run the long suite', turnId: 'long1' })
    await clock.advance(55 * MINUTE)
    expect(w.forks).toHaveLength(0)
  })

  test('a hung ping gives up and says it may still have been billed', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { hangPings: true })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    await clock.advance(2 * MINUTE)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the ping did not answer within 2m; it may still have been billed')
    expect(evidence(w.files).find(row => row.kind === 'request')).toMatchObject({ via: 'fork', what: 'ping', ok: false, timedOut: true })
  })

  test('the one-hour setting is given to a ping only when asked, then put back', { options: { pingSubagentTtl1h: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forkTtlEnv).toEqual(['1h'])
    expect(w.envWrites).toEqual([
      ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h'],
      ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', undefined],
    ])
  })

  test('by default that setting is never touched', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forkTtlEnv).toEqual([undefined])
    expect(w.envWrites).toEqual([])
  })
})

// ============================================================ the proof

describe('the proof', () => {
  test('a break the pings carried is logged as extended', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    await clock.advance(20 * MINUTE)
    await $.turn.complete(turn(200000, 600))
    const rows = evidence(w.files)
    expect(rows.map(row => row.kind)).toEqual(['start', 'turn', 'request', 'ping', 'break-check', 'turn'])
    expect(rows[0]).toMatchObject({ version: '2.1.294', billing: 'subscription' })
    expect(rows[2]).toMatchObject({ via: 'fork', what: 'ping', ok: true, read: 200000 })
    expect(rows[3]).toMatchObject({ warm: true, idleMin: 50 })
    expect(rows[4]).toMatchObject({ verdict: 'extended', pings: 1, idleMin: 70 })
    expect(w.logs.at(-1)).toBe('warmproof: proven, after 1h10m idle and 1 ping this message read 200k from the cache')
  })

  test('a break the pings lost is logged as not extended, and pauses the build', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(70 * MINUTE)
    await $.turn.complete(turn(0, 200000))
    expect(evidence(w.files).find(row => row.kind === 'break-check')).toMatchObject({ verdict: 'not-extended' })
    expect(w.logs.some(line => /NOT proven/.test(line))).toBe(true)
    expect(w.logs.some(line => /pings paused for Claude Code 2\.1\.294, the first message after a pinged break re-wrote the context/.test(line))).toBe(true)
  })

  test('no ping, or no real break, means no verdict either way', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MINUTE)
    await $.turn.complete(turn())
    await clock.advance(90 * MINUTE)
    await $.turn.complete(turn(0, 200000))
    expect(evidence(w.files).some(row => row.kind === 'break-check')).toBe(false)
  })

  test('a ping on request reports what the cache served, now', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    const answer = await $.command.run(run('warmproof', 'ping'))
    expect(answer.text).toBe('warm. The ping read 200k from the cache and wrote 0, 20k input-equivalent tokens spent; the hour restarts now')
    expect(w.forks).toEqual(['Reply with the single word: warm'])
    expect(evidence(w.files).find(row => row.kind === 'ping')).toMatchObject({ warm: true })
  })

  test('a ping on request that misses says so and pauses the build', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on, { pings: [{ read: 0, write: 200000 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'ping'))).text).toMatch(/^NOT warm\./)
    expect(w.logs.some(line => /a ping on request missed the cache/.test(line))).toBe(true)
  })

  test('a ping on request is refused when it could not help', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    expect((await $.command.run(run('warmproof', 'ping'))).text).toMatch(/nothing to ping yet/)
    await $.turn.complete(turn())
    await clock.advance(70 * MINUTE)
    expect((await $.command.run(run('warmproof', 'ping'))).text).toMatch(/the cache went cold 10m ago/)
    expect(w.forks).toHaveLength(0)
  })

  test('a ping on request still obeys the kill switch', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map([[`${PROFILE}/warmproof-off`, { text: '', mtimeMs: 1 }]])
    const w = world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'ping'))).text).toMatch(/^no ping, kill switch file/)
    expect(w.forks).toHaveLength(0)
  })
})

// ============================================================ the evidence

describe('the evidence', () => {
  test('a ping records its spend and the plan usage behind it', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { limits: [{ kind: 'five_hour', percentUsed: 42 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '1h'))
    await clock.advance(50 * MINUTE)
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(80 * MINUTE)
    await $.prompt.submit(typed('back'))
    await $.prompt.submit(typed('back'))
    await $.turn.complete(turn(0, 200000))
    const rows = evidence(w.files)
    expect(rows.find(row => row.kind === 'ping')).toMatchObject({ spend: 20007, limits: { five_hour: 42 } })
    expect(rows.filter(row => row.kind === 'turn').at(-1)).toMatchObject({ cause: 'ttl-expired' })
  })

  test('the report adds up what was spent and what was proved', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(70 * MINUTE)
    await $.turn.complete(turn(200000, 600))
    const text = (await $.command.run(run('warmproof', 'report'))).text
    expect(text).toMatch(/^warmproof report, last 7 days/)
    expect(text).toMatch(/pings {8}1 \(1 warm\)/)
    expect(text).toMatch(/proof {8}1 break checks: 1 proven, 0 not proven/)
    expect(text).toMatch(/kept {9}201k tokens/)
    expect(w.forks).toHaveLength(1)
  })

  test('with no profile folder nothing is written and nothing breaks', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: {} })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(w.files.size).toBe(0)
  })

  test('the log rolls over instead of growing without limit', { options: { evidenceMaxKb: 1 } }, async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    for (let i = 0; i < 12; i++) await $.turn.complete(turn())
    const rolled = w.files.get(ledgerPath(w.files, '.1'))?.text ?? ''
    const live = w.files.get(ledgerPath(w.files))?.text ?? ''
    expect(rolled.length).toBeGreaterThan(0)
    // Nothing is torn across the roll: every line on both sides is still whole JSON.
    for (const line of (rolled + live).trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
  })

  test('zero never rolls', { options: { evidenceMaxKb: 0 } }, async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    for (let i = 0; i < 12; i++) await $.turn.complete(turn())
    expect(ledgerPath(w.files, '.1')).toBe('')
  })

  test('forget asks first, then empties the logs and drops the keys', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on, { store: { bench: { version: '2.1.294', reason: 'a ping missed the cache' } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'forget'))).text).toMatch(/forget confirm clears/)
    expect(evidence(w.files).length).toBeGreaterThan(0)
    expect((await $.command.run(run('warmproof', 'forget confirm'))).text)
      .toMatch(/^emptied 1 evidence file and dropped \d+ stored keys?$/)
    expect(w.files.get(ledgerPath(w.files))?.text).toBe('')
  })

  test('sessions lists this profile, newest turn first', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'aaaaaaaa-1111', [
      { at: new Date(WED_10AM - 30 * MINUTE).toISOString(), kind: 'start', cwd: '/repos/other-app' },
      { at: new Date(WED_10AM - 20 * MINUTE).toISOString(), kind: 'turn', ctx: 340000 },
    ])
    const w = world(on, { files })
    await $.session.start(session)
    const text = (await $.command.run(run('warmproof', 'sessions'))).text
    expect(text).toMatch(/aaaaaaaa {2}other-app {2}last turn \d\d:\d\d {2}ctx 340k {2}no window/)
    expect(text).toMatch(/S1 {2}my-app {2}no turn yet {2}ctx 0 {2}no window {2}\(this one\)/)
    expect(w.forks).toHaveLength(0)
  })

  test('the card names where the cache lifetime came from', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const written = JSON.stringify({ message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } } } })
    world(on, { tail: `${written}\n` })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof'))).text).toMatch(/1h cache, assumed, not yet observed/)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/S1.jsonl', background_tasks: [] })
    expect((await $.command.run(run('warmproof'))).text).toMatch(/1h cache, seen in the transcript/)
  })

  test('the transcript is read at most once in ten minutes', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const written = JSON.stringify({ message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } } } })
    const w = world(on, { tail: `${written}\n` })
    await $.session.start(session)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/S1.jsonl', background_tasks: [] })
    expect(w.commands[0]).toEqual(['tail', '-c', '262144', '/t/S1.jsonl'])
    await clock.advance(5 * MINUTE)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/S1.jsonl', background_tasks: [] })
    expect(w.commands).toHaveLength(1)
    await clock.advance(6 * MINUTE)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/S1.jsonl', background_tasks: [] })
    expect(w.commands).toHaveLength(2)
  })

  test('a five-minute write in the transcript stops pinging', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const written = JSON.stringify({ message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 } } } })
    const w = world(on, { tail: `${written}\n` })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/S1.jsonl', background_tasks: [] })
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/5-minute cache/)
  })

  test('a model switch reporting five minutes stops pinging', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    on('classic.PostModelSwitch', () => ({}))
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.PostModelSwitch({
      from_model: 'claude-fable-5-1', to_model: 'claude-sonnet-5-5', requested_model: null, source: 'command',
      context_tokens: 200000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1, pricing: 'catalog',
    })
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/5-minute cache/)
  })

  test('the countdown shows what a cold resume would cost, until it is off', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('cache 1h00m left · cold resume 201k tokens')
    await clock.advance(61 * MINUTE)
    expect(w.status.at(-1)).toBe('cache cold · the next message re-writes 201k tokens')
  })

  test('the countdown can be turned off', { options: { showCountdown: false } }, async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBeUndefined()
  })
})

// ============================================================ idle compaction

describe('idle compaction', () => {
  const summary = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

  test('held while a window is on, allowed once it is off', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    const held = await $.session.compact({ trigger: 'auto', messages: summary })
    expect('skip' in held ? held.skip : '').toMatch(/keep-warm window is on/)
    await $.command.run(run('keepwarm', 'off'))
    expect('skip' in (await $.session.compact({ trigger: 'auto', messages: summary }))).toBe(false)
    expect(evidence(w.files).filter(row => row.kind === 'compact').map(row => row.blocked)).toEqual([true, false])
  })

  test('a compaction you asked for is never held', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect('skip' in (await $.session.compact({ trigger: 'manual', messages: summary }))).toBe(false)
  })

  test('the hold can be turned off', { options: { blockIdleCompaction: false } }, async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect('skip' in (await $.session.compact({ trigger: 'auto', messages: summary }))).toBe(false)
  })
})

// ============================================================ the handoff

describe('the handoff note', () => {
  test('after hours a ping becomes a note, and the window stops', async ($, on) => {
    const clock = mock.clock(on, { now: WED_6PM })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(w.forks[0]).toMatch(/^Write the note a new session/)
    const note = w.files.get(`${PROFILE}/handoffs/S1.md`)
    expect(note?.text).toMatch(/^<!-- session S1 · \/repos\/my-app · /)
    expect(note?.text).toMatch(/## Where this stands\nShip WarmProof\n$/)
    expect(w.status.at(-1)).toBe(`keepwarm stopped: outside working hours, handoff saved: ${PROFILE}/handoffs/S1.md`)
    await clock.advance(60 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('keep-pinging ignores the clock entirely', { options: { afterHours: 'keep-pinging' } }, async ($, on) => {
    const clock = mock.clock(on, { now: SAT_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('keepwarm', '2h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MINUTE)
    expect(w.forks).toEqual(['Reply with the single word: warm'])
  })

  test('without CLAUDE_CONFIG_DIR the note goes under HOME', async ($, on) => {
    const clock = mock.clock(on, { now: WED_6PM })
    const w = world(on, { env: HOME_ONLY })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MINUTE)
    expect([...w.files.keys()].filter(path => path.includes('/handoffs/'))).toEqual(['/Users/me/.claude/handoffs/S1.md'])
  })

  test('/handoff writes one now, and load brings the newest back', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map([[`${PROFILE}/handoffs/OLD.md`, { text: 'an older note', mtimeMs: 1 }]])
    const w = world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('handoff'))).text).toBe(`handoff saved to ${PROFILE}/handoffs/S1.md`)
    const loaded = await $.command.run(run('handoff', 'load'))
    expect(loaded.text).toBe(`loaded ${PROFILE}/handoffs/S1.md`)
    expect('context' in loaded ? loaded.context?.[0] : '').toMatch(/Ship WarmProof/)
    const byName = await $.command.run(run('handoff', 'load OLD'))
    expect('context' in byName ? byName.context?.[0] : '').toMatch(/an older note$/)
    expect(w.forks).toHaveLength(1)
  })

  test('load with nothing saved says so', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    expect((await $.command.run(run('handoff', 'load'))).text).toBe('no handoffs folder yet')
  })

  test('a note counts against the daily budget', { options: { dailyPingBudget: 20000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('handoff'))
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(w.status.at(-1)).toMatch(/today's ping budget is used/)
  })
})

// ============================================================ the phone

describe('the phone', () => {
  test('no topic, no alert', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(60 * MINUTE)
    expect(w.posts).toHaveLength(0)
  })

  test('one alert before expiry, carrying the folder name only', { options: PHONE }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(54 * MINUTE)
    expect(w.posts).toHaveLength(0)
    await clock.advance(1 * MINUTE)
    expect(w.posts).toHaveLength(1)
    expect(w.posts[0]?.url).toBe('https://ntfy.sh')
    expect(w.posts[0]?.body.topic).toBe('wp-alerts')
    expect(w.posts[0]?.body.message).toMatch(/Cache goes cold in 5m in my-app \(201k tokens to re-write\)/)
    expect(w.posts[0]?.body.message).not.toMatch(/\/repos\//)
    expect(w.posts[0]?.body.actions).toBeUndefined()
    expect(w.forks).toHaveLength(0)
  })

  test('no alert while a window holds it, nor before a newer turn is due', { options: PHONE }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MINUTE)
    await $.turn.complete(turn())
    await clock.advance(30 * MINUTE)
    expect(w.posts).toHaveLength(0)
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(60 * MINUTE)
    expect(w.posts).toHaveLength(0)
  })

  test('outside working hours the alert stays quiet', { options: PHONE }, async ($, on) => {
    const clock = mock.clock(on, { now: SAT_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(60 * MINUTE)
    expect(w.posts).toHaveLength(0)
  })

  test('Keep warm 2h arms a window, spends its whole group, and confirms', { options: PHONE_BUTTONS }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const replies = { text: '' }
    const w = world(on, { replies })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    const actions = w.posts[0]?.body.actions ?? []
    expect(actions.map(action => action.label)).toEqual(['Keep warm 2h', 'Compact', 'Leave'])
    expect(actions[0]?.url).toBe('https://ntfy.sh/wp-replies')
    const tap = (index: number) => JSON.stringify({ event: 'message', message: actions[index]?.body ?? '' })
    // Two taps arrive together; only the first may act.
    replies.text = `${tap(0)}\n${tap(1)}`
    await clock.advance(20 * 1000)
    expect(w.status.at(-1)).toMatch(/^keepwarm 2h00m left/)
    expect(w.posts.at(-1)?.body.message).toBe('Keeping my-app warm for 2h.')
    expect(w.compactions).toEqual([])
    expect(evidence(w.files).filter(row => row.kind === 'phone').map(row => row.action)).toEqual(['warm2h'])
  })

  test('Compact compacts while still warm, and confirms', { options: PHONE_BUTTONS }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const replies = { text: '' }
    const w = world(on, { replies })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    replies.text = JSON.stringify({ event: 'message', message: w.posts[0]?.body.actions?.[1]?.body ?? '' })
    await clock.advance(20 * 1000)
    expect(w.compactions).toEqual(['plugin'])
    expect(w.posts.at(-1)?.body.message).toBe('Compacted my-app while warm.')
  })

  test('a tap after the cache has gone does nothing at all', { options: PHONE_BUTTONS }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const replies = { text: '' }
    const w = world(on, { replies })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    const button = w.posts[0]?.body.actions?.[0]?.body ?? ''
    await clock.advance(6 * MINUTE)
    replies.text = JSON.stringify({ event: 'message', message: button })
    await clock.advance(20 * 1000)
    expect(w.posts).toHaveLength(1)
    expect(evidence(w.files).some(row => row.kind === 'phone')).toBe(false)
  })

  test('a failed poll is logged, and the next one still works', { options: PHONE_BUTTONS }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const replies = { text: '' }
    const w = world(on, { replies, failPolls: { n: 1 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    replies.text = JSON.stringify({ event: 'message', message: w.posts[0]?.body.actions?.[2]?.body ?? '' })
    await clock.advance(20 * 1000)
    expect(evidence(w.files).some(row => row.kind === 'phone')).toBe(false)
    expect(evidence(w.files).find(row => row.kind === 'request' && row.what === 'poll phone replies'))
      .toMatchObject({ ok: false, status: 503 })
    await clock.advance(20 * 1000)
    expect(evidence(w.files).filter(row => row.kind === 'phone').map(row => row.action)).toEqual(['leave'])
  })

  test('at the Mac it is a desktop notice, away it is the phone', { options: { ...PHONE, desktopNotify: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { idleSec: 30 })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    expect(w.posts).toHaveLength(0)
    const script = w.commands.find(argv => argv[0] === 'osascript')
    expect(script?.[2]).toBe('display notification "Cache goes cold in 5m in my-app (201k tokens to re-write). Run /keepwarm to hold it." with title "WarmProof"')
    expect(evidence(w.files).find(row => row.kind === 'notify')).toMatchObject({ channel: 'desktop', away: false })
  })

  test('away, the phone gets it instead', { options: { ...PHONE, desktopNotify: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { idleSec: 900 })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    expect(w.posts).toHaveLength(1)
    expect(w.commands.some(argv => argv[0] === 'osascript')).toBe(false)
  })

  test('the weekly digest goes out once, to the phone and a file', { options: { ...PHONE, weeklyDigest: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: MON_0931 })
    const w = world(on)
    await $.session.start(session)
    await clock.advance(61 * 1000)
    const digests = () => w.posts.map(post => post.body.message ?? '').filter(message => message.startsWith('warmproof report'))
    expect(digests()).toHaveLength(1)
    expect(w.files.get(`${PROFILE}/warmproof/digest-2026-10-19.md`)?.text).toMatch(/^warmproof report, last 7 days/)
    await clock.advance(10 * MINUTE)
    expect(digests()).toHaveLength(1)
  })
})

// ============================================================ other sessions, and reloads

describe('other sessions, and reloads', () => {
  test('an away plan set elsewhere is picked up within the minute', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { store: { leave: { id: 'L1', until: WED_10AM + 2 * 60 * MINUTE } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(61 * 1000)
    expect(evidence(w.files).find(row => row.kind === 'leave')).toBeTruthy()
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('leave arms this session and records the plan', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'leave 2h'))).text).toMatch(/^away for 2h00m/)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toMatch(/^keepwarm 2h00m left/)
    expect((await $.command.run(run('warmproof', 'leave soon'))).text).toMatch(/takes a length/)
  })

  test('a restored turn and ping count still produce a verdict', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const runtime = {
      lastTurnAt: WED_10AM - 70 * MINUTE, ctxAtTurn: 200000, pingsSinceTurn: 1, wakeAt: null,
      bgWindow: false, compactedSinceTurn: false, prevTurnModel: 'claude-fable-5-1',
      prevTurnEffort: null, handoffPath: null, phone: [], phoneSince: 0,
    }
    const w = world(on, { runtime })
    await $.session.start(session)
    await clock.advance(1000)
    await $.turn.complete(turn(200000, 600))
    expect(evidence(w.files).find(row => row.kind === 'break-check'))
      .toMatchObject({ verdict: 'extended', pings: 1, idleMin: 70 })
  })

  test('restored phone buttons are polled again and still honoured', { options: PHONE_BUTTONS }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const runtime = {
      lastTurnAt: 0, ctxAtTurn: 0, pingsSinceTurn: 0, wakeAt: null, bgWindow: false,
      compactedSinceTurn: false, prevTurnModel: null, prevTurnEffort: null, handoffPath: null,
      phone: [['tok1', { action: 'leave', group: 'g1', exp: WED_10AM + 30 * MINUTE }]], phoneSince: 0,
    }
    const replies = { text: JSON.stringify({ event: 'message', message: JSON.stringify({ warmproof: 'tok1' }) }) }
    const w = world(on, { runtime, replies })
    await $.session.start(session)
    await clock.advance(20 * 1000)
    expect(w.polls[0]).toBe('https://ntfy.sh/wp-replies/json?poll=1&since=0')
    expect(evidence(w.files).filter(row => row.kind === 'phone').map(row => row.action)).toEqual(['leave'])
  })
})

// ============================================================ failing open

describe('failing open', () => {
  test('a guard that cannot speak still lets the message through', { options: { } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { breakLogs: true, store: { guard: 'warn' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * 60 * MINUTE)
    // Warn mode prices the cold send through $.ui.log; when that throws, the message must
    // still go out rather than be swallowed by the guard.
    expect('drop' in (await $.prompt.submit(typed('recap')))).toBe(false)
    expect(w.logs).toHaveLength(0)
  })

  test('a tool call outside a ping is untouched', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect('deny' in (await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w1', delaySeconds: 60 }))).toBe(false)
    expect(w.logs.some(line => /refused/.test(line))).toBe(false)
  })

  test('a slash command is never treated as a cold send', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * 60 * MINUTE)
    expect('drop' in (await $.prompt.submit(typed('/compact')))).toBe(false)
  })
})

describe('a message you are already typing', () => {
  test('text in the prompt box means the idle ping is not needed', async () => {
    expect(typingNow('half a thought')).toBe(true)
    expect(typingNow('   ')).toBe(false)
    expect(typingNow('')).toBe(false)
  })

  test('the idle ping stands down while you type', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { draft: 'what about the retry path' })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(0)
    expect(w.status.at(-1)).toMatch(/part-way through typing/)
  })

  test('a ping you asked for is sent even mid-sentence', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on, { draft: 'still typing' })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'ping'))).text).toMatch(/^warm\./)
    expect(w.forks).toHaveLength(1)
  })
})

// ============================================================ the four review findings

describe('the review findings stay fixed', () => {
  test('Leave lets it cool, and the next tick does not re-arm it', { options: PHONE_BUTTONS }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const replies = { text: '' }
    const w = world(on, { replies })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MINUTE)
    replies.text = JSON.stringify({ event: 'message', message: w.posts[0]?.body.actions?.[2]?.body ?? '' })
    await clock.advance(20 * 1000)
    expect(evidence(w.files).filter(row => row.kind === 'phone').map(row => row.action)).toEqual(['leave'])
    expect(w.status.at(-1)).toBe('keepwarm stopped: you chose to leave it cooling')
    // The tick runs every minute. It must not treat the tap as an away plan and start warming.
    await clock.advance(2 * MINUTE)
    expect(w.status.at(-1)).toBe('keepwarm stopped: you chose to leave it cooling')
    expect(evidence(w.files).some(row => row.kind === 'leave')).toBe(false)
  })

  test('a digest that cannot be sent is still owed next tick', { options: { ...PHONE, weeklyDigest: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: MON_0931 })
    // No profile folder, so reportText returns early: nothing is written and nothing is pushed.
    const w = world(on, { env: {} })
    await $.session.start(session)
    await clock.advance(61 * 1000)
    expect(w.posts.filter(post => (post.body.message ?? '').startsWith('warmproof report'))).toHaveLength(0)
    expect(w.files.size).toBe(0)
    // The point of the fix: the week is not marked, so a later tick with a folder tries again.
    expect(w.store.get('digestWeek')).toBeUndefined()
  })

  test('a digest that goes out marks its week, so it goes out once', { options: { ...PHONE, weeklyDigest: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: MON_0931 })
    const w = world(on)
    await $.session.start(session)
    await clock.advance(61 * 1000)
    expect(w.store.get('digestWeek')).toBe('2026-10-19')
  })

  test('a rolled log is not listed as a session of its own', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'S1.1', [
      { at: new Date(WED_10AM - 40 * MINUTE).toISOString(), kind: 'start', cwd: '/repos/my-app' },
      { at: new Date(WED_10AM - 35 * MINUTE).toISOString(), kind: 'turn', ctx: 200000 },
    ])
    const w = world(on, { files })
    await $.session.start(session)
    const text = (await $.command.run(run('warmproof', 'sessions'))).text
    expect(text).not.toMatch(/S1\.1/)
    expect(text.trim().split('\n')).toHaveLength(2)
    expect(w.forks).toHaveLength(0)
  })

  test('pings you asked for do not spend the automatic cap', { options: { maxPingsPerIdle: 2 } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('warmproof', 'ping'))
    await $.command.run(run('warmproof', 'ping'))
    expect(w.forks).toHaveLength(2)
    // Two manual pings with a cap of two: the window must still get its own two.
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(150 * MINUTE)
    expect(w.forks).toHaveLength(4)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: 2 pings without a real turn/)
  })
})

describe('what a ping costs in plan allowance', () => {
  const at = (minutes: number) => new Date(WED_10AM + minutes * MINUTE).toISOString()

  test('the rise across each ping is averaged, per limit', async () => {
    const totals = summarise([
      { at: at(0), kind: 'turn', limits: { five_hour: 60, seven_day: 30 } },
      { at: at(50), kind: 'ping', warm: true, read: 200000, write: 0, input: 2, output: 1, limits: { five_hour: 62, seven_day: 30 } },
      { at: at(100), kind: 'ping', warm: true, read: 200000, write: 0, input: 2, output: 1, limits: { five_hour: 66, seven_day: 31 } },
    ], 0)
    // 2 then 4 points of the five-hour limit; 0 then 1 of the weekly one.
    expect(totals.planPerPing.five_hour).toBe(3)
    expect(totals.planPerPing.seven_day).toBe(0.5)
  })

  test('a limit window that reset is not read as a saving', async () => {
    const totals = summarise([
      { at: at(0), kind: 'turn', limits: { five_hour: 95 } },
      { at: at(50), kind: 'ping', warm: true, read: 1, write: 0, input: 0, output: 0, limits: { five_hour: 3 } },
      { at: at(60), kind: 'turn', limits: { five_hour: 4 } },
      { at: at(110), kind: 'ping', warm: true, read: 1, write: 0, input: 0, output: 0, limits: { five_hour: 6 } },
    ], 0)
    // The drop from 95 to 3 is a reset, not a refund: only the 2-point rise counts.
    expect(totals.planPerPing.five_hour).toBe(2)
  })

  test('with nothing logged the report says nothing about plan cost', async () => {
    expect(summarise([{ at: at(0), kind: 'ping', warm: true, read: 1, write: 0, input: 0, output: 0 }], 0).planPerPing).toEqual({})
  })

  test('the report prints the measured cost', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'OLD2', [
      { at: new Date(WED_10AM - 120 * MINUTE).toISOString(), kind: 'turn', read: 0, write: 0, input: 0, output: 0, ctx: 200000, limits: { five_hour: 40 } },
      { at: new Date(WED_10AM - 70 * MINUTE).toISOString(), kind: 'ping', warm: true, read: 200000, write: 0, input: 2, output: 1, limits: { five_hour: 42 } },
    ])
    world(on, { files })
    await $.session.start(session)
    expect((await $.command.run(run('warmproof', 'report'))).text)
      .toMatch(/plan cost {4}about 2\.0% of five-hour per ping, from your own log/)
  })
})

describe('two sessions warming one folder', () => {
  test('only a live window in the same folder counts as a rival', async () => {
    const mine = { sid: 'S1', folder: 'my-app' }
    const others = [
      { sid: 'S2', folder: 'my-app', deadline: WED_10AM + 60 * MINUTE },
      { sid: 'S3', folder: 'other-app', deadline: WED_10AM + 60 * MINUTE },
      { sid: 'S4', folder: 'my-app', deadline: WED_10AM - MINUTE },
      { sid: 'S5', folder: 'my-app', deadline: null },
      { sid: 'S1', folder: 'my-app', deadline: WED_10AM + 60 * MINUTE },
    ]
    // S3 is elsewhere, S4 expired, S5 has none, and the last row is me.
    expect(rivalsInFolder(others, mine, WED_10AM)).toEqual(['S2'])
  })

  test('arming a window says so when another session already holds one here', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'bbbbbbbb-2222', [{ at: new Date(WED_10AM - 20 * MINUTE).toISOString(), kind: 'start', cwd: '/repos/my-app' }])
    const w = world(on, { files, store: { 'deadline:bbbbbbbb-2222': WED_10AM + 90 * MINUTE } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect(w.logs.some(line => /session bbbbbbbb is already keeping my-app warm/.test(line))).toBe(true)
  })

  test('a window elsewhere is not worth mentioning', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'cccccccc-3333', [{ at: new Date(WED_10AM - 20 * MINUTE).toISOString(), kind: 'start', cwd: '/repos/other-app' }])
    const w = world(on, { files, store: { 'deadline:cccccccc-3333': WED_10AM + 90 * MINUTE } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect(w.logs.some(line => /already keeping/.test(line))).toBe(false)
  })
})

describe('the proof as one command', () => {
  test('prove arms a window and says what to do next', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    const armed = await $.command.run(run('warmproof', 'prove'))
    expect(armed.text).toMatch(/^proof armed for 1h30m with 201k of context\./)
    expect(armed.text).toMatch(/leave this session alone for 1h10m/)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toMatch(/^keepwarm 1h30m left/)
    expect(w.forks).toHaveLength(0)
  })

  test('it refuses when there is nothing to prove', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    expect((await $.command.run(run('warmproof', 'prove'))).text).toMatch(/^nothing to prove yet/)
    await $.turn.complete(turn())
    await clock.advance(70 * MINUTE)
    expect((await $.command.run(run('warmproof', 'prove'))).text).toMatch(/^the cache went cold 10m ago/)
  })

  test('it refuses a context too small to mean anything', { options: { minContextTokens: 500000 } }, async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'prove'))).text)
      .toMatch(/^the context is 201k, below the 500k worth proving anything about/)
  })

  test('the verdict names itself as the answer you asked for', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('warmproof', 'prove'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    await clock.advance(25 * MINUTE)
    await $.turn.complete(turn(200000, 600))
    expect(w.logs.at(-1)).toMatch(/^warmproof: the proof you asked for: proven, after 1h15m idle and 1 ping/)
    // The flag clears, so an ordinary later break is reported plainly.
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MINUTE)
    await clock.advance(25 * MINUTE)
    await $.turn.complete(turn(200000, 600))
    expect(w.logs.at(-1)).toMatch(/^warmproof: proven, after/)
  })
})

describe('one log file per instance', () => {
  test('a file maps back to its session whatever wrote it', async () => {
    expect(sessionOfLogFile('S1-ab12cd34.jsonl')).toBe('S1')
    expect(sessionOfLogFile('S1-ab12cd34.1.jsonl')).toBe('S1')
    // Files written before per-instance names still read correctly.
    expect(sessionOfLogFile('S1.jsonl')).toBe('S1')
    expect(sessionOfLogFile('aaaaaaaa-1111-2222-3333-444444444444-ab12cd34.jsonl'))
      .toBe('aaaaaaaa-1111-2222-3333-444444444444')
  })

  test('two instances of one session do not share a file', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const shared: FakeFiles = new Map()
    const first = world(on, { files: shared })
    await $.session.start(session)
    await $.turn.complete(turn())
    const written = [...shared.keys()].filter(path => path.includes('/warmproof/'))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/\/warmproof\/S1-[0-9a-f]{8}\.jsonl$/)
    expect(first.logs.some(line => /unparse/.test(line))).toBe(false)
  })

  test('rows from an older shared file still count in the report', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    // A file written before per-instance names, with a proven break in it.
    seedEvidence(files, 'OLD3', [
      { at: new Date(WED_10AM - 90 * MINUTE).toISOString(), kind: 'ping', warm: true, read: 200000, write: 0, input: 2, output: 1 },
      { at: new Date(WED_10AM - 20 * MINUTE).toISOString(), kind: 'break-check', verdict: 'extended', idleMin: 70, pings: 1, read: 200000, write: 100, prevCtx: 200000 },
    ])
    world(on, { files })
    await $.session.start(session)
    const text = (await $.command.run(run('warmproof', 'report'))).text
    expect(text).toMatch(/pings {8}1 \(1 warm\)/)
    expect(text).toMatch(/proof {8}1 break checks: 1 proven, 0 not proven/)
  })
})

describe('a stop reason is news, not wallpaper', () => {
  test('the countdown comes back once you work again', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { pings: [{ read: 0, write: 200000 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    // The miss stopped the window and the status says why.
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 200k/)
    // A real turn moves the session on: the reason must not sit there for the rest of the day.
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('cache 1h00m left · cold resume 201k tokens')
    expect((await $.command.run(run('warmproof'))).text).toMatch(/keepwarm {4}off \(/)
  })
})

describe('the lifetime follows the session', () => {
  test('a five-minute session counts down in minutes, not an hour', { options: { showCountdown: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('cache 5m left · cold resume 201k tokens')
    await clock.advance(6 * MINUTE)
    expect(w.status.at(-1)).toBe('cache cold · the next message re-writes 201k tokens')
  })

  test('a window on a five-minute cache says why it cannot work', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect(w.status.at(-1)).toBe('keepwarm stopped: this session uses the 5-minute cache, which pings cannot hold')
    expect(w.forks).toHaveLength(0)
  })

  test('the guard fires at five minutes on a five-minute cache', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(6 * MINUTE)
    // On the old fixed hour this send would have passed unguarded.
    expect('drop' in (await $.prompt.submit(typed('recap')))).toBe(true)
  })
})

describe('a sleeping Mac is not an idle one', () => {
  test('a gap far past the tick interval is sleep', async () => {
    expect(sleptMinutes(0, WED_10AM, 60_000)).toBe(null)
    expect(sleptMinutes(WED_10AM, WED_10AM + 70_000, 60_000)).toBe(null)
    expect(sleptMinutes(WED_10AM, WED_10AM + 40 * MINUTE, 60_000)).toBe(40)
  })

  // The engine-level case is not staged here: mock.clock replays every interval as it advances,
  // so it cannot produce the gap a sleeping machine leaves (the host simply does not fire the
  // timer while asleep). The rule above is what the detection is; the wiring is one call.
})

describe('the fast proof', () => {
  test('it refuses on the one-hour cache, and says where to run it', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'prove fast'))).text)
      .toMatch(/^the fast proof runs on the five-minute cache, and this session is on the one-hour one\./)
  })

  test('it arms a window that pings a minute before the cache lapses', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    const armed = await $.command.run(run('warmproof', 'prove fast'))
    expect(armed.text).toMatch(/^fast proof armed with 201k of context, testing the fork mechanism\./)
    expect(armed.text).toMatch(/A ping goes out after 4m of idle/)
    expect(armed.text).toMatch(/Leave this session alone for 7m/)
    // A ping sent at once would hold the cache only as long as an unpinged one lives.
    expect(w.forks).toHaveLength(0)
    await clock.advance(4 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(evidence(w.files).find(row => row.kind === 'ping')).toMatchObject({ warm: true, idleMin: 4 })
  })

  test('the verdict arrives after the short gap, and the guard does not eat it', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('warmproof', 'prove fast'))
    await clock.advance(7 * MINUTE)
    // Seven minutes on a five-minute cache: cold by the guard's reckoning, and the message is
    // the measurement, so it must go through rather than be held.
    expect('drop' in (await $.prompt.submit(typed('back')))).toBe(false)
    await $.turn.complete(turn(200000, 600))
    expect(evidence(w.files).find(row => row.kind === 'break-check')).toMatchObject({ verdict: 'extended', pings: 1 })
    expect(w.logs.at(-1)).toMatch(/the proof you asked for: proven/)
  })

  test('outside a proof run the guard still holds a cold send', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(7 * MINUTE)
    expect('drop' in (await $.prompt.submit(typed('back')))).toBe(true)
  })
})

describe('evidence you can paste into an issue', () => {
  test('it carries the verdicts and misses, and no paths', async () => {
    const at = (m: number) => new Date(WED_10AM + m * MINUTE).toISOString()
    const text = exportFrom([
      { at: at(0), kind: 'start', cwd: '/repos/my-app', file: 'S1-ab12cd34.jsonl' },
      { at: at(10), kind: 'ping', warm: false, read: 0, write: 200000, input: 2, output: 1 },
      { at: at(80), kind: 'break-check', verdict: 'extended', idleMin: 75, pings: 1, read: 54761, write: 419, prevCtx: 54763 },
      { at: at(90), kind: 'wake', sleptMin: 40 },
    ], WED_10AM + 100 * MINUTE, 7)
    expect(text).toMatch(/^```/)
    expect(text).toMatch(/break-check {2}extended {2}idle 75m {2}pings 1 {2}read 54761 {2}wrote 419/)
    expect(text).toMatch(/ping missed {2}read 0 {2}wrote 200000/)
    expect(text).toMatch(/wake {9}asleep about 40m/)
    // Nothing identifying: no folder, no file name, no clock time.
    expect(text).not.toMatch(/my-app|repos|S1-ab12cd34|10:/)
  })

  test('the command refuses when there is nothing logged', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on, { env: {} })
    await $.session.start(session)
    expect((await $.command.run(run('warmproof', 'export'))).text).toBe('no evidence logged yet')
  })
})

describe('the ping period can be learned', () => {
  const ping = (warm: boolean, idleMin: number) => ({ warm, idleMin })

  test('pings that keep holding push it later, a miss pulls it back', async () => {
    expect(learnedEveryMinutes([ping(true, 50), ping(true, 50)], 50)).toBe(null)
    expect(learnedEveryMinutes(Array(4).fill(ping(true, 50)), 50)).toBe(52)
    expect(learnedEveryMinutes(Array(4).fill(ping(true, 54)), 54)).toBe(55)
    // 55 is the ceiling, since a ping past the hour is worthless.
    expect(learnedEveryMinutes(Array(4).fill(ping(true, 55)), 55)).toBe(55)
    // A miss at 52 means stay well inside it.
    expect(learnedEveryMinutes([ping(true, 50), ping(true, 50), ping(true, 50), ping(false, 52)], 52)).toBe(42)
  })

  test('off by default, and applied when on', { options: { adaptPingPeriod: true } }, async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    const files: FakeFiles = new Map()
    seedEvidence(files, 'OLD4', Array.from({ length: 4 }, (_, i) => ({
      at: new Date(WED_10AM - (i + 1) * 60 * MINUTE).toISOString(),
      kind: 'ping', warm: true, idleMin: 50, read: 200000, write: 0, input: 2, output: 1,
    })))
    const w = world(on, { files })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect(w.logs.some(line => /pinging every 52m instead of 50m, from 4 pings on record/.test(line))).toBe(true)
  })
})

describe('the other mechanism, for comparison', () => {
  test('pingVia turn sends a real turn and records which mechanism it was', { options: { pingVia: 'turn' } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    // No fork: the ping went as a turn instead, and that turn's own usage is what it cost.
    expect(w.forks).toHaveLength(0)
    await $.turn.complete(turn(200_500, 40))
    expect(evidence(w.files).find(row => row.kind === 'ping'))
      .toMatchObject({ via: 'turn', read: 200_500, write: 40, warm: true })
    // The request row names the channel it really used, so the log does not call a turn a fork.
    expect(evidence(w.files).find(row => row.kind === 'request'))
      .toMatchObject({ via: 'turn', what: 'ping', ok: true })
  })

  test('a ping sent as a turn does not restart the break it was sent to carry', { options: { pingVia: 'turn' } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    await $.turn.complete(turn(200_500, 40))
    // An hour and ten minutes after the only real turn, this one still gets a verdict: the ping's
    // own turn was booked as a ping, so the clock the proof hangs off was left alone.
    await clock.advance(20 * MINUTE)
    await $.turn.complete(turn(200_540, 300))
    expect(evidence(w.files).find(row => row.kind === 'break-check'))
      .toMatchObject({ verdict: 'extended', pings: 1 })
  })

  test('a turn that arrives too late to be the ping counts as a real turn', { options: { pingVia: 'turn' } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    // The ping's turn never landed. Four minutes later this is your own work, not that ping.
    await clock.advance(4 * MINUTE)
    await $.turn.complete(turn(200_500, 40))
    const rows = evidence(w.files)
    expect(rows.find(row => row.kind === 'ping')).toBeUndefined()
    expect(rows.filter(row => row.kind === 'turn')).toHaveLength(2)
  })

  test('fork is the default, and records no mechanism', async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    await clock.advance(50 * MINUTE)
    expect(w.forks).toHaveLength(1)
    expect(evidence(w.files).find(row => row.kind === 'ping')?.via).toBeUndefined()
  })
})

describe('the A/B needs no config change', () => {
  test('a run names the mechanism it tests, and that beats the option', { options: { pingVia: 'fork' } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    const armed = await $.command.run(run('warmproof', 'prove fast turn'))
    expect(armed.text).toMatch(/testing the turn mechanism/)
    await clock.advance(4 * MINUTE)
    // The option says fork, the run says turn: no fork goes out, and the row records which.
    expect(w.forks).toHaveLength(0)
    await $.turn.complete(turn(200_500, 40))
    expect(evidence(w.files).find(row => row.kind === 'ping')).toMatchObject({ via: 'turn' })
  })

  test('the option still decides outside a proof run', { options: { pingVia: 'fork' } }, async ($, on) => {
    const clock = mock.clock(on, { now: WED_10AM })
    const w = world(on, { env: { ...DEFAULT_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('warmproof', 'prove fast'))
    await clock.advance(4 * MINUTE)
    expect(w.forks).toHaveLength(1)
  })

  test('a word that is not a mechanism is refused', async ($, on) => {
    mock.clock(on, { now: WED_10AM })
    world(on)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('warmproof', 'prove quickly'))).text)
      .toBe('/warmproof prove takes fast, fork or turn: prove, prove fast, prove fast turn')
  })
})
