import { describe, expect, it } from "vitest";
import {
  encodeTemplatePathReference,
  resolveTemplatePathReference,
} from "./template-paths.js";

describe("template path helpers", () => {
  it("stores project-root descendants as relative references", () => {
    expect(
      encodeTemplatePathReference("C:\\Work\\Repo", "C:\\Work\\Repo\\src\\server"),
    ).toEqual({
      kind: "relative",
      value: "src\\server",
    });
  });

  it("stores external directories as absolute references", () => {
    expect(
      encodeTemplatePathReference("C:\\Work\\Repo", "D:\\Shared\\Tools"),
    ).toEqual({
      kind: "absolute",
      value: "D:\\Shared\\Tools",
    });
  });

  it("resolves relative references against the target project root", () => {
    expect(
      resolveTemplatePathReference("C:\\Other\\Repo", {
        kind: "relative",
        value: "src\\server",
      }),
    ).toBe("C:\\Other\\Repo\\src\\server");
  });
});
