# Contributing

This is a one-person project, so the useful contribution is usually a measurement rather than a
patch. A ledger row showing that the cache did not hold on your setup is worth more than an
opinion about whether it should have.

## Before you open an issue

Run `/warmproof report` and paste what it says, along with your Claude Code version
(`claude --version`), your platform, and whether you are on a subscription or metered billing —
`/warmproof` shows which one it detected. If something looks wrong in the evidence, the matching
lines from `<profile>/warmproof/*.jsonl` are the thing to include; they hold token counts and
timestamps, not your conversation.

## Working on the code

```bash
claude plugin validate .   # the manifest and every hook the host will load
claude plugin test .       # the test suite
python3 scripts/check-evidence.py   # every spend goes through a logging wrapper
python3 scripts/statusline-segment.py --self-test
```

All four run in CI on Linux and macOS, so all four should pass before you push.

Two things about this codebase are not obvious and will cost you an afternoon if you discover them
the hard way:

- **`$` cannot cross a file boundary.** The host's validator follows `$` only into functions
  declared in the same file. That is why everything touching the engine lives in
  `hooks/register.ts`, and why `atom()` is declared there rather than imported. Pure logic goes in
  `policy.ts`, `views.ts`, `extras.ts`, `money.ts` or `ledger.ts`, where it can be tested on its own.
- **`claude plugin validate` accepts fields it does not know.** A manifest option that validates is
  not evidence that the host supports it. Check the types, or measure.

New behaviour needs a test in `tests/engine.test.ts`. Anything that spends tokens or sends a
request has to go through one of the wrappers in `register.ts` — `askModel`, `askModelTurn`,
`askCompact`, `askHost`, `askWeb` — so that it lands in the ledger;
`scripts/check-evidence.py` fails the build if it does not.

## Pull requests

One change per pull request, with a conventional-commit subject (`feat:`, `fix:`, `perf:`,
`chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `build:`). Say in the description what you ran and
what came back. A claim about cache behaviour needs the ledger rows that show it.
