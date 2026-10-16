# Changelog

Notable changes to WarmProof. Versions follow [semantic versioning](https://semver.org/), and the
version in `.claude-plugin/plugin.json` is the one a release is tagged with.

## [0.8.1] — 2026-10-17

Accuracy, found by reading every tracked file line by line rather than searching it.

### Fixed

- A ping sent as a real turn wrote its `request` row as `via: "fork"`, with `"(as a turn)"` added
  to the text to compensate. `via` now carries `turn`, and `LedgerRow`'s union has a `turn` member.
  The tool-denial row keeps `fork` deliberately: a fork ping is what that denial protects.
- The README promised the mod never adds a turn to your conversation. With `pingVia: turn` it
  does, and both the summary and the feature list now say so.
- Stale counts: the test badge said 132 and "Built with" said 117 cases. Both are 138.
- `prove fast turn` and `prove fast fork`, the per-run mechanism override, were shipped
  undocumented and are now in the commands table.
- The build note now says what CI actually does: 2.1.299 pinned per push, latest weekly.

## [0.8.0] — 2026-10-16

The first version worth using. Everything below is in it.

### Keeping the cache warm

- A keep-warm window you open yourself with `/warmproof warm`, which sends a small ping every
  `pingEveryMinutes` so an idle session does not fall off the one-hour prompt cache.
- Two ping mechanisms, chosen with `pingVia`: `fork`, a side request that never enters the
  transcript, or `turn`, a real turn as other keep-warm tools send it.
- Working hours, so a window that outlives the day ends instead of pinging all night
  (`workStart`, `workEnd`, `workdaysOnly`, `afterHours`).
- A per-idle ping cap (`maxPingsPerIdle`) and a daily token budget (`dailyPingBudget`), both of
  which stop a forgotten window from spending without limit.
- Optional warming while background work or a long turn runs
  (`warmDuringBackgroundWork`, `warmDuringLongTurns`).
- A ping period that adapts to the breaks a session actually takes (`adaptPingPeriod`).

### Proving it held

- An evidence ledger at `<profile>/warmproof/<session>-<instance>.jsonl`: one JSON object per
  line for every turn, ping, compaction, alert and verdict, with the token counts the API itself
  reported. One file per plugin instance, because the host offers no append.
- A `break-check` row written on the first real request after a break the pings covered. It reads
  `extended` only when that request read most of the context back and re-wrote little of it.
- `/warmproof prove` and `/warmproof prove fast`, which arm a measured run and then say proven or
  not proven in the reply. `prove fast turn` and `prove fast fork` pick the mechanism for that
  one run, so the two can be compared without changing any setting.
- `/warmproof report`, `/warmproof sessions` and `/warmproof export` for reading the ledger back.
- Ledger rotation at `evidenceMaxKb`, and `/warmproof forget` to delete what has been recorded.

### Knowing when not to bother

- Billing detection: a metered backend caches for five minutes, where a fifty-minute ping always
  arrives too late, so pings are off unless `pingOnMeteredBilling` is set.
- A cache lifetime read from the session rather than assumed, so the countdown, the guard and the
  proof all follow a five-minute TTL as well as the one-hour default.
- A plan-usage gate (`pauseAbovePlanPercent`) that stops pinging when the plan's own limits are
  close, and a measured cost per ping reported alongside the token counts.
- `minContextTokens` and `pingOnlyIfWorthIt`, so a small or cheap session is left alone.
- A named cause when a request re-writes the context anyway: the TTL expired, a compaction landed,
  the model changed, the effort changed, or the machine slept.

### Staying out of the way

- A warning before a message that would land on a cold cache, and a guard that holds back an idle
  compaction while a window is live (`blockIdleCompaction`).
- Phone alerts through [ntfy](https://ntfy.sh) before the cache lapses, with buttons to warm for
  two more hours, compact now, or let it cool (`ntfyTopic`, `ntfyReplyTopic`).
- An optional desktop notification, a handoff note written when the working day ends with the
  cache still warm, and a weekly digest of what the pings saved.
- A countdown segment above the prompt, and a status line segment for people who want one.
- Every hook fails open: a hook that throws is logged and the session carries on.

[0.8.0]: https://github.com/SUDARSHANCHAUDHARI/WarmProof/releases/tag/v0.8.0
[0.8.1]: https://github.com/SUDARSHANCHAUDHARI/WarmProof/releases/tag/v0.8.1
