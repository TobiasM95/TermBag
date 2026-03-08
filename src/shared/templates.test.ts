import { describe, expect, it } from "vitest";
import { createLayoutFromPreset } from "./layout.js";
import {
  mapPersistedLayoutToTemplateLayout,
  mapTemplateLayoutToPersistedLayout,
  parseTemplateDocument,
  serializeTemplateDocument,
  serializeTemplateLibraryDocument,
} from "./templates.js";

describe("template helpers", () => {
  it("round-trips persisted layouts through template layouts", () => {
    const layout = createLayoutFromPreset("grid_2x2", [
      "session-1",
      "session-2",
      "session-3",
      "session-4",
    ]);

    const templateLayout = mapPersistedLayoutToTemplateLayout(layout);
    const restored = mapTemplateLayoutToPersistedLayout(
      templateLayout,
      new Map([
        ["session-1", "session-1"],
        ["session-2", "session-2"],
        ["session-3", "session-3"],
        ["session-4", "session-4"],
      ]),
    );

    expect(restored).toEqual(layout);
  });

  it("parses both single-template and template-library documents", () => {
    const singleTemplate = serializeTemplateDocument({
      name: "Starter",
      tabs: [
        {
          title: "One",
          focusedPaneId: "pane-1",
          layout: {
            version: 1,
            root: { id: "pane-1:root", kind: "leaf", paneId: "pane-1" },
          },
          panes: [{ id: "pane-1", shellProfileId: "pwsh", cwd: null }],
        },
      ],
    });
    const library = serializeTemplateLibraryDocument([
      {
        name: "Starter",
        tabs: [
          {
            title: "One",
            focusedPaneId: "pane-1",
            layout: {
              version: 1,
              root: { id: "pane-1:root", kind: "leaf", paneId: "pane-1" },
            },
            panes: [{ id: "pane-1", shellProfileId: "pwsh", cwd: null }],
          },
        ],
      },
      {
        name: "Split",
        tabs: [
          {
            title: "Two",
            focusedPaneId: "pane-2",
            layout: {
              version: 1,
              root: { id: "pane-2:root", kind: "leaf", paneId: "pane-2" },
            },
            panes: [{ id: "pane-2", shellProfileId: "pwsh", cwd: null }],
          },
        ],
      },
    ]);

    expect(parseTemplateDocument(singleTemplate)).toHaveLength(1);
    expect(parseTemplateDocument(library)).toHaveLength(2);
  });

  it("rejects malformed template documents", () => {
    expect(() => parseTemplateDocument("{")).toThrow("Template import file is not valid JSON.");
    expect(() =>
      parseTemplateDocument(
        JSON.stringify({
          version: 1,
          kind: "template",
          template: {
            name: "Broken",
            tabs: [
              {
                title: "Broken",
                focusedPaneId: "pane-2",
                layout: {
                  version: 1,
                  root: { id: "pane-1:root", kind: "leaf", paneId: "pane-1" },
                },
                panes: [{ id: "pane-1", shellProfileId: "pwsh", cwd: null }],
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });
});
