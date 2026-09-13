# `tode doctor --json` Implementation Plan

> **For the implementer:** Execute this plan task-by-task against the approved design spec. Keep each task isolated, run its validation before moving on, and do not create commits unless the user explicitly authorizes commits.

**Goal:** Add `tode doctor [--json] [--fix]` with deterministic diagnostics, verified repairs, stable JSON output, safe shortcut handling, and owned daemon lifecycle repair.

**Architecture:** Add a dependency-injected check/repair plan engine under `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/`. Checks are read-only; repairs are explicit, ordered, idempotent actions. The CLI runs checks, optionally repairs with `--fix`, runs checks again, and renders one shared report model as text or JSON.

**Tech Stack:** TypeScript with Node16 modules, Node built-in `node:test`, existing `fs`, `child_process`, `net`, and `fetch` abstractions. No new dependency is required.

**Design source:** `/Users/pisitkoolplukpol/Work/terminal-code-doctor/docs/superpowers/specs/2026-08-20-tode-doctor-json-design.md`

---

## Implementation constraints

- Canonical syntax is `tode doctor [--json] [--fix]`; preserve all existing path-opening and `--<command>` behavior for other arguments.
- `doctor` without `--fix` must not write, download, start, stop, or mutate anything.
- `--fix` may repair only terminal-code-managed state, verified runtime artifacts, supported terminal configuration, and owned code-server/injector processes.
- Never invent a shortcut decision. Apply saved decisions and shared auto-apply only; unresolved conflicts return `needs_input` and remain unchanged.
- Never signal an unverified PID. A live PID alone is insufficient ownership evidence.
- Keep JSON stdout uncontaminated. Progress and diagnostics belong on stderr.
- Do not add dependencies or alter `package-lock.json`.
- Use disposable fixtures and dependency injection for network, filesystem, terminal, clock, and process behavior. Do not touch the user's real home or active daemon in tests.
- Validation is targeted first because host memory is constrained; run the full repository test command only after focused tests pass.

## Task 1: Add report model and status aggregation

**Objective:** Define the stable report/action/check types and pure summary/exit-code aggregation before any I/O is introduced.

**Files:**
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/model.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-model.test.js`

**Step 1: Write failing tests**

Test that:

- `ok`, `warning`, `error`, `needs_input`, and `skipped` checks serialize as explicit strings;
- summary counters match the input checks/actions;
- error exit code `1` takes precedence over `needs_input` exit code `2`;
- a report with only `needs_input` returns `2`;
- a healthy report returns `0`.

**Step 2: Run the focused test**

Run:

```bash
npm run -s build && node --test test/doctor-model.test.js
```

Expected: FAIL because `/Users/pisitkoolplukpol/Work/terminal-code-doctor/dist/doctor/model.js` does not exist.

**Step 3: Implement the smallest model**

Export the string unions and interfaces from the approved spec. Use a pure function with a shape equivalent to:

```ts
export function summarize(
  checks: DoctorCheck[],
  actions: DoctorAction[],
): DoctorSummary {
  const errors = checks.filter((check) => check.status === "error").length;
  const failed = actions.filter((action) => action.status === "failed").length;
  const needsInput = checks.filter((check) => check.status === "needs_input").length;
  const exitCode = errors > 0 || failed > 0 ? 1 : needsInput > 0 ? 2 : 0;
  return { /* deterministic counters and status */ };
}
```

Do not read the filesystem or process environment from this module.

**Step 4: Run the focused test again**

Expected: PASS.

## Task 2: Add pure doctor option parsing

**Objective:** Parse only doctor arguments without changing the existing command dispatcher yet.

**Files:**
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/command.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-command.test.js`

**Step 1: Write failing tests**

Cover:

- `[]` -> `{ json: false, fix: false }`;
- `['--json']`, `['--fix']`, and both orders;
- unknown flags and positional arguments return a typed usage error;
- parser does not mutate its input array;
- usage errors map to exit code `64` at the command boundary, not by calling `process.exit` inside the parser.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-command.test.js
```

Expected: FAIL because the parser module is absent.

**Step 3: Implement the parser**

Use a pure signature such as:

```ts
export interface DoctorOptions { json: boolean; fix: boolean }
export type DoctorArgs =
  | { kind: "ok"; options: DoctorOptions }
  | { kind: "usage-error"; message: string };

export function parseDoctorArgs(args: readonly string[]): DoctorArgs;
```

**Step 4: Run the focused test**

Expected: PASS.

## Task 3: Create dependency-injected doctor context

**Objective:** Give checks a read-only view of machine and installation facts without importing mutation-heavy launch paths directly.

**Files:**
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/context.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-context.test.js`

**Step 1: Write failing tests**

Use temporary XDG directories and injected fakes to verify that context collection exposes:

- platform and architecture/target triple;
- TTY booleans;
- managed data/state/cache directories;
- pinned terminal-browser version;
- code-server version and configured override;
- no filesystem creation during collection.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-context.test.js
```

Expected: FAIL because context does not exist.

**Step 3: Implement context interfaces**

Keep environment access behind interfaces so tests do not patch globals. Reuse `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/runtime/paths.ts`, `targetTriple()`, `PINNED_VERSION`, and the existing code-server constants for values, but do not call `ensureCodeServer`, `resolveRuntime`, or `ensureServer` while collecting facts.

**Step 4: Run the focused test**

Expected: PASS, including an assertion that the fixture directory remains unchanged.

## Task 4: Add environment, terminal, and managed-path checks

**Objective:** Report basic capability and managed-state findings using the read-only context.

**Files:**
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/checks.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-checks.test.js`

**Step 1: Write failing tests**

Cover:

- supported/unsupported platform values;
- Ghostty, Kitty, and unknown provider detection through injected environment;
- non-TTY behavior does not run an interactive terminal query;
- missing managed directories produce fixable checks without creating them;
- unreadable state/config produces an error or warning with a redacted detail, not file contents.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-checks.test.js
```

Expected: FAIL because check registry functions are absent.

**Step 3: Implement read-only checks**

Add a deterministic registry in the order specified by the design. Terminal palette probing may reuse `queryTerminal()` from `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/terminal/osc.ts` only when a TTY is available and must retain its bounded timeout. Do not call `readPalette()` because it writes the palette cache.

**Step 4: Run the focused test**

Expected: PASS with no fixture mutation.

## Task 5: Add pure runtime and code-server inspection

**Objective:** Distinguish healthy, missing, overridden, and corrupt runtime states without invoking download paths.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/runtime/release.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/codeserver/vendored.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-runtime.test.js`

**Step 1: Write failing tests**

Use temporary roots to cover:

- valid vendored/pinned runtime;
- missing `VERSION`, CLI entry, or Electron entry;
- `TODE_TERMINAL_BROWSER_BIN` override present/missing;
- code-server override and pinned binary present/missing;
- inspection does not call `fetch`, `tar`, `cp`, or write a launcher.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-runtime.test.js
```

Expected: FAIL because read-only inspection functions are absent.

**Step 3: Implement inspection seams**

Add exported pure/read-only functions such as `inspectRuntime(version, roots)` and `inspectCodeServer(version, roots)`. Refactor existing `usable()`/`binAt()` logic so inspection and repair share the same validity definition. Keep `resolveRuntime()` and `ensureCodeServer()` behavior unchanged until the repair tasks.

**Step 4: Run the focused test**

Expected: PASS, including no-network assertions.

## Task 6: Add profile/generated-state inspection

**Objective:** Report missing or stale terminal-code-owned artifacts without rewriting user-owned settings.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/profile.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/bridge.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-profile.test.js`

**Step 1: Write failing tests**

In an isolated XDG data home, verify findings for:

- missing font, CSS, live theme, bridge manifest/source, settings, keybindings record, and theme registration;
- existing user settings not flagged as corrupt merely because they contain user-owned keys;
- generated artifacts are classified as repairable;
- check-only mode performs no writes.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-profile.test.js
```

Expected: FAIL because profile inspection is absent.

**Step 3: Implement ownership-aware inspection**

Expose a read-only inventory of paths and owned entries. Reuse `managedSettings()`, `KEYBINDINGS_RECORD`, `BRIDGE_DIR`, and existing profile constants. Do not call `installSettings`, `installKeybindings`, `installBridge`, `ensureFont`, or theme writers from checks.

**Step 4: Run the focused test**

Expected: PASS.

## Task 7: Add shortcut diagnostics and unresolved-decision classification

**Objective:** Report provider readiness, saved decisions, shared conflicts, and unresolved conflicts without opening the shortcut UI.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/shortcuts/provider.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/shortcuts/wizard.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-shortcuts.test.js`

**Step 1: Write failing tests**

Inject fake providers and verify:

- unsupported provider is reported without an erroring shell command;
- provider not ready is reported with its remediation string;
- saved decisions and shared conflicts are classified as repairable;
- unresolved rows are `needs_input` and have no repair permission;
- a provider scan failure is captured as a check error without writing config.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-shortcuts.test.js
```

Expected: FAIL because the diagnostic adapter is absent.

**Step 3: Implement a read-only shortcut snapshot**

Add a narrow adapter around `providerFor()`, `provider.scan()`, `loadDecisions()`, and existing shared-conflict logic. Keep `applyDecisions()` private or expose only a repair-safe wrapper later. Do not invoke `runManager()` or `shortcutsCommand()` from doctor.

**Step 4: Run the focused test**

Expected: PASS, including no calls to provider mutation methods.

## Task 8: Add daemon inspection and ownership seams

**Objective:** Safely distinguish a healthy daemon, stale state, missing daemon, and an unattributed process/port.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/codeserver/server.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/process.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-daemon.test.js`

**Step 1: Write failing tests**

Use injected process and TCP probes to cover:

- valid state with both owned PIDs and responsive localhost ports;
- missing state;
- dead PIDs with stale state;
- live but unverified PID, which must be blocked;
- occupied port that is not attributable to terminal-code;
- no signal is sent during check-only mode.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-daemon.test.js
```

Expected: FAIL because ownership-aware inspection is absent.

**Step 3: Implement safe inspection**

Refactor the existing private state reader into a read-only snapshot function. Add an injected process identity probe that verifies command/executable identity before any future signal. Reuse `currentServer()` for endpoint semantics where safe, but do not make `currentServer()` kill or clean anything.

**Step 4: Run the focused test**

Expected: PASS, especially the refusal case for an unverified PID.

## Task 9: Add orchestration and report rendering

**Objective:** Run the check registry deterministically, aggregate status, and render the same report as text or JSON.

**Files:**
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/orchestrator.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/report.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-report.test.js`

**Step 1: Write failing tests**

Verify:

- checks run in stable registry order;
- exceptions become report entries rather than aborting unrelated checks;
- JSON output parses as exactly one document;
- stdout contains no progress text;
- text and JSON renderers receive equivalent report objects;
- summary counters and exit code agree with final checks/actions.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-report.test.js
```

Expected: FAIL because the orchestrator and reporters are absent.

**Step 3: Implement check-only orchestration**

Use an interface similar to:

```ts
export interface DoctorRunner {
  run(options: DoctorOptions): Promise<DoctorReport>;
}
```

For this task, `fix` must be rejected or ignored only at the internal repair boundary; the final CLI behavior is wired in Task 10. Serialize with `JSON.stringify(report, null, 2) + "\n"` and keep all progress on an injected stderr writer.

**Step 4: Run the focused test**

Expected: PASS.

## Task 10: Wire `tode doctor` into the CLI

**Objective:** Route the canonical command before the existing path parser without regressing other commands.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/main.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-command.test.js`

**Step 1: Extend failing tests**

Add subprocess/entrypoint coverage for:

- `dist/main.js doctor --json`;
- `dist/main.js doctor --fix --json`;
- `--json` before/after `--fix`;
- existing `--help`, path opening, `--skill`, and `--shutdown` routes still dispatch as before;
- invalid doctor flags return `64` and a JSON usage report only when `--json` was selected.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-command.test.js
```

Expected: FAIL because `main()` still treats `doctor` as a path.

**Step 3: Implement the route and help text**

Add a `doctor` branch before `openCommand(args)`. Do not call `process.exit` from the doctor implementation; return its code to the existing promise chain. Add the canonical forms and side-effect warning to `HELP` near the other commands.

**Step 4: Run the focused test**

Expected: PASS, with all pre-existing command routes unchanged.

## Task 11: Add managed-state and verified runtime repairs

**Objective:** Repair missing managed directories, terminal-browser runtime, and code-server using existing verified provisioning paths.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/repairs.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/runtime/release.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/codeserver/vendored.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-repairs-runtime.test.js`

**Step 1: Write failing tests**

Use injected fake download/unpack functions to verify:

- missing directories are created only under managed roots;
- valid runtime is unchanged;
- missing runtime invokes verified download exactly once;
- checksum failure removes the temporary archive and reports `failed`;
- code-server uses its pinned build and does not replace a valid binary.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-repairs-runtime.test.js
```

Expected: FAIL because repair actions are absent.

**Step 3: Implement actions**

Define repair actions with stable IDs, dependencies, and outcomes. Call existing `resolveRuntime()`/`ensureCodeServer()` only from repair code, passing stderr progress callbacks. Keep check-only execution on the read-only inspection path.

**Step 4: Run the focused test**

Expected: PASS, including the no-partial-artifact assertion.

## Task 12: Add profile and generated-artifact repairs

**Objective:** Regenerate terminal-code-owned profile artifacts while preserving user-authored state.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/repairs.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/profile.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/bridge.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-repairs-profile.test.js`

**Step 1: Write failing tests**

Verify that repair:

- creates the missing generated profile files;
- preserves unknown/user-owned settings and keybindings;
- uses write-if-changed behavior on a second run;
- records each changed/unchanged artifact as an action;
- uses atomic writes for new JSON output.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-repairs-profile.test.js
```

Expected: FAIL because profile repair actions are absent.

**Step 3: Implement profile repair**

Compose existing `ensureFont`, `installTheme`, `installCss`, `setLiveTheme`, `installSettings`, `installKeybindings`, `installBridge`, and theme registration behind explicit repair actions. Read the palette through a repair-safe path; do not make the check pass call these functions.

**Step 4: Run the focused test**

Expected: PASS, including byte-for-byte preservation of user-owned entries.

## Task 13: Add shortcut repair with `needs_input`

**Objective:** Apply saved/shared decisions and leave undecided conflicts untouched.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/repairs.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/shortcuts/wizard.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/shortcuts/backends/ghostty.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/shortcuts/backends/kitty.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-repairs-shortcuts.test.js`

**Step 1: Write failing tests**

Using the existing sandbox patterns in `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/shortcuts-loop.test.js`, verify:

- saved decisions apply through the provider;
- shared conflicts auto-apply;
- undecided conflicts produce a blocked action and final exit code `2`;
- undecided config bytes do not change;
- provider reload hints are recorded;
- an unsupported provider does not receive a config write.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-repairs-shortcuts.test.js
```

Expected: FAIL because the doctor repair adapter is absent.

**Step 3: Implement the repair adapter**

Reuse the provider decision application path, but expose a non-interactive function that accepts only already-recorded decisions. Never call `startManager`, `runManager`, or a browser page from doctor. Capture before/after fingerprints of managed shortcut files for action details.

**Step 4: Run the focused test**

Expected: PASS, with unresolved decisions returning `needs_input` and no guessed ownership.

## Task 14: Add safe daemon lifecycle repair

**Objective:** Clean verified stale state and start/verify owned code-server/injector processes without killing unrelated processes or opening a terminal window.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/repairs.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/codeserver/server.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/process.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-repairs-daemon.test.js`

**Step 1: Write failing tests**

Cover:

- dead recorded PIDs permit stale state cleanup;
- live unverified PIDs block repair and receive no signal;
- absent daemon starts through an injected `ensureServer` seam;
- both upstream and injector endpoints must answer;
- no `terminal-browser open` process is spawned;
- a second repair reports `unchanged`.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-repairs-daemon.test.js
```

Expected: FAIL because lifecycle repair is absent.

**Step 3: Implement ownership-aware repair**

Add a process identity abstraction that can be faked in tests. Only remove state when recorded PIDs are confirmed absent. Only signal a process after identity and expected endpoint checks agree. Use `ensureServer()` for startup after runtime/profile prerequisites are healthy, then verify `currentServer()` and both loopback ports.

**Step 4: Run the focused test**

Expected: PASS, especially the unverified-PID refusal case.

## Task 15: Complete two-pass orchestration and idempotence

**Objective:** Connect the repair registry to the orchestrator and make final checks, not initial checks, authoritative.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/orchestrator.ts`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/doctor/model.ts`
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-idempotence.test.js`

**Step 1: Write failing tests**

Run a disposable fixture through:

1. initial checks;
2. repair pass;
3. final checks;
4. second complete `--fix` pass.

Assert that the second pass has zero changed actions and that unresolved shortcuts still return `2` while unrelated repairs are retained.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-idempotence.test.js
```

Expected: FAIL until repair actions are wired into the second-pass runner.

**Step 3: Implement the full lifecycle**

For `fix: false`, run checks once and return. For `fix: true`, run checks, select eligible actions, execute independent actions in dependency order, run all checks again, aggregate final status, and preserve all action outcomes in the report.

**Step 4: Run the focused test**

Expected: PASS with stable action ordering and no unnecessary writes.

## Task 16: Add CLI integration and stdout/stderr contract tests

**Objective:** Prove the actual built CLI is parseable and side-effect behavior is correct at the process boundary.

**Files:**
- Create: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/test/doctor-cli.test.js`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/package.json` only if a focused test script is genuinely needed; prefer the existing commands.

**Step 1: Write failing tests**

Spawn `/Users/pisitkoolplukpol/Work/terminal-code-doctor/dist/main.js` with isolated XDG paths and assert:

- `doctor --json` stdout is exactly one parseable JSON document;
- stderr does not make stdout invalid;
- check-only mode leaves the fixture unchanged;
- `doctor --json --fix` reports actions and final state;
- exit codes `0`, `1`, `2`, and `64` map to the designed scenarios.

**Step 2: Run to verify failure**

```bash
npm run -s build && node --test test/doctor-cli.test.js
```

Expected: FAIL until the complete CLI path is connected.

**Step 3: Implement only missing boundary behavior**

Do not duplicate checks in the subprocess test. Use injected fixture environment and fake release/process seams where possible; keep one smoke test for real command parsing and report serialization.

**Step 4: Run the focused test**

Expected: PASS.

## Task 17: Document command behavior

**Objective:** Make the new command discoverable and make its side effects and exit codes explicit.

**Files:**
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/README.md`
- Modify: `/Users/pisitkoolplukpol/Work/terminal-code-doctor/src/main.ts`

**Step 1: Write documentation checks**

Manually or with a small text assertion, verify README/help contains:

- `tode doctor --json`;
- `tode doctor --json --fix`;
- stdout/stderr behavior;
- exit codes;
- `needs_input` shortcut behavior;
- warning that `--fix` may download, modify managed config, and start the local daemon.

**Step 2: Implement documentation**

Keep the README example concise and link the JSON report contract to the command semantics. Do not promise unsupported terminal formats or automatic shortcut ownership decisions.

**Step 3: Run documentation validation**

```bash
grep -nE 'tode doctor|needs_input|exit code|--fix' README.md src/main.ts
```

Expected: all required terms are present.

## Task 18: Run the validation matrix

**Objective:** Verify the complete feature without broad, repeated heavy runs.

**Files:**
- No new source files; validation only.

**Step 1: Run focused doctor tests**

```bash
npm run -s build && node --test test/doctor*.test.js
```

Expected: all new doctor tests pass.

**Step 2: Run type checking**

```bash
npm run typecheck
```

Expected: TypeScript and page type checks pass.

**Step 3: Run the existing test suite**

```bash
npm test
```

Expected: existing tests and doctor tests pass after the build.

**Step 4: Run repository hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files are modified/untracked.

**Step 5: Run a minimal CLI smoke test**

```bash
node dist/main.js doctor --json > /tmp/tode-doctor.json
python3 - <<'PY'
import json
with open('/tmp/tode-doctor.json', encoding='utf-8') as handle:
    report = json.load(handle)
assert report["schemaVersion"] == 1
assert "checks" in report and "actions" in report
print(report["summary"]["status"])
PY
```

Expected: the report parses and contains schema version `1`, checks, actions, and summary status.

## Completion checklist

- [ ] `/Users/pisitkoolplukpol/Work/terminal-code-doctor/docs/superpowers/specs/2026-08-20-tode-doctor-json-design.md` remains unchanged after implementation unless the user approves a spec revision.
- [ ] `tode doctor --json` is read-only.
- [ ] `tode doctor --json --fix` records every action and performs a final verification pass.
- [ ] Runtime downloads remain checksum-verified and never replace healthy pinned artifacts.
- [ ] Profile repair preserves user-owned settings/keybindings.
- [ ] Shortcut repair never guesses unresolved ownership and returns `needs_input`.
- [ ] Daemon repair never signals an unverified PID or opens a terminal window.
- [ ] A second identical repair run is idempotent.
- [ ] JSON stdout is parseable and free of progress text.
- [ ] Focused tests, typecheck, full tests, diff check, and CLI smoke validation pass.
- [ ] No commit, push, PR, or deployment is performed without explicit user authorization.
