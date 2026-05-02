import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    // Integration tests run inside a real VSCode Extension Host via
    // @vscode/test-electron (npm run test:integration), not vitest.
    exclude: ["src/test/integration/**", "node_modules/**"],
    environment: "node",
  },
  resolve: {
    alias: {
      // The real `vscode` module is only available inside the Extension Host
      // at runtime. For unit tests we route the import to a lightweight stub
      // that satisfies the small surface our pure helpers touch at import
      // time. This is ONLY used by vitest — `tsc` resolves the real types
      // from @types/vscode for compilation.
      vscode: path.resolve(__dirname, "src/test/vscode-stub.ts"),
    },
  },
});
