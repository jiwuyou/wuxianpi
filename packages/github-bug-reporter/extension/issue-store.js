import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const emptyState = () => ({ schemaVersion: 1, reporterToken: null, drafts: {}, references: {} });

export class IssueStore {
  constructor(path = process.env.WUXIANPI_SUPPORT_STATE || join(homedir(), ".pi", "wuxianpi", "support", "issues.json")) {
    this.path = path;
    this.pending = Promise.resolve();
  }

  async reporterToken() {
    return await this.mutate((state) => {
      state.reporterToken ||= `wuxianpi_reporter_${randomBytes(32).toString("base64url")}`;
      return state.reporterToken;
    });
  }

  async createDraft(value) {
    return await this.mutate((state) => {
      const draftId = `draft_${randomUUID().replaceAll("-", "")}`;
      const draft = { draftId, ...value, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.drafts[draftId] = draft;
      return draft;
    });
  }

  async draft(draftId) {
    const state = await this.read();
    return state.drafts[draftId] || null;
  }

  async recordSubmission(draftId, submission) {
    return await this.mutate((state) => {
      const draft = state.drafts[draftId];
      if (!draft) throw new Error(`找不到 Issue 草稿：${draftId}`);
      const referenceId = `issue_ref_${randomUUID().replaceAll("-", "")}`;
      const reference = { referenceId, draftId, ...submission, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.references[referenceId] = reference;
      draft.status = "submitted";
      draft.referenceId = referenceId;
      draft.updatedAt = reference.updatedAt;
      return reference;
    });
  }

  async reference(referenceId) {
    const state = await this.read();
    return state.references[referenceId] || null;
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value?.schemaVersion !== 1 || !value.drafts || !value.references) throw new Error("unsupported state");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw new Error(`无法读取问题报告状态：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  mutate(operation) {
    const task = this.pending.then(async () => {
      const state = await this.read();
      const result = operation(state);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
}
