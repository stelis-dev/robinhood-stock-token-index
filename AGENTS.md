# AGENTS.md

Read this file before every task in this repository.

## Ownership

- `registry/pairs.json` is the sole owner of chain identity, the committed
  primary RPC URL, deployment, collection limits, exact pair descriptors,
  PoolKeys, base/quote orientation, source initialization, history start, and
  activation boundaries. `cli.mjs` may append only the two ordered optional
  fallback URLs without replacing the primary or changing chain identity.
- `collector/` owns RPC admission, finalized coverage, exact Swap decoding,
  numeric meaning, one-minute candles, pair lifecycle, canonical artifacts, and
  verified period reads.
- `storage/` owns raw artifact carriage and physical location only. A storage
  adapter cannot decode, reconstruct, summarize, merge, or select market facts.
- `.github/workflows/` invokes one-pair command-line owners. Workflow YAML does
  not duplicate collection, history, repair, publication, or read logic.

## Boundaries

- Use one code path for every admitted pair. Do not add ticker branches,
  alternate pools, aliases, inferred addresses, route pricing, sampling, or
  interpolation.
- One current, historical, or repair attempt uses one RPC endpoint and one fixed
  block range. After bounded local retries exhaust a retryable availability
  failure, or the endpoint denies access or lacks a required RPC capability,
  discard the unpublished attempt and restart the complete operation from
  durable state with the next endpoint. Never combine providers within one
  attempt. Chain identity, activation identity, malformed response, invalid
  request, numeric, abort, and storage-integrity failures stop without fallback.
- The workflow reads each optional fallback endpoint as one complete URL from
  its corresponding GitHub Actions repository secret. It does not read a
  repository variable or assemble a provider base URL and token.
- Current collection advances only the forward edge, historical collection
  decreases only the history edge to the fixed `historyStart`, and repair moves
  neither edge. Complete every RPC read before the first storage write.
- Publish immutable pair-day and pair-month children before the new pair-state
  generation. Re-download and admit every changed child, then re-read the exact
  selected state. Unchanged month references come only from the
  previously admitted state.
- No selected state carrier is the sole no-data representation. Every persisted
  state is non-empty, every state generation owns at least one direct month
  reference from that generation, and every month generation owns at least one
  direct day reference from that generation.
- Pair state owns ordered month references directly. Year grouping is derived
  from canonical `YYYY-MM` month identities and is not an artifact, logical
  parent, path, Release, reader, or compatibility name.
- Routine publication reads and rebuilds the selected state, whose
  month-reference metadata grows by one bounded reference per produced month.
  It reads or lists child carriers only for changed month scopes. Explicit full
  verification streams month and day artifacts in order without accumulating
  complete candle history.
- Cleanup is derived only from the exact selected state and its changed month
  manifests. It proves every retained carrier before mutation and removes
  superseded generations only for explicitly named logical identities. Omission
  is never deletion authority.
- Store exact processed candles and continuous coverage, not raw RPC responses,
  synthetic candles, a general-purpose transaction index, provider choice, or
  storage locator.
- Change a stored state, month, or day `contractVersion` only when that
  artifact's persisted schema or meaning changes. When persisted schema and
  meaning stay unchanged, runtime, RPC, retry, fallback, registry, CLI,
  workflow, and storage implementation changes do not change data versions or
  add an implementation compatibility discriminator.
- Publish and read only the current artifact contract. Replace internal
  implementation directly; do not retain old readers, names, aliases,
  migrations, compatibility branches, or implementation markers.
- A missing candle is not a zero-price candle. USDG is not USD. Native ETH is
  not WETH.
- GitHub Actions and Releases are development and test adapters, not the market
  source or a public-production availability claim.
- Keep collector and canonical artifacts independent of GitHub identifiers,
  URLs, tokens, workflow contexts, and Release layout.
- Do not add a dependency without reviewing its exact version, closure,
  lifecycle scripts, security, license, distribution form, and replacement
  cost. Prefer the Node standard library when it completely expresses the
  boundary.

## Work

- Inspect repository state before editing and preserve unrelated changes.
- Work records contain only current status, exact verification evidence,
  unresolved debt, and the outputs and limits required by the next work. Do not
  keep diaries, timelines, abandoned alternatives, or token/context accounting.
- Solve defects at their owning boundary. Do not add case-specific patches or
  compatibility aliases.
- Tests target distinct invariants and counterexamples. Test count is not
  evidence; inspect what each test actually proves.
- Network smoke tests remain manual. Automated tests use fixed independent
  fixtures and never contact a live endpoint.
- Run `npm test` and construct a complete offline state/month/day pair closure
  before running the pair-scoped directory `verify` command and a bounded
  `read` against the same root. An empty-store verify is not completion
  evidence.
- A GitHub publication claim additionally requires an actual manual workflow
  run and independent anonymous re-download verification.
