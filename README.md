# Robinhood Stock Token Index

This repository builds exact one-minute executed-trade candles for nine fixed
Uniswap V4 pairs on Robinhood Chain: eight Stock Token/USDG pairs and one
native ETH/USDG pair. Every series is identified by its exact PoolId and
PoolKey. USDG is an onchain token, not fiat USD.

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

GitHub Actions and Releases are development adapters. They are not a
public-production availability claim. The canonical artifacts contain logical
pair and calendar references, never a GitHub repository, Release tag, URL,
asset ID, token, workflow context, or RPC endpoint.

## Pair lifecycle

`collect` runs two durable operations in order for one `--pair`:

1. current collection advances the forward edge from the pair's activation or
   last selected state;
2. historical collection moves the other edge backward toward the fixed
   `historyStart`, which is never more than twelve calendar months before the
   activation boundary.

The two operations publish independently. A historical RPC failure cannot undo
an already selected current publication. `repair` replaces the configured
recent interval without moving either coverage edge. Missing-trade minutes stay
empty; no interpolation or zero-price candle is created.

There is no scheduled or grouped collection in the current workflow. Manual
dispatch accepts one exact pair ID and either `collect` or `repair`. There is no
automatic age deletion: after the fixed historical edge is reached, later
current data continues to accumulate.

## Storage and reads

Canonical candle data is one pair and one UTC day. A pair-month manifest refers
to at most 31 pair-days, and selected pair state refers directly to produced
months. Year grouping is derived from canonical `YYYY-MM` month identities; it
is not a stored parent. Changed immutable days and months are written and
re-downloaded before the new state is written last. The exact selected state is
then re-read. A pair with no published data has no selected state carrier. Each
persisted state generation contains a month from that generation, and each
persisted month generation contains a day from that generation. Explicit full
verification streams all selected months and days separately.

The directory adapter uses:

```text
pairs/{pairId}/state/
pairs/{pairId}/months/{YYYY-MM}/
```

The GitHub adapter keeps one selected-state Release per pair and one child
Release per pair-month. Referenced bytes use deterministic public Release
download paths. After a new state is selected, cleanup lists only that state
Release and the pair-month Releases changed by the transition; it does not
enumerate retained Releases or traverse unchanged history. Cleanup first proves
the exact selected and retained carriers, then removes superseded generations
only for the logical month and day identities named by that transition. An
omitted identity is left untouched. Routine publication still reads and
rebuilds the selected state's ordered month-reference metadata; it grows by one
bounded reference per produced month even though unchanged month and day
carriers are not read or listed.

`read` accepts one pair and one non-empty interval inside one UTC calendar
month. It reads only the selected month and intersecting pair-days. The
result distinguishes unavailable time from covered time with no Swap.

Example commands using the committed NVDA/USDG PoolId:

```sh
PAIR_ID=0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1

npm test
npm run collect -- --pair "${PAIR_ID}" --store directory --root .local-index
npm run repair -- --pair "${PAIR_ID}" --store directory --root .local-index
npm run verify -- --pair "${PAIR_ID}" --store directory --root .local-index
npm run read -- --pair "${PAIR_ID}" \
  --from 2026-08-14T14:01:00.000Z \
  --until 2026-08-14T15:01:00.000Z \
  --store directory --root .local-index
```

Published public GitHub Releases can be read and verified without a token.
GitHub collection, repair, upload, and cleanup require a repository token with
contents write permission.

## RPC availability

The committed public RPC URL is always primary. An operation may append two
ordered complete URLs from the repository secrets
`INDEX_RPC_FALLBACK_URL_0` and `INDEX_RPC_FALLBACK_URL_1`. Each secret contains
the full HTTPS URL, including a provider credential when required. The workflow
does not use repository variables, assemble URLs, or print URLs.

Each endpoint must support `eth_chainId`, the `finalized` block tag, historical
`eth_getLogs`, `eth_getBlockByNumber`, and JSON-RPC header batches at the
configured size. Every attempt also verifies the committed activation block,
hash, and timestamp.

After bounded local availability retries are exhausted, or an endpoint denies
access or lacks a required RPC capability, the unpublished attempt is discarded
and the complete operation restarts from durable state on the next endpoint.
Providers are never mixed inside one current, historical, or repair attempt.
Chain identity, activation identity, malformed responses, invalid requests,
numeric errors, and storage-integrity failures stop without fallback.

In GitHub Actions only, stderr records the attempt role and one fixed source
name: `registry.chain.primaryRpcUrl`, `INDEX_RPC_FALLBACK_URL_0`, or
`INDEX_RPC_FALLBACK_URL_1`. It never records the endpoint URL or provider
response. This line is not part of stdout or stored data.

Fallback improves availability but does not prove that an HTTP 200
`eth_getLogs` response is complete. Coverage means the stated finalized block
range was queried and admitted on one endpoint; it is not provider consensus or
a cryptographic completeness proof.

## Candle meaning

Each candle stores exact rational OHLC values in quote-token units per one base
token unit, exact raw base and quote volume, admitted trade count, and source
positions. It does not contain a recommendation, executable quote, raw RPC
response, wallet, account, or transaction history.
