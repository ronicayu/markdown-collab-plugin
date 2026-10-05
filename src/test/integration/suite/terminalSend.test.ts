import * as assert from "assert";
import * as vscode from "vscode";
import { terminalActivity } from "../../../transports/terminalTarget";
import {
  FIXTURE,
  IDLE_MESSAGE,
  NO_TERMINAL_MESSAGE,
  SENTINEL,
  activateExtension,
  hasShellEvents,
  idleTerminal,
  occurrences,
  openTerminal,
  posixSuite,
  received,
  runningCat,
  sendAll,
  sendFixture,
  settled,
  startsIn,
  waitFor,
} from "./sendHarness";

posixSuite("terminal Send into a real terminal", () => {
  const f = sendFixture("terminal");

  suiteSetup(async function () {
    await activateExtension();
    if (!hasShellEvents()) this.skip();
  });

  test("the prompt lands in the terminal where a program is running", async () => {
    await runningCat("send-probe", f.file("a.txt"));
    f.dialogs();

    assert.strictEqual(await sendAll(f.uri()), "delivered");

    await waitFor(
      async () => (await received(f.file("a.txt"))).includes(FIXTURE),
      "the prompt never reached the file cat was writing",
    );
  });

  test("an idle shell gets nothing", async () => {
    const terminal = await idleTerminal("send-probe");
    const started = startsIn(terminal);
    const { messages } = f.dialogs();
    try {
      assert.strictEqual(await sendAll(f.uri()), "cancelled");
      assert.deepStrictEqual(messages, [IDLE_MESSAGE]);

      await new Promise((r) => setTimeout(r, 2000));
      assert.strictEqual(started.count(), 0, "something was typed into the idle shell");
    } finally {
      started.dispose();
    }
  });

  test("an idle active terminal sends to the terminal the previous Send went to", async () => {
    const a = f.file("a.txt");
    const catA = await runningCat("cat-a", a);
    const { picks } = f.dialogs();
    assert.strictEqual(await sendAll(f.uri()), "delivered");
    const afterFirst = await settled(catA, a);
    assert.ok(afterFirst.includes(FIXTURE), "the first Send never reached terminal A");

    const catC = await runningCat("cat-c", f.file("c.txt"));
    await idleTerminal("idle-b");
    assert.strictEqual(await sendAll(f.uri()), "delivered");

    assert.strictEqual(picks.length, 0, "a terminal choice was offered although the last target is still running");
    assert.ok(occurrences(await settled(catA, a), FIXTURE) > occurrences(afterFirst, FIXTURE), "the second prompt never reached terminal A");
    assert.strictEqual(await settled(catC, f.file("c.txt")), "");
  });

  test("an idle active terminal sends to the one other terminal running a program", async () => {
    const a = f.file("a.txt");
    const catA = await runningCat("cat-a", a);
    await idleTerminal("idle-b");
    const { picks } = f.dialogs();

    assert.strictEqual(await sendAll(f.uri()), "delivered");

    assert.strictEqual(picks.length, 0);
    assert.ok((await settled(catA, a)).includes(FIXTURE));
  });

  test("with two running terminals the choice decides where the prompt goes", async () => {
    const [a, b] = [f.file("a.txt"), f.file("b.txt")];
    const catA = await runningCat("cat-a", a);
    const catB = await runningCat("cat-b", b);
    await idleTerminal("idle-c");
    const { picks } = f.dialogs({ choose: (items) => items.find((item) => item.label === catB.name) });

    assert.strictEqual(await sendAll(f.uri()), "delivered");

    assert.strictEqual(picks.length, 1);
    assert.deepStrictEqual(picks[0]!.map((item) => item.label).sort(), [catA.name, catB.name]);
    assert.ok(picks[0]!.find((item) => item.label === catA.name)!.description!.includes(a));
    assert.ok(picks[0]!.find((item) => item.label === catB.name)!.description!.includes(b));
    assert.ok((await settled(catB, b)).includes(FIXTURE));
    assert.strictEqual(await settled(catA, a), "");
  });

  test("dismissing the terminal choice cancels and writes to neither", async () => {
    const [a, b] = [f.file("a.txt"), f.file("b.txt")];
    const catA = await runningCat("cat-a", a);
    const catB = await runningCat("cat-b", b);
    await idleTerminal("idle-c");
    const { picks } = f.dialogs();

    assert.strictEqual(await sendAll(f.uri()), "cancelled");

    assert.strictEqual(picks.length, 1);
    assert.strictEqual(await settled(catA, a), "");
    assert.strictEqual(await settled(catB, b), "");
  });

  test("an unidentified shell asks first, and Copy instead copies the prompt", async function () {
    const terminal = await openTerminal();
    if (terminalActivity(undefined, terminal.name) !== "unknown") this.skip();
    const started = startsIn(terminal);
    const { messages } = f.dialogs({ reply: "Copy instead" });
    try {
      assert.strictEqual(await sendAll(f.uri()), "copied");
      assert.strictEqual(messages[0], `Send to terminal "${terminal.name}"? Markdown Collab can't tell what's running there.`);
      assert.ok((await vscode.env.clipboard.readText()).includes(FIXTURE));
      assert.strictEqual(started.count(), 0, "something was typed into the unidentified shell");
    } finally {
      started.dispose();
    }
  });

  test("an unidentified shell asks first, and dismissing cancels", async function () {
    const terminal = await openTerminal();
    if (terminalActivity(undefined, terminal.name) !== "unknown") this.skip();
    const started = startsIn(terminal);
    const { messages } = f.dialogs();
    try {
      assert.strictEqual(await sendAll(f.uri()), "cancelled");
      assert.strictEqual(messages[0], `Send to terminal "${terminal.name}"? Markdown Collab can't tell what's running there.`);
      assert.strictEqual(await vscode.env.clipboard.readText(), SENTINEL);
      assert.strictEqual(started.count(), 0, "something was typed into the unidentified shell");
    } finally {
      started.dispose();
    }
  });

  test("when every terminal is idle, Copy instead copies the prompt", async () => {
    await idleTerminal("idle-a");
    const { messages } = f.dialogs({ reply: "Copy instead" });

    assert.strictEqual(await sendAll(f.uri()), "copied");

    assert.strictEqual(messages[0], IDLE_MESSAGE);
    assert.ok((await vscode.env.clipboard.readText()).includes(FIXTURE));
  });

  test("with no terminal open the send says so, and dismissing cancels", async () => {
    const { messages } = f.dialogs();

    assert.strictEqual(await sendAll(f.uri()), "cancelled");

    assert.deepStrictEqual(messages, [NO_TERMINAL_MESSAGE]);
    assert.strictEqual(await vscode.env.clipboard.readText(), SENTINEL);
  });

  test("with no terminal open, Copy instead copies the prompt", async () => {
    const { messages } = f.dialogs({ reply: "Copy instead" });

    assert.strictEqual(await sendAll(f.uri()), "copied");

    assert.strictEqual(messages[0], NO_TERMINAL_MESSAGE);
    assert.ok((await vscode.env.clipboard.readText()).includes(FIXTURE));
  });

  test("a closed last target is forgotten", async () => {
    const a = f.file("a.txt");
    const catA = await runningCat("cat-a", a);
    f.dialogs();
    assert.strictEqual(await sendAll(f.uri()), "delivered");
    assert.ok((await settled(catA, a)).includes(FIXTURE));

    catA.dispose();
    await waitFor(() => vscode.window.terminals.length === 0, "terminal A never closed");
    const idle = await idleTerminal("idle-b");
    const started = startsIn(idle);
    const { messages } = f.dialogs();
    try {
      assert.strictEqual(await sendAll(f.uri()), "cancelled");
      assert.deepStrictEqual(messages, [IDLE_MESSAGE]);
      assert.strictEqual(started.count(), 0, "something was typed into the idle shell");
    } finally {
      started.dispose();
    }
  });
});
