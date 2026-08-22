import { collectDoctorContext } from "./context";
import { collectDoctorChecks } from "./checks";
import type { CheckRegistryOptions } from "./checks";
import type { DoctorContext } from "./context";
import { makeDoctorReport } from "./report";
import type { DoctorReport } from "./model";
import type { DoctorAction, DoctorCheck } from "./model";
import { repairChecks } from "./repairs";
import type { RepairDependencies } from "./repairs";

export interface DoctorRunnerOptions {
  json: boolean;
  fix: boolean;
}

export interface DoctorRunnerDependencies {
  context?: DoctorContext;
  collectChecks?: (context: DoctorContext) => Promise<DoctorCheck[]>;
  checkOptions?: CheckRegistryOptions;
  repairChecks?: (
    checks: DoctorCheck[],
    context: DoctorContext,
    dependencies: RepairDependencies,
  ) => Promise<DoctorAction[]>;
  repairDependencies?: RepairDependencies;
  now?: () => number;
  stderr?: (message: string) => void;
}

function checkFailure(id: string, error: unknown): DoctorCheck {
  return {
    id,
    status: "error",
    severity: "error",
    fixable: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function collect(
  context: DoctorContext,
  collector: (context: DoctorContext) => Promise<DoctorCheck[]>,
): Promise<DoctorCheck[]> {
  try {
    return await collector(context);
  } catch (error) {
    return [checkFailure("doctor.checks", error)];
  }
}

export async function runDoctor(
  options: DoctorRunnerOptions,
  dependencies: DoctorRunnerDependencies = {},
): Promise<DoctorReport> {
  const now = dependencies.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const context = dependencies.context ?? collectDoctorContext();
  const collector = dependencies.collectChecks ?? ((value: DoctorContext) => collectDoctorChecks(value, dependencies.checkOptions));
  const repairer = dependencies.repairChecks ?? repairChecks;
  const stderr = dependencies.stderr ?? ((message: string) => process.stderr.write(message));
  const repairDependencies: RepairDependencies = {
    ...(dependencies.repairDependencies ?? {}),
    stderr: dependencies.repairDependencies?.stderr ?? stderr,
  };

  const initialChecks = await collect(context, collector);
  let actions: DoctorAction[] = [];
  let finalChecks = initialChecks;
  if (options.fix) {
    try {
      actions = await repairer(initialChecks, context, repairDependencies);
    } catch (error) {
      actions = [
        {
          id: "doctor.repairs",
          status: "failed",
          reversible: false,
          message: error instanceof Error ? error.message : String(error),
          checkIds: [],
          error: {
            kind: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }
    finalChecks = await collect(context, collector);
  }

  return makeDoctorReport({
    command: options,
    context,
    startedAt,
    durationMs: now() - startedAtMs,
    checks: finalChecks,
    actions,
  });
}

export interface DoctorRunner {
  run(options: DoctorRunnerOptions): Promise<DoctorReport>;
}

export function createDoctorRunner(
  dependencies: DoctorRunnerDependencies = {},
): DoctorRunner {
  return { run: (options) => runDoctor(options, dependencies) };
}
