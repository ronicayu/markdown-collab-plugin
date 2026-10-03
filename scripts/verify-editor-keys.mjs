// Proves, in a REAL VS Code with real key presses, what docs/editor-undo-and-keys.md
// rests on and no other suite can reach:
//
//   - Cmd/Ctrl+B in the Markdown Collab editor (Editing mode) makes text bold
//     and does NOT also toggle the side bar;
//   - Cmd/Ctrl+Z undoes the last change to the file, in place, without
//     scrolling to the end of the document and without a "Claude updated…"
//     notice, and Cmd/Ctrl+Shift+Z redoes it;
//   - with the caret outside the document the keys are the workbench's again.
//
// The Extension Host suite cannot press keys (and its window often cannot
// undo at all); the Chromium harness has no VS Code keybinding layer. This
// drives the downloaded VS Code build through Playwright's Electron support,
// like scripts/verify-webview-keybinding.mjs.
//
// Not part of CI: it opens a window. Run it by hand after touching the
// editor's key handling, the keybindings, or the undo path:
//
//   npm run compile && node scripts/verify-editor-keys.mjs
//
// Exit 0 means every step below was observed.

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

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mc-edkeys-ws-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mc-edkeys-ud-"));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-edkeys-ext-"));
// Long enough to scroll: the bug this guards against parked the view at the end.
const doc =
  Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of a long document that scrolls.`).join("\n\n") + "\n";
const file = path.join(ws, "long.md");
fs.writeFileSync(file, doc);

const steps = [];
const step = (name, ok, detail = "") => {
  steps.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const until = async (fn, ms = 10_000, every = 150) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* frame busy */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, every));
  }
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
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 120_000 });
  await page.waitForTimeout(4000); // let onLanguage:markdown activate the extension
  await page.click(".monaco-editor .view-lines");

  // Open the file in the Markdown Collab editor (Reading mode).
  await page.keyboard.press(`${mod}+K`);
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+Alt+V`);

  const findFrame = async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        try {
          if (await f.$(".mdc-doc-toolbar")) return f;
        } catch {
          /* frame navigating */
        }
      }
      await page.waitForTimeout(300);
    }
    return null;
  };
  const frame = await findFrame();
  step("the Markdown Collab editor opened", frame !== null);
  if (!frame) throw new Error("the Markdown Collab editor never appeared");

  // Editing mode.
  await frame.click('#edit-mode-toggle input[value="edit"]', { force: true });
  step(
    "switched to Editing",
    await until(() => frame.$('.milkdown .ProseMirror[contenteditable="true"]'), 30_000),
  );

  const sideBarShown = () =>
    page.evaluate(() => {
      const el = document.querySelector(".part.sidebar");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden";
    });
  const firstPara = () => frame.evaluate(() => document.querySelector(".milkdown .ProseMirror p")?.textContent ?? "");
  const scrollTop = () => frame.evaluate(() => document.querySelector(".mdc-editor-scroll")?.scrollTop ?? -1);
  const hasStrong = () => frame.evaluate(() => !!document.querySelector(".milkdown .ProseMirror strong"));
  const noticeShown = () => frame.evaluate(() => /Claude (updated|edited)/.test(document.body.innerText));
  const onDisk = () => fs.readFileSync(file, "utf8");

  // 1. Type at the top of the document; the keystrokes reach the file.
  //    (Wherever in the paragraph the click put the caret — End is not
  //    "end of line" on macOS.)
  await frame.click(".milkdown .ProseMirror p >> nth=0");
  await page.keyboard.type(" XY");
  step("typing reaches the file", await until(() => onDisk().split("\n")[0].includes(" XY"), 15_000));

  // 2. Cmd+B: bold, and the side bar stays as it was.
  const sideBarBefore = await sideBarShown();
  await frame.dblclick(".milkdown .ProseMirror p >> nth=1", { position: { x: 30, y: 8 } });
  // Bold needs a selection; wait for the double-click to have made one.
  await until(() => frame.evaluate(() => (window.getSelection()?.toString() ?? "").length > 0), 5000);
  await page.keyboard.press(`${mod}+B`);
  step("Cmd+B makes the selection bold", await until(hasStrong, 5000));
  await page.waitForTimeout(800);
  step(
    "Cmd+B does not toggle the side bar",
    (await sideBarShown()) === sideBarBefore,
    `before=${sideBarBefore} after=${await sideBarShown()}`,
  );
  step("the bold reaches the file", await until(() => /\*\*Paragraph\*\*|\*\*\w+\*\*/.test(onDisk()), 15_000));

  // 3. Cmd+Z undoes the bold (the file's last change), in place.
  await page.keyboard.press(`${mod}+Z`);
  step("Cmd+Z undoes the bold", await until(async () => !(await hasStrong()), 10_000));
  step("…and the file follows", await until(() => !/\*\*/.test(onDisk()), 15_000));
  step("…without a \"Claude updated\" notice", !(await noticeShown()));

  // 4. Cmd+Z again undoes the typing, and the view does not jump to the end.
  //    (The bug: the second undo parked the cursor and scroll at the end.)
  await page.keyboard.press(`${mod}+Z`);
  step("a second Cmd+Z undoes the typing", await until(async () => !(await firstPara()).includes("XY"), 10_000), await firstPara());
  await page.waitForTimeout(500);
  const top = await scrollTop();
  step("the view did not scroll to the end", top >= 0 && top < 200, `scrollTop=${top}`);
  step("the file is back to the original", await until(() => onDisk() === doc, 15_000));
  step("the side bar is still as it was", (await sideBarShown()) === sideBarBefore);

  // 5. Redo.
  await page.keyboard.press(`${mod}+Shift+Z`);
  step("Cmd+Shift+Z redoes the typing", await until(async () => (await firstPara()).includes("XY"), 10_000), await firstPara());

  // 6. With the caret outside the document, Cmd+B is the workbench's again.
  await frame.click("#threads-header h2");
  await page.waitForTimeout(800);
  await page.keyboard.press(`${mod}+B`);
  step(
    "outside the document, Cmd+B toggles the side bar",
    await until(async () => (await sideBarShown()) !== sideBarBefore, 5000),
  );
  await page.keyboard.press(`${mod}+B`);
} catch (e) {
  step("run", false, String(e.message ?? e).slice(0, 400));
} finally {
  try {
    await app?.close();
  } catch {
    /* already gone */
  }
  for (const d of [ws, userData, extDir]) fs.rmSync(d, { recursive: true, force: true });
}
const failed = steps.filter((s) => !s.ok);
console.log(
  failed.length === 0 ? "verify-editor-keys: all observed" : `verify-editor-keys: ${failed.length} step(s) failed`,
);
process.exit(failed.length === 0 ? 0 : 1);
