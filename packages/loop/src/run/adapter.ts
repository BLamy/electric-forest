import type { Event, Offset } from "@eforest/protocol";
import {
  runArtifactEvent,
  runGateResultEvent,
  runInputEvent,
  runToolResultEvent,
  type RunAppendEvent,
} from "./events.js";
import type { WorkspaceManifest } from "./workspace.js";

export type AdapterExitStatus = "completed" | "failed" | "crashed";

export interface AgentMutationRequest {
  readonly operationId: string;
  readonly target: "branch" | "evidence" | "verdict";
  readonly stream: string;
  readonly event: Event;
}

export interface AgentMutationReceipt {
  readonly operationId: string;
  readonly target: AgentMutationRequest["target"];
  readonly stream: string;
  readonly targetOffset: Offset;
}

export interface AgentAdapterContext {
  readonly role: "builder" | "critic";
  readonly taskId: string;
  readonly runId: string;
  readonly workspace: WorkspaceManifest;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly now: () => number;
  readonly assertActive: () => Promise<void>;
  readonly append: (event: RunAppendEvent) => Promise<void>;
  readonly mutate: (request: AgentMutationRequest) => Promise<AgentMutationReceipt>;
}

export interface AgentAdapterResult {
  readonly status: AdapterExitStatus;
  readonly mutations: number;
  readonly steps: number;
}

export interface AgentAdapter {
  readonly name: string;
  run(context: AgentAdapterContext): Promise<AgentAdapterResult>;
}

export type ScriptedStep =
  | {
      readonly kind: "input";
      readonly name: string;
      readonly digest: string;
      readonly size: number;
      readonly summary?: string;
    }
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly ok: boolean;
      readonly outputDigest: string;
      readonly summary?: string;
    }
  | {
      readonly kind: "gate";
      readonly gate: string;
      readonly ok: boolean;
      readonly exitCode: number;
      readonly outputDigest: string;
    }
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
      readonly artifactKind: string;
      readonly digest: string;
      readonly size: number;
    }
  | (AgentMutationRequest & { readonly kind: "mutation" })
  | { readonly kind: "crash"; readonly reason?: string }
  | { readonly kind: "exit"; readonly status: "completed" | "failed" };

export class ScriptedCrashError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ScriptedCrashError";
  }
}

/** A deterministic adapter used by the run protocol tests and local harness. */
export class ScriptedAgentAdapter implements AgentAdapter {
  readonly name = "scripted";

  constructor(private readonly steps: readonly ScriptedStep[]) {}

  async run(context: AgentAdapterContext): Promise<AgentAdapterResult> {
    let mutations = 0;
    let steps = 0;
    for (const step of this.steps) {
      steps += 1;
      await context.assertActive();
      switch (step.kind) {
        case "input":
          await context.append(
            runInputEvent(
              {
                name: step.name,
                digest: step.digest,
                size: step.size,
                ...(step.summary === undefined ? {} : { summary: step.summary }),
              },
              context.now(),
            ),
          );
          break;
        case "tool":
          await context.append(
            runToolResultEvent(
              {
                tool: step.tool,
                ok: step.ok,
                outputDigest: step.outputDigest,
                ...(step.summary === undefined ? {} : { summary: step.summary }),
              },
              context.now(),
            ),
          );
          break;
        case "gate":
          await context.append(
            runGateResultEvent(
              {
                gate: step.gate,
                ok: step.ok,
                exitCode: step.exitCode,
                outputDigest: step.outputDigest,
              },
              context.now(),
            ),
          );
          break;
        case "artifact":
          await context.append(
            runArtifactEvent(
              {
                artifactId: step.artifactId,
                kind: step.artifactKind,
                digest: step.digest,
                size: step.size,
              },
              context.now(),
            ),
          );
          break;
        case "mutation":
          await context.mutate(step);
          mutations += 1;
          break;
        case "crash":
          throw new ScriptedCrashError(step.reason ?? "scripted-crash");
        case "exit":
          return { status: step.status, mutations, steps };
      }
    }
    return { status: "completed", mutations, steps };
  }
}
