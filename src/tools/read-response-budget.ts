import * as path from "node:path";

const READ_COLLECTIONS: Record<string, string[]> = {
  get_console_logs: ["logs"],
  check_import_status: ["compilerErrors", "errors", "compilerWarnings", "warnings"],
  wait_for_unity_compile: ["compilerErrors", "compilerWarnings"],
  get_prefab_catalog: ["prefabs", "categories"],
};
const STATE_FILES: Record<string, string[]> = {
  get_console_logs: ["console-log.json"],
  check_import_status: ["import-status.json", "compilation-status.json"],
  wait_for_unity_compile: ["compilation-status.json"],
  get_prefab_catalog: ["prefab-catalog.json"],
};

export const READ_RESPONSE_BUDGET_SCHEMA = {
  type: "integer", minimum: 16384, maximum: 4194304, default: 65536,
  description: "Maximum UTF-8 bytes of the complete result text. Omitted entries are reported; narrow filters or explicitly raise the budget for more detail.",
};

export function hasReadResponseBudget(name: string): boolean {
  return Object.hasOwn(READ_COLLECTIONS, name);
}

export function readResponseBudget(value: unknown): number {
  const budget = value === undefined ? 65536 : value;
  if (!Number.isInteger(budget) || (budget as number) < 16384 || (budget as number) > 4194304) {
    throw new Error("maxResponseBytes must be an integer between 16384 and 4194304.");
  }
  return budget as number;
}

// Only diagnostic/catalog reads are bounded here. Never clip graph payloads or mutation receipts.
export function boundedReadText(name: string, value: unknown, budget: number, statePath: string): string {
  const original = value as Record<string, unknown>;
  const collections = READ_COLLECTIONS[name].filter((key) =>
    key === "categories" ? original[key] && typeof original[key] === "object" : Array.isArray(original[key])
  ).map((key) => ({ key, items: key === "categories"
    ? Object.entries(original[key] as Record<string, unknown>) : original[key] as unknown[] }));
  const total = collections.reduce((count, collection) => count + collection.items.length, 0);
  const render = (take: number): string => {
    const result = { ...original };
    const counts: Record<string, { available: number; returned: number }> = {};
    let remaining = take;
    for (const { key, items } of collections) {
      const count = Math.min(remaining, items.length);
      remaining -= count;
      const selected = key === "logs" ? items.slice(items.length - count) : items.slice(0, count);
      result[key] = key === "categories" ? Object.fromEntries(selected as [string, unknown][]) : selected;
      counts[key] = { available: items.length, returned: count };
      if (key === "logs") result.count = count;
      if (key === "prefabs") result.returnedResults = count;
    }
    result.responseBudget = {
      maxResponseBytes: budget, truncated: take < total, collections: counts,
      sourceFiles: STATE_FILES[name].map((file) => path.join(statePath, file)),
      ...(take < total ? { advice: "Response is incomplete. Narrow supported filters or explicitly increase maxResponseBytes. Complete captured entries remain in sourceFiles; omitted diagnostics do not mean no errors. Source files are snapshots and may change." } : {}),
    };
    return JSON.stringify(result);
  };
  const full = render(total);
  if (Buffer.byteLength(full, "utf8") <= budget) return full;
  let low = 0;
  let high = total - 1;
  let best = render(0);
  if (Buffer.byteLength(best, "utf8") > budget) {
    throw new Error("Read-result metadata exceeds maxResponseBytes; narrow the request or increase the budget. No complete result could be returned.");
  }
  // Whole entries and status metadata survive; compiler errors take priority over warnings.
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);
    if (Buffer.byteLength(candidate, "utf8") <= budget) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}
