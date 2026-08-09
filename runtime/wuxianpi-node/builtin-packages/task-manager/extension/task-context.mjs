import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

const INDEX_PATH = join(".wuxianpi", "tasks", "index.json");
export default function taskContextExtension(pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    const located = await findTask(ctx.cwd, ctx.sessionManager.getSessionId());
    if (!located) return;
    const memoryPath = join(located.workspaceRoot, ".wuxianpi", "tasks", located.task.id, "MEMORY.md");
    return {
      systemPrompt: `${event.systemPrompt}\n\nCurrent WuxianPi task:\n` +
        `- Name: ${located.task.title}\n` +
        `- Status: ${located.task.status}\n` +
        `- Workspace: ${located.workspaceRoot}\n` +
        `- Task memory: ${memoryPath}\n\n` +
        "Read Task MEMORY.md only when it is relevant. Keep it concise; use it for stable goals, facts, decisions, and constraints, not for chat history or logs.",
    };
  });
}

async function findTask(cwd, conversationId) {
  let current = cwd;
  const root = parse(current).root;
  while (true) {
    try {
      const parsed = JSON.parse(await readFile(join(current, INDEX_PATH), "utf8"));
      const conversation = Array.isArray(parsed.conversations)
        ? parsed.conversations.find((candidate) => candidate && candidate.conversationId === conversationId && candidate.status === "active")
        : undefined;
      const task = conversation && Array.isArray(parsed.tasks)
        ? parsed.tasks.find((candidate) => candidate && candidate.id === conversation.taskId && candidate.status !== "archived")
        : undefined;
      if (task && typeof task.id === "string" && typeof task.title === "string") return { workspaceRoot: current, task };
    } catch {
      // A normal conversation usually has no task index.
    }
    if (current === root) return undefined;
    current = dirname(current);
  }
}
