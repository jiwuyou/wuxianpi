import { TimerStore } from "./timer-store.mjs";
import { nextRunAt, validateSchedule, validateTimezone } from "./schedule-calculator.mjs";

const EXECUTION_GROUP = "com.wuxianpi.background/execution";

export default async function activate(context) {
  const store = new TimerStore(`${context.dataDir}/timers.sqlite`);
  let timerHandle = null;
  let accepting = false;
  let active = Promise.resolve();

  const api = async (request) => {
    const p = request.params ?? {};
    if (request.method === "list") return { timers: store.list() };
    if (request.method === "get") return store.get(String(p.timerId));
    if (request.method === "occurrences") return { occurrences: store.listOccurrences(String(p.timerId)) };
    if (request.method === "create") {
      const schedule = validateSchedule(p.schedule);
      const timezone = validateTimezone(p.timezone ?? "UTC");
      const next = nextRunAt(schedule, Date.now() - 1000, timezone);
      return store.create({
        id: p.id ? String(p.id) : undefined,
        title: String(p.title ?? "定时任务"), schedule, timezone, nextRunAt: next,
        catchUp: p.catchUp === "once" ? "once" : "skip",
        handlerRef: p.handlerRef,
        consumerId: p.consumerId,
        handlerId: p.handlerId,
        payload: p.payload ?? {},
      });
    }
    const timerId = String(p.timerId ?? "");
    if (request.method === "pause") return store.setStatus(timerId, "paused");
    if (request.method === "resume") {
      const timer = store.get(timerId);
      if (!timer) throw new Error("timer_not_found");
      return store.update(timerId, { status: "active", nextRunAt: timer.nextRunAt ?? nextRunAt(timer.schedule, Date.now(), timer.timezone) });
    }
    if (request.method === "cancel") return store.setStatus(timerId, "cancelled");
    if (request.method === "runNow") {
      requireOwner();
      return enqueue(() => runOccurrence(timerId, new Date().toISOString()));
    }
    if (request.method === "update") {
      const current = store.get(timerId);
      if (!current) throw new Error("timer_not_found");
      const schedule = p.schedule ? validateSchedule(p.schedule) : current.schedule;
      const timezone = p.timezone === undefined ? current.timezone : validateTimezone(p.timezone);
      return store.update(timerId, {
        ...(p.title === undefined ? {} : { title: String(p.title) }), schedule,
        ...(p.payload === undefined ? {} : { payload: p.payload }),
        ...(p.handlerRef === undefined ? {} : { handlerRef: p.handlerRef }),
        timezone,
        nextRunAt: p.schedule || p.timezone !== undefined ? nextRunAt(schedule, Date.now() - 1000, timezone) : current.nextRunAt,
      });
    }
    throw new Error("unknown_timer_method");
  };

  context.registerService("timer.v1", {
    create: (input) => api({ method: "create", params: input }),
    get: (timerId) => api({ method: "get", params: { timerId } }),
    list: () => store.list(),
    runNow: (timerId) => api({ method: "runNow", params: { timerId } }),
  });
  context.registerApi("timer.v1", api);
  context.registerService("timer.store-lifecycle", { stop() { store.close(); } });

  context.registerSingleton({
    id: "scheduler",
    groupId: EXECUTION_GROUP,
    name: "Timer Scheduler",
    recover() { store.recoverRunning(); },
    start() {
      accepting = true;
      timerHandle = setInterval(() => { if (accepting) void enqueue(runDue); }, 1000);
      timerHandle.unref?.();
    },
    quiesce() {
      accepting = false;
      if (timerHandle) clearInterval(timerHandle);
      timerHandle = null;
    },
    async stop() { await active.catch(() => undefined); },
    status() { return { accepting, scannerActive: timerHandle !== null }; },
  });

  function requireOwner() {
    if (!context.isSingletonOwner(EXECUTION_GROUP)) {
      const error = new Error("Timer execution is owned by another Runtime");
      error.code = "timer_scheduler_standby";
      throw error;
    }
  }

  function enqueue(operation) {
    const result = active.then(operation, operation);
    active = result.then(() => undefined, () => undefined);
    return result;
  }

  async function runOccurrence(timerId, forcedScheduledAt = null) {
    requireOwner();
    const timer = timerId ? store.get(timerId) : null;
    if (timerId && !timer) throw new Error("timer_not_found");
    const claimed = forcedScheduledAt ? store.claimManual(timer, forcedScheduledAt) : store.claimDue(new Date().toISOString(), (due) =>
      nextRunAt(due.schedule, Date.parse(due.nextRunAt), due.timezone));
    if (!claimed) return null;
    try {
      await context.invokeService(claimed.timer.handlerRef, {
        timer: claimed.timer,
        occurrence: claimed.occurrence,
        payload: claimed.timer.payload,
      });
      store.finishOccurrence(claimed.occurrence.occurrenceId, "succeeded");
    } catch (error) {
      store.finishOccurrence(claimed.occurrence.occurrenceId, "failed", error instanceof Error ? error.message : String(error));
    }
    return claimed.occurrence;
  }

  async function runDue() {
    let count = 0;
    while (accepting && count++ < 20) {
      const claimed = await runOccurrence(null);
      if (!claimed) break;
    }
  }
}
