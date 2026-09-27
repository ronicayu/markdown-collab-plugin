#!/usr/bin/env node
// src/skillCli/mdc.ts
import { writeSync } from "node:fs";
import { readFileSync, statSync, writeFileSync } from "node:fs";

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
        comments: Array.isArray(obj.comments) ? obj.comments.filter(isValidComment) : [],
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
    comments: [{ id: "c1", author: comment.author, ts, body: comment.body }],
    // The author is looking at this text right now, so it is the baseline the
    // "text changed since this comment" badge compares against (P1.3).
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
function locatePassage(source, quote, occurrence = 0) {
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
    return last !== void 0 && last.author !== "claude";
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
      comments: t.comments.filter((c) => !c.deleted).map((c) => ({ id: c.id, author: c.author, ts: c.ts, body: c.body }))
    };
  });
  const suggestions = parsed.suggestions.map((s) => {
    const a = parsed.anchors.get(s.anchorId);
    return {
      anchorId: s.anchorId,
      threadId: s.threadId,
      author: s.author,
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
function opReply(source, threadId, body, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const thread = findThread(source, threadId);
  const replied = withRefreshedAnchorHash(
    parse(source),
    appendReply(thread, { author: "claude", body, ts: now() })
  );
  const next = replaceThread(source, threadId, replied);
  assertNoNewIssues(source, next);
  const updated = findThread(next, threadId);
  return {
    next,
    result: { threadId, commentId: updated.comments[updated.comments.length - 1].id }
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
function opOpen(source, quote, body, occurrence = 0, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const at = locatePassage(source, quote, occurrence);
  let result;
  try {
    result = addThread(source, at, at + quote.length, { author: "claude", body, ts: now() });
  } catch (e) {
    throw new DocOpError("not_anchorable", e.message, { quote });
  }
  assertNoNewIssues(source, result.source);
  return { next: result.source, result: { threadId: result.thread.id, quote } };
}
function opResolve(source, threadId, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const thread = findThread(source, threadId);
  const next = replaceThread(source, threadId, {
    ...thread,
    status: "resolved",
    resolvedBy: "claude",
    resolvedTs: now()
  });
  assertNoNewIssues(source, next);
  return { next, result: { threadId } };
}
function opSuggest(source, quote, proposed, opts = {}, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const at = locatePassage(source, quote, opts.occurrence ?? 0);
  let result;
  try {
    result = addSuggestion(source, at, at + quote.length, {
      author: "claude",
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

// src/skillCli/checkHook.ts
import * as path from "node:path";
var SILENT_OK = { exitCode: 0, stderr: "" };
var THREADS_BEGIN_MARKER = "<!--mc:threads:begin-->";
var MAX_ISSUE_LINES = 10;
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
  const errors = opCheck(content).issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return SILENT_OK;
  return { exitCode: 2, stderr: formatReport(filePath, errors) };
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

// src/skillCli/mdc.ts
var EXIT_OK = 0;
var EXIT_USAGE = 1;
var EXIT_INTEGRITY = 2;
var USAGE = `mdc \u2014 Markdown Collab inline-comment CLI

  mdc list <file> [--actionable]              threads as JSON
  mdc reply <file> <threadId> --body TEXT     append a reply authored by claude
  mdc rewrite <file> <threadId> --with TEXT   replace the anchored span, markers preserved
  mdc edit <file> --old TEXT --new TEXT [--occurrence N]
                                              replace exact prose text outside anchored spans
  mdc open <file> --quote TEXT --body TEXT [--occurrence N]
                                              open a new thread on a passage
  mdc resolve <file> <threadId>               mark a thread resolved
  mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N]
                                              propose an edit (accept/reject in the UI)
  mdc accept <file> <anchorId>                apply a pending suggestion
  mdc reject <file> <anchorId>                drop a pending suggestion, keep the original
  mdc check <file> [--repair]                 integrity report; exit 2 if broken
  mdc check --hook                            Claude Code PostToolUse hook: reads the hook JSON on stdin;
                                              exit 2 + report on stderr if the edited .md has broken markers

All commands print JSON to stdout. Exit codes: 0 ok, 1 usage, 2 integrity.`;
function out(obj) {
  writeSync(1, `${JSON.stringify(obj, null, 2)}
`);
}
function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`mdc: ${message}
`);
  process.exit(code);
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
  integrity: EXIT_INTEGRITY
};
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
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
function readDoc(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    const err = e;
    return fail(err.code === "ENOENT" ? `no such file: ${file}` : `cannot read ${file}: ${err.message}`);
  }
}
function apply(file, action, run, opts = {}) {
  const source = readDoc(file);
  let outcome;
  try {
    outcome = run(source);
  } catch (e) {
    if (e instanceof DocOpError) {
      const escalated = opts.integrityCodes?.includes(e.code) ? EXIT_INTEGRITY : EXIT_FOR_CODE[e.code];
      const hint = e.code === "unanchored" || e.code === "integrity" ? " (see `mdc check`)" : "";
      if (e.code === "passage_ambiguous") {
        const n = e.details?.occurrences;
        return fail(
          `passage appears ${n} times; pass --occurrence 1..${n} to say which one you mean`,
          escalated
        );
      }
      return fail(`${e.message}${hint}`, escalated);
    }
    throw e;
  }
  writeFileSync(file, outcome.next, "utf8");
  out({ action, file, ...outcome.result, integrityOk: checkIntegrity(outcome.next).ok });
}
function cmdList(file, actionableOnly) {
  out({ file, ...opList(readDoc(file), actionableOnly) });
}
function cmdReply(file, threadId, body) {
  apply(file, "reply", (s) => opReply(s, threadId, body));
}
function cmdRewrite(file, threadId, replacement) {
  apply(file, "rewrite", (s) => opRewrite(s, threadId, replacement));
}
function cmdOpen(file, quote, body, occurrence) {
  apply(file, "open", (s) => opOpen(s, quote, body, occurrence));
}
function cmdEdit(file, old, replacement, occurrence) {
  apply(file, "edit", (s) => opEdit(s, old, replacement, occurrence));
}
function cmdResolve(file, threadId) {
  apply(file, "resolve", (s) => opResolve(s, threadId));
}
function cmdSuggest(file, quote, proposed, note, occurrence) {
  apply(file, "suggest", (s) => opSuggest(s, quote, proposed, { note, occurrence }));
}
function cmdAccept(file, anchorId) {
  apply(file, "accept", (s) => opAccept(s, anchorId), { integrityCodes: ["unanchored"] });
}
function cmdReject(file, anchorId) {
  apply(file, "reject", (s) => opReject(s, anchorId));
}
function cmdCheck(file, repair) {
  const source = readDoc(file);
  if (!repair) {
    const report = opCheck(source);
    out({ file, ...report });
    process.exit(report.ok ? EXIT_OK : EXIT_INTEGRITY);
  }
  const result = repairIntegrity(source);
  if (result.source !== source) {
    if (stripAllInlineMarkup(result.source) !== stripAllInlineMarkup(source)) {
      fail("internal error: repair would have altered prose; nothing was written", EXIT_INTEGRITY);
    }
    writeFileSync(file, result.source, "utf8");
  }
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
function cmdCheckHook() {
  let stdinText;
  try {
    stdinText = readFileSync(0, "utf8");
  } catch {
    process.exit(EXIT_OK);
  }
  const outcome = runCheckHook(stdinText, realHookIo);
  if (outcome.stderr) writeSync(2, outcome.stderr);
  process.exit(outcome.exitCode);
}
function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    writeSync(1, `${USAGE}
`);
    process.exit(argv.length === 0 ? EXIT_USAGE : EXIT_OK);
  }
  const { _, flags } = parseArgs(argv);
  const [command, ...rest] = _;
  switch (command) {
    case "list":
      if (!rest[0]) fail("usage: mdc list <file> [--actionable]");
      return cmdList(rest[0], flags.actionable === true);
    case "reply":
      if (!rest[0] || !rest[1]) fail("usage: mdc reply <file> <threadId> --body TEXT");
      return cmdReply(rest[0], rest[1], str(flags, "body"));
    case "rewrite":
      if (!rest[0] || !rest[1]) fail("usage: mdc rewrite <file> <threadId> --with TEXT");
      return cmdRewrite(rest[0], rest[1], str(flags, "with"));
    case "edit":
      if (!rest[0]) fail("usage: mdc edit <file> --old TEXT --new TEXT [--occurrence N]");
      return cmdEdit(
        rest[0],
        str(flags, "old"),
        strAllowEmpty(flags, "new"),
        typeof flags.occurrence === "string" ? Number(flags.occurrence) : 0
      );
    case "open":
      if (!rest[0]) fail("usage: mdc open <file> --quote TEXT --body TEXT [--occurrence N]");
      return cmdOpen(
        rest[0],
        str(flags, "quote"),
        str(flags, "body"),
        typeof flags.occurrence === "string" ? Number(flags.occurrence) : 0
      );
    case "resolve":
      if (!rest[0] || !rest[1]) fail("usage: mdc resolve <file> <threadId>");
      return cmdResolve(rest[0], rest[1]);
    case "suggest":
      if (!rest[0]) fail("usage: mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N]");
      return cmdSuggest(
        rest[0],
        str(flags, "quote"),
        str(flags, "with"),
        typeof flags.note === "string" ? flags.note : void 0,
        typeof flags.occurrence === "string" ? Number(flags.occurrence) : 0
      );
    case "accept":
      if (!rest[0] || !rest[1]) fail("usage: mdc accept <file> <anchorId>");
      return cmdAccept(rest[0], rest[1]);
    case "reject":
      if (!rest[0] || !rest[1]) fail("usage: mdc reject <file> <anchorId>");
      return cmdReject(rest[0], rest[1]);
    case "check":
      if (flags.hook === true) return cmdCheckHook();
      if (!rest[0]) fail("usage: mdc check <file> [--repair]");
      return cmdCheck(rest[0], flags.repair === true);
    default:
      fail(`unknown command: ${command}

${USAGE}`);
  }
}
main();
