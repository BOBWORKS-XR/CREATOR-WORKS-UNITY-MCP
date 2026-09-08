import assert from "node:assert/strict";
import test from "node:test";
import { releaseChecksums } from "../scripts/release-checksums.mjs";

const fixture = () => ({assets: ["setup.exe", "app.AppImage", "app.deb", "app.rpm", "app.dmg", "app-standalone.zip"]
  .map(name => ({name, state: "uploaded", digest: `sha256:${"a".repeat(64)}`}))});

test("checksums include every platform and ignore the previous checksum asset", () => {
  const data = fixture();
  data.assets.push({name: "SHA256SUMS.txt"});
  const result = releaseChecksums(data);
  assert.equal(result.trim().split("\n").length, 6);
  assert.ok(result.includes(`${"a".repeat(64)}  setup.exe\n`));
});

test("checksums fail closed on partial uploads, missing platforms, unsafe names and invalid digests", () => {
  for (const change of [
    data => data.assets.pop(),
    data => { data.assets[0].digest = null; },
    data => { data.assets[0].digest = `sha512:${"a".repeat(64)}`; },
    data => { data.assets[0].state = "new"; },
    data => { data.assets[0].name = "bad\nname.exe"; },
    data => { data.assets[0].name = "../setup.exe"; },
    data => data.assets.push({...data.assets[0]}),
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => releaseChecksums(data));
  }
});
