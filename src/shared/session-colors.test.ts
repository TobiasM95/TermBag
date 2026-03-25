import { describe, expect, it } from "vitest";
import {
  createSessionBorderPalette,
  normalizeSessionBorderColor,
  parseStoredSessionBorderColor,
} from "./session-colors.js";

describe("session border colors", () => {
  it("normalizes supported hex formats", () => {
    expect(normalizeSessionBorderColor("#3B82F6")).toBe("#3b82f6");
    expect(normalizeSessionBorderColor("abc")).toBe("#aabbcc");
    expect(normalizeSessionBorderColor("")).toBeNull();
    expect(normalizeSessionBorderColor(null)).toBeNull();
  });

  it("ignores invalid stored colors and derives focus palettes from valid ones", () => {
    expect(parseStoredSessionBorderColor("not-a-color")).toBeNull();

    expect(createSessionBorderPalette("#3b82f6", "dark")).toEqual({
      base: "#3b82f6",
      focused: "#629bf8",
      unfocused: "#326dcf",
    });
    expect(createSessionBorderPalette("#3b82f6", "light")).toEqual({
      base: "#3b82f6",
      focused: "#2f68c5",
      unfocused: "#5a96f7",
    });
  });
});
