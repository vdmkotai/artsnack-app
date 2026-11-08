# Refreshing the Higgsfield rate card

`lib/higgsfield-prices.ts` is captured, not computed. Higgsfield publishes no
rate card, so every figure in it came from asking their CLI for a quote against
the live account. Refresh it when they change pricing, or when a model, duration
or resolution is added to the registry — the test
`every configuration the form can reach has a listed price` fails when the two
drift apart, which is the signal to run this.

The app does not depend on it being current: a live quote for the same
configuration always wins, and the real charge is written back from the vendor
when a job finishes. The table exists so the Generate button shows a number on
the first paint instead of an ellipsis.

## Prerequisites

The official CLI, authenticated as the account that will be billed:

```sh
export PATH="$HOME/.local/bin:$PATH"
higgsfield auth login          # only if `higgsfield generate cost …` says otherwise
```

`generate cost` creates no job and spends nothing.

## Capture

```sh
export PATH="$HOME/.local/bin:$PATH"
bunx tsx scripts/higgsfield-prices.ts
```

That walks every combination the form can reach, quotes each one, and rewrites
`lib/higgsfield-prices.ts`. It takes about a minute — roughly 120 quotes at a
quarter-second each. Combinations the vendor rejects (Seedance `fast` above
720p) are reported and skipped; the UI never offers them.

Then:

```sh
bun test          # the coverage test above must pass
git diff lib/higgsfield-prices.ts
```

Read the diff before committing. A price that moved is worth knowing about;
a price that vanished means a model or option was renamed upstream, and the
registry in `lib/api-models.ts` needs to follow it rather than the table being
patched to match.

## What the key means

Entries are keyed by `costSignature()` from `lib/higgsfield-job.ts`: job type,
then every priced parameter, sorted. Aspect ratio and reference count are
deliberately absent — both were measured against the vendor and neither moves
the price, so including them would split one known number across two dozen
entries that each need their own round trip before a price could be shown.
