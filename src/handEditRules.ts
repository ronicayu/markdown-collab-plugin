/** Where the format contract lives. The `docs/` folder isn't in the .vsix, so
 *  the link goes to the repository rather than to a path in the workspace. */
export const FORMAT_SPEC_URL = "https://github.com/ronicayu/markdown-collab-plugin/blob/main/docs/format.md";

export const HAND_EDIT_RULES: readonly string[] = [
  `**Reply:** append \`{"id":"c<next>","parent":"<last-comment-id>","author":"<you>","agent":true,"ts":"<ISO-8601 UTC>","body":"<what you did>"}\` to the \`comments\` array on the thread's \`<!--mc:t {…}-->\` line. Never change \`status\`; never edit or remove an existing comment.`,
  `**New thread**, only on explicit request ("leave a comment on X"): pick an unused 5-character id from \`0-9a-z\`, wrap the passage in \`<!--mc:a:ID-->…<!--mc:/a:ID-->\`, and add a line \`<!--mc:t {"id":"ID","quote":"<the passage>","status":"open","comments":[{"id":"c1","author":"<you>","agent":true,"ts":"<ISO-8601 UTC>","body":"<the comment>"}]}-->\` just before \`<!--mc:threads:end-->\` (no block yet: add both fence lines at the very end of the file, after a blank line).`,
  `**Suggesting an edit**, when asked to suggest rather than change: leave the passage's text as it is, wrap it in \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` with an unused id as above, and add a line \`<!--mc:s {"anchorId":"ID","author":"<you>","agent":true,"ts":"<ISO-8601 UTC>","original":"<the wrapped text>","proposed":"<the replacement>"}-->\` in the same place. Add \`"threadId":"<id>"\` to answer a thread, \`"note":"<why>"\` for a one-line reason. The reviewer accepts or rejects it in the editor.`,
  `**On a heading line, or the document title,** the opening marker goes after the \`#\`s and the space and the closing marker at the end of the heading text — \`## <!--mc:a:ID-->Title<!--mc:/a:ID-->\` — and \`quote\` is the heading text alone; a marker before the \`#\`s stops the line being a heading.`,
  `**Rewriting an anchored passage** keeps both markers on the new wording; removing the passage deletes both markers and leaves the thread unanchored — the correct outcome, don't re-anchor to nearby text.`,
  `Never type inside a marker or put one in a code block or the frontmatter. Inside JSON strings, write \`-->\` as \`--\\u003e\` and \`<!--\` as \`\\u003c!--\`.`,
];
