import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class TimerStore {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, schedule_json TEXT NOT NULL,
        timezone TEXT NOT NULL, next_run_at TEXT, status TEXT NOT NULL,
        catch_up TEXT NOT NULL, consumer_id TEXT NOT NULL, handler_id TEXT NOT NULL,
        handler_ref_json TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timer_occurrences (
        occurrence_id TEXT PRIMARY KEY, timer_id TEXT NOT NULL REFERENCES timers(id),
        scheduled_at TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
        error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        UNIQUE(timer_id, scheduled_at)
      );
      CREATE INDEX IF NOT EXISTS timer_due ON timers(status, next_run_at);
      CREATE INDEX IF NOT EXISTS timer_occurrence_timer ON timer_occurrences(timer_id, scheduled_at DESC);
    `);
    const columns = this.db.prepare("PRAGMA table_info(timers)").all().map((column) => String(column.name));
    if (!columns.includes("handler_ref_json")) this.db.exec("ALTER TABLE timers ADD COLUMN handler_ref_json TEXT");
  }

  close() { this.db.close(); }
  now() { return new Date().toISOString(); }

  create(input) {
    const id = input.id || `timer-${randomUUID()}`;
    const now = this.now();
    const handlerRef = normalizeHandlerRef(input);
    this.db.prepare(`INSERT INTO timers
      (id,title,schedule_json,timezone,next_run_at,status,catch_up,consumer_id,handler_id,handler_ref_json,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?)`).run(
      id, input.title, JSON.stringify(input.schedule), input.timezone, input.nextRunAt,
      input.catchUp, String(input.consumerId ?? handlerRef.packageId), String(input.handlerId ?? handlerRef.serviceId), JSON.stringify(handlerRef),
      JSON.stringify(input.payload ?? {}), now, now,
    );
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM timers WHERE id = ?").get(id);
    return row ? timerView(row) : null;
  }

  list() {
    return this.db.prepare("SELECT * FROM timers ORDER BY next_run_at IS NULL, next_run_at, created_at DESC").all().map(timerView);
  }

  update(id, input) {
    const current = this.get(id);
    if (!current) throw new Error("timer_not_found");
    const next = { ...current, ...input, updatedAt: this.now() };
    const handlerRef = input.handlerRef ? normalizeHandlerRef(input) : current.handlerRef;
    this.db.prepare(`UPDATE timers SET title=?,schedule_json=?,timezone=?,next_run_at=?,status=?,catch_up=?,consumer_id=?,handler_id=?,handler_ref_json=?,payload_json=?,updated_at=? WHERE id=?`).run(
      next.title, JSON.stringify(next.schedule), next.timezone, next.nextRunAt, next.status, next.catchUp,
      handlerRef.packageId, handlerRef.serviceId, JSON.stringify(handlerRef), JSON.stringify(next.payload), next.updatedAt, id,
    );
    return this.get(id);
  }

  setStatus(id, status) { return this.update(id, { status }); }

  claimDue(now, calculateNext, leaseSeconds = 300) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM timers WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 1").get(now);
      if (!row) { this.db.exec("COMMIT"); return null; }
      const timer = timerView(row);
      const scheduledAt = timer.nextRunAt;
      const occurrenceId = `${timer.id}:${scheduledAt}`;
      const existing = this.db.prepare("SELECT * FROM timer_occurrences WHERE occurrence_id=?").get(occurrenceId);
      if (existing) {
        this.db.prepare("UPDATE timers SET next_run_at = NULL, status = CASE WHEN schedule_json LIKE '%\"kind\":\"once\"%' THEN 'completed' ELSE status END, updated_at=? WHERE id=?").run(now, timer.id);
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(`INSERT INTO timer_occurrences
        (occurrence_id,timer_id,scheduled_at,status,attempts,error,created_at,started_at,finished_at)
        VALUES (?,?,?,'running',1,NULL,?,?,NULL)`).run(occurrenceId, timer.id, scheduledAt, now, now);
      const next = calculateNext(timer);
      this.db.prepare("UPDATE timers SET next_run_at=?, status=?, updated_at=? WHERE id=?").run(
        next, next === null ? "completed" : timer.status, now, timer.id,
      );
      this.db.exec("COMMIT");
      return { occurrence: { occurrenceId, timerId: timer.id, scheduledAt, status: "running", attempts: 1 }, timer, leaseUntil: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString() };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  claimManual(timer, scheduledAt) {
    const now = this.now();
    const occurrenceId = `${timer.id}:${scheduledAt}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM timer_occurrences WHERE occurrence_id=?").get(occurrenceId);
      if (existing) { this.db.exec("COMMIT"); return null; }
      this.db.prepare(`INSERT INTO timer_occurrences
        (occurrence_id,timer_id,scheduled_at,status,attempts,error,created_at,started_at,finished_at)
        VALUES (?,?,?,'running',1,NULL,?,?,NULL)`).run(occurrenceId, timer.id, scheduledAt, now, now);
      this.db.exec("COMMIT");
      return { occurrence: { occurrenceId, timerId: timer.id, scheduledAt, status: "running", attempts: 1 }, timer };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recoverRunning() {
    this.db.prepare("UPDATE timer_occurrences SET status='failed', error='runtime_interrupted', finished_at=? WHERE status='running'").run(this.now());
  }

  finishOccurrence(id, status, error = null) {
    const now = this.now();
    this.db.prepare("UPDATE timer_occurrences SET status=?, error=?, finished_at=? WHERE occurrence_id=? AND status='running'").run(status, error, now, id);
    const row = this.db.prepare("SELECT * FROM timer_occurrences WHERE occurrence_id=?").get(id);
    return row ? occurrenceView(row) : null;
  }

  listOccurrences(timerId) {
    return this.db.prepare("SELECT * FROM timer_occurrences WHERE timer_id=? ORDER BY scheduled_at DESC LIMIT 100").all(timerId).map(occurrenceView);
  }
}

function normalizeHandlerRef(input) {
  const value = input.handlerRef ?? {
    packageId: input.consumerId,
    serviceId: input.handlerId,
    method: "execute",
  };
  const packageId = String(value?.packageId ?? "").trim();
  const serviceId = String(value?.serviceId ?? "").trim();
  const method = String(value?.method ?? "execute").trim();
  if (!packageId || !serviceId || !method) throw new Error("invalid_timer_handler_ref");
  return { packageId, serviceId, method };
}

function timerView(row) {
  const handlerRef = row.handler_ref_json
    ? JSON.parse(String(row.handler_ref_json))
    : { packageId: String(row.consumer_id), serviceId: String(row.handler_id), method: "execute" };
  return {
    id: String(row.id), title: String(row.title), schedule: JSON.parse(String(row.schedule_json)), timezone: String(row.timezone),
    nextRunAt: row.next_run_at == null ? null : String(row.next_run_at), status: String(row.status), catchUp: String(row.catch_up),
    handlerRef, consumerId: handlerRef.packageId, handlerId: handlerRef.serviceId,
    payload: JSON.parse(String(row.payload_json)), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function occurrenceView(row) {
  return { occurrenceId: String(row.occurrence_id), timerId: String(row.timer_id), scheduledAt: String(row.scheduled_at), status: String(row.status), attempts: Number(row.attempts), error: row.error == null ? null : String(row.error), createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at) };
}
