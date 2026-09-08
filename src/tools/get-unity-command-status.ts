import * as fs from "fs";
import * as path from "path";

import type { BanterMCPConfig } from "../lib/config.js";
import { projectIdForPath } from "../lib/project-router.js";
import {
  readBridgeInstanceDescriptor,
  type BridgeCommandResult,
} from "../lib/unity-bridge-transport.js";

export interface UnityCommandStatusResult extends Record<string, unknown> {
  success: boolean;
  accepted?: boolean;
  pending?: boolean;
  status: "completed" | "pending" | "unknown";
  commandId: string;
  projectId?: string;
  projectPath: string;
  editorInstanceId?: string;
  message?: string;
  error?: string;
}

export function pendingCommandTimeout(commandId: string, config: BanterMCPConfig, error: string) {
  const projectId = config.projectId || projectIdForPath(config.unityProjectPath);
  return {
    success: false,
    pending: true,
    status: "result_timeout",
    commandId,
    projectId,
    projectPath: config.unityProjectPath,
    error,
    message: "Completion is unknown; this command may still execute. Do not resubmit it. Check Unity for a dialog, open menu, reload, or long-running work, then poll the original command.",
    nextAction: { tool: "get_unity_command_status", arguments: { commandId, projectId } },
  };
}

export function getUnityCommandStatus(
  commandId: string,
  projectId: string,
  config: BanterMCPConfig
): UnityCommandStatusResult {
  if (!isSafeCommandId(commandId)) {
    return failure(commandId, config, "commandId must be a UUID returned by a Unity command.");
  }
  if (!projectId || projectId !== config.projectId) {
    return failure(
      commandId,
      config,
      `Project mismatch: status was requested for '${projectId || "(missing)"}', but the selected project is '${config.projectId || "(unrouted)"}'. Reselect the intended project first.`
    );
  }

  const descriptor = readBridgeInstanceDescriptor(config);
  const resultPath = path.join(config.mcpStatePath, "command-results", `${commandId}.json`);
  if (fs.existsSync(resultPath)) {
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as BridgeCommandResult;
      if (result.commandId !== commandId) {
        return failure(commandId, config, "Unity command result correlation ID did not match the request.");
      }
      if (result.projectPath && !pathsReferToSameProject(result.projectPath, config.unityProjectPath)) {
        return failure(
          commandId,
          config,
          `Unity command result came from '${result.projectPath}', not selected project '${config.unityProjectPath}'.`
        );
      }
      if (descriptor?.editorInstanceId && result.editorInstanceId &&
          descriptor.editorInstanceId !== result.editorInstanceId) {
        return failure(
          commandId,
          config,
          `Unity command result came from Editor '${result.editorInstanceId}', not active Editor '${descriptor.editorInstanceId}'.`
        );
      }
      fs.unlinkSync(resultPath);
      return {
        success: result.success === true,
        accepted: true,
        pending: false,
        status: "completed",
        commandId,
        projectId: config.projectId,
        projectPath: result.projectPath || config.unityProjectPath,
        editorInstanceId: result.editorInstanceId,
        message: result.message,
        error: result.error,
      };
    } catch (error) {
      return failure(
        commandId,
        config,
        `Could not read Unity command result: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  const commandPath = path.join(config.mcpCommandsPath, `${commandId}.json`);
  if (fs.existsSync(commandPath)) {
    return {
      success: false,
      accepted: true,
      pending: true,
      status: "pending",
      commandId,
      projectId: config.projectId,
      projectPath: config.unityProjectPath,
      editorInstanceId: descriptor?.editorInstanceId,
      message: "Unity has not completed this command yet.",
    };
  }

  return {
    success: false,
    accepted: false,
    pending: false,
    status: "unknown",
    commandId,
    projectId: config.projectId,
    projectPath: config.unityProjectPath,
    editorInstanceId: descriptor?.editorInstanceId,
    error: "No pending command or correlated result exists in the selected project's state directory.",
  };
}

function failure(commandId: string, config: BanterMCPConfig, error: string): UnityCommandStatusResult {
  return {
    success: false,
    accepted: false,
    pending: false,
    status: "unknown",
    commandId,
    projectId: config.projectId,
    projectPath: config.unityProjectPath,
    error,
  };
}

function isSafeCommandId(value: string): boolean {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function pathsReferToSameProject(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value.trim()).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return Boolean(left?.trim() && right?.trim()) && normalize(left) === normalize(right);
}
