import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteSingletonGuard {
  private database: DatabaseSync | undefined;

  constructor(readonly path: string) {}

  acquire(): boolean {
    if (this.database) return true;
    initializeGuard(this.path);
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA busy_timeout = 0");
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE singleton_guard SET id = id WHERE id = 1").run();
      this.database = database;
      return true;
    } catch (error) {
      database.close();
      if (isBusy(error)) return false;
      throw error;
    }
  }

  release(): void {
    const database = this.database;
    this.database = undefined;
    if (!database) return;
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }

  get acquired(): boolean { return this.database !== undefined; }
}

function initializeGuard(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS singleton_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1)
      );
      INSERT OR IGNORE INTO singleton_guard(id) VALUES(1);
    `);
  } finally {
    database.close();
  }
}

function isBusy(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ((error as { code?: unknown }).code === "SQLITE_BUSY" || String((error as { message?: unknown }).message ?? "").includes("database is locked"));
}
