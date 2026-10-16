# Security

## Reporting something

Open a [private advisory](https://github.com/SUDARSHANCHAUDHARI/WarmProof/security/advisories/new)
on this repository, or email sunny.sudarshan@gmail.com. Please do not open a public issue for a
vulnerability. This is a one-person project, so expect a first reply within a few days rather than
within hours.

## What WarmProof touches

Worth knowing before you install it, and worth checking in the source rather than taking on trust.

- **Your transcript.** The keep-warm ping is sent through the host's own model call. With
  `pingVia: fork` it is a side request that never enters the conversation; with `pingVia: turn` it
  is a real turn and does appear. Neither one sends your conversation anywhere the host was not
  already sending it.
- **The evidence ledger.** Written to `<profile>/warmproof/*.jsonl`, inside your own Claude Code
  profile folder. It records token counts, timestamps, model names, the project's folder name and
  the reason a request re-wrote its context. It does not record prompts, replies or file contents.
  `/warmproof forget` deletes it.
- **The network, only if you ask.** Nothing leaves the machine unless you set `ntfyTopic`. Then a
  short alert goes to the ntfy server you named, carrying the project's folder name, a countdown
  and a token count — never the conversation. The request goes through the host's HTTP client, so
  your organisation's own web policy still applies to it. An ntfy topic is a shared secret: anyone
  who knows yours can read your alerts and tap the buttons, so use a long random one, and set
  `ntfyServer` to your own instance if that matters to you.
- **Phone buttons.** A button is honoured only against a token this session minted, and only
  until the cache it speaks for would have expired. The first tap spends the whole group, so no
  button acts twice.
- **Tool calls during a ping.** With `denyToolsDuringPing` on, which is the default, a ping cannot
  run tools. It is one short reply and nothing else.
- **No credentials and no keys.** WarmProof reads no credential store and holds no API key of its
  own. It runs exactly three commands, all through the host's process API, all logged in the
  ledger: `ioreg` to see whether the keyboard has been idle, `osascript` for the optional desktop
  notification, and `tail -c 262144` on this session's own transcript file to read which cache TTL
  the session is running under. The transcript read stays on the machine; nothing from it is sent
  anywhere, and only the TTL marker is kept. Any text that reaches `osascript` is escaped first.

## Scope

In scope: anything in `hooks/`, `scripts/` or `.claude-plugin/` that leaks conversation content,
writes outside the profile folder, lets text in a conversation choose what WarmProof sends or
where, or lets an alert reply act on a session that did not mint it.

Out of scope: the Claude Code host itself and the prompt-cache behaviour it is built on — report
those to Anthropic. Also out of scope: the cost of pings you configured, and ntfy's own delivery.
