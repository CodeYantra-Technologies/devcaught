import { defaultParsers, runParsers } from "../../../../packages/parsers/src/index.ts";
import type {
  NormalizedMessage,
  StoredMessage,
} from "../../../../packages/shared/src/types.ts";
import type { ScopedInboxStore, SmsInsertResult } from "../store/sqlite.ts";

/**
 * Optional inbox retention. Both knobs default to 0 = disabled, so an existing
 * inbox is never pruned unless the operator opts in via configuration.
 */
export interface RetentionConfig {
  retentionDays?: number;
  maxMessages?: number;
}

export class InboxService {
  private readonly store: ScopedInboxStore;
  private readonly retentionDays: number;
  private readonly maxMessages: number;

  constructor(store: ScopedInboxStore, retention: RetentionConfig = {}) {
    this.store = store;
    this.retentionDays = retention.retentionDays ?? 0;
    this.maxMessages = retention.maxMessages ?? 0;
  }

  ingest(message: NormalizedMessage): StoredMessage {
    const detections = runParsers(message, defaultParsers);
    const stored = this.store.insert({ ...message, detections });
    this.prune();
    return stored;
  }

  /**
   * Ingest an SMS event, deduplicating provider retries by `dedupeKey` (null =
   * never deduplicate, e.g. simulated events).
   */
  ingestSms(message: NormalizedMessage, dedupeKey: string | null): SmsInsertResult {
    const detections = runParsers(message, defaultParsers);
    const result = this.store.insertSms({ ...message, detections, dedupeKey });
    this.prune();
    return result;
  }

  /** Apply the configured retention knobs (no-op when both are disabled). */
  prune(now = Date.now()): void {
    this.store.pruneExpired(now, this.retentionDays);
    this.store.pruneOverMax(this.maxMessages);
  }
}
