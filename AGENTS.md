# AGENTS.md

Read this file before every task in this repository.

## Project and terms

This repository reads finalized Uniswap V4 `Swap` events on Robinhood Chain and
stores one-minute open, high, low, and close (OHLC) candles for registered
trading pairs. It currently uses a local directory or GitHub Releases as
storage. GitHub is a development and test storage service, not the source of
market data and not a production-availability claim.

Terms used in this file:

- A **pair** is one specific Uniswap V4 pool plus a chosen base/quote display
  direction. It is identified by its Robinhood Chain ID, PoolManager address,
  PoolKey, and PoolId. The registry field `pairId` contains the PoolId. A token
  symbol is only a display label. `baseIsCurrency0` explicitly records whether
  the base asset is the PoolKey's `currency0`.
- `sourceInitialization` identifies the block where the registered pool was
  initialized; `source` in this field means the registered onchain pool, not an
  RPC provider or candle event position. `historyStart` is the later of that
  initialization minute and the configured number of calendar months before
  activation; it is the earliest
  boundary historical collection may reach. `activation` is the initial
  boundary from which current collection moves forward and historical
  collection moves backward.
- A **candle** is the open, high, low, close, volume, and trade count calculated
  from actual `Swap` events in one UTC minute. A minute with no trade has no
  candle. Its `firstSource` and `lastSource` fields identify the first and last
  contributing `Swap`; `source` here means an event position, not an RPC
  provider.
- **Coverage** is the continuous half-open time and block range that was fully
  queried, written as `[from, until)`. Coverage can contain minutes with no
  candle.
- An **RPC endpoint** is a JSON-RPC server used to read chain data. A **finalized
  block** is the block returned for Ethereum's `finalized` tag. Do not publish
  data from a newer unfinalized block.
- A **pair-day file** stores one pair's candles and coverage for part or all of
  one UTC day. A **pair-month file** lists that pair's day files for one UTC
  month. A **pair-state file** lists the months currently available for one pair
  and records its current and historical collection boundaries.
- A stored reference's `logicalId` is its stable pair-and-month or pair-and-day
  identifier. It contains no generation number or physical storage location.
  Source files use **artifact** to mean one encoded state, month, or day data
  file.
- A **generation** is the integer sequence number used to publish a replacement
  state, month, or day file without overwriting the preceding file. The
  **selected pair state** is the latest valid pair-state generation returned by
  the storage adapter.
- `contractVersion` identifies a stored file's schema and meaning. It is not a
  publication generation or a package version. **Canonical JSON** means that
  one valid value has one deterministic JSON byte representation for hashing.
- **Validation** checks one input or one stored file. Full **verification** loads
  the selected pair state and validates every referenced month and day file.
- A **collection group** is only an ordered list of pair IDs run sequentially by
  one scheduled job. It owns no candle data or collection progress.
- An operation's `phase` is `current`, `history`, or `repair`. It identifies
  which part of collection produced a command result; it is not stored in a
  candle, month, or pair-state file.

## Sources of truth and responsibilities

- `registry/pairs.json` is the sole source of truth for chain identity, the
  committed primary RPC URL, Uniswap deployment addresses, collection limits,
  pair descriptions, PoolKeys, base/quote direction, pool initialization,
  `historyStart`, and activation boundaries. `cli.mjs` may append only the two
  ordered optional fallback URLs. It cannot replace the primary URL or chain
  identity.
- `collector/` validates RPC data, determines finalized coverage, decodes
  `Swap` events, calculates one-minute candles, advances each pair's collection
  boundaries, encodes the stored files, and verifies period reads.
- `registry/collection-plan.json` is the sole source of truth for the maximum
  number of groups, maximum pairs and runtime per group, the 25 percent runtime
  safety margin, ordered group membership, measured pair runtimes, and the cron
  expressions assigned to each group. `scheduler/` validates that file, resolves
  a group ID or cron expression, and runs the group's pairs sequentially.
- `storage/` reads, writes, lists, and deletes bytes at physical locations. A
  storage adapter cannot decode candles, calculate market data, combine pair
  data, or decide which stored generation is valid; it implements the selection
  rules supplied by the collector.
- `cli.mjs` is the only command for pair, group, and scheduled operations.
  `.github/workflows/index.yml` must contain the same cron expressions as
  `registry/collection-plan.json` because GitHub reads schedules before
  repository code starts. The workflow passes the selected expression to
  `cli.mjs`; it does not duplicate the cron-to-group mapping or group membership.
- `register-pair.mjs` is the only command that adds a pair. It consumes one
  complete candidate entry for `registry/pairs.json` and the measured duration
  of one complete pair collection run. It may add the pair only to an existing
  group
  that remains within both capacity limits. It writes `registry/pairs.json` and
  `registry/collection-plan.json` only after both complete candidate files
  validate together.

## Required behavior

- Use one code path for every registered pair. Do not add behavior selected by
  ticker symbol, alternate pools, aliases, inferred addresses, multi-pool route
  prices, sampled data, or interpolated data.
- One current, historical, or repair attempt uses one RPC endpoint and one fixed
  block range. After bounded retries exhaust a temporary endpoint failure, or
  the endpoint denies access or lacks a required RPC method, discard all
  unpublished results from that attempt and restart the whole operation from
  the stored pair state using the next endpoint. Never combine data from two RPC
  providers in one attempt. Stop without fallback when chain identity, pool
  activation data, response structure, request validity, numeric bounds,
  cancellation, or stored-data integrity is invalid.
- Each optional fallback RPC is one complete URL read from its corresponding
  GitHub Actions repository secret. Do not read it from a repository variable or
  construct it from a provider URL and token.
- Current collection moves only `coverage.until` forward. Historical collection
  moves only `coverage.from` backward toward the fixed `historyStart`. Repair
  changes candles inside existing coverage and moves neither boundary. Finish
  every RPC read before the first storage write.
- A collection group runs its pairs in order. A pair failure other than
  cancellation does not prevent later pairs from running. After every member has
  been attempted, the group fails if any pair failed. Cancellation stops before
  the next pair. Group execution adds no shared cursor, retry state, stored file,
  or recovery state.
- The current collection plan allows at most three groups, three pairs per
  group, and 720 seconds of estimated runtime per group. For capacity checks,
  add the plan's 25 percent safety margin to each measured pair runtime. Pair
  registration chooses the eligible group with the lowest estimated runtime;
  ties follow group order. Registration never creates a group, changes a cron
  expression, or changes a capacity limit. A fourth group requires a separately
  reviewed change to scheduling and expected data freshness.
- Scheduled jobs run `collect` only. `repair` requires a manually selected pair
  or group. All jobs that can write data use one non-cancelling GitHub Actions
  concurrency queue, so an in-progress job is not cancelled and one pending job
  is retained. Cron timing is best effort and does not define data validity or
  guarantee availability.
- Pair registration never derives a PoolKey, address, initialization block, or
  pair identity; contacts the chain; publishes or deletes data; or treats a
  symbol as an identifier. A dry run is the default. `--write` is allowed only
  after the complete candidate pair registry and collection plan both validate.
- During publication, write immutable pair-day and pair-month files before the
  new pair-state generation. Re-download and validate each changed day and month
  file, publish the state last, and then re-read that exact state generation.
  References to unchanged months must come from the previously validated state.
- Do not publish an empty pair-state file. The absence of a selected state means
  that no data has been published for that pair. Every new pair-state generation
  must directly reference at least one pair-month generation written by the same
  operation, and every new pair-month generation must directly reference at
  least one pair-day generation written by that operation.
- A pair-state file directly contains its ordered month references. A year is
  derived from the `YYYY-MM` month identifier; do not create a year file, path,
  GitHub Release, reader, or compatibility name.
- Routine publication reads and rebuilds the selected pair state. Its metadata
  grows by one bounded month reference for each month that contains data. Read or
  list day and month files only for months changed by the operation. Full
  verification must stream month and day files in order instead of holding the
  complete candle history in memory.
- Cleanup may use only the newly selected state and the month files changed by
  that state update. Before deleting anything, verify every file that must
  remain. Delete an older generation only when its pair, month or day identifier
  is named explicitly by the selected state update. A missing reference alone is
  never permission to delete a file.
- Store processed candles and continuous coverage. Do not store raw RPC
  responses, invented candles, a general transaction index, the RPC provider
  used, or a storage URL.
- Change a state, month, or day `contractVersion` only when that file's stored
  schema or meaning changes. When stored schema and meaning remain the same,
  runtime, RPC, retry, fallback, registry, CLI, workflow, and storage changes do
  not change the data version or add an implementation-version field.
- Publish and read only the current stored-data contract. Replace internal
  implementations directly; do not keep old readers, old names, aliases,
  migrations, compatibility branches, or implementation markers.
- A missing candle is not a zero-price candle. USDG is an onchain token, not
  fiat USD. Native ETH and WETH are different assets.
- Keep candle calculation and stored files independent of GitHub repository
  names, Release tags, URLs, tokens, workflow data, and Release layout.
- Before adding a dependency, review its exact version, transitive dependencies,
  lifecycle scripts, security, license, distribution form, and replacement
  cost. Use the Node.js standard library when it fully implements the required
  behavior.

## Work policy

- Inspect repository state before editing and preserve unrelated changes.
- Work records contain only current status, exact verification evidence,
  unresolved debt, and the outputs and limits required by the next task. Do not
  keep diaries, timelines, abandoned alternatives, or token/context accounting.
- Fix a defect in the component responsible for the violated rule. Do not add a
  special case or compatibility alias for one observed example.
- Use the same plain term for the same concept in documentation, configuration,
  code, logs, and command output. Do not introduce a synonym that suggests a
  different meaning. Define a necessary protocol or stored-data term before it
  is used without explanation.
- Each test must prove a distinct rule or counterexample. Test count is not
  evidence; inspect what each test actually proves.
- Network smoke tests are manual. Automated tests use fixed independent fixtures
  and never contact a live endpoint.
- Before completion, run `npm test`. Then create a non-empty offline data set
  containing a pair-state file, its referenced pair-month file, and its
  referenced pair-day file. Run the pair-scoped directory `verify` command and a
  bounded `read` against that same directory. Verifying an empty directory is
  not completion evidence.
- A claim that GitHub publication works additionally requires a manual workflow
  run followed by verification that downloads the published files without using
  GitHub authentication.
