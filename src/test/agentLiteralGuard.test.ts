// Guard for 10x-plan-4 P1.2: every "is this the agent?" check must go
// through `isAgentComment` (or read an `agentSlugFromClientName`-derived
// slug), never compare an author string to the literal `"claude"` directly.
// `agentIdentity.ts` is the one place allowed to mention that literal — it's
// the known-slug fallback `isAgentComment` itself is built on.
//
// Scoped to non-test source: a test asserting its OWN fixture data — "this
// comment's author should be exactly claude" — is a normal equality check on
// data the test constructed, not the authorship-classification bug this
// guards against. Production code has no such excuse.

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(__dirname, "..");
const EXEMPT = "agentIdentity.ts";

const LITERAL_RE = /===\s*["']claude["']|!==\s*["']claude["']/;

/** Every `.ts` file under `src/`, excluding `src/test/`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (join(dir, entry.name) === resolve(SRC_ROOT, "test")) continue;
      out.push(...walk(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

describe('no literal === "claude" / !== "claude" author comparison outside agentIdentity.ts', () => {
  const files = walk(SRC_ROOT).filter((abs) => !abs.endsWith(`/${EXEMPT}`));

  it("found more than a token handful of files to check (the scan didn't come up empty)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const abs of files) {
    const rel = abs.slice(SRC_ROOT.length + 1);
    it(`${rel} has no literal claude author comparison`, () => {
      const text = readFileSync(abs, "utf8");
      expect(text).not.toMatch(LITERAL_RE);
    });
  }

  it("agentIdentity.ts is exempt and still mentions the pattern it replaces", () => {
    const text = readFileSync(resolve(SRC_ROOT, EXEMPT), "utf8");
    expect(text).toMatch(LITERAL_RE);
  });
});
