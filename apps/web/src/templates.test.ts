import { describe, expect, it } from "vitest";
import { suggestName } from "./templates";

describe("a new project's name", () => {
  it("is a What if? question whole, with no ellipsis typed into it", () => {
    expect(suggestName("what_if", { question: "What if every book in an old library flew off its shelf like a bird?" })).toBe("What if every book in an old library flew off its shelf like a bird?");
    const long = suggestName("what_if", { question: `What if ${"the sea ".repeat(20)}froze?` });
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long).not.toContain("…");
    expect(long).toMatch(/sea$/);
    expect(suggestName("what_if", {})).toBe("What if?");
  });
});
