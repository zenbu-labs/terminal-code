import type { TerminalTheme } from "@zenbu-labs/pixel/preload";

export interface ThemeMessage {
  type: "theme";
  colors: TerminalTheme;
}

export interface PageTiming {
  at: number;
  origin: number;
  responseEnd: number;
  domInteractive: number;
  loadEnd: number;
  marks: Record<string, number>;
}

export interface TimingMessage {
  type: "timing";
  page: PageTiming;
}

export const MESSAGE_CHANNEL = "tode:message";
