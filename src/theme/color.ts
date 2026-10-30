export type Rgb = [number, number, number];

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(clamp(c, 0, 1) * 255);
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** Oklch keeps lightness perceptually even, so the same step looks like the same
 * step whatever hue a terminal theme happens to use. */
export function toOklch([r, g, b]: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: lightness, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

export function fromOklch({ l, c, h }: Oklch): Rgb {
  const a = Math.cos(h) * c;
  const b = Math.sin(h) * c;
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    fromLinear(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    fromLinear(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ];
}

export function hex(color: Rgb): string {
  return `#${color.map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

export function withAlpha(color: Rgb, alpha: number): string {
  return `${hex(color)}${Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, "0")}`;
}

export function parseHex(value: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  const number = parseInt(digits, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

export function isDark(color: Rgb): boolean {
  return luminance(color) < 0.25;
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = clamp(amount, 0, 1);
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** Step a surface away from its neighbours, so one flat terminal background can
 * become the ladder of panels an editor needs.
 *
 * This works in sRGB rather than Oklch on purpose. Oklch lightness is so
 * compressed near black that a perceptually even step off #000000 still lands on
 * #010101, which would flatten every panel into the same colour on the pure
 * black terminal themes people actually use. A background with no room in the
 * direction asked for steps the other way instead. */
export function shade(base: Rgb, amount: number): Rgb {
  const size = Math.abs(amount);
  const up = amount >= 0;
  const room = up ? 255 - Math.max(...base) : Math.min(...base);
  const direction = room >= size ? (up ? 1 : -1) : up ? -1 : 1;
  return base.map((channel) => clamp(Math.round(channel + direction * size), 0, 255)) as Rgb;
}

/** Push a colour until it is legible on its background. Terminal themes are
 * sometimes very low contrast, and an editor cannot afford that. */
export function legible(color: Rgb, on: Rgb, target: number): Rgb {
  if (contrast(color, on) >= target) return color;
  const lighten = luminance(on) < 0.5;
  const { c, h } = toOklch(color);
  let best = color;
  for (let step = 1; step <= 40; step++) {
    const l = clamp(toOklch(color).l + (lighten ? step : -step) * 0.02, 0, 1);
    best = fromOklch({ l, c, h });
    if (contrast(best, on) >= target) return best;
  }
  return best;
}
