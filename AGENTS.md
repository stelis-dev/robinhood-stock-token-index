# AGENTS.md

Read this file before every task in this repository.

## Ownership

- `registry/groups.json` is the sole owner of chain identity, the committed
  primary RPC URL, deployment, PoolKey, pool, collection-limit, and group
  membership configuration. `cli.mjs` may append only the two ordered optional
  fallback URLs without replacing the primary or changing chain identity.
- `collector/` owns RPC admission, finalized coverage, Swap decoding, exact
  numeric values, one-minute candles, and canonical data artifacts.
- `storage/` owns artifact carriage only. A storage adapter cannot alter,
  reconstruct, summarize, or select market facts.
- `.github/workflows/` invokes the command-line owners. Workflow YAML does not
  duplicate collection, repair, publication, or retention logic.

## Boundaries

- Use one code path for all registry assets. Do not add ticker branches,
  alternate pools, aliases, inferred addresses, sampling, or interpolation.
- One collection or repair attempt uses one RPC endpoint. After bounded local
  retries exhaust a retryable availability failure, or the endpoint denies
  access or lacks a required RPC capability, discard the unpublished attempt
  and restart the complete operation from durable state with the next endpoint.
  Never combine providers within one attempt. Chain identity, malformed
  response, invalid request, numeric, and storage-integrity failures stop the
  operation without fallback.
- The workflow reads each optional fallback endpoint as one complete URL from
  its corresponding GitHub Actions repository secret. It does not read a
  repository variable or assemble a provider base URL and token.
- Fix one finalized end block before reading a range. Publish a cursor only
  after the complete replacement generation is admitted and stored.
- Store exact processed candles and coverage, not raw RPC responses or a
  general-purpose transaction index.
- Change a stored state or day `contractVersion` only when that artifact's
  persisted schema or meaning changes. When persisted schema and meaning stay
  unchanged, runtime, RPC, retry, fallback, registry, CLI, workflow, and other
  implementation changes do not change data versions or add an implementation
  compatibility discriminator.
- The workflow publishes only the current artifact contract. When persisted
  schema and meaning are unchanged, replace internal implementation directly;
  do not retain old readers, names, aliases, migrations, compatibility branches,
  or implementation markers. Existing artifacts affect current code only
  through their current admitted data contract.
- A missing candle is not a zero-price candle. USDG is not USD.
- GitHub Actions and Releases are development and test adapters, not the market
  source or a public-production availability claim.
- Keep the collector and canonical artifact independent of GitHub identifiers,
  URLs, tokens, workflow contexts, and release layout.
- Do not add a dependency without reviewing its exact version, closure,
  lifecycle scripts, security, license, distribution form, and replacement
  cost. Prefer the Node standard library when it completely expresses the
  boundary.

## Work

- Inspect repository state before editing and preserve unrelated changes.
- Solve defects at their owning boundary. Do not add case-specific patches or
  compatibility aliases.
- Tests target distinct invariants and counterexamples. Test count is not
  evidence.
- Network smoke tests remain manual. Automated tests use fixed independent
  fixtures and never contact a live endpoint.
- Run `npm test` and `npm run verify -- --store directory --root <path>` for
  affected local work. A GitHub publication claim additionally requires an
  actual manual workflow run and independent re-download verification.
