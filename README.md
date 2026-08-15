# Robinhood Stock Token Index

This repository builds exact one-minute executed-trade candles for nine fixed
Uniswap V4 pairs on Robinhood Chain: eight Stock Token/USDG pairs and one native
ETH/USDG pair. Every series is identified by its exact PoolId and PoolKey. USDG
is an onchain token, not fiat USD, and native ETH is not WETH.

The current data path is:

```text
one exact pair
  -> finalized Robinhood Chain Swap logs
  -> exact base/quote trades
  -> exact one-minute candles and continuous coverage
  -> canonical pair-day, pair-month, and pair-state artifacts
  -> raw-byte storage
       -> local directory
       -> GitHub Releases for development and end-to-end testing
```

Collection groups schedule existing pair operations. They do not create a
group-owned cursor, candle, artifact, or read interface.

## Install and discover identifiers

Use Node.js 22 or newer, then install the pinned dependency closure without
running package lifecycle scripts:

```sh
npm ci --ignore-scripts
```

Print every current display label and exact pair ID from the authoritative
registry:

```sh
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const registry = JSON.parse(await readFile("registry/pairs.json", "utf8"));
  for (const entry of registry.pairs) {
    console.log(entry.display.label + "\t" + entry.pair.pairId);
  }
'
```

Print current collection-group membership:

```sh
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const registry = JSON.parse(await readFile("registry/collection-groups.json", "utf8"));
  for (const group of registry.groups) {
    console.log(group.groupId + "\t" + group.pairIds.join(","));
  }
'
```

Commands accept exact IDs only. Symbols and display labels are not aliases.

## Local collection and reads

Choose an exact pair ID and a local storage root:

```sh
PAIR_ID=0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1
INDEX_ROOT=.local-index

node cli.mjs collect --pair "${PAIR_ID}" --store directory --root "${INDEX_ROOT}"
node cli.mjs verify --pair "${PAIR_ID}" --store directory --root "${INDEX_ROOT}"
```

`collect` first advances current coverage and then independently extends
historical coverage toward the pair's fixed `historyStart`. `repair` re-reads
the configured recent interval without moving either coverage edge:

```sh
node cli.mjs repair --pair "${PAIR_ID}" --store directory --root "${INDEX_ROOT}"
```

The `verify` stdout envelope contains `result.coverage`. Its `fromTimestamp` and
`untilTimestamp` are the available half-open boundary. The built-in `read`
contract accepts minute-aligned canonical UTC boundaries, rejects rather than
rounds other boundaries, and requires a non-empty interval inside one UTC
calendar month. Split a coverage range at UTC month boundaries when it spans
more than one month:

```sh
node cli.mjs read --pair "${PAIR_ID}" \
  --from 2026-08-14T14:01:00.000Z \
  --until 2026-08-14T15:01:00.000Z \
  --store directory --root "${INDEX_ROOT}"
```

Pair-day and pair-month artifacts retain minute-aligned coverage, and stored
candles remain exact one-minute candles. A downstream product whose own
half-open request contains seconds or milliseconds keeps that public request
unchanged, selects the overlapping monthly data, and exposes only candles fully
contained in the original request. That downstream composition does not change
the stored artifact contract or its version.

Local collection uses the committed primary RPC. Optional fallback RPCs are
complete HTTPS URLs supplied as `INDEX_RPC_FALLBACK_URL_0` and then
`INDEX_RPC_FALLBACK_URL_1`.

## Anonymous public verification and reads

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

Use the coverage returned by the first command to choose the second command's
single-month interval. GitHub collection, repair, upload, and cleanup require a
repository token with contents write permission.

## GitHub Actions operation

Manual workflow dispatch accepts:

- `operation`: `collect` or `repair`;
- `targetKind`: `pair` or `group`;
- `targetId`: an exact ID from `registry/pairs.json` or
  `registry/collection-groups.json` matching the selected kind.

Scheduled runs execute `collect` only. The three admitted groups are staggered
so that one group starts every fifteen minutes and each group is selected every
forty-five minutes. All mutation jobs share one concurrency group, execute one
at a time, retain pending jobs instead of replacing them, and never cancel an
in-progress publication. Group members publish independently: a failed member
does not roll back earlier success, later members are still attempted, and the
group exits unsuccessfully after the sequence. `repair` is manual because no
automatic repair cadence has been admitted.

GitHub schedules are best effort and may be delayed or dropped. A later
successful collection resumes from each pair's selected durable state, but a
delay can reduce freshness while the pair catches up. This repository does not
claim exact real-time delivery or a production availability level.

## Pair lifecycle and storage

Current collection advances only the forward edge. Historical collection moves
only the other edge toward the fixed `historyStart`, which is never more than
twelve calendar months before activation. The two operations publish
independently. A historical RPC failure cannot undo an already selected current
publication. Missing-trade minutes stay empty; no interpolation or zero-price
candle is created. After the historical edge is reached, later current data
continues to accumulate; there is no automatic age deletion.

Canonical candle data is one pair and one UTC day. A pair-month manifest refers
to at most 31 pair-days, and selected pair state refers directly to produced
months. Year grouping is derived from canonical `YYYY-MM` month identities and
is not stored. Changed immutable days and months are written and re-downloaded
before state is written last, and the selected state is then re-read.

The directory adapter uses:

```text
pairs/{pairId}/state/
pairs/{pairId}/months/{YYYY-MM}/
```

The GitHub adapter uses one selected-state Release per pair and one child
Release per pair-month. Canonical artifacts contain no repository, Release tag,
URL, asset ID, token, workflow context, group, schedule, or RPC endpoint.
Cleanup proves the exact selected and retained carriers before removing only
superseded generations named by the selected transition. Omission is never
deletion authority.

## Output and candle meaning

Every command writes a JSON stdout envelope containing `ok`, `operation`, the
exact target ID, and `result`. Group execution leaves each pair command's
envelope intact and adds one final group summary with ordered pair IDs and
`success` or `failure` status.

- `coverage` is the continuous finalized range queried and admitted for one
  pair. It is not proof of agreement between RPC providers.
- `available` and `unavailable` exactly partition the requested period.
- A covered minute with no candle means no admitted Swap occurred; it does not
  mean a zero price.
- OHLC values are exact rational quote-token units per one base token unit.
- `baseVolumeRaw` and `quoteVolumeRaw` are exact raw token amounts.
- `tradeCount` is the number of admitted Swap logs in the candle.

Candles are executed-trade evidence, not recommendations or executable quotes.
They contain no raw RPC response, wallet, account, or transaction history.

## RPC availability

The committed public RPC URL is always primary. A run may append two ordered
complete URLs from `INDEX_RPC_FALLBACK_URL_0` and
`INDEX_RPC_FALLBACK_URL_1`. GitHub Actions reads both from repository secrets;
it does not assemble URLs, use repository variables, or print endpoint values.

Each endpoint must support `eth_chainId`, the `finalized` block tag, historical
`eth_getLogs`, `eth_getBlockByNumber`, and JSON-RPC header batches at the
configured size. Every attempt also verifies the committed activation block,
hash, and timestamp.

After bounded availability retries are exhausted, or an endpoint denies access
or lacks a required capability, the unpublished attempt is discarded and the
complete operation restarts from durable state on the next endpoint. Providers
are never mixed inside one current, historical, or repair attempt. Chain
identity, activation identity, malformed responses, invalid requests, numeric
errors, abort, and storage-integrity failures stop without fallback.

In GitHub Actions only, stderr records the attempt role and one fixed source
name: `registry.chain.primaryRpcUrl`, `INDEX_RPC_FALLBACK_URL_0`, or
`INDEX_RPC_FALLBACK_URL_1`. It never records the endpoint URL or provider
response. A failed pair records only its `current`, `history`, or `repair` role.
If GitHub cleanup fails, stderr also records the fixed cleanup phase, pair ID,
selected sequence, and affected month. These operational records never contain
an endpoint URL, token, response body, exception message, or stack trace. This
fixed diagnostic record is separate from the command's existing terminal error.
Fallback improves availability but cannot prove that an HTTP 200 `eth_getLogs`
response is complete.

GitHub Actions and Releases remain development and test adapters, not the
market source or a public-production availability claim.
