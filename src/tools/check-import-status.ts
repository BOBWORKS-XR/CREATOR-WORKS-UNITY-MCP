/**
 * Check Import Status
 *
 * Verify that Unity has imported assets correctly.
 */

import * as fs from "fs";
import * as path from "path";
import type { BanterMCPConfig } from "../lib/config.js";

export interface ImportStatusResult {
  success: boolean;
  imported: boolean;
  errors?: string[];
  warnings?: string[];
  assetPath?: string;
  message?: string;
  isCompiling?: boolean;
  isUpdating?: boolean;
  editorStateTimestamp?: number;
  editorStateAgeMs?: number;
  compilationCompleted?: boolean;
  compilationHasErrors?: boolean;
  compilationTimestamp?: number;
  compilerErrors?: BridgeCompilerMessage[];
  compilerWarnings?: BridgeCompilerMessage[];
  stale?: boolean;
  heartbeatStale?: boolean;
  compilationStatusAgeMs?: number;
  compilationStale?: boolean;
  staleAssembly?: boolean;
}

interface BridgeAssetStatus {
  path: string;
  hasErrors?: boolean;
  errors?: string[];
  warnings?: string[];
}

interface BridgeImportStatus {
  completed?: boolean;
  hasErrors?: boolean;
  errorMessage?: string;
  errors?: string[];
  warnings?: string[];
  timestamp?: number;
  assets?: BridgeAssetStatus[];
}

interface BridgeEditorState {
  isCompiling?: boolean;
  isUpdating?: boolean;
  timestamp?: number;
}

export interface BridgeCompilerMessage {
  assemblyPath?: string;
  type?: string;
  message?: string;
  file?: string;
  line?: number;
  column?: number;
}

interface BridgeCompilationStatus {
  completed?: boolean;
  hasErrors?: boolean;
  startedAt?: number;
  timestamp?: number;
  errorCount?: number;
  warningCount?: number;
  messagesTruncated?: boolean;
  errors?: BridgeCompilerMessage[];
  warnings?: BridgeCompilerMessage[];
}

export interface UnityCompileStatusResult {
  success: boolean;
  settled: boolean;
  isCompiling?: boolean;
  isUpdating?: boolean;
  editorStateTimestamp?: number;
  editorStateAgeMs?: number;
  compilationCompleted?: boolean;
  compilationHasErrors?: boolean;
  compilationTimestamp?: number;
  compilerErrors?: BridgeCompilerMessage[];
  compilerWarnings?: BridgeCompilerMessage[];
  stale?: boolean;
  heartbeatStale?: boolean;
  compilationStatusAgeMs?: number;
  compilationStale?: boolean;
  message: string;
}

/**
 * Check the status of asset import in Unity
 */
export async function checkImportStatus(
  assetPath: string | undefined,
  waitForImport: boolean = true,
  timeoutMs: number = 10000,
  config: BanterMCPConfig
): Promise<ImportStatusResult> {
  const fullAssetPath = assetPath
    ? resolveAssetPath(assetPath, config)
    : undefined;

  if (fullAssetPath && !fs.existsSync(fullAssetPath)) {
    return {
      success: false,
      imported: false,
      message: "Asset file not found",
      assetPath,
    };
  }

  if (!config.hasUnityExtension) {
    // Can't check status without extension - just verify file exists
    if (assetPath) {
      const exists = Boolean(fullAssetPath && fs.existsSync(fullAssetPath));
      return {
        success: exists,
        imported: exists,
        message: exists
          ? "Asset file exists (cannot verify Unity import without MCP Bridge)"
          : "Asset file not found",
        assetPath,
      };
    }

    return {
      success: false,
      imported: false,
      message: "Unity MCP Bridge not detected. Cannot verify import status.",
    };
  }

  try {
    const statusPath = path.join(config.mcpStatePath, "import-status.json");

    if (waitForImport) {
      // Poll for import completion
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const editorState = readOptionalJson<BridgeEditorState>(
          path.join(config.mcpStatePath, "editor-state.json")
        );
        const compilationStatus = readOptionalJson<BridgeCompilationStatus>(
          path.join(config.mcpStatePath, "compilation-status.json")
        );
        const editorStateAgeMs = editorState?.timestamp === undefined
          ? undefined
          : Math.max(0, Date.now() - editorState.timestamp);
        const compilationStatusAgeMs = compilationStatus?.timestamp === undefined
          ? undefined
          : Math.max(0, Date.now() - compilationStatus.timestamp);
        const heartbeatStale = editorStateAgeMs === undefined || editorStateAgeMs > 5000;
        const compilationStale = compilationStatusAgeMs === undefined || compilationStatusAgeMs > 5000;

        if (heartbeatStale && compilationStale) {
          return {
            success: false,
            imported: false,
            assetPath,
            editorStateTimestamp: editorState?.timestamp,
            editorStateAgeMs,
            heartbeatStale,
            compilationStatusAgeMs,
            compilationStale,
            stale: true,
            message: "Unity editor state is stale; import and compilation status cannot be verified.",
          };
        }

        if (editorState?.isCompiling || editorState?.isUpdating || compilationStatus?.completed === false) {
          await sleep(250);
          continue;
        }

        if (fs.existsSync(statusPath)) {
          const status = readStatus(statusPath);

          if (isStatusCurrentForAsset(status, fullAssetPath)) {
            return attachEditorAndCompilationStatus(
              createResult(status, assetPath, fullAssetPath),
              editorState,
              compilationStatus,
              fullAssetPath
            );
          }
        }

        // Wait before next check
        await sleep(250);
      }

      return {
        success: false,
        imported: false,
        message: `Timeout waiting for import status (${timeoutMs}ms)`,
        assetPath,
        ...readCurrentEditorAndCompilationState(config),
      };
    } else {
      // Just read current status
      if (!fs.existsSync(statusPath)) {
        return {
          success: false,
          imported: false,
          message: "No import status available",
        };
      }

      const current = readCurrentEditorAndCompilationState(config);
      if (current.stale) {
        return {
          success: false,
          imported: false,
          assetPath,
          message: "Unity editor state is stale; import and compilation status cannot be verified.",
          ...current,
        };
      }
      if (current.isCompiling || current.isUpdating || current.compilationCompleted === false) {
        return {
          success: false,
          imported: false,
          assetPath,
          message: "Unity is still compiling or importing assets.",
          ...current,
        };
      }

      return attachEditorAndCompilationStatus(
        createResult(readStatus(statusPath), assetPath, fullAssetPath),
        readOptionalJson<BridgeEditorState>(path.join(config.mcpStatePath, "editor-state.json")),
        readOptionalJson<BridgeCompilationStatus>(path.join(config.mcpStatePath, "compilation-status.json")),
        fullAssetPath
      );
    }
  } catch (error) {
    return {
      success: false,
      imported: false,
      errors: [error instanceof Error ? error.message : "Unknown error"],
      message: "Error checking import status",
    };
  }
}

export async function waitForUnityCompile(
  timeoutMs: number = 30000,
  config: BanterMCPConfig,
  options: { waitForFreshHeartbeat?: boolean } = {}
): Promise<UnityCompileStatusResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    return {
      success: false,
      settled: false,
      message: "timeoutMs must be between 1000 and 120000.",
    };
  }

  const startedAt = Date.now();
  let settledSince: number | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const current = readCurrentEditorAndCompilationState(config);
    if (current.stale || (options.waitForFreshHeartbeat !== false && current.heartbeatStale)) {
      settledSince = undefined;
      if (options.waitForFreshHeartbeat !== false) {
        await sleep(250);
        continue;
      }
      return {
        success: false,
        settled: false,
        ...current,
        message: "Unity editor state is stale; compilation status cannot be verified.",
      };
    }

    if (current.isCompiling === false && current.isUpdating === false && current.compilationCompleted === true) {
      settledSince ??= Date.now();
      if (Date.now() - settledSince < 500) {
        await sleep(100);
        continue;
      }

      const hasErrors = current.compilationHasErrors === true;
      return {
        success: !hasErrors,
        settled: true,
        ...current,
        message: hasErrors
          ? `Unity compilation settled with ${current.compilerErrors?.length ?? 0} reported errors.`
          : current.heartbeatStale
          ? "Unity compilation is current and successful; the Editor heartbeat is stale, so asset-update state was not independently verified."
          : "Unity compilation and asset updates are settled.",
      };
    }

    settledSince = undefined;

    await sleep(250);
  }

  const current = readCurrentEditorAndCompilationState(config);
  return {
    success: false,
    settled: false,
    ...current,
    message: `Timeout waiting for Unity compilation and asset updates (${timeoutMs}ms).` +
      (current.heartbeatStale
        ? " The Editor heartbeat is stale. Check Unity for a dialog or open menu, domain reload, long-running work, or a closed Editor; the cause is not known. Pending commands may still execute: poll their original command IDs instead of resubmitting."
        : " Fresh settled compilation was not confirmed."),
  };
}

function readCurrentEditorAndCompilationState(config: BanterMCPConfig): Omit<UnityCompileStatusResult, "success" | "settled" | "message"> {
  const editorState = readOptionalJson<BridgeEditorState>(
    path.join(config.mcpStatePath, "editor-state.json")
  );
  const compilationStatus = readOptionalJson<BridgeCompilationStatus>(
    path.join(config.mcpStatePath, "compilation-status.json")
  );
  const editorStateAgeMs = editorState?.timestamp === undefined
    ? undefined
    : Math.max(0, Date.now() - editorState.timestamp);
  const compilationStatusAgeMs = compilationStatus?.timestamp === undefined
    ? undefined
    : Math.max(0, Date.now() - compilationStatus.timestamp);
  const heartbeatStale = editorStateAgeMs === undefined || editorStateAgeMs > 5000;
  const compilationStale = compilationStatusAgeMs === undefined || compilationStatusAgeMs > 5000;

  return {
    isCompiling: editorState?.isCompiling,
    isUpdating: editorState?.isUpdating,
    editorStateTimestamp: editorState?.timestamp,
    editorStateAgeMs,
    compilationCompleted: compilationStatus?.completed,
    compilationHasErrors: compilationStatus?.hasErrors,
    compilationTimestamp: compilationStatus?.timestamp,
    compilerErrors: compilationStatus?.errors || [],
    compilerWarnings: compilationStatus?.warnings || [],
    heartbeatStale,
    compilationStatusAgeMs,
    compilationStale,
    stale: heartbeatStale && compilationStale,
  };
}

function attachEditorAndCompilationStatus(
  result: ImportStatusResult,
  editorState: BridgeEditorState | undefined,
  compilationStatus: BridgeCompilationStatus | undefined,
  fullAssetPath?: string
): ImportStatusResult {
  const editorStateAgeMs = editorState?.timestamp === undefined
    ? undefined
    : Math.max(0, Date.now() - editorState.timestamp);
  const compilationStatusAgeMs = compilationStatus?.timestamp === undefined
    ? undefined
    : Math.max(0, Date.now() - compilationStatus.timestamp);
  const compilerErrors = compilationStatus?.errors || [];
  const compilerWarnings = compilationStatus?.warnings || [];
  const compilationHasErrors = compilationStatus?.hasErrors === true || compilerErrors.length > 0;
  const heartbeatStale = editorStateAgeMs === undefined || editorStateAgeMs > 5000;
  const compilationStale = compilationStatusAgeMs === undefined || compilationStatusAgeMs > 5000;
  const staleAssembly = isCompilationStaleForAsset(compilationStatus, fullAssetPath);
  const stale = heartbeatStale && compilationStale;

  return {
    ...result,
    success: result.success && !compilationHasErrors && !stale && !staleAssembly,
    errors: compilationHasErrors
      ? [...(result.errors || []), ...compilerErrors.map(formatCompilerMessage)]
      : result.errors,
    message: staleAssembly
      ? "The C# asset is newer than Unity's last completed compilation; assembly state is stale. Refresh assets and wait for a newer compilation result."
      : stale
      ? "Unity editor and compiler status are both stale; import and compilation status cannot be verified."
      : compilationHasErrors
      ? `Unity asset import completed, but script compilation has ${compilerErrors.length} errors.`
      : result.message,
    isCompiling: editorState?.isCompiling,
    isUpdating: editorState?.isUpdating,
    editorStateTimestamp: editorState?.timestamp,
    editorStateAgeMs,
    compilationCompleted: compilationStatus?.completed,
    compilationHasErrors,
    compilationTimestamp: compilationStatus?.timestamp,
    compilationStatusAgeMs,
    compilerErrors,
    compilerWarnings,
    heartbeatStale,
    compilationStale,
    staleAssembly,
    stale,
  };
}

function isCompilationStaleForAsset(
  compilationStatus: BridgeCompilationStatus | undefined,
  fullAssetPath: string | undefined
): boolean {
  if (!fullAssetPath || path.extname(fullAssetPath).toLowerCase() !== ".cs") return false;
  if (compilationStatus?.completed !== true || compilationStatus.timestamp === undefined) return true;
  return compilationStatus.timestamp + 1000 < fs.statSync(fullAssetPath).mtimeMs;
}
function formatCompilerMessage(message: BridgeCompilerMessage): string {
  const location = message.file
    ? `${message.file}${message.line ? `:${message.line}${message.column ? `:${message.column}` : ""}` : ""}`
    : message.assemblyPath || "Unity compiler";
  return `${location}: ${message.message || "Unknown compiler error"}`;
}

function readOptionalJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function resolveAssetPath(
  assetPath: string,
  config: BanterMCPConfig
): string {
  if (path.isAbsolute(assetPath)) {
    return path.normalize(assetPath);
  }

  const normalized = assetPath.replace(/\\/g, "/");
  if (normalized === "Assets" || normalized.startsWith("Assets/")) {
    return path.join(config.unityProjectPath, normalized);
  }

  return path.join(config.assetsPath, normalized);
}

function readStatus(statusPath: string): BridgeImportStatus {
  return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as BridgeImportStatus;
}

function isStatusCurrentForAsset(
  status: BridgeImportStatus,
  fullAssetPath: string | undefined
): boolean {
  if (!status.completed) {
    return false;
  }

  if (!fullAssetPath) {
    return true;
  }

  if (!status.timestamp) {
    return false;
  }

  const assetModifiedAt = fs.statSync(fullAssetPath).mtimeMs;
  const metaPath = fullAssetPath.endsWith(".meta")
    ? fullAssetPath
    : `${fullAssetPath}.meta`;
  const metaModifiedAt = fs.existsSync(metaPath)
    ? fs.statSync(metaPath).mtimeMs
    : assetModifiedAt;

  // Filesystem timestamps can be slightly ahead of Date.now() on Windows.
  return status.timestamp + 1000 >= Math.max(assetModifiedAt, metaModifiedAt);
}

function createResult(
  status: BridgeImportStatus,
  assetPath: string | undefined,
  fullAssetPath: string | undefined
): ImportStatusResult {
  const assetStatus = assetPath
    ? status.assets?.find((candidate) =>
        pathsReferToSameAsset(candidate.path, assetPath)
      )
    : undefined;

  if (assetStatus) {
    const hasErrors = Boolean(assetStatus.hasErrors);
    return {
      success: !hasErrors,
      imported: true,
      errors: assetStatus.errors || [],
      warnings: assetStatus.warnings || [],
      assetPath: assetStatus.path,
      message: hasErrors
        ? "Asset imported with errors"
        : "Asset imported successfully",
    };
  }

  const errors = status.errors ||
    (status.errorMessage ? [status.errorMessage] : []);
  const hasErrors = Boolean(status.hasErrors || errors.length);

  if (assetPath && fullAssetPath) {
    const metaPath = fullAssetPath.endsWith(".meta")
      ? fullAssetPath
      : `${fullAssetPath}.meta`;
    const hasMetaFile = fs.existsSync(metaPath);
    const imported = Boolean(status.completed && hasMetaFile);

    return {
      success: imported && !hasErrors,
      imported,
      errors,
      warnings: status.warnings || [],
      assetPath,
      message: !hasMetaFile
        ? "Asset exists, but Unity has not created its .meta file"
        : hasErrors
          ? "Unity's latest import completed with errors"
          : "Asset and .meta file exist; Unity's latest import completed successfully",
    };
  }

  return {
    success: Boolean(status.completed && !hasErrors),
    imported: Boolean(status.completed),
    errors,
    warnings: status.warnings || [],
    message: hasErrors
      ? `Import completed with ${errors.length} errors`
      : "Import completed successfully",
  };
}

function pathsReferToSameAsset(candidate: string, requested: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const normalizedCandidate = normalize(candidate);
  const normalizedRequested = normalize(requested);

  return normalizedCandidate === normalizedRequested ||
    normalizedCandidate.endsWith(`/${normalizedRequested}`) ||
    normalizedRequested.endsWith(`/${normalizedCandidate}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
