import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

const gated = [
  "src/commands/setup.ts",
  "src/pr/cli.ts",
  "src/transports/claudeBinary.ts",
  "src/transports/headless.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("files that start a subprocess", () => {
  it("are exactly the ones behind a Restricted Mode gate", () => {
    const spawning = sourceFiles(SRC)
      .filter((file) => /["'](?:node:)?child_process["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(resolve(SRC, ".."), file).split(sep).join("/"))
      .sort();

    expect(
      spawning,
      "A new file imports child_process. Gate it in Restricted Mode (route it through lookupClaude, " +
        "the CLI gate in src/pr/cli.ts, or requireTrust in src/trust.ts), then add it to this list.",
    ).toEqual(gated);
  });
});
