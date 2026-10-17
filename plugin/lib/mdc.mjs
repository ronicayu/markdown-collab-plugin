#!/usr/bin/env node
// src/skillCli/mdc.ts
import { writeSync } from "node:fs";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import * as path3 from "node:path";

// src/inlineComments/staleness.ts
function hashAnchorText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function anchoredTextOf(parsed, threadId) {
  const a = parsed.anchors.get(threadId);
  if (!a) return null;
  return parsed.source.slice(a.openEnd, a.closeStart);
}
function isThreadStale(parsed, threadId) {
  const thread = parsed.threads.find((t) => t.id === threadId);
  if (!thread?.anchorHash) return false;
  const live = anchoredTextOf(parsed, threadId);
  if (live === null) return false;
  return hashAnchorText(live) !== thread.anchorHash;
}
function staleThreadIds(parsed) {
  return parsed.threads.filter((t) => isThreadStale(parsed, t.id)).map((t) => t.id);
}
function currentAnchorHash(parsed, threadId) {
  const live = anchoredTextOf(parsed, threadId);
  return live === null ? void 0 : hashAnchorText(live);
}
function withRefreshedAnchorHash(parsed, thread) {
  const hash = currentAnchorHash(parsed, thread.id);
  return hash === void 0 ? thread : { ...thread, anchorHash: hash };
}

// src/inlineComments/format.ts
function isWriteVia(v) {
  return v === "tools" || v === "cli";
}
var OPEN_RE = /<!--mc:a:([a-z0-9]{1,12})-->/g;
var CLOSE_RE = /<!--mc:\/a:([a-z0-9]{1,12})-->/g;
var THREADS_BEGIN = "<!--mc:threads:begin-->";
var THREADS_END = "<!--mc:threads:end-->";
var THREAD_LINE_RE = /<!--mc:t\s+(\{[\s\S]*?\})\s*-->/g;
var SUGGESTION_LINE_RE = /<!--mc:s\s+(\{[\s\S]*?\})\s*-->/g;
var CHECKPOINT_LINE_RE = /<!--mc:rev\s+(\{[\s\S]*?\})\s*-->/g;
function buildCodeMask(source) {
  const mask = new Uint8Array(source.length);
  const fenceLineRe = /^[ \t]{0,3}(```+|~~~+)[^\n]*$/gm;
  let fenceMatch;
  let inFence = false;
  let fenceMarker = "";
  let fenceStart = 0;
  while ((fenceMatch = fenceLineRe.exec(source)) !== null) {
    if (!inFence) {
      inFence = true;
      fenceMarker = fenceMatch[1];
      fenceStart = fenceMatch.index;
    } else if (fenceMatch[1].startsWith(fenceMarker[0]) && fenceMatch[1].length >= fenceMarker.length) {
      const fenceEnd = fenceMatch.index + fenceMatch[0].length;
      for (let i = fenceStart; i < fenceEnd; i++) mask[i] = 1;
      inFence = false;
      fenceMarker = "";
    }
  }
  if (inFence) {
    for (let i = fenceStart; i < source.length; i++) mask[i] = 1;
  }
  const tickRe = /`+/g;
  let tickMatch;
  const ticks = [];
  while ((tickMatch = tickRe.exec(source)) !== null) {
    const start = tickMatch.index;
    if (mask[start]) continue;
    ticks.push({ start, end: start + tickMatch[0].length, len: tickMatch[0].length });
  }
  const used = /* @__PURE__ */ new Set();
  for (let i = 0; i < ticks.length; i++) {
    if (used.has(i)) continue;
    const open = ticks[i];
    for (let j = i + 1; j < ticks.length; j++) {
      if (used.has(j)) continue;
      const close = ticks[j];
      if (close.len !== open.len) continue;
      for (let k = open.start; k < close.end; k++) mask[k] = 1;
      used.add(i);
      used.add(j);
      break;
    }
  }
  let lineStart = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      if (!mask[lineStart] && source.slice(lineStart, lineStart + 4) === "    ") {
        for (let k = lineStart; k < i; k++) mask[k] = 1;
      }
      lineStart = i + 1;
    }
  }
  return mask;
}
function isInCode(source, start, end) {
  const mask = buildCodeMask(source);
  const last = Math.max(start, Math.min(end, source.length) - 1);
  for (let i = Math.max(0, start); i <= last && i < source.length; i++) {
    if (mask[i]) return true;
  }
  return false;
}
function findMarkers(source, mask) {
  const markers = [];
  for (const [re, kind] of [
    [OPEN_RE, "open"],
    [CLOSE_RE, "close"]
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      if (mask[m.index]) continue;
      markers.push({ kind, id: m[1], start: m.index, end: m.index + m[0].length });
    }
  }
  markers.sort((a, b) => a.start - b.start);
  return markers;
}
function pairAnchors(markers) {
  const anchors = /* @__PURE__ */ new Map();
  const openByid = /* @__PURE__ */ new Map();
  const unpaired = [];
  for (const m of markers) {
    if (m.kind === "open") {
      if (openByid.has(m.id) || anchors.has(m.id)) {
        unpaired.push(m);
        continue;
      }
      openByid.set(m.id, m);
    } else {
      const open = openByid.get(m.id);
      if (!open) {
        unpaired.push(m);
        continue;
      }
      anchors.set(m.id, {
        openStart: open.start,
        openEnd: open.end,
        closeStart: m.start,
        closeEnd: m.end
      });
      openByid.delete(m.id);
    }
  }
  for (const m of openByid.values()) unpaired.push(m);
  return { anchors, unpaired };
}
function findThreadsRegion(source) {
  let mask = null;
  let from = source.length;
  for (; ; ) {
    const begin = source.lastIndexOf(THREADS_BEGIN, from);
    if (begin === -1) return null;
    const end = source.indexOf(THREADS_END, begin + THREADS_BEGIN.length);
    if (end !== -1) {
      const endAfter = end + THREADS_END.length;
      const region = {
        start: begin,
        end: endAfter,
        body: source.slice(begin + THREADS_BEGIN.length, end)
      };
      if (source.slice(endAfter).trim() === "") return region;
      mask ??= buildCodeMask(source);
      if (!mask[begin]) return region;
    }
    if (begin === 0) return null;
    from = begin - 1;
  }
}
function parseThreads(body, malformed) {
  const threads = [];
  let m;
  THREAD_LINE_RE.lastIndex = 0;
  while ((m = THREAD_LINE_RE.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (!obj || typeof obj.id !== "string") {
        malformed?.push({ raw: m[1], offset: m.index, reason: "missing-id" });
        continue;
      }
      threads.push({
        id: obj.id,
        quote: typeof obj.quote === "string" ? obj.quote : "",
        status: obj.status === "resolved" ? "resolved" : "open",
        resolvedBy: obj.resolvedBy,
        resolvedTs: obj.resolvedTs,
        comments: Array.isArray(obj.comments) ? obj.comments.filter(isValidComment).map(withKnownVia) : [],
        anchorHash: typeof obj.anchorHash === "string" ? obj.anchorHash : void 0
      });
    } catch {
      malformed?.push({ raw: m[1], offset: m.index, reason: "json-parse-error" });
    }
  }
  return threads;
}
function parseCheckpoint(body) {
  CHECKPOINT_LINE_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = CHECKPOINT_LINE_RE.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (typeof obj?.ts === "string" && typeof obj.contentHash === "string") {
        last = {
          ts: obj.ts,
          contentHash: obj.contentHash,
          gitRef: typeof obj.gitRef === "string" ? obj.gitRef : void 0,
          sections: Array.isArray(obj.sections) ? obj.sections.filter(
            (s) => !!s && typeof s.hash === "string" && (s.heading === null || typeof s.heading === "string")
          ) : void 0
        };
      }
    } catch {
    }
  }
  return last;
}
function parseSuggestions(body) {
  const suggestions = [];
  let m;
  SUGGESTION_LINE_RE.lastIndex = 0;
  while ((m = SUGGESTION_LINE_RE.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (!obj || typeof obj.anchorId !== "string" || typeof obj.original !== "string" || typeof obj.proposed !== "string") {
        continue;
      }
      suggestions.push({
        anchorId: obj.anchorId,
        threadId: typeof obj.threadId === "string" ? obj.threadId : void 0,
        author: typeof obj.author === "string" ? obj.author : "claude",
        // A thread's `comments` array is kept as the raw parsed objects, so any
        // field on them survives a round trip for free; a suggestion is rebuilt
        // field by field here. A field forgotten in this list is silently deleted
        // the next time the file is saved.
        agent: typeof obj.agent === "boolean" ? obj.agent : void 0,
        via: isWriteVia(obj.via) ? obj.via : void 0,
        ts: typeof obj.ts === "string" ? obj.ts : "",
        original: obj.original,
        proposed: obj.proposed,
        note: typeof obj.note === "string" ? obj.note : void 0
      });
    } catch {
    }
  }
  return suggestions;
}
function isValidComment(c) {
  if (!c || typeof c !== "object") return false;
  const o = c;
  return typeof o.id === "string" && typeof o.author === "string" && typeof o.ts === "string" && typeof o.body === "string";
}
function withKnownVia(c) {
  if (!("via" in c) || isWriteVia(c.via)) return c;
  const rest = { ...c };
  delete rest.via;
  return rest;
}
function findFrontmatter(source) {
  const offset = source.charCodeAt(0) === 65279 ? 1 : 0;
  const head = source.slice(offset, offset + 4);
  let fence = null;
  if (head.startsWith("---") && (head.length === 3 || head[3] === "\n" || head[3] === "\r")) {
    fence = "---";
  } else if (head.startsWith("+++") && (head.length === 3 || head[3] === "\n" || head[3] === "\r")) {
    fence = "+++";
  }
  if (!fence) return null;
  let cursor = offset + fence.length;
  if (source[cursor] === "\r") cursor++;
  if (source[cursor] === "\n") cursor++;
  else return null;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const realLineEnd = lineEnd === -1 ? source.length : lineEnd;
    let line = source.slice(cursor, realLineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const isClosing = fence === "---" && (line === "---" || line === "...") || fence === "+++" && line === "+++";
    if (isClosing) {
      const end = lineEnd === -1 ? source.length : lineEnd + 1;
      return { start: 0, end };
    }
    if (lineEnd === -1) return null;
    cursor = lineEnd + 1;
  }
  return null;
}
function parse(source) {
  const mask = buildCodeMask(source);
  const markers = findMarkers(source, mask);
  const { anchors } = pairAnchors(markers);
  const region = findThreadsRegion(source);
  const threads = region ? parseThreads(region.body) : [];
  const suggestions = region ? parseSuggestions(region.body) : [];
  const checkpoint = region ? parseCheckpoint(region.body) : null;
  const frontmatter = findFrontmatter(source);
  threads.sort((a, b) => {
    const ai = anchors.get(a.id)?.openStart ?? Number.POSITIVE_INFINITY;
    const bi = anchors.get(b.id)?.openStart ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });
  suggestions.sort((a, b) => {
    const ai = anchors.get(a.anchorId)?.openStart ?? Number.POSITIVE_INFINITY;
    const bi = anchors.get(b.anchorId)?.openStart ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });
  const unanchoredThreadIds = threads.filter((t) => !anchors.has(t.id)).map((t) => t.id);
  const unanchoredSuggestionIds = suggestions.filter((s) => !anchors.has(s.anchorId)).map((s) => s.anchorId);
  return {
    source,
    threads,
    suggestions,
    checkpoint,
    anchors,
    unanchoredThreadIds,
    unanchoredSuggestionIds,
    threadsRegion: region ? { start: region.start, end: region.end } : null,
    frontmatter
  };
}
function inspect(source) {
  const mask = buildCodeMask(source);
  const markers = findMarkers(source, mask);
  const { anchors, unpaired } = pairAnchors(markers);
  const region = findThreadsRegion(source);
  const malformedThreadLines = [];
  const threads = region ? parseThreads(region.body, malformedThreadLines) : [];
  const suggestions = region ? parseSuggestions(region.body) : [];
  const seen = /* @__PURE__ */ new Set();
  const duplicateThreadIds = [];
  for (const t of threads) {
    if (seen.has(t.id)) {
      if (!duplicateThreadIds.includes(t.id)) duplicateThreadIds.push(t.id);
    }
    seen.add(t.id);
  }
  const anchorOwners = new Set(seen);
  for (const s of suggestions) anchorOwners.add(s.anchorId);
  const orphanAnchorIds = [...anchors.keys()].filter((id) => !anchorOwners.has(id));
  return {
    parsed: parse(source),
    unpairedMarkers: unpaired.map((m) => ({ kind: m.kind, id: m.id, start: m.start, end: m.end })),
    malformedThreadLines,
    duplicateThreadIds,
    orphanAnchorIds
  };
}
function renderThreadsRegion(threads, suggestions = [], checkpoint = null) {
  if (threads.length === 0 && suggestions.length === 0 && !checkpoint) return "";
  const lines = [THREADS_BEGIN];
  for (const t of threads) {
    const obj = {
      id: t.id,
      quote: t.quote,
      status: t.status
    };
    if (t.resolvedBy) obj.resolvedBy = t.resolvedBy;
    if (t.resolvedTs) obj.resolvedTs = t.resolvedTs;
    if (t.anchorHash) obj.anchorHash = t.anchorHash;
    obj.comments = t.comments;
    lines.push(`<!--mc:t ${safeStringify(obj)}-->`);
  }
  for (const s of suggestions) {
    const obj = { anchorId: s.anchorId };
    if (s.threadId) obj.threadId = s.threadId;
    obj.author = s.author;
    if (s.agent) obj.agent = true;
    if (s.via) obj.via = s.via;
    obj.ts = s.ts;
    obj.original = s.original;
    obj.proposed = s.proposed;
    if (s.note) obj.note = s.note;
    lines.push(`<!--mc:s ${safeStringify(obj)}-->`);
  }
  if (checkpoint) {
    const obj = {
      ts: checkpoint.ts,
      contentHash: checkpoint.contentHash
    };
    if (checkpoint.gitRef) obj.gitRef = checkpoint.gitRef;
    if (checkpoint.sections) obj.sections = checkpoint.sections;
    lines.push(`<!--mc:rev ${safeStringify(obj)}-->`);
  }
  lines.push(THREADS_END);
  return lines.join("\n");
}
function safeStringify(obj) {
  return JSON.stringify(obj).replace(/-->/g, "--\\u003e").replace(/<!--/g, "\\u003c!--");
}
function withThreads(source, threads, suggestions, checkpoint) {
  const region = findThreadsRegion(source);
  const existing = parse(source);
  const keepSuggestions = suggestions ?? existing.suggestions;
  const keepCheckpoint = checkpoint === void 0 ? existing.checkpoint : checkpoint;
  const rendered = renderThreadsRegion(threads, keepSuggestions, keepCheckpoint);
  if (region) {
    const before = source.slice(0, region.start);
    const after = source.slice(region.end);
    if (rendered === "") {
      const head = before.replace(/\n+$/, "");
      const tail = after.replace(/^\n+/, "");
      const joiner = before.endsWith("\n") || after.startsWith("\n") ? "\n" : "";
      return head + joiner + tail;
    }
    return before + rendered + after;
  }
  if (rendered === "") return source;
  return `${source.replace(/\n+$/, "")}

${rendered}
`;
}
var ID_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyz";
function mintThreadId(existing) {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = "";
    for (let i = 0; i < 5; i++) {
      id += ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)];
    }
    if (!taken.has(id)) return id;
  }
  throw new Error("Could not mint a unique thread id after 50 attempts");
}
function startPastHeadingPrefix(text, start, limit) {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const lineEnd = text.indexOf("\n", lineStart);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const m = /^[ \t]{0,3}#{1,6}[ \t]+/.exec(line);
  if (!m) return start;
  const contentStart = lineStart + m[0].length;
  if (start >= contentStart) return start;
  return Math.min(contentStart, limit);
}
function addThread(source, selStart, selEnd, comment) {
  if (selEnd < selStart) throw new Error("selEnd must be >= selStart");
  selStart = startPastHeadingPrefix(source, selStart, selEnd);
  const parsed = parse(source);
  const id = mintThreadId(parsed.threads.map((t) => t.id));
  const quote = source.slice(selStart, selEnd).replace(OPEN_RE, "").replace(CLOSE_RE, "");
  const openMarker = `<!--mc:a:${id}-->`;
  const closeMarker = `<!--mc:/a:${id}-->`;
  const ts = comment.ts ?? (/* @__PURE__ */ new Date()).toISOString();
  const thread = {
    id,
    quote,
    status: "open",
    comments: [
      {
        id: "c1",
        author: comment.author,
        ...comment.agent ? { agent: true } : {},
        // Only when set, so a comment written without it serializes to exactly
        // the same bytes.
        ...comment.via ? { via: comment.via } : {},
        ts,
        body: comment.body
      }
    ],
    // The author is looking at this text right now, so it is the baseline the
    // "text changed since this comment" badge compares against.
    anchorHash: hashAnchorText(quote)
  };
  assertAnchorable(parsed, source, selStart, selEnd);
  const withMarkers = source.slice(0, selStart) + openMarker + source.slice(selStart, selEnd) + closeMarker + source.slice(selEnd);
  const nextThreads = [...parsed.threads, thread];
  return { source: withThreads(withMarkers, nextThreads), thread };
}
function assertAnchorable(parsed, source, selStart, selEnd) {
  if (parsed.threadsRegion) {
    if (selStart >= parsed.threadsRegion.start && selStart < parsed.threadsRegion.end) {
      throw new Error("Cannot anchor inside the threads region");
    }
    if (selEnd > parsed.threadsRegion.start && selEnd <= parsed.threadsRegion.end) {
      throw new Error("Cannot anchor inside the threads region");
    }
  }
  if (parsed.frontmatter) {
    if (selStart >= parsed.frontmatter.start && selStart < parsed.frontmatter.end) {
      throw new Error("Cannot anchor inside the frontmatter");
    }
    if (selEnd > parsed.frontmatter.start && selEnd <= parsed.frontmatter.end) {
      throw new Error("Cannot anchor inside the frontmatter");
    }
  }
  if (isInCode(source, selStart, selEnd)) {
    throw new Error("Cannot anchor inside a code block or code span");
  }
}
function replaceThread(source, id, next) {
  const parsed = parse(source);
  let nextThreads;
  if (next === null) {
    nextThreads = parsed.threads.filter((t) => t.id !== id);
  } else {
    if (next.id !== id) throw new Error("replaceThread: id mismatch");
    nextThreads = parsed.threads.map((t) => t.id === id ? next : t);
    if (!parsed.threads.some((t) => t.id === id)) nextThreads.push(next);
  }
  let body = source;
  if (next === null) {
    body = stripAnchorMarkers(body, id);
  }
  return withThreads(body, nextThreads);
}
function stripAnchorMarkers(source, id) {
  const open = `<!--mc:a:${id}-->`;
  const close = `<!--mc:/a:${id}-->`;
  return source.split(open).join("").split(close).join("");
}
function stripAllInlineMarkup(source) {
  const region = findThreadsRegion(source);
  const stripped = region ? source.slice(0, region.start).replace(/\n+$/, "\n") + source.slice(region.end) : source;
  return stripped.replace(OPEN_RE, "").replace(CLOSE_RE, "");
}
function appendReply(thread, reply) {
  const ts = reply.ts ?? (/* @__PURE__ */ new Date()).toISOString();
  const nextId = nextCommentId(thread);
  return {
    ...thread,
    comments: [
      ...thread.comments,
      {
        id: nextId,
        author: reply.author,
        ...reply.agent ? { agent: true } : {},
        ...reply.via ? { via: reply.via } : {},
        ts,
        body: reply.body,
        parent: reply.parent
      }
    ]
  };
}
function nextCommentId(thread) {
  let max = 0;
  for (const c of thread.comments) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}
function addSuggestion(source, selStart, selEnd, suggestion) {
  if (selEnd < selStart) throw new Error("selEnd must be >= selStart");
  selStart = startPastHeadingPrefix(source, selStart, selEnd);
  const parsed = parse(source);
  const anchorId = mintThreadId([
    ...parsed.threads.map((t) => t.id),
    ...parsed.suggestions.map((s) => s.anchorId)
  ]);
  const original = source.slice(selStart, selEnd).replace(OPEN_RE, "").replace(CLOSE_RE, "");
  assertAnchorable(parsed, source, selStart, selEnd);
  const openMarker = `<!--mc:a:${anchorId}-->`;
  const closeMarker = `<!--mc:/a:${anchorId}-->`;
  const record = {
    anchorId,
    threadId: suggestion.threadId,
    author: suggestion.author,
    agent: suggestion.agent,
    via: suggestion.via,
    ts: suggestion.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    original,
    proposed: suggestion.proposed,
    note: suggestion.note
  };
  const withMarkers = source.slice(0, selStart) + openMarker + source.slice(selStart, selEnd) + closeMarker + source.slice(selEnd);
  const nextSuggestions = [...parsed.suggestions, record];
  return { source: withThreads(withMarkers, parsed.threads, nextSuggestions), suggestion: record };
}
function acceptSuggestion(source, anchorId) {
  return resolveSuggestion(source, anchorId, "accept");
}
function rejectSuggestion(source, anchorId) {
  return resolveSuggestion(source, anchorId, "reject");
}
function resolveSuggestion(source, anchorId, mode) {
  const parsed = parse(source);
  const suggestion = parsed.suggestions.find((s) => s.anchorId === anchorId);
  if (!suggestion) return source;
  const anchor = parsed.anchors.get(anchorId);
  let body = source;
  if (anchor) {
    const replacement = mode === "accept" ? suggestion.proposed : source.slice(anchor.openEnd, anchor.closeStart);
    body = source.slice(0, anchor.openStart) + replacement + source.slice(anchor.closeEnd);
  } else {
    body = stripAnchorMarkers(body, anchorId);
  }
  const nextSuggestions = parsed.suggestions.filter((s) => s.anchorId !== anchorId);
  return withThreads(body, parsed.threads, nextSuggestions);
}

// src/inlineComments/integrity.ts
function checkIntegrity(source) {
  const insp = inspect(source);
  const issues = [];
  for (const m of insp.unpairedMarkers) {
    issues.push({
      kind: "unpaired-marker",
      severity: "error",
      message: m.kind === "open" ? `Anchor ${m.id} has an opening marker with no matching close.` : `Anchor ${m.id} has a closing marker with no matching open.`,
      threadId: m.id,
      offset: m.start,
      repairable: true
    });
  }
  for (const m of insp.malformedThreadLines) {
    issues.push({
      kind: "malformed-thread-json",
      severity: "error",
      message: m.reason === "json-parse-error" ? `A thread line contains invalid JSON and was skipped: ${truncate(m.raw)}` : `A thread line has no "id" field and was skipped: ${truncate(m.raw)}`,
      repairable: false
    });
  }
  for (const id of insp.duplicateThreadIds) {
    issues.push({
      kind: "duplicate-thread-id",
      severity: "error",
      message: `Thread id ${id} appears on more than one thread line; only the last is used.`,
      threadId: id,
      repairable: false
    });
  }
  for (const id of insp.orphanAnchorIds) {
    issues.push({
      kind: "orphan-anchor",
      severity: "warning",
      message: `Anchor markers for ${id} are in the prose but the thread is gone.`,
      threadId: id,
      offset: insp.parsed.anchors.get(id)?.openStart,
      repairable: true
    });
  }
  for (const id of insp.parsed.unanchoredThreadIds) {
    const thread = insp.parsed.threads.find((t) => t.id === id);
    const recoverable = thread ? canRecoverByQuote(source, thread) : false;
    issues.push({
      kind: "unanchored-thread",
      severity: "warning",
      message: recoverable ? `Thread ${id} lost its anchor markers; its quote still matches exactly one place in the prose.` : `Thread ${id} has no anchor markers and its quote cannot be located unambiguously.`,
      threadId: id,
      repairable: recoverable
    });
  }
  for (const t of insp.parsed.threads) {
    const a = insp.parsed.anchors.get(t.id);
    if (!a || t.quote !== "") continue;
    issues.push({
      kind: "empty-quote",
      severity: "warning",
      message: a.openEnd === a.closeStart ? `Thread ${t.id} is anchored to an empty span and has an empty quote \u2014 it points at no text.` : `Thread ${t.id} has an empty quote, so it cannot be re-anchored if its markers are lost.`,
      threadId: t.id,
      offset: a.openStart,
      repairable: false
    });
  }
  for (const id of insp.parsed.unanchoredSuggestionIds) {
    issues.push({
      kind: "unanchored-suggestion",
      severity: "warning",
      message: `Suggestion ${id} lost its anchor markers; its original text can no longer be located.`,
      threadId: id,
      repairable: false
    });
  }
  const anchored = insp.parsed.threads.length - insp.parsed.unanchoredThreadIds.length;
  return {
    ok: issues.length === 0,
    issues,
    counts: {
      threads: insp.parsed.threads.length,
      anchored,
      unanchored: insp.parsed.unanchoredThreadIds.length,
      repairable: issues.filter((i) => i.repairable).length
    }
  };
}
function repairIntegrity(source) {
  const before = checkIntegrity(source);
  if (before.counts.repairable === 0) {
    return { source, repairs: [], remaining: before.issues };
  }
  const proseBefore = stripAllInlineMarkup(source);
  const repairs = [];
  let next = source;
  const unpaired = [...inspect(next).unpairedMarkers].sort((a, b) => b.start - a.start);
  for (const m of unpaired) {
    next = next.slice(0, m.start) + next.slice(m.end);
    repairs.push({
      kind: "unpaired-marker",
      threadId: m.id,
      description: `Removed a stray ${m.kind === "open" ? "opening" : "closing"} marker for ${m.id}.`
    });
  }
  for (const id of inspect(next).orphanAnchorIds) {
    next = stripAnchorMarkers(next, id);
    repairs.push({
      kind: "orphan-anchor",
      threadId: id,
      description: `Removed anchor markers for ${id}, whose thread no longer exists.`
    });
  }
  for (; ; ) {
    const parsed = parse(next);
    const target = parsed.threads.find(
      (t) => parsed.unanchoredThreadIds.includes(t.id) && canRecoverByQuote(next, t)
    );
    if (!target) break;
    const rewrapped = rewrapByQuote(next, target);
    if (rewrapped === null) break;
    next = rewrapped;
    repairs.push({
      kind: "unanchored-thread",
      threadId: target.id,
      description: `Re-anchored thread ${target.id} to the unique occurrence of its quote.`
    });
  }
  if (stripAllInlineMarkup(next) !== proseBefore) {
    return {
      source,
      repairs: [],
      remaining: [
        ...before.issues,
        {
          kind: "unpaired-marker",
          severity: "error",
          message: "Automatic repair was abandoned: it would have altered prose text. The document is unchanged.",
          repairable: false
        }
      ]
    };
  }
  return { source: next, repairs, remaining: checkIntegrity(next).issues };
}
function canRecoverByQuote(source, thread) {
  if (!thread.quote || thread.quote.trim() === "") return false;
  return countOccurrences(stripAllInlineMarkup(source), thread.quote) === 1;
}
function rewrapByQuote(source, thread) {
  const region = parse(source).threadsRegion;
  const searchEnd = region ? region.start : source.length;
  const haystack = source.slice(0, searchEnd);
  if (countOccurrences(haystack, thread.quote) !== 1) return null;
  const at = haystack.indexOf(thread.quote);
  if (at === -1) return null;
  const open = `<!--mc:a:${thread.id}-->`;
  const close = `<!--mc:/a:${thread.id}-->`;
  return source.slice(0, at) + open + source.slice(at, at + thread.quote.length) + close + source.slice(at + thread.quote.length);
}
function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}
function truncate(s, max = 80) {
  return s.length <= max ? s : `${s.slice(0, max)}\u2026`;
}

// src/inlineComments/deltaReview.ts
function contentHashOf(source) {
  return hashAnchorText(normalize(stripAllInlineMarkup(source)));
}
function normalize(text) {
  return text.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
}
function splitSections(prose) {
  const lines = prose.split("\n");
  const sections = [];
  const seen = /* @__PURE__ */ new Map();
  let current = {
    heading: null,
    startLine: 1,
    body: []
  };
  const push = () => {
    if (current.heading === null && current.body.join("").trim() === "" && sections.length === 0) {
      return;
    }
    const key = current.heading ?? "\0preamble";
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    sections.push({
      heading: current.heading,
      ordinal,
      startLine: current.startLine,
      text: current.body.join("\n")
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) {
      push();
      current = { heading: m[1].trim(), startLine: i + 1, body: [lines[i]] };
    } else {
      current.body.push(lines[i]);
    }
  }
  push();
  return sections;
}
function sectionHashes(source) {
  return splitSections(stripAllInlineMarkup(source)).map((s) => ({
    heading: s.heading,
    hash: hashAnchorText(normalize(s.text))
  }));
}
function checkpointFor(source, now = () => (/* @__PURE__ */ new Date()).toISOString(), gitRef) {
  return {
    ts: now(),
    contentHash: contentHashOf(source),
    ...gitRef ? { gitRef } : {},
    sections: sectionHashes(source)
  };
}

// src/agentIdentity.ts
var KNOWN_AGENT_SLUGS = /* @__PURE__ */ new Set(["claude", "codex", "cursor", "copilot", "gemini", "agent"]);
function isAgentComment(c) {
  if (c.agent === true) return true;
  return KNOWN_AGENT_SLUGS.has(c.author.toLowerCase());
}

// src/inlineComments/docOps.ts
var DocOpError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "DocOpError";
  }
  code;
  details;
};
function assertNoNewIssues(before, after, opts) {
  const wasBroken = checkIntegrity(before).issues.length;
  const report = checkIntegrity(after);
  const expected = opts?.expectedUnanchored;
  const countable = expected && expected.size > 0 ? report.issues.filter(
    (i) => !(i.kind === "unanchored-thread" && i.threadId !== void 0 && expected.has(i.threadId))
  ) : report.issues;
  if (countable.length > wasBroken) {
    const introduced = countable.length - wasBroken;
    throw new DocOpError(
      "integrity",
      `refusing to write \u2014 the change would introduce ${introduced} integrity problem(s): ${countable.map((i) => i.message).join("; ")}`,
      { issues: countable }
    );
  }
  return report.issues;
}
function findThread(source, threadId) {
  const t = parse(source).threads.find((x) => x.id === threadId);
  if (!t) {
    throw new DocOpError("thread_not_found", `no thread with id ${threadId} in this file`, { threadId });
  }
  return t;
}
function lastLiveComment(t) {
  const live = t.comments.filter((c) => !c.deleted);
  return live[live.length - 1];
}
function parseOccurrence(value) {
  if (value === void 0 || value === null) return 0;
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new DocOpError(
      "invalid_arguments",
      `occurrence must be a non-negative integer (1-based; 0 means "the only one"), got ${JSON.stringify(value)}`,
      { occurrence: value }
    );
  }
  return n;
}
function locatePassage(source, quote, occurrence = 0) {
  parseOccurrence(occurrence);
  if (quote === "") {
    throw new DocOpError("empty_selection", "quote must not be empty \u2014 give the exact text to anchor to", { quote });
  }
  const parsed = parse(source);
  const limit = parsed.threadsRegion ? parsed.threadsRegion.start : source.length;
  const hits = [];
  let from = 0;
  for (; ; ) {
    const at = source.indexOf(quote, from);
    if (at === -1 || at >= limit) break;
    hits.push(at);
    from = at + quote.length;
  }
  if (hits.length === 0) {
    throw new DocOpError("passage_not_found", `passage not found: ${JSON.stringify(quote.slice(0, 60))}`, {
      quote
    });
  }
  if (hits.length > 1 && occurrence === 0) {
    throw new DocOpError(
      "passage_ambiguous",
      `passage appears ${hits.length} times; pass occurrence 1..${hits.length} to say which one you mean`,
      { quote, occurrences: hits.length }
    );
  }
  const index = occurrence === 0 ? 0 : occurrence - 1;
  if (index < 0 || index >= hits.length) {
    throw new DocOpError(
      "passage_not_found",
      `occurrence ${occurrence} is out of range (passage appears ${hits.length} time(s))`,
      { quote, occurrences: hits.length }
    );
  }
  return hits[index];
}
function opList(source, actionable = false) {
  const parsed = parse(source);
  const stale = new Set(staleThreadIds(parsed));
  const threads = parsed.threads.filter((t) => {
    if (!actionable) return true;
    if (t.status !== "open") return false;
    const last = lastLiveComment(t);
    return last !== void 0 && !isAgentComment(last);
  }).map((t) => {
    const a = parsed.anchors.get(t.id);
    return {
      id: t.id,
      status: t.status,
      quote: t.quote,
      anchored: a !== void 0,
      anchoredText: a ? source.slice(a.openEnd, a.closeStart) : null,
      // True when the passage moved after the last comment — read this one
      // first, the comment may be answering text that no longer exists.
      stale: stale.has(t.id),
      comments: t.comments.filter((c) => !c.deleted).map((c) => ({ id: c.id, author: c.author, ts: c.ts, body: c.body, ...c.via ? { via: c.via } : {} }))
    };
  });
  const suggestions = parsed.suggestions.map((s) => {
    const a = parsed.anchors.get(s.anchorId);
    return {
      anchorId: s.anchorId,
      threadId: s.threadId,
      author: s.author,
      ...s.via ? { via: s.via } : {},
      anchored: a !== void 0,
      original: s.original,
      proposed: s.proposed,
      note: s.note
    };
  });
  return {
    threadCount: parsed.threads.length,
    threads,
    suggestionCount: parsed.suggestions.length,
    suggestions
  };
}
function opReply(source, threadId, body, now = () => (/* @__PURE__ */ new Date()).toISOString(), author = "claude", agent = true, via) {
  const thread = findThread(source, threadId);
  const appended = appendReply(thread, { author, agent, via, body, ts: now() });
  const reply = appended.comments[appended.comments.length - 1];
  const reopened = thread.status === "resolved" && isAgentComment(reply);
  const replied = withRefreshedAnchorHash(
    parse(source),
    reopened ? { ...appended, status: "open", resolvedBy: void 0, resolvedTs: void 0 } : appended
  );
  const next = replaceThread(source, threadId, replied);
  assertNoNewIssues(source, next);
  const updated = findThread(next, threadId);
  return {
    next,
    result: { threadId, commentId: updated.comments[updated.comments.length - 1].id, reopened }
  };
}
function opRewrite(source, threadId, replacement) {
  const parsed = parse(source);
  const thread = findThread(source, threadId);
  const a = parsed.anchors.get(threadId);
  if (!a) {
    throw new DocOpError(
      "unanchored",
      `thread ${threadId} has no anchor markers in the prose; rewrite needs an anchored span`,
      { threadId }
    );
  }
  const previous = source.slice(a.openEnd, a.closeStart);
  const spliced = source.slice(0, a.openEnd) + replacement + source.slice(a.closeStart);
  const next = replaceThread(spliced, threadId, {
    ...thread,
    quote: replacement,
    anchorHash: hashAnchorText(replacement)
  });
  assertNoNewIssues(source, next);
  return { next, result: { threadId, previous, replacement } };
}
function opEdit(source, old, replacement, occurrence = 0) {
  parseOccurrence(occurrence);
  if (old === "") {
    throw new DocOpError("empty_selection", "old text must not be empty \u2014 give the exact text to replace", { old });
  }
  if (old === replacement) {
    throw new DocOpError(
      "nothing_to_do",
      "old and new text are identical; the document is unchanged"
    );
  }
  const parsed = parse(source);
  const regionStart = parsed.threadsRegion ? parsed.threadsRegion.start : source.length;
  const matches = [];
  let from = 0;
  for (; ; ) {
    const at = source.indexOf(old, from);
    if (at === -1) break;
    matches.push(at);
    from = at + old.length;
  }
  if (matches.length === 0) {
    throw new DocOpError(
      "passage_not_found",
      `text not found: ${JSON.stringify(old.slice(0, 60))}`,
      { old }
    );
  }
  const candidates = matches.filter((at) => at < regionStart);
  if (candidates.length === 0) {
    throw new DocOpError(
      "not_editable",
      "that text is only inside the review threads region; reply with mc_reply instead of editing thread records",
      { old }
    );
  }
  if (candidates.length > 1 && occurrence === 0) {
    throw new DocOpError(
      "passage_ambiguous",
      `text appears ${candidates.length} times; pass occurrence 1..${candidates.length} to say which one you mean`,
      { old, occurrences: candidates.length }
    );
  }
  const index = occurrence === 0 ? 0 : occurrence - 1;
  if (index < 0 || index >= candidates.length) {
    throw new DocOpError(
      "passage_not_found",
      `occurrence ${occurrence} is out of range (text appears ${candidates.length} time(s))`,
      { old, occurrences: candidates.length }
    );
  }
  const start = candidates[index];
  const end = start + old.length;
  if (parsed.threadsRegion && start < parsed.threadsRegion.end && parsed.threadsRegion.start < end) {
    throw new DocOpError(
      "not_editable",
      "that text runs into the review threads region; reply with mc_reply instead of editing thread records",
      { old }
    );
  }
  const touchesRange = (m) => m.start < end && start < m.end;
  const wholeInRange = (m) => start <= m.start && m.end <= end;
  const MARKER_MESSAGE = "that text contains only one of a thread's two markers (or splits a marker); to delete an anchored passage include both markers and the text between them; to change text inside an anchor use mc_rewrite";
  const removedPairIds = /* @__PURE__ */ new Set();
  for (const [id, a] of parsed.anchors) {
    const open = { start: a.openStart, end: a.openEnd };
    const close = { start: a.closeStart, end: a.closeEnd };
    const openTouches = touchesRange(open);
    const closeTouches = touchesRange(close);
    if (!openTouches && !closeTouches) continue;
    if (openTouches && closeTouches && wholeInRange(open) && wholeInRange(close)) {
      removedPairIds.add(id);
      continue;
    }
    throw new DocOpError("not_editable", MARKER_MESSAGE, { old });
  }
  for (const m of inspect(source).unpairedMarkers) {
    if (touchesRange(m)) {
      throw new DocOpError("not_editable", MARKER_MESSAGE, { old });
    }
  }
  const next = source.slice(0, start) + replacement + source.slice(end);
  assertNoNewIssues(source, next, { expectedUnanchored: removedPairIds });
  return {
    next,
    result: {
      occurrence: index + 1,
      occurrences: candidates.length,
      line: source.slice(0, start).split("\n").length,
      // Threads only: a removed pair can also be an orphan anchor (markers
      // whose thread was already gone), which leaves nothing unanchored.
      unanchored: parsed.threads.filter((t) => removedPairIds.has(t.id)).map((t) => t.id)
    }
  };
}
function opOpen(source, quote, body, occurrence = 0, now = () => (/* @__PURE__ */ new Date()).toISOString(), author = "claude", via) {
  const at = locatePassage(source, quote, occurrence);
  let result;
  try {
    result = addThread(source, at, at + quote.length, { author, agent: true, via, body, ts: now() });
  } catch (e) {
    throw new DocOpError("not_anchorable", e.message, { quote });
  }
  assertNoNewIssues(source, result.source);
  return { next: result.source, result: { threadId: result.thread.id, quote } };
}
function opResolve(source, threadId, now = () => (/* @__PURE__ */ new Date()).toISOString(), author = "claude") {
  const thread = findThread(source, threadId);
  const next = replaceThread(source, threadId, {
    ...thread,
    status: "resolved",
    resolvedBy: author,
    resolvedTs: now()
  });
  assertNoNewIssues(source, next);
  return { next, result: { threadId } };
}
function opSuggest(source, quote, proposed, opts = {}, now = () => (/* @__PURE__ */ new Date()).toISOString(), author = "claude", via) {
  const at = locatePassage(source, quote, opts.occurrence ?? 0);
  let result;
  try {
    result = addSuggestion(source, at, at + quote.length, {
      author,
      agent: true,
      via,
      proposed,
      note: opts.note,
      threadId: opts.threadId,
      ts: now()
    });
  } catch (e) {
    throw new DocOpError("not_anchorable", e.message, { quote });
  }
  assertNoNewIssues(source, result.source);
  return {
    next: result.source,
    result: {
      anchorId: result.suggestion.anchorId,
      original: result.suggestion.original,
      proposed
    }
  };
}
function opAccept(source, anchorId) {
  const parsed = parse(source);
  const suggestion = parsed.suggestions.find((s) => s.anchorId === anchorId);
  if (!suggestion) {
    throw new DocOpError("suggestion_not_found", `no suggestion with anchor id ${anchorId} in this file`, {
      anchorId
    });
  }
  if (!parsed.anchors.has(anchorId)) {
    throw new DocOpError(
      "unanchored",
      `suggestion ${anchorId} lost its anchor markers; cannot place the change`,
      { anchorId }
    );
  }
  const next = acceptSuggestion(source, anchorId);
  assertNoNewIssues(source, next);
  return { next, result: { anchorId, applied: suggestion.proposed } };
}
function opReject(source, anchorId) {
  const parsed = parse(source);
  if (!parsed.suggestions.some((s) => s.anchorId === anchorId)) {
    throw new DocOpError("suggestion_not_found", `no suggestion with anchor id ${anchorId} in this file`, {
      anchorId
    });
  }
  const next = rejectSuggestion(source, anchorId);
  assertNoNewIssues(source, next);
  return { next, result: { anchorId } };
}
function opCheck(source) {
  const report = checkIntegrity(source);
  return {
    ok: report.ok,
    counts: report.counts,
    issues: report.issues.map((i) => ({
      kind: i.kind,
      severity: i.severity,
      threadId: i.threadId,
      repairable: i.repairable,
      message: i.message
    }))
  };
}
function opCheckpoint(source, now = () => (/* @__PURE__ */ new Date()).toISOString(), gitRef) {
  const report = checkIntegrity(source);
  if (!report.ok) {
    throw new DocOpError("integrity", "refusing to checkpoint a document with integrity problems", {
      issues: report.issues
    });
  }
  const checkpoint = checkpointFor(source, now, gitRef);
  const next = withThreads(source, parse(source).threads, void 0, checkpoint);
  assertNoNewIssues(source, next);
  return { next, result: { checkpoint } };
}
function opCheckAndCheckpoint(source, now = () => (/* @__PURE__ */ new Date()).toISOString(), gitRef) {
  const report = opCheck(source);
  if (!report.ok) return { report };
  try {
    const stamped = opCheckpoint(source, now, gitRef);
    return { report, next: stamped.next, checkpoint: stamped.result.checkpoint };
  } catch {
    return { report };
  }
}

// src/mcpServer/protocol.ts
var PROTOCOL_VERSION = "2025-06-18";

// src/mcpServer/registration.ts
var ENV_URL = "MARKDOWN_COLLAB_MCP_URL";
var ENV_TOKEN = "MARKDOWN_COLLAB_MCP_TOKEN";
var DESCRIPTOR_REL = ".markdown-collab/.mcp-server.json";

// src/skillCli/checkHook.ts
import * as path from "node:path";
var SILENT_OK = { exitCode: 0, stderr: "" };
var THREADS_BEGIN_MARKER = "<!--mc:threads:begin-->";
var MAX_ISSUE_LINES = 10;
var SUGGEST_MODE_SETTING = "markdownCollab.proposeEditsAsSuggestions";
function runCheckHook(stdinText, io) {
  try {
    return decide(stdinText, io);
  } catch {
    return SILENT_OK;
  }
}
function decide(stdinText, io) {
  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return SILENT_OK;
  }
  if (!isPlainObject(payload)) return SILENT_OK;
  const toolInput = payload.tool_input;
  if (!isPlainObject(toolInput)) return SILENT_OK;
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || filePath === "") return SILENT_OK;
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return SILENT_OK;
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : io.cwd();
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(hookCwd, filePath);
  const content = io.readFile(absPath);
  if (content === null) return SILENT_OK;
  if (!content.includes(THREADS_BEGIN_MARKER)) return SILENT_OK;
  const reports = [];
  if (suggestModeOnDisk(hookCwd, io)) {
    reports.push(suggestModeReport(filePath));
  }
  const errors = opCheck(content).issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) reports.push(formatReport(filePath, errors));
  if (reports.length === 0) return SILENT_OK;
  return { exitCode: 2, stderr: reports.join("") };
}
function suggestModeReport(filePath) {
  return `Markdown Collab: ${filePath} was edited directly, but suggest mode is on for this workspace \u2014 propose edits with mc_suggest / mdc suggest instead of editing directly.
`;
}
function suggestModeOnDisk(hookCwd, io) {
  const raw = io.readFile(path.join(hookCwd, ".vscode", "settings.json"));
  if (raw === null) return false;
  const parsed = parseJsonc(raw);
  if (!isPlainObject(parsed)) return false;
  return parsed[SUGGEST_MODE_SETTING] === true;
}
function parseJsonc(raw) {
  let out2 = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      out2 += c;
      if (c === "\\" && i + 1 < raw.length) {
        out2 += raw[++i];
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out2 += c;
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out2 += "\n";
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out2 += c;
  }
  try {
    return JSON.parse(out2.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return void 0;
  }
}
function formatReport(filePath, errors) {
  const noun = errors.length === 1 ? "problem" : "problems";
  const lines = [`Markdown Collab: ${filePath} has ${errors.length} comment-marker ${noun} after this edit:`];
  const shown = errors.slice(0, MAX_ISSUE_LINES);
  for (const issue of shown) lines.push(`- ${issue.message}`);
  if (errors.length > MAX_ISSUE_LINES) {
    lines.push(`- \u2026and ${errors.length - MAX_ISSUE_LINES} more`);
  }
  lines.push(`Run \`mdc check ${filePath} --repair\` (or mc_check) and fix what remains \u2014 don't hand-edit markers.`);
  return `${lines.join("\n")}
`;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/skillCli/guardHook.ts
import * as path2 from "node:path";
var PASS = { exitCode: 0, stderr: "" };
var REVIEW_DATA = /<!--mc:[\s\S]*?-->/g;
function runGuardHook(stdinText, io) {
  try {
    return decide2(stdinText, io);
  } catch {
    return PASS;
  }
}
function decide2(stdinText, io) {
  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return PASS;
  }
  if (!isPlainObject(payload)) return PASS;
  const input = payload.tool_input;
  if (!isPlainObject(input)) return PASS;
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath === "") return PASS;
  const ext = path2.extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return PASS;
  const hookCwd = typeof payload.cwd === "string" ? payload.cwd : io.cwd();
  const absPath = path2.isAbsolute(filePath) ? filePath : path2.resolve(hookCwd, filePath);
  const current = io.readFile(absPath);
  if (current === null || !current.includes("<!--mc:")) return PASS;
  const before = reviewData(current);
  if (before.length === 0) return PASS;
  const next = afterTool(payload.tool_name, input, current);
  if (next === null || next === current) return PASS;
  if (opCheck(current).issues.some((issue) => issue.severity === "error")) return PASS;
  if (suggestModeOnDisk(hookCwd, io)) return { exitCode: 2, stderr: suggestModeRefusal(filePath) };
  const after = reviewData(next);
  if (before.length === after.length && before.every((token, i) => token === after[i])) return PASS;
  return { exitCode: 2, stderr: refusal(filePath, usesReplaceAll(input) && after.length === before.length) };
}
function afterTool(tool, input, current) {
  if (tool === "Write") return typeof input.content === "string" ? input.content : null;
  if (tool === "Edit") return applyEdit(current, input);
  if (tool === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    let text = current;
    for (const edit of input.edits) {
      if (!isPlainObject(edit) || text === null) return null;
      text = applyEdit(text, edit);
    }
    return text;
  }
  return null;
}
function applyEdit(text, edit) {
  const { old_string: rawOld, new_string: rawNew, replace_all: replaceAll } = edit;
  if (typeof rawOld !== "string" || typeof rawNew !== "string" || rawOld === "") return null;
  let oldString = rawOld;
  let newString = rawNew;
  if (!text.includes(oldString) && text.includes("\r\n") && oldString.includes("\n")) {
    oldString = oldString.replace(/\r?\n/g, "\r\n");
    newString = newString.replace(/\r?\n/g, "\r\n");
  }
  const at = text.indexOf(oldString);
  if (at < 0) return null;
  if (replaceAll === true) return text.split(oldString).join(newString);
  return text.slice(0, at) + newString + text.slice(at + oldString.length);
}
function reviewData(text) {
  const mask = buildCodeMask(text);
  const tokens = [];
  for (const m of text.matchAll(REVIEW_DATA)) if (!mask[m.index]) tokens.push(m[0]);
  return tokens;
}
function usesReplaceAll(input) {
  if (input.replace_all === true) return true;
  return Array.isArray(input.edits) && input.edits.some((e) => isPlainObject(e) && e.replace_all === true);
}
function refusal(filePath, replaceAllHitThreadText) {
  const lines = [
    `Markdown Collab: not applied \u2014 this edit to ${filePath} would change its review comments (a <!--mc:\u2026--> marker or thread line), and a hand edit is how they break.`
  ];
  if (replaceAllHitThreadText) {
    lines.push(
      "replace_all also rewrote text quoted inside a thread line. Make the same Edit once per occurrence in the prose instead (or mdc edit with --occurrence N)."
    );
  }
  lines.push(
    "Make the change with mdc (or the matching markdown-collab MCP tool: mc_reply, mc_rewrite, mc_edit, \u2026):",
    `- reply to a thread: mdc reply ${filePath} <threadId> --body "\u2026"`,
    `- rewrite a commented passage, markers kept: mdc rewrite ${filePath} <threadId> --with "\u2026"`,
    `- change or delete prose around markers: mdc edit ${filePath} --old "\u2026" --new "\u2026"`,
    `- open, resolve, suggest: mdc open / mdc resolve / mdc suggest ${filePath} \u2026`,
    "Removing every comment from the file is the human's call: ask them to run Markdown Collab: Remove All Review Data.",
    "An Edit that leaves every <!--mc:\u2026--> exactly as it is still goes through.",
    ""
  );
  return lines.join("\n");
}
function suggestModeRefusal(filePath) {
  return `Markdown Collab: not applied \u2014 suggest mode is on for this workspace, so ${filePath} isn't edited directly. Propose the change with mdc suggest ${filePath} --quote "\u2026" --with "\u2026" --note "\u2026" (or mc_suggest). If the human wants this edit made directly, they can turn suggest mode off (the switch above Send, or markdownCollab.proposeEditsAsSuggestions in .vscode/settings.json).
`;
}

// src/skillText.ts
var TOOL_VERBS = {
  check: "mc_check",
  anchorRules: "Phase 5 constraints",
  openMechanics: "same Phase 5 mechanics"
};
var CLI_VERBS = {
  check: "mdc check",
  anchorRules: "the anchoring rules `open` enforces",
  openMechanics: "same `open` mechanics"
};
function reviewRubric(v) {
  return `#### Focus directive

The prompt may include a \`Focus:\` line \u2014 a free-form instruction from the human (e.g. *"check API examples for correctness," "find marketing-y tone," "look for contradictions with the architecture doc"*). When a focus directive is present:

- It is the **primary filter** for what counts as a concern worth a thread. Only flag things that match the focus.
- A general-quality issue that doesn't match the focus does **not** warrant a thread unless it's a hard error (e.g. broken example, factually wrong claim).
- If no concerns match the focus after a careful read, reply (via the send channel, not via a thread) saying so. **Do not fabricate threads to feel productive.**

Without a focus directive, do a general review against the rubric below.

#### Standing conventions

A payload may carry a **Conventions:** block \u2014 the project's standing rules (from \`.markdown-collab/conventions.md\`): terminology, tone, house style, and "we know, don't flag it" exceptions.

- They apply to **every** pass, where \`Focus:\` applies to one. Where they pull apart, focus wins on **scope** (what warrants a thread); conventions still hold on **wording**. A convention violation is a legitimate thread even with no matching focus \u2014 that's what makes it standing.
- Anything the block lists as known and accepted is **not** a finding \u2014 flagging it is the re-litigation the file exists to stop.
- If the human dismisses a thread by stating a rule ("we always write it this way"), **suggest** adding it to the conventions file \u2014 don't write to that file yourself, it's theirs.

#### What warrants a thread

Factual error; an unclear claim a reader could plausibly misread; missing context (an undefined term used in passing); a broken example (code that won't run, a wrong flag, a link to a nonexistent file); a contradiction with another section or scoped-in file; a structural issue (order, heading hierarchy, buried info); anything matching the focus directive.

#### What does NOT warrant a thread by default

Pure typos \u2014 skip unless the focus is "copy-edit". Style preferences (Oxford comma, sentence length, voice) \u2014 skip unless the focus is "tone"/"style". A generic "could be clearer" with no named problem \u2014 if you can't name it, you can't anchor it. Restating the anchored text \u2014 the body must add something the human doesn't already see.

#### Anchor sizing in Review Mode

- The anchor should be the **smallest passage that makes the comment make sense**. Prefer one sentence over a paragraph. Prefer one phrase over a sentence when the issue is local.
- Avoid wrapping a whole section. If the issue is structural ("this section is in the wrong place"), anchor the section heading line, not the body.
- Anchors must still satisfy ${v.anchorRules}: a meaningful span, outside code spans, marker-safe location.

#### Thread body \u2014 specificity rule

Every \`c1\` body must name the concern concretely \u2014 **good:** *"The claim that \`X\` implies \`Y\` skips intermediate step \`Z\`. Either justify the jump or add the step."* **bad:** *"This could be clearer"* / *"The whole section needs work"* / restating the anchored text with no analysis.

The body should fit in 1\u20133 sentences. If you need more, split into separate threads on different anchors.

#### Worked examples \u2014 good vs bad

These calibrate the rubric. Mirror the *shape* of the good examples; avoid the failure modes in the bad ones.

**Good \u2014 concrete factual correction.** Doc says: *"The CLI accepts \`--all\` to include resolved comments."* Code says the flag is \`--include-resolved\`. Anchor the literal \`--all\` token only (smallest meaningful span). Body: *"CLI flag is \`--include-resolved\` per \`cli.ts:142\`, not \`--all\`. Either rename the doc or update the CLI."*

**Good \u2014 unclear claim with a named ambiguity.** Doc says: *"The skill triggers on review-mode phrases."* Anchor the sentence. Body: *"\\'Review-mode phrases\\' isn't defined here \u2014 the rubric for what counts as one is in Phase 5+. Either inline a one-line definition or link to the Review Mode section."*

**Good \u2014 contradiction across sections.** Doc's \`Quick start\` says \`Send to Claude\` is in the right-click menu; doc's \`Commands\` table says it's palette-only. Anchor the quick-start claim (because it's the one that's likely wrong). Body: *"Conflicts with the Commands table, which marks this palette-only as of v0.28. Update one or the other to match reality."*

**Good \u2014 structural issue, anchored at a heading.** Doc has a \`## Settings\` heading before \`## Storage layout\`, but Storage explains terms used in Settings. Anchor the \`## Settings\` heading. Body: *"Settings references the \`<!--mc:threads:begin-->\` marker introduced in Storage layout below. Move Storage layout above Settings, or forward-link explicitly."*

**Bad \u2014 vague.** *"This could be clearer."* No anchored specifics, no named problem, nothing the human can act on without re-deriving the concern. Either name the specific issue or skip.

**Bad \u2014 anchor too wide.** Anchoring an entire 8-paragraph section because *"the whole section needs work."* The human can't tell which sentence drove the comment. Pick the single sentence (or heading) that crystallizes the issue.

**Bad \u2014 restating the anchor.** Anchored: *"Channels need MCP."* Body: *"This sentence is about channels needing MCP."* Adds nothing the reader doesn't see. Either explain *why* the claim is problematic (it's incomplete? wrong? unclear in this context?) or skip.

**Bad \u2014 opinion presented as fact.** *"This intro is too marketing-y."* \u2014 only valid if the focus directive explicitly asks for tone. Without that, style preferences aren't a substantive concern.

**Bad \u2014 fix dressed as a comment.** Body: *"I changed this to X."* You don't edit prose in Review Mode. Open a thread proposing the change in the body; let the human accept it.

#### Rank, cap at five, then summarize

Rank concerns by severity and open threads for the **five** that matter most. Put everything else in one summary thread anchored to the document's title (its first \`#\` heading, or the very first line when it has none): \`Also noticed (N): \u2026\`, one line per item naming its passage \u2014 so the human can read it and say "open 3 and 7" for exactly the ones they want promoted. The \`Focus:\` line can override the cap explicitly ("give me ten", "everything"); absent that, five is it, whether the pass turns up six issues or sixty.

Don't drop a finding to make the cap \u2014 every concern still reaches the human, in its own thread if it's top five, in the summary line otherwise. The human triages with the sidebar UI; your job is signal, ranked.

#### Honest empty result

If you read the doc carefully and find no concerns that match the focus (or no general-rubric concerns if no focus was given), say so explicitly via the send channel. Do **not** open a thread to comment "looks good" \u2014 threads are for actionable concerns. A short reply of *"Reviewed \`<path>\` against focus \`<focus>\`. No concerns found."* is the correct outcome.

#### Delta passes \u2014 "review changes since last pass"

A prompt may ask you to review **only what changed since your last pass**. It names the changed sections, includes their current text, and lists the threads that already exist.

Do not review unchanged prose \u2014 it was reviewed already, and re-raising it is noise in the triage queue. Cross-reference by id instead of duplicating: if a concern is already covered by a listed thread, reply there rather than opening a second one. A resolved thread is settled \u2014 don't raise it again unless the new text genuinely reintroduces the problem, and say which thread it was ("this brings back the issue from a1b2c") when it does. Threads flagged "text changed" first, since their passage was edited and the concern may already be handled or moved. Unchanged text is fair game only when the change made it wrong \u2014 say why in the body. Finish with \`${v.check}\` as always \u2014 it's what makes the *next* delta pass possible.

#### Multi-file review passes

A Review Mode prompt may name **several files** instead of one \u2014 the extension's "Ask Agent to Review These Docs" command builds one pass over a folder or a multi-select. The prompt lists the files; treat that list as the work order.

1. **Read every listed file end to end before opening any thread** \u2014 you can't judge cross-file consistency otherwise, and a thread opened in file 1 may be answered by file 3. Then open threads file by file, in the order listed (${v.openMechanics}; ids unique only within their own file).
2. **Cross-document consistency is part of the pass**, not an optional extra: terminology drift, a claim in one file contradicted by another, duplicated guidance that's diverged, cross-references that no longer resolve. Anchor such a thread in the file that's wrong (or the more prominent one), quoting the other file's conflicting text \u2014 the human is reading without it open.
3. **Focus applies per pass; the five-thread cap applies per file.** Each file gets its own top five and its own summary thread for the rest \u2014 not one shared cap or one shared summary across the whole pass. Verify each file with \`${v.check}\` before moving to the next \u2014 cheaper to catch a broken marker in file 1 before editing files 2 and 3 \u2014 and report per file, with cross-document findings called out separately.`;
}
function renderReviewGuide() {
  return `# Reviewing a document with Markdown Collab

You are the reviewer: you open threads on passages for the human to triage, and you never edit the prose \u2014 not even an obvious typo (open a thread on it). Read the whole document first, then open threads one at a time, in document order, with \`mdc open <file> --quote "\u2026" --body "\u2026"\` \u2014 re-reading between them, since each one moves the text after it. Finish every file with \`mdc check <file>\`, which also ends the human's "Waiting for the agent\u2026" row.

${reviewRubric(CLI_VERBS).replace(/^#### /gm, "## ")}
`;
}
var SECTIONS = [
  {
    id: "intro",
    text: `# Markdown Collab \u2014 agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. The user runs the IDE; you do the writing.`
  },
  {
    id: "storage",
    text: `## Storage format

Comments are stored INLINE in the \`.md\` file itself \u2014 there is no sidecar.

- Anchored spans are paired HTML comments: \`<!--mc:a:ID-->anchored text<!--mc:/a:ID-->\` (ID = 1\u201312 char base36).
- One block at the end of the file holds one \`<!--mc:t {JSON}-->\` line per thread, fenced by \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\`: \`{"id":"<ID>","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, \u2026]}\`.
- Each \`Comment\`: \`{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>","editedTs"?:"<ISO-8601 UTC>","deleted"?:true}\`.

**Detection:** the file contains the literal string \`<!--mc:threads:begin-->\` \u2014 its absence means no comments yet. A named file with no threads region: if the user asked you to **address** comments, there are none \u2014 tell them and stop; if they asked you to **initiate** a thread (opt-in, Phase 5), create the region.`,
    brief: { kind: "intro", text: "Review threads and suggestions live INLINE in the .md file \u2014 `<!--mc:a:ID-->\u2026<!--mc:/a:ID-->` anchor markers plus one `<!--mc:threads:begin-->` block at the end. These tools are the only safe way to change them: never hand-edit a marker or a thread line." }
  },
  {
    id: "change-paths",
    text: `## How to change a document \u2014 the tools

Marker surgery by hand is the single most common way this workflow breaks: one dropped \`-->\` silently orphans a reviewer's comment. So you never hand-edit a marker or a thread line \u2014 every change goes through the **MCP tools**, which run the *same* engine the editor itself uses: edits go through the editor, undoable with Cmd+Z, validated before they land.

| MCP tool | What it does |
| --- | --- |
| \`mc_list(file, actionable?)\` | Threads and pending suggestions as JSON, including each thread's live anchored text. The actionable flag keeps only open threads whose last comment is not yours. |
| \`mc_reply(file, threadId, body)\` | Appends a reply authored by \`claude\` with the correct \`c<N>\` id and timestamp. |
| \`mc_rewrite(file, threadId, with)\` | Replaces the text between a thread's markers and updates its \`quote\`. Both markers are preserved by construction. |
| \`mc_edit(file, old, new, occurrence?)\` | Replaces exact text outside anchored spans (prose, frontmatter), or deletes an anchored passage when \`old\` spans both of its markers. Refuses anything that splits a marker pair or touches the threads region \u2014 use \`mc_rewrite\` inside an anchor. |
| \`mc_open(file, quote, body, occurrence?)\` | Opens a new thread on a passage: mints a unique id, wraps the passage, appends the thread line. |
| \`mc_resolve(file, threadId)\` | Marks a thread resolved. Only when the human asks. |
| \`mc_suggest(file, quote, with, note?, occurrence?)\` | Proposes an edit without applying it (suggest mode). Keeps the original in the prose. |
| \`mc_accept(file, anchorId)\` / \`mc_reject(file, anchorId)\` | Apply / drop a pending suggestion. Normally the human's call in the UI. |
| \`mc_check(file)\` | Integrity report. **Run this last on every file you touched** \u2014 see below. |
| \`mc_status(note, file?)\` | Say what you're doing right now ("reading 2 of 3 files", "opening threads on \xA7Setup"). |

Two of these do more than they look like they do: **\`mc_check\` ends the pass** \u2014 the extension shows the human a "Waiting for the agent\u2026" row on every thread it sent you, and your closing \`mc_check\` on a file is what clears it; skip it and they're left watching a spinner for work you already finished. **\`mc_status\` is free and worth it** \u2014 a review pass over three files is minutes of silence otherwise, and one short present-tense phrase per phase shows up next to the indicator and in the status bar.

Ordinary prose edits \u2014 text outside an anchored span \u2014 use \`mc_edit\`, which refuses anything that would break a marker or touch the threads region. Every mutating tool validates before writing and refuses a change that would introduce a new integrity problem, so a refused call leaves the file untouched rather than half-edited.

**The tools refuse rather than guess.** Ambiguous passage (appears more than once)? Pass the occurrence. Inside a code span? Choose a different anchor. The file kept changing under the call (\`conflict\`)? Nothing was written \u2014 re-read it with \`mc_list\` and make the call again. Never work around a refusal \u2014 it's telling you the edit was unsafe.`,
    brief: { kind: "intro", text: "Writes go through the editor (the human can undo them) and are validated first. A refusal means the edit was unsafe \u2014 pass `occurrence` for an ambiguous passage; never work around it." }
  },
  {
    id: "discover",
    text: `## Workflow

### Phase 1 \u2014 Discover

Call \`mc_list(file, actionable: true)\` for the threads still waiting on you \u2014 open, last spoken to by someone other than you. Each comes with \`id\`, \`quote\`, \`comments\`, and \`anchoredText\` (the live text between that thread's markers \u2014 the passage the reviewer meant). A thread with \`"anchored": false\` has lost its markers; treat \`quote\` as the locator and see Phase 7.

Read the file itself too \u2014 the threads are only the part someone commented on.`,
    brief: { kind: "step", text: "Discover \u2014 `mc_list(file, actionable: true)` gives the threads waiting on you, with ids and live anchored text. Read the file too." }
  },
  {
    id: "plan",
    text: `### Phase 2 \u2014 Plan

Group by file. Within a file, order edits by anchor position (earlier first). For each thread, write down: the reviewer's intent, the concrete edit, and whether the anchored passage will be rewritten in place (marker pair must move with it) or removed (markers go away, thread orphans).`
  },
  {
    id: "edit-reply",
    text: `### Phase 3 \u2014 Edit & reply

For each thread, in order:

1. **Make the prose change.** Rewriting the anchored passage: replace the text *between* the markers with \`mc_rewrite(file, threadId, with: "\u2026")\` \u2014 updates \`quote\` in the same operation, can't drop or split a marker. Editing prose outside the anchored span: use \`mc_edit\`, markers stay put. Removing the anchored passage: delete the open marker, the passage, and the close marker together with \`mc_edit\` \u2014 \`old\` spans both markers, so nothing is split; the thread orphans and shows as "broken anchor", the correct outcome; do NOT re-anchor to nearby unrelated text.

2. **Append a reply:** \`mc_reply(file, threadId, body: "\u2026")\`. Assigns the next \`c<N>\` id, sets \`author\` to \`"claude"\` and \`ts\` to now, appends to the thread, leaves everything else untouched. Write one or two specific sentences \u2014 quote the new wording, name the section or file/function you changed. Don't say "done".

3. **For threads you can't fully address** (ambiguous, missing info, conflicting with another thread), reply explaining what you tried and what you need \u2014 don't pretend it's done.`,
    brief: { kind: "step", text: "Act \u2014 `mc_rewrite` changes text inside a thread's anchor; `mc_edit` changes prose outside anchors (an `old` spanning both markers of an anchor deletes that passage: the thread is left unanchored by design \u2014 never re-anchor it to nearby text). Then `mc_reply` with one or two specific sentences quoting what changed." }
  },
  {
    id: "deletion",
    text: `### Phase 4 \u2014 Deletion (opt-in)

You only delete a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"). There is no tool for removing a thread record \u2014 reply that it can go and list it in your report; the human deletes it from the review view.

- Never delete to "clean up". Never delete just because you addressed a comment \u2014 the human resolves.`
  },
  {
    id: "initiate",
    text: `### Phase 5 \u2014 Initiate a new thread (opt-in)

Only **create** a thread when the human explicitly asks \u2014 "leave a comment on X", "flag this for follow-up", "drop a TODO comment here". Never spontaneously, as a reminder to yourself, or mid-maintenance-edit. Works whether the file already has a threads region or not (a fresh file gets one created).

**Pick the passage:** a verbatim, meaningful substring \u2014 a word at minimum, usually a sentence. Code spans, frontmatter, and the threads region are refused for you; judge instead whether it's the *right* span and whether wrapping it would split something markdown cares about (a link target, an image alt, a table cell delimiter). **Open it:** \`mc_open(file, quote: "\u2026", body: "\u2026")\` \u2014 mints an id, wraps the passage, appends the thread line; an ambiguous passage tells you how many matches exist, so re-run with \`occurrence\`. **Verify** with \`mc_check\` (Phase 7).

Adding several threads in one turn? Do them one at a time, re-reading between each \u2014 earlier edits shift the offsets the next anchor depends on.`
  },
  {
    id: "invariants",
    text: `### Phase 6 \u2014 Invariants (inline mode)

These are judgement calls the tools can't make for you. You MUST NOT:

- Change any thread's \`status\` (only the human resolves), or edit any comment other than to APPEND a new one (the record is history).
- Re-anchor an orphaned thread to nearby unrelated text (let it orphan), or move anchor markers without also moving the passage they wrap.
- Initiate a new thread (Phase 5) unless the human explicitly asked \u2014 the Review Mode trigger below counts as an explicit ask and unlocks it.
- Edit prose in Review Mode: there you OPEN threads, never modify doc text. Even obvious typos go in a thread unless told to "fix as you go".
- Reformat the threads region (newlines, key order, escaping) for any reason.

The mechanical invariants \u2014 \`c<N>\` id sequence, thread ids/quotes staying put, threads-region formatting \u2014 are enforced by the tools; the judgement calls above are yours. Reporting isn't exempt either: quote what changed rather than saying "applied", and never say a comment is addressed when it isn't.`,
    brief: { kind: "rule", text: "Only the human resolves: never call `mc_resolve`, `mc_accept` or `mc_reject` unless asked. The record is append-only history \u2014 add replies, never edit or delete anyone's comments." }
  },
  {
    id: "review-mode",
    text: `### Review Mode (inline) \u2014 Claude as the reviewer

When the human's request matches **Review Mode** trigger phrases \u2014 "review this doc", "leave your thoughts on X", "do a review pass on Y", "second pair of eyes on README", "what would you flag in this file", or the Markdown Collab extension's "Ask Agent to Review This Doc" / "Ask Agent to Review These Docs" commands \u2014 you switch from addressing existing comments to **initiating** new review threads. The human will triage them in the sidebar. When the prompt names more than one file, read the *Multi-file review passes* section below before starting.

The mechanics are the same as Phase 5: pick a passage, allocate an id, insert paired markers, append a \`<!--mc:t {\u2026}-->\` line with a single \`c1\` comment authored by \`"claude"\`, verify. Read Phase 5 first if you have not \u2014 it carries the invariants you must respect when wrapping passages.

${reviewRubric(TOOL_VERBS)}

#### Workflow \u2014 Review Mode pass, in short

Read the doc end to end first. Initiate threads one at a time, in document order, with \`mc_open\` \u2014 never edit prose. Narrate long passes with \`mc_status\`. Verify with \`mc_check\`, which also ends the human's wait.`,
    brief: { kind: "rule", text: 'Review mode ("review this doc"): open a thread with `mc_open` for the five most severe concerns, then one summary thread for the rest ("Also noticed (N): \u2026"). Never edit prose.' }
  },
  {
    id: "verify",
    text: `### Phase 7 \u2014 Verify, and end the pass

Finish every file you touched with \`mc_check(file)\`. \`"ok": true\` means every marker is paired, every thread is anchored, and every thread line is valid JSON; otherwise you get the list \u2014 unpaired markers, orphaned anchors, unanchored threads, empty quotes, malformed thread JSON, duplicate ids \u2014 each saying whether it's \`repairable\`.

This call does double duty: it's your correctness check, **and** it's how the extension learns your pass on that file is over \u2014 clearing the "Waiting for the agent\u2026" row the human is watching. Skip it and they're left watching a spinner for work you already finished.

The tools refuse any change that would introduce damage, so anything the check reports was already there \u2014 name it in your report (the human can run **Markdown Collab: Repair Comment Anchors**) rather than trying to fix markers yourself. One case is not damage: **a thread whose passage you deliberately removed is expected to be unanchored.** Deletions become orphans by design \u2014 report it, don't "fix" it by re-anchoring to unrelated text.

Then confirm, from \`mc_list\`, that each addressed thread ends with your comment and is still \`"status":"open"\`.`,
    brief: { kind: "step", text: "Verify \u2014 `mc_check(file)` LAST on every file you touched: it is the integrity check, and it ends the human's wait. `mc_status(note)` narrates a long pass." }
  },
  {
    id: "suggest-mode",
    text: `## Suggest Mode \u2014 propose edits instead of applying them

When the human asks you to **suggest** or **propose** changes rather than make them ("suggest edits", "don't apply, let me accept them", or a send payload requesting suggest mode), do NOT edit the prose directly \u2014 every change becomes a pending suggestion via \`mc_suggest(file, quote: "\u2026", with: "\u2026", note: "why")\`.

The original text stays in the file; the proposal is recorded separately. \`note\` is your rationale, shown on the suggestion card \u2014 always include it. Same anchoring rules as opening a thread: ambiguous, or in code/frontmatter/the threads region, gets refused \u2014 pass \`occurrence\` or pick a different span. **One suggestion changes one sentence or one list item.** Re-read between several so offsets stay valid. A paragraph-level rewrite is split into several suggestions, one per sentence; when it genuinely can't be split (the change reworks the paragraph as a whole), open a comment carrying the proposed text instead of forcing it into one giant suggestion. A \`with\` far longer than the quoted passage is refused (\`suggestion_too_large\`) \u2014 that's the tool telling you to split it, not a limit to work around. **Do NOT accept or reject your own suggestions** \u2014 that's the human's call in the review UI, only on explicit instruction. Verify with \`mc_check\` and \`mc_list\` (reports each suggestion's \`original\` and \`proposed\`).

Mutually exclusive with direct edits per request: if the human wants suggestions, route ALL changes through \`mc_suggest\`, never mix in a few direct edits. Review Mode is unaffected \u2014 it never edits prose at all.`,
    brief: { kind: "rule", text: "Suggest mode: route every change through `mc_suggest` (with a `note`) \u2014 no direct edits at all." }
  },
  {
    id: "maintenance",
    text: `## Every \`.md\` edit goes through the tools

Whenever you change a file that contains \`<!--mc:threads:begin-->\` \u2014 for any reason, not only to address a comment \u2014 make the change with \`mc_edit\` or \`mc_rewrite\`: they refuse an edit that would break a marker, which a plain text edit can't. If you **rewrote an anchored passage**, \`mc_rewrite\` kept its markers on the new wording; if you **removed one**, the thread surfaces as unanchored \u2014 correct, don't re-anchor it to unrelated nearby text. Do NOT change any \`<!--mc:t {\u2026}-->\` line \u2014 only the human reviewer and the reply workflow append to threads. Finish with \`mc_check\`.`
  },
  {
    id: "reporting",
    text: `## Reporting

Tell the user, per file, using each thread's id (1\u201312 char base36) so they can find it in VS Code: threads addressed (+ one-line summary of each change), threads initiated on explicit request (+ anchored passage + the note you left), threads deleted on explicit request, threads left unanchored/orphaned because their target was removed (+ why), threads answered without a prose change (+ the question you replied with), and anything you skipped and why.`
  }
];

// src/skillCli/mdc.ts
var EXIT_OK = 0;
var EXIT_USAGE = 1;
var EXIT_INTEGRITY = 2;
var USAGE = `mdc \u2014 Markdown Collab inline-comment CLI

  mdc list <file> [--actionable]              threads as JSON
  mdc reply <file> <threadId> --body TEXT [--author SLUG]
                                              append a reply authored by claude (or --author);
                                              a resolved thread is reopened ("reopened": true)
  mdc rewrite <file> <threadId> --with TEXT   replace the anchored span, markers preserved
  mdc edit <file> --old TEXT --new TEXT [--occurrence N]
                                              replace exact prose text outside anchored spans
  mdc open <file> --quote TEXT --body TEXT [--occurrence N] [--author SLUG]
                                              open a new thread on a passage
  mdc resolve <file> <threadId> [--author SLUG]
                                              mark a thread resolved
  mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N] [--author SLUG]
                                              propose an edit (accept/reject in the UI)
  mdc accept <file> <anchorId>                apply a pending suggestion
  mdc reject <file> <anchorId>                drop a pending suggestion, keep the original
  mdc check <file> [--repair]                 integrity report; exit 2 if broken
  mdc help review                             the reviewer's rubric \u2014 read it before a review pass
  mdc check --hook                            Claude Code PostToolUse hook: reads the hook JSON on stdin;
                                              exit 2 + report on stderr if the edited .md has broken markers
  mdc guard --hook                            Claude Code PreToolUse hook: exit 2 (the edit is refused) when an
                                              Edit/Write would change a <!--mc:\u2026--> marker or thread line by hand

  --author SLUG applies to reply/open/resolve/suggest \u2014 the agent writing the
  comment. Defaults to "claude"; every headless Claude Code
  run is that default, so nothing changes for it. Sets the comment's JSON
  "agent" flag alongside "author".

  With ${ENV_URL}/_TOKEN set, writes go through the running extension; --direct writes the file itself.

Every command prints JSON to stdout \u2014 on failure {"ok":false,"code":"\u2026","message":"\u2026"}, with the
message also on stderr (check --hook prints only its stderr report). Exit codes: 0 ok, 1 usage or
refused, 2 integrity.`;
function out(obj) {
  writeSync(1, `${JSON.stringify(obj, null, 2)}
`);
}
function fail(message, opts = {}) {
  writeSync(1, `${JSON.stringify({ ok: false, code: opts.code ?? "usage", message })}
`);
  writeSync(2, `mdc: ${message}
${opts.detail ? `
${opts.detail}
` : ""}`);
  process.exit(opts.exit ?? EXIT_USAGE);
}
var EXIT_FOR_CODE = {
  thread_not_found: EXIT_USAGE,
  suggestion_not_found: EXIT_USAGE,
  passage_not_found: EXIT_USAGE,
  passage_ambiguous: EXIT_USAGE,
  not_anchorable: EXIT_USAGE,
  not_editable: EXIT_USAGE,
  unanchored: EXIT_USAGE,
  // Only reachable through the editor's selection path, but the map is
  // exhaustive over DocOpCode on purpose: a new refusal must be given an exit
  // status deliberately rather than defaulting to one.
  empty_selection: EXIT_USAGE,
  out_of_range: EXIT_USAGE,
  nothing_to_do: EXIT_USAGE,
  invalid_arguments: EXIT_USAGE,
  integrity: EXIT_INTEGRITY
};
function refuse(code, message, details, integrityCodes = []) {
  const known = Object.prototype.hasOwnProperty.call(EXIT_FOR_CODE, code);
  const exit = integrityCodes.includes(code) ? EXIT_INTEGRITY : known ? EXIT_FOR_CODE[code] : EXIT_USAGE;
  if (code === "passage_ambiguous") {
    const n = details?.occurrences;
    return fail(`passage appears ${n} times; pass --occurrence 1..${n} to say which one you mean`, { code, exit });
  }
  const hint = code === "unanchored" || code === "integrity" ? " (see `mdc check`)" : "";
  return fail(`${message}${hint}`, { code, exit });
}
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["repair", "actionable", "hook", "direct", "help"]);
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === void 0) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}
function str(flags, name) {
  const v = flags[name];
  if (typeof v !== "string" || v === "") fail(`missing required --${name}`);
  return v;
}
function strAllowEmpty(flags, name) {
  const v = flags[name];
  if (typeof v !== "string") fail(`missing required --${name}`);
  return v;
}
function occurrenceFlag(flags) {
  const v = flags.occurrence;
  if (v === void 0) return 0;
  if (v === true) fail("--occurrence needs a number", { code: "invalid_arguments" });
  try {
    return parseOccurrence(v);
  } catch (e) {
    if (!(e instanceof DocOpError)) throw e;
    return fail(`--occurrence takes a 1-based number, got ${JSON.stringify(v)}`, { code: e.code });
  }
}
function readDoc(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    const err = e;
    return err.code === "ENOENT" ? fail(`no such file: ${file}`, { code: "file_not_found" }) : fail(`cannot read ${file}: ${err.message}`, { code: "io_error" });
  }
}
var REACH_TIMEOUT_MS = 3e3;
var CALL_TIMEOUT_MS = 1e4;
function post(ext, message, sessionId, timeoutMs) {
  return new Promise((resolve4) => {
    let connected = false;
    let settled = false;
    const settle = (a) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4(a);
    };
    const payload = JSON.stringify(message);
    let req;
    try {
      req = request(
        ext.url,
        {
          method: "POST",
          // A fresh connection, closed after: a pooled keep-alive socket
          // would hold this process open after it has printed its answer.
          agent: false,
          headers: {
            authorization: `Bearer ${ext.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": Buffer.byteLength(payload),
            ...sessionId ? { "mcp-session-id": sessionId } : {}
          }
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const header = res.headers["mcp-session-id"];
            settle({
              kind: "answered",
              status: res.statusCode ?? 0,
              sessionId: typeof header === "string" ? header : void 0,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
          res.on("error", (e) => settle({ kind: "lost", reason: e.message }));
          res.on("close", () => settle({ kind: "lost", reason: "connection closed mid-answer" }));
        }
      );
    } catch (e) {
      resolve4({ kind: "unreachable", reason: e.message });
      return;
    }
    const timer = setTimeout(() => {
      settle({ kind: connected ? "lost" : "unreachable", reason: `no answer within ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);
    req.on("socket", (s) => s.once("connect", () => connected = true));
    req.on("error", (e) => settle({ kind: connected ? "lost" : "unreachable", reason: e.message }));
    req.end(payload);
  });
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function rpcResult(body) {
  try {
    const parsed = JSON.parse(body);
    return isObject(parsed) && isObject(parsed.result) ? parsed.result : null;
  } catch {
    return null;
  }
}
async function forward(ext, tool, args, author) {
  const init = await post(
    ext,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: author, version: "mdc" } }
    },
    void 0,
    REACH_TIMEOUT_MS
  );
  if (init.kind !== "answered" || init.status !== 200 || !rpcResult(init.body)) return { kind: "fallback" };
  const call = await post(
    ext,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    init.sessionId,
    CALL_TIMEOUT_MS
  );
  if (call.kind === "unreachable") return { kind: "fallback" };
  if (call.kind === "lost") return { kind: "unknown", reason: call.reason };
  const result = call.status === 200 ? rpcResult(call.body) : null;
  if (!result) return { kind: "fallback" };
  const first = Array.isArray(result.content) ? result.content[0] : void 0;
  const text = isObject(first) && typeof first.text === "string" ? first.text : "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = void 0;
  }
  if (result.isError === true) {
    const err = isObject(payload) && isObject(payload.error) ? payload.error : void 0;
    if (err && typeof err.code === "string" && typeof err.message === "string") {
      return { kind: "refused", code: err.code, message: err.message, details: isObject(err.details) ? err.details : void 0 };
    }
    return { kind: "refused", code: "refused", message: text || "the extension refused the call" };
  }
  return { kind: "applied", result: isObject(payload) ? payload : {} };
}
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
var MCP_PATH = "/mcp";
function extensionFromEnv() {
  const url = process.env[ENV_URL];
  const token = process.env[ENV_TOKEN];
  if (!url || !token) return null;
  return localServer(url, token, ENV_URL);
}
function localServer(url, token, from) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    writeSync(2, `mdc: ${from} is not a valid URL (${JSON.stringify(url)}) \u2014 writing directly
`);
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host) || parsed.pathname !== MCP_PATH) {
    writeSync(2, `mdc: ${from} does not point at the local tool server (${url}) \u2014 writing directly
`);
    return null;
  }
  return { url, token };
}
function extensionFromDescriptor(file) {
  let dir = path3.dirname(path3.resolve(file));
  for (; ; ) {
    const at = path3.join(dir, ...DESCRIPTOR_REL.split("/"));
    let raw = null;
    try {
      raw = readFileSync(at, "utf8");
    } catch {
      raw = null;
    }
    if (raw !== null) {
      let d;
      try {
        d = JSON.parse(raw);
      } catch {
        d = void 0;
      }
      if (isObject(d) && typeof d.url === "string" && typeof d.token === "string" && processAlive(d.pid)) {
        return localServer(d.url, d.token, at);
      }
      return null;
    }
    const parent = path3.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function processAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function extensionFor(file, flags) {
  if (flags.direct === true) return null;
  return extensionFromEnv() ?? extensionFromDescriptor(file);
}
function integrityOkOnDisk(absPath) {
  try {
    return checkIntegrity(readFileSync(absPath, "utf8")).ok;
  } catch {
    return void 0;
  }
}
function writeComputed(file, compute) {
  for (let attempt = 1; ; attempt++) {
    const source = readDoc(file);
    const outcome = compute(source);
    if (!outcome || outcome.next === source) return { source, outcome };
    if (readFileSync(file, "utf8") === source) {
      writeFileSync(file, outcome.next, "utf8");
      return { source, outcome };
    }
    if (attempt === 3) {
      fail(`${file} kept changing while mdc was writing it; nothing was written \u2014 run the command again`, {
        code: "conflict"
      });
    }
  }
}
async function apply(file, m, ext, author) {
  if (ext) {
    readDoc(file);
    const abs = path3.resolve(file);
    const f = await forward(ext, m.tool, { file: abs, ...m.args }, author);
    switch (f.kind) {
      case "applied": {
        const rest = { ...f.result };
        delete rest.action;
        delete rest.file;
        out({ action: m.action, file, ...rest, integrityOk: integrityOkOnDisk(abs), via: "extension" });
        return;
      }
      case "refused":
        if (f.code !== "file_not_found" && f.code !== "no_workspace") {
          return refuse(f.code, f.message, f.details, m.integrityCodes);
        }
        writeSync(2, `mdc: ${file} is not in the extension's workspace \u2014 writing directly
`);
        break;
      case "unknown":
        return fail(
          `the extension at ${ext.url} did not answer (${f.reason}); the ${m.action} may already be applied \u2014 run \`mdc list ${file}\` before retrying`,
          { code: "no_answer" }
        );
      case "fallback":
        writeSync(2, `mdc: extension not reachable at ${ext.url} \u2014 writing directly
`);
        break;
    }
  }
  let outcome;
  try {
    outcome = writeComputed(file, m.run).outcome;
  } catch (e) {
    if (e instanceof DocOpError) return refuse(e.code, e.message, e.details, m.integrityCodes);
    throw e;
  }
  out({ action: m.action, file, ...outcome.result, integrityOk: checkIntegrity(outcome.next).ok });
}
function cmdList(file, actionableOnly) {
  out({ file, ...opList(readDoc(file), actionableOnly) });
}
async function cmdCheck(file, repair, ext, author) {
  if (!repair) {
    if (ext) {
      readDoc(file);
      const f = await forward(ext, "mc_check", { file: path3.resolve(file) }, author);
      if (f.kind === "applied") {
        const rest = { ...f.result };
        delete rest.file;
        out({ file, ...rest, via: "extension" });
        process.exit(rest.ok === true ? EXIT_OK : EXIT_INTEGRITY);
      }
      if (f.kind === "refused" && f.code !== "file_not_found" && f.code !== "no_workspace") {
        return refuse(f.code, f.message, f.details);
      }
      if (f.kind === "unknown") {
        return fail(
          `the extension at ${ext.url} did not answer (${f.reason}); run \`mdc check ${file}\` again`,
          { code: "no_answer" }
        );
      }
      writeSync(2, `mdc: checking ${file} directly
`);
    }
    let report;
    const { outcome } = writeComputed(file, (source) => {
      const checked = opCheckAndCheckpoint(source);
      report = checked.report;
      return checked.next !== void 0 && checked.checkpoint ? { next: checked.next, result: checked.checkpoint } : null;
    });
    out(outcome ? { file, ...report, checkpointed: outcome.result.ts } : { file, ...report });
    process.exit(report.ok ? EXIT_OK : EXIT_INTEGRITY);
  }
  let result;
  writeComputed(file, (source) => {
    result = repairIntegrity(source);
    if (result.source === source) return null;
    if (stripAllInlineMarkup(result.source) !== stripAllInlineMarkup(source)) {
      fail("internal error: repair would have altered prose; nothing was written", {
        code: "integrity",
        exit: EXIT_INTEGRITY
      });
    }
    return { next: result.source, result: null };
  });
  out({
    file,
    repaired: result.repairs.length,
    repairs: result.repairs,
    ok: result.remaining.length === 0,
    remaining: result.remaining.map((i) => ({
      kind: i.kind,
      threadId: i.threadId,
      repairable: i.repairable,
      message: i.message
    }))
  });
  process.exit(result.remaining.length === 0 ? EXIT_OK : EXIT_INTEGRITY);
}
var realHookIo = {
  readFile(absPath) {
    try {
      if (!statSync(absPath).isFile()) return null;
      return readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  },
  cwd: () => process.cwd()
};
function cmdCheckHook(run = runCheckHook) {
  let stdinText;
  try {
    stdinText = readFileSync(0, "utf8");
  } catch {
    process.exit(EXIT_OK);
  }
  const outcome = run(stdinText, realHookIo);
  if (outcome.stderr) writeSync(2, outcome.stderr);
  process.exit(outcome.exitCode);
}
async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  if (flags.help === true) {
    writeSync(1, `${USAGE}
`);
    process.exit(EXIT_OK);
  }
  const [command, ...rest] = _;
  if (command === void 0) fail("no command given", { detail: USAGE });
  if (command === "help") {
    writeSync(1, rest[0] === "review" ? renderReviewGuide() : `${USAGE}
`);
    process.exit(EXIT_OK);
  }
  const author = typeof flags.author === "string" && flags.author !== "" ? flags.author : "claude";
  const mutate = (file, m) => apply(file, m, extensionFor(file, flags), author);
  switch (command) {
    case "list":
      if (!rest[0]) fail("usage: mdc list <file> [--actionable]");
      return cmdList(rest[0], flags.actionable === true);
    case "reply": {
      if (!rest[0] || !rest[1]) fail("usage: mdc reply <file> <threadId> --body TEXT [--author SLUG]");
      const threadId = rest[1];
      const body = str(flags, "body");
      return mutate(rest[0], {
        action: "reply",
        tool: "mc_reply",
        args: { threadId, body },
        // `run` is only the direct write — the forwarded one runs `mc_reply`,
        // which stamps "tools" itself.
        run: (s) => opReply(s, threadId, body, void 0, author, true, "cli")
      });
    }
    case "rewrite": {
      if (!rest[0] || !rest[1]) fail("usage: mdc rewrite <file> <threadId> --with TEXT");
      const threadId = rest[1];
      const replacement = str(flags, "with");
      return mutate(rest[0], {
        action: "rewrite",
        tool: "mc_rewrite",
        args: { threadId, with: replacement },
        run: (s) => opRewrite(s, threadId, replacement)
      });
    }
    case "edit": {
      if (!rest[0]) fail("usage: mdc edit <file> --old TEXT --new TEXT [--occurrence N]");
      const old = str(flags, "old");
      const replacement = strAllowEmpty(flags, "new");
      const occurrence = occurrenceFlag(flags);
      return mutate(rest[0], {
        action: "edit",
        tool: "mc_edit",
        args: { old, new: replacement, occurrence },
        run: (s) => opEdit(s, old, replacement, occurrence)
      });
    }
    case "open": {
      if (!rest[0]) fail("usage: mdc open <file> --quote TEXT --body TEXT [--occurrence N] [--author SLUG]");
      const quote = str(flags, "quote");
      const body = str(flags, "body");
      const occurrence = occurrenceFlag(flags);
      return mutate(rest[0], {
        action: "open",
        tool: "mc_open",
        args: { quote, body, occurrence },
        run: (s) => opOpen(s, quote, body, occurrence, void 0, author, "cli")
      });
    }
    case "resolve": {
      if (!rest[0] || !rest[1]) fail("usage: mdc resolve <file> <threadId> [--author SLUG]");
      const threadId = rest[1];
      return mutate(rest[0], {
        action: "resolve",
        tool: "mc_resolve",
        args: { threadId },
        run: (s) => opResolve(s, threadId, void 0, author)
      });
    }
    case "suggest": {
      if (!rest[0]) {
        fail("usage: mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N] [--author SLUG]");
      }
      const quote = str(flags, "quote");
      const proposed = str(flags, "with");
      const note = typeof flags.note === "string" ? flags.note : void 0;
      const occurrence = occurrenceFlag(flags);
      return mutate(rest[0], {
        action: "suggest",
        tool: "mc_suggest",
        args: { quote, with: proposed, note, occurrence },
        run: (s) => opSuggest(s, quote, proposed, { note, occurrence }, void 0, author, "cli")
      });
    }
    case "accept": {
      if (!rest[0] || !rest[1]) fail("usage: mdc accept <file> <anchorId>");
      const anchorId = rest[1];
      return mutate(rest[0], {
        action: "accept",
        tool: "mc_accept",
        args: { anchorId },
        run: (s) => opAccept(s, anchorId),
        // A suggestion that lost its markers is a damaged document, not a typo
        // in the command — exit 2 so a wrapper can tell the two apart.
        integrityCodes: ["unanchored"]
      });
    }
    case "reject": {
      if (!rest[0] || !rest[1]) fail("usage: mdc reject <file> <anchorId>");
      const anchorId = rest[1];
      return mutate(rest[0], {
        action: "reject",
        tool: "mc_reject",
        args: { anchorId },
        run: (s) => opReject(s, anchorId)
      });
    }
    case "check":
      if (flags.hook === true) return cmdCheckHook();
      if (!rest[0]) fail("usage: mdc check <file> [--repair]");
      return cmdCheck(rest[0], flags.repair === true, extensionFor(rest[0], flags), author);
    case "guard":
      if (flags.hook !== true) fail("usage: mdc guard --hook (Claude Code PreToolUse hook; reads the hook JSON on stdin)");
      return cmdCheckHook(runGuardHook);
    default:
      fail(`unknown command: ${command}`, { detail: USAGE });
  }
}
main().catch((e) => fail(`internal error: ${e.message}`, { code: "internal_error" }));
