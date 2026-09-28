// Proves the contributed chords in a REAL VS Code, including from inside the
// review view's webview — the one thing neither the Extension Host suite nor
// the Chromium harness can reach. The host suite has no way to press keys; the
// harness has no VS Code keybinding layer. This drives the downloaded VS Code
// build through Playwright's Electron support, the way VS Code's own smoke
// tests do.
//
// Not part of CI: it opens a window. Run it by hand after touching the
// keybindings or the webview's key handling:
//
//   npm run compile && node scripts/verify-webview-keybinding.mjs
//
// Exit 0 means every step below was observed; anything else prints which one
// wasn't.

import { _electron as electron } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mac = process.platform === "darwin";
const mod = mac ? "Meta" : "Control";

function findCode() {
  const root = path.join(repo, ".vscode-test");
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith("vscode-")).sort() : [];
  if (dirs.length === 0) throw new Error("no VS Code under .vscode-test — run npm run test:integration once");
  const dir = path.join(root, dirs[dirs.length - 1]);
  if (mac) return path.join(dir, "Visual Studio Code.app", "Contents", "MacOS", "Code");
  const linux = path.join(dir, "code");
  return fs.existsSync(linux) ? linux : path.join(dir, "Code.exe");
}

// A workspace with one file carrying two unread threads from Claude, so the
// "next unread" walk has somewhere to go on the second press.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mc-keys-ws-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mc-keys-ud-"));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-keys-ext-"));
const doc = [
  "# Notes",
  "",
  "The <!--mc:a:aaa11-->first passage<!--mc:/a:aaa11--> is here.",
  "",
  "And the <!--mc:a:bbb22-->second passage<!--mc:/a:bbb22--> is here.",
  "",
  "<!--mc:threads:begin-->",
  '<!--mc:t {"id":"aaa11","quote":"first passage","status":"open","comments":[{"id":"c1","author":"claude","agent":true,"ts":"2026-09-28T00:00:00Z","body":"One."}]}-->',
  '<!--mc:t {"id":"bbb22","quote":"second passage","status":"open","comments":[{"id":"c1","author":"claude","agent":true,"ts":"2026-09-28T00:00:01Z","body":"Two."}]}-->',
  "<!--mc:threads:end-->",
  "",
].join("\n");
const file = path.join(ws, "notes.md");
fs.writeFileSync(file, doc);

const steps = [];
const step = (name, ok, detail = "") => {
  steps.push({ name, ok });
  console.log(`${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let app;
try {
  app = await electron.launch({
    executablePath: findCode(),
    args: [
      `--extensionDevelopmentPath=${repo}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extDir}`,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--disable-telemetry",
      "--new-window",
      ws,
      file,
    ],
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  // The file opens in a text editor; give the extension a moment to activate
  // (onLanguage:markdown) so its keybindings' `when` clauses can be true.
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.click(".monaco-editor .view-lines");

  const chord = async (second) => {
    await page.keyboard.press(`${mod}+K`);
    await page.waitForTimeout(150);
    await page.keyboard.press(`${mod}+Alt+${second}`);
  };

  // The walk command sets a status-bar message ("Unread from Claude 1/2 —
  // notes.md") for five seconds: a host-side observation that doesn't depend
  // on what the webview draws.
  const statusText = () => page.evaluate(() => document.querySelector(".part.statusbar")?.textContent ?? "");
  const waitStatus = async (needle) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if ((await statusText()).includes(needle)) return true;
      await page.waitForTimeout(150);
    }
    return false;
  };

  // 1. From the text editor: Cmd+K Cmd+Alt+N opens the review view on the
  //    first unread thread.
  await chord("N");
  step("Cmd+K Cmd+Alt+N from the editor walks to unread 1/2", await waitStatus("Unread from Claude 1/2"));
  const webviewFrame = async () => {
    // VS Code nests the extension's HTML two iframes deep.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        try {
          if (await f.$("#threads-list")) return f;
        } catch {
          /* frame navigating */
        }
      }
      await page.waitForTimeout(250);
    }
    return null;
  };
  const frame = await webviewFrame();
  step("the review view opened", frame !== null);
  if (!frame) throw new Error("review view never appeared");
  await frame.waitForSelector(".thread-card", { timeout: 20_000 });
  // Let the 5-second status message from step 1 expire so the next one is new.
  await page.waitForTimeout(5500);

  // 2. From INSIDE the webview: focus its document (the preview pane, not a
  //    card or an input) and press the chord. If VS Code forwards the chord
  //    from the webview to its keybinding service, the walk advances to 2/2.
  await frame.click("#preview-pane", { position: { x: 20, y: 5 } });
  await frame.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  await chord("N");
  step("Cmd+K Cmd+Alt+N inside the webview walks to unread 2/2", await waitStatus("Unread from Claude 2/2"));
  await page.waitForTimeout(5500);
  await chord("N");
  step("a third press wraps back to 1/2", await waitStatus("Unread from Claude 1/2"));

  // 3. Single-key navigation inside the webview (no chord).
  const highlighted = () => frame.evaluate(() => document.querySelector(".thread-card.highlighted")?.getAttribute("data-thread") ?? null);
  const before = await highlighted();
  await page.keyboard.press("n");
  await page.waitForTimeout(500);
  const after = await highlighted();
  step("n inside the webview moves the highlight", after !== null && after !== before, `before=${before} after=${after}`);
} catch (e) {
  step("run", false, String(e.message ?? e).slice(0, 300));
} finally {
  try {
    await app?.close();
  } catch {
    /* already gone */
  }
  for (const d of [ws, userData, extDir]) fs.rmSync(d, { recursive: true, force: true });
}
const failed = steps.filter((s) => !s.ok);
console.log(failed.length === 0 ? "verify-webview-keybinding: all observed" : `verify-webview-keybinding: ${failed.length} step(s) failed`);
process.exit(failed.length === 0 ? 0 : 1);
