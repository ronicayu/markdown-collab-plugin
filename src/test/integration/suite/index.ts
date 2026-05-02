// Mocha bootstrap. Runs inside the Extension Test Host (Electron main
// renderer). Discovers every *.test.js sibling, registers them, runs.

import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    // Tests use the TDD interface (suite/test/suiteSetup) — switching
    // to "bdd" here would leave suite/test undefined at require time.
    ui: "tdd",
    color: true,
    timeout: 30000,
  });
  const testsRoot = path.resolve(__dirname);
  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
