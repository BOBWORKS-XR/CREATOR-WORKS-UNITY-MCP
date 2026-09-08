import { registerTools, handleToolCall } from "../dist/tools/index.js";
import { performance } from "node:perf_hooks";
import { parseToolGroupSelection } from "../dist/tools/tool-groups.js";
import { createConfigForProject } from "../dist/lib/config.js";
import { handleResourceRead } from "../dist/resources/index.js";

const profiles = [
  ["Token Saver", "core"],
  ["Inspection", "read"],
  ["Testing", "core,test"],
  ["Unity authoring", "core,author"],
  ["Banter workflow", "core,banter"],
  ["Shader Graph preview", "core,shadergraph"],
  ["Full", "all"],
  ["Routing only", "none"],
];

console.log("| Profile | Selection | Tools | Schema bytes | Rough tokens* |");
console.log("|---|---|---:|---:|---:|");

for (const [label, selectionValue] of profiles) {
  const selection = parseToolGroupSelection(selectionValue);
  const tools = registerTools(selection);
  const schemaBytes = Buffer.byteLength(JSON.stringify({ tools }), "utf8");
  const roughTokens = Math.ceil(schemaBytes / 4);
  console.log(
    `| ${label} | \`${selectionValue}\` | ${tools.length} | ${schemaBytes.toLocaleString("en-US")} | ~${roughTokens.toLocaleString("en-US")} |`,
  );
}

console.log("");
console.log("*Rough tokens use four UTF-8 bytes per token. Actual client and model tokenization varies.");

const resources = [
  ["System prompt", "banter://system-prompt"],
  ["SDK compatibility", "banter://sdk-compatibility"],
  ["Workflows", "banter://workflows"],
  ["Components", "banter://components"],
  ["Custom VS nodes", "banter://custom-vs-nodes"],
  ["Custom VS node log", "banter://custom-vs-node-log"],
  ["VS JSON manual", "banter://unity-vs-json-manual"],
];
const config = createConfigForProject("");

console.log("");
console.log("On-demand resources are not sent with tools/list, but reading one adds its full content:");
console.log("");
console.log("| Resource | URI | Bytes | Rough tokens* |");
console.log("|---|---|---:|---:|");
for (const [label, uri] of resources) {
  const response = handleResourceRead(uri, config);
  const bytes = Buffer.byteLength(response.contents[0].text, "utf8");
  console.log(
    `| ${label} | \`${uri}\` | ${bytes.toLocaleString("en-US")} | ~${Math.ceil(bytes / 4).toLocaleString("en-US")} |`,
  );
}

console.log("\nFocused reference calls (complete result text, including correction guidance):");
for (const [name, args] of [
  ["get_mcp_reference", { source: "manual", query: "SetMember", limit: 1 }],
  ["get_mcp_reference", { source: "components", query: "BanterSyncedObject", limit: 1 }],
  ["search_sidequest_vs_nodes", { query: "InjectJS", limit: 3 }],
]) {
  const samples = [];
  let response;
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    response = await handleToolCall(name, args, config);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const text = response.content[0].text;
  const result = JSON.parse(text);
  if (!result.success || !(result.totalMatches > 0)) throw new Error(`Benchmark query did not match: ${JSON.stringify(args)}`);
  console.log(`${name} ${JSON.stringify(args)}: ${Buffer.byteLength(text)} bytes; warm local p50=${samples[49].toFixed(3)}ms p95=${samples[94].toFixed(3)}ms`);
}
console.log("Timing excludes startup, model, transport, and Unity. Byte reductions are not account-usage guarantees; partial entries may require continuation calls.");
