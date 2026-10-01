import crypto from "node:crypto";

import type { TerminalPalette } from "../terminal/osc";
import { contrast, hex, isDark, legible, mix, shade, toOklch, withAlpha } from "./color";
import type { Rgb } from "./color";

export const THEME_NAME = "Terminal Code";

/** Which ansi slot best represents a hue, judged by angle rather than by index,
 * because plenty of terminal themes do not put red in slot one. */
function nearestHue(palette: Rgb[], degrees: number, background: Rgb): Rgb {
  const target = (degrees * Math.PI) / 180;
  let best = palette[0];
  let bestScore = Infinity;
  for (const color of palette) {
    const { c, h } = toOklch(color);
    if (c < 0.02) continue;
    const delta = Math.abs(Math.atan2(Math.sin(h - target), Math.cos(h - target)));
    const score = delta - Math.min(contrast(color, background), 8) * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = color;
    }
  }
  return best;
}

export interface Semantic {
  red: Rgb;
  green: Rgb;
  yellow: Rgb;
  blue: Rgb;
  magenta: Rgb;
  cyan: Rgb;
}

/** The bright half of the palette reads better on an editor surface than the dim
 * half, so accents are chosen from slots eight to fifteen where they exist. */
export function semanticColors(palette: TerminalPalette): Semantic {
  const bright = palette.ansi.slice(9, 15);
  const pool = bright.some((color) => toOklch(color).c > 0.02)
    ? bright
    : palette.ansi.slice(1, 7);
  const bg = palette.background;
  return {
    red: nearestHue(pool, 29, bg),
    green: nearestHue(pool, 142, bg),
    yellow: nearestHue(pool, 90, bg),
    blue: nearestHue(pool, 264, bg),
    magenta: nearestHue(pool, 328, bg),
    cyan: nearestHue(pool, 195, bg),
  };
}

export interface Surfaces {
  editor: Rgb;
  raised: Rgb;
  sunken: Rgb;
  overlay: Rgb;
  border: Rgb;
  hover: Rgb;
  active: Rgb;
}

export function surfaces(background: Rgb, foreground: Rgb): Surfaces {
  return {
    editor: background,
    raised: shade(background, 6),
    sunken: shade(background, -10),
    overlay: shade(background, 20),
    border: mix(background, foreground, 0.14),
    hover: mix(background, foreground, 0.08),
    active: mix(background, foreground, 0.16),
  };
}

export interface GeneratedTheme {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
  tokenColors: unknown[];
  semanticHighlighting: boolean;
}

export function paletteFingerprint(palette: TerminalPalette): string {
  const parts = [palette.background, palette.foreground, ...palette.ansi].map(hex).join("");
  return crypto.createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

export interface ThemeOptions {
  transparent?: boolean;
}

export function generateTheme(palette: TerminalPalette, options: ThemeOptions = {}): GeneratedTheme {
  const bg = palette.background;
  const fg = palette.foreground;
  const dark = isDark(bg);
  const s = surfaces(bg, fg);
  const accent = semanticColors(palette);
  const clear = options.transparent === true;
  const CLEAR = "#00000000";
  const surface = (color: Rgb) => (clear ? CLEAR : hex(color));
  const tint = (color: Rgb, alpha: number) => (clear ? withAlpha(fg, alpha) : hex(color));

  const on = (color: Rgb, target = 4.5) => hex(legible(color, s.editor, target));
  const muted = hex(mix(fg, bg, 0.4));
  const faint = hex(mix(fg, bg, 0.62));
  const primary = legible(accent.blue, s.editor, 3);

  const colors: Record<string, string> = {
    focusBorder: withAlpha(primary, 0.6),
    foreground: hex(fg),
    descriptionForeground: muted,
    errorForeground: on(accent.red),
    "widget.border": hex(s.border),
    "widget.shadow": withAlpha(shade(bg, -24), 0.4),
    "selection.background": withAlpha(primary, 0.35),
    "icon.foreground": muted,
    "sash.hoverBorder": withAlpha(primary, 0.7),

    "editor.background": surface(s.editor),
    "editor.foreground": hex(fg),
    "editorLineNumber.foreground": hex(mix(fg, bg, 0.68)),
    "editorLineNumber.activeForeground": hex(fg),
    "editorCursor.foreground": hex(primary),
    "editor.selectionBackground": withAlpha(primary, 0.3),
    "editor.inactiveSelectionBackground": withAlpha(primary, 0.16),
    "editor.selectionHighlightBackground": withAlpha(primary, 0.16),
    "editor.wordHighlightBackground": withAlpha(primary, 0.14),
    "editor.wordHighlightStrongBackground": withAlpha(accent.green, 0.16),
    "editor.findMatchBackground": withAlpha(accent.yellow, 0.4),
    "editor.findMatchHighlightBackground": withAlpha(accent.yellow, 0.22),
    "editor.lineHighlightBackground": tint(s.raised, 0.06),
    "editor.rangeHighlightBackground": withAlpha(primary, 0.1),
    "editorWhitespace.foreground": withAlpha(fg, 0.15),
    "editorIndentGuide.background1": withAlpha(fg, 0.1),
    "editorIndentGuide.activeBackground1": withAlpha(fg, 0.26),
    "editorRuler.foreground": hex(s.border),
    "editorBracketMatch.background": withAlpha(primary, 0.2),
    "editorBracketMatch.border": withAlpha(primary, 0.5),
    "editorError.foreground": on(accent.red),
    "editorWarning.foreground": on(accent.yellow),
    "editorInfo.foreground": on(accent.blue),
    "editorGutter.addedBackground": on(accent.green, 3),
    "editorGutter.modifiedBackground": on(accent.blue, 3),
    "editorGutter.deletedBackground": on(accent.red, 3),
    "editorOverviewRuler.border": "#00000000",
    "editorLink.activeForeground": hex(primary),

    "editorWidget.background": hex(s.overlay),
    "editorWidget.border": hex(s.border),
    "editorSuggestWidget.background": hex(s.overlay),
    "editorSuggestWidget.border": hex(s.border),
    "editorSuggestWidget.selectedBackground": hex(s.active),
    "editorSuggestWidget.highlightForeground": hex(primary),
    "editorHoverWidget.background": hex(s.overlay),
    "editorHoverWidget.border": hex(s.border),

    "quickInput.background": hex(s.overlay),
    "quickInput.foreground": hex(fg),
    "quickInputList.focusBackground": hex(s.active),
    "quickInputTitle.background": hex(s.overlay),
    "pickerGroup.foreground": muted,
    "pickerGroup.border": hex(s.border),

    "sideBar.background": surface(s.sunken),
    "sideBar.foreground": hex(mix(fg, bg, 0.12)),
    "sideBar.border": hex(s.border),
    "sideBarTitle.foreground": muted,
    "sideBarSectionHeader.background": surface(s.sunken),
    "sideBarSectionHeader.foreground": muted,
    "sideBarSectionHeader.border": hex(s.border),

    "activityBar.background": surface(s.sunken),
    "activityBar.foreground": hex(fg),
    "activityBar.inactiveForeground": faint,
    "activityBar.border": hex(s.border),
    "activityBarBadge.background": hex(primary),
    "activityBarBadge.foreground": hex(isDark(primary) ? [255, 255, 255] : [0, 0, 0]),

    "statusBar.background": surface(s.sunken),
    "statusBar.foreground": muted,
    "statusBar.border": hex(s.border),
    "statusBar.noFolderBackground": surface(s.sunken),
    "statusBar.debuggingBackground": hex(accent.yellow),
    "statusBar.debuggingForeground": hex(isDark(accent.yellow) ? [255, 255, 255] : [0, 0, 0]),
    "statusBarItem.remoteBackground": surface(s.sunken),
    "statusBarItem.remoteForeground": muted,
    "statusBarItem.hoverBackground": tint(s.hover, 0.1),

    "titleBar.activeBackground": surface(s.sunken),
    "titleBar.activeForeground": muted,
    "titleBar.inactiveBackground": surface(s.sunken),
    "titleBar.inactiveForeground": faint,
    "titleBar.border": hex(s.border),

    "panel.background": surface(s.editor),
    "panel.border": hex(s.border),
    "panelTitle.activeForeground": hex(fg),
    "panelTitle.inactiveForeground": faint,
    "panelTitle.activeBorder": hex(primary),

    "editorGroupHeader.tabsBackground": surface(s.sunken),
    "editorGroupHeader.tabsBorder": hex(s.border),
    "editorGroupHeader.noTabsBackground": surface(s.sunken),
    "editorGroup.border": hex(s.border),
    "tab.activeBackground": tint(s.editor, 0.1),
    "tab.activeForeground": hex(fg),
    "tab.inactiveBackground": surface(s.sunken),
    "tab.inactiveForeground": faint,
    "tab.border": hex(s.border),
    "tab.activeBorderTop": hex(primary),
    "tab.hoverBackground": tint(s.hover, 0.06),
    "tab.unfocusedActiveBackground": tint(s.sunken, 0.05),

    "list.activeSelectionBackground": tint(s.active, 0.16),
    "list.activeSelectionForeground": hex(fg),
    "list.inactiveSelectionBackground": tint(s.hover, 0.1),
    "list.hoverBackground": tint(s.hover, 0.08),
    "list.focusBackground": tint(s.active, 0.16),
    "list.highlightForeground": hex(primary),
    "list.errorForeground": on(accent.red),
    "list.warningForeground": on(accent.yellow),
    "tree.indentGuidesStroke": withAlpha(fg, 0.16),

    "input.background": hex(s.raised),
    "input.foreground": hex(fg),
    "input.border": hex(s.border),
    "input.placeholderForeground": faint,
    "inputOption.activeBorder": hex(primary),
    "inputValidation.errorBackground": hex(mix(bg, accent.red, 0.3)),
    "inputValidation.errorBorder": on(accent.red, 3),
    "dropdown.background": hex(s.overlay),
    "dropdown.foreground": hex(fg),
    "dropdown.border": hex(s.border),

    "button.background": hex(primary),
    "button.foreground": hex(isDark(primary) ? [255, 255, 255] : [0, 0, 0]),
    "button.hoverBackground": hex(shade(primary, 12)),
    "button.secondaryBackground": hex(s.active),
    "button.secondaryForeground": hex(fg),
    "badge.background": hex(s.active),
    "badge.foreground": hex(fg),
    "progressBar.background": hex(primary),

    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": withAlpha(fg, 0.14),
    "scrollbarSlider.hoverBackground": withAlpha(fg, 0.22),
    "scrollbarSlider.activeBackground": withAlpha(fg, 0.3),
    "minimap.background": surface(s.editor),

    "menu.background": hex(s.overlay),
    "menu.foreground": hex(fg),
    "menu.border": hex(s.border),
    "menu.selectionBackground": hex(s.active),
    "menubar.selectionBackground": hex(s.hover),

    "notificationCenterHeader.background": hex(s.overlay),
    "notifications.background": hex(s.overlay),
    "notifications.border": hex(s.border),

    "gitDecoration.modifiedResourceForeground": on(accent.yellow, 3),
    "gitDecoration.deletedResourceForeground": on(accent.red, 3),
    "gitDecoration.untrackedResourceForeground": on(accent.green, 3),
    "gitDecoration.ignoredResourceForeground": faint,
    "gitDecoration.conflictingResourceForeground": on(accent.magenta, 3),

    "peekView.border": hex(primary),
    "peekViewEditor.background": hex(s.raised),
    "peekViewResult.background": hex(s.sunken),
    "peekViewTitle.background": hex(s.sunken),

    "breadcrumb.foreground": faint,
    "breadcrumb.focusForeground": hex(fg),
    "breadcrumb.background": surface(s.editor),

    "terminal.background": surface(s.editor),
    "terminal.foreground": hex(fg),
    "terminalCursor.foreground": hex(primary),
    "terminal.selectionBackground": withAlpha(primary, 0.3),
    "terminal.border": hex(s.border),
    // special case da sticky headers
    "editorStickyScroll.background": clear ? withAlpha(bg, 0.85) : hex(s.editor),
    "editorStickyScrollHover.background": clear ? withAlpha(fg, 0.1) : hex(s.hover),
  };

  const ANSI_NAMES = [
    "Black",
    "Red",
    "Green",
    "Yellow",
    "Blue",
    "Magenta",
    "Cyan",
    "White",
    "BrightBlack",
    "BrightRed",
    "BrightGreen",
    "BrightYellow",
    "BrightBlue",
    "BrightMagenta",
    "BrightCyan",
    "BrightWhite",
  ];
  palette.ansi.forEach((color, index) => {
    colors[`terminal.ansi${ANSI_NAMES[index]}`] = hex(color);
  });

  const token = (scopes: string[], color: Rgb, style?: string) => ({
    scope: scopes,
    settings: { foreground: on(color), ...(style ? { fontStyle: style } : {}) },
  });

  const tokenColors = [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: hex(legible(mix(fg, bg, 0.5), s.editor, 3)), fontStyle: "italic" },
    },
    token(["keyword", "storage", "storage.type", "keyword.control"], accent.red),
    token(["string", "string.quoted", "punctuation.definition.string"], accent.green),
    token(["constant.numeric", "constant.language", "constant.character"], accent.magenta),
    token(["entity.name.function", "support.function", "meta.function-call"], accent.blue),
    token(["entity.name.type", "entity.name.class", "support.class", "support.type"], accent.yellow),
    token(["variable", "meta.definition.variable.name", "variable.other.readwrite"], fg),
    token(["variable.parameter"], mix(fg, accent.cyan, 0.5)),
    token(["entity.name.tag"], accent.red),
    token(["entity.other.attribute-name"], accent.yellow),
    token(["support.type.property-name", "meta.object-literal.key"], accent.cyan),
    token(["punctuation", "meta.brace"], mix(fg, bg, 0.3)),
    token(["invalid"], accent.red),
    {
      scope: ["markup.heading"],
      settings: { foreground: on(accent.blue), fontStyle: "bold" },
    },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  ];

  return {
    name: THEME_NAME,
    type: dark ? "dark" : "light",
    semanticHighlighting: true,
    colors,
    tokenColors,
  };
}

/** Names the extension folder for a theme that did not come from a palette —
 * a theme document handed over as a file or inline gets the same treatment a
 * generated one does. */
export function themeFingerprint(theme: object): string {
  return crypto.createHash("sha256").update(JSON.stringify(theme)).digest("hex").slice(0, 16);
}
