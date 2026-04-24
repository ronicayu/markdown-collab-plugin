import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  CURRENT_SCHEMA_VERSION,
  type Anchor,
  type Author,
  type Comment,
  type Reply,
  type Sidecar,
} from "./types";

export type LoadResult =
  | { sidecar: Sidecar; mode: "ok" }
  | { sidecar: Sidecar; mode: "read-only-unknown-version" }
  | null;

export function sidecarPathFor(mdAbsPath: string, workspaceRoot: string): string | null {
  const rel = path.relative(workspaceRoot, mdAbsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return path.join(workspaceRoot, ".markdown-collab", rel + ".json");
}

/**
 * Inverse of `sidecarPathFor`: given an absolute path to a sidecar file like
 * `<ws>/.markdown-collab/docs/guide.md.json`, return the absolute path to the
 * .md file it describes (`<ws>/docs/guide.md`). Returns null if the sidecar
 * isn't nested under `<ws>/.markdown-collab/` or lacks the `.json` suffix.
 *
 * Used by the live sidecar watcher to map filesystem events back to the
 * corresponding markdown URIs so it can enqueue reloads or notify cache
 * invalidation consumers.
 */
export function mdPathForSidecar(
  sidecarAbsPath: string,
  workspaceRoot: string,
): string | null {
  const root = path.join(workspaceRoot, ".markdown-collab");
  const rel = path.relative(root, sidecarAbsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  if (!rel.endsWith(".json")) return null;
  const mdRel = rel.slice(0, -".json".length);
  if (mdRel.length === 0) return null;
  return path.join(workspaceRoot, mdRel);
}

type ValidationResult = { ok: true; value: Sidecar } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ID_RE = /^c_[0-9a-f]{8}$/;

/**
 * Reject paths we consider unsafe for a sidecar `file` field: empty strings,
 * absolute paths, Windows drive-letter paths, and any path containing a
 * parent-directory segment (`..`). Backslashes are accepted as legitimate
 * Windows-style separators. Returns an error string on failure, null on ok.
 */
function validateRelativePath(p: string): string | null {
  if (p.length === 0) return "must not be empty";
  if (p.startsWith("/") || p.startsWith("\\")) return "must be relative (no leading slash)";
  if (/^[A-Za-z]:[\\/]/.test(p)) return "must be relative (no drive letter)";
  // Split on BOTH separators so we catch ".." whichever convention was used.
  const segments = p.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === "..") return "must not contain '..' traversal";
  }
  return null;
}

export function validateSidecar(value: unknown): ValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: "sidecar must be an object" };
  }
  const v = value.version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: "version must be an integer >= 1" };
  }
  if (typeof value.file !== "string") {
    return { ok: false, error: "file must be a string" };
  }
  const fileErr = validateRelativePath(value.file);
  if (fileErr) {
    return { ok: false, error: `file: ${fileErr}` };
  }
  if (!Array.isArray(value.comments)) {
    return { ok: false, error: "comments must be an array" };
  }
  for (let i = 0; i < value.comments.length; i++) {
    const err = validateComment(value.comments[i], i);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: value as unknown as Sidecar };
}

function validateComment(c: unknown, i: number): string | null {
  if (!isPlainObject(c)) return `comment[${i}] must be an object`;
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) {
    return `comment[${i}].id must match /^c_[0-9a-f]{8}$/`;
  }
  if (!isPlainObject(c.anchor)) return `comment[${i}].anchor must be an object`;
  const a = c.anchor;
  if (typeof a.text !== "string") return `comment[${i}].anchor.text must be a string`;
  if (typeof a.contextBefore !== "string")
    return `comment[${i}].anchor.contextBefore must be a string`;
  if (typeof a.contextAfter !== "string")
    return `comment[${i}].anchor.contextAfter must be a string`;
  if (typeof c.body !== "string") return `comment[${i}].body must be a string`;
  if (typeof c.author !== "string") return `comment[${i}].author must be a string`;
  if (typeof c.createdAt !== "string") return `comment[${i}].createdAt must be a string`;
  if (typeof c.resolved !== "boolean") return `comment[${i}].resolved must be a boolean`;
  if (!Array.isArray(c.replies)) return `comment[${i}].replies must be an array`;
  for (let j = 0; j < c.replies.length; j++) {
    const r = c.replies[j];
    if (!isPlainObject(r)) return `comment[${i}].replies[${j}] must be an object`;
    if (typeof r.author !== "string")
      return `comment[${i}].replies[${j}].author must be a string`;
    if (typeof r.body !== "string")
      return `comment[${i}].replies[${j}].body must be a string`;
    if (typeof r.createdAt !== "string")
      return `comment[${i}].replies[${j}].createdAt must be a string`;
  }
  return null;
}

export async function loadSidecar(
  sidecarPath: string,
  onError?: (msg: string) => void,
): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(sidecarPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    onError?.(`Failed to read sidecar ${sidecarPath}: ${err.message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    onError?.(`Failed to parse sidecar JSON at ${sidecarPath}: ${(e as Error).message}`);
    return null;
  }
  const result = validateSidecar(parsed);
  if (!result.ok) {
    onError?.(`Sidecar schema validation failed at ${sidecarPath}: ${result.error}`);
    return null;
  }
  if (result.value.version > CURRENT_SCHEMA_VERSION) {
    return { sidecar: result.value, mode: "read-only-unknown-version" };
  }
  return { sidecar: result.value, mode: "ok" };
}

/**
 * Content hashes of files we've written very recently. The live sidecar
 * watcher consults this set to distinguish echoes of our own writes (which
 * we want to ignore) from genuine external mutations (which should trigger
 * a reload). Keyed by hash alone because the watcher may hand us a path
 * that differs cosmetically (case, trailing slash) from the one we wrote
 * to — the content fingerprint is the authoritative identity.
 */
const selfWriteHashes = new Set<string>();
const SELF_WRITE_TTL_MS = 2000;

function hashContents(contents: string): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

/**
 * Return true if the file at `sidecarPath` exactly matches a recent
 * `saveSidecar` output. On a positive match the hash is consumed — a
 * subsequent unrelated write with the same contents will not be suppressed.
 */
export async function wasSelfWrite(
  sidecarPath: string,
  fileContents?: string,
): Promise<boolean> {
  let contents = fileContents;
  if (contents === undefined) {
    try {
      contents = await fs.readFile(sidecarPath, "utf8");
    } catch {
      return false;
    }
  }
  const hash = hashContents(contents);
  if (selfWriteHashes.has(hash)) {
    selfWriteHashes.delete(hash);
    return true;
  }
  return false;
}

/** Test-only: drop any in-flight self-write hashes so cases don't bleed. */
export function __resetSelfWriteTokens(): void {
  selfWriteHashes.clear();
}

export async function saveSidecar(sidecarPath: string, sidecar: Sidecar): Promise<void> {
  const dir = path.dirname(sidecarPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${sidecarPath}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  const serialized = JSON.stringify(sidecar, null, 2);
  await fs.writeFile(tmpPath, serialized, "utf8");
  // Register the content hash just before the rename so the watcher event —
  // which can fire as early as the rename returns — finds it. We expire the
  // token after a short window so a genuine external write with coincidentally
  // identical bytes isn't suppressed indefinitely.
  const hash = hashContents(serialized);
  selfWriteHashes.add(hash);
  setTimeout(() => {
    selfWriteHashes.delete(hash);
  }, SELF_WRITE_TTL_MS).unref?.();
  try {
    await fs.rename(tmpPath, sidecarPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY") {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await fs.rename(tmpPath, sidecarPath);
      } catch (e2) {
        await fs.unlink(tmpPath).catch(() => {});
        throw e2;
      }
    } else {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

export function generateUniqueCommentId(existing: Pick<Comment, "id">[]): string {
  const taken = new Set(existing.map((c) => c.id));
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = "c_" + crypto.randomBytes(4).toString("hex");
    if (!taken.has(id)) return id;
  }
  throw new Error("comment id collision");
}

// Per-path promise queue: serialize load→mutate→save cycles so concurrent
// callers don't clobber one another. Each entry is the tail of a chain of
// Promises keyed by the sidecar's absolute path. A new caller awaits the
// current tail, then replaces it with its own work, and finally prunes the
// entry when the chain settles so the map doesn't grow unboundedly.
const pathQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = pathQueues.get(key) ?? Promise.resolve();
  // Chain unconditionally via a catch on `prev` so that prior failures don't
  // block subsequent writes, and so the queue promise itself never rejects
  // (keeping the in-map tail free of unhandled-rejection side-channels).
  const tail = prev.catch(() => undefined).then(work);
  // The stored tail must never surface an unhandled rejection: callers await
  // `tail` directly and handle errors themselves. For the queue bookkeeping
  // promise, swallow errors.
  const queueEntry: Promise<unknown> = tail.catch(() => undefined);
  pathQueues.set(key, queueEntry);
  // Floating cleanup is race-safe via the identity check: a later enqueue() can replace the map entry before this fires.
  queueEntry.then(() => {
    if (pathQueues.get(key) === queueEntry) pathQueues.delete(key);
  });
  return tail;
}

/**
 * Shared loader for mutation paths. Rejects read-only-unknown-version so that
 * writers never silently drop data on forward-incompatible sidecars. If the
 * file is missing, behavior depends on `createIfMissing`:
 *   - when provided: return a fresh empty sidecar with the given `file` field
 *     (used by addComment, which is the only creator).
 *   - when omitted: throw (used by addReply / setResolved, which require an
 *     existing comment to operate on).
 */
async function loadForMutation(
  sidecarPath: string,
  createIfMissing?: { file: string },
): Promise<Sidecar> {
  const loaded = await loadSidecar(sidecarPath);
  if (loaded === null) {
    if (createIfMissing) {
      return {
        version: CURRENT_SCHEMA_VERSION,
        file: createIfMissing.file,
        comments: [],
      };
    }
    throw new Error(`Sidecar not found at ${sidecarPath}`);
  }
  if (loaded.mode === "read-only-unknown-version") {
    throw new Error(
      `Sidecar at ${sidecarPath} has unknown version ${loaded.sidecar.version}; read-only.`,
    );
  }
  return loaded.sidecar;
}

export async function addComment(
  sidecarPath: string,
  mdRelPath: string,
  data: { anchor: Anchor; body: string; author: Author; createdAt: string },
): Promise<Comment> {
  return enqueue(sidecarPath, async () => {
    const sidecar = await loadForMutation(sidecarPath, { file: mdRelPath });
    const id = generateUniqueCommentId(sidecar.comments);
    const comment: Comment = {
      id,
      anchor: data.anchor,
      body: data.body,
      author: data.author,
      createdAt: data.createdAt,
      resolved: false,
      replies: [],
    };
    sidecar.comments.push(comment);
    await saveSidecar(sidecarPath, sidecar);
    return comment;
  });
}

export async function addReply(
  sidecarPath: string,
  commentId: string,
  reply: Reply,
): Promise<Comment> {
  return enqueue(sidecarPath, async () => {
    const sidecar = await loadForMutation(sidecarPath);
    const comment = sidecar.comments.find((c) => c.id === commentId);
    if (!comment) throw new Error(`Comment ${commentId} not found in ${sidecarPath}`);
    comment.replies.push(reply);
    await saveSidecar(sidecarPath, sidecar);
    return comment;
  });
}

export async function setResolved(
  sidecarPath: string,
  commentId: string,
  resolved: boolean,
): Promise<void> {
  return enqueue(sidecarPath, async () => {
    const sidecar = await loadForMutation(sidecarPath);
    const comment = sidecar.comments.find((c) => c.id === commentId);
    if (!comment) throw new Error(`Comment ${commentId} not found in ${sidecarPath}`);
    comment.resolved = resolved;
    await saveSidecar(sidecarPath, sidecar);
  });
}

export async function deleteComment(
  sidecarPath: string,
  commentId: string,
): Promise<boolean> {
  return enqueue(sidecarPath, async () => {
    const sidecar = await loadForMutation(sidecarPath);
    const before = sidecar.comments.length;
    sidecar.comments = sidecar.comments.filter((c) => c.id !== commentId);
    if (sidecar.comments.length === before) return false;
    await saveSidecar(sidecarPath, sidecar);
    return true;
  });
}
