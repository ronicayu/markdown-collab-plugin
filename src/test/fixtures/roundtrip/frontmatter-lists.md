---
title: Design Notes
status: draft
tags: [markdown, review, collab]
---

# Design Notes 🎨

Frontmatter is stripped from the preview, so anchors must never land in
it. Emoji in prose 🚀 must not corrupt offsets — they are multi-byte and
the 0.34.24 NUL-byte bug lived in exactly this neighbourhood.

## Open Questions

1. Should suggestions be a thread variant or their own marker kind?
   - A variant reuses the format engine 👍
   - A new kind needs its own parser 👎
2. How do we surface a damaged thread without a modal?
   - Inline badge in the sidebar
   - Status-bar item

### Nested detail

- Outer item
  - Inner item with `inline code` and a [link](https://example.com)
  - Another inner item — em dashes, "smart quotes", and ellipses…

Short words like a, an, and the appear many times, which makes them
unsafe quote-recovery targets by design.
