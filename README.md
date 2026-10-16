# WarmProof

[![Release](https://img.shields.io/github/v/release/SUDARSHANCHAUDHARI/WarmProof?color=4c1)](https://github.com/SUDARSHANCHAUDHARI/WarmProof/releases/latest) ![License](https://img.shields.io/badge/License-MIT-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.287+-d97757) ![Tests](https://img.shields.io/badge/tests-132%20passing-4c1) [![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/sudarshanchaudhari)

> Keeps Claude Code's one-hour prompt cache warm while you step away, and proves whether it held.

Claude Code caches your conversation for an hour of idle time. Step away for longer and the next
message you send re-writes the whole context before you get an answer.

WarmProof keeps that cache alive while you are away — and then checks whether it actually worked.
It pings only when you ask it to, only inside your working hours, and never adds a turn to your
conversation. Every ping, every real turn and every compaction is written down, and the first
message after a pinged break says `proven` or `NOT proven`.

It does work: in a measured run, one ping carried a 54,763-token context across a 75-minute gap,
and the next message read 54,761 of those tokens back from the cache instead of re-writing them.
`/warmproof prove` runs that experiment on your own setup.

## What it does

- **Pings only when asked** — `/keepwarm`, for a window you choose, learned from your own breaks, or per folder
- **Proves it worked** — the first message after a pinged break is examined and logged `proven` or `NOT proven`
- **Pauses itself on a miss** — a failed ping stops pinging in every session on that Claude Code build
- **Keeps evidence** — every ping, turn, compaction, request and verdict in one JSONL per instance
- **Measures what it costs** — in tokens and in plan allowance, taken from your own log
- **Refuses to waste money** — metered backends, five-minute caches, plan ceilings, daily budget, per-model caps, a half-typed message, a kill switch
- **Never adds a turn** — a ping is a tool-less side request, and cannot call a tool
- **Fails open** — no hook of ours can gate your session on its own error
- **Profile-aware** — follows `CLAUDE_CONFIG_DIR`, so work and personal setups stay separate
- **Tells you about double spend** — when another session is already warming the same folder
- **Hands over after hours** — a handoff note instead of a ping, and `/handoff load` to pick it up

## Why bother checking

The hour is an idle timer, not a countdown: any request that reads the cache restarts it. A cache
read costs about a tenth of base input, while re-writing the context on the one-hour bucket costs
double it. So one tiny request before the hour runs out is roughly twenty times cheaper than
losing the cache.

That is the theory every keep-warm tool runs on. The part they skip is confirming it. WarmProof
measures each break instead, and stops pinging the moment the evidence says the pings are not
working.

## Safe by default

- **Nothing pings until you say so.** `/keepwarm`, or `always`, or a background-work window you
  switched on yourself. A cold write never starts pinging unless `autoArmOnColdWrite` is set.
- **No proxy, no stored tokens, no edits to your settings, no extra turns.** A ping is a side
  request through the documented mod API, billed to your plan like anything else.
- **It stops itself** on a kill-switch file, on a five-minute cache, on a metered backend, outside
  working hours, at the ping cap, at the daily budget, above a plan-usage line you set, after a
  missed ping (which pauses every session on that build), and in headless `-p` or SDK sessions.
- **A ping cannot act.** Its prompt asks for one word, and any tool call from another loop is
  refused outright while a ping is in flight.
- **It fails open.** Every hook that could gate your session passes your action through if
  anything inside it goes wrong.
- **Terms:** Anthropic's consumer terms restrict automated access except where permitted, and
  nothing explicitly permits keep-alive pings. The mod API does document model calls billed to
  your plan. Treat pinging as your decision, per session.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Ping after every 50 idle minutes, for 6 hours (`windowHours`) |
| `/keepwarm 90m`, `/keepwarm for 3h` | A window of your own length |
| `/keepwarm until 18:00` | Until a local time — tomorrow, if that time has passed |
| `/keepwarm auto` | A window as long as your own usual long breaks, learned from the evidence |
| `/keepwarm always` · `off` · `status` | Arm at every session start · stop and forget · show the state |
| `/warmproof` | The card: cache state and lifetime source, cold cost, window, guard, billing, breaks |
| `/warmproof ping` | Send one ping now and report what the cache served — the fastest way to test the mechanism |
| `/warmproof prove` | Run the experiment behind the whole mod: arm, ping, wait out the hour, then the next message says proven or not |
| `/warmproof prove fast` | The same experiment on the five-minute cache: about seven minutes instead of seventy |
| `/warmproof export [days]` | The totals plus every verdict, miss and sleep, as a block you can paste into an issue |
| `/warmproof report [days]` | Totals: pings and their spend, breaks proven and not, context kept, cold writes by cause, compactions held, and what a ping costs in plan allowance |
| `/warmproof sessions` | Every session of this profile in the last day: folder, last turn, context, window |
| `/warmproof leave 2h` | An away plan every open session with a warm, worthwhile cache picks up |
| `/warmproof breaks` | Your logged breaks, and the window `/keepwarm auto` would choose |
| `/warmproof project always\|auto\|never` | A policy for this folder, saved in `<config dir>/warmproof-projects.json` |
| `/warmproof guard warn\|refuse` | A cold send: price it and let it through, or hold the first one |
| `/warmproof unbench` | Allow pings again after a miss paused them for this build |
| `/warmproof forget confirm` | Empty this profile's evidence logs, the version pause and today's spend |
| `/handoff` · `/handoff load [latest \| <session-id>]` | Write a handoff note now · read one back into the session |

## How it decides

1. **When to ping.** 50 minutes after your last real request (`pingEveryMinutes`, never above 55),
   as a tool-less fork that adds no turn. A ping counts as warm only if it read from the cache and
   wrote less than a tenth of what it read.
2. **Whether it worked.** The first real message after a pinged break longer than an hour is
   checked: reading most of the earlier context is `proven`; re-writing half or more, or reading
   back less than half, is `NOT proven` — and pings are paused for this Claude Code version.
3. **When not to bother.** The cache is already cold, say after the Mac slept. A wake-up this
   session booked lands first and will read the cache anyway. The session bills per token — API
   key, a relay `ANTHROPIC_BASE_URL`, Bedrock, Vertex or Foundry — where the cache lasts five
   minutes (`pingOnMeteredBilling` overrides). The lifetime really is five minutes, from the
   environment, a model switch, or the transcript's own last cache write. The kill switch exists.
   The ping cap, the daily budget, or your plan-usage line has been reached. The model's prices
   say the pings so far already cost one cold re-write. Your own past breaks say you are unlikely
   to be back inside the hour (`pingOnlyIfWorthIt`).
4. **Background work.** With `warmDuringBackgroundWork`, a turn that ends while a subagent, shell
   or workflow is still running keeps the cache for up to `backgroundWarmHours`. Dev servers,
   watchers and monitors do not count. The window closes when the work does.
5. **Working hours.** Pings and alerts happen between `workStart` and `workEnd`, weekdays only by
   default. Outside them a ping becomes a handoff note (`afterHours`).
6. **When a window ends.** `compact` compacts once while still warm, above `compactMinTokens`.
   `handoff` saves a note. `nothing` simply lets the cache cool.
7. **Idle compaction.** While a window is on, Claude Code's own idle compaction is held back, so
   the context you asked to keep stays whole (`blockIdleCompaction`). A `/compact` you typed
   always runs.
8. **What it spends.** Everything is counted in input-equivalent tokens — a read at a tenth, a
   one-hour write at double, output at five times — and summed across sessions per local day
   against `dailyPingBudget`. Each session writes only its own key, so no update is ever lost.
9. **The phone.** With a topic set, an alert goes out `alertMinutes` before a big cache expires,
   inside working hours, carrying only the folder name. With `ntfyReplyTopic` as well it carries
   **Keep warm 2h**, **Compact** and **Leave**. Each button holds a single-use token, the first tap
   spends the whole group, and the tokens die with the cache they speak for. Taps are polled every
   20 seconds while any are live.

## More

- **A ping on demand.** `/warmproof ping` answers the only question that matters in about a
  second, instead of making you idle for fifty minutes. A miss pauses the build exactly as an
  automatic miss does.
- **Where the lifetime came from.** The card says `1h cache, seen in the transcript` or
  `assumed, not yet observed`, so a measurement is never mistaken for a guess.
- **Long tool runs.** With `warmDuringLongTurns`, a single turn that runs long with no new request
  is pinged before the hour runs out, so the cache is still there when it finishes.
- **At the Mac, or away.** With `desktopNotify`, the pre-expiry alert becomes a macOS notification
  when you have touched the keyboard recently (`ioreg` HIDIdleTime); the phone only gets it when
  you are actually away.
- **Learned windows.** `/keepwarm auto` sizes the window to the 80th percentile of your breaks
  over an hour across the last 14 days, between 1h and 12h.
- **Per-folder policy.** `always` opens a window at every session start there; `never` turns
  pinging off for that folder entirely.
- **A weekly digest.** The 7-day report goes to your phone and is saved beside the evidence as
  `warmproof/digest-<week>.md`.
- **A bounded log.** An instance's evidence file rolls into `<session>-<instance>.1.jsonl` past
  `evidenceMaxKb`, keeping one generation.
- **No silent double spend.** Arming a window says so when another session of this profile is
  already warming the same folder, since both would ping the same conversation lineage.
- **The lifetime follows the session.** A five-minute cache counts down in minutes, the guard
  fires at five minutes, and a window opened on one says plainly that a ping cannot reach it.
- **A sleeping Mac is not an idle one.** Timers do not run while it sleeps, so a gap the machine
  slept through is logged as a `wake` row — and any proof run spanning it is voided rather than
  reported, because it would measure the sleep rather than the ping.
- **The period can be learned.** With `adaptPingPeriod`, pings that keep holding push the period
  later and a single miss pulls it back well inside the shortest idle that failed.
- **Both mechanisms, measured.** Every other tool injects a real turn; this forks. With
  `pingVia: turn` the log records which mechanism each ping used, so the two can be compared on
  your own account rather than argued about.
- **A status-line segment.** `scripts/statusline-segment.py` reads the status-line JSON and prints
  `cache 42m left (1h)` or `cache cold · next msg re-writes 330k`. Wire it into your own status
  line; WarmProof never edits your settings for you.

## The evidence

Everything lands in `<config dir>/warmproof/<session-id>-<instance>.jsonl`, where the config dir
is `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`. One JSON object per line.

The `<instance>` suffix is not decoration: the file API can only replace a whole file, so two
instances of one session — a plugin reload, or a host upgrade mid-session — would overwrite each
other and shred rows. Each instance therefore writes its own file, and the readers treat them as
one session. Rows:

| Row | What it records |
| --- | --- |
| `start` | The build, the cache settings the session opened with, and which backend pays |
| `turn` | A real request of yours: tokens read and written, context size, plan usage, and the cause when it re-wrote most of it |
| `ping` | Read, written, warm or not, spend, plan usage, and whether it fired during a turn |
| `break-check` | The verdict on a break the pings were meant to carry |
| `compact` | The trigger, and whether a live window held it |
| `request` | Every fork, compaction, HTTP call and host command, with its outcome, status and tokens |
| `notify` | A nudge, and down which channel |
| `phone` | A button tap |
| `leave` | An away plan this session adopted |
| `digest` | The week a digest went out |
| `wake` | The machine slept, for about how long, and whether a proof run was voided by it |

Handoff notes go to `<config dir>/handoffs/<session-id>.md`.

Nothing in the log carries your prompts, your code, or any path beyond the session's own folder
name. A host command is recorded by its exit code, a network call by its status.

## Options

Set them at install, or later through `/config`. They are stored under `pluginConfigs.warmproof`.

| Option | Default | Meaning |
| --- | --- | --- |
| `costUnit` | `tokens` | `tokens`, or `usd` for the API list price. On a subscription, dollars are an estimate, not a bill |
| `windowHours` | `6` | The length of a bare `/keepwarm`, and of an `always` window |
| `pingEveryMinutes` | `50` | Idle time before each ping, never above 55 |
| `minContextTokens` | `50000` | Below this a cold resume is cheap: no guard, no alert, no handoff |
| `maxPingsPerIdle` | `8` | The most pings without a real turn |
| `dailyPingBudget` | `1000000` | Input-equivalent tokens per local day across sessions; `0` means no cap |
| `pauseAbovePlanPercent` | `0` | Stop pinging once any plan limit reaches this percentage; `0` turns the check off |
| `pingOnMeteredBilling` | `false` | Ping even on API-key, relay, Bedrock, Vertex or Foundry sessions, which bill per token on a five-minute cache |
| `autoArmOnColdWrite` | `false` | After you pay a cold re-write, hold the cache for 3 hours unasked |
| `warmDuringBackgroundWork` | `false` | Keep the cache while background work runs |
| `backgroundWarmHours` | `3` | The longest such window |
| `warmDuringLongTurns` | `false` | Ping during one long turn that makes no new request |
| `endOfWindow` | `nothing` | `nothing`, `compact`, or `handoff` when a window ends |
| `compactMinTokens` | `200000` | `compact` acts only above this |
| `blockIdleCompaction` | `true` | Hold Claude Code's idle compaction while a window is on |
| `workStart` / `workEnd` | `09:00` / `18:30` | Working hours, local clock |
| `workdaysOnly` | `true` | Treat Saturday and Sunday as outside them |
| `afterHours` | `handoff` | `handoff` stops and writes a note; `keep-pinging` ignores the clock |
| `handoff` | `true` | Write that note |
| `ntfyServer` | `https://ntfy.sh` | Where phone alerts go |
| `ntfyTopic` | empty | The alert topic (secret). Empty turns alerts off |
| `ntfyReplyTopic` | empty | A second topic for the buttons (secret). Must differ from `ntfyTopic` |
| `alertMinutes` | `5` | How long before expiry to warn; `0` turns it off |
| `desktopNotify` | `false` | A desktop notice when you are at the Mac; the phone only when away |
| `awayMinutes` | `5` | Input idle time that counts as away |
| `pingOnlyIfWorthIt` | `false` | Skip a ping your own breaks say will not pay |
| `adaptPingPeriod` | `false` | Let pings that keep holding push the period later, to 55 minutes, and pull it back hard after a miss |
| `pingVia` | `fork` | `fork` adds no turn. `turn` sends a real turn as other tools do, so the two can be compared in the log — it does add a turn |
| `pingSubagentTtl1h` | `false` | Give each ping fork the one-hour cache (`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h` for that request only, then restored). Turn on only if the proof says pings need it |
| `denyToolsDuringPing` | `true` | Refuse a tool call from another loop while a ping is in flight; your own tools are never affected |
| `evidenceMaxKb` | `1024` | Roll a session's evidence file past this size, keeping one generation; `0` never rolls |
| `showCountdown` | `true` | Show time left and the cold-resume cost even with no window on |
| `followLeave` | `true` | Join an away plan set in another session |
| `weeklyDigest` | `false` | Send the weekly report to the phone and a file |
| `digestWeekday` / `digestTime` | `1` / `09:30` | When it goes out (0 is Sunday) |

Kill switch: create `<config dir>/warmproof-off` and nothing will ping.

## Built with

- **Language:** TypeScript, `strict`, ES2023, no runtime dependencies
- **Surface:** the Claude Code mod API (`hooks/hooks.json` → `register.ts`), 16 hooks and 3 commands
- **State:** `$.state` for the slice that must survive a reload; `$.store` for cross-session facts
- **Evidence:** JSONL under the active profile's config folder, one file per plugin instance
- **Checks:** `claude plugin test` (117 cases) plus two self-checking Python scripts, on CI for Linux and macOS
- **Requires:** Claude Code 2.1.287 or later, since mods are an early-access API

## Running it

```sh
CLAUDE_CODE_PROMPT_CACHE_TTL=1h claude --plugin-dir /path/to/WarmProof
```

Setting the lifetime in the environment keeps the main conversation on the one-hour cache without
touching your settings, which works around interactive sessions sometimes getting five minutes.

To settle whether pinging works at all on your setup:

1. Build more than 50k of context.
2. Run `/warmproof ping`. It answers in a second: warm, or not warm. That proves a fork can read
   the main thread's cache.
3. Run `/warmproof prove`. It arms the window, pings after the idle period, and tells you to leave
   the session alone for 1h10m. The next message you send then says `proven` or `NOT proven` —
   that proves the ping also *holds* the cache across a real gap, which is the stronger claim.
   In a hurry, relaunch with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` and run `/warmproof prove fast`:
   same physics on the five-minute bucket, about seven minutes end to end.
4. Repeat with `pingSubagentTtl1h` on, and compare.
5. `/warmproof report` sums whatever you found, including what a ping cost in plan allowance.

Don't run it alongside another keep-warm mod: two of them register the same `/keepwarm`.

## Developing

```sh
claude plugin validate .
claude plugin test .
python3 -I scripts/check-evidence.py
python3 -I scripts/statusline-segment.py --self-test
```

Those four run in CI on Linux and macOS (`.github/workflows/check.yml`). None of them needs an
account: the suite drives a mocked engine, and both scripts check themselves. There is no eval
suite, deliberately — an eval runs an agent against a plugin, and every surface here is a
slash command you type or a hook that fires on a session event, none of which a model can trigger.

Everything that touches the engine lives in one file, because the mod API follows `$` only inside
the file it was handed to. Everything else is pure, and therefore tested directly:

| File | What is in it |
| --- | --- |
| `hooks/register.ts` | The hooks, the commands, the window, the pings, the phone, and the four logged wrappers |
| `hooks/runtime.ts` | Constants, live options, the session record, and the slice that survives a reload |
| `hooks/policy.ts` | The decisions: gates, learned breaks, cold-write causes, billing, plan limits, ntfy parsing |
| `hooks/views.ts` | Every line WarmProof says: status, card, report, sessions, warnings |
| `hooks/money.ts` | List prices, and what a read, a re-write and a ping cost |
| `hooks/extras.ts` | Options, working hours, the profile folder, the shape of an ntfy publish |
| `hooks/ledger.ts` | The evidence row types, and the break verdict |
| `hooks/status-icons.ts` | The band's mark, drawn as a vector or a glyph |
| `tests/engine.test.ts` | The whole suite (138 tests), and the contract the engine was written against |
| `types/index.d.ts` | The `$.state` contract for the runtime slice |
| `scripts/check-evidence.py` | Fails if anything spends or sends outside the logged wrappers |

Needs Claude Code 2.1.287 or later, since mods are an early-access API. Built against 2.1.294.

## Known limits

- **The core claim now has one measurement behind it, not a proof by assertion.** A fork ping did
  extend the main conversation's one-hour cache in a measured run: a 54,763-token context, a ping
  at 50 minutes idle, then a real message 75 minutes after the previous turn, which read 54,761
  tokens back and wrote 419 (`verdict: extended`). One run on one account and one build, which is
  why every break is still checked instead of assumed — your own log is the authority, not this
  paragraph.
- **Both mechanisms hold the cache; only one stays out of the transcript.** Run side by side on the
  five-minute bucket, a fork ping and a ping sent as a real turn both came back `extended` across a
  seven-minute break (fork: read 54,833, wrote 456. Turn: ping read 54,566 and wrote 471, then the
  next message read 55,037 and wrote 1,146). They cost about the same — roughly 6,400
  input-equivalent tokens a ping — but the turn is a real turn: it is written into the conversation,
  so every ping leaves a few hundred tokens of transcript behind that you then pay to read for the
  rest of the session. That is why `fork` is the default, and why `pingVia` exists at all: so the
  comparison can be re-run on your account rather than taken on trust.
- **Plan accounting is undocumented by Anthropic**, so WarmProof measures it instead: `report`
  prints `plan cost about 2.0% of five-hour per ping, from your own log`, derived from the usage
  percentages recorded on every ping and turn. That figure is the one worth watching, since the
  token budget is rarely what binds on a subscription.
- **Sleep.** Timers do not run while the Mac sleeps, and a ping into an already-cold cache is
  skipped rather than sent.
- **The clock is local.** Working hours follow the Mac's own time zone.
- **Phone buttons are plaintext on ntfy.** Use long random topic names. The tokens are single-use,
  but anyone who can read the reply topic could replay a tap inside its 20-second poll window.
- **The shared store has no locking.** The budget avoids races by giving each session its own key;
  the version pause is deliberately one shared key. The evidence log avoids the same race by
  giving each plugin instance its own file — a lesson learnt from a real shredded row, found when
  a host upgrade mid-session left two builds writing one file.
- **There is no file delete in the API.** `forget` empties evidence files rather than removing
  them, so retention by age is not possible — only the size roll.

What changed between versions is in [CHANGELOG.md](CHANGELOG.md). What WarmProof touches on your
machine, and how to report a hole in it, is in [SECURITY.md](SECURITY.md). If you want to send a
patch or a measurement, [CONTRIBUTING.md](CONTRIBUTING.md) says what to run first.

## License

MIT, © 2026 Sudarshan. See `LICENSE`.

## About

I'm Sudarshan Chaudhari, a Senior Quality Engineer, Test Automation specialist, and AI systems builder based in Bangkok, Thailand.

I have 13+ years of experience in software quality engineering, working across SaaS, fintech, gaming, web, mobile, cloud, and digital signage platforms. My background combines hands-on test automation with QA leadership, test strategy, CI/CD, release quality, production investigation, and cross-platform validation.

Alongside my professional QA career, I run [SudarshanTechLabs](https://sudarshantechlabs.com/), my independent engineering and product lab where I design, build, test, and ship software across Android, web, AI, cybersecurity, developer tooling, and cross-platform applications.

### What I work on

- ⚙️ **Quality Engineering & Test Automation** — Playwright, Selenium, Cypress, Appium, API testing, automation frameworks, end-to-end testing, CI/CD, release gates, GitHub Actions, risk-based testing, and production validation
- 🤖 **AI Systems & Automation** — AI agents, multi-agent orchestration, MCP servers, AI-assisted QA, prompt tooling, developer workflows, automation systems, and Claude Code plugins
- 📱 **Mobile & Cross-Platform Applications** — Android applications built with Kotlin and Jetpack Compose, Google Play releases, automated build and publishing pipelines, and cross-platform development spanning iOS, web, Windows, and macOS
- 🌐 **Web Applications & Platforms** — Full-stack applications using Next.js, TypeScript, Firebase, Cloudflare, REST APIs, and modern web infrastructure
- 🛠️ **Developer Tooling & CLI Engineering** — Rust, Python, TypeScript, CLI utilities, multi-repository tooling, build automation, release tooling, and engineering productivity systems
- 🛡️ **Cybersecurity & Observability** — Threat detection, log analysis, security auditing, vulnerability assessment, monitoring, and security-focused developer tools
- 📺 **Digital Signage & Device Platforms** — Content validation, playback testing, device compatibility, production investigation, monitoring, and QA across diverse hardware and operating-system environments

My work sits at the intersection of quality engineering, automation, AI, and software development. I approach products with a QA mindset from the beginning: understanding failure modes, designing for testability, automating repetitive work, and building release confidence into the engineering process.

Through SudarshanTechLabs, I also build products and tools from idea to production, covering architecture, development, testing, CI/CD, release automation, monitoring, and ongoing maintenance.

🌐 [sudarshantechlabs.com](https://sudarshantechlabs.com/) · 💼 [LinkedIn](https://linkedin.com/in/sudarshan-chaudhari) · 🐙 [GitHub](https://github.com/SUDARSHANCHAUDHARI) · ✉️ [sunny.sudarshan@gmail.com](mailto:sunny.sudarshan@gmail.com)

---

Issues and findings welcome. If a ping misses on your setup, the useful things to attach are
`/warmproof report` and the `break-check` rows from your evidence log — a failure with evidence is
worth more to this project than a passing run.
