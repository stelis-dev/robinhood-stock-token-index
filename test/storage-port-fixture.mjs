export function storagePort(store, overrides = {}) {
  return {
    readSelectedState: (...args) => store.readSelectedState(...args),
    readReferenced: (...args) => store.readReferenced(...args),
    resolvePairMonth: (...args) => store.resolvePairMonth(...args),
    writeReferenced: (...args) => store.writeReferenced(...args),
    writeState: (...args) => store.writeState(...args),
    readPublication: (...args) => store.readPublication(...args),
    createPublication: (...args) => store.createPublication(...args),
    removePublication: (...args) => store.removePublication(...args),
    removePublicationStarter: (...args) => store.removePublicationStarter(...args),
    readState: (...args) => store.readState(...args),
    proveReferenced: (...args) => store.proveReferenced(...args),
    removeReferenced: (...args) => store.removeReferenced(...args),
    removeState: (...args) => store.removeState(...args),
    ...overrides,
  };
}
