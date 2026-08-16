export type StarterPrompt = {
  title: string;
  description: string;
  prompt: string;
};

/** Product defaults used when an Assistant does not provide its own starter prompts. */
export const STARTER_PROMPTS = [
  {
    title: "帮我整理今天的任务",
    description: "把零散想法变成清晰、可执行的计划",
    prompt: "请帮我整理今天的任务。先询问必要背景，再给出按优先级排列的可执行清单。",
  },
  {
    title: "帮我安装一个 AI 工具",
    description: "从市场和 GitHub 找到合适工具并安装到手机",
    prompt: "我想在手机上安装一个 AI 工具。请先询问我想解决的问题、主要使用场景和必要限制，然后优先检查 WuxianPi 市场，并搜索 GitHub 上合适的现有项目。对比候选项目的功能、维护状态、许可证、技术栈、资源需求和手机运行可行性，等我确认后，再帮助我完成安装、运行、服务管理和 OpenHouse 入口接入。",
  },
  {
    title: "我想用 OpenHouse 实现一个想法",
    description: "从需求出发，找到现有项目并运行在手机上",
    prompt: "我想用 OpenHouse 在手机上实现一个想法。请先询问我想要什么功能、主要使用场景和必要限制，然后优先检查 WuxianPi 市场，并搜索 GitHub 上合适的现有开源项目。对比候选项目的功能、维护状态、许可证、技术栈、资源需求和手机运行可行性，等我确认项目后，再帮助我完成安装、运行、服务管理和 OpenHouse 入口接入。",
  },
  {
    title: "帮我完成一个复杂任务",
    description: "规划、执行和检查，直到任务真正完成",
    prompt: "我有一个复杂任务需要你完成。请先确认目标和约束，给出简短计划，然后持续执行和验证，直到任务完成或确实需要我的输入。",
  },
] satisfies readonly StarterPrompt[];

const STARTER_PROMPT_BY_TITLE = new Map(STARTER_PROMPTS.map((item) => [item.title, item]));

export function resolveStarterPrompt(prompt: string, useProductDefaults: boolean): StarterPrompt {
  const productPrompt = useProductDefaults ? STARTER_PROMPT_BY_TITLE.get(prompt) : undefined;
  return productPrompt ?? { title: prompt, description: "开始这个话题", prompt };
}
