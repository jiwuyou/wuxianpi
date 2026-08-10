import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore } from "./task-store.mjs";

const PACKAGE_ID = "com.wuxianpi.builtin.tasks";
const TIMER_PACKAGE_ID = "com.wuxianpi.builtin.timer";
const AUTOMATION_PACKAGE_ID = "com.wuxianpi.builtin.automation";
const INDEX_PATH = ".wuxianpi/tasks/index.json";
const PURPOSES = new Set(["general", "planning", "execution", "report", "repair"]);
const TASK_STATUSES = new Set(["active", "paused", "completed", "archived"]);
const EXECUTION_GROUP = "com.wuxianpi.background/execution";

export default async function activate(context) {
  const store = new TaskStore(join(context.dataDir, "tasks.sqlite"));
  let timer;
  let automation;
  let acceptingScheduledActions = false;
  let activeScheduledActions = Promise.resolve();
  const ensureTask = (id) => { const task = store.getTask(String(id)); if (!task) throw new Error("task_not_found"); return task; };
  const ensureAction = (id) => { const action = store.getAction(String(id)); if (!action) throw new Error("task_action_not_found"); return action; };
  const api = async (request) => {
    const p = request.params ?? {};
    if (request.method === "list") return await listView();
    if (request.method === "get") return await taskView(ensureTask(p.taskId));
    if (request.method === "workspaces") return { workspaces: (await context.registry.listWorkspaces(false)).map((item) => workspaceView(item.workspace)) };
    if (request.method === "create") return await createTask(p, request);
    if (request.method === "attachConversation") return await attachConversation(String(p.taskId), String(p.conversationId), p.purpose, p.origin ?? "user");
    if (request.method === "conversations") return { conversations: store.listConversations(String(p.taskId)) };
    if (request.method === "actions") return { actions: store.listActions(String(p.taskId)) };
    if (request.method === "runs") return { runs: store.listRuns(String(p.taskId)) };
    if (request.method === "createScheduledConversation") return await createScheduledConversation(p, request);
    if (request.method === "runAction") return await executeAction(String(p.actionId), null);
    if (request.method === "setStatus") {
      const status = String(p.status);
      if (!TASK_STATUSES.has(status)) throw new Error("invalid_task_status");
      const task = store.setTaskStatus(String(p.taskId), status);
      await writeIndex(task.workspaceId);
      return taskView(task);
    }
    if (request.method === "memory.read") return readMemory(ensureTask(p.taskId));
    if (request.method === "memory.apply") return applyMemory(ensureTask(p.taskId), Number(p.expectedRevision), String(p.content ?? ""));
    throw new Error("unknown_task_method");
  };
  context.registerApi("task.v1", api);
  context.registerService("task.v1", { executeAction, list: () => listView() });
  const scheduledActionService = {
    execute: ({ payload, occurrence }) => {
      if (!acceptingScheduledActions) throw new Error("task_executor_standby");
      const result = activeScheduledActions.then(
        () => executeAction(String(payload.actionId), occurrence.occurrenceId),
        () => executeAction(String(payload.actionId), occurrence.occurrenceId),
      );
      activeScheduledActions = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  context.registerService("task.scheduled-action.v1", scheduledActionService, { singletonGroupId: EXECUTION_GROUP });
  context.registerService("task-action", scheduledActionService, { singletonGroupId: EXECUTION_GROUP });
  context.registerService("task.lifecycle", {
    async start() {
      timer = context.getService(TIMER_PACKAGE_ID, "timer.v1");
      automation = context.getService(AUTOMATION_PACKAGE_ID, "automation-control.v1");
    },
    async stop() { store.close(); },
  });
  context.registerSingleton({
    id: "executor",
    groupId: EXECUTION_GROUP,
    name: "Task Executor",
    start() { acceptingScheduledActions = true; },
    quiesce() { acceptingScheduledActions = false; },
    async stop() { await activeScheduledActions.catch(() => undefined); },
    status() { return { accepting: acceptingScheduledActions }; },
  });

  async function listView() { return { tasks: await Promise.all(store.listTasks().map(taskView)) }; }
  async function taskView(task) {
    const workspace = await context.registry.getWorkspace(task.workspaceId);
    const conversations = store.listConversations(task.id);
    const actions = store.listActions(task.id);
    const runs = store.listRuns(task.id);
    const timers = await Promise.all(actions.filter((action) => action.timerId && timer?.get).map((action) => timer.get(action.timerId)));
    return {
      ...task,
      workspaceName: workspace.workspace.name,
      workspaceRoot: workspace.workspace.rootCwd,
      conversations,
      actions,
      runs,
      nextRunAt: timers.filter(Boolean).map((item) => item.nextRunAt).filter(Boolean).sort()[0] ?? null,
    };
  }
  async function createTask(input, request) {
    const title = String(input.title ?? "").trim(); if (!title) throw new Error("task_title_required");
    const assistantId = String(input.assistantId ?? request.assistantId ?? "").trim();
    let workspaceId = input.workspaceId ? String(input.workspaceId) : null;
    if (!workspaceId) {
      const id = `task-${randomUUID()}`;
      const rootCwd = join(homedir(), ".wuxianpi", "workspaces", id);
      await mkdir(rootCwd, { recursive: true, mode: 0o700 });
      const workspace = await context.registry.createWorkspace({ id, name: String(input.workspaceName ?? title), rootCwd });
      workspaceId = workspace.workspace.id;
    }
    const workspace = await context.registry.getWorkspace(workspaceId);
    const task = store.createTask({ title, goal: String(input.goal ?? title), workspaceId });
    await writeMemory(task, defaultMemory(task));
    let conversationId = input.conversationId ? String(input.conversationId) : request.sessionId;
    if (!conversationId) {
      if (!assistantId) throw new Error("assistant_required");
      conversationId = (await context.registry.create({ assistantId, workspaceId, cwd: workspace.workspace.rootCwd })).sessionId;
    }
    await attachConversation(task.id, conversationId, input.purpose ?? "general", "user", {
      rebind: input.rebind === true,
      assistantId,
      confirmed: input.confirmed === true,
    });
    return taskView(ensureTask(task.id));
  }
  async function attachConversation(taskId, conversationId, purpose = "general", origin = "user", options = {}) {
    const task = ensureTask(taskId); if (!PURPOSES.has(purpose)) throw new Error("invalid_task_conversation_purpose");
    const scope = await context.registry.scope(conversationId);
    if (scope.workspaceId !== task.workspaceId) {
      if (!options.rebind) throw new Error("task_conversation_workspace_mismatch");
      const workspace = await context.registry.getWorkspace(task.workspaceId);
      const assistantId = options.assistantId ?? scope.assistantId;
      if (!assistantId) throw new Error("assistant_required");
      const changesExistingBoundary = scope.ownershipState === "bound" &&
        (scope.workspaceId !== task.workspaceId || scope.assistantId !== assistantId || scope.cwd !== workspace.workspace.rootCwd);
      if (changesExistingBoundary && options.confirmed !== true) throw new Error("task_rebind_confirmation_required");
      await context.registry.rebind(conversationId, {
        assistantId,
        workspaceId: task.workspaceId,
        cwd: workspace.workspace.rootCwd,
        expectedRevision: scope.bindingRevision,
        reason: "task_attach",
      });
    }
    const value = store.addConversation({ taskId, conversationId, purpose, origin });
    await writeIndex(task.workspaceId); return value;
  }
  async function createScheduledConversation(input, request) {
    if (!timer?.create) throw new Error("timer_package_unavailable");
    const task = ensureTask(input.taskId); const policy = normalizePolicy(input.policy, request, task);
    const action = store.createAction({ taskId: task.id, title: String(input.title ?? "定时对话"), kind: "scheduled_conversation", policy, message: String(input.message ?? "请继续处理当前任务。") });
    const scheduled = await timer.create({
      title: action.title,
      schedule: input.schedule,
      timezone: String(input.timezone ?? "UTC"),
      catchUp: input.catchUp === "once" ? "once" : "skip",
      handlerRef: { packageId: PACKAGE_ID, serviceId: "task.scheduled-action.v1", method: "execute" },
      consumerId: PACKAGE_ID,
      handlerId: "task-action",
      payload: { taskId: task.id, actionId: action.id },
    });
    store.setActionTimer(action.id, scheduled.id); return { action: store.getAction(action.id), timer: scheduled };
  }
  function normalizePolicy(value, request, task) {
    const raw = value ?? {}; const mode = raw.mode === "new" || raw.mode === "select" ? raw.mode : "reuse";
    const purpose = PURPOSES.has(raw.purpose) ? raw.purpose : "general";
    return { mode, purpose, conversationId: raw.conversationId ? String(raw.conversationId) : null, assistantId: String(raw.assistantId ?? request.assistantId ?? ""), workspaceId: task.workspaceId };
  }
  async function executeAction(actionId, occurrenceId) {
    const action = ensureAction(actionId); const task = ensureTask(action.taskId);
    const created = store.createRun({ taskId: task.id, actionId, timerOccurrenceId: occurrenceId });
    if (!created.created) return created.run;
    let run = store.startRun(created.run.id);
    if (!action.enabled || task.status !== "active") return store.finishRun(run.id, "cancelled", { error: "task_or_action_not_active" });
    if (action.kind === "program") return store.finishRun(run.id, "failed", { error: "program_runner_not_installed" });
    if (!automation?.ensureInternalGrant) return store.finishRun(run.id, "failed", { error: "automation_package_unavailable" });
    try {
      const target = await resolveTarget(task, action.policy);
      const grant = await automation.ensureInternalGrant({ id: `task.${action.id}`, title: action.title, applicantConversationId: target.applicantConversationId, reason: `Task action: ${action.title}`, projectRoot: (await context.registry.getWorkspace(task.workspaceId)).workspace.rootCwd, target: target.target, ownerPackageId: PACKAGE_ID });
      const turn = await automation.triggerInternalTurn({ registrationId: grant.id, runId: run.id, message: action.message ?? `请继续任务“${task.title}”。`, idempotencyKey: `${action.id}:${occurrenceId ?? run.id}` });
      run = store.startRun(run.id, turn.conversationId);
      if (turn.conversationId) await attachConversation(task.id, turn.conversationId, action.policy?.purpose ?? "general", "schedule");
      const result = await automation.awaitInternalTurn({ registrationId: grant.id, turnId: turn.turnId, waitMs: 30000 });
      return result.status === "succeeded" ? store.finishRun(run.id, "succeeded", { conversationId: result.conversationId, summary: result.assistantText ?? "" }) : store.finishRun(run.id, "failed", { conversationId: result.conversationId, error: result.errorMessage ?? result.status });
    } catch (error) { return store.finishRun(run.id, "failed", { error: error instanceof Error ? error.message : String(error) }); }
  }
  async function resolveTarget(task, policy) {
    const workspace = await context.registry.getWorkspace(task.workspaceId);
    let conversationId = policy?.conversationId;
    if (policy?.mode === "select" && !conversationId) conversationId = store.findConversation(task.id, policy.purpose)?.conversationId;
    if (policy?.mode !== "new" && conversationId) return { applicantConversationId: conversationId, target: { kind: "existing", conversationId } };
    if (policy?.mode === "new") {
      const assistantId = policy.assistantId; if (!assistantId) throw new Error("task_action_assistant_required");
      const fallback = store.findConversation(task.id, policy.purpose)?.conversationId;
      return { applicantConversationId: fallback ?? (await context.registry.create({ assistantId, workspaceId: task.workspaceId, cwd: workspace.workspace.rootCwd })).sessionId, target: { kind: "new", mode: "per-run", assistantId, workspaceId: task.workspaceId, cwd: workspace.workspace.rootCwd } };
    }
    const created = await context.registry.create({ assistantId: policy.assistantId, workspaceId: task.workspaceId, cwd: workspace.workspace.rootCwd });
    return { applicantConversationId: created.sessionId, target: { kind: "existing", conversationId: created.sessionId } };
  }
  async function readMemory(task) {
    const content = await readFile(await memoryPath(task), "utf8").catch(() => "");
    return { taskId: task.id, revision: task.memoryRevision, content };
  }
  async function applyMemory(task, expectedRevision, content) {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.memoryRevision) return { applied: false, conflict: true, current: await readMemory(task) };
    await writeMemory(task, content); return { applied: true, task: store.getTask(task.id), memory: await readMemory(store.getTask(task.id)) };
  }
  async function writeMemory(task, content) {
    const path = await memoryPath(task); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 }); await rename(temporary, path);
    store.db.prepare("UPDATE tasks SET memory_revision=memory_revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
    await writeIndex(task.workspaceId);
  }
  async function memoryPath(task) {
    const workspace = await context.registry.getWorkspace(task.workspaceId);
    return join(workspace.workspace.rootCwd, ".wuxianpi", "tasks", task.id, "MEMORY.md");
  }
  async function writeIndex(workspaceId) {
    const workspace = await context.registry.getWorkspace(workspaceId); const root = workspace.workspace.rootCwd;
    const tasks = store.listTasks().filter((task) => task.workspaceId === workspaceId).map((task) => ({ id:task.id,title:task.title,status:task.status,memoryRevision:task.memoryRevision,workspaceId:task.workspaceId }));
    const conversations = tasks.flatMap((task) => store.listConversations(task.id));
    const path = join(root, INDEX_PATH); await mkdir(dirname(path), { recursive:true, mode:0o700 });
    const temporary=`${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify({ schemaVersion:2,tasks,conversations },null,2)}\n`, {mode:0o600}); await rename(temporary,path);
  }
}

function defaultMemory(task) { return `# ${task.title}\n\n## Goal\n${task.goal}\n\n## Stable constraints\n-\n\n## Confirmed facts\n-\n\n## Decisions\n-\n\n## Next steps\n-\n`; }
function workspaceView(workspace) { return { id: String(workspace.id), name: String(workspace.name), rootCwd: String(workspace.rootCwd), archived: workspace.archived === true, createdAt: String(workspace.createdAt), updatedAt: String(workspace.updatedAt) }; }
