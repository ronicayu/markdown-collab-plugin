import * as assert from "assert";
import * as vscode from "vscode";
import { parse } from "../../../inlineComments/format";
import {
  FIRST_QUOTE,
  FIXTURE,
  IDLE_MESSAGE,
  SECOND_QUOTE,
  SENTINEL,
  activateExtension,
  hasShellEvents,
  idleTerminal,
  occurrences,
  pickMode,
  posixSuite,
  quietly,
  resetRememberedMode,
  runningCat,
  sendAll,
  sendFixture,
  settled,
  waitFor,
} from "./sendHarness";

async function threadsAwaitingReply(): Promise<number> {
  await quietly(async () => vscode.commands.executeCommand("markdownCollab.reportDiagnostics"));
  await waitFor(
    () => vscode.window.activeTextEditor?.document.getText().includes("Threads awaiting a reply") === true,
    "the diagnostics report never opened",
  );
  const report = vscode.window.activeTextEditor!.document.getText();
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  const match = /Threads awaiting a reply: (\d+)/.exec(report);
  assert.ok(match, report);
  return Number(match[1]);
}

posixSuite("Send mode resolution and the other ways into Send", () => {
  const f = sendFixture("ask");

  suiteSetup(async function () {
    await activateExtension();
    if (!hasShellEvents()) this.skip();
  });

  test("a mode that delivered is remembered, so the next Send does not ask", async () => {
    const a = f.file("a.txt");
    const cat = await runningCat("cat-a", a);
    const { picks } = f.dialogs({ choose: pickMode("terminal") });

    assert.strictEqual(await sendAll(f.uri()), "delivered");
    const afterFirst = await settled(cat, a);
    assert.strictEqual(picks.length, 1);

    assert.strictEqual(await sendAll(f.uri()), "delivered");

    assert.strictEqual(picks.length, 1, "the picker came back although the mode was remembered");
    assert.ok(occurrences(await settled(cat, a), FIXTURE) > occurrences(afterFirst, FIXTURE));
  });

  test("a mode whose Send was cancelled is not remembered, so the next Send asks again", async () => {
    await idleTerminal("idle-a");
    const { picks, messages } = f.dialogs({ choose: pickMode("terminal") });

    assert.strictEqual(await sendAll(f.uri()), "cancelled");
    assert.strictEqual(await sendAll(f.uri()), "cancelled");

    assert.strictEqual(picks.length, 2);
    assert.deepStrictEqual(messages, [IDLE_MESSAGE, IDLE_MESSAGE]);
  });

  test("clipboard picked and copied is remembered, so the next Send copies without asking", async () => {
    const { picks } = f.dialogs({ choose: pickMode("clipboard") });

    assert.strictEqual(await sendAll(f.uri()), "copied");
    assert.ok((await vscode.env.clipboard.readText()).includes(FIXTURE));
    await vscode.env.clipboard.writeText(SENTINEL);

    assert.strictEqual(await sendAll(f.uri()), "copied");

    assert.strictEqual(picks.length, 1, "the picker came back although clipboard was remembered");
    assert.ok((await vscode.env.clipboard.readText()).includes(FIXTURE));
  });

  test("Reset Send Mode makes the next Send ask again", async () => {
    await runningCat("cat-a", f.file("a.txt"));
    const { picks } = f.dialogs({ choose: pickMode("terminal") });
    assert.strictEqual(await sendAll(f.uri()), "delivered");
    assert.strictEqual(await sendAll(f.uri()), "delivered");
    assert.strictEqual(picks.length, 1);

    await resetRememberedMode();
    assert.strictEqual(await sendAll(f.uri()), "delivered");

    assert.strictEqual(picks.length, 2);
  });

  test("dismissing the mode picker cancels without writing or copying", async () => {
    const a = f.file("a.txt");
    const cat = await runningCat("cat-a", a);
    const { picks } = f.dialogs();

    assert.strictEqual(await sendAll(f.uri()), "cancelled");

    assert.strictEqual(picks.length, 1);
    assert.strictEqual(await settled(cat, a), "");
    assert.strictEqual(await vscode.env.clipboard.readText(), SENTINEL);
  });

  test("sending one thread puts only that thread in the prompt", async () => {
    await f.setMode("terminal");
    const a = f.file("a.txt");
    const cat = await runningCat("cat-a", a);
    f.dialogs();
    const doc = await vscode.workspace.openTextDocument(f.uri());
    const thread = parse(doc.getText()).threads.find((t) => t.quote === SECOND_QUOTE)!;

    const outcome = await vscode.commands.executeCommand("markdownCollab.sendThreadToClaude", f.uri(), thread.id);

    assert.strictEqual(outcome, "delivered");
    const text = await settled(cat, a);
    assert.ok(text.includes(SECOND_QUOTE) && text.includes(thread.id), text);
    assert.ok(!text.includes(FIRST_QUOTE), "the other thread leaked into the prompt");
  });

  test("a review request goes to the running terminal", async () => {
    await f.setMode("terminal");
    const a = f.file("a.txt");
    const cat = await runningCat("cat-a", a);
    const { messages } = f.dialogs();

    await vscode.commands.executeCommand("markdownCollab.askClaudeToReview", f.uri(), undefined, { focus: "" });

    const text = await settled(cat, a);
    assert.ok(text.includes("Review Mode") && text.includes(FIXTURE), text);
    assert.ok(messages.some((m) => m.includes(`Sent to "${cat.name}" for review`)), messages.join(" | "));
  });

  test("copying a thread marks it as waiting for a reply", async () => {
    await f.setMode("clipboard");
    f.dialogs();
    const doc = await vscode.workspace.openTextDocument(f.uri());
    const thread = parse(doc.getText()).threads.find((t) => t.quote === FIRST_QUOTE)!;
    const before = await threadsAwaitingReply();

    const outcome = await vscode.commands.executeCommand("markdownCollab.sendThreadToClaude", f.uri(), thread.id);

    assert.strictEqual(outcome, "copied");
    assert.strictEqual(await threadsAwaitingReply(), before + 1);
  });

  test("a Send that goes nowhere does not mark the thread as waiting", async () => {
    await idleTerminal("idle-a");
    f.dialogs();
    await f.setMode("terminal");
    const before = await threadsAwaitingReply();

    assert.strictEqual(await sendAll(f.uri()), "cancelled");

    assert.strictEqual(await threadsAwaitingReply(), before);
  });
});
