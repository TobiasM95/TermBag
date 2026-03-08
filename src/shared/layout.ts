import type { PersistedTabLayout, TabLayoutNode } from "./types.js";

export function createSingleLeafLayout(
  sessionId: string,
  nodeId = sessionId,
): PersistedTabLayout {
  return {
    version: 1,
    root: {
      id: nodeId,
      kind: "leaf",
      sessionId,
    },
  };
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

export function findFirstLayoutSessionId(layout: PersistedTabLayout): string | null {
  let current: TabLayoutNode = layout.root;
  while (current.kind === "split") {
    const firstChild = current.children[0];
    if (!firstChild) {
      return null;
    }
    current = firstChild;
  }

  return current.sessionId;
}
