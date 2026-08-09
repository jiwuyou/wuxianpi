import { TimerStore } from "./timer-store.mjs";
import { nextRunAt, validateSchedule, validateTimezone } from "./schedule-calculator.mjs";

const PACKAGE_ID = "com.wuxianpi.builtin.timer";

export default async function activate(context) {
  const store = new TimerStore(`${context.dataDir}/timers.sqlite`);
  const consumers = new Map();
  let timerHandle = null;
  const api = async (request) => {
    const p = request.params ?? {};
    if (request.method === "list") return { timers: store.list() };
    if (request.method === "get") return store.get(String(p.timerId));
    if (request.method === "occurrences") return { occurrences: store.listOccurrences(String(p.timerId)) };
    if (request.method === "create") {
      const schedule = validateSchedule(p.schedule);
      const timezone = validateTimezone(p.timezone ?? "UTC");
      const next = nextRunAt(schedule, Date.now() - 1000, timezone);
      return store.create({ id: p.id ? String(p.id) : undefined, title: String(p.title ?? "定时任务"), schedule, timezone, nextRunAt: next, catchUp: p.catchUp === "once" ? "once" : "skip", consumerId: String(p.consumerId), handlerId: String(p.handlerId), payload: p.payload ?? {} });
    }
    const timerId = String(p.timerId ?? "");
    if (request.method === "pause") return store.setStatus(timerId, "paused");
    if (request.method === "resume") {
      const timer = store.get(timerId);
      if (!timer) throw new Error("timer_not_found");
      return store.update(timerId, { status: "active", nextRunAt: timer.nextRunAt ?? nextRunAt(timer.schedule, Date.now(), timer.timezone) });
    }
    if (request.method === "cancel") return store.setStatus(timerId, "cancelled");
    if (request.method === "runNow") return runOccurrence(timerId, new Date().toISOString());
    if (request.method === "update") {
      const current = store.get(timerId);
      if (!current) throw new Error("timer_not_found");
      const schedule = p.schedule ? validateSchedule(p.schedule) : current.schedule;
      const timezone = p.timezone === undefined ? current.timezone : validateTimezone(p.timezone);
      return store.update(timerId, { ...(p.title === undefined ? {} : { title: String(p.title) }), schedule, ...(p.payload === undefined ? {} : { payload: p.payload }), timezone, nextRunAt: p.schedule || p.timezone !== undefined ? nextRunAt(schedule, Date.now() - 1000, timezone) : current.nextRunAt });
    }
    throw new Error("unknown_timer_method");
  };
  const service = {
    registerConsumer(input) { consumers.set(`${input.consumerId}:${input.handlerId}`, input.handler); },
    create: (input) => api({ method: "create", params: input }),
    get: (timerId) => api({ method: "get", params: { timerId } }),
    list: () => store.list(),
    runNow: (timerId) => runOccurrence(timerId, new Date().toISOString()),
  };
  context.registerService("timer.v1", service);
  context.registerApi("timer.v1", api);
  const runOccurrence = async (timerId, forcedScheduledAt = null) => {
    const timer = timerId ? store.get(timerId) : null;
    if (timerId && !timer) throw new Error("timer_not_found");
    const claimed = forcedScheduledAt ? store.claimManual(timer, forcedScheduledAt) : store.claimDue(new Date().toISOString(), (due) =>
      nextRunAt(due.schedule, Date.parse(due.nextRunAt), due.timezone));
    if (!claimed) return null;
    const claimedTimer = claimed.timer;
    const handler = consumers.get(`${claimedTimer.consumerId}:${claimedTimer.handlerId}`);
    if (!handler) { store.finishOccurrence(claimed.occurrence.occurrenceId, "failed", "timer_consumer_unavailable"); return claimed.occurrence; }
    try { await handler({ timer: claimedTimer, occurrence: claimed.occurrence, payload: claimedTimer.payload }); store.finishOccurrence(claimed.occurrence.occurrenceId, "succeeded"); }
    catch (error) { store.finishOccurrence(claimed.occurrence.occurrenceId, "failed", error instanceof Error ? error.message : String(error)); }
    return claimed.occurrence;
  };
  context.registerService("timer.lifecycle", {
    async recover() { store.recoverRunning(); },
    async start() { timerHandle = setInterval(() => void runDue(), 1000); timerHandle.unref?.(); },
    async stop() { if (timerHandle) clearInterval(timerHandle); store.close(); },
  });
  async function runDue() { let count = 0; while (count++ < 20) { const claimed = await runOccurrence(null); if (!claimed) break; } }
}
