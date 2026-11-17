import * as db from "./db.js";

function initialise(): void {
  db.execute("CREATE TABLE IF NOT EXISTS browser_checkpoints (batch_id INTEGER PRIMARY KEY, job_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)");
}
export function saveCheckpoint(batchId: number, jobId: string, payload: unknown): void {
  initialise();
  db.execute("INSERT INTO browser_checkpoints(batch_id,job_id,payload) VALUES(?,?,?) ON CONFLICT(batch_id) DO UPDATE SET job_id=excluded.job_id,payload=excluded.payload", batchId, jobId, JSON.stringify(payload));
}
export function readCheckpoint(key: string | number): any {
  initialise();
  const row = db.row<{ payload: string }>(`SELECT payload FROM browser_checkpoints WHERE ${typeof key === "number" ? "batch_id" : "job_id"}=?`, key);
  return row ? JSON.parse(row.payload) : undefined;
}
