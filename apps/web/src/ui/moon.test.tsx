/** The moon on screen: work under way always shows a first sliver; a step not started can be a new moon. */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Moon } from "./Moon";

describe("the moon", () => {
  it("shows a first sliver for work under way, even at nought", () => {
    const { container } = render(<Moon phase={0} />);
    expect(container.querySelector(".moon__lit")).not.toBeNull();
  });

  it("is a new moon, its disc and no light, for a step not started", () => {
    const { container } = render(<Moon phase={0} sliver={false} />);
    expect(container.querySelector(".moon__disc")).not.toBeNull();
    expect(container.querySelector(".moon__lit")).toBeNull();
  });
});
