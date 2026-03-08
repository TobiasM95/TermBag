import type {
  PersistedTabLayout,
  TabLayoutNode,
  TemplateDefinition,
  TemplateExportFile,
  TemplateLayoutNode,
  TemplateLibraryExportFile,
  TemplatePathReference,
  TemplateTab,
  TemplateTabLayout,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid template ${label}.`);
  }

  return value;
}

function assertDirection(value: unknown, label: string): "row" | "column" {
  if (value !== "row" && value !== "column") {
    throw new Error(`Invalid template ${label}.`);
  }

  return value;
}

function validateTemplateLayoutNode(value: unknown, label: string): TemplateLayoutNode {
  if (!isRecord(value)) {
    throw new Error(`Invalid template ${label}.`);
  }

  const id = assertString(value.id, `${label} id`);
  const kind = value.kind;
  if (kind === "leaf") {
    return {
      id,
      kind,
      paneId: assertString(value.paneId, `${label} pane id`),
    };
  }

  if (kind !== "split") {
    throw new Error(`Invalid template ${label}.`);
  }

  if (!Array.isArray(value.sizes) || !Array.isArray(value.children)) {
    throw new Error(`Invalid template ${label}.`);
  }

  const sizes = value.sizes.map((size, index) => {
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      throw new Error(`Invalid template ${label} size ${index + 1}.`);
    }

    return size;
  });
  const children = value.children.map((child, index) =>
    validateTemplateLayoutNode(child, `${label} child ${index + 1}`),
  );

  if (children.length === 0 || sizes.length !== children.length) {
    throw new Error(`Invalid template ${label}.`);
  }

  return {
    id,
    kind,
    direction: assertDirection(value.direction, `${label} direction`),
    sizes,
    children,
  };
}

function validateTemplateTabLayout(value: unknown, label: string): TemplateTabLayout {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(`Invalid template ${label}.`);
  }

  return {
    version: 1,
    root: validateTemplateLayoutNode(value.root, `${label} root`),
  };
}

function collectTemplatePaneIdsFromNode(node: TemplateLayoutNode, paneIds: string[]): void {
  if (node.kind === "leaf") {
    paneIds.push(node.paneId);
    return;
  }

  for (const child of node.children) {
    collectTemplatePaneIdsFromNode(child, paneIds);
  }
}

function validateTemplateTab(value: unknown, label: string): TemplateTab {
  if (!isRecord(value) || !Array.isArray(value.panes)) {
    throw new Error(`Invalid template ${label}.`);
  }

  const title = assertString(value.title, `${label} title`);
  const layout = validateTemplateTabLayout(value.layout, `${label} layout`);
  const panes = value.panes.map((pane, index) => {
    if (!isRecord(pane)) {
      throw new Error(`Invalid template ${label} pane ${index + 1}.`);
    }

    const cwd = pane.cwd;
    let normalizedCwd: TemplatePathReference | null = null;
    if (cwd !== null && cwd !== undefined) {
      if (!isRecord(cwd)) {
        throw new Error(`Invalid template ${label} pane ${index + 1} cwd.`);
      }

      const kind = cwd.kind;
      if (kind !== "relative" && kind !== "absolute") {
        throw new Error(`Invalid template ${label} pane ${index + 1} cwd.`);
      }

      normalizedCwd = {
        kind,
        value: assertString(cwd.value, `${label} pane ${index + 1} cwd value`),
      };
    }

    return {
      id: assertString(pane.id, `${label} pane ${index + 1} id`),
      shellProfileId: assertString(
        pane.shellProfileId,
        `${label} pane ${index + 1} shell profile`,
      ),
      cwd: normalizedCwd,
    };
  });

  if (panes.length === 0) {
    throw new Error(`Invalid template ${label}.`);
  }

  const paneIds = panes.map((pane) => pane.id);
  const uniquePaneIds = new Set(paneIds);
  if (uniquePaneIds.size !== paneIds.length) {
    throw new Error(`Invalid template ${label}.`);
  }

  const layoutPaneIds = collectTemplatePaneIds(layout);
  const uniqueLayoutPaneIds = new Set(layoutPaneIds);
  if (uniqueLayoutPaneIds.size !== layoutPaneIds.length) {
    throw new Error(`Invalid template ${label}.`);
  }

  if (
    layoutPaneIds.length !== panes.length ||
    layoutPaneIds.some((paneId) => !uniquePaneIds.has(paneId))
  ) {
    throw new Error(`Invalid template ${label}.`);
  }

  const focusedPaneId = assertString(value.focusedPaneId, `${label} focused pane`);
  if (!uniquePaneIds.has(focusedPaneId)) {
    throw new Error(`Invalid template ${label}.`);
  }

  return {
    title,
    layout,
    focusedPaneId,
    panes,
  };
}

function validateTemplateDefinition(value: unknown, label: string): TemplateDefinition {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    throw new Error(`Invalid ${label}.`);
  }

  const name = assertString(value.name, `${label} name`).trim();
  const tabs = value.tabs.map((tab, index) =>
    validateTemplateTab(tab, `${label} tab ${index + 1}`),
  );

  if (tabs.length === 0) {
    throw new Error(`Invalid ${label}.`);
  }

  return {
    name,
    tabs,
  };
}

function mapPersistedNodeToTemplateNode(node: TabLayoutNode): TemplateLayoutNode {
  if (node.kind === "leaf") {
    return {
      id: node.id,
      kind: "leaf",
      paneId: node.sessionId,
    };
  }

  return {
    id: node.id,
    kind: "split",
    direction: node.direction,
    sizes: [...node.sizes],
    children: node.children.map((child) => mapPersistedNodeToTemplateNode(child)),
  };
}

function mapTemplateNodeToPersistedNode(
  node: TemplateLayoutNode,
  paneSessionIds: Map<string, string>,
): TabLayoutNode {
  if (node.kind === "leaf") {
    const sessionId = paneSessionIds.get(node.paneId);
    if (!sessionId) {
      throw new Error(`Template layout references an unknown pane: ${node.paneId}`);
    }

    return {
      id: node.id,
      kind: "leaf",
      sessionId,
    };
  }

  return {
    id: node.id,
    kind: "split",
    direction: node.direction,
    sizes: [...node.sizes],
    children: node.children.map((child) => mapTemplateNodeToPersistedNode(child, paneSessionIds)),
  };
}

export function mapPersistedLayoutToTemplateLayout(
  layout: PersistedTabLayout,
): TemplateTabLayout {
  return {
    version: 1,
    root: mapPersistedNodeToTemplateNode(layout.root),
  };
}

export function mapTemplateLayoutToPersistedLayout(
  layout: TemplateTabLayout,
  paneSessionIds: Map<string, string>,
): PersistedTabLayout {
  return {
    version: 1,
    root: mapTemplateNodeToPersistedNode(layout.root, paneSessionIds),
  };
}

export function collectTemplatePaneIds(layout: TemplateTabLayout): string[] {
  const paneIds: string[] = [];
  collectTemplatePaneIdsFromNode(layout.root, paneIds);
  return paneIds;
}

export function findFirstTemplatePaneId(layout: TemplateTabLayout): string | null {
  return collectTemplatePaneIds(layout)[0] ?? null;
}

export function parseTemplateDocument(
  serialized: string,
): TemplateDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Template import file is not valid JSON.");
  }

  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error("Unsupported template import file.");
  }

  if (parsed.kind === "template") {
    return [
      validateTemplateDefinition(
        parsed.template,
        "template",
      ),
    ];
  }

  if (parsed.kind === "template-library") {
    if (!Array.isArray(parsed.templates)) {
      throw new Error("Invalid template library file.");
    }

    if (parsed.templates.length === 0) {
      throw new Error("Template library import file is empty.");
    }

    return parsed.templates.map((template, index) =>
      validateTemplateDefinition(template, `template ${index + 1}`),
    );
  }

  throw new Error("Unsupported template import file.");
}

export function serializeTemplateDocument(template: TemplateDefinition): string {
  const file: TemplateExportFile = {
    version: 1,
    kind: "template",
    template,
  };

  return JSON.stringify(file, null, 2);
}

export function serializeTemplateLibraryDocument(
  templates: TemplateDefinition[],
): string {
  const file: TemplateLibraryExportFile = {
    version: 1,
    kind: "template-library",
    templates,
  };

  return JSON.stringify(file, null, 2);
}
