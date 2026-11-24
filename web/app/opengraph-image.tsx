import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/* The og card is the homepage demo as a still: a terminal where `terminal-code` was
   just typed and VS Code opened inside it. Rebuilt with satori-safe flexbox
   and inline styles. Palette comes from globals.css (dark). */

export const alt = "terminal-code — VS Code inside your terminal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const C = {
  bg: "#0c0c0d",
  panel: "#121214",
  panel2: "#17171a",
  border: "#26262a",
  borderSoft: "#1e1e21",
  text: "#ededf0",
  text2: "#b8b8c0",
  muted: "#82828c",
  faint: "#5a5a63",
  ok: "#6ad734",
  /* vscode dark+ editor colors */
  kw: "#c586c0",
  fn: "#dcdcaa",
  str: "#ce9178",
  ident: "#9cdcfe",
  type: "#4ec9b0",
  punct: "#d4d4d4",
  comment: "#6a9955",
  lineNo: "#565660",
  /* terminal prompt colors from the demo video */
  promptPath: "#4d9fff",
  promptBranch: "#5fb85f",
};

/* glyphs the font may not cover, drawn as svg instead */
function TrafficLights() {
  return (
    <svg width={52} height={12} viewBox="0 0 52 12">
      <circle cx="6" cy="6" r="6" fill="#ff5f57" />
      <circle cx="26" cy="6" r="6" fill="#febc2e" />
      <circle cx="46" cy="6" r="6" fill="#28c840" />
    </svg>
  );
}

function Branch({ size: s, color }: { size: number; color: string }) {
  return (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <circle cx="4.5" cy="3.2" r="1.9" fill="none" stroke={color} strokeWidth={1.4} />
      <circle cx="4.5" cy="12.8" r="1.9" fill="none" stroke={color} strokeWidth={1.4} />
      <circle cx="11.5" cy="4.8" r="1.9" fill="none" stroke={color} strokeWidth={1.4} />
      <path d="M4.5 5.1v5.8M11.5 6.7c0 3-7 2.2-7 4.2" fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

function Chevron({ size: s, color, open }: { size: number; color: string; open?: boolean }) {
  return (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path
        d={open ? "M2.8 5.5 L8 11 L13.2 5.5" : "M5.5 2.8 L11 8 L5.5 13.2"}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
      />
    </svg>
  );
}

/* activity-bar icons, sketched */
function IconFiles({ color }: { color: string }) {
  return (
    <svg width={22} height={22} viewBox="0 0 16 16">
      <path d="M4.5 1.5h5l3 3v10h-8z" fill="none" stroke={color} strokeWidth={1.2} />
      <path d="M9.5 1.5v3h3" fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  );
}
function IconSearch({ color }: { color: string }) {
  return (
    <svg width={22} height={22} viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.4" fill="none" stroke={color} strokeWidth={1.3} />
      <path d="M10.4 10.4 L14 14" stroke={color} strokeWidth={1.3} />
    </svg>
  );
}
function IconGit({ color }: { color: string }) {
  return <Branch size={22} color={color} />;
}
function IconExt({ color }: { color: string }) {
  return (
    <svg width={22} height={22} viewBox="0 0 16 16">
      <path d="M2 6h4V2h4v4h4v4h-4v4H6v-4H2z" fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  );
}

function FileRow({
  name,
  depth,
  active,
  dir,
  open,
}: {
  name: string;
  depth: number;
  active?: boolean;
  dir?: boolean;
  open?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        paddingLeft: 14 + depth * 18,
        paddingTop: 4.5,
        paddingBottom: 4.5,
        backgroundColor: active ? "rgba(255,255,255,0.07)" : "transparent",
        color: active ? C.text : C.muted,
      }}
    >
      {dir ? (
        <Chevron size={12} color={C.muted} open={open} />
      ) : (
        <div style={{ width: 12, display: "flex" }} />
      )}
      <span style={{ marginLeft: 7 }}>{name}</span>
    </div>
  );
}

/* one editor line: [lineNo, ...colored segments] */
type Seg = [string, string];
function CodeLine({ no, segs }: { no: string; segs: Seg[] }) {
  return (
    <div style={{ display: "flex", whiteSpace: "pre", marginTop: 7 }}>
      <span style={{ color: C.lineNo, width: 44 }}>{no}</span>
      {segs.map(([t, c], i) => (
        <span key={i} style={{ color: c }}>
          {t}
        </span>
      ))}
    </div>
  );
}

export default async function Image() {
  const [regular, medium, bold] = await Promise.all([
    readFile(join(process.cwd(), "assets/JetBrainsMono-Regular.ttf")),
    readFile(join(process.cwd(), "assets/JetBrainsMono-Medium.ttf")),
    readFile(join(process.cwd(), "assets/JetBrainsMono-Bold.ttf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: C.bg,
          padding: "50px 64px 60px",
          fontFamily: "JetBrains Mono",
        }}
      >
        {/* hero line, keyword styled like the homepage h1 */}
        <div style={{ display: "flex", alignItems: "center", fontSize: 31, fontWeight: 500, color: C.text }}>
          <span>VS Code inside your&nbsp;</span>
          <span style={{ color: C.ok }}>terminal</span>
          <div style={{ width: 13, height: 30, marginLeft: 7, backgroundColor: C.ok, display: "flex" }} />
        </div>

        {/* the terminal window: `terminal-code` typed, the editor opened */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            marginTop: 36,
            borderRadius: 14,
            border: `1px solid ${C.border}`,
            backgroundColor: C.panel,
            overflow: "hidden",
          }}
        >
          {/* terminal title bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: 42,
              paddingLeft: 20,
              borderBottom: `1px solid ${C.borderSoft}`,
            }}
          >
            <TrafficLights />
            <span style={{ marginLeft: 18, fontSize: 14, color: C.faint }}>~/my-app</span>
          </div>

          {/* scrollback: the shell line that launched it */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "12px 20px",
              fontSize: 16,
              borderBottom: `1px solid ${C.borderSoft}`,
            }}
          >
            <span style={{ color: C.promptPath, fontWeight: 700 }}>~/my-app</span>
            <span style={{ marginLeft: 10, color: C.promptBranch }}>main</span>
            <span style={{ marginLeft: 14, color: C.ok }}>&gt;</span>
            <span style={{ marginLeft: 10, color: C.text }}>terminal-code</span>
          </div>

          {/* vscode, filling the rest of the terminal */}
          <div style={{ display: "flex", flexGrow: 1 }}>
            {/* activity bar */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 48,
                paddingTop: 14,
                gap: 18,
                borderRight: `1px solid ${C.borderSoft}`,
                backgroundColor: C.panel2,
              }}
            >
              <IconFiles color={C.text} />
              <IconSearch color={C.faint} />
              <IconGit color={C.faint} />
              <IconExt color={C.faint} />
            </div>

            {/* explorer */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 218,
                paddingTop: 10,
                fontSize: 14.5,
                borderRight: `1px solid ${C.borderSoft}`,
                backgroundColor: C.panel2,
              }}
            >
              <span style={{ paddingLeft: 14, fontSize: 12, color: C.faint, letterSpacing: 1 }}>
                EXPLORER
              </span>
              <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
                <FileRow name="my-app" depth={0} dir open />
                <FileRow name="src" depth={1} dir open />
                <FileRow name="App.tsx" depth={2} active />
                <FileRow name="main.tsx" depth={2} />
                <FileRow name="index.css" depth={2} />
                <FileRow name="public" depth={1} dir />
                <FileRow name="package.json" depth={1} />
                <FileRow name="vite.config.ts" depth={1} />
              </div>
            </div>

            {/* editor */}
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, backgroundColor: C.panel }}>
              {/* tab bar */}
              <div style={{ display: "flex", height: 38, borderBottom: `1px solid ${C.borderSoft}` }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 20px",
                    fontSize: 14.5,
                    color: C.text,
                    backgroundColor: C.panel,
                    borderRight: `1px solid ${C.borderSoft}`,
                    borderTop: `2px solid ${C.ok}`,
                  }}
                >
                  <span>App.tsx</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 20px",
                    fontSize: 14.5,
                    color: C.faint,
                    backgroundColor: C.panel2,
                    borderRight: `1px solid ${C.borderSoft}`,
                  }}
                >
                  <span>main.tsx</span>
                </div>
              </div>

              {/* code */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flexGrow: 1,
                  padding: "12px 8px",
                  fontSize: 15.5,
                }}
              >
                <CodeLine
                  no="1"
                  segs={[
                    ["import", C.kw],
                    [" { useState } ", C.punct],
                    ["from", C.kw],
                    [" ", C.punct],
                    ['"react"', C.str],
                    [";", C.punct],
                  ]}
                />
                <CodeLine no="2" segs={[["", C.punct]]} />
                <CodeLine
                  no="3"
                  segs={[
                    ["export function", C.kw],
                    [" ", C.punct],
                    ["App", C.fn],
                    ["() {", C.punct],
                  ]}
                />
                <CodeLine
                  no="4"
                  segs={[
                    ["  const", C.kw],
                    [" [count, setCount] = ", C.punct],
                    ["useState", C.fn],
                    ["(", C.punct],
                    ["0", "#b5cea8"],
                    [");", C.punct],
                  ]}
                />
                <CodeLine
                  no="5"
                  segs={[
                    ["  return", C.kw],
                    [" (", C.punct],
                  ]}
                />
                <CodeLine
                  no="6"
                  segs={[
                    ["    <", C.punct],
                    ["button", C.type],
                    [" ", C.punct],
                    ["onClick", C.ident],
                    ["={() => ", C.punct],
                    ["setCount", C.fn],
                    ["(count + ", C.punct],
                    ["1", "#b5cea8"],
                    [")}>", C.punct],
                  ]}
                />
                <CodeLine
                  no="7"
                  segs={[
                    ["      count is {count}", C.punct],
                  ]}
                />
                <CodeLine
                  no="8"
                  segs={[
                    ["    </", C.punct],
                    ["button", C.type],
                    [">", C.punct],
                  ]}
                />
                <CodeLine no="9" segs={[["  );", C.punct]]} />
                <CodeLine no="10" segs={[["}", C.punct]]} />
              </div>
            </div>
          </div>

          {/* status bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: 32,
              padding: "0 16px",
              fontSize: 13,
              color: C.muted,
              borderTop: `1px solid ${C.borderSoft}`,
              backgroundColor: C.panel2,
            }}
          >
            <Branch size={14} color={C.ok} />
            <span style={{ marginLeft: 7, color: C.text2 }}>main</span>
            <div style={{ display: "flex", flexGrow: 1 }} />
            <span>TypeScript JSX</span>
            <span style={{ marginLeft: 22 }}>Ln 4, Col 9</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "JetBrains Mono", data: regular, weight: 400 as const, style: "normal" as const },
        { name: "JetBrains Mono", data: medium, weight: 500 as const, style: "normal" as const },
        { name: "JetBrains Mono", data: bold, weight: 700 as const, style: "normal" as const },
      ],
    },
  );
}
