# Dependencies

## `@noble/hashes` 2.3.0

The collector uses only `keccak_256` from `@noble/hashes/sha3.js` to derive
Ethereum Uniswap V4 pool IDs from the registry's ABI-encoded PoolKeys. Node's
standard library supplies NIST SHA-3 but not Ethereum Keccak, so substituting
`sha3-256` would produce false pool identities.

The exact npm artifact has registry integrity
`sha512-oN+QwyX7VSHotibwubG3kpzbwKrfnyR6OOO+3Nk/53ADL7FmgHHz4TgrbaYKvvOw09u6QTx0oiH1cNCIOuN0CQ==`
and unpacked size 680,759 bytes. Its sole current maintainer is the source
repository owner, and the npm artifact names the same official source
repository. The package is MIT licensed, has no runtime, optional, peer, or
platform dependency, and has no install or lifecycle script. The installed
license bytes have SHA-256
`4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec`.
It is used as an ordinary separately installed runtime dependency and is not
copied or bundled into generated index data.

The official 2.3.0 release is current and immutable. It improves SHA-3 speed,
type checks, and package size over 2.2.0 without changing the imported
`keccak_256(Uint8Array)` contract. The repository remains active. The official
GitHub advisory list and the npm production audit contain no published
advisory. Current open reports concern the separate `utf8ToBytes` handling of
malformed JavaScript strings and asynchronous KDF yielding. This project calls
`keccak_256` only with a validated, fixed-length `Buffer`, so neither path is
reachable.

A no-dependency implementation would require maintaining a security-sensitive
Keccak implementation. Node's `sha3-256` is not Ethereum Keccak and cannot be
substituted. A larger Ethereum SDK would add unrelated transports, ABI,
signing, and chain behavior. The single zero-dependency hash package is the
smallest complete current dependency set for this PoolId calculation.
