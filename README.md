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

GitHub workflows select the GitHub Release adapter and provide only the scoped
repository token. The RPC request contains public chain and contract data only.

## Data meaning

Each candle contains exact rational OHLC values, exact raw Stock Token and USDG
volume, the admitted trade count, and source positions. Empty covered minutes
remain empty. The artifacts do not contain a quote, recommendation, executable
price, raw RPC response, account, wallet, or transaction history.
