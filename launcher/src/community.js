/* Shared by Hub and the standalone Creator apps. No HTML from the catalogue. */
(() => {
  const root = document.getElementById('view-plugins');
  if (!root) return;
  const types = { all: 'All types', graph: 'Visual Scripting', prefab: 'Prefabs', plugin: 'Plugins', 'community-tool': 'Editor tools', recipe: 'Recipes', 'mcp-tool': 'MCP tools', 'ai-skill': 'AI skills' };
  const raw = 'https://raw.githubusercontent.com/SideQuestVR/Creator-Community/main/';
  const invoke = (command, args = {}) => (window.CreatorCommunityInvoke || window.CreatorHubNative.invoke)(command, args);
  let snapshot = null, busy = false, query = '', category = 'all', lastRefresh = 0;
  const layoutKey = 'creator-plugins.layout.v1';
  let layout = 'grid';
  try { if (localStorage.getItem(layoutKey) === 'list') layout = 'list'; } catch { /* Storage may be unavailable in an embedded client. */ }
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const icon = name => { const node = el('span', `icon icon-${name}`); node.setAttribute('aria-hidden', 'true'); return node; };
  function button(label, className, action, symbol) {
    const node = el('button', className); node.type = 'button'; if (symbol) node.append(icon(symbol)); node.append(document.createTextNode(label)); node.addEventListener('click', action); return node;
  }
  const heading = el('div', 'community-heading');
  const headingText = el('div'); const title = el('h2', '', 'Creator Plugins'); title.id = 'plugins-title'; title.tabIndex = -1;
  headingText.append(title, el('p', 'community-subtitle', 'Made by the community. Shared with creators.'));
  const submit = button('Share a creation', 'community-secondary', () => link('', 'submit'), 'external');
  const addMenu = button('Add Unity menu', 'community-secondary', () => openProject(null), 'plugins');
  addMenu.hidden = true;
  const headingActions = el('div', 'community-heading-actions'); headingActions.append(addMenu, submit);
  heading.append(headingText, headingActions);
  const toolbar = el('div', 'community-toolbar');
  const search = el('input', 'community-search'); search.type = 'search'; search.placeholder = 'Search contributions'; search.setAttribute('aria-label', 'Search contributions');
  const sort = el('select', 'community-sort'); sort.setAttribute('aria-label', 'Sort contributions');
  for (const [value, label] of [['name', 'Name A-Z'], ['author', 'Creator A-Z']]) { const option = el('option', '', label); option.value = value; sort.append(option); }
  const refresh = button('', 'community-icon-button', () => load(true), 'refresh'); refresh.title = 'Refresh catalogue'; refresh.setAttribute('aria-label', 'Refresh catalogue');
  const viewModes = el('div', 'community-view-modes'); viewModes.setAttribute('role', 'group'); viewModes.setAttribute('aria-label', 'Catalogue layout');
  const viewButtons = ['list', 'grid'].map(value => {
    const label = value === 'grid' ? 'Grid view' : 'List view';
    const node = button('', 'community-icon-button', () => {
      layout = value;
      try { localStorage.setItem(layoutKey, value); } catch { /* Keep the current view usable without storage. */ }
      applyLayout();
    }, value === 'grid' ? 'layout-grid' : 'list');
    node.title = label; node.setAttribute('aria-label', label); node.dataset.layout = value;
    viewModes.append(node); return node;
  });
  toolbar.append(search, sort, viewModes, refresh);
  const filters = el('div', 'community-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Contribution type');
  const filterButtons = Object.entries(types).map(([value, label]) => {
    const node = button(label, 'community-filter', () => { category = value; render(); }); node.dataset.category = value; filters.append(node); return node;
  });
  const summary = el('p', 'community-count'); summary.setAttribute('role', 'status');
  const message = el('p', 'community-message'); message.setAttribute('role', 'status'); message.hidden = true;
  const list = el('div', 'community-list'); list.setAttribute('aria-label', 'Contributions');
  function applyLayout() {
    list.dataset.layout = layout;
    for (const node of viewButtons) node.setAttribute('aria-pressed', String(node.dataset.layout === layout));
  }
  applyLayout();
  const footer = el('div', 'community-footer');
  footer.append(el('span', '', 'SideQuest Creator Community'), button('Catalogue on GitHub', 'community-link', () => link('', 'catalogue'), 'external'));
  root.replaceChildren(heading, toolbar, filters, summary, message, list, footer);
  const zoom = el('dialog', 'community-zoom'); zoom.setAttribute('aria-label', 'Contribution preview');
  const closeZoom = button('Close preview', 'community-secondary', () => zoom.close());
  const zoomTitle = el('h3');
  const zoomStage = el('div', 'community-media-stage');
  const zoomStatus = el('p', 'community-media-status'); zoomStatus.setAttribute('role', 'status');
  const previousMedia = button('', 'community-icon-button', () => selectMedia(mediaIndex - 1), 'chevron-left');
  previousMedia.title = 'Previous preview'; previousMedia.setAttribute('aria-label', 'Previous preview');
  const nextMedia = button('', 'community-icon-button', () => selectMedia(mediaIndex + 1), 'chevron-right');
  nextMedia.title = 'Next preview'; nextMedia.setAttribute('aria-label', 'Next preview');
  const mediaCount = el('span', 'community-media-count');
  const mediaAction = button('Load animation', 'community-secondary', () => {}, 'play');
  const mediaRetry = button('Retry preview', 'community-secondary', () => showMedia(false), 'refresh'); mediaRetry.hidden = true;
  const mediaControls = el('div', 'community-media-controls');
  mediaControls.append(previousMedia, mediaCount, nextMedia, mediaAction, mediaRetry);
  const zoomHeader = el('div', 'community-media-header'); zoomHeader.append(zoomTitle, closeZoom);
  zoom.append(zoomHeader, zoomStage, zoomStatus, mediaControls); root.append(zoom);
  let mediaItems = [], mediaIndex = 0, mediaName = '', mediaAbort = null, mediaBlob = null;
  function clearMedia() {
    mediaAbort?.abort(); mediaAbort = null;
    const video = zoomStage.querySelector('video'); if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    zoomStage.replaceChildren();
    if (mediaBlob) { URL.revokeObjectURL(mediaBlob); mediaBlob = null; }
  }
  zoom.addEventListener('close', clearMedia);
  zoom.addEventListener('keydown', event => {
    if (event.target.tagName === 'VIDEO') return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); selectMedia(mediaIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  zoom.addEventListener('click', e => { if (e.target === zoom) zoom.close(); });
  let projectBusy = false, projectError = false, projectEntries = [], importEntry = null, outcome = null;
  const projectDialog = el('dialog', 'community-project-dialog'); projectDialog.setAttribute('aria-labelledby', 'community-project-title');
  const projectTitle = el('h3'); projectTitle.id = 'community-project-title';
  const projectLabel = el('label', '', 'Unity project'); projectLabel.htmlFor = 'community-project-select';
  const projectSelect = el('select', 'community-project-select'); projectSelect.id = 'community-project-select';
  const browseProject = button('Browse', 'community-secondary', () => projectAction(async () => {
    const target = await invoke('choose_community_project');
    if (target) { projectEntries = projectEntries.filter(p => p.id !== target.id).concat(target); fillProjects(target.id); projectError = false; outcome = null; projectMessage.textContent = ''; }
  }, 'Waiting for a project folder...'), 'folder');
  const refreshProjects = button('', 'community-icon-button', () => projectAction(refreshTargets, 'Loading Unity projects... Please wait.'), 'refresh'); refreshProjects.title = 'Refresh projects'; refreshProjects.setAttribute('aria-label', 'Refresh projects');
  const projectPicker = el('div', 'community-project-picker'); projectPicker.append(projectSelect, browseProject, refreshProjects);
  const projectPath = el('p', 'community-project-path'); const projectInfo = el('p', 'community-project-info');
  const projectSafety = el('p', 'community-project-safety');
  const projectMessage = el('p', 'community-message'); projectMessage.setAttribute('role', 'status'); projectMessage.hidden = true;
  const projectLoading = el('p', 'community-message'); projectLoading.setAttribute('role', 'status'); projectLoading.hidden = true;
  const menuAction = button('Add menu to project', 'community-secondary', () => projectAction(async () => {
    const id = projectSelect.value; projectMessage.textContent = await invoke('install_community_menu', { projectId: id });
    await refreshTargets();
  }, 'Preparing the Unity menu... Please wait.'), 'plugins');
  const sendAction = button('Send to Unity for review', 'community-primary', () => projectAction(async () => {
    outcome = await runTransfer('queue_community_import', { id: importEntry.id, projectId: projectSelect.value }, true);
    showOutcome();
  }, 'Preparing the package for Unity review... Please wait.'), 'download');
  const checkAction = button('Check Unity status', 'community-secondary', () => projectAction(async () => {
    outcome = await invoke('community_import_status', { projectId: outcome.projectId, requestId: outcome.requestId }); showOutcome();
  }, 'Checking the Unity import status...'), 'refresh');
  const closeProject = button('Close', 'community-secondary', () => projectDialog.close());
  const projectActions = el('div', 'community-project-actions'); projectActions.append(menuAction, sendAction, checkAction, closeProject);
  projectDialog.append(projectTitle, el('p', 'community-project-info', 'Experimental project integration'), projectLoading, projectLabel, projectPicker, projectPath, projectInfo, projectSafety, projectMessage, projectActions); root.append(projectDialog);
  const transferPanel = el('div', 'community-transfer'); transferPanel.hidden = true;
  const transferText = el('span'); transferText.setAttribute('role', 'status');
  const cancelTransfer = button('Cancel download', 'community-secondary', async () => {
    if (!activeTransfer) return;
    const id = activeTransfer;
    cancelTransfer.disabled = true;
    try { await invoke('cancel_community_transfer', { operationId: id }); if (activeTransfer === id) transferText.textContent = 'Cancelling download...'; }
    catch (error) { if (activeTransfer === id) { transferText.textContent = String(error); cancelTransfer.disabled = false; } }
  }, 'close');
  transferPanel.append(transferText, cancelTransfer);
  let activeTransfer = null;
  async function runTransfer(command, args, inProject = false) {
    const operationId = crypto.randomUUID(); activeTransfer = operationId;
    let timer;
    const started = performance.now();
    (inProject ? projectDialog : root).append(transferPanel);
    transferPanel.hidden = false; cancelTransfer.hidden = true; cancelTransfer.disabled = false;
    transferText.textContent = 'Preparing download...';
    const poll = async () => {
      try {
        const progress = await invoke('community_transfer_status');
        if (activeTransfer !== operationId) return;
        if (progress?.id === operationId) {
          const speed = progress.received / Math.max(1, (performance.now() - started) / 1000);
          const phase = { downloading: 'Downloading', checking: 'Checking package', review: 'Waiting for approval', queueing: 'Sending to Unity', saving: 'Saving package' }[progress.phase] || 'Working';
          transferText.textContent = `${phase}: ${bytes(progress.received)} / ${bytes(progress.total)}${progress.phase === 'downloading' ? ` (${bytes(speed)}/s)` : ''}`;
          cancelTransfer.hidden = progress.cancellable !== true;
        }
      } catch { /* The operation result remains authoritative if progress cannot be read. */ }
      if (activeTransfer === operationId) timer = setTimeout(poll, 250);
    };
    timer = setTimeout(poll, 100);
    try { return await invoke(command, { ...args, operationId }); }
    finally { activeTransfer = null; clearTimeout(timer); transferPanel.hidden = true; }
  }
  projectDialog.addEventListener('cancel', event => { if (projectBusy) event.preventDefault(); });
  window.addEventListener('focus', () => {
    if (projectDialog.open && !busy && !projectBusy) void projectAction(refreshTargets, 'Rechecking Unity projects...');
  });
  projectSelect.addEventListener('change', () => { outcome = null; projectMessage.textContent = ''; renderProject(); });
  function fillProjects(selectedId = projectSelect.value) {
    const first = el('option', '', 'Choose a Unity project'); first.value = '';
    const choices = projectEntries.map(project => { const choice = el('option', '', project.name); choice.value = project.id; return choice; });
    projectSelect.replaceChildren(first, ...choices); projectSelect.value = projectEntries.some(p => p.id === selectedId) ? selectedId : '';
  }
  function renderProject() {
    const target = projectEntries.find(p => p.id === projectSelect.value);
    projectSelect.disabled = browseProject.disabled = refreshProjects.disabled = closeProject.disabled = projectBusy;
    projectPath.textContent = target?.path || '';
    projectInfo.textContent = target ? `Unity ${target.unityVersion} / ${target.sdk}` : '';
    const helperNote = !target ? 'Choose the project you want to change.' : target.helper === 'different' ? 'Existing Creator Plugins files differ. They will not be overwritten.' : target.helper === 'outdated' ? (target.open ? 'Close this project in Unity before updating its menu.' : 'A known older Creator Plugins menu is installed. Updating backs it up and preserves Unity metadata.') : target.helper === 'missing' ? (target.open ? 'Close this project in Unity before adding its menu.' : 'The Creator Plugins menu is not installed in this project.') : 'Creator Plugins menu installed.';
    projectSafety.textContent = `${helperNote} ${importEntry ? 'Packages are queued outside Assets. Review files in Unity before importing; no scenes are saved automatically.' : 'Adds an Editor-only package. It does not install MCP or community assets.'}`;
    menuAction.hidden = target?.helper === 'installed';
    menuAction.lastChild.textContent = target?.helper === 'outdated' ? 'Update menu in project' : 'Add menu to project';
    menuAction.disabled = projectBusy || projectError || !target || !['missing', 'outdated'].includes(target.helper) || target.open;
    sendAction.hidden = !importEntry;
    sendAction.disabled = projectBusy || projectError || !target || target.helper !== 'installed' || !importEntry || importEntry.reviewStatus !== 'listed' || Boolean(snapshot?.stale) || Boolean(outcome?.requestId && ['queued', 'review'].includes(outcome.status));
    checkAction.hidden = !outcome?.requestId; checkAction.disabled = projectBusy || !outcome?.requestId;
    projectMessage.hidden = !projectMessage.textContent;
    projectLoading.hidden = !projectBusy;
    projectDialog.setAttribute('aria-busy', String(projectBusy));
  }
  async function refreshTargets() {
    const next = await invoke('community_projects');
    if (!next || !Array.isArray(next.projects) || !Array.isArray(next.warnings) || next.projects.length > 200) throw new Error('Invalid project list response.');
    projectEntries = next.projects; projectError = false; fillProjects();
    if (next.warnings.length) projectMessage.textContent = next.warnings.join(' ');
  }
  async function projectAction(action, loadingMessage) {
    if (busy || projectBusy) return;
    projectLoading.textContent = loadingMessage;
    busy = projectBusy = true; refresh.disabled = true; updateDownloads(); renderProject();
    window.dispatchEvent(new CustomEvent('creator-community-busy', { detail: true }));
    try { await action(); }
    catch (error) { projectMessage.textContent = String(error); projectMessage.classList.add('warning'); }
    finally { busy = projectBusy = false; refresh.disabled = false; updateDownloads(); renderProject(); window.dispatchEvent(new CustomEvent('creator-community-busy', { detail: false })); }
  }
  function showOutcome() {
    if (!outcome || !['queued', 'review', 'imported', 'cancelled', 'failed'].includes(outcome.status)) throw new Error('Import outcome is unrecognized. Check Unity; no success has been assumed.');
    const labels = { queued: 'Queued, not imported', review: 'Waiting for the Unity import outcome', imported: 'Unity reported imported files. Project validation is still needed', cancelled: 'Cancelled', failed: 'Import not confirmed or failed' };
    projectMessage.textContent = `${labels[outcome.status]}. ${outcome.message}`;
  }
  async function openProject(entry) {
    if (busy || snapshot?.projectImportEnabled !== true) return;
    importEntry = entry; outcome = null; projectMessage.textContent = ''; projectMessage.classList.remove('warning');
    projectTitle.textContent = entry ? `Add ${entry.name}` : 'Add Unity menu';
    renderProject(); projectDialog.showModal();
    await projectAction(async () => { try { await refreshTargets(); } catch (error) { projectError = true; throw error; } }, 'Loading Unity projects... Please wait.');
  }
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
  function gallery(entry) {
    const cover = imageUrl(entry.previewImage);
    const items = snapshot?.media?.find(g => g.id === entry.id)?.items;
    const valid = Array.isArray(items) && items.length <= 8 ? items.filter(item => {
      if (!item || !imageUrl(item.url)) return false;
      if (item.type === 'image') return /\.(png|jpe?g)$/.test(item.url);
      return ['gif', 'webm'].includes(item.type) && item.url.endsWith(`.${item.type}`)
        && imageUrl(item.poster) && /\.(png|jpe?g)$/.test(item.poster);
    }) : [];
    return cover && !valid.some(item => imageUrl(item.url) === cover)
      ? [{ type: 'image', url: cover }, ...valid] : valid.length ? valid : cover ? [{ type: 'image', url: cover }] : [];
  }
  function selectMedia(index) {
    if (!mediaItems.length) return;
    mediaIndex = (index + mediaItems.length) % mediaItems.length;
    showMedia(false);
  }
  async function showMedia(animate) {
    clearMedia();
    const item = mediaItems[mediaIndex]; if (!item) return;
    const controller = new AbortController(); mediaAbort = controller;
    const timer = setTimeout(() => controller.abort(), 25000);
    const animated = item.type !== 'image';
    mediaCount.textContent = `${mediaIndex + 1} / ${mediaItems.length}`;
    previousMedia.hidden = nextMedia.hidden = mediaItems.length < 2;
    mediaAction.hidden = !animated;
    mediaAction.lastChild.textContent = animate ? 'Show poster' : item.type === 'webm' ? 'Load video' : 'Load animation';
    mediaAction.onclick = () => showMedia(!animate);
    mediaRetry.hidden = true; zoomStatus.textContent = 'Loading preview...';
    const url = imageUrl(animated && !animate ? item.poster : item.url);
    const max = animate && item.type === 'webm' ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
    try {
      if (!url) throw Error('Unapproved preview URL.');
      const response = await fetch(url, { signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body) throw Error('Preview unavailable.');
      if (Number(response.headers.get('content-length')) > max) throw Error('Preview exceeds its size limit.');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > max) throw Error('Preview exceeds its size limit.'); chunks.push(value); }
      } finally { await reader.cancel(); }
      if (controller.signal.aborted || mediaAbort !== controller || !zoom.open) return;
      const type = animate ? item.type : 'image';
      const mime = type === 'webm' ? 'video/webm' : type === 'gif' ? 'image/gif' : url.endsWith('.png') ? 'image/png' : 'image/jpeg';
      mediaBlob = URL.createObjectURL(new Blob(chunks, { type: mime }));
      const media = el(type === 'webm' ? 'video' : 'img');
      media.setAttribute('aria-label', `${mediaName} preview ${mediaIndex + 1}`);
      if (type === 'webm') { media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
      else media.alt = `${mediaName} preview ${mediaIndex + 1}`;
      media.addEventListener('error', () => { if (mediaAbort === controller) { zoomStatus.textContent = 'Preview cannot be displayed. Try its static poster.'; mediaRetry.hidden = false; } });
      const sizeEvent = type === 'webm' ? 'loadedmetadata' : 'load';
      media.addEventListener(sizeEvent, () => {
        const width = media.videoWidth || media.naturalWidth, height = media.videoHeight || media.naturalHeight;
        if (width > 4096 || height > 4096 || width * height > 4 * 1024 * 1024) {
          if (type === 'webm') media.pause();
          media.remove(); zoomStatus.textContent = 'Preview dimensions exceed the limit.'; mediaRetry.hidden = false;
        }
      });
      media.src = mediaBlob; zoomStage.append(media);
      zoomStatus.textContent = animated && !animate ? `${item.type === 'gif' ? 'GIF' : 'WebM'} / Static poster` : '';
    } catch (error) {
      if (mediaAbort === controller && zoom.open) { zoomStatus.textContent = controller.signal.aborted ? 'Preview timed out. Try again.' : String(error.message || error); mediaRetry.hidden = false; }
    } finally { clearTimeout(timer); }
  }
  function bytes(value) { return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`; }
  function unityImport(entry) {
    return ['graph', 'prefab', 'plugin', 'community-tool'].includes(entry.category)
      && ['editor-only', 'runtime', 'both'].includes(entry.scope)
      && /\.unitypackage$/.test(entry.download?.url || entry.download?.path || '');
  }
  function destination(entry) {
    if (entry.category === 'ai-skill') return 'AI client skill. Follow the client and project/user scope in the instructions; not a Unity asset.';
    if (entry.category === 'mcp-tool') return 'MCP client or server. Review its configuration and execution permissions in the instructions; not a Unity asset.';
    if (entry.category === 'recipe' || entry.scope === 'instructions-only' || !entry.download) return 'Instructions only. No automatic installation.';
    if (unityImport(entry)) return 'Unity asset package. Original paths and GUIDs are retained. Review files and replacements in Unity before importing.';
    return 'Archive download. Follow the contributor instructions; ZIP and Package Manager packages are not Unity asset imports.';
  }
  function incorporation(entry) {
    if (entry.category === 'ai-skill') return ['Read the skill and any bundled scripts before enabling it.', 'Use the client and project/user scope specified by its author. Do not place AI skills in Assets.', 'Enable it in that client and test a small, non-destructive task.'];
    if (entry.category === 'mcp-tool') return ['Check whether this is a server, remote service or an extension for an existing server.', 'Follow the author\'s client configuration and review its permissions and startup command. Do not place it in Assets.', 'Test a read-only tool first. Keep credentials out of shared project files.'];
    if (!unityImport(entry)) return ['Follow the contributor instructions for the required format and dependencies.', 'ZIP archives and Package Manager packages require their own setup; they are not imported as Unity asset packages.'];
    const common = 'Check the listed SDK/dependencies, then review package files and replacements in Unity. Keep shared dependencies in their original locations.';
    if (entry.category === 'graph') return [common, 'Select the imported graph asset in Unity, then use Creator Plugins > Organize selected assets. Reuse a Visual Scripting/VS folder, or create one after reviewing the move.', 'Assign the graph to the appropriate Script Machine or State Machine as described below. Check variables, references and event connections before testing.'];
    if (entry.category === 'prefab') return [common, 'Select the imported prefab and use Creator Plugins > Organize selected assets to place it under Prefabs. Keep its materials, scripts and other dependencies intact.', 'Add an instance to the intended scene, set its references and test it before saving your scene changes.'];
    if (entry.category === 'community-tool' || entry.scope === 'editor-only') return [common, 'Preserve Editor folders and assembly definitions. Do not move Editor code into a runtime folder.', 'Wait for compilation, then open the author\'s Unity menu or window and follow its setup instructions.'];
    return [common, 'Preserve the package layout, assembly boundaries and shared dependencies.', 'Follow the contributor\'s component and configuration steps below, then check compilation and behaviour.'];
  }
  async function download(entry, node) {
    if (busy) return;
    busy = true; refresh.disabled = true; updateDownloads(); status('Choose a destination. The package will be checked before saving.');
    window.dispatchEvent(new CustomEvent('creator-community-busy', { detail: true }));
    try { status(await runTransfer('download_community_package', { id: entry.id })); }
    catch (error) { status(String(error), true); }
    finally { busy = false; refresh.disabled = false; updateDownloads(); window.dispatchEvent(new CustomEvent('creator-community-busy', { detail: false })); }
  }
  function item(entry) {
    const product = (snapshot.products || []).find(p => p.id === entry.id && p.version === entry.version
      && entry.reviewStatus === 'listed' && entry.scope === 'instructions-only' && !entry.download);
    const article = el('article', 'community-item'); article.dataset.id = entry.id;
    const visual = el('div', 'community-visual'); const media = gallery(entry);
    const source = imageUrl(entry.previewImage) || imageUrl(media[0]?.poster || media[0]?.url);
    if (source) {
      const open = button('', 'community-image-button', () => { mediaItems = media; mediaName = entry.name; zoomTitle.textContent = entry.name; zoom.showModal(); selectMedia(0); });
      open.title = 'Enlarge preview'; open.setAttribute('aria-label', `Enlarge ${entry.name} preview`);
      const image = el('img'); image.src = source; image.alt = `${entry.name} preview`; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { open.replaceChildren(icon('plugins'), el('span', '', 'Preview unavailable')); }); open.append(image); visual.append(open);
      if (media.length > 1) open.append(el('span', 'community-media-badge', `${media.length} previews`));
    } else visual.append(icon('plugins'), el('span', '', 'No preview supplied'));
    const body = el('div', 'community-item-body');
    const meta = el('div', 'community-meta'); meta.append(el('span', 'community-type', types[entry.category] || 'Contribution'));
    if (entry.includesCode) meta.append(el('span', 'community-code', 'Includes code'));
    if (product) meta.append(el('span', 'community-code', 'Paid'));
    body.append(meta, el('h3', '', entry.name));
    body.append(el('p', 'community-author', `By ${entry.author.name}${entry.author.discord ? ` / ${entry.author.discord}` : ''}`), el('p', 'community-description', entry.description));
    const actions = el('div', 'community-item-actions');
    const details = el('details', 'community-details'); const toggle = el('summary', '', 'Details & instructions'); details.append(toggle);
    const specs = el('dl', 'community-specs');
    const values = [['Licence', entry.license], ['Unity compatibility', entry.compatibility.unity.join(', ') || 'Not specified'], ['Creator SDK compatibility', entry.compatibility.creatorSdk.join(', ') || 'Not specified'], ['Banter SDK compatibility', entry.compatibility.banterSdk.join(', ') || 'Not specified'], ['Dependencies', entry.dependencies.join(', ') || 'None declared'], ['Package', entry.download ? `${bytes(entry.download.byteLength)} / ${entry.version}` : 'Instructions only']];
    const dimensions = { unity: 'Unity', 'creator-sdk': 'Creator SDK', 'banter-sdk': 'Banter SDK', 'render-pipeline': 'Render pipeline', 'host-os': 'Host OS', 'build-target': 'Build target', runtime: 'Runtime' };
    if (product) {
      actions.append(button('Purchase', 'community-primary', () => link(entry.id, 'purchase'), 'external'),
        button('Product website', 'community-secondary', () => link(entry.id, 'product'), 'external'));
      for (const claim of product.claims || []) values.push([
        dimensions[claim.dimension] || claim.dimension,
        `${claim.value} / ${claim.evidence === 'maintainer-tested' ? 'Maintainer tested' : 'Author reported'}: ${claim.notes}`
      ]);
      details.append(el('p', 'community-caution', 'External purchase. Current pricing and product licence are supplied by the author. No package is included in this listing.'));
    }
    for (const [label, text] of values) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', text)); specs.append(row); }
    details.append(el('p', 'community-destination', destination(entry)), el('p', 'community-usage', entry.usage || 'See the contributor instructions.'), specs, el('p', 'community-test-notes', entry.testNotes));
    details.append(el('h4', '', 'Incorporation steps'));
    const steps = el('ol', 'community-incorporation');
    for (const step of incorporation(entry)) steps.append(el('li', '', step));
    details.append(steps);
    if (entry.contents?.length) { details.append(el('h4', '', 'Package contents')); const files = el('ul', 'community-files'); for (const file of entry.contents) files.append(el('li', '', file)); details.append(files); }
    if (entry.includesCode) details.append(el('p', 'community-caution', 'Review code before installing or running it. Unity C# can run on import; a checksum is not a safety check.'));
    const links = el('div', 'community-detail-links');
    for (const [kind, label, exists] of [['instructions', 'Full instructions', true], ['license', 'Licence notes', true], ['source', 'Source', entry.sourceUrl], ['discussion', 'Discord post', entry.discussionUrl]]) if (exists) links.append(button(label, 'community-link', () => link(entry.id, kind), 'external'));
    details.append(links);
    if (entry.download && entry.reviewStatus === 'listed') {
      const save = button('Download package', 'community-primary', () => download(entry, save), 'download'); save.dataset.communityDownload = entry.id; save.disabled = busy || snapshot.stale; actions.append(save, el('span', 'community-size', bytes(entry.download.byteLength)));
    } else if (!product) actions.append(el('span', 'community-review', entry.download ? 'Review pending' : 'Instructions only'));
    if (snapshot?.projectImportEnabled === true && unityImport(entry)) {
      const add = button('Add to project', 'community-secondary', () => openProject(entry), 'plugins');
      add.dataset.communityImport = entry.reviewStatus;
      add.disabled = busy || snapshot.stale || entry.reviewStatus !== 'listed';
      if (entry.reviewStatus !== 'listed') add.title = 'Available after this contribution has been reviewed.';
      actions.append(add);
    }
    body.append(actions); article.append(visual, body, details); return article;
  }
  function render() {
    const entries = snapshot?.entries || [];
    addMenu.hidden = snapshot?.projectImportEnabled !== true;
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
  function updateDownloads() {
    addMenu.disabled = busy;
    for (const button of root.querySelectorAll('[data-community-download]')) button.disabled = busy || Boolean(snapshot?.stale);
    for (const button of root.querySelectorAll('[data-community-import]')) button.disabled = busy || Boolean(snapshot?.stale) || button.dataset.communityImport !== 'listed';
  }
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
  window.CreatorCommunity = Object.freeze({ show() { if (!snapshot || Date.now() - lastRefresh > 180000) return load(); }, closePreview() { if (zoom.open) zoom.close(); if (projectDialog.open && !projectBusy) projectDialog.close(); } });
})();
