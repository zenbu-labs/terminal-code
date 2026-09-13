# Design: `tode doctor --json` and `--fix`

**Date:** 2026-08-20
**Status:** Design approved for written-spec review
**Repository:** `zenbu-labs/terminal-code`
**Branch:** `feat/tode-doctor-json`

## Problem

`terminal-code` currently discovers and repairs parts of its installation opportunistically while opening the editor. Runtime resolution, code-server provisioning, profile generation, shortcut integration, and daemon startup are spread across the normal launch path. When one of those steps fails, users receive a narrow error from the operation that happened to encounter the problem rather than a complete diagnosis.

This is particularly difficult for automated support and agent workflows. A caller needs a deterministic way to answer:

- Which terminal-code capabilities are available on this machine?
- Which local installation components are missing, stale, or unhealthy?
- Which problems can be repaired safely without an interactive wizard?
- What exactly changed after a repair attempt?
- Which problems still require a human decision?

The project needs a diagnostic command that can be used by a human, CI, or an agent without scraping prose or guessing from side effects.

## Goals

1. Add the canonical command:

   ```text
   tode doctor [--json] [--fix]
   ```

2. Make `--json` emit exactly one machine-readable JSON document on stdout.
3. Keep progress, warnings, and debug details on stderr so stdout is safe to pipe into a parser.
4. Make `doctor` without `--fix` observational: it must not download, write, start, stop, or modify anything.
5. Make `doctor --fix` repair all deterministic problems within terminal-code's managed surface, including runtime, profile, supported terminal configuration, and the owned code-server/injector daemon.
6. Re-run checks after repair and report both attempted actions and final state.
7. Preserve non-interactive behavior. A shortcut conflict that has no saved decision must become `needs_input`; it must not be resolved by guessing.
8. Make repairs idempotent: a second run after a successful repair should produce no unnecessary mutations.
9. Reuse existing checksum, path, provider, profile, and server abstractions rather than creating parallel state formats.
10. Give KiroCrew and other agents a stable, versioned capability/report contract.

## Non-goals

- Replacing the interactive `tode --shortcut-setup` wizard.
- Choosing an owner for a shortcut conflict that the user has not decided.
- Upgrading a healthy installation to a newer release. `doctor --fix` repairs the pinned/current installation; `tode --upgrade` remains the upgrade command.
- Managing arbitrary user projects, VS Code extensions, shell dotfiles, or unrelated processes.
- Exposing code-server beyond its existing localhost-only binding.
- Executing arbitrary shell commands from report data or repair requests.
- Adding a remote telemetry service or uploading diagnostic reports.

## User-facing contract

### Commands and flags

The canonical forms are:

```bash
tode doctor
tode doctor --json
tode doctor --fix
tode doctor --json --fix
```

`--json` and `--fix` may appear in either order. Unknown doctor flags are usage errors. The existing `tode` path-opening behavior remains unchanged for all other argument shapes.

The help text must document `doctor`, `--json`, and `--fix`, including that `--fix` may download verified runtime artifacts, alter terminal-code-managed configuration, and start the owned local daemon.

### Output channels

For `--json`:

- stdout contains one JSON document followed by one newline;
- no progress, spinner, warning, or stack trace is written to stdout;
- human-readable progress and diagnostics go to stderr;
- errors are represented in the JSON report whenever report generation can continue.

For non-JSON mode, the same report model is rendered as concise human-readable sections. The command must not have a separate diagnosis implementation for text mode.

### Exit codes

The command returns:

- `0` when all checks are healthy after the optional repair pass;
- `1` when a check or repair failed, or a final error remains;
- `2` when a deterministic repair is blocked by a required user decision, including unresolved shortcut conflicts;
- `64` for invalid command-line usage.

The report always includes the selected exit code in `summary.exitCode`. If both a failed repair and `needs_input` are present, the failed-repair code `1` takes precedence.

## Architecture

The feature is a check/repair plan engine. The CLI adapter stays thin and the check/repair units are independently testable.

### Proposed modules

```text
src/doctor/
  model.ts          // public report, check, action, status types
  context.ts        // read-only machine/install facts and dependency injection seams
  checks.ts         // check registry and individual check implementations
  repairs.ts        // repair registry and dependency-ordered actions
  orchestrator.ts   // collect -> optionally repair -> collect again
  report.ts         // JSON serialization and human rendering
  doctor.ts         // command entrypoint and option validation
```

The exact file split may be adjusted during implementation if an existing module provides a better seam, but the responsibilities must remain separate:

- checks never mutate state;
- repairs declare their prerequisites and record outcomes;
- orchestration owns ordering and the second verification pass;
- rendering never performs checks or repairs.

### Core model

The model should use explicit string unions so the JSON contract is stable and TypeScript exhaustiveness checks catch new states.

```ts
type CheckStatus = "ok" | "warning" | "error" | "needs_input" | "skipped";
type ActionStatus = "changed" | "unchanged" | "blocked" | "failed" | "skipped";
type Severity = "info" | "warning" | "error";

interface DoctorReport {
  schemaVersion: 1;
  command: {
    fix: boolean;
    json: boolean;
  };
  startedAt: string;
  durationMs: number;
  environment: EnvironmentSummary;
  summary: {
    status: CheckStatus;
    checks: number;
    ok: number;
    warnings: number;
    errors: number;
    needsInput: number;
    changed: number;
    blocked: number;
    failed: number;
    exitCode: 0 | 1 | 2 | 64;
  };
  checks: DoctorCheck[];
  actions: DoctorAction[];
}

interface DoctorCheck {
  id: string;
  status: CheckStatus;
  severity: Severity;
  fixable: boolean;
  message: string;
  details?: Record<string, unknown>;
  actionIds?: string[];
}

interface DoctorAction {
  id: string;
  status: ActionStatus;
  reversible: boolean;
  message: string;
  checkIds: string[];
  details?: Record<string, unknown>;
  error?: {
    kind: string;
    message: string;
  };
}
```

The report may include paths needed to understand an action, but it must not include secrets, complete environment dumps, shell command strings, access tokens, or arbitrary file contents. Sensitive paths should be redacted or represented by a stable category unless a future explicitly opt-in verbose mode is added.

### Check registry

Checks are run in deterministic order and receive a read-only context. The initial registry covers:

1. `environment.platform`
   - OS and supported target triple from the existing runtime abstraction;
   - architecture;
   - whether stdout/stderr/stdin are TTYs;
   - whether the command is running in a context where interactive terminal queries are unavailable.

2. `environment.terminal`
   - detected Ghostty/Kitty provider, or unsupported/unknown terminal;
   - provider readiness and reload hint;
   - terminal palette query result when a TTY is available, with bounded timeouts;
   - no terminal query may hang the command or change terminal configuration.

3. `paths.managedState`
   - required managed directories;
   - install receipt/version/channel where available;
   - readable/writable status without creating anything in check-only mode.

4. `runtime.terminalBrowser`
   - pinned version, target triple, source, and `usable()` result;
   - vendored, pinned, system, override, and missing states;
   - no release lookup or download during the check pass.

5. `runtime.codeServer`
   - configured/pinned code-server version and whether the executable is present and runnable;
   - no provisioning during the check pass.

6. `profile.generatedState`
   - generated bridge, theme, CSS, settings, keybindings, font, and extension registration state that terminal-code owns;
   - user-authored settings and extensions outside owned entries are not treated as repair targets.

7. `shortcuts.configuration`
   - provider detection and readiness;
   - recorded decisions;
   - current conflicts and whether each conflict has a saved decision;
   - shared conflicts that can be auto-applied;
   - unresolved conflicts are `needs_input`, not `error`, unless the provider itself is corrupt.

8. `daemon.state`
   - parse and freshness of the state file;
   - ownership and liveness of the code-server and injector PIDs;
   - localhost port responsiveness;
   - stale state versus an actually healthy daemon.

The check layer must not call `resolveRuntime`, `ensureCodeServer`, `ensureServer`, `installBridge`, `provider.apply`, or other mutating functions. It should use or introduce pure/read-only counterparts where current helpers combine observation and mutation.

## Repair behavior

`--fix` performs a repair pass only after the initial check pass has been collected. Each action is idempotent, has a stable ID, and records its result even when it fails. Independent actions continue after a failure; dependent actions are marked `skipped` or `blocked` with the dependency reason.

### Repair order

1. **Managed directories and state prerequisites**
   - create only directories owned by terminal-code;
   - never create or modify a user project directory;
   - use the existing path abstraction so overrides remain respected.

2. **Terminal-browser runtime**
   - prefer an existing valid vendored, pinned, system, or explicitly configured override;
   - if the pinned runtime is absent, use the existing verified release lookup/download/unpack path;
   - preserve SHA-256 and size verification;
   - remove incomplete or checksum-invalid temporary archives;
   - never replace a valid runtime merely because a newer release exists.

3. **Code-server runtime**
   - use the existing pinned provisioning path;
   - verify the executable after provisioning;
   - report network, permission, or version failures without hiding the original cause.

4. **Owned generated profile**
   - regenerate only terminal-code-owned bridge, theme, CSS, settings, keybindings, extension registration, and font artifacts;
   - preserve user-owned settings and unrelated keybindings;
   - use existing write-if-changed behavior where available;
   - use atomic writes for new repair code so interrupted repairs do not leave truncated JSON.

5. **Terminal shortcuts**
   - if a supported provider has saved decisions, apply those decisions through the existing provider abstraction;
   - auto-apply only conflicts already classified as shared by the existing logic;
   - if an unresolved conflict needs a user choice, record `needs_input` and do not mutate that conflict;
   - if a provider is unsupported, report the capability and a remediation hint rather than writing an unknown config format;
   - preserve the existing undo path and report whether a reload/restart is needed.

6. **Daemon lifecycle**
   - remove a stale state file only when its recorded processes are confirmed absent;
   - never send a signal to a PID unless its identity is confirmed as a terminal-code-owned code-server/injector process;
   - if the owned daemon is absent and prerequisites are healthy, start it through the existing server abstraction;
   - verify both localhost endpoints after startup;
   - do not launch a terminal-browser window;
   - if a PID or port cannot be safely attributed, report `blocked` rather than killing or hijacking it.

After all possible actions, the orchestrator runs the complete check registry again. The final checks, not the initial checks, determine the exit code and overall status. The report retains action results so a caller can distinguish a repaired warning from an unresolved failure.

## JSON examples

Healthy check-only invocation:

```json
{
  "schemaVersion": 1,
  "command": { "fix": false, "json": true },
  "startedAt": "2026-08-20T00:00:00.000Z",
  "durationMs": 42,
  "environment": {
    "platform": "darwin",
    "architecture": "arm64",
    "tty": true,
    "terminalProvider": "ghostty"
  },
  "summary": {
    "status": "ok",
    "checks": 1,
    "ok": 1,
    "warnings": 0,
    "errors": 0,
    "needsInput": 0,
    "changed": 0,
    "blocked": 0,
    "failed": 0,
    "exitCode": 0
  },
  "checks": [
    {
      "id": "runtime.terminalBrowser",
      "status": "ok",
      "severity": "info",
      "fixable": true,
      "message": "pinned runtime is available"
    }
  ],
  "actions": []
}
```

A repair with an unresolved shortcut decision:

```json
{
  "schemaVersion": 1,
  "command": { "fix": true, "json": true },
  "startedAt": "2026-08-20T00:00:00.000Z",
  "durationMs": 812,
  "environment": {
    "platform": "darwin",
    "architecture": "arm64",
    "tty": true,
    "terminalProvider": "ghostty"
  },
  "summary": {
    "status": "needs_input",
    "checks": 8,
    "ok": 7,
    "warnings": 0,
    "errors": 0,
    "needsInput": 1,
    "changed": 2,
    "blocked": 1,
    "failed": 0,
    "exitCode": 2
  },
  "checks": [
    {
      "id": "shortcuts.configuration",
      "status": "needs_input",
      "severity": "warning",
      "fixable": false,
      "message": "1 shortcut conflict has no saved decision",
      "details": { "provider": "ghostty", "unresolved": 1 },
      "actionIds": ["shortcuts.apply-decisions"]
    }
  ],
  "actions": [
    {
      "id": "shortcuts.apply-decisions",
      "status": "blocked",
      "reversible": true,
      "message": "left unresolved conflicts unchanged",
      "checkIds": ["shortcuts.configuration"],
      "details": { "reason": "needs_input" }
    }
  ]
}
```

The examples are illustrative; the implementation must populate all summary counters consistently and must not omit real check entries. The healthy example shows one check for compactness, while an empty `actions` array is expected when no repair was requested or no mutation was needed.

## Error handling and safety

- Each check and action catches expected operational errors and converts them into typed report data.
- Unexpected programming errors are reported as `failed` with a redacted message and also written to stderr in non-JSON mode.
- Network failures identify the release operation and endpoint category but do not include credentials or response bodies.
- Permission failures identify the managed category and path class without dumping file contents.
- Failed downloads leave no accepted partial runtime; checksum failure is terminal for that action.
- A repair pass never silently falls back to an interactive prompt.
- Concurrent invocations must not corrupt shared state. New repair code should use existing lock/atomic patterns or fail with a clear busy result.
- The daemon repair must not trust a PID solely because it is alive. PID identity and expected localhost endpoint must agree before any signal is sent.
- The command must not expose code-server's local unauthenticated endpoint on a non-loopback address.

## Testing strategy

Tests should be deterministic and avoid live network, terminal graphics, or real daemon mutation.

### Unit tests

- option parsing for `doctor`, `--json`, `--fix`, ordering, unknown flags, and usage exit code;
- check status aggregation and exit-code precedence;
- JSON serialization is valid, stable, single-document output;
- human and JSON reporters consume the same report model;
- path/environment checks with fake filesystem facts;
- runtime checks distinguish vendored, pinned, override, missing, and corrupt states;
- repair ordering and dependency blocking;
- action idempotence and write-if-changed behavior;
- checksum failure removes incomplete artifacts;
- shortcut saved-decision application and unresolved-conflict `needs_input` behavior;
- daemon state parsing, endpoint checks, stale-state cleanup, and PID-ownership refusal;
- no check-only operation writes, downloads, starts, stops, or mutates configuration.

### Integration/CLI tests

- `tode doctor --json` can be parsed from stdout while stderr contains no JSON contamination;
- `tode doctor --json --fix` repairs a disposable fixture and a second run reports no changes;
- a failed runtime download still produces a complete report and non-zero exit code;
- a shortcut conflict requiring input repairs unrelated components but exits `2`;
- daemon startup verifies both code-server and injector endpoints without opening a terminal window;
- existing shortcut, profile, runtime, bridge, theme, and import tests remain green.

The test harness should inject filesystem, network, process, terminal, and clock dependencies rather than patching global behavior. No test may use the user's real home, terminal config, or running daemon.

## Acceptance criteria

The implementation is complete when:

1. `tode doctor --json` exists, is documented in help, and emits valid JSON with no side effects.
2. `tode doctor --json --fix` performs the ordered repair pass and emits every action outcome.
3. Runtime and code-server repair reuse verified existing provisioning paths and do not upgrade healthy installations.
4. Profile repair preserves user-owned settings and keybindings.
5. Supported terminal shortcut repair uses only saved decisions/shared auto-apply; unresolved choices remain unchanged and return `needs_input`.
6. Daemon repair starts only owned local processes, never kills an unverified PID, and verifies both endpoints.
7. A second identical `--fix` run is idempotent.
8. JSON stdout is safe for CI/agent consumption and contains no secrets or arbitrary command text.
9. Targeted tests cover all check and repair categories, and the repository's existing typecheck/build/test commands pass.
10. README/help documentation explains side effects, exit codes, unsupported-terminal behavior, and the `needs_input` result.

## Implementation sequencing

1. Add the report model, dependency-injected context, option parser, and reporter with pure tests.
2. Add read-only checks and check aggregation; wire `tode doctor` without repair.
3. Add deterministic managed-state, runtime, code-server, and profile repairs.
4. Add shortcut decision repair and explicit `needs_input` reporting.
5. Add daemon ownership checks and lifecycle repair.
6. Add CLI/integration tests, help/README documentation, and run the targeted validation matrix.

No source implementation is part of this design-spec change. The next step is a detailed implementation plan after the user reviews this document.
