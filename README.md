# Robinhood Stock Token Index

This repository reads finalized Uniswap V4 `Swap` events on Robinhood Chain and
produces one-minute open, high, low, and close (OHLC) candles from executed
trades. It currently collects nine registered pairs: eight Stock Token/USDG
pairs and one native ETH/USDG pair. USDG is an onchain token, not fiat USD.
Native ETH and WETH are different assets.

The data path is:

```text
one registered Uniswap V4 pair
  -> finalized Swap events from Robinhood Chain RPC
  -> trades in the registered base/quote direction
  -> one-minute candles and the continuous queried range
  -> one day file, one month index file, and one current pair-state file
  -> local directory or GitHub Releases
```

Collection groups only decide which existing pairs run sequentially in a
scheduled job. Reading one pair never requires a collection group.

## Terms used in this repository

- A **pool** is one Uniswap V4 market. Its **PoolKey** contains the two onchain
  currencies, fee, tick spacing, and hooks address. Its **PoolId** is derived
  from that PoolKey. The **PoolManager** contract stores the pool and emits its
  `Swap` events. The registry field named `pairId` contains this PoolId.
- A **pair** in this repository is one specific pool plus a chosen display and
  price direction. The **base asset** is the asset being priced; the **quote
  asset** is the unit used for that price. For example, `NVDA/USDG` means USDG
  units per NVDA token. A symbol such as `NVDA` is a display label, not a pool
  identifier. `baseIsCurrency0` states whether the base asset is `currency0` in
  the PoolKey; it removes any need to infer price direction from address order.
- A **registered pair** is a complete entry in `registry/pairs.json`. Its
  `sourceInitialization` identifies the block where the pool was initialized;
  `source` in this field means the registered onchain pool, not an RPC provider
  or candle event position. Its `historyStart` is the later of the pool's
  initialization minute and the configured number of calendar months before
  activation. It is the earliest
  boundary the collector may reach. Its `activation` is the initial boundary
  from which current collection moves forward and historical collection moves
  backward.
- A **candle** contains open, high, low, close, base volume, quote volume, and
  trade count calculated from `Swap` events with non-zero pool balance deltas
  of opposite signs for both assets in one UTC minute. A structurally valid
  `Swap` with a zero delta for either asset remains inside queried coverage but
  does not supply an exchange ratio or contribute to a candle. A minute with no
  contributing `Swap` has no candle.
- An **RPC endpoint** is a JSON-RPC server used to read blockchain data. A
  **finalized block** is the block returned by that endpoint for Ethereum's
  `finalized` tag; the collector does not publish data from a newer unfinalized
  block.
- **Coverage** is the continuous time and block range that was fully queried.
  It is written as a **half-open interval** `[from, until)`: `from` is included
  and `until` is excluded. Coverage can contain minutes with no candle.
- A **pair-day file** stores one pair's candles and coverage for part or all of
  one UTC day. A **pair-month file** lists that pair's day files for one UTC
  month. A **pair-state file** lists the available months and records the
  current and historical collection boundaries.
- A stored reference's `logicalId` is its stable pair-and-month or pair-and-day
  identifier. It does not contain a GitHub Release, file generation, or storage
  URL. Code uses **artifact** to mean one encoded state, month, or day data file.
- A **generation** is the `sequence` number used to publish a replacement file
  without overwriting the preceding file. The **selected pair state** is the
  latest valid pair-state generation returned by the storage adapter.
- `contractVersion` identifies the stored schema and meaning of a state, month,
  or day file. It is unrelated to a publication generation or package version.
- **Canonical JSON** means that the same valid value has one deterministic JSON
  byte representation. Stored hashes and sizes are checked against those bytes.
- **Validation** checks one input or stored file against its required fields and
  rules. The `verify` command is broader: it loads the selected pair state and
  validates every month and day file referenced by that state.

## Discover registered pairs and install

[`registry/pairs.json`](https://raw.githubusercontent.com/stelis-dev/robinhood-stock-token-index/main/registry/pairs.json)
is the current list of registered pairs. A consumer can read it directly without
loading collection groups or listing GitHub Releases:

```sh
node --input-type=module -e '
  const response = await fetch(
    "https://raw.githubusercontent.com/stelis-dev/robinhood-stock-token-index/main/registry/pairs.json",
  );
  if (!response.ok) throw new Error("Public pair registry is unavailable.");
  const registry = await response.json();
  for (const { display, pair } of registry.pairs) {
    console.log(JSON.stringify({
      label: display.label,
      pairId: pair.pairId,
      baseAsset: pair.baseAsset,
      quoteAsset: pair.quoteAsset,
      poolKey: pair.poolKey,
    }));
  }
'
```

The `display` object contains names and symbols for people. The `pair` object
contains the chain ID, PoolManager, PoolId, PoolKey, base/quote asset addresses
and direction, pool initialization, history start, and activation boundary.
Commands require a PoolId; they do not accept a symbol or display label as an
alias.

Use Node.js 22 or newer. Install the exact dependency versions recorded in
`package-lock.json` without running package lifecycle scripts:

```sh
npm ci --ignore-scripts
```

Print every display label and PoolId:

```sh
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const registry = JSON.parse(await readFile("registry/pairs.json", "utf8"));
  for (const entry of registry.pairs) {
    console.log(entry.display.label + "\t" + entry.pair.pairId);
  }
'
```

Print the scheduling groups:

```sh
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const plan = JSON.parse(await readFile("registry/collection-plan.json", "utf8"));
  for (const group of plan.groups) {
    console.log(group.groupId + "\t" + group.members.map((member) => member.pairId).join(","));
  }
'
```

These groups divide scheduled work; they are not a public market-data catalog
and do not affect pair reads.

## Add a pair

Check current group capacity before preparing a candidate:

```sh
node register-pair.mjs --status
```

This command reads the same collection plan used by scheduled jobs. For each
group it reports its pair count, estimated runtime, and remaining pair and time
capacity. Estimated runtime is each recorded `measuredSeconds` value plus the 25
percent safety margin configured in `registry/collection-plan.json`.

Registration requires independently verified onchain facts for one specific
pool; it does not discover a pool from a ticker. Create a candidate JSON file
containing one complete `{ "pair": ..., "display": ... }` object with the same
shape as an entry in `registry/pairs.json`.

The candidate must explicitly contain:

- the same Robinhood Chain ID, PoolManager, and `Swap` event topic used by the
  registry;
- the complete PoolKey and its derived PoolId in `pairId`;
- the base and quote asset kind, contract address when applicable, decimals, and
  `baseIsCurrency0` direction;
- the pool initialization block and timestamp;
- the earliest allowed historical block and minute boundary in `historyStart`;
- the activation block number, block hash, and minute boundary from which the
  first forward and historical collections begin; and
- human-readable names, symbols, and pair label under `display`.

`register-pair.mjs` validates these relationships but deliberately does not
invent or query any of these market facts. Their evidence must be reviewed
before the candidate is written.

Measure the elapsed whole seconds of a representative successful
`node cli.mjs collect --pair ...` operation, including both collection phases
selected by that command. Do not include workflow checkout, dependency
installation, or other job setup. Test the candidate without changing either
registry:

```sh
node register-pair.mjs \
  --candidate /absolute/path/to/candidate-pair.json \
  --measured-seconds 180
```

The command validates the complete candidate pair registry and collection plan
in memory. It chooses the existing eligible group with the lowest estimated
runtime while enforcing both the three-pair and 720-second limits. It does not
contact Robinhood Chain, infer a PoolKey, create a group, change a cron
expression, or publish data.

After reviewing the dry-run output, write both registry changes together:

```sh
node register-pair.mjs \
  --candidate /absolute/path/to/candidate-pair.json \
  --measured-seconds 180 \
  --write
npm test
```

The current plan has three groups with three pairs each, so it has no free pair
slot. A new candidate currently exits with a capacity error and changes neither
file. Adding a fourth group is a separate scheduling decision because it changes
the cron schedule and expected data freshness.

When capacity exists and registration succeeds, commit `registry/pairs.json`
and `registry/collection-plan.json` together. Run the new pair manually with
`collect`, run `verify` against the published data without a GitHub token, and
confirm the pair's next scheduled group run. Registration alone does not prove
that data has been published.

## Local collection and reading

Choose a PoolId and local directory:

```sh
PAIR_ID=0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1
INDEX_ROOT=.local-index

node cli.mjs collect --pair "${PAIR_ID}" --store directory --root "${INDEX_ROOT}"
node cli.mjs verify --pair "${PAIR_ID}" --store directory --root "${INDEX_ROOT}"
```

`collect` runs at most two phases against one finalized block fixed by its first
phase. The first phase extends `coverage.until`. If its block or UTC-day limit
stops before the fixed boundary, the second phase extends `coverage.until`
again. Otherwise the second phase moves `coverage.from` backward toward the
pair's fixed `historyStart`. `repair` reads the configured recent interval again
and may replace candles inside coverage, but it changes neither coverage
boundary:

```sh
node cli.mjs repair --pair "${PAIR_ID}" --store directory --root "${INDEX_ROOT}"
```

The same command can run every pair in a configured group sequentially. One
group command reuses its registry, storage adapter, RPC clients, cancellation
signal, and log writer across pair boundaries. The group has no stored data or
shared collection position:

```sh
node cli.mjs collect --group group-1 --store directory --root "${INDEX_ROOT}"
node cli.mjs repair --group group-1 --store directory --root "${INDEX_ROOT}"
```

The `verify` JSON output contains `result.coverage`. Its `fromTimestamp` is
included and its `untilTimestamp` is excluded. The built-in `read` command
requires UTC timestamps aligned to exact minute boundaries, a non-empty period,
and a period contained in one UTC calendar month. It rejects rather than rounds
seconds or milliseconds. Split a request at UTC month boundaries if needed:

```sh
node cli.mjs read --pair "${PAIR_ID}" \
  --from 2026-08-14T14:01:00.000Z \
  --until 2026-08-14T15:01:00.000Z \
  --store directory --root "${INDEX_ROOT}"
```

Applications may accept public requests that contain seconds or milliseconds.
They must preserve the original request instead of rounding it. They can read
the overlapping stored month and return only one-minute candles whose complete
`[intervalStart, intervalEnd)` falls inside the original request. This application
behavior does not change the stored-data schema or `contractVersion`.

Local collection always starts with the primary RPC URL committed in
`registry/pairs.json`. Optional fallback RPCs are complete HTTPS URLs supplied
in `INDEX_RPC_FALLBACK_URL_0` and then `INDEX_RPC_FALLBACK_URL_1`.

## Read public GitHub data without authentication

Published GitHub Release data can be verified and read without a GitHub token:

```sh
PAIR_ID=0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1
INDEX_REPOSITORY=stelis-dev/robinhood-stock-token-index

node cli.mjs verify --pair "${PAIR_ID}" \
  --store github --repository "${INDEX_REPOSITORY}"

node cli.mjs read --pair "${PAIR_ID}" \
  --from 2026-08-14T13:07:00.000Z \
  --until 2026-08-14T14:54:00.000Z \
  --store github --repository "${INDEX_REPOSITORY}"
```

A pair can be registered before its first data publication. In that case,
`verify` returns `status: "empty"`. `status: "verified"` means that the selected
pair-state file and every month and day file it references passed schema, size,
hash, identity, order, and coverage validation. The result reports the available
`coverage`.

A successful `read` returns the pair description, display metadata, candles,
and two interval lists. `available` contains the part backed by readable stored
data; `unavailable` contains the remainder. Together they cover the complete
requested period without overlap. Use `verify` coverage to choose a read period
within one month.

Collection, repair, upload, and cleanup through the GitHub storage adapter need
a repository token with Contents write permission.

## GitHub Actions

Manual workflow dispatch accepts:

- `operation`: `collect` or `repair`;
- `targetKind`: `pair` or `group`;
- `targetId`: a PoolId from `registry/pairs.json` or a group ID from
  `registry/collection-plan.json`, matching `targetKind`.

Scheduled jobs run `collect` only. One group starts every fifteen minutes, and
each of the three groups is selected every forty-five minutes. All jobs that can
write data share one concurrency queue. They run one at a time, do not cancel an
in-progress publication, and retain one pending job instead of replacing it.

A group runs all of its pairs in order. If one pair fails for a reason other
than cancellation, later pairs still run. Successful earlier pairs remain
published, and the group job exits unsuccessfully after every pair has been
attempted. Cancellation stops before the next pair. `repair` is manual because
there is no configured automatic repair schedule.

GitHub schedules are best effort and may be delayed or dropped. A later
successful run resumes from each pair's stored state, but data freshness can be
reduced while the pair catches up. This repository does not claim real-time
delivery or production availability.

`registry/collection-plan.json` defines the group membership, runtime limits,
measured runtimes, and cron-to-group mapping. GitHub requires the same cron
expressions to appear in `.github/workflows/index.yml` because it reads workflow
triggers before repository code runs. Tests require those two lists to be equal.
The workflow passes the triggered cron expression to `cli.mjs`; only the
collection plan maps that expression to a group.

The current schedule starts four three-pair group runs per hour. A pair has at most
two publishing phases. The implemented mature-state GitHub request traces use
19 REST requests for a pair's first publishing phase in a command and 12 for
its second phase after the same adapter has retained verified evidence. The
normal maximum is therefore 372 REST requests and 192 content mutations per
hour. This stays below [GitHub's documented rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
of 1,000 REST requests per hour for a repository `GITHUB_TOKEN` and 500
content-generating requests per hour. Recovery, rate-limit, and transport
retries are bounded failure paths and are not counted as normal throughput.

## Pair collection and storage

Current collection moves only `coverage.until` forward. Historical collection
moves only `coverage.from` backward toward `historyStart`, which is at most
twelve calendar months before activation. Each current or historical phase
stops at the adjacent UTC-day boundary, so one phase replaces one pair-day and
one pair-month even when consecutive blocks are separated by several days. The
phases publish independently, so a second-phase failure cannot undo a
first-phase publication. When historical collection reaches `historyStart`,
current data continues to accumulate. The current implementation does not
delete data by age.

Missing-trade minutes remain empty. The collector never interpolates a price or
creates a zero-price candle.

One day file contains data for one pair and one UTC day. One month file refers
to at most 31 day files. The selected pair-state file refers directly to every
month that contains its continuous coverage. A year is derived from each
`YYYY-MM` month ID and is not stored as another level.

Publication writes immutable changed day files, then the changed month files,
and finally a new pair-state generation. It re-downloads and validates every
changed day and month before publishing state, then re-reads the exact state
generation. A reader therefore sees either the preceding complete set of files
or the new complete set, never a mixture created by partial publication.

Before those files are written, the collector stores one internal pending
publication record for the pair. It identifies the exact preceding and
replacement files without changing the public pair-state, month, day, or read
formats. If a command stops before the replacement state is selected, the next
pair mutation verifies the preceding data and removes only the unpublished
replacement files. If it stops after selection, the next mutation verifies the
replacement data and removes only the superseded files. Any other state is
rejected as stored-data corruption before another RPC request is made.

The directory storage adapter uses:

```text
pairs/{pairId}/state/
pairs/{pairId}/months/{YYYY-MM}/
```

The GitHub storage adapter uses one Release for a pair's state generations and
one Release for each pair and UTC month. Stored state, month, and day data never
contains a repository name, Release tag, URL, asset ID, token, workflow value,
collection group, schedule, or RPC endpoint.

Cleanup is blocking. It verifies the selected state and every retained file in
the changed months before its first deletion, deletes only the exact files named
by the pending publication, and removes the pending record last. A failed cleanup
makes that pair operation fail while its selected data remains readable; the
next pair mutation resumes the same cleanup before collecting new chain data.
The absence of a reference, a generation comparison, or a repository scan is
not deletion authority.

The GitHub adapter uses at most three attempts for transport failures, HTTP 408
and 429 responses, and HTTP 5xx responses. It honors a `Retry-After` or rate-limit
reset delay only when the delay is at most 60 seconds. A repeated `DELETE` that
finds the exact asset already absent is successful. After an uncertain Release
creation or asset upload response, the adapter first reads the exact Release or
asset and verifies its identity and bytes; it does not blindly repeat a mutation.
If that exact reconciliation remains unavailable, it stops without sending a
second creation or upload request. Only an empty GitHub asset explicitly marked
as an incomplete `starter` can be removed as an incomplete upload.
Access, invalid-response, immutable-byte, size, and other request failures remain
fatal. Cleanup still fails the pair operation when its bounded recovery is
exhausted.

GitHub mutations are supported through the repository's one non-cancelling
Actions queue. Directory mutations are supported from one local process at a
time. The pending publication record detects and recovers an interrupted
transition; it is not a distributed lock and does not merge concurrent writers.

## Command output and candle values

Every command writes one JSON object to standard output with `ok`, `operation`,
the target ID, and `result`. A pair `collect` result is an ordered list of its
two completed phase results. A pair `repair` result is a one-item phase list.
Each item uses `phase` to identify `current`, `history`, or `repair`. A group
command writes one summary containing the ordered pair IDs and a `success` or
`failure` status; it does not emit a separate JSON object for each pair.

- `coverage` is the continuous finalized range fully queried for one pair. It
  does not prove that two RPC providers returned the same logs.
- `available` and `unavailable` are non-overlapping lists that together cover
  the requested period.
- A covered minute with no candle means that no validated `Swap` with a
  non-zero amount for both assets occurred in that minute. It does not mean a
  zero price.
- Each OHLC value is an exact rational number in quote-token units per one
  base-token unit, stored as reduced decimal-string `numerator` and `denominator`
  fields rather than a rounded floating-point number.
- `baseVolumeRaw` and `quoteVolumeRaw` are integer token amounts before decimal
  display conversion.
- `tradeCount` is the number of validated `Swap` events with non-zero amounts
  of opposite signs for both assets that contribute to the candle.
- `firstSource` and `lastSource` identify the first and last contributing `Swap`
  by block number and hash, transaction index and hash, and log index. `source`
  in these field names means an event position, not an RPC provider.

Candles describe executed trades. They are not recommendations or executable
quotes and contain no raw RPC response, wallet, account, or transaction history.

## RPC availability and fallback

The public RPC URL committed in `registry/pairs.json` is always tried first. A
run may add two complete URLs from `INDEX_RPC_FALLBACK_URL_0` and
`INDEX_RPC_FALLBACK_URL_1`, in that order. GitHub Actions reads both from
repository secrets. It does not construct URLs, read repository variables, or
print endpoint values.

Each RPC endpoint must support `eth_chainId`, the `finalized` block tag,
historical `eth_getLogs`, `eth_getBlockByNumber`, and JSON-RPC batch requests up
to the configured header batch size. Every attempt also verifies the registered
activation block number, hash, and timestamp.

One current, historical, or repair attempt uses only one endpoint. If bounded
retries exhaust a temporary endpoint failure, or the endpoint denies access or
lacks a required RPC method, the collector discards every unpublished result
from that attempt. It starts the complete operation again from the stored pair
state using the next endpoint. It never combines data from two providers inside
one attempt.

Both phases of one pair `collect` use one fixed finalized block. If a later
phase or fallback endpoint is selected, that endpoint must return the same block
number, hash, and timestamp for the fixed boundary before its data can be used.

The operation stops without fallback if chain identity, activation data,
response structure, request validity, numeric limits, cancellation, or stored
data integrity is invalid. Those failures can indicate a request, code, or data
defect rather than temporary endpoint unavailability.

Only in GitHub Actions, standard error records one success or failure line for
each completed or failed phase (`current`, `history`, or `repair`). A success
line names the selected RPC source as `registry.chain.primaryRpcUrl`,
`INDEX_RPC_FALLBACK_URL_0`, or `INDEX_RPC_FALLBACK_URL_1`. It never prints the
URL, provider response, token, exception message, or stack trace. Pair failure
records include only the operation phase, PoolId, and fixed `component`,
`operation`, and `reason` codes.
When pending publication recovery performs work, one additional fixed line says
whether the previous state was retained or the next state was selected; idle
recovery emits no line.
These codes distinguish GitHub access, rate-limit, transport, HTTP, response,
storage-limit, and immutable-byte failures without exposing a URL, response
body, or token. Exhausting every configured RPC
endpoint is reported as `component=rpc reason=all_endpoints_unavailable`. A fatal
RPC response reports `component=rpc` with one of `activation_boundary_mismatch`,
`chain_identity_mismatch`, `finalized_boundary_mismatch`, `http_rejected`,
`response_envelope_invalid`, `response_not_json`, `response_result_invalid`,
`response_too_large`, or `rpc_error`. The applicable numeric facts,
`http_status` and `rpc_code`, contain
only the admitted integer status or JSON-RPC error code. Stored bytes or a
stored file that fails its contract reports
`component=stored_data reason=integrity_rejected`. Only a remaining collector
invariant uses
`component=collector reason=operation_rejected`.

Fallback improves availability, but it cannot prove that an HTTP 200
`eth_getLogs` response contains every log. GitHub Actions and Releases remain
development and test services, not market-data sources or a production
availability guarantee.
