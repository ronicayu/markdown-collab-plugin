import { describe, it, expect } from "vitest";
import { resolveImageSrc, type ImageBaseUris } from "../webviewShared/imageSrc";

const BASES: ImageBaseUris = {
  docDir: "https://h.vscode-cdn.net/Users/ron/proj/docs",
  workspaceFolder: "https://h.vscode-cdn.net/Users/ron/proj",
};

describe("resolveImageSrc", () => {
  it("resolves a sibling image against the doc directory", () => {
    expect(resolveImageSrc("shot.png", BASES)).toBe(
      "https://h.vscode-cdn.net/Users/ron/proj/docs/shot.png",
    );
  });

  it("resolves a ./ image against the doc directory", () => {
    expect(resolveImageSrc("./img/a.png", BASES)).toBe(
      "https://h.vscode-cdn.net/Users/ron/proj/docs/img/a.png",
    );
  });

  it("climbs out of the doc directory for a ../ image (the reported bug)", () => {
    expect(resolveImageSrc("../diagrams/tn5.png", BASES)).toBe(
      "https://h.vscode-cdn.net/Users/ron/proj/diagrams/tn5.png",
    );
  });

  it("handles multiple ../ levels", () => {
    expect(resolveImageSrc("../../assets/x.png", BASES)).toBe(
      "https://h.vscode-cdn.net/Users/ron/assets/x.png",
    );
  });

  it("resolves a leading-/ image against the workspace folder", () => {
    expect(resolveImageSrc("/assets/logo.png", BASES)).toBe(
      "https://h.vscode-cdn.net/Users/ron/proj/assets/logo.png",
    );
  });

  it("percent-encodes spaces in the path", () => {
    expect(resolveImageSrc("../diagrams/my file.png", BASES)).toBe(
      "https://h.vscode-cdn.net/Users/ron/proj/diagrams/my%20file.png",
    );
  });

  it("leaves http(s), data, and protocol-relative URLs alone (modulo //)", () => {
    expect(resolveImageSrc("https://x.com/a.png", BASES)).toBe("https://x.com/a.png");
    expect(resolveImageSrc("data:image/png;base64,AAAA", BASES)).toBe("data:image/png;base64,AAAA");
    expect(resolveImageSrc("//cdn.x.com/a.png", BASES)).toBe("https://cdn.x.com/a.png");
  });

  it("returns the src unchanged when no base URIs are available", () => {
    expect(resolveImageSrc("../diagrams/x.png", { docDir: "", workspaceFolder: null })).toBe(
      "../diagrams/x.png",
    );
    expect(resolveImageSrc("/abs.png", { docDir: "d", workspaceFolder: null })).toBe("/abs.png");
  });
});
