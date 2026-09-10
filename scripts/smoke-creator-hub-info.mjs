import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// This smoke is only for an explicitly hash-identified build, never legacy app discovery.
const [binary, trustedSha256] = process.argv.slice(2);
assert.ok(binary && path.isAbsolute(binary) && /^[a-f0-9]{64}$/i.test(trustedSha256 ?? ""),
  "Pass an absolute next-version executable path and its trusted SHA-256. Do not probe old releases.");
const contents = fs.readFileSync(binary);
const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
assert.equal(sha256, trustedSha256.toLowerCase(), "Build identity mismatch; executable was not run.");
assert.equal(process.platform, "win32", "This release-EXE smoke is Windows-only; other platforms require native packaging tests.");
let expectedArchitecture;
if (process.platform === "win32") {
  assert.equal(contents.toString("ascii", 0, 2), "MZ");
  const pe = contents.readUInt32LE(0x3c);
  assert.equal(contents.toString("ascii", pe, pe + 4), "PE\0\0");
  expectedArchitecture = { 0x8664: "x86_64", 0xaa64: "aarch64" }[contents.readUInt16LE(pe + 4)];
  assert.ok(expectedArchitecture, "Unsupported Windows executable architecture.");
  assert.equal(contents.readUInt16LE(pe + 24 + 68), 2, "Use a release Windows GUI-subsystem EXE, not a console test binary.");
}
const tempBase = fs.realpathSync(os.tmpdir());
const root = fs.realpathSync(fs.mkdtempSync(path.join(tempBase, "creator-hub-info-")));
assert.equal(path.dirname(root), tempBase);
const marker = path.join(root, "untouched.txt");
fs.writeFileSync(marker, "metadata probe must not modify this fixture");
const env = { ...process.env, APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"),
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
  HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "codex"),
  CREATOR_WORKS_MCP_ROOT: path.join(root, "not-a-server"), BANTWORKS_MCP_ROOT: path.join(root, "not-a-server") };
const expected = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)))).version;
const home = os.homedir();
const watchedConfigs = [
  process.env.APPDATA && path.join(process.env.APPDATA, "creator-works-mcp", "launcher-config.json"),
  process.env.APPDATA && path.join(process.env.APPDATA, "banter-mcp", "launcher-config.json"),
  path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
  path.join(home, ".claude.json"),
].filter(Boolean);
const configMetadata = () => watchedConfigs.map((file) => {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return { size: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs, inode: stat.ino };
});
const beforeConfigs = configMetadata();

function probe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let failure, size = 0;
    const stdout = [], stderr = [];
    const fail = (message) => { failure ??= new Error(message); child.kill(); };
    const timer = setTimeout(() => fail("Metadata process exceeded 5 seconds; owned process stopped."), 5000);
    const collect = (target, chunk) => {
      if (failure) return;
      size += chunk.length;
      if (size > 4096) { fail("Combined stdout/stderr exceeded 4 KiB."); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), bytes: size });
    });
  });
}

try {
  const valid = await probe(["--creator-hub-info"]);
  assert.equal(valid.code, 0); assert.equal(valid.stderr, "");
  assert.match(valid.stdout, /^\{[^\r\n]*\}\n$/);
  const identity = JSON.parse(valid.stdout);
  assert.deepEqual(Object.keys(identity).sort(), ["schemaVersion", "appId", "displayName", "version", "platform", "architecture", "capabilities"].sort());
  assert.equal(identity.schemaVersion, 1); assert.equal(identity.appId, "creator-works-mcp");
  assert.equal(identity.displayName, "Creator Works MCP"); assert.equal(identity.version, expected);
  assert.equal(identity.platform, { win32: "windows", darwin: "macos", linux: "linux" }[process.platform]);
  assert.equal(identity.architecture, expectedArchitecture);
  assert.deepEqual(identity.capabilities, ["launch.standalone"]);
  const invalid = [
    ["--creator-hub-info", "--project", root], ["--output", path.join(root, "must-not-exist.json"), "--creator-hub-info"],
    ["--creator-hub-info", "--creator-hub-info"], ["--creator-hub-info=anything"], ["--creator-hub-unknown"],
    ["--creator-hub-info", "--repair"], ["--creator-hub-info", "& echo not-a-command"],
    ["--creator-hub"], ["--CREATOR-HUB-INFO"],
  ];
  for (const args of invalid) {
    const result = await probe(args);
    assert.equal(result.code, 2); assert.equal(result.stdout, "");
    assert.match(result.stderr, /Use --creator-hub-info alone/);
  }
  const repeated = await probe(["--creator-hub-info"]);
  assert.equal(repeated.code, 0); assert.equal(repeated.stdout, valid.stdout);
  assert.deepEqual(fs.readdirSync(root), ["untouched.txt"]);
  assert.equal(fs.readFileSync(marker, "utf8"), "metadata probe must not modify this fixture");
  assert.deepEqual(configMetadata(), beforeConfigs, "Existing configuration metadata changed during the probe; investigate attribution before claiming no side effects.");
  console.log(JSON.stringify({ success: true, sha256, identity, bytes: valid.bytes, successfulProbes: 2, rejectedProbes: invalid.length,
    fixtureUnchanged: true, existingConfigMetadataUnchanged: true, windowsGuiSubsystem: process.platform === "win32",
    caveat: "Windows known-folder APIs may ignore environment isolation; fast-path unit/source checks remain part of no-startup proof. No normal GUI/re-open or update-safety claim." }));
} finally {
  assert.equal(fs.realpathSync(root), root, "Temporary root changed; refusing cleanup.");
  assert.equal(path.dirname(root), tempBase);
  fs.rmSync(root, { recursive: true, force: true });
}
