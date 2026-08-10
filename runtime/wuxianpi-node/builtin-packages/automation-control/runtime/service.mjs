const PACKAGE_ID = "com.wuxianpi.builtin.automation";
const INTERNAL_CALLERS = new Set(["com.wuxianpi.builtin.tasks"]);
const EXECUTION_GROUP = "com.wuxianpi.background/execution";

export default async function activate(context) {
  const api = async (request) => {
    const p = request.params ?? {};
    if (request.method === "list") return { automations: context.automation.listRegistrations() };
    if (request.method === "get") return context.automation.getRegistration(String(p.registrationId));
    if (request.method === "request") {
      return context.automation.requestRegistration({
        id: String(p.id), title: String(p.title), applicantConversationId: String(p.applicantConversationId),
        target: p.target, reason: String(p.reason), projectRoot: String(p.projectRoot), rateLimit: p.rateLimit,
        expiresAt: String(p.expiresAt), ownerPackageId: null,
      });
    }
    if (request.method === "approve") return context.automation.approveRegistration(String(p.registrationId));
    if (request.method === "pause") return context.automation.pauseRegistration(String(p.registrationId));
    if (request.method === "resume") return context.automation.resumeRegistration(String(p.registrationId));
    if (request.method === "revoke") return context.automation.revokeRegistration(String(p.registrationId));
    if (request.method === "update") return context.automation.updateRegistration(String(p.registrationId), p.input ?? {});
    throw new Error("unknown_automation_method");
  };
  const service = {
    async ensureInternalGrant(input) {
      if (!INTERNAL_CALLERS.has(input.ownerPackageId)) throw new Error("internal_automation_caller_not_allowed");
      return context.automation.issuePackageGrant({
        id: input.id, title: input.title, applicantConversationId: input.applicantConversationId,
        target: input.target, reason: input.reason, projectRoot: input.projectRoot,
        rateLimit: { maxCalls: 1000, windowSeconds: 86400 },
        expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(), ownerPackageId: PACKAGE_ID,
      });
    },
    async triggerInternalTurn(input) {
      return context.automation.triggerPackageTurn({ ownerPackageId: PACKAGE_ID, ...input });
    },
    async awaitInternalTurn(input) {
      return context.automation.getPackageTurn({ ownerPackageId: PACKAGE_ID, ...input });
    },
  };
  context.registerApi("automation-control.v1", api);
  context.registerService("automation-control.v1", service, { singletonGroupId: EXECUTION_GROUP });
  context.registerSingleton({
    id: "executor",
    groupId: EXECUTION_GROUP,
    name: "Automation Executor",
    recover() { context.automation.recoverInterruptedTurns(); },
    start() { context.automation.setExecutionEnabled(true); },
    async quiesce() { await context.automation.stopExecutions(); },
    status() { return { enabled: context.isSingletonOwner(EXECUTION_GROUP) }; },
  });
}
