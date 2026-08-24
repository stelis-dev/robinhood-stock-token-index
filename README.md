# Robinhood Stock Token Index

This repository reads finalized Uniswap V4 `Swap` events on Robinhood Chain and
publishes price candles for a fixed registry of trading pairs. One-minute
candles are the canonical source. Larger candle intervals are calculated
directly from those one-minute candles and stored as independently loadable
monthly files.

GitHub Releases are the development and test store. They are not the market-data
source and this repository makes no production-availability guarantee.

## What is stored

Every candle contains exact rational OHLC prices, base and quote raw volumes,
trade count, and the first and last contributing `Swap` positions. A minute
with no contributing `Swap` has no candle. Continuous coverage records the
fully queried time and block range, including covered minutes with no trade.

The fixed stored resolutions are:

| Label | Interval | Physical partition |
| --- | ---: | --- |
| `1m` | 60 seconds | UTC day |
| `15m` | 900 seconds | owner month |
| `30m` | 1,800 seconds | owner month |
| `1h` | 3,600 seconds | owner month |
| `2h` | 7,200 seconds | owner month |
| `4h` | 14,400 seconds | owner month |
| `6h` | 21,600 seconds | owner month |
| `12h` | 43,200 seconds | owner month |
| `1d` | 86,400 seconds | owner month |
| `2d` | 172,800 seconds | owner month |

Each derived candle uses every contributing one-minute candle in its natural
Unix-epoch-aligned interval. It is never calculated from another derived
resolution. Prices are not sampled, filled, interpolated, or carried forward.

`2d` can cross a UTC month boundary. The month containing the candle start owns
the complete candle. A consumer whose range begins inside such a candle must
also inspect the preceding owner month.

## Stored structure

One selected closure has this shape:

```text
pair state
  -> ordered pair months
       -> ordered one-minute day files
       -> independently referenced derived-resolution files
```

The pair state contains the complete resolution catalog and continuous source
coverage. Each pair month contains exact day and resolution references. Every
reference includes its logical identity, generation, byte counts, and SHA-256
digests. A generation is a publication sequence, not a data format identifier.

There is no year object. A year is assembled from `YYYY-MM` owner months.

### Directory layout

```text
pairs/{pairId}/state/state-g{generation}.json.gz
pairs/{pairId}/state/publication.json.gz
pairs/{pairId}/months/{YYYY-MM}/month-{YYYY-MM}-g{generation}-{sha256}.json.gz
pairs/{pairId}/months/{YYYY-MM}/candles-{YYYY-MM-DD}-1m-g{generation}-{sha256}.json.gz
pairs/{pairId}/months/{YYYY-MM}/candles-{YYYY-MM}-{label}-g{generation}-{sha256}.json.gz
```

`publication.json.gz` is internal recovery state and is not market data.

### GitHub Release layout

```text
pair-{pairId}-state
pair-{pairId}-month-{YYYY-MM}
```

The state Release contains state generations and the internal publication
manifest. Each month Release contains that month's month index, `1m` day files,
and independently downloadable derived-resolution files. Resolution-specific
and year-specific Releases do not exist.

## Requirements

- Node.js 22 or newer
- npm

Install the pinned dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts
```

Run the offline suite:

```bash
npm test
```

## Find registered pairs

`registry/pairs.json` is the only pair registry. A symbol is a display label;
the exact PoolId in `pair.pairId` is the command and storage identity.

List each display pair, PoolId, base asset, and quote asset:

```bash
jq -r '.pairs[] | [
  .display.label,
  .pair.pairId,
  .display.baseSymbol,
  .display.quoteSymbol
] | @tsv' registry/pairs.json
```

Inspect one complete entry before using it:

```bash
PAIR_ID='0x...'
jq --arg pairId "${PAIR_ID}" '.pairs[] | select(.pair.pairId == $pairId)' registry/pairs.json
```

The entry fixes the chain, PoolManager, PoolKey, base/quote direction,
initialization, history start, and activation boundary. Do not infer these
values from a symbol.

## Collect data

Directory collection is useful for offline qualification:

```bash
PAIR_ID='0x...'
node cli.mjs collect \
  --pair "${PAIR_ID}" \
  --store directory \
  --root /absolute/path/to/index-data
```

GitHub collection requires the repository `GITHUB_TOKEN`:

```bash
node cli.mjs collect \
  --pair "${PAIR_ID}" \
  --store github \
  --repository stelis-dev/robinhood-stock-token-index
```

`collect` runs at most two durable phases against one fixed finalized block.
It runs current collection first, then current again if a limit stopped it, or
history after it reaches the fixed finalized boundary. Each selected phase
publishes day, resolution, month, and state files atomically.

Repair rereads the configured recent range without moving coverage:

```bash
node cli.mjs repair \
  --pair "${PAIR_ID}" \
  --store directory \
  --root /absolute/path/to/index-data
```

Scheduled jobs run the ordered groups from
`registry/collection-plan.json`. The workflow contains the same cron
expressions because GitHub must read schedules before repository code starts.
The same plan validates group runtime and the maximum rolling-hour GitHub
request and content-generation load. One group command shares an adapter that
paces every GitHub content-generating request; the plan includes that maximum
wait in each group runtime estimate.

## Verify a pair

Verification pins one selected state, streams its months and source days, and
re-derives every selected resolution directly from the one-minute files.

Directory:

```bash
node cli.mjs verify \
  --pair "${PAIR_ID}" \
  --store directory \
  --root /absolute/path/to/index-data
```

Public GitHub Releases, without a token:

```bash
env -u GITHUB_TOKEN node cli.mjs verify \
  --pair "${PAIR_ID}" \
  --store github \
  --repository stelis-dev/robinhood-stock-token-index
```

A verified result names the exact selected state identity, complete catalog,
coverage, month and day counts, source-candle count, and derived artifact and
candle counts. `status: "empty"` means the pair has no selected state.

## Read one month and one resolution

`read` never chooses a resolution and has no default. It accepts exactly one
owner month and one catalog label.

Read canonical one-minute day files:

```bash
node cli.mjs read \
  --pair "${PAIR_ID}" \
  --month 2026-08 \
  --resolution 1m \
  --store directory \
  --root /absolute/path/to/index-data
```

Read one derived resolution anonymously from GitHub:

```bash
env -u GITHUB_TOKEN node cli.mjs read \
  --pair "${PAIR_ID}" \
  --month 2026-08 \
  --resolution 4h \
  --store github \
  --repository stelis-dev/robinhood-stock-token-index
```

A successful result contains:

- `selectedState`: the pinned state generation, gzip byte count, and digest;
- `catalog`: every available label and interval;
- `stateCoverage`: canonical selected coverage;
- `ownerMonth` and the exact label and interval requested;
- `monthReference`: the selected immutable month reference;
- `coverage` for `1m` or `timeCoverage` for a derived resolution; and
- `files`: exact references paired with decoded stored values.

`1m` returns the month's ordered day files. A derived label returns exactly one
resolution artifact and does not load another derived resolution or any day
file.

Normal absence is explicit:

- `status: "empty"`: the pair has no selected state;
- `reason: "month_not_selected"`: the selected state does not contain the owner
  month; or
- `reason: "resolution_not_published"`: canonical coverage does not yet contain
  a complete natural interval for that label and owner month.

A missing or altered referenced file is not normal absence; verification and
read fail integrity validation.

## Load several months without changing state

Do not run independent state selection between months. Pin one state and resolve
every month and resolution reference from that same value:

```js
import { loadPairRegistry } from "./collector/pair-registry.mjs";
import {
  readPairMonth,
  readPairResolution,
  readPairStateSelection,
} from "./collector/pair-reader.mjs";
import { pairMonthLogicalId } from "./collector/pair-file-identity.mjs";
import { validateSelectedPairMonth } from "./collector/pair-files.mjs";
import { createStore } from "./storage/create-store.mjs";

const repository = "stelis-dev/robinhood-stock-token-index";
const pairId = "0x...";
const ownerMonths = ["2026-05", "2026-06", "2026-07", "2026-08"];
const resolutionLabel = "12h";

const registry = await loadPairRegistry();
const store = createStore({
  kind: "github",
  repository,
  maximumArtifactBytes: registry.collection.maximumArtifactBytes,
});
const selected = await readPairStateSelection({ registry, pairId, store });
if (selected === null) throw new Error("The pair has no selected data.");
const definition = selected.state.resolutions.find((entry) => entry.label === resolutionLabel);
if (definition === undefined) throw new Error("The selected state does not contain the resolution.");
const intervalSeconds = definition.intervalSeconds;

const values = [];
for (const ownerMonth of ownerMonths) {
  const logicalId = pairMonthLogicalId(pairId, ownerMonth);
  const monthReference = selected.state.months.find((entry) => entry.logicalId === logicalId);
  if (monthReference === undefined) continue;
  const month = await readPairMonth({ registry, store, reference: monthReference });
  validateSelectedPairMonth({ state: selected.state, month }, { registry });
  const reference = month.resolutions.find((entry) => entry.intervalSeconds === intervalSeconds);
  if (reference === undefined) continue;
  values.push(await readPairResolution({ registry, store, reference }));
}
```

The consumer may concatenate `values` in owner-month order and apply its own
period rules. This repository does not choose a display interval, trim a chart
range, cache downloads, or construct chart output.

For `2d`, add the preceding owner month when the requested range begins inside
an epoch-aligned two-day candle. The complete candle remains in its start month.

## Direct integrity checks

A direct reader that does not use this repository's reader must still:

1. select one uploaded state generation and keep its exact bytes pinned;
2. verify gzip size and SHA-256 before decompression;
3. enforce the decompressed JSON byte boundary and JSON SHA-256;
4. validate the strict stored member set and pair identity;
5. resolve months only through the pinned state's references;
6. resolve day or resolution files only through the selected month;
7. verify logical identity, generation, coverage, interval, ordering, and every
   reference digest; and
8. treat a missing referenced file or semantic mismatch as corruption or
   unavailable storage, never as a no-trade interval.

Filenames and Release listings locate bytes. They do not override references or
establish deletion authority.

## Add a pair

Check current group capacity:

```bash
node register-pair.mjs --status
```

Prepare one complete candidate registry entry and measure one complete pair
collection. A dry run validates both resulting registries and selects the
eligible group with the lowest estimated runtime:

```bash
node register-pair.mjs \
  --candidate /absolute/path/to/pair.json \
  --measured-seconds 180
```

Apply the same validated result only after reviewing the dry run:

```bash
node register-pair.mjs \
  --candidate /absolute/path/to/pair.json \
  --measured-seconds 180 \
  --write
```

The command never derives PoolKeys or addresses, contacts the chain, publishes
data, creates a group, or changes a schedule. Pair registration is complete only
after collection and verification succeed for the exact new PoolId.

## RPC endpoints

`registry/pairs.json` fixes the primary RPC URL and chain identity. Optional
fallbacks are complete URLs from these GitHub Actions repository secrets:

```text
INDEX_RPC_FALLBACK_URL_0
INDEX_RPC_FALLBACK_URL_1
```

One phase uses one endpoint and one fixed block range. After bounded endpoint
availability failures, all unpublished work is discarded and the whole phase
restarts from selected state on the next endpoint. Data from two endpoints is
never combined in one phase. Chain identity, malformed responses, invalid
requests, numeric errors, and stored-data integrity failures remain fatal.

Endpoint URLs, provider messages, response bodies, and tokens are not written
to operational logs.

## Publication and recovery

The publication manifest is the first mutation. Day files are written first,
then derived-resolution files, month files, and state last. State selection is
the only public visibility point.

Recovery has one decision:

- if the manifest's previous state is selected, verify it and remove only the
  exact unpublished next files;
- if the next state is selected, verify it and remove only exact superseded
  files; or
- otherwise fail stored-data integrity.

Cleanup is blocking and resumable. The manifest is removed last. Repository
scans, filenames, and missing references are never deletion authority.

## Clean first publication

This project starts with an empty public data store. Use this transition order
so a scheduled job cannot recreate development data during the reset:

1. disable the `Stock Token index` workflow in GitHub and wait until no
   operation is running or queued;
2. manually remove every existing index Release and its corresponding tag;
3. push this implementation while the workflow remains disabled;
4. enable the workflow; and
5. dispatch the first `collect` operation from empty storage.

The code contains no data-conversion path, bulk-delete command, alternate reader, or
mixed-data path.

The first pair collection sees exact absence and publishes generation 1. Until
that state is selected, the pair has no public data. Current and historical
collection then build coverage from the fixed activation and `historyStart`
boundaries.

## Data not stored in Releases

The following remain in the Git repository or local runtime rather than GitHub
Releases:

- `registry/pairs.json` and `registry/collection-plan.json`;
- workflow, source code, and documentation;
- local directory-store data;
- RPC responses and failed in-memory candidates; and
- unfinalized or incompletely covered intervals.

Only files reachable from one selected pair state are public market data.
