import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { builtinKeybindings, installKeybindings, readPalette, removalMasked } from "../profile";
import type { TerminalPalette } from "../terminal/osc";
import { DATA_DIR } from "../runtime/paths";
import { resolveRuntimeWithProgress } from "../runtime/release";
import { extensionHolder, importedConflicts, importedHolder } from "./imported";
import { wrap } from "./prompt";
import { providerFor } from "./provider";
import type { ProviderConflict, ShortcutProvider } from "./provider";
import { QUIT_CHORD, clearDecisions, loadDecisions, saveDecisions } from "./store";
import type { Decision } from "./store";
import { makeEditorHolds } from "./holds";
import { defaultBinding } from "./vscode-keymap";
import { startManager } from "./web";
import type { ManagerDeps, ManagerRow } from "./web";
import { words } from "./words";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

const MODS = ["ctrl", "shift", "alt", "cmd"];
const KEY_PATTERN = /^([a-z0-9]|f[0-9]{1,2}|left|right|up|down|home|end|pageup|pagedown|tab|enter|space|backspace|delete|escape|[`\-=[\]\\;',./])$/;

export function normalizeChord(input: string): string | null {
  const parts = input.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.pop()!;
  const ALIASES: Record<string, string> = {
    meta: "cmd",
    super: "cmd",
    command: "cmd",
    control: "ctrl",
    option: "alt",
    opt: "alt",
  };
  const mods = [...new Set(parts.map((part) => ALIASES[part] ?? part))];
  if (!mods.every((mod) => MODS.includes(mod)) || !KEY_PATTERN.test(key)) return null;
  return [...MODS.filter((mod) => mods.includes(mod)), key].join("+");
}

function applyDecisions(
  provider: ShortcutProvider,
  conflicts: ProviderConflict[],
  choices: Record<string, Decision>,
): { configPath: string; keybindingsChanged: boolean } {
  const moves = conflicts
    .filter((conflict) => choices[conflict.editorId]?.choice === "terminal")
    .map((conflict) => {
      const decision = choices[conflict.editorId];
      return { trigger: conflict.trigger, to: decision.key, action: decision.action };
    });
  for (const [id, decision] of Object.entries(choices)) {
    if (!id.startsWith("claim:") || decision.owner !== "terminal") continue;
    if (decision.choice !== "terminal" || !decision.action) continue;
    const rest = id.slice("claim:".length);
    const named = rest.indexOf(":");
    const chord = named === -1 ? rest : rest.slice(0, named);
    moves.push({ trigger: provider.trigger(chord), to: decision.key, action: decision.action });
  }
  const configPath = provider.apply(moves);
  saveDecisions({ version: 1, terminal: provider.id, choices });
  const keybindingsChanged = installKeybindings();
  return { configPath, keybindingsChanged };
}

export function applyRecordedDecisions(
  provider: ShortcutProvider,
  conflicts: ProviderConflict[],
  choices: Record<string, Decision>,
): { configPath: string; keybindingsChanged: boolean; reloadedLive: boolean; reloadHint: string } {
  const applied = applyDecisions(provider, conflicts, choices);
  return {
    ...applied,
    reloadedLive: provider.onApplied(),
    reloadHint: provider.reloadHint(),
  };
}

function say(text: string, style: (line: string) => string = (line) => line): void {
  process.stdout.write(`${wrap(text, "  ").map(style).join("\n")}\n`);
}

export function autoApplyShared(provider: ShortcutProvider | null = providerFor()): void {
  if (!provider || provider.ready() !== null) return;
  try {
    const conflicts = provider.scan();
    const choices = { ...(loadDecisions()?.choices ?? {}) };
    const fresh = conflicts.filter(
      (conflict) => conflict.shared && conflict.current !== null && !choices[conflict.editorId],
    );
    if (fresh.length === 0) return;
    for (const conflict of fresh) {
      choices[conflict.editorId] = { choice: "terminal", action: conflict.current ?? undefined };
    }
    applyDecisions(provider, conflicts, choices);
    provider.onApplied();
  } catch { }
}

/** Whoever holds a chord on the editor side, as a claimant the page can seat
 * in the duel: an imported keybinding, one of tode's own builtins, or an
 * extension's contribution. All three resolve through the same claim
 * decisions, because a user-level removal entry is written after every one of
 * their rules and masks whichever kind it names. */
function claimHolder(
  chord: string,
): { command: string; claimant: string; describes: string; when?: string } | null {
  const imported = importedHolder(chord);
  if (imported) return { command: imported, claimant: "imported", describes: words(imported) };
  const builtin = builtinKeybindings().find(
    (bind) =>
      !!bind.key &&
      !!bind.command &&
      normalizeChord(bind.key) === chord &&
      !removalMasked(bind.key, bind.command),
  );
  if (builtin) {
    return {
      command: builtin.command!,
      claimant: "terminal-code",
      describes: words(builtin.command!),
      when: builtin.when,
    };
  }
  const extension = extensionHolder(chord);
  if (extension) return extension;
  // the workbench defaults hold chords too — the scan counts them as
  // conflicts, so picking a chord must vet against them the same way, or a
  // move lands somewhere the very next scan calls contested
  const fallback = defaultBinding(chord);
  if (fallback && !removalMasked(chord, fallback.command)) {
    return {
      command: fallback.command,
      claimant: "terminal-code",
      describes: words(fallback.command),
      when: fallback.when,
    };
  }
  return null;
}

type RowClaim = NonNullable<ManagerRow["claims"]>[number];

type SelfExempt = { action?: string; command?: string };

function liveHolders(
  provider: ShortcutProvider,
  holds: ReturnType<typeof makeEditorHolds>,
  chord: string,
  exempt: SelfExempt = {},
): (RowClaim & { terminal?: boolean })[] {
  const holders: (RowClaim & { terminal?: boolean })[] = [];
  const terminal = provider.takenAs(chord);
  if (terminal && terminal !== exempt.action) {
    holders.push({
      chord,
      command: terminal,
      claimant: provider.name,
      describes: provider.describe(terminal),
      terminal: true,
    });
  }
  for (const held of holds(chord)) {
    if (held.command === exempt.command) continue;
    holders.push({
      chord,
      command: held.command,
      claimant: held.claimant ?? "terminal-code",
      describes: held.describes ?? words(held.command),
      when: held.guard,
    });
  }
  return holders;
}

/** The staged fact about a holder of `chord`, wherever the session recorded
 * it: a claim decision from a duel, or the decision of the row that IS this
 * very binding — the same binding is one fact, whichever step touched it. */
function stagedAbout(
  choices: Record<string, Decision>,
  chord: string,
  holder: { command: string; terminal?: boolean },
): Decision | null {
  const claim =
    choices[`claim:${chord}:${holder.command}`] ?? choices[`claim:${chord}`] ?? null;
  if (claim && (claim.action ?? holder.command) === holder.command) return claim;
  const row = choices[chord];
  if (holder.terminal) {
    if (row?.choice === "terminal" && row.action === holder.command) return row;
    return null;
  }
  // editor-side holders: the owning row's editor decision, translated into
  // the shape a claim column displays (unset, or moved to a key)
  const translate = (decision: Decision | undefined): Decision | null => {
    if (!decision || decision.command !== holder.command) return null;
    if (decision.choice === "keep") return { choice: "terminal" };
    if (decision.choice === "editor" && decision.key && decision.key !== chord) {
      return { choice: "terminal", key: decision.key };
    }
    return null;
  };
  return translate(row) ?? translate(choices[`import:${chord}`]);
}

export function managerRows(
  provider: ShortcutProvider,
  choices: Record<string, Decision>,
): ManagerRow[] {
  const holds = makeEditorHolds();
  const rowClaims = (
    rowChord: string,
    others: RowClaim[],
    roots: { decision: Decision | null | undefined; exempt: SelfExempt }[],
  ): RowClaim[] => {
    const out: RowClaim[] = [];
    const seen = new Set<string>();
    const push = (claim: RowClaim) => {
      const identity = `${claim.chord}:${claim.command}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      out.push(claim);
      follow(
        claim.decided,
        claim.decided?.owner === "terminal"
          ? { action: claim.command }
          : { command: claim.command },
      );
    };
    const follow = (decision: Decision | null | undefined, exempt: SelfExempt) => {
      const target = decision?.key;
      if (!target || decision?.choice === "keep" || target === rowChord) return;
      for (const holder of liveHolders(provider, holds, target, exempt)) {
        const { terminal, ...claim } = holder;
        push({ ...claim, decided: stagedAbout(choices, target, holder) });
      }
    };
    for (const other of others) {
      push({ ...other, resting: true, decided: stagedAbout(choices, rowChord, other) });
    }
    for (const root of roots) follow(root.decision, root.exempt);
    return out;
  };
  const currents = new Map<string, string>();
  const rows = provider.scan().filter((conflict) => !conflict.shared).map((conflict): ManagerRow => {
    if (conflict.current) currents.set(conflict.editorId, conflict.current);
    const legacy = choices[`claim:${conflict.editorId}`];
    const mirrored =
      choices[`claim:${conflict.editorId}:${conflict.current}`] ??
      (legacy?.owner === "terminal" && legacy.action === conflict.current ? legacy : null);
    const decision =
      choices[conflict.editorId] ??
      (mirrored?.choice === "terminal" ? mirrored : null);
    return {
      id: conflict.editorId,
      kind: "terminal",
      means: conflict.editor.means,
      detail: { command: conflict.editor.command, when: conflict.editor.guard },
      terminal: {
        name: provider.name,
        short: conflict.short,
        does: conflict.inTerminal,
        freed: conflict.freed,
        tradeoff: conflict.tradeoff,
        bound: true,
      },
      decision,
      claims: rowClaims(
        conflict.editorId,
        conflict.others.map((other) => ({
          chord: conflict.editorId,
          command: other.command,
          claimant: other.claimant ?? "terminal-code",
          describes: other.describes ?? words(other.command),
          when: other.guard,
        })),
        [
          {
            decision,
            exempt:
              decision?.choice === "editor"
                ? { command: decision.command ?? conflict.editor.command }
                : { action: conflict.current ?? undefined },
          },
        ],
      ),
    };
  });
  for (const imported of importedConflicts()) {
    const claimDecision =
      choices[`claim:${imported.key}:${imported.command}`] ??
      choices[`claim:${imported.key}`] ??
      null;
    rows.push({
      id: imported.key,
      kind: "import",
      // quit is tode's own idea, named as such; every other builtin's label
      // derives from the command it runs
      means: imported.key === QUIT_CHORD ? "quit terminal-code" : words(imported.builtin),
      terminal: { name: provider.name, short: "", does: "", freed: "", tradeoff: "", bound: true },
      importedCommand: imported.command,
      claimant: imported.claimant,
      claimDescribes: imported.describes,
      claimDecision,
      decision: choices[`import:${imported.key}`] ?? null,
      // both movers on an import row are editor-side bindings: the moved
      // builtin carries its command on the decision, the moved imported
      // binding is the row's own command — each move's target gets its
      // holders seated, exempting only that mover's own command
      claims: rowClaims(
        imported.key,
        [],
        [
          {
            decision: choices[`import:${imported.key}`],
            exempt: { command: choices[`import:${imported.key}`]?.command ?? imported.command },
          },
          { decision: claimDecision, exempt: { command: imported.command } },
        ],
      ),
    });
  }
  // A step answered entirely from other steps has no question left to ask —
  // it stops existing. That takes both: the row has no record of its own
  // (only the mirrored claim record resolves it), and that record is still
  // visible as a claimant column in some other row's duel, where it stays
  // editable. Undo the other duel's move and the step comes back.
  const visibleElsewhere = (row: ManagerRow, command: string | undefined) =>
    !!command &&
    rows.some(
      (other) =>
        other.id !== row.id &&
        other.claims?.some((claim) => claim.chord === row.id && claim.command === command),
    );
  return rows.filter((row) => {
    if (row.kind === "terminal") {
      if (choices[row.id]) return true;
      const current = currents.get(row.id);
      const mirror = current ? choices[`claim:${row.id}:${current}`] : undefined;
      if (mirror?.choice !== "terminal") return true;
      return !visibleElsewhere(row, current);
    }
    if (choices[`import:${row.id}`]) return true;
    if (row.claimDecision?.choice !== "terminal") return true;
    return !visibleElsewhere(row, row.importedCommand);
  });
}

// racy i dont like this
export const BOOT_AFTER_APPLY = 100;

export function chordTaken(
  provider: ShortcutProvider,
  staged: Record<string, Decision>,
  chord: string,
  rowId?: string,
  command?: string,
  side?: "terminal" | "editor",
): ReturnType<ManagerDeps["taken"]> {
  const conflict = provider.scan().find((entry) => entry.editorId === rowId);
  const ownKeys = command
    ? [`claim:${rowId}:${command}`, `claim:${rowId}`]
    : [rowId, `import:${rowId}`, `claim:${rowId}:${conflict?.current}`];
  for (const [id, decision] of Object.entries(staged)) {
    if (decision.key !== chord || decision.choice === "keep") continue;
    if (rowId && ownKeys.includes(id)) continue;
    const what = decision.action ?? decision.command ?? "another shortcut";
    return { holder: `${what} (moved here this session)` };
  }
  const own: SelfExempt = command
    ? provider.takenAs(rowId ?? "") === command
      ? { action: command }
      : { command }
    : side === "terminal"
      ? { action: conflict?.current ?? undefined }
      : side === "editor"
        ? {
          command:
            conflict?.editor.command ??
            builtinKeybindings().find(
              (bind) => !!bind.key && !!bind.command && normalizeChord(bind.key) === rowId,
            )?.command,
        }
        : {};
  for (const holder of liveHolders(provider, makeEditorHolds(), chord, own)) {
    const decided = stagedAbout(staged, chord, holder);
    if (decided?.choice === "terminal") continue;
    const { terminal, ...claim } = holder;
    void terminal;
    return { holder: `${claim.command} (${claim.claimant})`, claim };
  }
  return null;
}

export function managerSession(provider: ShortcutProvider): {
  staged: Record<string, Decision>;
  rows(): ManagerRow[];
  taken: ManagerDeps["taken"];
  decide: ManagerDeps["decide"];
  confirm(): void;
} {
  const staged: Record<string, Decision> = { ...(loadDecisions()?.choices ?? {}) };
  return {
    staged,
    rows: () => managerRows(provider, staged),
    taken: (chord, rowId, command, side) =>
      chordTaken(provider, staged, chord, rowId, command, side),
    decide: (id, kind, decision, side, info) => {
      const claim = kind === "claim" || side === "claim";
      const key = claim
        ? `claim:${id}${info?.command ? `:${info.command}` : ""}`
        : kind === "import"
          ? `import:${id}`
          : id;
      const dropTwin = () => {
        if (kind === "terminal") {
          const current = provider.scan().find((entry) => entry.editorId === id)?.current;
          if (!current) return;
          delete staged[`claim:${id}:${current}`];
          const legacy = staged[`claim:${id}`];
          if (legacy?.owner === "terminal" && legacy.action === current) {
            delete staged[`claim:${id}`];
          }
        }
        if (claim) {
          const twin = staged[id];
          if (twin?.choice === "terminal" && twin.action === (info?.command ?? staged[key]?.action)) {
            delete staged[id];
          }
        }
      };
      if (decision === null) {
        delete staged[key];
        dropTwin();
        return;
      }
      dropTwin();
      if (kind === "import" && decision.choice === "editor") {
        decision.command =
          builtinKeybindings().find((bind) => !!bind.key && normalizeChord(bind.key) === id)
            ?.command ?? staged[key]?.command;
      }
      if (kind === "terminal") {
        const conflict = provider.scan().find((entry) => entry.editorId === id);
        if (decision.choice === "terminal") {
          decision.action = conflict?.current ?? staged[key]?.action;
        }
        if (decision.choice === "editor") {
          decision.command = conflict?.editor.command ?? staged[key]?.command;
        }
      }
      if (claim) {
        const terminal = provider.takenAs(id);
        const named = info?.command;
        if (named && terminal === named) {
          decision.action = named;
          decision.owner = "terminal";
        } else if (named) {
          decision.action = named;
          decision.guard = info?.when;
        } else if (terminal) {
          decision.action = terminal;
          decision.owner = "terminal";
        } else {
          const held = claimHolder(id);
          decision.action = held?.command ?? staged[key]?.action;
          decision.guard = held?.when ?? staged[key]?.guard;
        }
      }
      staged[key] = decision;
    },
    confirm: () => {
      applyDecisions(provider, provider.scan(), staged);
    },
  };
}

async function openManager(
  provider: ShortcutProvider,
  intro: boolean,
  next?: () => Promise<string | null>,
  continues = !!next,
  knownPalette?: TerminalPalette,
) {
  const palette = knownPalette ?? (await readPalette()).palette;
  const session = managerSession(provider);
  const state = { confirmed: false, reloadedLive: false, navigated: false };
  const wrappedNext = next
    ? async () => {
      const url = await next();
      state.navigated = !!url;
      return url;
    }
    : undefined;
  const manager = await startManager({
    rows: session.rows,
    taken: session.taken,
    normalize: normalizeChord,
    decide: session.decide,
    confirm: () => {
      state.confirmed = true;
      session.confirm();
      state.reloadedLive = provider.onApplied();
      return { note: state.reloadedLive ? "applied" : `applied — ${provider.reloadHint()}` };
    },
    next: wrappedNext,
    continues,
    reloadHint: provider.reloadHint(),
    terminalName: provider.name,
    palette,
    intro,
  });
  return { manager, state };
}

async function runManager(
  provider: ShortcutProvider,
  intro = false,
  bootUrl?: () => Promise<string>,
): Promise<{ code: number; confirmed: boolean; reloadedLive: boolean; served: boolean; navigated: boolean }> {
  const next = bootUrl ? async () => (state0().confirmed ? await bootUrl() : null) : undefined;
  const opened = await openManager(provider, intro, next, false);
  const { manager, state } = opened;
  function state0() {
    return opened.state;
  }
  const runtime = await resolveRuntimeWithProgress();
  const child = spawn(
    runtime.bin,
    [
      "open",
      `http://127.0.0.1:${manager.port}`,
      "--app-mode"
    ],
    { stdio: "inherit" },
  );
  void manager.done.then(() => {
    if (!state.navigated) child.kill("SIGTERM");
  });
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`could not start terminal-browser: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (exit) => resolve(exit ?? 0));
  });
  manager.close();
  const served = manager.served();
  if (!served) {
    process.stderr.write(
      `tode: the shortcuts wizard never reached the screen (terminal-browser exited ${code})\n`,
    );
  }
  return {
    code,
    confirmed: state.confirmed,
    reloadedLive: state.reloadedLive,
    served,
    navigated: state.navigated,
  };
}

const INTRO_MARKER = path.join(DATA_DIR, "shortcuts-intro");

function markIntroShown(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INTRO_MARKER, `${new Date().toISOString()}\n`);
  } catch { }
}

export async function shortcutsFirstRunStage(
  next: () => Promise<string>,
  palette?: TerminalPalette,
): Promise<import("../onboarding").OnboardStage | null> {
  if (fs.existsSync(INTRO_MARKER)) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const provider = providerFor();
  if (!provider || provider.ready() !== null) return null;
  try {
    autoApplyShared(provider);
    if (provider.scan().filter((conflict) => !conflict.shared).length === 0 && importedConflicts().length === 0) {
      markIntroShown();
      return null;
    }
  } catch {
    return null;
  }
  const { manager } = await openManager(provider, true, next, true, palette);
  return {
    url: `http://127.0.0.1:${manager.port}`,
    done: manager.done,
    served: manager.served,
    close: manager.close,
    shown: markIntroShown,
  };
}

export async function shortcutsCommand(
  args: string[],
  bootUrl?: () => Promise<string>,
): Promise<number> {
  const provider = providerFor();
  if (!provider) {
    process.stdout.write(
      `shortcut setup not yet available in this terminal, please file an issue if you want your terminal supported https://github.com/zenbu-labs/terminal-code/issues`
    )
    return 0;
  }

  // what is undo?
  if (args.includes("--undo")) {
    const hadDecisions = loadDecisions() !== null;
    const undone = provider.undo();
    clearDecisions();
    installKeybindings();
    const reloaded = undone && provider.onApplied();
    process.stdout.write(
      undone || hadDecisions
        ? `removed tode's ${provider.name} overrides and editor chords\n${reloaded ? "" : `${provider.reloadHint()}\n`}`
        : "nothing to undo\n",
    );
    return 0;
  }

  const notReady = provider.ready();
  if (notReady) {
    process.stdout.write(`${notReady}\n`);
    return 1;
  }

  autoApplyShared(provider);
  const conflicts = provider.scan().filter((conflict) => !conflict.shared);
  const imported = importedConflicts();
  if (conflicts.length === 0 && imported.length === 0) {
    process.stdout.write(`no shortcut conflicts detected!\n`);
    return 0;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("run tode --shortcut-setup in a terminal to continue\n");
    return 0;
  }

  const { code, confirmed, reloadedLive, served, navigated } = await runManager(provider, false, bootUrl);
  if (served) markIntroShown();
  if (confirmed) {
    if (!reloadedLive) say(provider.reloadHint(), dim);
    if (navigated) return code;
    return BOOT_AFTER_APPLY;
  }
  return code;
}
