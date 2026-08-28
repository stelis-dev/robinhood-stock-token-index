export class StoredDataIntegrityError extends Error {
  constructor() {
    super("Stored data failed integrity validation.");
    this.name = "StoredDataIntegrityError";
  }
}
