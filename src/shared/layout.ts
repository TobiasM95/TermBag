import type {
  LayoutPresetId,
  LayoutSplitNode,
  PersistedTabLayout,
  TabLayoutNode,
} from "./types.js";

type PaneNavigationDirection = "up" | "down" | "left" | "right";

const PANE_NAVIGATION_BY_PRESET: Record<
  LayoutPresetId,
  Array<Partial<Record<PaneNavigationDirection, number>>>
> = {
  single: [{}],
  split_horizontal: [
    { down: 1 },
    { up: 0 },
  ],
  split_vertical: [
    { right: 1 },
    { left: 0 },
  ],
  grid_2x2: [
    { right: 1, down: 2 },
    { left: 0, down: 3 },
    { up: 0, right: 3 },
    { up: 1, left: 2 },
  ],
  main_left_stack_right: [
    { right: 1, up: 1, down: 2 },
    { left: 0, down: 2 },
    { left: 0, up: 1 },
  ],
  stack_left_main_right: [
    { right: 2, down: 1 },
    { right: 2, up: 0 },
    { left: 0, up: 0, down: 1 },
  ],
};

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

function isTwoLeafSplit(
  node: TabLayoutNode,
  direction: "row" | "column",
): boolean {
  return (
    node.kind === "split" &&
    node.direction === direction &&
    node.children.length === 2 &&
    node.children[0]?.kind === "leaf" &&
    node.children[1]?.kind === "leaf"
  );
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

export function detectLayoutPresetId(layout: PersistedTabLayout): LayoutPresetId | null {
  const { root } = layout;

  if (root.kind === "leaf") {
    return "single";
  }

  if (isTwoLeafSplit(root, "column")) {
    return "split_horizontal";
  }

  if (isTwoLeafSplit(root, "row")) {
    return "split_vertical";
  }

  if (
    root.direction === "column" &&
    root.children.length === 2 &&
    root.children[0] &&
    root.children[1] &&
    isTwoLeafSplit(root.children[0], "row") &&
    isTwoLeafSplit(root.children[1], "row")
  ) {
    return "grid_2x2";
  }

  if (
    root.direction === "row" &&
    root.children.length === 2 &&
    root.children[0]?.kind === "leaf" &&
    root.children[1] &&
    isTwoLeafSplit(root.children[1], "column")
  ) {
    return "main_left_stack_right";
  }

  if (
    root.direction === "row" &&
    root.children.length === 2 &&
    root.children[0] &&
    isTwoLeafSplit(root.children[0], "column") &&
    root.children[1]?.kind === "leaf"
  ) {
    return "stack_left_main_right";
  }

  return null;
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

export function getNextLayoutPaneSlot(
  presetId: LayoutPresetId,
  currentSlot: number,
  direction: PaneNavigationDirection,
): number | null {
  const presetMapping = PANE_NAVIGATION_BY_PRESET[presetId];
  const nextSlot = presetMapping[currentSlot]?.[direction];
  return typeof nextSlot === "number" ? nextSlot : null;
}
