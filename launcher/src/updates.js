const REPOSITORY = 'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP';
export const RELEASE_API = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/latest';

function version(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? { parts, preview: Boolean(match[4]) } : null;
}

export function stableUpdate(currentVersion, release) {
  const current = version(currentVersion);
  const candidate = version(release?.tag_name);
  if (!current || !candidate || candidate.preview || release.draft !== false || release.prerelease !== false)
    throw new Error('Release metadata is not a valid stable release.');
  const expectedUrl = `${REPOSITORY}/releases/tag/${release.tag_name}`;
  if (release.html_url !== expectedUrl || !release.published_at)
    throw new Error('Release metadata does not match the official repository.');
  let comparison = 0;
  for (let index = 0; index < 3 && comparison === 0; index++)
    comparison = Math.sign(candidate.parts[index] - current.parts[index]);
  return { available: comparison > 0 || (comparison === 0 && current.preview),
    version: release.tag_name.replace(/^v/, ''), url: expectedUrl };
}

export async function checkStableUpdate(currentVersion, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(RELEASE_API, {
      signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`Update check unavailable (HTTP ${response.status}). Try again later.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty update response.');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512 * 1024) { await reader.cancel(); throw new Error('Update response exceeds the size limit.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return stableUpdate(currentVersion, JSON.parse(new TextDecoder().decode(bytes)));
  } finally { clearTimeout(timer); }
}
