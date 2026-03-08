import type {
  LayoutPresetId,
  LayoutSplitNode,
  PersistedTabLayout,
  TabLayoutNode,
} from "./types.js";

function createLeaf(sessionId: string, nodeId: string): TabLayoutNode {
  return {
    id: nodeId,
    kind: "leaf",
    sessionId,
  };
}

function createSplit(
  nodeId: string,
  direction: "row" | "column",
  sizes: number[],
  children: TabLayoutNode[],
): LayoutSplitNode {
  return {
    id: nodeId,
    kind: "split",
    direction,
    sizes,
    children,
  };
}

export function createSingleLeafLayout(
  sessionId: string,
  nodeId = sessionId,
): PersistedTabLayout {
  return {
    version: 1,
    root: createLeaf(sessionId, nodeId),
  };
}

export function getLayoutPresetLeafCount(presetId: LayoutPresetId): number {
  switch (presetId) {
    case "single":
      return 1;
    case "split_horizontal":
    case "split_vertical":
      return 2;
    case "grid_2x2":
      return 4;
    case "main_left_stack_right":
    case "stack_left_main_right":
      return 3;
  }
}

export function createLayoutFromPreset(
  presetId: LayoutPresetId,
  sessionIds: string[],
): PersistedTabLayout {
  if (sessionIds.length < getLayoutPresetLeafCount(presetId)) {
    throw new Error(`Not enough sessions for layout preset: ${presetId}`);
  }

  switch (presetId) {
    case "single":
      return createSingleLeafLayout(sessionIds[0]!, "layout:single");
    case "split_horizontal":
      return {
        version: 1,
        root: createSplit("layout:split-horizontal", "column", [1, 1], [
          createLeaf(sessionIds[0]!, "layout:split-horizontal:top"),
          createLeaf(sessionIds[1]!, "layout:split-horizontal:bottom"),
        ]),
      };
    case "split_vertical":
      return {
        version: 1,
        root: createSplit("layout:split-vertical", "row", [1, 1], [
          createLeaf(sessionIds[0]!, "layout:split-vertical:left"),
          createLeaf(sessionIds[1]!, "layout:split-vertical:right"),
        ]),
      };
    case "grid_2x2":
      return {
        version: 1,
        root: createSplit("layout:grid-2x2", "column", [1, 1], [
          createSplit("layout:grid-2x2:top", "row", [1, 1], [
            createLeaf(sessionIds[0]!, "layout:grid-2x2:top-left"),
            createLeaf(sessionIds[1]!, "layout:grid-2x2:top-right"),
          ]),
          createSplit("layout:grid-2x2:bottom", "row", [1, 1], [
            createLeaf(sessionIds[2]!, "layout:grid-2x2:bottom-left"),
            createLeaf(sessionIds[3]!, "layout:grid-2x2:bottom-right"),
          ]),
        ]),
      };
    case "main_left_stack_right":
      return {
        version: 1,
        root: createSplit("layout:main-left-stack-right", "row", [1, 1], [
          createLeaf(sessionIds[0]!, "layout:main-left-stack-right:left"),
          createSplit("layout:main-left-stack-right:right", "column", [1, 1], [
            createLeaf(sessionIds[1]!, "layout:main-left-stack-right:top-right"),
            createLeaf(sessionIds[2]!, "layout:main-left-stack-right:bottom-right"),
          ]),
        ]),
      };
    case "stack_left_main_right":
      return {
        version: 1,
        root: createSplit("layout:stack-left-main-right", "row", [1, 1], [
          createSplit("layout:stack-left-main-right:left", "column", [1, 1], [
            createLeaf(sessionIds[0]!, "layout:stack-left-main-right:top-left"),
            createLeaf(sessionIds[1]!, "layout:stack-left-main-right:bottom-left"),
          ]),
          createLeaf(sessionIds[2]!, "layout:stack-left-main-right:right"),
        ]),
      };
  }
}

export function collectLayoutSessionIds(layout: PersistedTabLayout): string[] {
  const sessionIds = new Set<string>();

  const visit = (node: TabLayoutNode) => {
    if (node.kind === "leaf") {
      sessionIds.add(node.sessionId);
      return;
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(layout.root);
  return [...sessionIds];
}

export function flattenLayoutLeafSessionIds(layout: PersistedTabLayout): string[] {
  const sessionIds: string[] = [];

  const visit = (node: TabLayoutNode) => {
    if (node.kind === "leaf") {
      sessionIds.push(node.sessionId);
      return;
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(layout.root);
  return sessionIds;
}

export function findFirstLayoutSessionId(layout: PersistedTabLayout): string | null {
  const firstSessionId = flattenLayoutLeafSessionIds(layout)[0];
  return firstSessionId ?? null;
}
