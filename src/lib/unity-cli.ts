import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export const UNITY_CLI_EXPERIMENT = {
  cliVersion: "1.0.0-beta.8",
  pipelineVersion: "0.6.0-exp.1",
  processByteLimit: 256 * 1024,
  responseByteLimit: 32 * 1024,
} as const;

export type UnityCliAction = "status" | "commands" | "find" | "scenes";
export interface UnityCliOptions {
  enabled?: boolean;
  projectPath: string;
  executablePath?: string;
  action: UnityCliAction;
  query?: string;
  name?: string;
  limit?: number;
  timeoutMs?: number;
}
export interface CliProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
}
export interface CliProcessResult { exitCode: number; stdout: string; stderr: string }
export type CliRunner = (request: CliProcessRequest) => Promise<CliProcessResult>;
type RecordValue = Record<string, unknown>;

class ProbeError extends Error {
  constructor(readonly code: string, message: string, readonly details?: RecordValue) { super(message); }
}
function fail(code: string, message: string): never { throw new ProbeError(code, message); }
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_RESPONSE", "Expected a structured object; no result was accepted.");
  return value as RecordValue;
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    fail("INVALID_RESPONSE", "A required text field is missing or exceeds its bounds.");
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("INVALID_RESPONSE", "The upstream item count is invalid.");
  return value as number;
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function projectFile(root: string, name: string, maxBytes: number): string {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) fail("PROJECT_METADATA_MISSING", `Required project file is missing: ${name}.`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || !inside(root, fs.realpathSync(file)))
    fail("UNSAFE_PROJECT_METADATA", `Project file is not a bounded, contained regular file: ${name}.`);
  const contents = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(contents) > maxBytes) fail("UNSAFE_PROJECT_METADATA", "Project metadata grew beyond its read limit.");
  return contents.replace(/^\uFEFF/, "");
}
function readJson(root: string, name: string): RecordValue {
  try { return object(JSON.parse(projectFile(root, name, 512 * 1024))); }
  catch (error) {
    if (error instanceof ProbeError) throw error;
    fail("INVALID_PROJECT_METADATA", `Project metadata is not valid JSON: ${name}.`);
  }
}

export function inspectUnityCliProject(projectPath: string) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath) || /[\x00-\x1f\x7f]/.test(projectPath))
    fail("PROJECT_REQUIRED", "Pass an absolute Unity project path; no active-project guessing is allowed.");
  if (!fs.existsSync(projectPath)) fail("PROJECT_MISSING", "The selected Unity project does not exist.");
  const root = fs.realpathSync(projectPath);
  if (!fs.existsSync(path.join(root, "Assets")) || !fs.statSync(path.join(root, "Assets")).isDirectory())
    fail("INVALID_PROJECT", "The selected project has no Assets directory.");
  const versionFile = projectFile(root, "ProjectSettings/ProjectVersion.txt", 8192);
  const version = /^m_EditorVersion:\s*(\d+\.\d+\.\d+[abfp]\d+)\s*$/m.exec(versionFile)?.[1];
  if (!version) fail("UNITY_VERSION_UNKNOWN", "Cannot establish the project's Unity version.");
  if (Number(version.split(".")[0]) < 6000)
    fail("UNITY_VERSION_UNSUPPORTED", "Live Unity CLI access requires Unity 6+. Keep using the existing MCP bridge here.");
  const manifest = readJson(root, "Packages/manifest.json");
  const declared = object(manifest.dependencies)["com.unity.pipeline"];
  const locked = object(readJson(root, "Packages/packages-lock.json").dependencies);
  const pipeline = locked["com.unity.pipeline"];
  if (!pipeline) fail("PIPELINE_MISSING", "Unity Pipeline is not resolved in this project. This probe never installs packages.");
  const resolved = object(pipeline);
  if (resolved.version !== UNITY_CLI_EXPERIMENT.pipelineVersion || resolved.source !== "registry" ||
      resolved.url !== "https://packages.unity.com" ||
      (declared !== undefined && declared !== UNITY_CLI_EXPERIMENT.pipelineVersion))
    fail("PIPELINE_UNSUPPORTED", `This experiment requires official registry Pipeline ${UNITY_CLI_EXPERIMENT.pipelineVersion}; no package was changed.`);
  const assistant = locked["com.unity.ai.assistant"];
  if (assistant) {
    const assistantVersion = /^(\d+)\.(\d+)\./.exec(String(object(assistant).version));
    if (!assistantVersion || Number(assistantVersion[1]) < 2 ||
        (Number(assistantVersion[1]) === 2 && Number(assistantVersion[2]) < 13))
      fail("ASSISTANT_CONFLICT", "Unity documents CLI conflicts with Assistant versions below 2.13. Review the installed package first.");
  }
  return { projectPath: root, unityVersion: version, pipelineVersion: String(resolved.version), hubRequired: false };
}

export function findUnityCliExecutable(explicit?: string, searchPath = process.env.PATH ?? ""): string {
  const candidates = explicit ? [explicit] : searchPath.split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && path.resolve(entry) !== process.cwd())
    .map((entry) => path.join(entry, process.platform === "win32" ? "unity.exe" : "unity"));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || /[\x00-\x1f\x7f]/.test(candidate)) continue;
    if (process.platform === "win32" && path.extname(candidate).toLowerCase() !== ".exe") continue;
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const resolved = fs.realpathSync(candidate);
    // Unity Editor is also named Unity.exe; never launch it as a CLI version probe.
    if (fs.existsSync(path.join(path.dirname(resolved), "Data", "Resources")) ||
        fs.existsSync(path.join(path.dirname(resolved), "UnityCrashHandler64.exe"))) continue;
    return resolved;
  }
  fail("CLI_NOT_FOUND", "A standalone Unity CLI executable was not found. Pass --executable with its absolute path; the Hub and Editor executables are not substitutes.");
}

export const runBoundedCliProcess: CliRunner = async (request) => {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60000 ||
      !Number.isInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 1024 * 1024)
    fail("INVALID_PROCESS_LIMIT", "Process timeout or byte limit is invalid.");
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(UNITY_|HUB_)/i.test(key)) delete env[key];
    Object.assign(env, {
      UNITY_NO_UPDATE_CHECK: "1", UNITY_NO_CONSENT_PROMPT: "1", UNITY_NO_CRASH_REPORT: "1",
      UNITY_NON_INTERACTIVE: "1", UNITY_NO_PAGER: "1", UNITY_NO_BANNER: "1", UNITY_NO_CLOUD: "1",
    });
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let failure: ProbeError | undefined;
    const stop = (error: ProbeError) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new ProbeError("CLI_TIMEOUT", "The read-only CLI process timed out. No retry or fallback was submitted.")), request.timeoutMs);
    const receive = (target: Buffer[], chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > request.maxBytes) { stop(new ProbeError("CLI_OUTPUT_LIMIT", "CLI output exceeded the byte limit. Narrow the request; no partial result was accepted.")); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
    child.on("error", () => { failure ??= new ProbeError("CLI_START_FAILED", "The selected CLI executable could not be started."); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
};

function sameProject(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !path.isAbsolute(actual) || !fs.existsSync(actual)) return false;
  const resolved = fs.realpathSync(actual);
  return process.platform === "win32" ? expected.toLowerCase() === resolved.toLowerCase() : expected === resolved;
}
function upstreamCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((entry) => {
    const code = entry && typeof entry === "object" ? (entry as RecordValue).code : undefined;
    return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : "UNCLASSIFIED";
  });
}
function rows(value: unknown, reportedCount: unknown): RecordValue[] {
  if (!Array.isArray(value) || count(reportedCount) !== value.length)
    fail("INVALID_RESPONSE", "The returned rows do not match their reported count.");
  return value.map(object);
}
function projectIdentity(row: RecordValue): RecordValue {
  if (!Number.isSafeInteger(row.instanceId)) fail("INVALID_RESPONSE", "A GameObject identity is missing its instance ID.");
  return { instanceId: row.instanceId, globalId: row.globalId === null ? null : text(row.globalId),
    hierarchyPath: text(row.hierarchyPath), type: text(row.type, 128) };
}

export async function runUnityCliProbe(options: UnityCliOptions, runner: CliRunner = runBoundedCliProcess): Promise<RecordValue> {
  try {
    if (options.enabled !== true) fail("EXPERIMENT_DISABLED", "Unity CLI support is opt-in. Pass --enable for this invocation; the existing MCP is unchanged.");
    if (!["status", "commands", "find", "scenes"].includes(options.action))
      fail("ACTION_NOT_ALLOWED", "This experiment supports status, commands, find and scenes only; mutations and eval are unavailable.");
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_LIMIT", "limit must be an integer from 1 to 100.");
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      fail("INVALID_TIMEOUT", "timeoutMs must be an integer from 100 to 60000.");
    if (options.action === "commands" && (!options.query?.trim() || options.query.length > 120 || /[\x00-\x1f\x7f]/.test(options.query)))
      fail("QUERY_REQUIRED", "Command lookup requires a nonempty query of at most 120 characters.");
    if (options.action === "find" && (!options.name?.trim() || options.name.length > 256 || /[\x00-\x1f\x7f]/.test(options.name)))
      fail("NAME_REQUIRED", "Find requires an exact nonempty object name of at most 256 characters.");
    if ((options.query !== undefined && options.action !== "commands") || (options.name !== undefined && options.action !== "find"))
      fail("UNEXPECTED_ARGUMENT", "query is only valid for commands; name is only valid for find.");
    const project = inspectUnityCliProject(options.projectPath);
    const executable = findUnityCliExecutable(options.executablePath);
    let processBytes = 0;
    const invoke = async (args: string[]) => {
      const result = await runner({ executable, args, cwd: project.projectPath, timeoutMs, maxBytes: UNITY_CLI_EXPERIMENT.processByteLimit });
      processBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > UNITY_CLI_EXPERIMENT.processByteLimit)
        fail("CLI_OUTPUT_LIMIT", "CLI output exceeded the byte limit; no result was accepted.");
      return result;
    };
    const versionResult = await invoke(["--version"]);
    if (versionResult.exitCode !== 0 || versionResult.stdout.trim() !== UNITY_CLI_EXPERIMENT.cliVersion)
      fail("CLI_VERSION_UNSUPPORTED", `This experiment is tested against CLI ${UNITY_CLI_EXPERIMENT.cliVersion}. No Editor command was sent.`);
    const command = { status: "editor_status", find: "find_gameobjects", scenes: "list_open_scenes", commands: "" }[options.action];
    const args = ["command"];
    if (command) args.push(command);
    if (options.action === "commands") args.push(`--query=${options.query!}`, "--detail", "compact", "--limit", String(limit));
    if (options.action === "find") args.push(`--name=${options.name!}`);
    args.push("--project-path", project.projectPath, "--format", "json", "--non-interactive", "--no-banner", "--no-pager", "--no-log-proxy", "--timeout", String(Math.max(1, Math.floor(timeoutMs / 1000))));
    const processResult = await invoke(args);
    let envelope: RecordValue;
    try { envelope = object(JSON.parse(processResult.stdout)); }
    catch { fail("INVALID_RESPONSE", "Unity CLI did not return a complete JSON response. No raw process output was forwarded."); }
    if (processResult.exitCode !== 0 || envelope.success !== true || !Array.isArray(envelope.errors) || envelope.errors.length)
      throw new ProbeError("UPSTREAM_FAILED", "Unity CLI reported a failure. No retry or backend fallback was submitted.", { exitCode: processResult.exitCode, codes: upstreamCodes(envelope.errors) });
    const data = object(envelope.data);
    const target = object(data.target);
    if (!sameProject(project.projectPath, target.projectPath) || !["127.0.0.1", "localhost", "::1"].includes(String(target.host)))
      fail("PROJECT_MISMATCH", "Unity CLI returned a different or nonlocal project target; its data was rejected.");
    if (envelope.command !== (command ? `command ${command}` : "command") ||
        (command && (data.command !== command || data.success !== true)))
      fail("COMMAND_MISMATCH", "Unity CLI did not acknowledge the requested command successfully.");
    if (options.action === "find" && object(data.parameters).name !== options.name)
      fail("PARAMETER_MISMATCH", "Unity CLI did not acknowledge the exact requested object name; its data was rejected.");
    if (!Array.isArray(envelope.warnings)) fail("INVALID_RESPONSE", "Upstream warning metadata is missing.");
    const base: RecordValue = { success: true, experimental: true, backend: "unity-cli", action: options.action,
      ...project, cliVersion: UNITY_CLI_EXPERIMENT.cliVersion, capturedAt: new Date().toISOString(),
      warnings: upstreamCodes(envelope.warnings), warningCount: envelope.warnings.length,
      stderrBytes: Buffer.byteLength(versionResult.stderr) + Buffer.byteLength(processResult.stderr),
      diagnosticsWithheld: Boolean(versionResult.stderr || processResult.stderr || envelope.warnings.length), processBytes };
    if (options.action === "status") {
      const status = object(data.result);
      if (!sameProject(project.projectPath, status.projectPath) || status.unityVersion !== project.unityVersion)
        fail("EDITOR_IDENTITY_MISMATCH", "Editor status does not match the selected project's path and Unity version.");
      if (typeof status.compiling !== "boolean" || typeof status.domainReloadInProgress !== "boolean")
        fail("INVALID_RESPONSE", "Editor compilation/reload status is missing.");
      const heartbeat = Date.parse(text(status.lastHeartbeat, 80));
      const age = Date.now() - heartbeat;
      const ready = status.status === "ready" && !status.compiling && !status.domainReloadInProgress && Number.isFinite(age) && age >= -5000 && age <= 10000;
      return { ...base, ready, status: text(status.status, 80), compiling: status.compiling,
        domainReloadInProgress: status.domainReloadInProgress, playMode: text(status.playMode, 80),
        lastHeartbeat: status.lastHeartbeat, heartbeatFresh: Number.isFinite(age) && age >= -5000 && age <= 10000 };
    }
    let items: RecordValue[], total: number;
    if (options.action === "commands") {
      items = rows(data.commands, data.count).map((row) => ({ name: text(row.name, 256),
        description: text(row.description, 4096), package: text(row.package, 256) }));
      total = count(data.total);
      if (total < items.length || data.offset !== 0) fail("INVALID_RESPONSE", "Command discovery returned inconsistent paging metadata.");
    } else {
      const result = object(data.result);
      total = count(result.count);
      if (options.action === "find") items = rows(result.gameObjects, total).map(projectIdentity);
      else items = rows(result.scenes, total).map((row) => {
        if ([row.isLoaded, row.isDirty, row.isActive].some((value) => typeof value !== "boolean"))
          fail("INVALID_RESPONSE", "Scene load/dirty/active status is missing.");
        return { name: text(row.name), path: text(row.path), isLoaded: row.isLoaded,
          isDirty: row.isDirty, isActive: row.isActive, rootCount: count(row.rootCount) };
      });
    }
    const returned = items.slice(0, limit);
    const response = () => ({ ...base, query: { limit, sourceCount: total, returned: returned.length,
      omitted: total - returned.length, truncated: returned.length < total,
      responseByteLimit: UNITY_CLI_EXPERIMENT.responseByteLimit }, items: returned });
    while (returned.length && Buffer.byteLength(JSON.stringify(response())) > UNITY_CLI_EXPERIMENT.responseByteLimit) returned.pop();
    if (Buffer.byteLength(JSON.stringify(response())) > UNITY_CLI_EXPERIMENT.responseByteLimit)
      fail("RESPONSE_LIMIT", "Even the response metadata exceeds the output budget.");
    return response();
  } catch (error) {
    const known = error instanceof ProbeError;
    return { success: false, experimental: true, backend: "unity-cli", fallbackSubmitted: false,
      error: { code: known ? error.code : "PROBE_FAILED", message: known ? error.message : "The probe failed while reading local prerequisites; no automatic repair was attempted.",
        ...(known && error.details ? { details: error.details } : {}) } };
  }
}
