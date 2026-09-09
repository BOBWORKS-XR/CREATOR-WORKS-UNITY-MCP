import { randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

import type { BanterMCPConfig } from "./config.js";
import { atomicWriteFileSync } from "./files.js";

export const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_HEARTBEAT_MAX_AGE_MS = 10_000;
const PIPE_RESPONSE_LIMIT_BYTES = 64 * 1024;

export interface BridgeCommandResult {
  status?: "dispatched" | "completed";
  observed?: Record<string, unknown>;
  commandId?: string;
  success?: boolean;
  message?: string;
  error?: string;
  timestamp?: number;
  projectId?: string;
  projectPath?: string;
  editorInstanceId?: string;
}

export interface BridgeTransportDispatch {
  commandId: string;
  acknowledgement?: BridgeCommandResult;
  transport: "named_pipe" | "file";
  queued: boolean;
  fallbackReason?: string;
}

export interface BridgeInstanceDescriptor {
  editorInstanceId?: string;
  projectPath?: string;
  projectName?: string;
  bridgeVersion?: string;
  protocolVersion?: number;
  minimumProtocolVersion?: number;
  capabilities?: string[];
  preferredTransport?: string;
  pipeName?: string;
  processId?: number;
  updatedAt?: number;
}

interface PipeAttempt {
  status: "acknowledged" | "sent_without_acknowledgement" | "unavailable";
  acknowledgement?: BridgeCommandResult;
  reason?: string;
}

export async function dispatchUnityBridgeCommand(
  command: Record<string, unknown>,
  config: BanterMCPConfig,
  timeoutMs = 3000
): Promise<BridgeTransportDispatch> {
  const commandId = randomUUID();
  const descriptor = readBridgeInstanceDescriptor(config);
  if (descriptor?.projectPath && !pathsReferToSameProject(descriptor.projectPath, config.unityProjectPath)) {
    throw new Error(
      `Unity bridge project mismatch: selected '${config.unityProjectPath}', descriptor reports '${descriptor.projectPath}'.`
    );
  }
  const payload = {
    ...command,
    id: commandId,
    timestamp: Date.now(),
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    expectedProjectId: config.projectId,
    expectedProjectPath: config.unityProjectPath,
    expectedEditorInstanceId: descriptor?.editorInstanceId,
  };

  const pipeEligibility = namedPipeEligibility(descriptor);
  if (pipeEligibility.eligible && descriptor?.pipeName) {
    const pipeAttempt = await sendOverNamedPipe(payload, descriptor.pipeName, timeoutMs);
    if (pipeAttempt.status === "acknowledged") {
      assertAcknowledgementTarget(pipeAttempt.acknowledgement, config, descriptor.editorInstanceId);
      return {
        commandId,
        acknowledgement: pipeAttempt.acknowledgement,
        transport: "named_pipe",
        queued: false,
      };
    }

    if (pipeAttempt.status === "sent_without_acknowledgement") {
      return {
        commandId,
        transport: "named_pipe",
        queued: true,
        fallbackReason: pipeAttempt.reason,
      };
    }

    return dispatchOverFiles(
      payload,
      commandId,
      config,
      timeoutMs,
      descriptor?.editorInstanceId,
      pipeAttempt.reason
    );
  }

  return dispatchOverFiles(
    payload,
    commandId,
    config,
    timeoutMs,
    descriptor?.editorInstanceId,
    pipeEligibility.reason
  );
}

export function readBridgeInstanceDescriptor(
  config: BanterMCPConfig
): BridgeInstanceDescriptor | undefined {
  const descriptorPath = path.join(config.mcpStatePath, "project-instance.json");
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf-8")) as BridgeInstanceDescriptor;
    return descriptor && typeof descriptor === "object" ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

function namedPipeEligibility(
  descriptor: BridgeInstanceDescriptor | undefined
): { eligible: boolean; reason?: string } {
  if (process.platform !== "win32") {
    return { eligible: false, reason: "Named-pipe transport is currently available on Windows only." };
  }
  if (!descriptor) {
    return { eligible: false, reason: "The bridge instance descriptor is unavailable." };
  }
  if (
    typeof descriptor.updatedAt !== "number" ||
    Date.now() - descriptor.updatedAt > BRIDGE_HEARTBEAT_MAX_AGE_MS
  ) {
    return { eligible: false, reason: "The bridge instance descriptor is stale." };
  }
  if (
    descriptor.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    (descriptor.minimumProtocolVersion ?? BRIDGE_PROTOCOL_VERSION) > BRIDGE_PROTOCOL_VERSION
  ) {
    return {
      eligible: false,
      reason: `Bridge protocol ${String(descriptor.protocolVersion)} is not compatible with server protocol ${BRIDGE_PROTOCOL_VERSION}.`,
    };
  }
  if (!descriptor.capabilities?.includes("named_pipe_commands")) {
    return { eligible: false, reason: "The bridge does not advertise named-pipe commands." };
  }
  if (
    typeof descriptor.pipeName !== "string" ||
    !/^bantworks-unity-[A-Za-z0-9._-]{1,100}$/.test(descriptor.pipeName)
  ) {
    return { eligible: false, reason: "The bridge pipe name is missing or invalid." };
  }
  return { eligible: true };
}

async function dispatchOverFiles(
  payload: Record<string, unknown>,
  commandId: string,
  config: BanterMCPConfig,
  timeoutMs: number,
  expectedEditorInstanceId?: string,
  fallbackReason?: string
): Promise<BridgeTransportDispatch> {
  const commandFile = path.join(config.mcpCommandsPath, `${commandId}.json`);
  atomicWriteFileSync(commandFile, JSON.stringify(payload, null, 2));
  const acknowledgement = await waitForFileAcknowledgement(commandId, config, timeoutMs);
  assertAcknowledgementTarget(acknowledgement, config, expectedEditorInstanceId);

  return {
    commandId,
    acknowledgement,
    transport: "file",
    queued: !acknowledgement,
    fallbackReason,
  };
}

async function waitForFileAcknowledgement(
  commandId: string,
  config: BanterMCPConfig,
  timeoutMs: number
): Promise<BridgeCommandResult | undefined> {
  const resultPath = path.join(config.mcpStatePath, "command-results", `${commandId}.json`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as BridgeCommandResult;
        if (result.commandId === commandId) {
          fs.unlinkSync(resultPath);
          return result;
        }
      } catch {
        // The bridge may still be atomically publishing the result.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return undefined;
}

function assertAcknowledgementTarget(
  acknowledgement: BridgeCommandResult | undefined,
  config: BanterMCPConfig,
  expectedEditorInstanceId?: string
): void {
  if (!acknowledgement) return;
  if (acknowledgement.projectPath &&
      !pathsReferToSameProject(acknowledgement.projectPath, config.unityProjectPath)) {
    throw new Error(
      `Unity acknowledgement project mismatch: selected '${config.unityProjectPath}', result reports '${acknowledgement.projectPath}'.`
    );
  }
  if (expectedEditorInstanceId && acknowledgement.editorInstanceId &&
      acknowledgement.editorInstanceId !== expectedEditorInstanceId) {
    throw new Error(
      `Unity acknowledgement Editor mismatch: expected '${expectedEditorInstanceId}', result reports '${acknowledgement.editorInstanceId}'.`
    );
  }
}

function sendOverNamedPipe(
  payload: Record<string, unknown>,
  pipeName: string,
  timeoutMs: number
): Promise<PipeAttempt> {
  return new Promise((resolve) => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const socket = net.createConnection(pipePath);
    let commandMayHaveBeenDelivered = false;
    let responseBytes = 0;
    let response = "";
    let settled = false;

    const finish = (result: PipeAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(commandMayHaveBeenDelivered
        ? {
            status: "sent_without_acknowledgement",
            reason: "The named-pipe command was sent but Unity did not acknowledge it before the timeout.",
          }
        : {
            status: "unavailable",
            reason: "The named-pipe endpoint did not accept the command before the timeout.",
          });
    }, Math.max(250, timeoutMs));

    socket.once("connect", () => {
      commandMayHaveBeenDelivered = true;
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > PIPE_RESPONSE_LIMIT_BYTES) {
        finish({
          status: "sent_without_acknowledgement",
          reason: "The named-pipe acknowledgement exceeded the response size limit.",
        });
        return;
      }

      response += chunk.toString("utf-8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;

      try {
        const acknowledgement = JSON.parse(response.slice(0, newline)) as BridgeCommandResult;
        if (acknowledgement.commandId !== payload.id) {
          finish({
            status: "sent_without_acknowledgement",
            reason: "Unity returned an acknowledgement for a different command.",
          });
          return;
        }
        finish({ status: "acknowledged", acknowledgement });
      } catch {
        finish({
          status: "sent_without_acknowledgement",
          reason: "Unity returned an invalid named-pipe acknowledgement.",
        });
      }
    });

    socket.once("error", (error) => {
      finish(commandMayHaveBeenDelivered
        ? {
            status: "sent_without_acknowledgement",
            reason: `The named-pipe connection failed after sending the command: ${error.message}`,
          }
        : {
            status: "unavailable",
            reason: `The named-pipe endpoint is unavailable: ${error.message}`,
          });
    });

    socket.once("end", () => {
      if (!settled) {
        finish(commandMayHaveBeenDelivered
          ? {
              status: "sent_without_acknowledgement",
              reason: "The named-pipe connection closed before Unity acknowledged the command.",
            }
          : {
              status: "unavailable",
              reason: "The named-pipe connection closed before the command was sent.",
            });
      }
    });
  });
}

function pathsReferToSameProject(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value.trim()).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  return Boolean(left?.trim() && right?.trim()) && normalize(left) === normalize(right);
}
