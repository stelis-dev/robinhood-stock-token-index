export function compareSwapPosition(left, right) {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }
  return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
}

export function createSwapPositionIdentities() {
  return {
    blockHashByNumber: new Map(),
    blockNumberByHash: new Map(),
    transactionHashByCoordinate: new Map(),
    transactionCoordinateByHash: new Map(),
  };
}

export function admitSwapPositionIdentity(value, identities, sourceLabel) {
  const knownBlockHash = identities.blockHashByNumber.get(value.blockNumber);
  const knownBlockNumber = identities.blockNumberByHash.get(value.blockHash);
  if (
    (knownBlockHash !== undefined && knownBlockHash !== value.blockHash)
    || (knownBlockNumber !== undefined && knownBlockNumber !== value.blockNumber)
  ) {
    throw new Error(`${sourceLabel} disagree on their block identity.`);
  }
  identities.blockHashByNumber.set(value.blockNumber, value.blockHash);
  identities.blockNumberByHash.set(value.blockHash, value.blockNumber);

  const transactionCoordinate = `${value.blockNumber}:${value.transactionIndex}`;
  const knownTransactionHash = identities.transactionHashByCoordinate.get(transactionCoordinate);
  const knownTransactionCoordinate = identities.transactionCoordinateByHash.get(value.transactionHash);
  if (
    (knownTransactionHash !== undefined && knownTransactionHash !== value.transactionHash)
    || (knownTransactionCoordinate !== undefined && knownTransactionCoordinate !== transactionCoordinate)
  ) {
    throw new Error(`${sourceLabel} disagree on their transaction identity.`);
  }
  identities.transactionHashByCoordinate.set(transactionCoordinate, value.transactionHash);
  identities.transactionCoordinateByHash.set(value.transactionHash, transactionCoordinate);
  return value;
}
