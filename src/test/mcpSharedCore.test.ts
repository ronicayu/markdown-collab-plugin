// Source-level guards for 10x-plan-2 P0.1's central rule: the `mdc` CLI and the
// MCP tools are two front ends over ONE implementation of each verb.
//
// Type-checking can't catch the failure this prevents. Both front ends compile
// perfectly if one of them grows its own `addThread(...)` call with slightly
// different rules — you'd only find out when the CLI accepted an edit the tools
// refused, on someone's document, months later.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { opList, opReply, opRewrite } from "../inlineComments/docOps";
import { addThread } from "../inlineComments/format";
import { renderMcpInstructions, renderSkill } from "../skillText";

const read = (rel: string): string => readFileSync(resolve(__dirname, "..", rel), "utf8");
const cli = read("skillCli/mdc.ts");
const tools = read("mcpServer/tools.ts");

/** The engine functions that actually mutate a document. */
const MUTATORS = [
  "addThread",
  "addSuggestion",
  "appendReply",
  "replaceThread",
  "acceptSuggestion",
  "rejectSuggestion",
];

describe("one implementation per verb", () => {
  it("both front ends import their verbs from docOps", () => {
    for (const [name, source] of [
      ["mdc.ts", cli],
      ["tools.ts", tools],
    ] as const) {
      expect(source, `${name} should import the shared ops`).toMatch(
        /from "(\.\.\/)?inlineComments\/docOps"/,
      );
      for (const op of ["opReply", "opOpen", "opRewrite", "opEdit", "opSuggest", "opAccept", "opReject", "opList"]) {
        expect(source, `${name} should call ${op}`).toContain(op);
      }
    }
  });

  it("neither front end calls the format engine's mutators directly", () => {
    for (const [name, source] of [
      ["mdc.ts", cli],
      ["tools.ts", tools],
    ] as const) {
      for (const fn of MUTATORS) {
        expect(source, `${name} must not call ${fn} itself — use the shared op`).not.toMatch(
          new RegExp(`\\b${fn}\\s*\\(`),
        );
      }
    }
  });

  it("the shared ops are where the integrity gate lives", () => {
    const ops = read("inlineComments/docOps.ts");
    // Every mutating op must run the pre-write check. Count the calls rather
    // than trusting one to be in the right place.
    const gates = ops.match(/assertNoNewIssues\(/g) ?? [];
    // One definition + one call per mutating verb (reply, rewrite, edit, open,
    // resolve, suggest, accept, reject).
    expect(gates.length).toBeGreaterThanOrEqual(9);
  });
});

describe("the skill and the server agree on the tool names", () => {
  // The skill is prose; the catalog is code. A rename on either side leaves the
  // other telling Claude to call something that doesn't exist — and the failure
  // mode is Claude quietly falling back to hand-editing markers. Checked on
  // every rendering, since each is read by a different kind of session.
  const renderings = {
    legacy: renderSkill("legacy"),
    plugin: renderSkill("plugin"),
    headless: renderSkill("headless"),
  };
  const advertised = read("mcpServer/tools.ts")
    .match(/name: "(mc_[a-z_]+)"/g)!
    .map((m) => m.slice(7, -1));

  it("every advertised tool is named in every rendering of the skill", () => {
    expect(advertised.length).toBeGreaterThanOrEqual(10);
    for (const [target, skill] of Object.entries(renderings)) {
      // mc_help *returns* the skill, so the skill has no reason to name it;
      // the MCP instructions are where a client learns it exists.
      for (const tool of advertised.filter((t) => t !== "mc_help")) {
        expect(skill, `the ${target} skill should document ${tool}`).toContain(tool);
      }
    }
    expect(renderMcpInstructions()).toContain("mc_help");
  });

  it("no rendering invents a tool the server doesn't expose", () => {
    const tools = read("mcpServer/tools.ts");
    for (const text of [...Object.values(renderings), renderMcpInstructions()]) {
      for (const tool of new Set(text.match(/\bmc_[a-z_]+\b/g) ?? [])) {
        expect(tools, `the server should expose ${tool}`).toContain(`name: "${tool}"`);
      }
    }
  });
});

describe("the MCP write path goes through the editor", () => {
  const host = read("mcpServer/index.ts");
  // Scoped to applyDocumentEdit itself, not the whole file (security review
  // L1/L2/L5): the file also uses Node's `fs/promises` directly now, for
  // `resolveWorkspaceFile`'s symlink-realpath check and the tool-server
  // descriptor's 0600 permissions and symlink refusal — none of that is a
  // *document* write, and `vscode.workspace.fs` exposes neither `realpath`
  // nor file permissions nor `lstat`, so there is no way to implement those
  // checks without Node's fs somewhere in this file. What must never touch it
  // is the document edit path specifically.
  const applyDocumentEditFn = host.slice(
    host.indexOf("async function applyDocumentEdit("),
    host.indexOf("\n}\n", host.indexOf("async function applyDocumentEdit(")),
  );

  // The whole point of hosting the server in the extension. A raw write here
  // would type-check, pass every unit test, and quietly restore all three of
  // the problems P0.1 exists to fix (races the buffer, no undo, checked late).
  // The undo half can only be observed in a host that delivers the undo
  // command, so this is the deterministic half of that assertion.
  it("applies a WorkspaceEdit and saves, rather than writing the file", () => {
    expect(applyDocumentEditFn.length).toBeGreaterThan(0);
    expect(applyDocumentEditFn).toMatch(/new vscode\.WorkspaceEdit\(\)/);
    expect(applyDocumentEditFn).toMatch(/vscode\.workspace\.applyEdit\(/);
    expect(applyDocumentEditFn).toMatch(/\.save\(\)/);
    expect(applyDocumentEditFn).not.toMatch(/writeFileSync|fs\.promises\.writeFile|fs\/promises/);
  });

  // The narrowing above must not become a hole: the tools' document writer is
  // applyDocumentEdit, and the file's only raw writes are the descriptor and
  // the `.markdown-collab/.gitignore` beside it — a third would be new and has
  // to be looked at.
  it("routes every tool document write through applyDocumentEdit, and writes nothing else raw", () => {
    expect(host).toMatch(/writeDoc:\s*async\s*\([^)]*\)\s*=>\s*applyDocumentEdit\(/);
    expect(host).not.toMatch(/writeFileSync|fs\.promises\.writeFile/);
    const rawWrites = host.match(/fsp\.writeFile\(/g) ?? [];
    expect(rawWrites).toHaveLength(2);
    expect(host).toMatch(/fsp\.writeFile\(gitignore,/);
    expect(host).toMatch(/fsp\.writeFile\(filePath, body, \{[^}]*mode: 0o600/);
  });

  it("narrows the rewrite to the span that changed", () => {
    // A whole-file replacement would land as "everything changed" in the undo
    // stack and in every watcher.
    expect(host).toMatch(/minimalEdit\(/);
  });

  it("keeps the tool surface off arbitrary paths", () => {
    expect(host).toMatch(/isInsideRoot\(/);
    expect(host).toMatch(/file_not_found/);
  });
});

describe("the gate actually refuses", () => {
  const doc = "# T\n\nsome anchored words here\n";
  const seeded = addThread(doc, doc.indexOf("anchored words"), doc.indexOf("anchored words") + 14, {
    author: "ronica",
    body: "?",
    ts: "2026-07-01T00:00:00.000Z",
  });

  it("a mutation that would introduce an integrity problem throws before returning", () => {
    // Replacement text carrying a lone open marker leaves an unpaired anchor in
    // the prose — the exact damage the marker-surgery instructions warned about.
    expect(() => opRewrite(seeded.source, seeded.thread.id, "words <!--mc:a:zzzzz--> more")).toThrow(
      /integrity problem/,
    );
    // …and the source it was given is untouched, because ops are pure: there is
    // no half-applied state for a caller to write out by mistake.
    expect(opList(seeded.source).threads[0]!.quote).toBe("anchored words");
  });

  it("a marker inside a comment body is safe, and is not refused", () => {
    // Thread JSON escapes `<` and `>`, so quoting a marker in a reply can't
    // terminate the HTML comment. Refusing it would block Claude from ever
    // explaining the format to the human.
    const { next } = opReply(seeded.source, seeded.thread.id, "the `<!--mc:a:ID-->` marker pairs with `/a`");
    expect(opList(next).threads[0]!.comments).toHaveLength(2);
  });
});
