type ValueCheck = (value: string) => boolean;

const tokens = (v: string): string[] => v.match(/[a-z-]+\([^)]*\)|\S+/gi) ?? [];
const words =
  (...allowed: string[]): ValueCheck =>
  (v) =>
    allowed.includes(v);

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.,%\s/-]*\)$/i;
const COLOR_NAME = /^[a-z]{3,30}$/i;
const LENGTH = /^(?:0|\d*\.?\d+(?:px|em|rem|%|pt|ex|ch|vw|vh)?)$/i;

const color: ValueCheck = (v) => HEX_COLOR.test(v) || COLOR_FN.test(v) || COLOR_NAME.test(v);
const length: ValueCheck = (v) => LENGTH.test(v);
const lengthOrAuto: ValueCheck = (v) => length(v) || v === "auto";
const lengthOrNone: ValueCheck = (v) => lengthOrAuto(v) || v === "none";
const BORDER_STYLES = ["none", "solid", "dashed", "dotted", "double"];
const FONT_SIZES = ["xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "smaller", "larger"];

const each =
  (item: ValueCheck, max: number): ValueCheck =>
  (v) => {
    const t = tokens(v);
    return t.length >= 1 && t.length <= max && t.every(item);
  };

const border: ValueCheck = each((t) => length(t) || BORDER_STYLES.includes(t) || color(t), 3);

const PROPERTIES: Record<string, ValueCheck> = {
  color,
  "background-color": color,
  background: color,
  "font-size": (v) => length(v) || FONT_SIZES.includes(v),
  "font-weight": (v) => ["normal", "bold", "bolder", "lighter"].includes(v) || /^[1-9]00$/.test(v),
  "font-style": words("normal", "italic", "oblique"),
  "font-family": (v) => /^[a-z0-9 _-]+(?:\s*,\s*[a-z0-9 _-]+)*$/i.test(v),
  "line-height": (v) => length(v) || v === "normal",
  "letter-spacing": (v) => length(v) || v === "normal",
  "text-align": words("left", "right", "center", "justify"),
  "text-decoration": each(words("none", "underline", "overline", "line-through"), 3),
  "text-transform": words("none", "uppercase", "lowercase", "capitalize"),
  "text-indent": length,
  "vertical-align": words("baseline", "top", "middle", "bottom", "sub", "super", "text-top", "text-bottom"),
  "white-space": words("normal", "nowrap", "pre", "pre-wrap", "pre-line"),
  width: lengthOrAuto,
  height: lengthOrAuto,
  "min-width": lengthOrAuto,
  "min-height": lengthOrAuto,
  "max-width": lengthOrNone,
  "max-height": lengthOrNone,
  margin: each(lengthOrAuto, 4),
  "margin-top": lengthOrAuto,
  "margin-right": lengthOrAuto,
  "margin-bottom": lengthOrAuto,
  "margin-left": lengthOrAuto,
  padding: each(length, 4),
  "padding-top": length,
  "padding-right": length,
  "padding-bottom": length,
  "padding-left": length,
  border,
  "border-top": border,
  "border-right": border,
  "border-bottom": border,
  "border-left": border,
  "border-color": each(color, 4),
  "border-style": each(words(...BORDER_STYLES), 4),
  "border-width": each(length, 4),
  "border-radius": each(length, 4),
  "border-collapse": words("collapse", "separate"),
  float: words("left", "right", "none"),
};

export function safeStyle(raw: string): string | null {
  if (raw.includes("/*") || raw.includes("\\")) return null;
  const kept: string[] = [];
  for (const declaration of raw.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().replace(/\s+/g, " ");
    const check = PROPERTIES[property];
    if (check && value && check(value.toLowerCase())) kept.push(`${property}: ${value}`);
  }
  return kept.length ? kept.join("; ") : null;
}
