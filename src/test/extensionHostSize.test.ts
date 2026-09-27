// Guard for 10x-plan-4 P3.2: extension.ts is activation and dependency wiring
// only — command families live in src/commands/*.ts. Without this, the next
// feature that needs "just one more command" grows extension.ts right back
// into the 1848-line file the split was meant to end.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

describe("extension.ts stays activation and wiring only", () => {
  it("is under 400 lines", () => {
    const lines = readFileSync(resolve(__dirname, "../extension.ts"), "utf8").split("\n").length;
    expect(lines).toBeLessThan(400);
  });
});
