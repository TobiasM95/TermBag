import { describe, expect, it } from "vitest";
import {
  getBuiltInShells,
  getDefaultProfileOrder,
  resolveShellPlatform,
} from "./shells.js";

describe("shared shell catalog", () => {
  it("returns the expected macOS shell profiles", () => {
    const profiles = getBuiltInShells("darwin");

    expect(profiles.map((profile) => profile.id)).toEqual(["zsh", "bash", "pwsh"]);
    expect(profiles.every((profile) => profile.platform === "darwin")).toBe(true);
  });

  it("prefers zsh as the macOS default shell", () => {
    expect(getDefaultProfileOrder("darwin")).toEqual(["zsh", "bash", "pwsh"]);
  });

  it("falls back unknown platforms to linux defaults", () => {
    expect(resolveShellPlatform("sunos")).toBe("linux");
  });
});
