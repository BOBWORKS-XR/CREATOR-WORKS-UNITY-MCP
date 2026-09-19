#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runUnityCliProbe, type UnityCliAction } from "./lib/unity-cli.js";

async function main() {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
      enable: { type: "boolean" }, help: { type: "boolean" }, project: { type: "string" },
      executable: { type: "string" }, query: { type: "string" }, name: { type: "string" },
      limit: { type: "string" }, "timeout-ms": { type: "string" },
    } });
    if (values.help) {
      console.log("Experimental, read-only Unity CLI support. Not part of the installed launcher.\n" +
        "node dist/unity-cli.js <status|commands|find|scenes> --enable --project <absolute-path> [--executable <absolute-cli-path>]\n" +
        "commands requires --query <text>; find requires --name <exact-name>. Optional --limit 1..100, --timeout-ms 100..60000.\n" +
        "Output is compact JSON. No installation, mutation, eval, account changes or automatic fallback. Hub is not required.");
      return;
    }
    if (positionals.length !== 1) throw new Error("Choose exactly one action: status, commands, find or scenes.");
    const result = await runUnityCliProbe({ enabled: values.enable, projectPath: values.project ?? "",
      executablePath: values.executable, action: positionals[0] as UnityCliAction, query: values.query,
      name: values.name, limit: values.limit === undefined ? undefined : Number(values.limit),
      timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.success === true && result.ready !== false ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ success: false, experimental: true, error: {
      code: "INVALID_ARGUMENTS", message: "Invalid CLI arguments. Use --help; unknown flags and multiple actions are rejected.",
    } }));
    process.exitCode = 2;
  }
}
void main();
