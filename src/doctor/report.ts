import type { DoctorContext } from "./context";
import { summarize } from "./model";
import type {
  DoctorAction,
  DoctorCheck,
  DoctorExitCode,
  DoctorReport,
  DoctorSummary,
} from "./model";

export interface ReportCommand {
  fix: boolean;
  json: boolean;
}

export function environmentSummary(context: DoctorContext): DoctorReport["environment"] {
  return {
    platform: context.environment.platform,
    architecture: context.environment.architecture,
    tty: context.environment.tty.stdout,
    terminalProvider: context.environment.terminalProvider?.id ?? null,
  };
}

export function makeDoctorReport(input: {
  command: ReportCommand;
  context: DoctorContext;
  startedAt: string;
  durationMs: number;
  checks: DoctorCheck[];
  actions?: DoctorAction[];
  exitCode?: DoctorExitCode;
}): DoctorReport {
  const actions = input.actions ?? [];
  const base = summarize(input.checks, actions);
  const summary: DoctorSummary = input.exitCode === undefined
    ? base
    : { ...base, exitCode: input.exitCode };
  return {
    schemaVersion: 1,
    command: { fix: input.command.fix, json: input.command.json },
    startedAt: input.startedAt,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    environment: environmentSummary(input.context),
    summary,
    checks: input.checks,
    actions,
  };
}

export function makeUsageReport(
  context: DoctorContext,
  command: ReportCommand,
  message: string,
  startedAt = new Date().toISOString(),
): DoctorReport {
  const check: DoctorCheck = {
    id: "command.usage",
    status: "error",
    severity: "error",
    fixable: false,
    message,
  };
  return makeDoctorReport({
    command,
    context,
    startedAt,
    durationMs: 0,
    checks: [check],
    exitCode: 64,
  });
}

export function serializeDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function statusLabel(status: string): string {
  return status.replace("_", " ");
}

export function renderDoctorText(report: DoctorReport): string {
  const lines = [
    `tode doctor: ${statusLabel(report.summary.status)} (exit ${report.summary.exitCode})`,
    `checks: ${report.summary.ok} ok, ${report.summary.warnings} warning, ${report.summary.errors} error, ${report.summary.needsInput} needs input`,
  ];
  for (const check of report.checks) {
    lines.push(`  [${statusLabel(check.status)}] ${check.id}: ${check.message}`);
  }
  if (report.actions.length > 0) {
    lines.push("actions:");
    for (const action of report.actions) {
      lines.push(`  [${action.status}] ${action.id}: ${action.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
