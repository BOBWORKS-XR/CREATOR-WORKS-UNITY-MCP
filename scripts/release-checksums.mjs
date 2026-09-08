import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseChecksums(metadata) {
  if (!Array.isArray(metadata?.assets)) throw new Error("Release asset metadata is missing.");
  const assets = metadata.assets.filter(asset => asset.name !== "SHA256SUMS.txt");
  const names = new Set();
  for (const asset of assets) {
    if (typeof asset.name !== "string" || !asset.name.length || /[\x00-\x1f\x7f/\\]/.test(asset.name)) {
      throw new Error("Invalid release asset filename.");
    }
    const key = asset.name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate release asset: ${asset.name}`);
    names.add(key);
    if (asset.state !== "uploaded" || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? "")) {
      throw new Error(`Asset is not fully uploaded with a SHA256 digest: ${asset.name}`);
    }
  }
  for (const suffix of [".exe", ".AppImage", ".deb", ".rpm", ".dmg", "-standalone.zip"]) {
    if (!assets.some(asset => asset.name.endsWith(suffix))) throw new Error(`Missing release artifact: ${suffix}`);
  }
  return assets.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(asset => `${asset.digest.slice(7).toLowerCase()}  ${asset.name}\n`).join("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(releaseChecksums(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}
