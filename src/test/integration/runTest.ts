// Boots a downloaded VSCode (Electron) instance with our extension loaded
// against a temp workspace, then hands control to the mocha suite in
// `./suite/index.js`. Mirrors the layout from the official sample at
// https://github.com/microsoft/vscode-extension-samples/tree/main/helloworld-test-sample.

import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    // The folder containing the package.json — VSCode loads it as a
    // development extension (no install / no marketplace round-trip).
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
    const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
    const fixturesPath = path.resolve(__dirname, "fixtures");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-extensions stops every other installed extension from
      // booting in the Test Host so the only thing on the event bus is us
      // (and our timing assertions stay deterministic).
      launchArgs: [fixturesPath, "--disable-extensions"],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();
