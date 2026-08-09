import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class TaskStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
        workspace_id TEXT NOT NULL, memory_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_conversations (
        task_id TEXT NOT NULL REFERENCES tasks(id), conversation_id TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL,
        PRIMARY KEY(task_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS task_actions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, kind TEXT NOT NULL,
        timer_id TEXT, policy_json TEXT, message TEXT, program_ref TEXT, enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), action_id TEXT NOT NULL REFERENCES task_actions(id),
        timer_occurrence_id TEXT UNIQUE, conversation_id TEXT, status TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        summary TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_actions_task ON task_actions(task_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id, created_at DESC);
    `);
  }
  close() { this.db.close(); }
  now() { return new Date().toISOString(); }

  createTask(input) {
    const id = input.id ?? `task-${randomUUID()}`;
    const now = this.now();
    this.db.prepare("INSERT INTO tasks(id,title,goal,status,workspace_id,memory_revision,created_at,updated_at) VALUES(?,?,?,'active',?,0,?,?)")
      .run(id, input.title, input.goal, input.workspaceId, now, now);
    return this.getTask(id);
  }
  getTask(id) { const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id); return row ? taskView(row) : null; }
  listTasks() { return this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all().map(taskView); }
  setTaskStatus(id, status) { this.db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=?").run(status, this.now(), id); return this.getTask(id); }
  touchTask(id) { this.db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(this.now(), id); }

  addConversation(input) {
    const now = this.now();
    const prior = this.db.prepare("SELECT task_id,status FROM task_conversations WHERE conversation_id=?").get(input.conversationId);
    if (prior && prior.task_id !== input.taskId && prior.status === "active") throw new Error("conversation_already_assigned");
    this.db.prepare(`INSERT INTO task_conversations(task_id,conversation_id,purpose,origin,status,created_at,last_used_at)
      VALUES(?,?,?,?, 'active',?,?) ON CONFLICT(conversation_id) DO UPDATE SET task_id=excluded.task_id,purpose=excluded.purpose,origin=excluded.origin,status='active',last_used_at=excluded.last_used_at`)
      .run(input.taskId, input.conversationId, input.purpose, input.origin, now, now);
    this.touchTask(input.taskId);
    return this.listConversations(input.taskId).find((item) => item.conversationId === input.conversationId);
  }
  listConversations(taskId) { return this.db.prepare("SELECT * FROM task_conversations WHERE task_id=? ORDER BY last_used_at DESC").all(taskId).map(conversationView); }
  findConversation(taskId, purpose) {
    const row = this.db.prepare("SELECT * FROM task_conversations WHERE task_id=? AND purpose=? AND status='active' ORDER BY last_used_at DESC LIMIT 1").get(taskId, purpose);
    return row ? conversationView(row) : null;
  }
  touchConversation(conversationId) { this.db.prepare("UPDATE task_conversations SET last_used_at=? WHERE conversation_id=?").run(this.now(), conversationId); }

  createAction(input) {
    const id = input.id ?? `action-${randomUUID()}`;
    const now = this.now();
    this.db.prepare(`INSERT INTO task_actions(id,task_id,title,kind,timer_id,policy_json,message,program_ref,enabled,created_at,updated_at)
      VALUES(?,?,?,?,NULL,?,?,?,?,?,?)`).run(id, input.taskId, input.title, input.kind, input.policy ? JSON.stringify(input.policy) : null,
      input.message ?? null, input.programRef ?? null, input.enabled === false ? 0 : 1, now, now);
    this.touchTask(input.taskId);
    return this.getAction(id);
  }
  getAction(id) { const row = this.db.prepare("SELECT * FROM task_actions WHERE id=?").get(id); return row ? actionView(row) : null; }
  listActions(taskId) { return this.db.prepare("SELECT * FROM task_actions WHERE task_id=? ORDER BY updated_at DESC").all(taskId).map(actionView); }
  setActionTimer(id, timerId) { this.db.prepare("UPDATE task_actions SET timer_id=?,updated_at=? WHERE id=?").run(timerId, this.now(), id); return this.getAction(id); }
  setActionEnabled(id, enabled) { this.db.prepare("UPDATE task_actions SET enabled=?,updated_at=? WHERE id=?").run(enabled ? 1 : 0, this.now(), id); return this.getAction(id); }

  createRun(input) {
    const existing = input.timerOccurrenceId ? this.db.prepare("SELECT * FROM task_runs WHERE timer_occurrence_id=?").get(input.timerOccurrenceId) : null;
    if (existing) return { run: runView(existing), created: false };
    const id = input.id ?? `run-${randomUUID()}`;
    const now = this.now();
    this.db.prepare(`INSERT INTO task_runs(id,task_id,action_id,timer_occurrence_id,conversation_id,status,started_at,finished_at,summary,error,created_at,updated_at)
      VALUES(?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,?,?)`).run(id, input.taskId, input.actionId, input.timerOccurrenceId ?? null, input.conversationId ?? null, now, now);
    return { run: this.getRun(id), created: true };
  }
  getRun(id) { const row = this.db.prepare("SELECT * FROM task_runs WHERE id=?").get(id); return row ? runView(row) : null; }
  listRuns(taskId) { return this.db.prepare("SELECT * FROM task_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 100").all(taskId).map(runView); }
  startRun(id, conversationId = null) { this.db.prepare("UPDATE task_runs SET status='running',conversation_id=COALESCE(?,conversation_id),started_at=?,updated_at=? WHERE id=? AND status='queued'").run(conversationId, this.now(), this.now(), id); return this.getRun(id); }
  finishRun(id, status, values = {}) { this.db.prepare("UPDATE task_runs SET status=?,conversation_id=COALESCE(?,conversation_id),summary=?,error=?,finished_at=?,updated_at=? WHERE id=?").run(status, values.conversationId ?? null, values.summary ?? null, values.error ?? null, this.now(), this.now(), id); const run=this.getRun(id); if(run) this.touchTask(run.taskId); return run; }
}

function taskView(row) { return { id:String(row.id),title:String(row.title),goal:String(row.goal),status:String(row.status),workspaceId:String(row.workspace_id),memoryRevision:Number(row.memory_revision),createdAt:String(row.created_at),updatedAt:String(row.updated_at) }; }
function conversationView(row) { return { taskId:String(row.task_id),conversationId:String(row.conversation_id),purpose:String(row.purpose),origin:String(row.origin),status:String(row.status),createdAt:String(row.created_at),lastUsedAt:String(row.last_used_at) }; }
function actionView(row) { return { id:String(row.id),taskId:String(row.task_id),title:String(row.title),kind:String(row.kind),timerId:row.timer_id==null?null:String(row.timer_id),policy:row.policy_json==null?null:JSON.parse(String(row.policy_json)),message:row.message==null?null:String(row.message),programRef:row.program_ref==null?null:String(row.program_ref),enabled:Number(row.enabled)===1,createdAt:String(row.created_at),updatedAt:String(row.updated_at) }; }
function runView(row) { return { id:String(row.id),taskId:String(row.task_id),actionId:String(row.action_id),timerOccurrenceId:row.timer_occurrence_id==null?null:String(row.timer_occurrence_id),conversationId:row.conversation_id==null?null:String(row.conversation_id),status:String(row.status),startedAt:row.started_at==null?null:String(row.started_at),finishedAt:row.finished_at==null?null:String(row.finished_at),summary:row.summary==null?null:String(row.summary),error:row.error==null?null:String(row.error),createdAt:String(row.created_at),updatedAt:String(row.updated_at) }; }
