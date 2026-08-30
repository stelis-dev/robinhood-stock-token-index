# Robinhood Chain USDG market data

This repository collects finalized Uniswap V4 `Swap` events for configured
Robinhood Chain base currencies quoted by USDG and records verifiable candle
data in a local directory or GitHub Releases.

It owns collection and recording only. It does not choose a chart resolution,
assemble chart output, route swaps, compare pools, or provide a production
availability guarantee.

## Consumer quick start

This README defines the public data contract for consumers. `AGENTS.md` governs
contributors and coding agents working in this repository; its work policy is
not part of the public data format or consumer protocol.

GitHub Releases are development and test storage, so availability is not
guaranteed. Public `read` and `verify` commands do not require `GITHUB_TOKEN`.
Node.js 22 or later is required.

Install the pinned dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts
```

Choose a base currency by its exact lowercase address key under
`baseCurrencies` in [`registry/market-data.json`](registry/market-data.json).
The symbol is display metadata, not an identifier.

Read one base currency, UTC owner month, and exact stored resolution from the
public Releases. This convenience example tries AAPL `1h` data for the caller's
current UTC calendar month:

```bash
OWNER_MONTH="$(date -u +%Y-%m)"
node cli.mjs read \
  --base 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9 \
  --month "$OWNER_MONTH" \
  --resolution 1h \
  --store github \
  --repository stelis-dev/robinhood-stock-token-index
```

The caller's clock does not determine an owner month. The selected base-state
`months` references are authoritative. Near a UTC month transition or after a
publication delay, the current calendar month can correctly return `absent`;
for a deterministic read, pin the public root and choose an exact owner month
listed by the requested base state as described under
[Pin and read a public root](#pin-and-read-a-public-root).

Use one of the fixed stored resolutions listed under
[Recorded data](#recorded-data). For `1m`, `read` returns the selected base-day
files in the owner month. For every other resolution, it returns the one
selected base-resolution file owned by that month. It does not choose a
resolution, trim an arbitrary time range, or assemble chart output. The command
pins one selected root and downloads only the references needed for that base
currency, month, and resolution by byte Range. It never falls back to
downloading a complete packed asset.

An owner month containing the selected root's `currentUntil` is still in
progress. It contains only the coverage selected by that root, not a promise of
a complete calendar month, and a later root may extend it.

To verify every selected logical file in the complete public root instead:

```bash
node cli.mjs verify \
  --store github \
  --repository stelis-dev/robinhood-stock-token-index
```

Both commands print one JSON result:

- `unpublished` means there is no selected root;
- `absent` means the selected root has no state or owner month for the requested
  configured base currency;
- `read` means the returned files and their coverage are selected by the pinned
  root; and
- `verified` means every logical file selected by the pinned root passed full
  verification.

Coverage means its complete half-open block and UTC range was queried for the
recorded PoolId. In canonical `1m`, a fully covered minute with no candle has no
contributing Swap with two non-zero token deltas; a valid zero-delta Swap
contributes coverage but no candle value. For a derived resolution, a missing
candle means no stored candle for that natural interval. It means no trade only
when the complete interval is also contained by one continuous PoolId-owned
coverage segment; an incomplete or cross-PoolId interval is deliberately not
emitted.

Invalid stored data or unavailable required storage fails the command instead
of returning partial data.

## Recorded data

`registry/market-data.json` is the human-authored configuration. It fixes:

- Robinhood Chain and the PoolManager;
- USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168`;
- each base-currency address and decimals;
- the exact current PoolId, PoolKey, and Initialize fact; and
- a symbol used only for human readability.

Native ETH uses `0x0000000000000000000000000000000000000000`.
The program validates the base currency/USDG PoolKey and derives its PoolId
before any log request. It never selects a PoolId from symbol, price, volume,
liquidity, fee, routing, or display order.

One operation queries every PoolId applicable to the same finalized range
together, validates every returned Swap, classifies by PoolId, and records
continuous coverage and canonical `1m` candles by base-currency address.
A configured base currency with no selected state joins the first current phase
whose resulting coverage end is later than its Initialize minute. Its
initial suffix shares every overlapping range with existing current work, so a
current backlog cannot postpone a base satisfying the Initialize time and block
conditions or create a separate current boundary. The resolved first block of
the Initialize minute cannot follow the Initialize block, and the Initialize
block must precede the phase's resolved exclusive ending block. The common
coverage end becomes the selected root's `currentUntil` only after publication.

The fixed stored resolutions are:

```text
1m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 2d
```

Every derived resolution is calculated directly from canonical `1m`. A derived
candle is emitted only for a complete natural UTC interval owned by one PoolId.
Different PoolIds are never combined into one candle.

## Collection and local maintenance

Collect all configured base currencies into a directory:

```bash
node cli.mjs collect \
  --store directory \
  --root /absolute/path/to/market-data
```

Collect to GitHub Releases:

```bash
GITHUB_TOKEN='...' \
node cli.mjs collect \
  --store github \
  --repository stelis-dev/robinhood-stock-token-index
```

Run at most one mutating `collect` or `repair` operation at a time for the same
GitHub repository or Directory root. The repository Actions workflow enforces
this for automated GitHub writes through its non-cancelling concurrency queue;
direct CLI callers must preserve the same storage-surface serialization.

The GitHub Actions workflow schedules shared `collect` every 15 minutes. Its
exact UTC minute offsets are defined in
[`.github/workflows/usdg-market-data.yml`](.github/workflows/usdg-market-data.yml). Scheduled runs
never invoke `repair`.

The fixed primary RPC is `https://rpc.mainnet.chain.robinhood.com`. Optional
fallbacks are complete secret URLs in this order:

```text
INDEX_RPC_FALLBACK_URL_0
INDEX_RPC_FALLBACK_URL_1
```

One collect command runs at most two independently durable phases against one
fixed finalized block. Current work precedes history. A failure of the second
phase cannot discard a root selected by the first.

Verify one complete selected root:

```bash
node cli.mjs verify \
  --store directory \
  --root /absolute/path/to/market-data
```

Read one base currency, owner month, and exact stored resolution:

```bash
node cli.mjs read \
  --base 0x0000000000000000000000000000000000000000 \
  --month 2026-08 \
  --resolution 1h \
  --store directory \
  --root /absolute/path/to/market-data
```

`read` does not choose a resolution or assemble a requested chart period.

Repair requires one exact recorded PoolId range and changes neither current nor
history progress:

```bash
node cli.mjs repair \
  --base 0x... \
  --pool-id 0x... \
  --from-block 123 \
  --from-timestamp 2026-08-27T00:00:00.000Z \
  --until-block 456 \
  --until-timestamp 2026-08-27T00:15:00.000Z \
  --store directory \
  --root /absolute/path/to/market-data
```

## Logical files

One selected root reaches these logical files:

```text
selected root
  -> base state
       -> base month
            -> base day containing canonical 1m
            -> one file for every derived resolution
```

Logical identities are exactly:

```text
base/<baseCurrencyAddress>/state
base/<baseCurrencyAddress>/month/<YYYY-MM>
base/<baseCurrencyAddress>/day/<YYYY-MM-DD>
base/<baseCurrencyAddress>/resolution/<resolution>/<YYYY-MM>
```

Every logical file is canonical JSON with no schema-version member. Its address,
day, month, and resolution fields must equal the same values in its `logicalId`.

A stored member reference contains exactly:

```text
assetSha256, from, gzipSha256, jsonBytes, jsonSha256, logicalId, until
```

`[from, until)` is the member's byte range inside the physical asset. A coverage
segment contains exactly:

```text
fromBlock, fromTimestamp, poolId, untilBlock, untilTimestamp
```

Coverage segments are ordered, continuous, half-open ranges. The logical file
schemas are:

- base state: `baseCurrencyAddress`, `decimals`, ordered `months`, ordered
  `poolPeriods`, and `pools` keyed by PoolId;
- PoolId facts: `historyFrom`, `initialize`, `poolKey`, and `sourceFrom`;
- base month: `baseCurrencyAddress`, `coverage`, ordered `days`, `month`, and one
  reference for every derived resolution in `resolutions`;
- base day: `baseCurrencyAddress`, canonical `candles`, `coverage`, and `day`;
- base resolution: `baseCurrencyAddress`, derived `candles`, `coverage`,
  `intervalSeconds`, and `ownerMonth`.

Base-day coverage preserves the exact durable-phase boundaries recorded in the
day, including adjacent segments with the same PoolId. Resolution derivation
may coalesce those adjacent segments in memory to prove a continuous natural
interval; it does not rewrite the source day boundaries used by retention and
history.

Base-state `months` are strictly ordered unique references. `poolPeriods` are
continuous and every period names one entry in `pools`; unused PoolId facts are
invalid. A PoolId's `historyFrom` equals its first selected period boundary,
never precedes `sourceFrom`, and `sourceFrom` never precedes the Initialize
minute. The final pool period ends exactly at the root's `currentUntil` boundary.
Base-month `days` are strictly ordered unique references inside the named month,
and `resolutions` contains every non-`1m` catalog label exactly once.

A canonical `1m` candle contains exactly:

```text
baseVolumeRaw, close, firstSource, high, intervalEnd, intervalStart,
lastSource, low, open, quoteVolumeRaw, tradeCount
```

A derived candle additionally contains `observedStart`, `observedEnd`, and
`sourceCandleCount`. Prices are reduced positive rationals with `numerator` and
`denominator`. A source position contains `blockHash`, `blockNumber`, `logIndex`,
`transactionHash`, and `transactionIndex`.

Every OHLC price is exact normalized USDG per one base-currency unit:

```text
price = (quoteAmountRaw / 10^usdgDecimals)
      / (baseAmountRaw / 10^baseCurrencyDecimals)
```

Evaluate `numerator / denominator` only at the consumer's desired precision;
the stored value itself is not floating point. `baseVolumeRaw` is the sum of
absolute contributing base-currency Swap amounts in the base currency's
smallest unit. `quoteVolumeRaw` is the corresponding sum in the USDG smallest
unit. Divide them by `10^base-state.decimals` and `10^root.usdgDecimals`
respectively for normalized units. `tradeCount` counts contributing non-zero
Swaps; a derived candle sums the canonical `1m` volumes and trade counts.

Canonical field rules are:

- an address is lowercase `0x` plus exactly 40 hexadecimal digits; a PoolId or
  hash is lowercase `0x` plus exactly 64 hexadecimal digits;
- a decimal string is `0` or a non-zero decimal integer without a leading zero;
- a UTC instant is `YYYY-MM-DDTHH:mm:ss.000Z`; collection and coverage
  boundaries are minute-aligned;
- a collection boundary contains exactly `blockNumber` as a decimal string and
  `timestamp`; an Initialize fact has the same members but its timestamp need
  not be minute-aligned;
- a PoolKey contains exactly `currency0`, `currency1`, numeric `fee`, `hooks`,
  and numeric `tickSpacing`; `currency0 < currency1`, `0 <= fee < 16777216`, and
  `0 < tickSpacing < 8388608`; currencies contain the base currency and fixed
  USDG and the complete PoolKey derives the recorded PoolId;
- `fromBlock`, `untilBlock`, volumes, and derived `tradeCount` are decimal
  strings; a `1m` candle's `tradeCount`, source indexes, `sourceCandleCount`,
  decimals, byte ranges, byte counts, and publication sequence are safe JSON
  integers;
- source indexes and byte-range starts are non-negative; candle counts, byte
  counts, and publication sequence are positive;
- decimals are in `0..255`; native ETH has `18` decimals and fixed USDG has `6`;
- `from` is non-negative, `until` and `jsonBytes` are positive, and
  `from < until`; every SHA-256 is exactly 64 lowercase hexadecimal digits;
- a physical asset's `bytes` is positive and no greater than `430563600`.

Every coverage array is non-empty. For each segment, `fromBlock <= untilBlock`
and `fromTimestamp < untilTimestamp`. Adjacent segments meet at the same block
and timestamp without a gap or overlap. Day coverage remains inside its named
UTC day, month coverage remains inside its named UTC month, and resolution
coverage remains inside the owner-period bound described below.

Every price component is a positive reduced rational. For every candle,
`high >= open`, `high >= close`, `low <= open`, `low <= close`, and
`high >= low`. Both volumes and trade count are positive. A `1m` candle lasts
exactly 60 seconds; its trade count is a positive safe integer. Its first and
last source positions lie inside exactly one coverage segment and agree with a
single-trade or multiple-trade source span. Candles and their source positions
are strictly ordered without duplication.

A derived candle is epoch-aligned, lasts exactly its selected resolution, and
starts in `ownerMonth`. The relation is
`intervalStart <= observedStart < observedEnd <= intervalEnd`. Its volumes and
trade count are positive decimal strings.
`sourceCandleCount` is positive, no greater than the resolution's minute count
or observed minute span, and no greater than `tradeCount`.

Stored references and selected asset entries are strictly ordered and unique.
One logical ID is selected from exactly one physical asset. Its parent reference
must match the exact packed member range and digests, and its decoded address,
day, month, and resolution must match the logical ID. Asset entries are strictly
ordered and unique by SHA-256; data assets contain only day and resolution
members from their Release owner month, while one index asset contains only
base-month members or only base-state members.

The resolution catalog entries contain exactly `label`, `intervalSeconds`, and
`partition`. Their fixed values are:

```text
1m:60:day, 15m:900:month, 30m:1800:month, 1h:3600:month,
2h:7200:month, 4h:14400:month, 6h:21600:month, 12h:43200:month,
1d:86400:month, 2d:172800:month
```

Base-month coverage stays inside its named UTC month. Base-resolution coverage
starts in its owner month and extends only to the first natural interval boundary
at or after the month end. A candle is present only when its complete natural
interval is contained by one continuous PoolId-owned coverage segment.

The selected root contains exactly `assets`, `baseCurrencies`, `currentUntil`,
`poolManager`, `publicationSequence`, `resolutions`, `usdgAddress`, and
`usdgDecimals`. Each selected `assets` entry contains exactly `assetName`,
`bytes`, ordered `logicalIds`, `releaseTag`, and `sha256`. `baseCurrencies` maps
each recorded base-currency address to its exact base-state reference.

The root uses the same canonical JSON encoding as logical files. It does not
contain a storage URL or include itself in its asset table.

## GitHub Release layout

Logical files are independently encoded and gzip-compressed, then concatenated
into immutable packed assets.

```text
market-data-<YYYY-MM>-s<N>
  data-<assetSha256>.bin

market-data-index-s<N>
  index-<assetSha256>.bin

market-data-catalog
  root-s<publicationSequence>-<rootSha256>.json.gz
  publication.json.gz
```

Data packing is separated by owner month. Base-month indexes and base-state
indexes are packed in separate steps. Adding another logical member never
changes the meaning of an existing immutable asset.

`publication.json.gz` is internal mutation authority. It is not selected market
data. The next root is uploaded last and is the only selection point. An
interrupted action therefore leaves either the previous complete root or the
complete next root selected.

The writer admits only published, non-draft, mutable Release responses. This
layout cannot operate with immutable Releases because later publications add
content-addressed assets and delete exact superseded assets. It uses only the
existing Actions `GITHUB_TOKEN` and does not inspect or change repository
settings. An immutable Release response stops publication without selecting the
next root. The repository does not retry it under another tag or add an
administration credential.

If no selected root exists, `read` and `verify` report `unpublished`. This does
not prove that the physical Release namespace is empty: a failed first
publication may have left an unselected publication record, asset, or Release.

If an interrupted publication still has its previous root selected, a later
action repeats the fixed RPC collection and encoding. An existing remote asset
is reused only when its complete bytes equal the independently regenerated
bytes and the regenerated publication record matches exactly.

## Pin and read a public root

The public catalog Release and its unauthenticated API endpoint are:

- [market-data-catalog Release](https://github.com/stelis-dev/robinhood-stock-token-index/releases/tag/market-data-catalog)
- [market-data-catalog API](https://api.github.com/repos/stelis-dev/robinhood-stock-token-index/releases/tags/market-data-catalog)

Keep one root fixed for an entire multi-file read:

1. List all assets in the `market-data-catalog` Release.
2. Admit uploaded names matching exactly
   `root-s<positiveSequence>-<sha256>.json.gz`.
3. Reject duplicate sequences or contradictory metadata.
4. Select the greatest sequence. Do not fall back to an older root if the
   greatest root is invalid.
5. Download the complete root without authentication and verify its filename
   digest, listed byte count, returned bytes digest, and decoded schema.
6. Resolve the requested base-state reference from that pinned root.
7. Resolve its base-month reference, then the requested day or resolution
   reference, without selecting another root.
8. Match every reference to exactly one root asset entry having both the same
   asset SHA-256 and the referenced logical ID.

An exact asset URL is:

```text
https://github.com/<owner>/<repository>/releases/download/<releaseTag>/<assetName>
```

For a stored member reference with half-open range `[from, until)`, send:

```http
Range: bytes=<from>-<until-1>
Accept-Encoding: identity
```

Apply the same Range header after every redirect. Accept only:

- status `206`;
- `Content-Range: bytes <from>-<until-1>/<assetBytes>`;
- identity content encoding;
- exactly `until - from` response bytes;
- the referenced gzip SHA-256;
- the referenced decoded JSON byte count and SHA-256; and
- the referenced logical identity and strict file schema.

A valid Range request answered with `200` is storage unavailable; do not
download the complete packed asset as a fallback. Contradictory range metadata,
bytes, digests, or logical identity is stored-data corruption.

## Twelve-month selection

The selected range begins no earlier than twelve UTC calendar months before the
root's `currentUntil` boundary. A UTC day or month file crossing that lower
boundary may contain a bounded earlier prefix. The prefix is outside the
selected range and must not be interpreted as additional retained history. If
the boundary lies inside a recorded durable coverage segment, that segment is
kept from its stored start; no synthetic block boundary is created and the
prefix is not collected again.

An asset remains selected while at least one of its logical IDs is reachable.
It becomes deletion authority only after a validated root transition removes
its last logical ID. Release listings, filenames, ages, and missing references
never authorize deletion.

## Verification and development

Run the offline suite:

```bash
npm test
```

`verify` pins one root, traverses every base state, month, day, and resolution,
checks complete asset membership, and independently derives every stored
resolution from selected canonical `1m` data.

GitHub publication claims additionally require a manual workflow run followed
by unauthenticated `verify` and exact `read` operations against the published
root.
