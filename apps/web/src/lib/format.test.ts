/** Times as the app writes them: a place in time with tenths that never runs ahead, a length to the nearest second. */
import { describe, expect, it } from "vitest";
import { timecode } from "./format";

describe("timecode", () => {
  it("states a place in time with tenths, never ahead of it", () => {
    expect(timecode(3.97)).toBe("0:03.9");
    expect(timecode(61.25)).toBe("1:01.2");
    expect(timecode(-1)).toBe("0:00.0");
  });

  it("states a length to the nearest second, as the header's seconds do", () => {
    // A 3.9 s clip is the header's "4 s": its card said 0:03.
    expect(timecode(3.9, false)).toBe("0:04");
    expect(timecode(3.4, false)).toBe("0:03");
    expect(timecode(59.6, false)).toBe("1:00");
    expect(timecode(0, false)).toBe("0:00");
  });
});
