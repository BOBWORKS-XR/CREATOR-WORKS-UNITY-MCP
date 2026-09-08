import assert from "node:assert/strict";
import test from "node:test";
import { getMCPReference, splitReferenceMarkdown, REFERENCE_RESPONSE_MAX_BYTES } from "../dist/tools/get-mcp-reference.js";
import { BANTER_COMPONENTS } from "../dist/resources/banter-components.js";
import { BANTER_JS_API } from "../dist/resources/banter-js-api.js";
import { BANTER_WORKFLOWS, BANTER_WORKFLOW_CONTRACT } from "../dist/resources/banter-workflows.js";
import { UNITY_VS_JSON_MANUAL } from "../dist/resources/unity-vs-json-manual.js";
import { UNITY_VS_JSON_ERRATA } from "../dist/resources/unity-vs-json-errata.js";
import { handlePromptGet } from "../dist/prompts/index.js";
import { handleToolCall, parseToolGroupSelection, registerTools } from "../dist/tools/index.js";
import { createConfigForProject } from "../dist/lib/config.js";

function readEntry(source, entryId, guidance) {
  let startOffset = 0;
  let fullText = "";
  let revision;
  for (let page = 0; page < 100; page++) {
    const result = getMCPReference({ source, entryId, startOffset, revision });
    assert.equal(result.success, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= REFERENCE_RESPONSE_MAX_BYTES);
    if (guidance) assert.equal(result.guidance, guidance);
    revision ??= result.revision;
    assert.equal(result.revision, revision);
    const entry = result.entries[0];
    assert.equal(entry.startOffset, fullText.length);
    fullText += entry.text;
    if (entry.complete) {
      assert.equal(entry.nextOffset, null);
      return fullText;
    }
    assert.ok(entry.nextOffset > startOffset);
    startOffset = entry.nextOffset;
  }
  assert.fail("Reference continuation did not terminate");
}

test("bounded reference pages preserve every entry and every manual section exactly", () => {
  const sections = splitReferenceMarkdown(UNITY_VS_JSON_MANUAL);
  assert.equal(sections.map((section) => section.text).join("\n"), UNITY_VS_JSON_MANUAL.replace(/\r\n/g, "\n"));
  for (const section of sections) {
    assert.equal(readEntry("manual", section.id, UNITY_VS_JSON_ERRATA), section.text);
  }
  for (const [source, data] of Object.entries({ components: BANTER_COMPONENTS, javascript: BANTER_JS_API, workflows: BANTER_WORKFLOWS })) {
    for (const [id, expected] of Object.entries(data)) {
      const guidance = source === "workflows" ? JSON.stringify(BANTER_WORKFLOW_CONTRACT) : undefined;
      const restored = JSON.parse(readEntry(source, id, guidance), (_key, value) =>
        value && typeof value === "object" && Object.keys(value).length === 1 && "$number" in value
          ? Number(value.$number) : value);
      assert.deepEqual(restored, expected);
    }
  }
});

test("Markdown headings inside fenced examples never split a reference entry", () => {
  const source = "# First\n````text\n# Not a heading\n```\n## Still code\n````\n## Second\nDone";
  const entries = splitReferenceMarkdown(source);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].title, "First > Second");
  assert.equal(entries.map((entry) => entry.text).join("\n"), source);
});

test("reference search has bounded defaults and preserves override rules", async () => {
  for (const source of ["manual", "components", "javascript", "workflows"]) {
    const response = await handleToolCall("get_mcp_reference", { source, query: "a", limit: 5 }, createConfigForProject(""));
    assert.ok(Buffer.byteLength(response.content[0].text, "utf8") <= REFERENCE_RESPONSE_MAX_BYTES);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.success, true);
    assert.ok(result.entries.length <= 5);
    if (source === "manual") assert.equal(result.guidance, UNITY_VS_JSON_ERRATA);
  }
  const exact = getMCPReference({ source: "components", query: "BanterSyncedObject" });
  assert.equal(exact.entries[0].entryId, "BanterSyncedObject");
  const missing = getMCPReference({ source: "manual", query: "does-not-exist-998877" });
  assert.equal(missing.totalMatches, 0);
  assert.deepEqual(missing.entries, []);
});

test("reference inputs reject ambiguity, invalid bounds, and unknown sources", () => {
  for (const args of [
    {}, { source: "__proto__", query: "a" }, { source: "manual" },
    { source: "manual", query: "a", entryId: "section-1" },
    { source: "manual", query: " " }, { source: "manual", query: "a".repeat(129) },
    { source: "manual", query: "a", limit: 0 }, { source: "manual", query: "a", limit: 6 },
    { source: "manual", query: "a", startOffset: 1 },
    { source: "manual", entryId: "missing" },
    { source: "manual", entryId: "section-1", startOffset: 99999999 },
    { source: "manual", entryId: "section-1", startOffset: -1 },
    { source: "manual", entryId: "section-1", revision: "0".repeat(64) },
  ]) assert.equal(getMCPReference(args).success, false, JSON.stringify(args));
});

test("graph and workflow prompts use focused references without demanding full catalogs", () => {
  for (const name of ["create_vs_graph", "debug_vs_graph", "banter_interaction_workflow", "banter_best_practices"]) {
    const text = handlePromptGet(name, {}).messages[0].content.text;
    assert.match(text, /get_mcp_reference/);
    assert.doesNotMatch(text, /Read\s+banter:\/\/(?:workflows|unity-vs-json-manual)/i);
    assert.doesNotMatch(text, /also read banter:\/\/custom-vs-nodes/i);
  }
  for (const profile of ["read", "author", "banter"]) {
    assert.ok(registerTools(parseToolGroupSelection(profile)).some((tool) => tool.name === "get_mcp_reference"));
  }
});
