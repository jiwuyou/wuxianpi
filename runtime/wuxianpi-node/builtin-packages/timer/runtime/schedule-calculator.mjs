import rrulePackage from "./vendor/rrule.cjs";

const { rrulestr } = rrulePackage;

export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") throw new Error("invalid_schedule");
  if (schedule.kind === "once") {
    const time = Date.parse(String(schedule.runAt));
    if (!Number.isFinite(time)) throw new Error("invalid_schedule");
    return { kind: "once", runAt: new Date(time).toISOString() };
  }
  if (schedule.kind === "interval") {
    const seconds = Number(schedule.seconds);
    if (!Number.isInteger(seconds) || seconds < 1) throw new Error("invalid_schedule");
    return { kind: "interval", seconds };
  }
  if (schedule.kind === "rrule") {
    const value = String(schedule.value ?? "").trim();
    if (!value.startsWith("FREQ=")) throw new Error("invalid_schedule");
    try { rrulestr(value, { dtstart: new Date(), tzid: "UTC", cache: false }); }
    catch { throw new Error("invalid_schedule"); }
    return { kind: "rrule", value };
  }
  throw new Error("invalid_schedule");
}

export function validateTimezone(timezone) {
  const value = String(timezone ?? "UTC").trim() || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); }
  catch { throw new Error("invalid_timezone"); }
  return value;
}

export function nextRunAt(schedule, after = Date.now(), timezone = "UTC") {
  if (schedule.kind === "once") return Date.parse(schedule.runAt) > after ? new Date(Date.parse(schedule.runAt)).toISOString() : null;
  if (schedule.kind === "interval") return new Date(after + schedule.seconds * 1000).toISOString();
  const rule = rrulestr(String(schedule.value), {
    dtstart: new Date(after),
    tzid: validateTimezone(timezone),
    cache: false,
  });
  const next = rule.after(new Date(after), false);
  return next ? next.toISOString() : null;
}
