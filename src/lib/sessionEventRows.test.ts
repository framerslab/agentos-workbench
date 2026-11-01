import test from "node:test";
import assert from "node:assert/strict";
import { SqlJsAdapter } from "@framers/sql-storage-adapter/sqljs";
import { loadRecentSessionEventRows, MAX_EVENTS_PER_SESSION } from "./sessionEventRows";

// The columns of conversation_events as agentosStorage.ts creates the table.
const EVENTS_TABLE = `CREATE TABLE conversation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);`;

async function databaseWith(eventsBySession: Array<[string, number]>): Promise<SqlJsAdapter> {
  const adapter = new SqlJsAdapter();
  await adapter.open();
  await adapter.exec(EVENTS_TABLE);
  let timestamp = 0;
  for (const [sessionId, count] of eventsBySession) {
    await adapter.run(
      `INSERT INTO conversation_events (conversation_id, event_type, event_data, timestamp)
       WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
       SELECT ?, 'log', '{}', ? + i FROM n`,
      [count, sessionId, timestamp]
    );
    timestamp += count;
  }
  return adapter;
}

function countBySession(rows: Array<Record<string, unknown>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = String(row.conversation_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

test("loadRecentSessionEventRows restores the oldest session when many newer sessions are full", async () => {
  // 21 sessions of 200 events: 4,200 rows, and session-0 holds the oldest 200.
  const sessions = Array.from({ length: 21 }, (_, index): [string, number] => [`session-${index}`, MAX_EVENTS_PER_SESSION]);
  const adapter = await databaseWith(sessions);
  try {
    const counts = countBySession(await loadRecentSessionEventRows(adapter));

    assert.equal(counts.size, 21);
    assert.equal(counts.get("session-0"), MAX_EVENTS_PER_SESSION);
    for (const [sessionId] of sessions) {
      assert.equal(counts.get(sessionId), MAX_EVENTS_PER_SESSION, sessionId);
    }
  } finally {
    await adapter.close();
  }
});

test("loadRecentSessionEventRows keeps the newest events of a session over the cap, newest first", async () => {
  const adapter = await databaseWith([
    ["busy", MAX_EVENTS_PER_SESSION + 50],
    ["quiet", 3]
  ]);
  try {
    const rows = await loadRecentSessionEventRows(adapter);
    const busy = rows.filter((row) => row.conversation_id === "busy").map((row) => Number(row.timestamp));

    assert.equal(busy.length, MAX_EVENTS_PER_SESSION);
    assert.equal(busy[0], MAX_EVENTS_PER_SESSION + 49);
    assert.equal(busy[busy.length - 1], 50);
    assert.equal(countBySession(rows).get("quiet"), 3);
    const timestamps = rows.map((row) => Number(row.timestamp));
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
  } finally {
    await adapter.close();
  }
});
