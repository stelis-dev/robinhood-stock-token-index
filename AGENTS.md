# AGENTS.md

Read this file before every task in this repository.

## Project and terms

This repository reads finalized Uniswap V4 `Swap` events on Robinhood Chain,
stores canonical one-minute candles for registered trading pairs, and stores
the fixed derived candle resolutions calculated directly from those one-minute
candles. It uses a local directory or GitHub Releases as storage. GitHub is a
development and test storage service, not the source of market data and not a
production-availability claim.

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
  from `Swap` events whose two pool balance deltas are non-zero and have
  opposite signs. A structurally valid `Swap` with a zero delta for either
  asset remains part of queried coverage but supplies no exchange ratio and
  does not contribute to a candle. A minute with no contributing `Swap` has no
  candle. Its `firstSource` and `lastSource` fields identify the first and last
  contributing `Swap`; `source` here means an event position, not an RPC
  provider.
- **Coverage** is the continuous half-open time and block range that was fully
  queried, written as `[from, until)`. Coverage can contain minutes with no
  candle.
- An **RPC endpoint** is a JSON-RPC server used to read chain data. A **finalized
  block** is the block returned for Ethereum's `finalized` tag. Do not publish
  data from a newer unfinalized block.
- A **pair-day file** stores one pair's canonical one-minute candles and
  coverage for part or all of one UTC day. A **resolution artifact** stores one
  derived resolution for one owner month. A **pair-month file** selects that
  pair's day and resolution files for one UTC month. A **pair-state file** lists
  the months currently available for one pair, the complete resolution catalog,
  and its current and historical collection boundaries.
- The fixed resolution catalog is `1m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`,
  `12h`, `1d`, and `2d`. `1m` remains day-partitioned. Every other resolution is
  independently month-partitioned and calculated directly from `1m`; a stored
  derived resolution is never the source of another one.
- A **publication manifest** is one internal stored file that gives an
  unfinished pair publication exact ownership of its previous and next state,
  changed month, day, and resolution files. It is not part of the public
  pair-state, month, day, resolution, or read contract.
- A stored reference's `logicalId` is its stable pair-and-period identity. It
  contains no generation number or physical storage location. Source files use
  **artifact** to mean one encoded state, month, day, or resolution data file.
- A **generation** is the integer sequence number used to publish a replacement
  state, month, day, or resolution file without overwriting the preceding file. The
  **selected pair state** is the latest valid pair-state generation returned by
  the storage adapter.
- Stored files have one strict current schema and contain no schema revision or
  implementation marker. **Canonical JSON** means that one valid value has one
  deterministic JSON byte representation for hashing.
- **Validation** checks one input or one stored file. Full **verification** loads
  the selected pair state, validates every referenced month, day, and resolution
  file, and re-derives every resolution directly from the selected one-minute
  files.
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
  `Swap` events, calculates canonical and derived candles, advances each pair's
  collection boundaries, encodes the stored files, and verifies exact
  pair/month/resolution reads.
- `registry/collection-plan.json` is the sole source of truth for the maximum
  number of groups, maximum pairs and runtime per group, the 25 percent runtime
  safety margin, GitHub request capacity and per-pair estimates, ordered group
  membership, measured pair runtimes, and the cron expressions assigned to each
  group. `scheduler/` validates that file, resolves a group ID or cron expression,
  and runs the group's pairs sequentially.
- `storage/` reads, writes, lists, and deletes bytes at physical locations. A
  storage adapter cannot decode candles, calculate market data, combine pair
  data, or decide which stored generation is valid; it implements the selection
  rules supplied by the collector.
- `cli.mjs` is the only command for pair, group, and scheduled operations. One
  command reuses one admitted registry, storage adapter, RPC client set,
  cancellation signal, and log writer for every pair it runs. Group execution
  calls the direct pair-operation owner and never invokes the top-level CLI
  recursively.
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
- Only `RpcClient` chain verification, block, block-header batch, and log-read
  operations construct JSON-RPC requests. Validate their exact method inputs
  before any network request. Do not expose a generic method-and-parameters RPC
  entry point to collector callers.
- Admit each block response once into a canonical internal block number, hash,
  and UTC-representable timestamp. For a block-header batch, validate every
  successful result against its requested number, expected log block hash, and
  fixed operation time range before acting on any sibling availability result.
  Validate and decode every self-contained field of a returned `Swap` page
  before requesting its block headers. Across the complete fixed range, one
  block number maps to one block hash and one transaction coordinate maps to one
  transaction hash, in both directions. A later availability failure must never
  hide malformed data already returned by the same endpoint.
- One current, historical, or repair attempt uses one RPC endpoint and one fixed
  block range. After bounded retries exhaust a temporary transport, server, or
  required-resource failure, or the endpoint denies access or lacks a required
  RPC method, or the endpoint reports pruned history for a required historical
  block or log read, discard all unpublished results from that attempt and
  restart the whole operation from the stored pair state using the next
  endpoint. Never combine data from two RPC providers in one attempt. Stop
  without fallback when chain identity, pool activation data, response
  structure, request validity, numeric bounds, cancellation, or stored-data
  integrity is invalid. Standard invalid-request (`-32600`), invalid-parameter
  (`-32602`), and transaction-rejected (`-32003`) JSON-RPC responses remain
  fatal. A `-32000` response to
  a read request already admitted by `RpcClient` is an endpoint availability
  failure: retry the identical request within the configured bound and then
  restart the complete operation on the next endpoint. Unassigned
  implementation-defined server errors are also endpoint availability failures.
- Each optional fallback RPC is one complete URL read from its corresponding
  GitHub Actions repository secret. Do not read it from a repository variable or
  construct it from a provider URL and token.
- Current collection moves only `coverage.until` forward. Historical collection
  moves only `coverage.from` backward toward the fixed `historyStart`. Repair
  changes candles inside existing coverage and moves neither boundary. A
  current or historical phase stops at the adjacent UTC-day boundary as well as
  its admitted block and history limits. After pending publication recovery
  completes, finish every RPC read for the new attempt before creating its
  publication manifest or writing market data.
- A pair `collect` runs at most two durable phases against one fixed finalized
  block. The first phase is current. If it does not reach that block's complete
  minute boundary because of the block or UTC-day limit, the second phase is
  current again; otherwise the second phase is history. Every endpoint used by
  either phase must reproduce the fixed finalized block before use. A published
  first phase remains selected if the second phase fails.
- A collection group runs its pairs in order. A pair failure other than
  cancellation does not prevent later pairs from running. After every member has
  been attempted, the group fails if any pair failed. Cancellation stops before
  the next pair. The group shares only its command context; it adds no shared
  cursor, retry state, stored file, or recovery state.
- The current collection plan allows at most three groups, three pairs per
  group, and 720 seconds of estimated runtime per group. For capacity checks,
  add the plan's 25 percent safety margin to each measured pair runtime. Pair
  registration chooses the eligible group with the lowest estimated runtime;
  ties follow group order. Registration never creates a group, changes a cron
  expression, or changes a capacity limit. A fourth group requires a separately
  reviewed change to scheduling and expected data freshness.
- The collection plan also admits the maximum GitHub requests and
  content-generating requests per pair collection and validates the maximum
  rolling-hour schedule load against its GitHub hourly and per-minute limits.
  One command's shared GitHub adapter spaces all content-generating requests by
  the interval derived from the per-minute limit. Group runtime estimates include
  the maximum pacing time. Publication request-trace tests must use the admitted
  per-pair values rather than independent numeric expectations.
- Scheduled jobs run `collect` only. `repair` requires a manually selected pair
  or group. All jobs that can write data use one non-cancelling GitHub Actions
  concurrency queue, so an in-progress job is not cancelled and one pending job
  is retained. Cron timing is best effort and does not define data validity or
  guarantee availability.
- Pair registration never derives a PoolKey, address, initialization block, or
  pair identity; contacts the chain; publishes or deletes data; or treats a
  symbol as an identifier. A dry run is the default. `--write` is allowed only
  after the complete candidate pair registry and collection plan both validate.
- Before a pair mutation makes any RPC request, resolve its pending publication
  manifest. After every RPC read and replacement build completes, recheck the
  exact selected-state bytes, create the manifest as the first storage mutation,
  write immutable pair-day, resolution, and pair-month files, and write the new
  pair-state generation last. Validate each write from the exact bytes returned
  by storage, then re-read and validate the exact selected state. References to
  unchanged months must come from the previously validated state.
- Do not publish an empty pair-state file. The absence of a selected state means
  that no data has been published for that pair. Every new pair-state generation
  must directly reference at least one pair-month generation written by the same
  operation, and every new pair-month generation must directly reference at
  least one day or resolution generation written by that operation.
- A pair-state file directly contains its ordered month references. A year is
  derived from the `YYYY-MM` month identifier; do not create a year file, path,
  GitHub Release, reader, or compatibility name.
- Routine publication reads and rebuilds the selected pair state. Its metadata
  grows by one bounded month reference for each month that contains data. Read
  or list day, resolution, and month files only for months changed by the
  operation. Full verification must stream month, day, and resolution files in
  order instead of holding the complete candle history in memory.
- Publication recovery has one closed decision based on the admitted manifest
  and exact selected-state identity. If the previous state is selected, verify
  its changed closure and remove only the exact unpublished next files. If the
  next state is selected, verify its changed closure and remove only the exact
  superseded previous files. Any other combination is stored-data corruption.
  Remove the manifest last. A cleanup failure remains fatal and leaves the
  manifest for the next pair mutation. A missing reference, generation number,
  filename pattern, Release listing, or repository scan is never deletion
  authority.
- The GitHub storage adapter retries only bounded transport, rate-limit, request
  timeout, and server failures. Deleting an exact asset that is already absent is
  successful. After an uncertain Release creation or asset upload, read the
  exact remote identity and verify uploaded bytes before repeating the mutation.
  If that reconciliation read remains unavailable, stop without issuing another
  POST. Treat only an asset admitted as an empty GitHub `starter` as incomplete;
  contradictory asset metadata is corruption. Do not make cleanup non-blocking
  or hide an exhausted storage failure.
- Operational failure logs classify fatal RPC responses, stored-data integrity,
  and collector invariants at their responsible boundary. Log only fixed reason
  names, supported RPC method names, and admitted numeric HTTP or JSON-RPC
  codes; never log endpoint URLs, provider messages, response bodies, tokens, or
  stack traces. Classification does not change retry, fallback, publication, or
  group-failure behavior. The CLI emits one success or failure line per phase
  and names endpoints only by their registry field or secret variable name. If
  a later endpoint succeeds, that success line retains the fixed reason,
  supported method, and numeric code for each earlier failed endpoint. The CLI
  emits a recovery line only when recovery retained the previous state or
  selected the next state.
- Store processed candles and continuous coverage. Do not store raw RPC
  responses, invented candles, a general transaction index, the RPC provider
  used, or a storage URL.
- Validate every returned `Swap` event before using or excluding it. When either
  pool balance delta is zero, advance coverage without adding price, volume,
  trade count, or source positions to a candle. Do not substitute the event's
  post-swap `sqrtPriceX96` for an executed exchange ratio.
- Publish and read only the one strict stored-data contract. Stored state,
  month, day, resolution, reference, and publication-manifest objects contain no
  schema revision or implementation marker. Replace internal implementations
  directly; do not add aliases, migrations, compatibility branches, or alternate
  readers.
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
- Never create a requirement, decision, design, work item, code, test, or
  verification step from memory, prediction, customary practice, assumed
  repository state, or an expected future need. At the point of use, inspect
  the current owning source of truth and the exact affected producer and
  consumer. If current direct evidence does not establish that the work is
  required, exclude it; do not fill the gap with a default or assumption.
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
  referenced pair-day file, and every derived resolution possible from its
  coverage. Run the pair-scoped directory `verify` command and exact `read
  --month --resolution` commands against that same directory. Verifying an empty
  directory is not completion evidence.
- A claim that GitHub publication works additionally requires a manual workflow
  run followed by verification that downloads the published files without using
  GitHub authentication.
