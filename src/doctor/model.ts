export type CheckStatus = "ok" | "warning" | "error" | "needs_input" | "skipped";
export type ActionStatus = "changed" | "unchanged" | "blocked" | "failed" | "skipped";
export type Severity = "info" | "warning" | "error";
export type DoctorExitCode = 0 | 1 | 2 | 64;

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  severity: Severity;
  fixable: boolean;
  message: string;
  details?: Record<string, unknown>;
  actionIds?: string[];
}

export interface DoctorAction {
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

export interface DoctorSummary {
  status: CheckStatus;
  checks: number;
  ok: number;
  warnings: number;
  errors: number;
  needsInput: number;
  changed: number;
  blocked: number;
  failed: number;
  exitCode: DoctorExitCode;
}

export interface EnvironmentSummary {
  platform: string;
  architecture: string;
  tty: boolean;
  terminalProvider: string | null;
}

export interface DoctorReport {
  schemaVersion: 1;
  command: {
    fix: boolean;
    json: boolean;
  };
  startedAt: string;
  durationMs: number;
  environment: EnvironmentSummary;
  summary: DoctorSummary;
  checks: DoctorCheck[];
  actions: DoctorAction[];
}

export function summarize(checks: DoctorCheck[], actions: DoctorAction[]): DoctorSummary {
  const errors = checks.filter((check) => check.status === "error").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const needsInput = checks.filter((check) => check.status === "needs_input").length;
  const failed = actions.filter((action) => action.status === "failed").length;
  const changed = actions.filter((action) => action.status === "changed").length;
  const blocked = actions.filter((action) => action.status === "blocked").length;
  const ok = checks.filter((check) => check.status === "ok").length;

  const blockedNeedsInput = actions.some(
    (action) => action.status === "blocked" && action.details?.reason === "needs_input",
  );
  const exitCode: DoctorExitCode = errors > 0 || failed > 0 ? 1 : needsInput > 0 || blockedNeedsInput ? 2 : 0;
  const status: CheckStatus =
    exitCode === 1 ? "error" : exitCode === 2 ? "needs_input" : warnings > 0 ? "warning" : "ok";

  return {
    status,
    checks: checks.length,
    ok,
    warnings,
    errors,
    needsInput,
    changed,
    blocked,
    failed,
    exitCode,
  };
}
