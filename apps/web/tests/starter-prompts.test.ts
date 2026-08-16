import { describe, expect, it } from "vitest";
import { STARTER_PROMPTS, resolveStarterPrompt } from "../src/lib/starter-prompts";

const TITLES = [
  "帮我整理今天的任务",
  "帮我安装一个 AI 工具",
  "我想用 OpenHouse 实现一个想法",
  "帮我完成一个复杂任务",
];

describe("starter prompts", () => {
  it("uses the four product-focused default cards", () => {
    expect(STARTER_PROMPTS.map((item) => item.title)).toEqual(TITLES);
    expect(STARTER_PROMPTS.some((item) => item.title.includes("阅读并修改文件"))).toBe(false);
    expect(STARTER_PROMPTS.some((item) => item.title.includes("解释一个概念"))).toBe(false);
  });

  it("expands built-in Assistant titles into actionable prompts", () => {
    const aiTool = resolveStarterPrompt("帮我安装一个 AI 工具", true);
    expect(aiTool.description).toContain("市场和 GitHub");
    expect(aiTool.prompt).toContain("先询问");
    expect(aiTool.prompt).toContain("WuxianPi 市场");
    expect(aiTool.prompt).toContain("搜索 GitHub");
    expect(aiTool.prompt).toContain("等我确认");

    const openHouse = resolveStarterPrompt("我想用 OpenHouse 实现一个想法", true);
    expect(openHouse.prompt).toContain("想要什么功能");
    expect(openHouse.prompt).toContain("现有开源项目");
    expect(openHouse.prompt).toContain("OpenHouse 入口接入");
  });

  it("leaves custom Assistant prompts unchanged", () => {
    expect(resolveStarterPrompt("帮我安装一个 AI 工具", false)).toEqual({
      title: "帮我安装一个 AI 工具",
      description: "开始这个话题",
      prompt: "帮我安装一个 AI 工具",
    });
    expect(resolveStarterPrompt("自定义开场问题", true)).toEqual({
      title: "自定义开场问题",
      description: "开始这个话题",
      prompt: "自定义开场问题",
    });
  });
});
