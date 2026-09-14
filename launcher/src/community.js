/* Shared by Hub and the standalone Creator apps. No HTML from the catalogue. */
(() => {
  const root = document.getElementById('view-plugins');
  if (!root) return;
  const types = { all: 'All types', graph: 'Visual Scripting', prefab: 'Prefabs', plugin: 'Plugins', 'community-tool': 'Editor tools', recipe: 'Recipes' };
  const raw = 'https://raw.githubusercontent.com/SideQuestVR/Creator-Community/main/';
  const invoke = (command, args = {}) => (window.CreatorCommunityInvoke || window.CreatorHubNative.invoke)(command, args);
  let snapshot = null, busy = false, query = '', category = 'all', lastRefresh = 0;
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const icon = name => { const node = el('span', `icon icon-${name}`); node.setAttribute('aria-hidden', 'true'); return node; };
  function button(label, className, action, symbol) {
    const node = el('button', className); node.type = 'button'; if (symbol) node.append(icon(symbol)); node.append(document.createTextNode(label)); node.addEventListener('click', action); return node;
  }
  const heading = el('div', 'community-heading');
  const headingText = el('div'); const title = el('h2', '', 'Creator Plugins'); title.id = 'plugins-title'; title.tabIndex = -1;
  headingText.append(title, el('p', 'community-subtitle', 'Made by the community. Shared with creators.'));
  const submit = button('Share a creation', 'community-secondary', () => link('', 'submit'), 'external');
  heading.append(headingText, submit);
  const toolbar = el('div', 'community-toolbar');
  const search = el('input', 'community-search'); search.type = 'search'; search.placeholder = 'Search contributions'; search.setAttribute('aria-label', 'Search contributions');
  const sort = el('select', 'community-sort'); sort.setAttribute('aria-label', 'Sort contributions');
  for (const [value, label] of [['name', 'Name A-Z'], ['author', 'Creator A-Z']]) { const option = el('option', '', label); option.value = value; sort.append(option); }
  const refresh = button('', 'community-icon-button', () => load(true), 'refresh'); refresh.title = 'Refresh catalogue'; refresh.setAttribute('aria-label', 'Refresh catalogue');
  toolbar.append(search, sort, refresh);
  const filters = el('div', 'community-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Contribution type');
  const filterButtons = Object.entries(types).map(([value, label]) => {
    const node = button(label, 'community-filter', () => { category = value; render(); }); node.dataset.category = value; filters.append(node); return node;
  });
  const summary = el('p', 'community-count'); summary.setAttribute('role', 'status');
  const message = el('p', 'community-message'); message.setAttribute('role', 'status'); message.hidden = true;
  const list = el('div', 'community-list'); list.setAttribute('aria-label', 'Contributions');
  const footer = el('div', 'community-footer');
  footer.append(el('span', '', 'SideQuest Creator Community'), button('Catalogue on GitHub', 'community-link', () => link('', 'catalogue'), 'external'));
  root.replaceChildren(heading, toolbar, filters, summary, message, list, footer);
  const zoom = el('dialog', 'community-zoom'); zoom.setAttribute('aria-label', 'Contribution preview');
  const closeZoom = button('Close preview', 'community-secondary', () => zoom.close());
  const zoomImage = el('img'); zoom.append(closeZoom, zoomImage); root.append(zoom);
  zoom.addEventListener('click', e => { if (e.target === zoom) zoom.close(); });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); }); sort.addEventListener('change', render);
  function status(text, warning = false) { message.textContent = text; message.hidden = !text; message.classList.toggle('warning', warning); }
  async function link(id, kind) {
    try { await invoke('open_community_link', { id, kind }); } catch (error) { status(String(error), true); }
  }
  function imageUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      if (/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/.test(value)) value = raw + value;
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash
        && ((u.hostname === 'cdn.sidequestvr.com' && u.pathname.startsWith('/file/')) || (u.hostname === 'raw.githubusercontent.com' && u.pathname.startsWith('/SideQuestVR/Creator-Community/main/'))) ? u.href : null;
    } catch { return null; }
  }
  function bytes(value) { return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`; }
  async function download(entry, node) {
    if (busy) return;
    busy = true; refresh.disabled = true; updateDownloads(); status('Choose a destination. The package will be checked before saving.');
    window.dispatchEvent(new CustomEvent('creator-community-busy', { detail: true }));
    try { status(await invoke('download_community_package', { id: entry.id })); }
    catch (error) { status(String(error), true); }
    finally { busy = false; refresh.disabled = false; updateDownloads(); window.dispatchEvent(new CustomEvent('creator-community-busy', { detail: false })); }
  }
  function item(entry) {
    const article = el('article', 'community-item'); article.dataset.id = entry.id;
    const visual = el('div', 'community-visual'); const source = imageUrl(entry.previewImage);
    if (source) {
      const open = button('', 'community-image-button', () => { zoomImage.src = source; zoomImage.alt = `${entry.name} preview`; zoom.showModal(); });
      open.title = 'Enlarge preview'; open.setAttribute('aria-label', `Enlarge ${entry.name} preview`);
      const image = el('img'); image.src = source; image.alt = `${entry.name} preview`; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { open.replaceChildren(icon('plugins'), el('span', '', 'Preview unavailable')); open.disabled = true; }); open.append(image); visual.append(open);
    } else visual.append(icon('plugins'), el('span', '', 'No preview supplied'));
    const body = el('div', 'community-item-body');
    const meta = el('div', 'community-meta'); meta.append(el('span', 'community-type', types[entry.category] || 'Contribution'));
    if (entry.includesCode) meta.append(el('span', 'community-code', 'Includes C#'));
    body.append(meta, el('h3', '', entry.name));
    body.append(el('p', 'community-author', `By ${entry.author.name}${entry.author.discord ? ` / ${entry.author.discord}` : ''}`), el('p', 'community-description', entry.description));
    const actions = el('div', 'community-item-actions');
    const details = el('details', 'community-details'); const toggle = el('summary', '', 'Details & instructions'); details.append(toggle);
    const specs = el('dl', 'community-specs');
    const values = [['Licence', entry.license], ['Unity tested', entry.compatibility.unity.join(', ') || 'Not yet verified'], ['Creator SDK tested', entry.compatibility.creatorSdk.join(', ') || 'Not yet verified'], ['Banter SDK tested', entry.compatibility.banterSdk.join(', ') || 'Not yet verified'], ['Dependencies', entry.dependencies.join(', ') || 'None declared'], ['Package', entry.download ? `${bytes(entry.download.byteLength)} / ${entry.version}` : 'Instructions only']];
    for (const [label, text] of values) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', text)); specs.append(row); }
    details.append(el('p', 'community-usage', entry.usage || 'See the contributor instructions.'), specs, el('p', 'community-test-notes', entry.testNotes));
    if (entry.contents?.length) { details.append(el('h4', '', 'Package contents')); const files = el('ul', 'community-files'); for (const file of entry.contents) files.append(el('li', '', file)); details.append(files); }
    if (entry.includesCode) details.append(el('p', 'community-caution', 'C# can run when Unity imports it. Review the files first; a checksum is not a safety check.'));
    const links = el('div', 'community-detail-links');
    for (const [kind, label, exists] of [['instructions', 'Full instructions', true], ['license', 'Licence notes', true], ['source', 'Source', entry.sourceUrl], ['discussion', 'Discord post', entry.discussionUrl]]) if (exists) links.append(button(label, 'community-link', () => link(entry.id, kind), 'external'));
    details.append(links);
    if (entry.download && entry.reviewStatus === 'listed') {
      const save = button('Download package', 'community-primary', () => download(entry, save), 'download'); save.dataset.communityDownload = entry.id; save.disabled = busy || snapshot.stale; actions.append(save, el('span', 'community-size', bytes(entry.download.byteLength)));
    } else actions.append(el('span', 'community-review', entry.download ? 'Review pending' : 'Recipe'));
    body.append(actions); article.append(visual, body, details); return article;
  }
  function render() {
    const entries = snapshot?.entries || [];
    for (const node of filterButtons) { node.setAttribute('aria-pressed', String(node.dataset.category === category)); }
    const filtered = entries.filter(entry => (category === 'all' || entry.category === category) && [entry.name, entry.description, entry.author.name, entry.author.discord || ''].some(s => s.toLowerCase().includes(query)))
      .sort((a, b) => (sort.value === 'author' ? a.author.name.localeCompare(b.author.name) : a.name.localeCompare(b.name)) || a.id.localeCompare(b.id));
    summary.textContent = snapshot ? `${filtered.length} ${filtered.length === 1 ? 'contribution' : 'contributions'}${snapshot.stale ? ' / Saved view, refresh required' : ''}` : 'Loading catalogue...';
    list.replaceChildren(...filtered.map(item));
    if (snapshot && !filtered.length) {
      const empty = el('div', 'community-empty'); empty.append(icon('plugins'), el('h3', '', entries.length ? 'No matching contributions' : 'The catalogue is getting started'), el('p', '', entries.length ? 'Try a different search or type.' : 'No contributions are listed yet.'));
      if (entries.length) empty.append(button('Clear filters', 'community-secondary', () => { category = 'all'; query = ''; search.value = ''; render(); }));
      else empty.append(button('Share a creation', 'community-secondary', () => link('', 'submit'), 'external')); list.append(empty);
    }
  }
  function updateDownloads() { for (const button of root.querySelectorAll('[data-community-download]')) button.disabled = busy || Boolean(snapshot?.stale); }
  async function load(refreshRequested = false) {
    if (busy) return;
    busy = true; refresh.disabled = true; updateDownloads();
    if (!snapshot) { summary.textContent = 'Loading catalogue...'; list.replaceChildren(); }
    status('');
    try {
      const next = await invoke('community_catalogue', { refresh: refreshRequested });
      if (!next || !Array.isArray(next.entries) || !Array.isArray(next.warnings) || next.entries.length > 50) throw new Error('Invalid community catalogue response.');
      snapshot = next; lastRefresh = Date.now(); render(); status(next.warnings.join(' '), next.warnings.length > 0);
    } catch (error) {
      if (snapshot) { snapshot.stale = true; render(); } else summary.textContent = 'Catalogue unavailable';
      status(String(error), true);
    } finally { busy = false; refresh.disabled = false; updateDownloads(); }
  }
  window.CreatorCommunity = Object.freeze({ show() { if (!snapshot || Date.now() - lastRefresh > 180000) return load(); }, closePreview() { if (zoom.open) zoom.close(); } });
})();
