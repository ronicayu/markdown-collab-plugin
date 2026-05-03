import { describe, expect, it } from "vitest";
import { isExternalLinkSafe } from "../collab/urlAllowlist";

describe("isExternalLinkSafe", () => {
  it("accepts http / https URLs", () => {
    expect(isExternalLinkSafe("http://example.com")).toBe(true);
    expect(isExternalLinkSafe("https://example.com/path?q=1#a")).toBe(true);
  });

  it("accepts mailto: URLs", () => {
    expect(isExternalLinkSafe("mailto:user@example.com")).toBe(true);
    expect(isExternalLinkSafe("mailto:user@example.com?subject=hi")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isExternalLinkSafe("javascript:alert(1)")).toBe(false);
    expect(isExternalLinkSafe("JAVASCRIPT:alert(1)")).toBe(false);
  });

  it("rejects file: URLs", () => {
    expect(isExternalLinkSafe("file:///etc/passwd")).toBe(false);
  });

  it("rejects vscode-webview: and other custom schemes", () => {
    expect(isExternalLinkSafe("vscode-webview://something")).toBe(false);
    expect(isExternalLinkSafe("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects empty strings, null-ish, and non-strings", () => {
    expect(isExternalLinkSafe("")).toBe(false);
    expect(isExternalLinkSafe(undefined as unknown as string)).toBe(false);
    expect(isExternalLinkSafe(null as unknown as string)).toBe(false);
    expect(isExternalLinkSafe(42 as unknown as string)).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isExternalLinkSafe("not a url")).toBe(false);
    expect(isExternalLinkSafe("http:")).toBe(false);
  });

  it("rejects URLs with embedded control characters (header injection guard)", () => {
    expect(isExternalLinkSafe("mailto:user@example.com\r\nbcc:attacker@x.com")).toBe(false);
    expect(isExternalLinkSafe("https://example.com/foo\nbar")).toBe(false);
    expect(isExternalLinkSafe("https://example.com/\x00")).toBe(false);
    expect(isExternalLinkSafe("https://example.com/\x7f")).toBe(false);
  });

  it("rejects URLs with TAB characters", () => {
    expect(isExternalLinkSafe("https://example.com/\t")).toBe(false);
  });

  it("rejects URLs with CR alone", () => {
    expect(isExternalLinkSafe("https://example.com/\r")).toBe(false);
  });

  it("accepts an https URL with port number + query + fragment", () => {
    expect(isExternalLinkSafe("https://example.com:8443/path?q=1&r=2#section")).toBe(true);
  });

  it("rejects ftp:// (not in allowlist)", () => {
    expect(isExternalLinkSafe("ftp://example.com")).toBe(false);
  });

  it("rejects ssh:// and git+https:// (not in allowlist)", () => {
    expect(isExternalLinkSafe("ssh://user@host")).toBe(false);
    expect(isExternalLinkSafe("git+https://example.com/repo.git")).toBe(false);
  });

  it("accepts URLs with spaces (URL parser percent-encodes them; OS opener handles it)", () => {
    // Space is 0x20 — passes the control-char check. The URL parser
    // accepts and normalises by percent-encoding.
    expect(isExternalLinkSafe("https://example.com/has space")).toBe(true);
  });

  it("treats scheme-case insensitively for mailto:", () => {
    expect(isExternalLinkSafe("MAILTO:a@b.com")).toBe(true);
    expect(isExternalLinkSafe("MailTo:a@b.com")).toBe(true);
  });

  it("treats scheme-case insensitively for http: and https:", () => {
    // URL parser normalises scheme; both should pass.
    expect(isExternalLinkSafe("HTTP://example.com")).toBe(true);
    expect(isExternalLinkSafe("HTTPS://example.com")).toBe(true);
  });
});
