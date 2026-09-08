import { createHash } from "node:crypto";
import { BANTER_COMPONENTS } from "../resources/banter-components.js";
import { BANTER_JS_API } from "../resources/banter-js-api.js";
import { BANTER_WORKFLOWS, BANTER_WORKFLOW_CONTRACT } from "../resources/banter-workflows.js";
import { UNITY_VS_JSON_MANUAL } from "../resources/unity-vs-json-manual.js";
import { UNITY_VS_JSON_ERRATA } from "../resources/unity-vs-json-errata.js";

interface ReferenceEntry {
  id: string;
  title: string;
  text: string;
}

// Headings inside examples belong to their code block, not the reference index.
export function splitReferenceMarkdown(text: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  let title = "Introduction";
  let lines: string[] = [];
  let fence: string | undefined;
  const parents: string[] = [];
  const flush = () => {
    if (!lines.some((line) => line.trim())) return;
    entries.push({ id: `section-${entries.length + 1}`, title, text: lines.join("\n") });
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      lines.push(line);
      if (marker?.[0] === fence[0] && marker.length >= fence.length &&
          new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      lines.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      parents.length = heading[1].length - 1;
      parents.push(heading[2]);
      title = parents.filter(Boolean).join(" > ");
      lines = [line];
    } else lines.push(line);
  }
  flush();
  return entries;
}

function objectEntries(source: Record<string, unknown>): ReferenceEntry[] {
  return Object.entries(source).map(([id, value]) => ({ id, title: id, text: JSON.stringify(value,
    (_key, item) => typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item, 2) }));
}

const SOURCES: Record<string, { entries: ReferenceEntry[]; guidance: string }> = {
  manual: { entries: splitReferenceMarkdown(UNITY_VS_JSON_MANUAL), guidance: UNITY_VS_JSON_ERRATA },
  components: { entries: objectEntries(BANTER_COMPONENTS), guidance: "Legacy catalog keys must be resolved against get_banter_sdk_info before authoring Creator SDK or Banter components." },
  javascript: { entries: objectEntries(BANTER_JS_API), guidance: "This is the bundled Banter JavaScript reference. Confirm the selected SDK and hosted runtime contract before applying it to another backend." },
  workflows: { entries: objectEntries(BANTER_WORKFLOWS), guidance: JSON.stringify(BANTER_WORKFLOW_CONTRACT) },
};
const REVISIONS = Object.fromEntries(Object.entries(SOURCES).map(([key, source]) => [
  key, createHash("sha256").update(JSON.stringify(source)).digest("hex"),
]));

export const REFERENCE_RESPONSE_MAX_BYTES = 16 * 1024;

function excerptLength(text: string): number {
  let low = 0;
  let high = Math.min(text.length, 2048);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle)), "utf8") <= 2048) low = middle;
    else high = middle - 1;
  }
  // Keep each excerpt valid Unicode while retaining every character across pages.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return low;
}

export function getMCPReference(args: Record<string, unknown>): Record<string, unknown> {
  const sourceName = typeof args.source === "string" ? args.source : "";
  if (!Object.hasOwn(SOURCES, sourceName)) return { success: false, error: "source must be manual, components, javascript, or workflows." };
  const source = SOURCES[sourceName];
  if (args.revision !== undefined && args.revision !== REVISIONS[sourceName]) {
    return { success: false, error: "Reference revision changed. Search again before continuing an older excerpt." };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const entryId = typeof args.entryId === "string" ? args.entryId : "";
  if ((args.query !== undefined && (!query || query.length > 128)) ||
      (args.entryId !== undefined && (!entryId || entryId.length > 128)) ||
      Boolean(query) === Boolean(entryId)) {
    return { success: false, error: "Provide either query or entryId, containing 1 to 128 characters." };
  }
  const offset = args.startOffset ?? 0;
  const limit = args.limit ?? 3;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (!entryId && offset !== 0)) {
    return { success: false, error: "startOffset must be a non-negative integer and requires entryId." };
  }
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 5) {
    return { success: false, error: "limit must be an integer between 1 and 5." };
  }
  const terms = query.toLowerCase().split(/\s+/);
  const matches = entryId
    ? source.entries.filter((entry) => entry.id === entryId)
    : source.entries.filter((entry) => terms.every((term) => `${entry.title}\n${entry.text}`.toLowerCase().includes(term)));
  if (entryId && !matches.length) return { success: false, error: "Unknown entryId. Search this source for a current entry ID." };
  if (matches.length && (offset as number) >= matches[0].text.length) {
    return { success: false, error: "startOffset is outside this entry. Use a returned nextOffset or start at zero." };
  }
  if (!entryId) {
    const rank = (entry: ReferenceEntry) => entry.id.toLowerCase() === query.toLowerCase() ? 0
      : terms.every((term) => entry.title.toLowerCase().includes(term)) ? 1 : 2;
    matches.sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id, "en"));
  }
  const entries = matches.slice(0, limit as number).map((entry) => {
    const startOffset = offset as number;
    const end = startOffset + excerptLength(entry.text.slice(startOffset));
    return {
      entryId: entry.id, title: entry.title, text: entry.text.slice(startOffset, end),
      startOffset, nextOffset: end < entry.text.length ? end : null, complete: end === entry.text.length,
    };
  });
  const result: Record<string, unknown> = {
    success: true, source: sourceName, revision: REVISIONS[sourceName], guidance: source.guidance,
    encoding: "Non-finite reference numbers use a $number marker (Infinity, -Infinity, or NaN). This is descriptive metadata, not a Unity command value.",
    totalMatches: matches.length, returned: entries.length, truncated: matches.length > entries.length,
    entries, continuation: "For more text, call the same source with entryId, revision, and its nextOffset as startOffset. Excerpts with complete=false are partial reference text, not standalone JSON or complete examples. Reuse unchanged excerpts in this task; the reference revision does not validate the project's installed SDK.",
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > REFERENCE_RESPONSE_MAX_BYTES) {
    return { success: false, error: "Reference response exceeded its fixed budget. Retry with limit=1." };
  }
  return result;
}
