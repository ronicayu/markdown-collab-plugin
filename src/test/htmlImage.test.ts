// Recognizing an `<img>` written as raw HTML — and refusing everything else.
//
// Every review surface escapes raw HTML on purpose (the document under review
// may be untrusted). This narrows a hole in that posture rather than opening
// it: only a lone image is recognized, only whitelisted attributes survive, and
// anything carrying script renders as the escaped text it always did.

import { describe, expect, it } from "vitest";
import { parseHtmlImage } from "../webviewShared/htmlImage";

describe("parseHtmlImage — the cases markdown can't express", () => {
  it("reads src, alt, title and dimensions", () => {
    const img = parseHtmlImage('<img src="a.png" alt="A" title="T" width="400" height="20">')!;
    expect(img).toMatchObject({ src: "a.png", alt: "A", title: "T", width: "400", height: "20" });
  });

  it("handles a centering wrapper, the commonest README pattern", () => {
    const img = parseHtmlImage('<p align="center"><img src="../d/x.png" width="60%"></p>')!;
    expect(img.src).toBe("../d/x.png");
    expect(img.centered).toBe(true);
    expect(img.width).toBe("60%");
  });

  it("accepts single quotes and unquoted attribute values", () => {
    expect(parseHtmlImage("<img src='a.png'>")!.src).toBe("a.png");
    expect(parseHtmlImage("<img src=a.png>")!.src).toBe("a.png");
  });

  it("accepts a self-closing tag and an anchor wrapper", () => {
    expect(parseHtmlImage('<a href="x"><img src="a.png" /></a>')!.src).toBe("a.png");
  });
});

describe("parseHtmlImage — what it refuses", () => {
  const refused = [
    ["no image at all", "<div>hello</div>"],
    ["two images", '<img src="a.png"><img src="b.png">'],
    ["prose around the image", '<p>see <img src="a.png"> here</p>'],
    ["a script", '<script>alert(1)</script>'],
    ["an iframe wrapper", '<iframe><img src="a.png"></iframe>'],
    ["an event handler on the image", '<img src="a.png" onerror="alert(1)">'],
    ["an event handler on the wrapper", '<p onclick="alert(1)"><img src="a.png"></p>'],
    ["a javascript: src", '<img src="javascript:alert(1)">'],
    ["a vbscript: src", '<img src="vbscript:msgbox">'],
    ["an html data: url", '<img src="data:text/html,<script>alert(1)</script>">'],
    ["no src", "<img alt=\"nothing\">"],
    ["an expression in style", '<img src="a.png" style="width:expression(alert(1))">'],
  ] as const;

  for (const [name, html] of refused) {
    it(`refuses ${name}`, () => {
      expect(parseHtmlImage(html)).toBeNull();
    });
  }

  it("allows an image data: url, which is a real picture", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(parseHtmlImage(`<img src="${src}">`)!.src).toBe(src);
  });

  it("drops a dimension that isn't a plain number", () => {
    const img = parseHtmlImage('<img src="a.png" width="calc(100% - 3px)" height="10">')!;
    expect(img.width).toBeUndefined();
    expect(img.height).toBe("10");
  });

  it("keeps only whitelisted attributes — nothing else survives", () => {
    const img = parseHtmlImage('<img src="a.png" srcset="evil" class="x" style="color:red">')!;
    expect(Object.keys(img).filter((k) => img[k as keyof typeof img] !== undefined).sort()).toEqual(
      ["src"],
    );
  });
});
