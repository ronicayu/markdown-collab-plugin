import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  sidecarPathFor,
  mdPathForSidecar,
  validateSidecar,
  generateUniqueCommentId,
  saveSidecar,
  loadSidecar,
  addComment,
  addReply,
  setResolved,
  deleteComment,
  editCommentBody,
  editReplyBody,
  wasSelfWrite,
  __resetSelfWriteTokens,
} from "../sidecar";
import type { Sidecar } from "../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validSidecar(): Sidecar {
  return {
    version: 1,
    file: "docs/guide.md",
    comments: [
      {
        id: "c_abcdef12",
        anchor: { text: "hello world", contextBefore: "before", contextAfter: "after" },
        body: "please rewrite",
        author: "user",
        createdAt: "2026-04-18T10:00:00Z",
        resolved: false,
        replies: [
          { author: "ai", body: "done", createdAt: "2026-04-18T10:05:00Z" },
        ],
      },
    ],
  };
}

describe("sidecarPathFor", () => {
  it("maps a file at the workspace root to .markdown-collab/<name>.md.json", () => {
    const workspace = path.resolve("/tmp/ws");
    const md = path.resolve("/tmp/ws/README.md");
    expect(sidecarPathFor(md, workspace)).toBe(
      path.join(workspace, ".markdown-collab", "README.md.json"),
    );
  });

  it("preserves nested subdirectory structure under .markdown-collab/", () => {
    const workspace = path.resolve("/tmp/ws");
    const md = path.resolve("/tmp/ws/docs/guide/chapter.md");
    expect(sidecarPathFor(md, workspace)).toBe(
      path.join(workspace, ".markdown-collab", "docs", "guide", "chapter.md.json"),
    );
  });

  it("returns null when md path is outside the workspace root", () => {
    const workspace = path.resolve("/tmp/ws");
    const md = path.resolve("/tmp/other/README.md");
    expect(sidecarPathFor(md, workspace)).toBeNull();
  });

  it("returns null when md path is a sibling that shares a prefix but is not inside", () => {
    const workspace = path.resolve("/tmp/ws");
    const md = path.resolve("/tmp/ws-other/README.md");
    expect(sidecarPathFor(md, workspace)).toBeNull();
  });
});

describe("validateSidecar", () => {
  it("accepts a well-formed sidecar", () => {
    const res = validateSidecar(validSidecar());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.file).toBe("docs/guide.md");
  });

  it("rejects non-object input", () => {
    expect(validateSidecar(null).ok).toBe(false);
    expect(validateSidecar(42).ok).toBe(false);
    expect(validateSidecar("str").ok).toBe(false);
    expect(validateSidecar([]).ok).toBe(false);
  });

  it("rejects missing version", () => {
    const s: any = validSidecar();
    delete s.version;
    const res = validateSidecar(s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/version/);
  });

  it("rejects non-integer version", () => {
    const s: any = validSidecar();
    s.version = 1.5;
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("rejects version < 1", () => {
    const s: any = validSidecar();
    s.version = 0;
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("rejects non-string file", () => {
    const s: any = validSidecar();
    s.file = 123;
    const res = validateSidecar(s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/file/);
  });

  it("rejects absolute file path", () => {
    const s: any = validSidecar();
    s.file = "/etc/passwd";
    const res = validateSidecar(s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/file/i);
    if (!res.ok) expect(res.error).toMatch(/relative|path/i);
  });

  it("rejects file path with parent-directory traversal", () => {
    const s: any = validSidecar();
    s.file = "../escape.md";
    const res = validateSidecar(s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/\.\./);
  });

  it("accepts a plain relative file path", () => {
    const s: any = validSidecar();
    s.file = "docs/guide.md";
    expect(validateSidecar(s).ok).toBe(true);
  });

  it("accepts a Windows-style backslash-separated relative path", () => {
    const s: any = validSidecar();
    s.file = "docs\\guide.md";
    expect(validateSidecar(s).ok).toBe(true);
  });

  it("rejects non-array comments", () => {
    const s: any = validSidecar();
    s.comments = {};
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("rejects comment with malformed id", () => {
    const s: any = validSidecar();
    s.comments[0].id = "bad_id";
    const res = validateSidecar(s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/id/);
  });

  it("rejects comment with missing anchor fields", () => {
    const s: any = validSidecar();
    delete s.comments[0].anchor.contextBefore;
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("rejects comment with non-boolean resolved", () => {
    const s: any = validSidecar();
    s.comments[0].resolved = "no";
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("rejects reply with missing body", () => {
    const s: any = validSidecar();
    delete s.comments[0].replies[0].body;
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("rejects non-array replies", () => {
    const s: any = validSidecar();
    s.comments[0].replies = "none";
    expect(validateSidecar(s).ok).toBe(false);
  });

  it("accepts a non-standard author string", () => {
    const s: any = validSidecar();
    s.comments[0].author = "bot-42";
    expect(validateSidecar(s).ok).toBe(true);
  });
});

describe("generateUniqueCommentId", () => {
  it("returns a string matching the c_<8 hex> format", () => {
    const id = generateUniqueCommentId([]);
    expect(id).toMatch(/^c_[0-9a-f]{8}$/);
  });

  it("does not collide with existing ids", () => {
    // Pre-generate 50 ids so any single call is unlikely to collide by chance;
    // then check that no generated id appears in a forbidden set.
    const existing: { id: string }[] = [];
    for (let i = 0; i < 50; i++) existing.push({ id: generateUniqueCommentId(existing) });
    const ids = new Set(existing.map((c) => c.id));
    expect(ids.size).toBe(50);
  });

  it("never returns an id that is in 'existing'", () => {
    const existing = Array.from({ length: 3 }, (_, i) => ({
      id: `c_0000000${i}`,
    }));
    for (let i = 0; i < 20; i++) {
      const id = generateUniqueCommentId(existing);
      expect(existing.some((e) => e.id === id)).toBe(false);
    }
  });

  it("throws after 5 collisions", async () => {
    // Reset module cache and mock crypto.randomBytes so every draw yields the same
    // bytes; seed 'existing' with that id so all 5 attempts collide.
    vi.resetModules();
    vi.doMock("crypto", async () => {
      const actual = await vi.importActual<typeof import("crypto")>("crypto");
      return {
        ...actual,
        default: actual,
        randomBytes: () => Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      };
    });
    const fresh = await import("../sidecar");
    try {
      expect(() =>
        fresh.generateUniqueCommentId([{ id: "c_deadbeef" }]),
      ).toThrow(/collision/);
    } finally {
      vi.doUnmock("crypto");
      vi.resetModules();
    }
  });
});

describe("saveSidecar + loadSidecar round-trip", () => {
  it("writes and reads back an identical object", async () => {
    const target = path.join(tmpDir, ".markdown-collab", "docs", "a.md.json");
    const s = validSidecar();
    await saveSidecar(target, s);
    const result = await loadSidecar(target);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.mode).toBe("ok");
      expect(result.sidecar).toEqual(s);
    }
  });

  it("creates parent directories recursively", async () => {
    const target = path.join(tmpDir, "deep", "nested", "dirs", "x.md.json");
    await saveSidecar(target, validSidecar());
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });

  it("leaves no .tmp file behind on success", async () => {
    const target = path.join(tmpDir, "x.md.json");
    await saveSidecar(target, validSidecar());
    const entries = await fs.readdir(tmpDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });
});

describe("loadSidecar", () => {
  it("returns null for a missing file with no error logged", async () => {
    const onError = vi.fn();
    const result = await loadSidecar(path.join(tmpDir, "missing.json"), onError);
    expect(result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns null and logs for malformed JSON", async () => {
    const target = path.join(tmpDir, "bad.json");
    await fs.writeFile(target, "{not json", "utf8");
    const onError = vi.fn();
    const result = await loadSidecar(target, onError);
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0][0])).toMatch(/parse|json/i);
  });

  it("returns null and logs on schema violation", async () => {
    const target = path.join(tmpDir, "schema.json");
    await fs.writeFile(
      target,
      JSON.stringify({ version: 1, file: 123, comments: [] }),
      "utf8",
    );
    const onError = vi.fn();
    const result = await loadSidecar(target, onError);
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns mode 'read-only-unknown-version' for version > CURRENT", async () => {
    const target = path.join(tmpDir, "future.json");
    const future: any = validSidecar();
    future.version = 2;
    await fs.writeFile(target, JSON.stringify(future), "utf8");
    const result = await loadSidecar(target);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.mode).toBe("read-only-unknown-version");
      expect(result.sidecar.version).toBe(2);
    }
  });
});

describe("addComment", () => {
  it("creates a new sidecar file with an assigned id and appends the comment", async () => {
    const target = path.join(tmpDir, ".markdown-collab", "docs", "a.md.json");
    const comment = await addComment(target, "docs/a.md", {
      anchor: { text: "hello world", contextBefore: "b", contextAfter: "a" },
      body: "body",
      author: "user",
      createdAt: "2026-04-18T10:00:00Z",
    });
    expect(comment.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(comment.resolved).toBe(false);
    expect(comment.replies).toEqual([]);
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.file).toBe("docs/a.md");
    expect(loaded?.sidecar.comments).toHaveLength(1);
    expect(loaded?.sidecar.comments[0].id).toBe(comment.id);
  });

  it("appends to an existing sidecar", async () => {
    const target = path.join(tmpDir, "s.md.json");
    await saveSidecar(target, validSidecar());
    const c = await addComment(target, "docs/guide.md", {
      anchor: { text: "second", contextBefore: "", contextAfter: "" },
      body: "second comment",
      author: "user",
      createdAt: "2026-04-18T11:00:00Z",
    });
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments).toHaveLength(2);
    expect(loaded?.sidecar.comments[1].id).toBe(c.id);
  });

  it("throws when sidecar has unknown future version", async () => {
    const target = path.join(tmpDir, "future.md.json");
    const future: any = validSidecar();
    future.version = 2;
    await fs.writeFile(target, JSON.stringify(future), "utf8");
    await expect(
      addComment(target, "docs/guide.md", {
        anchor: { text: "x", contextBefore: "", contextAfter: "" },
        body: "nope",
        author: "user",
        createdAt: "2026-04-18T10:00:00Z",
      }),
    ).rejects.toThrow(/read-only|unknown/i);
  });
});

describe("addReply", () => {
  it("appends a reply to the identified comment", async () => {
    const target = path.join(tmpDir, "s.md.json");
    await saveSidecar(target, validSidecar());
    await addReply(target, "c_abcdef12", {
      author: "ai",
      body: "got it",
      createdAt: "2026-04-18T12:00:00Z",
    });
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments[0].replies).toHaveLength(2);
    expect(loaded?.sidecar.comments[0].replies[1].body).toBe("got it");
  });

  it("returns the updated Comment with the new reply appended", async () => {
    const target = path.join(tmpDir, "s.md.json");
    await saveSidecar(target, validSidecar());
    const result = await addReply(target, "c_abcdef12", {
      author: "ai",
      body: "returned reply",
      createdAt: "2026-04-18T13:00:00Z",
    });
    expect(result.id).toBe("c_abcdef12");
    expect(result.replies).toHaveLength(2);
    expect(result.replies[1].body).toBe("returned reply");
    expect(result.replies[1].author).toBe("ai");
  });

  it("throws when the comment id is unknown", async () => {
    const target = path.join(tmpDir, "s.md.json");
    await saveSidecar(target, validSidecar());
    await expect(
      addReply(target, "c_00000000", {
        author: "ai",
        body: "x",
        createdAt: "2026-04-18T12:00:00Z",
      }),
    ).rejects.toThrow(/not found|unknown/i);
  });

  it("throws on unknown future version sidecar", async () => {
    const target = path.join(tmpDir, "future.md.json");
    const future: any = validSidecar();
    future.version = 2;
    await fs.writeFile(target, JSON.stringify(future), "utf8");
    await expect(
      addReply(target, "c_abcdef12", {
        author: "ai",
        body: "x",
        createdAt: "2026-04-18T12:00:00Z",
      }),
    ).rejects.toThrow(/read-only|unknown/i);
  });
});

describe("setResolved", () => {
  it("toggles resolved true then false", async () => {
    const target = path.join(tmpDir, "s.md.json");
    await saveSidecar(target, validSidecar());
    await setResolved(target, "c_abcdef12", true);
    let loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments[0].resolved).toBe(true);
    await setResolved(target, "c_abcdef12", false);
    loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments[0].resolved).toBe(false);
  });

  it("throws when comment id is unknown", async () => {
    const target = path.join(tmpDir, "s.md.json");
    await saveSidecar(target, validSidecar());
    await expect(setResolved(target, "c_00000000", true)).rejects.toThrow(
      /not found|unknown/i,
    );
  });
});

describe("mdPathForSidecar", () => {
  it("is the inverse of sidecarPathFor for a file at the workspace root", () => {
    const workspace = path.resolve("/tmp/ws");
    const md = path.resolve("/tmp/ws/README.md");
    const sidecar = sidecarPathFor(md, workspace);
    expect(sidecar).not.toBeNull();
    expect(mdPathForSidecar(sidecar!, workspace)).toBe(md);
  });

  it("is the inverse of sidecarPathFor for a nested file", () => {
    const workspace = path.resolve("/tmp/ws");
    const md = path.resolve("/tmp/ws/docs/guide/chapter.md");
    const sidecar = sidecarPathFor(md, workspace);
    expect(sidecar).not.toBeNull();
    expect(mdPathForSidecar(sidecar!, workspace)).toBe(md);
  });

  it("returns null when the sidecar isn't under <ws>/.markdown-collab/", () => {
    const workspace = path.resolve("/tmp/ws");
    const stray = path.resolve("/tmp/other/README.md.json");
    expect(mdPathForSidecar(stray, workspace)).toBeNull();
  });

  it("returns null when the path doesn't end in .json", () => {
    const workspace = path.resolve("/tmp/ws");
    const noExt = path.join(workspace, ".markdown-collab", "README.md");
    expect(mdPathForSidecar(noExt, workspace)).toBeNull();
  });
});

describe("wasSelfWrite / self-write hash tokens", () => {
  beforeEach(() => {
    __resetSelfWriteTokens();
  });

  it("returns true immediately after saveSidecar writes a file", async () => {
    const target = path.join(tmpDir, "self.md.json");
    await saveSidecar(target, validSidecar());
    expect(await wasSelfWrite(target)).toBe(true);
  });

  it("returns FALSE when saveSidecar is called with trackSelfWrite=false (collab editor path)", async () => {
    // Regression guard: the collab editor's add/reply/resolve/delete
    // handlers pass trackSelfWrite=false because they need the standard
    // editor's CommentController to actually reload after the write.
    // Without the opt-out the controller's SidecarWatcher treats the
    // write as an echo and skips reload — symptom users see is "I added
    // a comment in the collab editor but it doesn't show up in VS
    // Code's gutter".
    const target = path.join(tmpDir, "no-track.md.json");
    await saveSidecar(target, validSidecar(), { trackSelfWrite: false });
    expect(await wasSelfWrite(target)).toBe(false);
  });

  it("consumes the token on match — a second call returns false", async () => {
    const target = path.join(tmpDir, "self2.md.json");
    await saveSidecar(target, validSidecar());
    expect(await wasSelfWrite(target)).toBe(true);
    expect(await wasSelfWrite(target)).toBe(false);
  });

  it("returns false when the file was tampered with post-save", async () => {
    const target = path.join(tmpDir, "tamper.md.json");
    await saveSidecar(target, validSidecar());
    // Overwrite with different bytes (simulates an external edit).
    const currentRaw = await fs.readFile(target, "utf8");
    await fs.writeFile(target, currentRaw + "\n// tampered", "utf8");
    expect(await wasSelfWrite(target)).toBe(false);
  });

  it("returns false when the sidecar file can't be read", async () => {
    expect(await wasSelfWrite(path.join(tmpDir, "does-not-exist.md.json"))).toBe(false);
  });

  it("expires the token after the 2s TTL window", async () => {
    vi.useFakeTimers();
    try {
      const target = path.join(tmpDir, "expire.md.json");
      await saveSidecar(target, validSidecar());
      // Advance past the 2000ms TTL.
      vi.advanceTimersByTime(2001);
      expect(await wasSelfWrite(target)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("concurrent mutations on the same path", () => {
  it("does not lose writes when addComment is invoked concurrently", async () => {
    const target = path.join(tmpDir, "concurrent.md.json");
    const N = 10;
    const calls = Array.from({ length: N }, (_, i) =>
      addComment(target, "docs/a.md", {
        anchor: { text: `anchor-${i}`, contextBefore: "", contextAfter: "" },
        body: `body-${i}`,
        author: "user",
        createdAt: `2026-04-18T10:00:${String(i).padStart(2, "0")}Z`,
      }),
    );
    const results = await Promise.all(calls);
    expect(new Set(results.map((c) => c.id)).size).toBe(N);
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments).toHaveLength(N);
    const bodies = new Set(loaded?.sidecar.comments.map((c) => c.body));
    for (let i = 0; i < N; i++) expect(bodies.has(`body-${i}`)).toBe(true);
  });

  it("does not lose replies when addReply is invoked concurrently on the same commentId", async () => {
    const target = path.join(tmpDir, "concurrent-replies.md.json");
    // Start with a sidecar that already contains a single comment to reply to.
    await saveSidecar(target, validSidecar());
    const N = 10;
    const calls = Array.from({ length: N }, (_, i) =>
      addReply(target, "c_abcdef12", {
        author: "user",
        body: `reply-${i}`,
        createdAt: `2026-04-18T13:00:${String(i).padStart(2, "0")}Z`,
      }),
    );
    await Promise.all(calls);
    const loaded = await loadSidecar(target);
    expect(loaded).not.toBeNull();
    // The initial sidecar already has one reply; the N concurrent adds must all land.
    const replies = loaded!.sidecar.comments[0].replies;
    expect(replies).toHaveLength(1 + N);
    const bodies = new Set(replies.map((r) => r.body));
    for (let i = 0; i < N; i++) expect(bodies.has(`reply-${i}`)).toBe(true);
  });
});

describe("deleteComment", () => {
  it("removes the matching comment and returns true", async () => {
    const target = path.join(tmpDir, "del.md.json");
    await saveSidecar(target, validSidecar());
    const result = await deleteComment(target, "c_abcdef12");
    expect(result).toBe(true);
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments).toHaveLength(0);
  });

  it("returns false and does not rewrite when commentId is unknown", async () => {
    const target = path.join(tmpDir, "del-missing.md.json");
    await saveSidecar(target, validSidecar());
    const before = await fs.stat(target);
    await new Promise((r) => setTimeout(r, 20));
    const result = await deleteComment(target, "c_99999999");
    expect(result).toBe(false);
    const after = await fs.stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects writes against a read-only forward-version sidecar", async () => {
    const target = path.join(tmpDir, "del-future.md.json");
    const future: any = { ...validSidecar(), version: 99 };
    await fs.writeFile(target, JSON.stringify(future, null, 2), "utf8");
    await expect(deleteComment(target, "c_abcdef12")).rejects.toThrow(/unknown version/);
  });

  it("serializes concurrent deletes for the same id without corrupting JSON", async () => {
    const target = path.join(tmpDir, "del-concurrent.md.json");
    await saveSidecar(target, validSidecar());
    const N = 5;
    const calls = Array.from({ length: N }, () => deleteComment(target, "c_abcdef12"));
    const results = await Promise.all(calls);
    // First call wins; subsequent calls find nothing to delete.
    expect(results.filter((r) => r === true)).toHaveLength(1);
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments).toHaveLength(0);
  });
});

describe("editCommentBody", () => {
  it("updates the body and returns true", async () => {
    const target = path.join(tmpDir, "edit.md.json");
    await saveSidecar(target, validSidecar());
    const result = await editCommentBody(target, "c_abcdef12", "rewritten");
    expect(result).toBe(true);
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments[0].body).toBe("rewritten");
  });

  it("returns false and does not rewrite for an unknown id", async () => {
    const target = path.join(tmpDir, "edit-missing.md.json");
    await saveSidecar(target, validSidecar());
    const before = await fs.stat(target);
    await new Promise((r) => setTimeout(r, 20));
    const result = await editCommentBody(target, "c_99999999", "rewritten");
    expect(result).toBe(false);
    const after = await fs.stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("returns true and skips the write when the body is unchanged", async () => {
    const target = path.join(tmpDir, "edit-noop.md.json");
    await saveSidecar(target, validSidecar());
    __resetSelfWriteTokens();
    const before = await fs.stat(target);
    await new Promise((r) => setTimeout(r, 20));
    const result = await editCommentBody(
      target,
      "c_abcdef12",
      "please rewrite",
    );
    expect(result).toBe(true);
    const after = await fs.stat(target);
    // No write means no mtime bump and no self-write token consumed.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const consumed = await wasSelfWrite(target);
    expect(consumed).toBe(false);
  });

  it("rejects writes against a read-only forward-version sidecar", async () => {
    const target = path.join(tmpDir, "edit-future.md.json");
    const future: any = { ...validSidecar(), version: 99 };
    await fs.writeFile(target, JSON.stringify(future, null, 2), "utf8");
    await expect(
      editCommentBody(target, "c_abcdef12", "x"),
    ).rejects.toThrow(/unknown version/);
  });
});

describe("editReplyBody", () => {
  it("updates the indexed reply", async () => {
    const target = path.join(tmpDir, "edit-reply.md.json");
    await saveSidecar(target, validSidecar());
    const result = await editReplyBody(target, "c_abcdef12", 0, "updated");
    expect(result).toBe(true);
    const loaded = await loadSidecar(target);
    expect(loaded?.sidecar.comments[0].replies[0].body).toBe("updated");
  });

  it("returns false for an out-of-range replyIndex (negative)", async () => {
    const target = path.join(tmpDir, "edit-reply-neg.md.json");
    await saveSidecar(target, validSidecar());
    const result = await editReplyBody(target, "c_abcdef12", -1, "x");
    expect(result).toBe(false);
  });

  it("returns false for an out-of-range replyIndex (too large)", async () => {
    const target = path.join(tmpDir, "edit-reply-big.md.json");
    await saveSidecar(target, validSidecar());
    const result = await editReplyBody(target, "c_abcdef12", 99, "x");
    expect(result).toBe(false);
  });

  it("returns false for an unknown commentId", async () => {
    const target = path.join(tmpDir, "edit-reply-missing.md.json");
    await saveSidecar(target, validSidecar());
    const result = await editReplyBody(target, "c_99999999", 0, "x");
    expect(result).toBe(false);
  });

  it("returns true and skips the write when the reply body is unchanged", async () => {
    const target = path.join(tmpDir, "edit-reply-noop.md.json");
    await saveSidecar(target, validSidecar());
    const before = await fs.stat(target);
    await new Promise((r) => setTimeout(r, 20));
    const result = await editReplyBody(target, "c_abcdef12", 0, "done");
    expect(result).toBe(true);
    const after = await fs.stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
