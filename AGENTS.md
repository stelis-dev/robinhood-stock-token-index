# AGENTS.md

Read this file before every task in this repository.

## Project purpose and boundary

This repository collects finalized Uniswap V4 `Swap` events on Robinhood Chain
and records candle data for configured base currencies quoted by fixed USDG
`0x5fc5360d0400a0fd4f2af552add042d716f1d168`.

For each equivalent finalized time range, it queries every applicable PoolId
together, validates the complete response, classifies events by PoolId, and
records the result by base-currency address. It must not restore normal
per-base-currency RPC collection.

The repository owns collection and recording only. It does not choose a chart
resolution, assemble chart output, route swaps, compare pools, interpolate
prices, implement a consumer cache, migrate old published data, or provide a
production-availability guarantee. GitHub Releases are development and test
storage, not the market-data source.

The accepted plan under `.WORK/market-data-archive/` governs replacement work.
Its purpose, product goal, and responsibility boundary have higher authority
than detailed code, tests, measurements, external reviews, or former behavior.

## Terms

- A **base currency** is identified by its canonical Robinhood Chain contract
  address. Native ETH uses
  `0x0000000000000000000000000000000000000000`. A symbol is display metadata.
- USDG is the fixed quote currency. Configuration, PoolId, symbol, or routing
  cannot replace or reinterpret it.
- A **PoolId** is source provenance selected by the human-authored
  configuration. One base currency may retain several historical PoolIds, but
  only the configured current PoolId owns unpublished current data.
- **Coverage** is one fully queried continuous half-open block and UTC time
  range `[from, until)` owned by one PoolId. Coverage with no candle means no
  contributing trade.
- Canonical `1m` candles contain exact rational OHLC, raw base and USDG volume,
  trade count, and first and last contributing finalized Swap positions.
- Fixed stored resolutions are `1m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`,
  `12h`, `1d`, and `2d`. Every derived candle is calculated directly from
  canonical `1m` and never crosses a PoolId boundary.
- A **logical file** is one base state, base month, base day, or base resolution
  identified by its `logicalId`.
- A **physical asset** is an immutable packed GitHub Release asset containing
  one or more independently compressed logical files.
- The **selected root** is the greatest valid uploaded root publication
  sequence. It fixes global facts, current boundary, base-state references, and
  the complete selected physical-asset membership.
- A **publication record** is internal mutation authority for exactly one
  previous root, next root, new assets, and superseded assets. It does not
  select market data.

## Sources of truth and responsibilities

- `registry/market-data.json` is the sole human-authored configuration. Programs
  read and validate it but never create, edit, normalize, or reorder it.
- Robinhood Chain, fixed USDG, fixed PoolManager, and USDG decimals are admitted
  global facts. Every configured PoolKey must contain its parent base currency
  and fixed USDG, and its derived PoolId must equal the configured PoolId.
- The fixed primary RPC is `https://rpc.mainnet.chain.robinhood.com`.
  Optional ordered fallbacks are `INDEX_RPC_FALLBACK_URL_0` and
  `INDEX_RPC_FALLBACK_URL_1`. They are complete secret URLs and are not stored
  market data.
- `collector/` owns configuration admission, shared planning and RPC reads,
  Swap validation, PoolId classification, candles, resolutions, logical files,
  packing, publication, recovery, retention, reads, and full verification.
- `storage/` owns only exact physical list, read, immutable write, and deletion
  operations. It cannot calculate or reinterpret market data.
- `cli.mjs` is the only collect, repair, read, and verify command.
- `.github/workflows/index.yml` exposes manual shared collect and repair and
  runs scheduled shared collect at minutes `8`, `23`, `38`, and `53` of every
  UTC hour. The workflow contains no pair or group routing.

## Required behavior

- Use one path for every configured base currency, including native ETH. Do not
  select behavior by symbol, alternate pool, alias, liquidity, volume, fee,
  route, or display order.
- One operation fixes configuration bytes, selected state, finalized block,
  complete-minute target, and ordered shared ranges before its first log read.
- Attempt one PoolId-filtered request for the complete applicable PoolId set.
  Divide only an actually oversized response, in deterministic time, block,
  then PoolId-set order. Division cannot omit or duplicate an event.
- Validate every returned Swap before classification or exclusion. A valid zero
  delta contributes coverage but no candle value.
- One attempt uses one endpoint. After bounded endpoint availability failure,
  discard all unpublished results and restart the whole attempt on the next
  endpoint. Never combine provider results.
- Malformed data, invalid configuration, chain mismatch, invalid request,
  numeric failure, cancellation, and stored-data corruption are fatal.
- Current advances only the global selected current boundary. History moves
  PoolId history boundaries backward. Repair replaces one exact recorded range
  and moves neither boundary. Current work precedes history.
- A collect command runs at most two independently durable phases against one
  fixed finalized block. Failure of the second phase cannot remove the first
  selected phase.
- Store at most twelve UTC calendar months. A crossing UTC day or month file may
  retain a bounded earlier prefix outside the selected range.
- When a retention lower bound falls inside a durable coverage segment, retain
  that segment from its recorded start. The same-day portion before the lower
  bound is an unselected prefix; do not invent a boundary or collect it again.
- Base-day coverage preserves exact durable-phase boundaries used by retention
  and history. Only resolution derivation coalesces adjacent same-PoolId
  segments in memory to prove a continuous natural interval.
- Pack only logical bytes changed by the current phase. Data, base-month index,
  and base-state index packing are separate deterministic steps. Unchanged
  logical files are never repacked.
- The recording builder produces one exact in-memory logical transition from
  the Work 2 result, selected state, and retention. Its replacement members and
  removals are the complete change authority; packing and physical membership
  consume them without widening or narrowing the change.
- Logical-file regeneration months and provenance-verification months are
  separate. A retention boundary can require verification without authorizing
  unchanged day, month, or resolution regeneration.
- Before root selection, affected base-day coverage must agree with the
  candidate base-state PoolId periods in PoolId, block range, and time range.
- Do not infer physical asset or GitHub request counts from logical-file counts.
  Validate exact member sizes, packed assets, Release shards, slots, and
  mutation identities after encoding and before the first storage mutation.
- Write the publication record before new assets and the next root last. The
  selected state is always the previous complete root or the complete next
  root.
- Recheck cancellation after shared collection and encoding and before every
  storage mutation. Cancellation before root selection leaves the previous root
  selected; cancellation after an uncertain or completed root upload leaves the
  publication record for normal recovery.
- If a pending publication still has its previous root selected, repeat its
  fixed RPC collection and encoding independently. Existing remote bytes may be
  reused only after regenerated bytes and the complete publication record match
  exactly. Pending bytes are never calculation input.
- A publisher mismatch never deletes the existing pending publication. The
  operation owner may abort exact pending identities only after recovery proves
  the previous-selected state and the supported mutation path is serialized.
- Automated GitHub mutations use the existing non-cancelling Actions concurrency
  queue. Directory storage supports one collect or repair mutation at a time for
  one root. Do not add a lock, lease, new credential, or active-writer inference
  for unsupported concurrent mutation.
- A pending history publication cannot delay a newer current gap. A scheduled
  collect never replays a pending manual repair.
- Deletion authority comes only from exact selected-root membership or the
  exact publication record. Filenames, listings, ages, missing references, and
  repository scans are not deletion authority.
- Public packed-member reads require the same byte Range across redirects,
  exact `206`, `Content-Range`, identity encoding, length, gzip and JSON digests,
  and logical identity. Do not fall back to downloading a complete packed asset
  when Range is ignored.
- Every GitHub retry loop applies the fixed maximum to its cumulative retry
  delay, not separately to each wait.
- Every Release admitted for a GitHub mutation must be published, non-draft,
  and mutable. Use only the existing Actions `GITHUB_TOKEN`; do not add a
  GitHub App, administration token, repository-settings preflight, alternate
  tag, or settings mutation. An immutable Release response is a non-retryable
  storage failure and cannot select the next root or complete automatic
  recovery on that storage surface.
- The absence of a selected root means `unpublished`, not that physical storage
  is empty. A clean launch is a separate manual Work 4 precondition: no earlier
  Release writer is running or queued, Release immutability is disabled, and no
  market-data catalog, index, or data Release or tag exists.
- Directory storage keeps staging files outside every Release asset directory.
  Read and list operations never clean or mutate staging. The first mutation in
  one Directory store instance removes only exact internal crash-staging names.
- Store processed candles and coverage only. Do not store raw RPC responses,
  provider identity, endpoint URLs, storage URLs, synthetic candles, or a
  general transaction index.
- Use one strict current schema. Do not add migration readers, compatibility
  aliases, deprecated wrappers, schema-version branches, or old-name commands.
- Before adding a dependency, inspect its exact version, transitive packages,
  lifecycle scripts, security, license, distribution form, and replacement
  cost. Prefer the Node.js standard library when sufficient.

## Work policy

- Before starting any repository task, re-read the current sources and output
  the following to the user before taking task action: the complete `Project
  purpose and boundary` section above verbatim; the exact purpose and product
  goal text of every accepted plan applicable to the task verbatim; and the
  user's exact current task purpose and requested work text verbatim. Do not
  reconstruct this text from memory or replace, shorten, paraphrase, normalize,
  reinterpret, or omit any part of it. If no accepted plan applies, state that
  fact instead of inventing one. Identify implementation means separately only
  after these unchanged authorities have been printed.
- Inspect repository state before editing and preserve unrelated changes. Do
  not commit unless the user explicitly asks.
- Always locate the current work inside the complete dependency chain and trace
  final outputs backward to their producers. Do not optimize one part in a way
  that creates debt for the next work.
- A previously fixed purpose or goal is never damaged, distorted, reduced,
  reframed, substituted, or omitted while writing a plan, performing work,
  reviewing, reporting progress, handling a failure, or judging completion.
  The accepted plan's complete purpose, product goal, responsibility boundary,
  fixed rules, work order, and completion conditions are one indivisible
  authority. Never abridge, summarize, narrow, reframe, substitute, omit, or
  otherwise manipulate that authority in a plan, work record, implementation,
  review, or completion judgment. A summary may help navigation but has no
  authority and can never replace the exact source text; re-read the complete
  accepted plan whenever the context is incomplete.
- Never mistake an implementation means for the work's purpose or product goal.
  Storage layouts, schemas, GitHub mechanisms, packing, publication, recovery,
  measurements, validators, tests, reviews, and procedures are means only. Add,
  change, or retain a means only when the complete accepted plan directly
  requires its result. Completing or perfecting a means cannot narrow, replace,
  redefine, or satisfy the product goal by itself. Improve a means when that
  improvement is necessary to solve the exact purpose and complete the exact
  work, but never make the improvement, completeness, generality, robustness,
  elegance, measurement, or validation of a means into a separate goal.
- Before starting or expanding any local task, identify the exact accepted-plan
  result it advances, the final output that consumes it, and which parts are
  merely implementation means. Do not improve, generalize, harden, document,
  measure, test, or otherwise raise the completeness of a means for its own
  sake. Once a means already satisfies the exact goal and its downstream
  contract, further work on that means is out of scope even if it appears
  cleaner, safer, more complete, or potentially useful later. If ongoing work
  cannot be traced directly to an unfinished goal condition, stop that local
  work and return to the complete dependency chain instead of inventing a new
  reason to continue it.
- Treat every authority below the plan purpose and goal as a claim that must be
  checked at its point of use. Filename, age, detail, approval, existing
  behavior, a passing test, measurement, or external reviewer is not authority
  for a conflicting result.
- If a detailed rule undermines the product goal, identify the exact conflict,
  inspect direct evidence, openly amend the accepted baseline, and only then
  continue. Never silently reinterpret the goal to preserve a lower-level
  artifact.
- Never create work from memory, prediction, convention, assumed repository
  state, or an expected future need. Inspect the current source of truth,
  producer, direct consumers, next dependent work, and existing patterns before
  editing.
- Do not silently strengthen a contract with a new digest, allowlist, identity,
  limit, approval, rejection rule, or security condition. A new constraint
  requires direct structural evidence and user agreement.
- Collect related issues before modifying them. Determine their common owner
  and root cause, then fix that owner rather than adding observed-example
  branches or test-only behavior.
- An unexpected file is a reason to investigate, not stop. Direct consumer
  inspection is part of the work. Exclude unrelated refactors and later
  features.
- If planned work cannot honestly solve a discovered problem, requires a new
  product/security/interface decision, damages a prior output, requires an
  alias or special branch, or creates structural debt, record the exact evidence,
  revert the affected unfinished implementation, and stop for the decision.
- Keep the accepted plan stable during implementation. Objective omissions are
  corrected openly; they are not hidden by renaming, splitting, or declaring a
  different task complete.
- Work records contain only current status, exact evidence, unresolved debt,
  and outputs needed by the next work. Do not keep diaries, abandoned options,
  procedural checklists, or context accounting.
- Before review, a work unit is only `in progress` or `ready for review`.
  Success or failure belongs to the subsequent complete review.
- Use the same plain technical term for the same concept everywhere. Remove
  coined, ambiguous, and legacy names.
- A test count proves nothing. Inspect what each test proves. Missing tests are
  not defects by themselves; first identify an invariant that incorrect code
  can represent or accept and whether a test is the smallest proof.
- Automated tests use fixed offline fixtures and never contact a live endpoint.
  Network smoke tests are manual.
- Before review readiness, run `npm test`, create a non-empty offline selected
  root with every fixed resolution possible from its coverage, run the directory
  `verify` command, and run exact `read --base --month --resolution` commands
  against the same root. Empty verification is not completion evidence.
- A claim that GitHub publication works additionally requires a manual workflow
  run followed by unauthenticated verification of the published root and
  referenced members.
