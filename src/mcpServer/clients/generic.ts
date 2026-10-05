// The fallback for any MCP-capable agent we haven't verified against —
// 10x-plan-4 P1.1.
//
// Every other writer in this folder puts something on disk that a client
// reads unattended. This one writes nothing: we don't know how the unnamed
// client wants its config, and handing an unknown client a bare token in a
// file with no expiry policy behind it is the one mistake this whole
// initiative exists to avoid. Instead: an untitled scratch buffer, shown
// once, that only the human sees — they copy what their agent needs.

export type SnippetClient = "generic" | "windsurf";

function windsurfSection(url: string, token: string): string[] {
  const snippet = {
    mcpServers: {
      "markdown-collab": {
        serverUrl: url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  return [
    "## Windsurf (Cascade)",
    "",
    "Paste this under `mcpServers` in `~/.codeium/windsurf/mcp_config.json`",
    "(Windsurf → Settings → Cascade → MCP Servers → View raw config), then press",
    "Refresh in that panel. Windsurf uses `serverUrl` for HTTP servers.",
    "",
    "```json",
    JSON.stringify(snippet, null, 2),
    "```",
    "",
    "The token changes every time this window reloads, so this entry has to be",
    "pasted again after a reload; without it Cascade still works from AGENTS.md.",
    "",
    "These Windsurf keys have not been verified against a real Windsurf install — if",
    "Cascade doesn't list the tools, try the generic snippet below.",
    "",
  ];
}

export function genericSnippet(url: string, token: string, client: SnippetClient = "generic"): string {
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
    "This token is only valid for this editor session — it stops working",
    "the moment this window reloads or closes. Prefer an env-var reference over",
    "pasting the token below if your agent supports one (it inherits",
    "MARKDOWN_COLLAB_MCP_URL / MARKDOWN_COLLAB_MCP_TOKEN from any terminal this",
    "window spawns).",
    "",
    `URL: ${url}`,
    `Authorization header: Bearer ${token}`,
    "",
    ...(client === "windsurf" ? windsurfSection(url, token) : []),
    "Generic `mcpServers` snippet, for a client that reads that shape:",
    "",
    "```json",
    JSON.stringify(snippet, null, 2),
    "```",
    "",
  ].join("\n");
}
