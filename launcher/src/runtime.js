(() => {
  const standalone = window === window.parent;
  if (standalone) {
    window.CreatorRuntime = Object.freeze({
      ready: Promise.resolve(), hosted: false, readOnly: false,
      invoke: (command, args) => window.__TAURI__.core.invoke(command, args),
      listen: (name, callback) => window.__TAURI__.event?.listen(name, callback) ?? Promise.resolve(() => {}),
      openDialog: options => window.__TAURI__.dialog.open(options),
      openExternal: url => window.__TAURI__.shell.open(url),
    });
    return;
  }

  // Being framed only waits for an explicit host connection; it grants no native authority.
  const commands = new Set(['get_hosted_snapshot', 'pick_project_folder', 'open_official_url']);
  const writableCommands = [
    'begin_ui_operation', 'finish_ui_operation', 'load_config', 'save_config',
    'discover_unity_projects', 'get_onboarding_status', 'add_project', 'one_click_setup',
    'get_project_sdk_profile', 'get_unity_extension_status', 'update_configured_unity_extensions',
    'update_codex_mcp_config', 'update_claude_mcp_config', 'update_antigravity_mcp_config',
    'update_opencode_mcp_config', 'remove_codex_mcp_config', 'remove_claude_mcp_config',
    'remove_antigravity_mcp_config', 'remove_opencode_mcp_config', 'install_unity_extension',
    'set_unity_custom_scripts', 'set_unity_allow_all_tests', 'get_project_feedback_settings',
    'set_project_feedback_settings', 'get_stable_release',
  ];
  let readOnly = true;
  const listeners = new Map();
  const queue = [];
  let active;
  let port;
  let sequence = 0;
  let failed;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const timer = setTimeout(() => disconnect('Hub did not connect. No configuration was changed.'), 15000);

  function emit(name, payload) {
    for (const callback of listeners.get(name) || []) {
      try { callback({ payload }); } catch (error) { console.error('Runtime listener failed:', error); }
    }
  }
  function disconnect(reason) {
    if (failed) return;
    failed = new Error(reason);
    clearTimeout(timer);
    port?.close();
    rejectReady(failed);
    active?.reject(failed);
    active = undefined;
    for (const item of queue.splice(0)) item.reject(failed);
    emit('creator-runtime-disconnected', reason);
    const controls = document.getElementById('workspaceControls');
    if (controls) controls.disabled = true;
  }
  function pump() {
    if (!port || active || failed || !queue.length) return;
    active = queue.shift();
    try { port.postMessage(active.message); }
    catch { disconnect('Hub transport failed. The last result is unknown; no command was retried.'); }
  }
  function invoke(command, args = {}) {
    if (failed) return Promise.reject(failed);
    if (!commands.has(command)) return Promise.reject(new Error('This hosted MCP preview is read-only.'));
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new Error('Invalid command arguments.'));
    // Reserve a slot for releasing the native workflow, even if other reads fill the queue.
    const limit = command === 'finish_ui_operation' ? 17 : 16;
    if (queue.length + Number(Boolean(active)) >= limit) return Promise.reject(new Error('Too many pending MCP operations.'));
    let message;
    try {
      message = { type: 'invoke', id: ++sequence, command, args };
      const json = JSON.stringify(message);
      if (new TextEncoder().encode(json).length > 60000) throw new Error('Hosted request exceeds the size limit.');
      message = JSON.parse(json);
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => { queue.push({ message, resolve, reject }); pump(); });
  }
  window.addEventListener('message', event => {
    if (port || failed || event.source !== window.parent || event.data?.type !== 'creator-host-connect'
      || event.data.protocol !== 1 || event.ports.length !== 1) return;
    if (event.data.effectiveMode !== undefined && !['read-only', 'writable'].includes(event.data.effectiveMode)) return;
    if (event.data.effectiveMode === 'writable' && event.data.hostingRevision !== 2) return;
    readOnly = event.data.effectiveMode !== 'writable';
    if (!readOnly) for (const command of writableCommands) commands.add(command);
    port = event.ports[0];
    port.onmessageerror = () => disconnect('Hub sent an unreadable response. No command was retried.');
    port.onmessage = ({ data }) => {
      if (failed) return;
      if (data?.type === 'disconnect') return disconnect('Hub disconnected. The last result may be unknown; no command was retried.');
      if (data?.type === 'event') {
        if (['creator-lifecycle-close-blocked', 'creator-mcp-lifecycle'].includes(data.name)) emit(data.name, data.payload);
        return;
      }
      if (data?.type !== 'result' || !active || data.id !== active.message.id || typeof data.ok !== 'boolean') {
        return disconnect('Hub returned an unexpected response. No command was retried.');
      }
      const request = active;
      active = undefined;
      if (data.ok) request.resolve(data.result); else request.reject(new Error(String(data.error || 'Hosted command failed.')));
      pump();
    };
    clearTimeout(timer);
    document.documentElement.classList.add('creator-hosted');
    port.postMessage({ type: 'ready', protocol: 1 });
    resolveReady();
    pump();
  });
  window.CreatorRuntime = Object.freeze({
    ready,
    get hosted() { return Boolean(port); },
    get readOnly() { return readOnly; },
    get disconnected() { return Boolean(failed); },
    invoke,
    async listen(name, callback) {
      if (!['creator-lifecycle-close-blocked', 'creator-runtime-disconnected', 'creator-mcp-lifecycle'].includes(name)) throw new Error('Unsupported hosted event.');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
      return () => listeners.get(name)?.delete(callback);
    },
    openDialog(options) {
      if (options?.directory !== true || options.multiple === true
        || Object.keys(options).some(key => !['directory', 'multiple', 'title'].includes(key))) {
        return Promise.reject(new Error('Only the project folder picker is available in this preview.'));
      }
      return invoke('pick_project_folder');
    },
    openExternal: url => invoke('open_official_url', { url }),
  });
})();
