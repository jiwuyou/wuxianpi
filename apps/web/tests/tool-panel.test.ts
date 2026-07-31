import { describe, expect, it } from "vitest";
import { getPresetFromTools, toolNamesForPreset } from "@/components/ToolPanel";

describe("assistant tool presets", () => {
  it("does not turn assistant or custom tool state into the default four tools", () => {
    expect(toolNamesForPreset("assistant")).toBeUndefined();
    expect(toolNamesForPreset("custom")).toBeUndefined();
  });

  it("reports non-preset active tools as custom", () => {
    expect(getPresetFromTools([
      { name: "read", description: "", active: true },
      { name: "bash", description: "", active: true },
      { name: "edit", description: "", active: true },
      { name: "write", description: "", active: true },
      { name: "mcp", description: "", active: true },
    ])).toBe("custom");
  });
});
