import { describe, expect, it } from "vitest";
import {
  createLayoutFromPreset,
  flattenLayoutLeafSessionIds,
  getLayoutPresetLeafCount,
} from "./layout.js";
import type { LayoutPresetId } from "./types.js";

const sessionIds = ["session-1", "session-2", "session-3", "session-4"];

describe("layout presets", () => {
  it.each([
    {
      presetId: "single" as LayoutPresetId,
      expectedLeafCount: 1,
      expectedOrder: ["session-1"],
    },
    {
      presetId: "split_horizontal" as LayoutPresetId,
      expectedLeafCount: 2,
      expectedOrder: ["session-1", "session-2"],
    },
    {
      presetId: "split_vertical" as LayoutPresetId,
      expectedLeafCount: 2,
      expectedOrder: ["session-1", "session-2"],
    },
    {
      presetId: "grid_2x2" as LayoutPresetId,
      expectedLeafCount: 4,
      expectedOrder: ["session-1", "session-2", "session-3", "session-4"],
    },
    {
      presetId: "main_left_stack_right" as LayoutPresetId,
      expectedLeafCount: 3,
      expectedOrder: ["session-1", "session-2", "session-3"],
    },
    {
      presetId: "stack_left_main_right" as LayoutPresetId,
      expectedLeafCount: 3,
      expectedOrder: ["session-1", "session-2", "session-3"],
    },
  ])("builds $presetId with stable leaf order", ({ presetId, expectedLeafCount, expectedOrder }) => {
    const layout = createLayoutFromPreset(presetId, sessionIds);

    expect(getLayoutPresetLeafCount(presetId)).toBe(expectedLeafCount);
    expect(flattenLayoutLeafSessionIds(layout)).toEqual(expectedOrder);
  });

  it("builds the asymmetric three-pane layouts with the expected split orientation", () => {
    const mainLeft = createLayoutFromPreset("main_left_stack_right", sessionIds);
    const stackLeft = createLayoutFromPreset("stack_left_main_right", sessionIds);

    expect(mainLeft.root.kind).toBe("split");
    if (mainLeft.root.kind === "split") {
      expect(mainLeft.root.direction).toBe("row");
      expect(mainLeft.root.children[0]?.kind).toBe("leaf");
      expect(mainLeft.root.children[1]?.kind).toBe("split");
      if (mainLeft.root.children[1]?.kind === "split") {
        expect(mainLeft.root.children[1].direction).toBe("column");
      }
    }

    expect(stackLeft.root.kind).toBe("split");
    if (stackLeft.root.kind === "split") {
      expect(stackLeft.root.direction).toBe("row");
      expect(stackLeft.root.children[0]?.kind).toBe("split");
      expect(stackLeft.root.children[1]?.kind).toBe("leaf");
      if (stackLeft.root.children[0]?.kind === "split") {
        expect(stackLeft.root.children[0].direction).toBe("column");
      }
    }
  });
});
