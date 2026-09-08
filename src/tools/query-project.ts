/**
 * Query Project State
 *
 * Read Unity project state from the MCP Bridge extension.
 */

import * as fs from "fs";
import * as path from "path";
import type { BanterMCPConfig } from "../lib/config.js";
import { dispatchUnityBridgeCommand } from "../lib/unity-bridge-transport.js";
import { pendingCommandTimeout } from "./get-unity-command-status.js";

export type ProjectStateMatchMode = "contains" | "exact";

export interface ProjectStateQueryOptions {
  match?: ProjectStateMatchMode;
  rootPath?: string;
  includeDescendants?: boolean;
  maxDepth?: number;
  maxResults?: number;
  fields?: string[];
  componentType?: string;
  propertyNames?: string[];
  componentDetails?: "identity" | "properties";
  maxResponseBytes?: number;
  refresh?: boolean;
  timeoutMs?: number;
}

interface QuerySummary {
  totalMatches: number;
  returned: number;
  truncated: boolean;
  match: ProjectStateMatchMode;
  rootPath?: string;
  includeDescendants: boolean;
  maxDepth?: number;
  maxResults: number;
  fields?: string[];
  componentType?: string;
  propertyNames?: string[];
  componentDetails?: "identity" | "properties";
  maxResponseBytes: number;
  responseBytes: number;
}

interface SnapshotInfo {
  timestamp?: number;
  ageMs?: number;
  refreshed: boolean;
  refreshRequested: boolean;
  refreshError?: string;
  editorStateTimestamp?: number;
  editorStateAgeMs?: number;
  sceneDirty?: boolean;
  isPlaying?: boolean;
  isCompiling?: boolean;
  isUpdating?: boolean;
}

interface RefreshResult {
  requested: boolean;
  refreshed: boolean;
  error?: string;
}

interface LiveHierarchyQueryResult {
  commandId?: string;
  success?: boolean;
  sceneName?: string;
  scenePath?: string;
  objects?: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
  totalMatches?: number;
  returned?: number;
  truncated?: boolean;
  timestamp?: number;
  error?: string;
}

export interface ProjectStateResult {
  success: boolean;
  data?: unknown;
  error?: string;
  warning?: string;
  source?: string;
  query?: QuerySummary;
  snapshot?: SnapshotInfo;
}

const DEFAULT_MAX_RESULTS = 200;
const MAX_RESULTS_LIMIT = 5000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MIN_RESPONSE_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const HIERARCHY_FIELDS = new Set([
  "name",
  "globalObjectId",
  "path",
  "active",
  "layer",
  "tag",
  "depth",
  "position",
  "rotation",
  "scale",
  "localPosition",
  "localRotation",
  "localScale",
  "components",
]);
const COMPONENT_FIELDS = new Set([
  "objectName",
  "objectPath",
  "depth",
  "type",
  "fullType",
  "globalObjectId",
  "properties",
  "missingProperties",
]);

/**
 * Query the Unity project state.
 */
export async function queryProjectState(
  query: string,
  filter: string | undefined,
  config: BanterMCPConfig,
  options: ProjectStateQueryOptions = {}
): Promise<ProjectStateResult> {
  if (!config.unityProjectPath || !fs.existsSync(config.assetsPath)) {
    return {
      success: false,
      error: "Unity project not configured or Assets folder not found.",
    };
  }

  if (query !== "hierarchy" && query !== "components") {
    return {
      success: false,
      error: query === "assets"
        ? "Use search_unity_assets for bounded AssetDatabase results."
        : query === "prefabs"
          ? "Use get_prefab_catalog for bounded prefab results."
          : "query must be hierarchy or components. Use the dedicated asset, prefab, console, import, and bridge-status tools instead of a combined state dump.",
    };
  }

  const validationError = validateQueryOptions(query, options);
  if (validationError) {
    return { success: false, error: validationError };
  }

  try {
    if ((query === "hierarchy" || query === "components") &&
        options.refresh !== false &&
        isTargetedHierarchyQuery(filter, options)) {
      if (!isBridgeLive(config)) {
        return {
          success: false,
          error: "Unity bridge heartbeat is stale or unavailable; a fresh targeted hierarchy query cannot be verified.",
        };
      }
      return boundQueryResult(await requestTargetedHierarchyQuery(query, filter, config, options));
    }

    const refresh = await refreshHierarchyIfRequested(config, options);

    switch (query) {
      case "hierarchy":
        return boundQueryResult(readHierarchy(config, filter, options, refresh));

      case "components":
        return boundQueryResult(readComponentsFromHierarchy(config, filter, options, refresh));

      default:
        return {
          success: false,
          error: `Unknown query type: ${query}. Valid options: hierarchy, components`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error querying project",
    };
  }
}

function validateQueryOptions(query: string, options: ProjectStateQueryOptions): string | undefined {
  if (options.componentDetails !== undefined && !["identity", "properties"].includes(options.componentDetails)) {
    return "componentDetails must be identity or properties.";
  }
  if (options.componentDetails === "identity" && options.propertyNames?.length) {
    return "propertyNames cannot be used with componentDetails: identity.";
  }
  if (options.match !== undefined && options.match !== "contains" && options.match !== "exact") {
    return "match must be either contains or exact.";
  }
  if (options.maxResults !== undefined &&
      (!Number.isInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > MAX_RESULTS_LIMIT)) {
    return `maxResults must be a whole number between 1 and ${MAX_RESULTS_LIMIT}.`;
  }
  if (options.maxDepth !== undefined &&
      (!Number.isInteger(options.maxDepth) || options.maxDepth < 0 || options.maxDepth > 100)) {
    return "maxDepth must be a whole number between 0 and 100.";
  }
  if (options.maxResponseBytes !== undefined &&
      (!Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < MIN_RESPONSE_BYTES || options.maxResponseBytes > MAX_RESPONSE_BYTES)) {
    return `maxResponseBytes must be a whole number between ${MIN_RESPONSE_BYTES} and ${MAX_RESPONSE_BYTES}.`;
  }
  if (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 120000)) {
    return "timeoutMs must be between 1000 and 120000.";
  }
  if (options.fields !== undefined &&
      (!Array.isArray(options.fields) || options.fields.length > 50 || options.fields.some((field) => typeof field !== "string" || !field))) {
    return "fields must contain at most 50 non-empty field names.";
  }
  if (options.propertyNames !== undefined &&
      (!Array.isArray(options.propertyNames) || options.propertyNames.length > 50 || options.propertyNames.some((name) => typeof name !== "string" || !name.trim()))) {
    return "propertyNames must contain at most 50 non-empty serialized property names.";
  }
  if (options.fields?.length) {
    const allowed = query === "hierarchy"
      ? HIERARCHY_FIELDS
      : query === "components"
        ? COMPONENT_FIELDS
        : undefined;
    if (!allowed) {
      return `fields are not supported for ${query} queries.`;
    }
    const unsupported = Array.from(new Set(options.fields.filter((field) => !allowed.has(field))));
    if (unsupported.length > 0) {
      return `Unsupported ${query} fields: ${unsupported.join(", ")}. Supported fields: ${Array.from(allowed).join(", ")}.`;
    }
  }
  return undefined;
}

function isTargetedHierarchyQuery(
  filter: string | undefined,
  options: ProjectStateQueryOptions
): boolean {
  return Boolean(
    normalizeObjectPath(options.rootPath) ||
    options.componentType ||
    options.propertyNames?.length ||
    filter
  );
}

async function requestTargetedHierarchyQuery(
  query: "hierarchy" | "components",
  filter: string | undefined,
  config: BanterMCPConfig,
  options: ProjectStateQueryOptions
): Promise<ProjectStateResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const dispatch = await dispatchUnityBridgeCommand({
    type: "query_hierarchy",
    queryKind: query,
    filter: filter || "",
    match: options.match ?? "contains",
    rootPath: normalizeObjectPath(options.rootPath) || "",
    includeDescendants: options.includeDescendants === true,
    maxDepth: options.maxDepth ?? -1,
    maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
    componentType: options.componentType || "",
    propertyNames: options.propertyNames || [],
    includeComponents: query === "components" || !options.fields?.length || options.fields.includes("components"),
    includeComponentProperties: options.componentDetails !== "identity" &&
      (query !== "components" || Boolean(options.propertyNames?.length) || !options.fields?.length || options.fields.includes("properties")),
  }, config, Math.min(timeoutMs, 3000));

  if (dispatch.acknowledgement?.success === false) {
    return {
      success: false,
      error: dispatch.acknowledgement.error || "Unity rejected the targeted hierarchy query.",
    };
  }

  const resultPath = path.join(
    config.mcpStatePath,
    "hierarchy-query-results",
    `${dispatch.commandId}.json`
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as LiveHierarchyQueryResult;
        if (result.commandId !== dispatch.commandId) {
          throw new Error("Targeted hierarchy result correlation ID did not match the request.");
        }
        fs.unlinkSync(resultPath);
        if (result.success !== true) {
          return {
            success: false,
            error: result.error || "Unity could not complete the targeted hierarchy query.",
          };
        }

        const timestamp = result.timestamp;
        const fields = options.fields ? Array.from(new Set(options.fields)) : undefined;
        const rawItems = query === "hierarchy" ? result.objects || [] : result.components || [];
        const projectedItems = rawItems.map((item) => {
          const projected = query === "hierarchy"
            ? projectMatchingComponents(item, options.componentType, options.propertyNames, options.componentDetails)
            : projectComponent(item, options.propertyNames, options.componentDetails);
          return fields?.length ? pickFields(projected, fields) : projected;
        });
        const bounded = boundItemsByBytes(projectedItems, options.maxResponseBytes);
        const items = bounded.items;
        const querySummary: QuerySummary = {
          totalMatches: result.totalMatches ?? items.length,
          returned: items.length,
          truncated: result.truncated === true || bounded.truncated,
          match: options.match ?? "contains",
          rootPath: normalizeObjectPath(options.rootPath),
          includeDescendants: options.includeDescendants === true,
          maxDepth: options.maxDepth,
          maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
          fields,
          componentType: options.componentType,
          propertyNames: options.propertyNames,
          componentDetails: options.componentDetails,
          maxResponseBytes: bounded.maxResponseBytes,
          responseBytes: bounded.responseBytes,
        };
        const snapshot = buildSnapshotInfo(
          config,
          { timestamp },
          { requested: true, refreshed: true }
        );

        return query === "hierarchy"
          ? {
              success: true,
              source: "unity-live-targeted-query",
              data: {
                sceneName: result.sceneName,
                scenePath: result.scenePath,
                objects: items,
                timestamp,
              },
              query: querySummary,
              snapshot,
            }
          : {
              success: true,
              source: "unity-live-targeted-query",
              data: items,
              query: querySummary,
              snapshot,
            };
      } catch (error) {
        if (error instanceof SyntaxError) {
          await sleep(50);
          continue;
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Could not read the targeted hierarchy result.",
        };
      }
    }
    await sleep(50);
  }

  return pendingCommandTimeout(dispatch.commandId, config,
    `Timed out after ${timeoutMs}ms waiting for Unity's targeted hierarchy result; no stale snapshot was substituted.`);
}

async function refreshHierarchyIfRequested(
  config: BanterMCPConfig,
  options: ProjectStateQueryOptions
): Promise<RefreshResult> {
  if (options.refresh === false) {
    return { requested: false, refreshed: false };
  }

  if (!isBridgeLive(config)) {
    return {
      requested: true,
      refreshed: false,
      error: "Unity bridge heartbeat is stale or unavailable; returning the latest saved snapshot.",
    };
  }

  return requestStateExport(
    config,
    "scene-hierarchy",
    options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
  );
}

function isBridgeLive(config: BanterMCPConfig): boolean {
  const editorState = readJsonFile(path.join(config.mcpStatePath, "editor-state.json"));
  const timestamp = numberValue(editorState?.timestamp);
  return timestamp !== undefined && Date.now() - timestamp <= 5000;
}

function readHierarchy(
  config: BanterMCPConfig,
  filter: string | undefined,
  options: ProjectStateQueryOptions,
  refresh: RefreshResult
): ProjectStateResult {
  const state = readStateFile(config, "scene-hierarchy.json", refresh);
  if (!state.success) {
    return state;
  }

  const hierarchy = state.data as Record<string, unknown>;
  const objects = Array.isArray(hierarchy.objects)
    ? hierarchy.objects.filter(isRecord)
    : [];
  const selected = selectHierarchyObjects(objects, filter, options);

  return {
    ...state,
    data: {
      ...hierarchy,
      objects: selected.items,
    },
    query: selected.summary,
  };
}

function readStateFile(
  config: BanterMCPConfig,
  filename: string,
  refresh: RefreshResult = { requested: false, refreshed: false }
): ProjectStateResult {
  const filePath = path.join(config.mcpStatePath, filename);

  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      error: `State file not found: ${filename}. Unity may need to export project state.`,
      source: filePath,
      snapshot: buildSnapshotInfo(config, undefined, refresh),
    };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      success: true,
      data,
      warning: refresh.error,
      source: filePath,
      snapshot: buildSnapshotInfo(config, data, refresh),
    };
  } catch (error) {
    return {
      success: false,
      error: `Error reading ${filename}: ${error instanceof Error ? error.message : "Unknown error"}`,
      source: filePath,
      snapshot: buildSnapshotInfo(config, undefined, refresh),
    };
  }
}

function buildSnapshotInfo(
  config: BanterMCPConfig,
  data: unknown,
  refresh: RefreshResult
): SnapshotInfo {
  const state = isRecord(data) ? data : undefined;
  const editorState = readJsonFile(path.join(config.mcpStatePath, "editor-state.json"));
  const timestamp = numberValue(state?.timestamp);
  const editorStateTimestamp = numberValue(editorState?.timestamp);

  return {
    timestamp,
    ageMs: timestamp === undefined ? undefined : Math.max(0, Date.now() - timestamp),
    refreshed: refresh.refreshed,
    refreshRequested: refresh.requested,
    refreshError: refresh.error,
    editorStateTimestamp,
    editorStateAgeMs: editorStateTimestamp === undefined
      ? undefined
      : Math.max(0, Date.now() - editorStateTimestamp),
    sceneDirty: booleanValue(editorState?.activeSceneDirty),
    isPlaying: booleanValue(editorState?.isPlaying),
    isCompiling: booleanValue(editorState?.isCompiling),
    isUpdating: booleanValue(editorState?.isUpdating),
  };
}

function matchingHierarchyObjects(
  objects: Array<Record<string, unknown>>,
  filter: string | undefined,
  options: ProjectStateQueryOptions
): Array<Record<string, unknown>> {
  const match = options.match ?? "contains";
  const rootPath = normalizeObjectPath(options.rootPath);
  const includeDescendants = options.includeDescendants === true;
  const root = rootPath
    ? objects.find((object) => stringValue(object.path)?.toLowerCase() === rootPath.toLowerCase())
    : undefined;
  const rootDepth = numberValue(root?.depth);

  let matches = objects.filter((object) => {
    const objectPath = stringValue(object.path) ?? "";
    const objectDepth = numberValue(object.depth) ?? 0;

    if (rootPath) {
      const exactRoot = objectPath.toLowerCase() === rootPath.toLowerCase();
      const descendant = objectPath.toLowerCase().startsWith(`${rootPath.toLowerCase()}/`);
      if (!exactRoot && !(includeDescendants && descendant)) {
        return false;
      }
      if (options.maxDepth !== undefined && rootDepth !== undefined && objectDepth - rootDepth > options.maxDepth) {
        return false;
      }
    } else if (options.maxDepth !== undefined && objectDepth > options.maxDepth) {
      return false;
    }

    if (options.componentType && !objectHasComponent(object, options.componentType)) {
      return false;
    }
    return !filter || matchesFilter(object, filter, match);
  });

  if (options.componentType || options.propertyNames?.length || options.componentDetails === "identity") {
    matches = matches.map((object) => projectMatchingComponents(object, options.componentType, options.propertyNames, options.componentDetails));
  }

  return matches;
}

function selectHierarchyObjects(
  objects: Array<Record<string, unknown>>,
  filter: string | undefined,
  options: ProjectStateQueryOptions
): { items: Array<Record<string, unknown>>; summary: QuerySummary } {
  const match = options.match ?? "contains";
  const rootPath = normalizeObjectPath(options.rootPath);
  const includeDescendants = options.includeDescendants === true;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const matches = matchingHierarchyObjects(objects, filter, options);

  const totalMatches = matches.length;
  const fields = options.fields ? Array.from(new Set(options.fields)) : undefined;
  const projectedItems = matches
    .slice(0, maxResults)
    .map((object) => fields ? pickFields(object, fields) : object);
  const bounded = boundItemsByBytes(projectedItems, options.maxResponseBytes);
  const items = bounded.items;

  return {
    items,
    summary: {
      totalMatches,
      returned: items.length,
      truncated: totalMatches > projectedItems.length || bounded.truncated,
      match,
      rootPath,
      includeDescendants,
      maxDepth: options.maxDepth,
      maxResults,
      fields,
      componentType: options.componentType,
      propertyNames: options.propertyNames,
      componentDetails: options.componentDetails,
      maxResponseBytes: bounded.maxResponseBytes,
      responseBytes: bounded.responseBytes,
    },
  };
}

function projectMatchingComponents(
  object: Record<string, unknown>,
  componentType: string | undefined,
  propertyNames: string[] | undefined,
  componentDetails?: "identity" | "properties"
): Record<string, unknown> {
  let components = Array.isArray(object.components)
    ? object.components.filter(isRecord)
    : [];
  if (componentType) {
    components = components.filter((component) => componentMatchesType(component, componentType));
  }
  components = components.map((component) => projectComponent(component, propertyNames, componentDetails));
  return { ...object, components };
}

function projectComponent(
  component: Record<string, unknown>,
  propertyNames?: string[],
  componentDetails?: "identity" | "properties"
): Record<string, unknown> {
  if (componentDetails === "identity") {
    return Object.fromEntries(Object.entries(component).filter(([key]) => key !== "properties" && key !== "missingProperties"));
  }
  if (!propertyNames?.length) {
    const result = { ...component };
    if (Array.isArray(result.missingProperties) && !result.missingProperties.length) delete result.missingProperties;
    return result;
  }
  const properties = Array.isArray(component.properties) ? component.properties.filter(isRecord) : [];
  const matches = (property: Record<string, unknown>, name: string) =>
    [property.name, property.propertyPath].some(value => typeof value === "string" && value.toLowerCase() === name.toLowerCase()) ||
    // Older bridges expose renderer material aliases under the canonical summary name.
    (property.name === "materials" && /^(MeshRenderer|SkinnedMeshRenderer|Renderer|ParticleSystemRenderer|LineRenderer|TrailRenderer)$/.test(String(component.type)) &&
      ["m_materials", "sharedmaterials"].includes(name.toLowerCase()));
  const selected = properties.filter(property => propertyNames.some(name => matches(property, name)));
  const missing = Array.from(new Set(propertyNames.filter(name => !selected.some(property => matches(property, name)))));
  const { missingProperties: _previous, ...rest } = component;
  return {
    ...rest,
    properties: selected,
    ...(missing.length ? { missingProperties: missing } : {}),
  };
}

function objectHasComponent(object: Record<string, unknown>, componentType: string): boolean {
  return Array.isArray(object.components) &&
    object.components.filter(isRecord).some((component) => componentMatchesType(component, componentType));
}

function componentMatchesType(component: Record<string, unknown>, componentType: string): boolean {
  const requested = componentType.toLowerCase();
  return stringValue(component.type)?.toLowerCase() === requested ||
    stringValue(component.fullType)?.toLowerCase() === requested;
}

function matchesFilter(
  item: Record<string, unknown>,
  filter: string,
  match: ProjectStateMatchMode
): boolean {
  const filterLower = filter.toLowerCase();
  const candidates = [item.name, item.path, item.type, item.fullType, item.objectName, item.objectPath]
    .filter((value): value is string => typeof value === "string");
  if (Array.isArray(item.components)) {
    for (const component of item.components.filter(isRecord)) {
      const type = stringValue(component.type);
      const fullType = stringValue(component.fullType);
      if (type !== undefined) candidates.push(type);
      if (fullType !== undefined) candidates.push(fullType);
    }
  }
  return candidates.some((value) => match === "exact"
    ? value.toLowerCase() === filterLower
    : value.toLowerCase().includes(filterLower));
}

function pickFields(item: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(item, field)) {
      result[field] = item[field];
    }
  }
  // A field projection must not hide missing requested-property evidence.
  if (Array.isArray(item.missingProperties) && item.missingProperties.length) {
    result.missingProperties = item.missingProperties;
  }
  return result;
}

interface BoundedItemsResult {
  items: Array<Record<string, unknown>>;
  responseBytes: number;
  maxResponseBytes: number;
  truncated: boolean;
}

function boundItemsByBytes(
  items: Array<Record<string, unknown>>,
  requestedMaxBytes: number | undefined
): BoundedItemsResult {
  const maxResponseBytes = requestedMaxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const bounded: Array<Record<string, unknown>> = [];
  let responseBytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf-8") + (bounded.length > 0 ? 1 : 0);
    if (responseBytes + itemBytes > maxResponseBytes) break;
    bounded.push(item);
    responseBytes += itemBytes;
  }
  return {
    items: bounded,
    responseBytes,
    maxResponseBytes,
    truncated: bounded.length < items.length,
  };
}

function boundQueryResult(result: ProjectStateResult): ProjectStateResult {
  if (!result.success || !result.query) return result;
  const summary = result.query;
  const hierarchy = !Array.isArray(result.data) && isRecord(result.data) ? result.data : undefined;
  const items = (hierarchy ? hierarchy.objects : result.data) as Array<Record<string, unknown>>;
  const alreadyTruncated = summary.truncated;
  const originalWarning = result.warning;

  // Budget the exact compact tool text, including metadata and its own byte count.
  const measure = (count: number): number => {
    const selected = items.slice(0, count);
    if (hierarchy) hierarchy.objects = selected;
    else result.data = selected;
    summary.returned = count;
    summary.truncated = alreadyTruncated || count < items.length;
    result.warning = count === 0 && summary.truncated
      ? [originalWarning, "No complete item fits the response budget. Narrow fields/propertyNames or increase maxResponseBytes."].filter(Boolean).join(" ")
      : originalWarning;
    summary.responseBytes = 0;
    let bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    while (summary.responseBytes !== bytes) {
      summary.responseBytes = bytes;
      bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    }
    return bytes;
  };

  if (measure(items.length) <= summary.maxResponseBytes) return result;
  if (measure(0) > summary.maxResponseBytes) {
    return { success: false, error: "Query metadata exceeds maxResponseBytes. Shorten the query options or increase the budget." };
  }
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(middle) <= summary.maxResponseBytes) low = middle;
    else high = middle - 1;
  }
  measure(low);
  return result;
}

function normalizeObjectPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function readComponentsFromHierarchy(
  config: BanterMCPConfig,
  filter: string | undefined,
  options: ProjectStateQueryOptions,
  refresh: RefreshResult
): ProjectStateResult {
  const hierarchyResult = readStateFile(config, "scene-hierarchy.json", refresh);
  if (!hierarchyResult.success) {
    return hierarchyResult;
  }

  const hierarchy = hierarchyResult.data as { objects?: Array<Record<string, unknown>> };
  const selectedObjects = matchingHierarchyObjects(hierarchy.objects || [], undefined, {
    ...options,
    fields: undefined,
    componentType: undefined,
  });
  let components: Array<Record<string, unknown>> = [];

  for (const object of selectedObjects) {
    const objectComponents = Array.isArray(object.components) ? object.components : [];
    for (const component of objectComponents.filter(isRecord)) {
      components.push({
        objectName: object.name,
        objectPath: object.path,
        depth: object.depth,
        ...component,
      });
    }
  }

  if (options.componentType) {
    components = components.filter((component) => componentMatchesType(component, options.componentType as string));
  }
  if (filter) {
    components = components.filter((component) => matchesFilter(component, filter, options.match ?? "contains"));
  }

  const totalMatches = components.length;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const fields = options.fields ? Array.from(new Set(options.fields)) : undefined;
  const projectedItems = components
    .slice(0, maxResults)
    .map((component) => fields ? pickFields(component, fields) : component);
  const bounded = boundItemsByBytes(projectedItems, options.maxResponseBytes);
  const items = bounded.items;

  return {
    ...hierarchyResult,
    data: items,
    query: {
      totalMatches,
      returned: items.length,
      truncated: totalMatches > projectedItems.length || bounded.truncated,
      match: options.match ?? "contains",
      rootPath: normalizeObjectPath(options.rootPath),
      includeDescendants: options.includeDescendants === true,
      maxDepth: options.maxDepth,
      maxResults,
      fields,
      componentType: options.componentType,
      propertyNames: options.propertyNames,
      componentDetails: options.componentDetails,
      maxResponseBytes: bounded.maxResponseBytes,
      responseBytes: bounded.responseBytes,
    },
  };
}

async function requestStateExport(
  config: BanterMCPConfig,
  stateType: string,
  timeoutMs: number
): Promise<RefreshResult> {
  const statePath = path.join(config.mcpStatePath, `${stateType}.json`);
  const beforeModifiedAt = fs.existsSync(statePath) ? fs.statSync(statePath).mtimeMs : 0;

  try {
    const dispatch = await dispatchUnityBridgeCommand({
      type: "export-state",
      stateType,
    }, config, Math.min(timeoutMs, 3000));
    const resultPath = path.join(
      config.mcpStatePath,
      "command-results",
      `${dispatch.commandId}.json`
    );

    if (dispatch.acknowledgement?.success === false) {
      return {
        requested: true,
        refreshed: false,
        error: dispatch.acknowledgement.error || "Unity rejected the state export command.",
      };
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const stateChanged = fs.existsSync(statePath) && fs.statSync(statePath).mtimeMs > beforeModifiedAt;
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as Record<string, unknown>;
          if (result.commandId === dispatch.commandId) {
            fs.unlinkSync(resultPath);
            if (result.success === false) {
              return {
                requested: true,
                refreshed: false,
                error: stringValue(result.error) || "Unity rejected the state export command.",
              };
            }
            return stateChanged || fs.existsSync(statePath)
              ? { requested: true, refreshed: true }
              : { requested: true, refreshed: false, error: "Unity acknowledged the export but no snapshot was written." };
          }
        } catch {
          // Unity may still be atomically replacing the result file.
        }
      }
      if (stateChanged) {
        return { requested: true, refreshed: true };
      }
      if (dispatch.acknowledgement?.success === true && fs.existsSync(statePath)) {
        return { requested: true, refreshed: true };
      }
      await sleep(100);
    }

    return {
      requested: true,
      refreshed: false,
      error: `Timed out after ${timeoutMs}ms waiting for Unity to export project state; returning the latest snapshot.`,
    };
  } catch (error) {
    return {
      requested: true,
      refreshed: false,
      error: error instanceof Error ? error.message : "Could not request a Unity state export.",
    };
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
