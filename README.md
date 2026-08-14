# Robinhood Stock Token Index

This repository builds exact one-minute USDG executed-trade candles from
finalized Uniswap V4 `Swap` logs on Robinhood Chain. It starts with one logical
group containing eight initialized Stock Token/USDG pools.

The index keeps source facts and storage separate:

```text
finalized Robinhood Chain logs
  -> exact Swap admission
  -> exact one-minute candles and coverage
  -> canonical gzip artifacts
  -> storage port
       -> local directory (development)
       -> GitHub Releases (initial end-to-end testing)
```

GitHub is the initial development scheduler and artifact store. It is not a
public-production market-data service or availability guarantee. A later
approved object store implements the same storage port without changing the
collector or artifact contract.

## Cadence and partitions

- One-minute is the canonical candle interval.
- Scheduled collection runs every fifteen minutes at minutes 7, 22, 37, and 52
  UTC. A delayed or dropped job resumes from the last published finalized
  cursor.
- Manual dispatch runs the same command immediately.
- Monthly Releases are storage partitions only. A month does not delay data or
  testing.
- Finalized day artifacts remain for 365 days. Older artifacts are removed by
  the retention owner.

## Commands

```sh
npm test
npm run collect -- --store directory --root .local-index
npm run repair -- --store directory --root .local-index
npm run verify -- --store directory --root .local-index
npm run retention -- --store directory --root .local-index
```

GitHub workflows select the GitHub Release adapter and provide the scoped
repository token. JSON-RPC request bodies contain public chain and contract
data only.

The committed public RPC endpoint is always the primary and is a rate-limited
development endpoint. Scheduled indexing may append two reviewed endpoints as
`INDEX_RPC_FALLBACK_URL_0` and `INDEX_RPC_FALLBACK_URL_1`. Each endpoint must
support `eth_chainId`, the `finalized` block tag, historical `eth_getLogs`, and
`eth_getBlockByNumber` in JSON-RPC batches at the configured header batch size.
Fallback positions must be contiguous and all endpoint URLs must be unique.
Changing the primary requires changing the committed registry; there is no
primary URL environment override.

Every fallback endpoint URL, with or without a credential, must be stored as an
individual GitHub Actions repository secret. Store the complete URL, including
the provider token when required; the workflow does not assemble a base URL and
token. Do not store fallback endpoints as repository variables, put multiple
URLs in one secret, commit them to the registry, pass them as CLI arguments, or
print them. GitHub log redaction is not a substitute for keeping credentials
out of output.

After a successful collection or repair in GitHub Actions, the CLI writes only
the selected configuration source name to the Actions log:
`registry.chain.primaryRpcUrl`, `INDEX_RPC_FALLBACK_URL_0`, or
`INDEX_RPC_FALLBACK_URL_1`. It never writes this line outside GitHub Actions and
never writes the endpoint URL. This operational line does not change the CLI
JSON result or any stored artifact.

If an endpoint denies access, lacks a required JSON-RPC method or protocol
version, or exhausts its bounded retries after a transport failure, HTTP 408,
HTTP 429, any HTTP 5xx response, JSON-RPC internal error, or a required resource
being missing, unavailable, or rate-limited, the collector discards that
unpublished attempt and restarts the complete collection or repair from durable
state with the next endpoint. An endpoint whose finalized state does not cover
the last durably stored block is unavailable for that attempt. The collector
never combines providers within an attempt. Chain identity, malformed response,
invalid request, numeric, and storage failures stop without fallback.

Provider fallback improves availability; it does not prove that a successful
`eth_getLogs` response is complete. The collector verifies chain ID 4663 and
the structure and source positions of every returned log, but the canonical
JSON-RPC response does not carry a completeness proof. Coverage therefore means
that the stated finalized block range was completely queried and admitted, not
that an independent provider or cryptographic proof confirmed every log.
Fallback is failure-driven: the collector does not query multiple endpoints to
select the freshest view or establish provider consensus. A valid endpoint that
covers the durably stored range remains authoritative for its attempt.

## Data meaning

Each candle contains exact rational OHLC values, exact raw Stock Token and USDG
volume, the admitted trade count, and source positions. Empty covered minutes
remain empty. The artifacts do not contain a quote, recommendation, executable
price, raw RPC response, account, wallet, or transaction history.
