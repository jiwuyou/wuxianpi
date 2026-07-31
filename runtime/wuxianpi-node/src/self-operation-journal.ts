import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomicJson } from "./package-storage.js";

export interface SelfOperationRecord {
  id: string;
  actor: string;
  intent: string;
  targets: string[];
  before: Record<string, unknown>;
  plannedActions: string[];
  commandAndLogs: string[];
  recoveryHint: string;
  status: "pending" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export class SelfOperationJournal {
  readonly pendingPath: string;
  readonly historyPath: string;

  constructor(root: string) {
    this.pendingPath = join(root, "pending-self-operation.json");
    this.historyPath = join(root, "self-operations.jsonl");
  }

  async begin(record: SelfOperationRecord): Promise<void> {
    await writeAtomicJson(this.pendingPath, record);
    await this.append(record);
  }

  async complete(record: SelfOperationRecord): Promise<void> {
    const completed = { ...record, status: "completed" as const, completedAt: new Date().toISOString() };
    await this.append(completed);
    await rm(this.pendingPath, { force: true });
  }

  async fail(record: SelfOperationRecord, error: unknown): Promise<void> {
    const failed = {
      ...record,
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    };
    await writeAtomicJson(this.pendingPath, failed);
    await this.append(failed);
  }

  async pending(): Promise<SelfOperationRecord | undefined> {
    try { return JSON.parse(await readFile(this.pendingPath, "utf8")) as SelfOperationRecord; }
    catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async append(record: SelfOperationRecord): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true, mode: 0o700 });
    await appendFile(this.historyPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
