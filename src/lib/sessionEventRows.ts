import type { StorageAdapter } from "@framers/sql-storage-adapter/types";

/** The most events a restored session holds. */
export const MAX_EVENTS_PER_SESSION = 200;

export type SessionEventRow = Record<string, unknown>;

/**
 * Reads the stored events the workbench restores at start, newest first: the
 * columns `conversation_id`, `event_id`, `event_type`, `event_data` and `timestamp`.
 */
export async function loadRecentSessionEventRows(
  adapter: Pick<StorageAdapter, "all">
): Promise<SessionEventRow[]> {
  return (await adapter.all(
    `SELECT conversation_id, id as event_id, event_type, event_data, timestamp
     FROM conversation_events
     ORDER BY timestamp DESC
     LIMIT 4000`
  )) as SessionEventRow[];
}
