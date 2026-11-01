import type { StorageAdapter } from "@framers/sql-storage-adapter/types";

/** The most events a restored session holds. */
export const MAX_EVENTS_PER_SESSION = 200;

export type SessionEventRow = Record<string, unknown>;

/**
 * Reads the stored events the workbench restores at start: the newest
 * `MAX_EVENTS_PER_SESSION` of each session, newest first, with the columns
 * `conversation_id`, `event_id`, `event_type`, `event_data` and `timestamp`.
 * The cap is per session, so a session behind many busier ones keeps its events.
 */
export async function loadRecentSessionEventRows(
  adapter: Pick<StorageAdapter, "all">
): Promise<SessionEventRow[]> {
  return (await adapter.all(
    `SELECT conversation_id, event_id, event_type, event_data, timestamp
     FROM (
       SELECT conversation_id, id AS event_id, event_type, event_data, timestamp,
         ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC, id DESC) AS event_rank
       FROM conversation_events
     )
     WHERE event_rank <= ?
     ORDER BY timestamp DESC, event_id DESC`,
    [MAX_EVENTS_PER_SESSION]
  )) as SessionEventRow[];
}
