# terminal-code (tode) — Agent Instructions

## Purpose

**tode** is a CLI tool that runs VS Code inside any modern terminal by combining
[terminal-browser](https://github.com/zenbu-labs/terminal-browser) (a browser in the
terminal) and [code-server](https://github.com/coder/code-server) (VS Code in the
browser). The binary is `tode`, built from this repo.

## Project Layout

| Path | What |
|---|---|
| `src/main.ts` | CLI entry point |
| `src/bridge/` | Bridge VS Code extension that connects to the host process via IPC |
| `src/browser/` | Browser context: preload script, main script, types |
| `src/codeserver/` | Code-server management: server lifecycle, inject, vendored binaries |
| `src/import/` | Import settings/keybindings/extensions from other editors |
| `src/pages/` | React+Vite pages (shortcuts wizard, import wizard) — built separately via `TODE_PAGE` env |
| `src/runtime/` | Runtime artifact paths and release management |
| `src/shortcuts/` | Shortcut conflict resolution between terminal and tode |
| `src/terminal/` | Terminal integration (OSC sequences, selection) |
| `src/theme/` | VS Code theme generation from terminal palette |
| `src/webui/` | Web UI utilities for pages |
| `web/` | Marketing website (Next.js) |
| `test/` | Test files — Node.js native test runner (`.test.js`) |
| `scripts/` | Build, install, release scripts |
| `assets/` | Static assets (fonts, keymaps, logos) |
| `herdr-plugin/` | Plugin for herdr terminal |
| `release-worker/` | Cloudflare Worker for release automation |

## Build, Test, Lint Commands

```bash
npm run build          # tsc + vite build for pages
npm run typecheck      # tsc --noEmit for src/ + pages/
npm test               # build then node --test test/*.test.js
npm run build:pages    # vite build for shortcuts + import pages
```

- TypeScript config: `tsconfig.json` (src/, ES2022, Node16 modules, strict)
- Pages have their own `src/pages/tsconfig.json`
- Test runner: Node.js built-in `node --test` — no jest/mocha
- Vite config is `vite.config.mts` — reads `TODE_PAGE` env to build one page at a time

## Architecture Rules

- **Bridge ↔ Server IPC**: The bridge extension (injected into code-server) talks to
  the host process through a Unix socket; messages are typed via `src/ipc.ts`.
  Keep the bridge as small and dependency-free as possible (it runs inside code-server
  and has no npm deps).
- **No shared chunks between pages**: Each Vite page is built as a self-contained
  bundle (one HTML, one JS, one CSS) via `TODE_PAGE` env. Never add shared chunk
  splitting to the Vite config.
- **Purity of terminal I/O**: The terminal render path (browser + terminal protocol)
  must not throw on partial/flaky output. All frame parsing is best-effort.
- **SSH**: `tode --ssh` runs the code-server backend remotely and the browser
  frontend locally; IPC is proxied over the SSH connection.

## Coding Conventions

- **TypeScript**: Strict mode, `noUnusedLocals` and `noUnusedParameters` enabled.
  Target `ES2022`, module system `Node16`.
- **Imports**: Use Node.js built-in modules with `node:` prefix (e.g., `import path
  from "node:path"`).
- **Indentation**: 2 spaces, no tabs.
- **Console/logging**: Prefer `narrateFetch` / structured logging helpers over raw
  `console.log`. The `--timing` flag reports stage durations.
- **Error handling**: Fatal errors exit with a user-facing message. Non-fatal errors
  should not break the terminal session. Avoid try/catch swallowing.

## Platform Constraints

- **Primary targets**: macOS and Linux. No native Windows build — Windows users
  must use WSL.
- **Requires a terminal that supports the Kitty graphics protocol** (Ghostty, Kitty,
  iTerm2, WezTerm, etc.).
- **Font**: A Nerd Font is bundled and ensured at startup (`ensureFont`).
- **VS Code theme**: Generated from the terminal's palette (OSC 4/10/11/12) so the
  editor matches the terminal colors. See `src/theme/`.

## Key Gotchas

- **Shortcut conflicts**: Terminal and tode compete for keybindings. `tode --shortcut-setup`
  resolves this via an interactive wizard. The shortcut system supports Ghostty and Kitty
  backends — be careful not to break parsing of terminal config files.
- **Multiple VS Code instances**: Only one code-server instance runs at a time (singleton
  server). The IPC socket path is derived from `ipcSocketDir` in `browserglue.ts`.
- **Version pinning**: Code-server version is pinned in `src/runtime/release.ts`
  (`PINNED_VERSION`). When upgrading, update the vendored hash and test thoroughly.
- **Release flow**: Release artifacts are built via `scripts/release.sh` and published
  to Cloudflare R2 (`scripts/publish-r2.sh`), coordinated by the `release-worker/`.

## Sensitive Areas — Read Before Editing

- `src/bridge/extension.ts` — the VS Code extension injected into code-server; it runs
  inside the editor process with no npm dependencies. Any import outside `node:`
  modules will break.
- `src/shortcuts/backends/` — parses Ghostty/Kitty config files. Incorrect parsing can
  corrupt user config.
- `src/runtime/release.ts` — manages the code-server binary download and version pinning.
- `scripts/install.sh` and `scripts/dist.sh` — affect user installations.
- `src/codeserver/inject.ts` — injects the browser glue into code-server's web UI.
  Changes here affect all rendering.