export class StorageConfigError extends Error {}

/** Another pending or confirmed booking already starts at this time for this business. */
export class SlotTakenError extends Error {
  constructor(readonly startsAt: string) {
    super(`slot ${startsAt} is already taken`);
  }
}
