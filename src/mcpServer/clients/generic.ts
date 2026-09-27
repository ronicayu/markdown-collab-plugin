// The fallback for any MCP-capable agent we haven't verified against —
// 10x-plan-4 P1.1.
//
// Every other writer in this folder puts something on disk that a client
// reads unattended. This one writes nothing: we don't know how the unnamed
// client wants its config, and handing an unknown client a bare token in a
// file with no expiry policy behind it is the one mistake this whole
// initiative exists to avoid. Instead: an untitled scratch buffer, shown
// once, that only the human sees — they copy what their agent needs.

export function genericSnippet(url: string, token: string): string {
  const snippet = {
    mcpServers: {
      "markdown-collab": {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  return [
    "# Connect Markdown Collab's review tools",
    "",
    "This token is only valid for the current VS Code session — it stops working",
    "the moment this window reloads or closes. Prefer an env-var reference over",
    "pasting the token below if your agent supports one (it inherits",
    "MARKDOWN_COLLAB_MCP_URL / MARKDOWN_COLLAB_MCP_TOKEN from any terminal this",
    "window spawns).",
    "",
    `URL: ${url}`,
    `Authorization header: Bearer ${token}`,
    "",
    "Generic `mcpServers` snippet, for a client that reads that shape:",
    "",
    "```json",
    JSON.stringify(snippet, null, 2),
    "```",
    "",
  ].join("\n");
}
