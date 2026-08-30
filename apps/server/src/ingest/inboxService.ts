import { defaultParsers, runParsers } from "../../../../packages/parsers/src/index.ts";
import type { NormalizedMessage, StoredMessage } from "../../../../packages/shared/src/types.ts";
import type { InboxStore } from "../store/sqlite.ts";

export class InboxService {
  private readonly store: InboxStore;

  constructor(store: InboxStore) {
    this.store = store;
  }

  ingest(message: NormalizedMessage): StoredMessage {
    const detections = runParsers(message, defaultParsers);
    return this.store.insert({ ...message, detections });
  }
}
