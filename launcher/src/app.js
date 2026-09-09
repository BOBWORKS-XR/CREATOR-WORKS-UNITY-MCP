let config = {
  channels: [],
  active_channel_id: null,
  mcp_server_path: '',
  tool_groups: 'core',
  auto_start: true,
  enable_custom_scripts: false
};

let onboarding = null;
let discoveredProjects = [];
let selectedProjectPath = '';
let clientSelectionInitialized = false;
let projectStatusTimer = null;
let updateTimer = null;
let releaseUrl = null;
let feedbackRequest = 0;

const elements = {};

document.addEventListener('DOMContentLoaded', async function() {
  for (const id of [
    'status', 'runtimeBadge', 'projectPath', 'browseProjectBtn', 'discoveredProjects',
    'connectCodex', 'connectClaude', 'connectAntigravity', 'connectOpenCode',
    'codexDetection', 'claudeDetection', 'antigravityDetection', 'opencodeDetection',
    'codexState', 'claudeState', 'antigravityState', 'opencodeState',
    'setupBtn', 'setupMessage', 'projectsList', 'emptyState', 'addProjectBtn',
    'updateBridgesBtn', 'localFeedback', 'usageCheckIns', 'feedbackStatus',
    'automaticUpdates', 'checkUpdatesBtn', 'openReleaseBtn', 'updateStatus',
    'mcpServerPath', 'toolGroups', 'autoConfig', 'customScripts', 'allowAllTests', 'applyConfigBtn',
    'applyCodexBtn', 'applyAntigravityBtn', 'applyOpenCodeBtn',
    'disconnectBtn', 'disconnectCodexBtn', 'disconnectAntigravityBtn', 'disconnectOpenCodeBtn',
    'installExtensionBtn',
    'openDocsBtn', 'githubLink'
  ]) {
    elements[id] = document.getElementById(id);
  }

  setupEventListeners();

  try {
    const results = await Promise.all([
      window.__TAURI__.core.invoke('load_config'),
      window.__TAURI__.core.invoke('discover_unity_projects')
    ]);
    config = results[0];
    discoveredProjects = results[1];
    const active = getActiveChannel();
    selectedProjectPath = active ? active.unity_project_path : (discoveredProjects[0]?.path || '');
    elements.projectPath.value = selectedProjectPath;
    renderDiscoveredProjects();
    await refreshOnboardingStatus();
    updateUI();
    scheduleUpdateChecks();
  } catch (error) {
    console.error('Launcher initialization failed:', error);
    showToast('Failed to initialize launcher: ' + String(error), 'error');
  }
});

function setupEventListeners() {
  elements.localFeedback.addEventListener('change', saveFeedbackSettings);
  elements.usageCheckIns.addEventListener('change', saveFeedbackSettings);
  elements.checkUpdatesBtn.addEventListener('click', checkForUpdates);
  elements.openReleaseBtn.addEventListener('click', async function() {
    if (releaseUrl) {
      try { await window.__TAURI__.shell.open(releaseUrl); }
      catch (error) { elements.updateStatus.textContent = 'Could not open release: ' + String(error); }
    }
  });
  elements.automaticUpdates.addEventListener('change', async function() {
    const previous = config.automatic_update_checks === true;
    config.automatic_update_checks = elements.automaticUpdates.checked;
    if (!await saveLauncherConfig('Failed to save update preference')) {
      config.automatic_update_checks = previous;
      elements.automaticUpdates.checked = previous;
    }
    scheduleUpdateChecks();
  });
  elements.browseProjectBtn.addEventListener('click', chooseProjectForSetup);
  elements.addProjectBtn.addEventListener('click', addProjectFromPicker);
  elements.updateBridgesBtn.addEventListener('click', updateConfiguredBridges);

  elements.projectPath.addEventListener('input', function() {
    elements.localFeedback.disabled = true;
    elements.usageCheckIns.disabled = true;
    selectedProjectPath = elements.projectPath.value.trim();
    clearTimeout(projectStatusTimer);
    projectStatusTimer = setTimeout(async function() {
      await refreshOnboardingStatus();
      updateSetupStatus();
    }, 250);
  });

  elements.discoveredProjects.addEventListener('change', async function() {
    if (!elements.discoveredProjects.value) return;
    await selectSetupProject(elements.discoveredProjects.value);
  });

  elements.connectCodex.addEventListener('change', updateSetupButton);
  elements.connectClaude.addEventListener('change', updateSetupButton);
  elements.connectAntigravity.addEventListener('change', updateSetupButton);
  elements.connectOpenCode.addEventListener('change', updateSetupButton);
  elements.setupBtn.addEventListener('click', runQuickSetup);

  elements.mcpServerPath.addEventListener('change', async function() {
    config.mcp_server_path = elements.mcpServerPath.value.trim();
    await saveLauncherConfig('Failed to save MCP server path');
  });

  elements.toolGroups.addEventListener('change', async function() {
    config.tool_groups = elements.toolGroups.value;
    await saveLauncherConfig('Failed to save capabilities');
    if (elements.autoConfig.checked && getActiveChannel()) {
      await updateConfiguredClients(getActiveChannel());
    }
  });

  elements.autoConfig.addEventListener('change', async function() {
    config.auto_start = elements.autoConfig.checked;
    await saveLauncherConfig('Failed to save active-project preference');
  });

  elements.customScripts.addEventListener('change', async function() {
    config.enable_custom_scripts = elements.customScripts.checked;
    await saveLauncherConfig('Failed to save script preference');
    const channel = getActiveChannel();
    if (channel) {
      await window.__TAURI__.core.invoke('set_unity_custom_scripts', {
        unityProjectPath: channel.unity_project_path,
        enabled: config.enable_custom_scripts
      });
    }
  });

  elements.allowAllTests.addEventListener('change', async function() {
    const previous = config.allow_all_tests !== false;
    const channel = getActiveChannel();
    config.allow_all_tests = elements.allowAllTests.checked;
    elements.allowAllTests.disabled = true;
    try {
      if (!await saveLauncherConfig('Failed to save test policy preference')) {
        config.allow_all_tests = previous;
        elements.allowAllTests.checked = previous;
        return;
      }
      if (channel) {
        await window.__TAURI__.core.invoke('set_unity_allow_all_tests', {
          unityProjectPath: channel.unity_project_path,
          enabled: config.allow_all_tests
        });
      }
    } catch (error) {
      showToast('Preference saved, but the selected project test policy was not updated: ' + String(error), 'error');
    } finally {
      elements.allowAllTests.disabled = false;
    }
  });

  elements.applyConfigBtn.addEventListener('click', applyToClaudeCode);
  elements.applyCodexBtn.addEventListener('click', applyToCodex);
  elements.applyAntigravityBtn.addEventListener('click', applyToAntigravity);
  elements.applyOpenCodeBtn.addEventListener('click', applyToOpenCode);
  elements.disconnectBtn.addEventListener('click', disconnectFromClaude);
  elements.disconnectCodexBtn.addEventListener('click', disconnectFromCodex);
  elements.disconnectAntigravityBtn.addEventListener('click', disconnectFromAntigravity);
  elements.disconnectOpenCodeBtn.addEventListener('click', disconnectFromOpenCode);
  elements.installExtensionBtn.addEventListener('click', installExtension);

  elements.openDocsBtn.addEventListener('click', openDocumentation);
  elements.githubLink.addEventListener('click', function(event) {
    event.preventDefault();
    openDocumentation();
  });
}

async function chooseProjectFolder() {
  return await window.__TAURI__.dialog.open({
    directory: true,
    multiple: false,
    title: 'Select Unity Project Folder'
  });
}

async function chooseProjectForSetup() {
  try {
    const selected = await chooseProjectFolder();
    if (selected) await selectSetupProject(selected);
  } catch (error) {
    showToast('Could not open the project picker', 'error');
  }
}

async function selectSetupProject(path) {
  selectedProjectPath = String(path);
  elements.projectPath.value = selectedProjectPath;
  elements.discoveredProjects.value = discoveredProjects.some(function(project) {
    return samePath(project.path, selectedProjectPath);
  }) ? discoveredProjects.find(function(project) {
    return samePath(project.path, selectedProjectPath);
  }).path : '';
  await refreshOnboardingStatus();
  updateSetupStatus();
}

async function addProjectFromPicker() {
  try {
    const selected = await chooseProjectFolder();
    if (!selected) return;
    const channel = await window.__TAURI__.core.invoke('add_project', { projectPath: selected });
    const existing = config.channels.find(function(item) {
      return samePath(item.unity_project_path, channel.unity_project_path);
    });
    if (!existing) config.channels.push(channel);
    config.active_channel_id = existing ? existing.id : channel.id;
    await window.__TAURI__.core.invoke('save_config', { config: config });
    selectedProjectPath = channel.unity_project_path;
    elements.projectPath.value = selectedProjectPath;
    await refreshAll();
    showToast('Unity project added', 'success');
  } catch (error) {
    showToast(String(error), 'error');
  }
}

function renderDiscoveredProjects() {
  const currentValue = selectedProjectPath;
  elements.discoveredProjects.innerHTML = '<option value="">Recent Unity projects</option>';
  discoveredProjects.forEach(function(project) {
    const option = document.createElement('option');
    option.value = project.path;
    option.textContent = project.name + (project.unityVersion ? ' · ' + project.unityVersion : '');
    elements.discoveredProjects.appendChild(option);
  });
  const match = discoveredProjects.find(function(project) {
    return samePath(project.path, currentValue);
  });
  elements.discoveredProjects.value = match ? match.path : '';
}

async function refreshAll() {
  config = await window.__TAURI__.core.invoke('load_config');
  discoveredProjects = await window.__TAURI__.core.invoke('discover_unity_projects');
  renderDiscoveredProjects();
  await refreshOnboardingStatus();
  updateUI();
}

async function refreshOnboardingStatus() {
  onboarding = await window.__TAURI__.core.invoke('get_onboarding_status', {
    unityProjectPath: selectedProjectPath || null
  });
  await refreshFeedbackSettings();
  if (!clientSelectionInitialized) {
    const codex = getClientStatus('codex');
    const claude = getClientStatus('claude');
    const antigravity = getClientStatus('antigravity');
    const opencode = getClientStatus('opencode');
    elements.connectCodex.checked = Boolean(codex && (codex.detected || codex.configured));
    elements.connectClaude.checked = Boolean(claude && (claude.detected || claude.configured));
    elements.connectAntigravity.checked = Boolean(antigravity && (antigravity.detected || antigravity.configured));
    elements.connectOpenCode.checked = Boolean(opencode && (opencode.detected || opencode.configured));
    clientSelectionInitialized = true;
  }
}

function updateUI() {
  elements.automaticUpdates.checked = config.automatic_update_checks === true;
  elements.mcpServerPath.value = config.mcp_server_path || '';
  const toolGroups = config.tool_groups || 'core';
  let option = Array.from(elements.toolGroups.options).find(function(item) {
    return item.value === toolGroups;
  });
  if (!option) {
    option = document.createElement('option');
    option.value = toolGroups;
    option.textContent = 'Custom (' + toolGroups + ')';
    elements.toolGroups.appendChild(option);
  }
  elements.toolGroups.value = toolGroups;
  elements.autoConfig.checked = config.auto_start !== false;
  elements.customScripts.checked = config.enable_custom_scripts === true;
  elements.allowAllTests.checked = config.allow_all_tests !== false;
  renderProjects();
  updateSetupStatus();
}

function updateSetupStatus() {
  if (!onboarding) return;
  const runtime = onboarding.runtime;
  const project = onboarding.project;
  const codex = getClientStatus('codex');
  const claude = getClientStatus('claude');
  const antigravity = getClientStatus('antigravity');
  const opencode = getClientStatus('opencode');

  elements.runtimeBadge.textContent = runtime.ready
    ? (runtime.bundled ? 'Private Node 24 LTS' : 'System Node')
    : 'Runtime unavailable';
  elements.runtimeBadge.className = 'runtime-badge ' + (runtime.ready ? 'ready' : 'error');

  setCheck('runtime', runtime.ready ? 'success' : 'error', runtime.ready ? 'Ready' : 'Missing');
  setCheck('project', !selectedProjectPath ? 'pending' : (project?.valid ? 'success' : 'error'),
    !selectedProjectPath ? 'Not selected' : (project?.valid ? 'Valid' : 'Invalid'));

  const sdkProfile = project?.sdkProfile;
  let sdkState = 'pending';
  let sdkText = 'Not selected';
  if (selectedProjectPath && sdkProfile) {
    sdkState = sdkProfile.profile === 'unknown'
      ? 'error'
      : (sdkProfile.profile === 'none' ? 'warning' : 'success');
    sdkText = sdkProfile.label;
  }
  setCheck('sdk', sdkState, sdkText);

  let bridgeState = 'pending';
  let bridgeText = 'Not installed';
  if (project?.bridgeInstalled && !project.bridgeCurrent) {
    bridgeState = 'warning';
    bridgeText = 'Update available';
  } else if (project?.bridgeInstalled) {
    bridgeState = project.stateStatus === 'fresh' ? 'success' : 'warning';
    bridgeText = project.stateStatus === 'fresh' ? 'Connected' : 'Installed';
  }
  setCheck('bridge', bridgeState, bridgeText);
  updateClientStatus('codex', codex, elements.codexDetection, elements.codexState);
  updateClientStatus('claude', claude, elements.claudeDetection, elements.claudeState);
  updateClientStatus('antigravity', antigravity, elements.antigravityDetection, elements.antigravityState);
  updateClientStatus('opencode', opencode, elements.opencodeDetection, elements.opencodeState);

  const connected = project?.bridgeCurrent && project.stateStatus === 'fresh';
  const configured = project?.bridgeCurrent &&
    (codex?.configured || claude?.configured || antigravity?.configured || opencode?.configured);
  if (connected) {
    setHeaderStatus('active', 'Connected');
  } else if (configured) {
    setHeaderStatus('warning', 'Configured');
  } else if (selectedProjectPath) {
    setHeaderStatus('warning', 'Setup required');
  } else {
    setHeaderStatus('', 'Not configured');
  }
  updateSetupButton();
}

function updateClientStatus(id, status, detectionElement, stateElement) {
  detectionElement.textContent = status?.detected ? 'Detected' : 'Not detected';
  stateElement.textContent = status?.configured ? 'Configured' : 'Not configured';
  stateElement.className = 'client-state ' + (status?.configured ? 'configured' : '');
  setCheck(id, status?.configured ? 'success' : (status?.detected ? 'pending' : 'warning'),
    status?.configured ? 'Configured' : (status?.detected ? 'Detected' : 'Not found'));
}

function setCheck(name, state, text) {
  const row = document.querySelector('[data-check="' + name + '"]');
  if (!row) return;
  row.className = 'check-row ' + state;
  row.querySelector('strong').textContent = text;
}

function setHeaderStatus(state, text) {
  elements.status.className = 'status' + (state ? ' ' + state : '');
  elements.status.querySelector('.status-text').textContent = text;
}

function updateSetupButton() {
  const projectValid = Boolean(onboarding?.project?.valid);
  const runtimeReady = Boolean(onboarding?.runtime?.ready);
  const hasClient = elements.connectCodex.checked
    || elements.connectClaude.checked
    || elements.connectAntigravity.checked
    || elements.connectOpenCode.checked;
  elements.setupBtn.disabled = !projectValid || !runtimeReady || !hasClient;
}

async function runQuickSetup() {
  elements.setupBtn.disabled = true;
  elements.setupBtn.classList.add('working');
  elements.setupMessage.textContent = 'Installing bridge and configuring clients...';

  try {
    await window.__TAURI__.core.invoke('one_click_setup', {
      unityProjectPath: selectedProjectPath,
      configureCodex: elements.connectCodex.checked,
      configureClaude: elements.connectClaude.checked,
      configureAntigravity: elements.connectAntigravity.checked,
      configureOpencode: elements.connectOpenCode.checked,
      toolGroups: config.tool_groups || 'core',
      enableCustomScripts: config.enable_custom_scripts === true
    });
    await refreshAll();
    elements.setupMessage.textContent = 'Setup saved. Waiting for Unity bridge...';
    const connected = await waitForFreshBridge(30);
    elements.setupMessage.textContent = connected
      ? 'Setup complete. Restart the configured MCP client if it was already open.'
      : 'Setup complete. Open or return to Unity to finish the bridge connection.';
    showToast('Creator Works MCP setup completed', 'success');
  } catch (error) {
    elements.setupMessage.textContent = String(error);
    showToast('Setup failed', 'error');
  } finally {
    elements.setupBtn.classList.remove('working');
    updateSetupButton();
  }
}

async function waitForFreshBridge(maxSeconds) {
  for (let elapsed = 0; elapsed < maxSeconds; elapsed += 2) {
    await refreshOnboardingStatus();
    updateSetupStatus();
    if (onboarding?.project?.stateStatus === 'fresh') return true;
    await delay(2000);
  }
  return false;
}

function renderProjects() {
  elements.projectsList.querySelectorAll('.project-card').forEach(function(card) { card.remove(); });
  elements.emptyState.style.display = config.channels.length ? 'none' : 'flex';

  config.channels.forEach(function(channel) {
    const card = document.createElement('div');
    const active = channel.id === config.active_channel_id;
    card.className = 'project-card' + (active ? ' active' : '');
    card.innerHTML =
      '<span class="project-indicator"></span>' +
      '<div class="project-info"><strong>' + escapeHtml(channel.name) + '</strong>' +
      '<span>' + escapeHtml(channel.unity_project_path) + '</span></div>' +
      '<div class="project-meta">' + (active ? '<span class="badge active-badge">Active</span>' : '') +
      '<span class="badge sdk-badge">Checking SDK</span>' +
      '<span class="badge bridge-badge">Checking bridge</span></div>' +
      '<button class="icon-button remove-project" type="button" title="Remove project" aria-label="Remove project">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';

    card.addEventListener('click', async function(event) {
      if (!event.target.closest('.remove-project')) await selectChannel(channel.id);
    });
    card.querySelector('.remove-project').addEventListener('click', async function(event) {
      event.stopPropagation();
      await removeChannel(channel.id);
    });
    elements.projectsList.appendChild(card);
    updateBridgeBadge(channel, card.querySelector('.bridge-badge'));
    updateSdkBadge(channel, card.querySelector('.sdk-badge'));
  });
}

async function updateSdkBadge(channel, badge) {
  try {
    const profile = await window.__TAURI__.core.invoke('get_project_sdk_profile', {
      unityProjectPath: channel.unity_project_path
    });
    badge.textContent = profile.label;
    badge.className = 'badge sdk-badge sdk-' + profile.profile;
    const packageDetails = profile.packages
      .map(function(item) { return item.packageId + (item.version ? ' ' + item.version : ''); })
      .join('\n');
    badge.title = profile.error || [
      'Detected from Packages/manifest.json and packages-lock.json.',
      packageDetails,
      profile.profile === 'none' ? '' : 'Run the SDK validator in Unity to prove Editor-domain availability.'
    ].filter(Boolean).join('\n');
  } catch (error) {
    badge.textContent = 'SDK unavailable';
    badge.className = 'badge sdk-badge warning';
    badge.title = String(error);
  }
}

async function updateBridgeBadge(channel, badge) {
  try {
    const status = await window.__TAURI__.core.invoke('get_unity_extension_status', {
      unityProjectPath: channel.unity_project_path
    });
    if (status.current) {
      badge.textContent = 'Bridge current';
      badge.className = 'badge bridge-badge success';
    } else {
      badge.textContent = status.installed ? 'Update available' : 'Bridge missing';
      badge.className = 'badge bridge-badge warning';
    }
  } catch (error) {
    badge.textContent = 'Unavailable';
    badge.className = 'badge bridge-badge warning';
  }
}

async function updateConfiguredBridges() {
  elements.updateBridgesBtn.disabled = true;
  try {
    const summary = await window.__TAURI__.core.invoke('update_configured_unity_extensions');
    await refreshAll();
    if (summary.failed.length) {
      showToast('Updated ' + summary.updated + ' bridges; ' + summary.failed.length + ' failed', 'error');
    } else if (summary.updated) {
      showToast('Updated ' + summary.updated + ' Unity bridge' + (summary.updated === 1 ? '' : 's'), 'success');
    } else {
      showToast('All configured Unity bridges are current', 'success');
    }
  } catch (error) {
    showToast('Bridge update failed: ' + String(error), 'error');
  } finally {
    elements.updateBridgesBtn.disabled = false;
  }
}

async function selectChannel(channelId) {
  config.active_channel_id = channelId;
  const channel = getActiveChannel();
  if (channel) {
    selectedProjectPath = channel.unity_project_path;
    elements.projectPath.value = selectedProjectPath;
  }
  await window.__TAURI__.core.invoke('save_config', { config: config });
  if (elements.autoConfig.checked && channel) await updateConfiguredClients(channel);
  await refreshAll();
}

async function removeChannel(channelId) {
  config.channels = config.channels.filter(function(channel) { return channel.id !== channelId; });
  if (config.active_channel_id === channelId) {
    config.active_channel_id = config.channels[0]?.id || null;
  }
  await window.__TAURI__.core.invoke('save_config', { config: config });
  const active = getActiveChannel();
  selectedProjectPath = active?.unity_project_path || '';
  elements.projectPath.value = selectedProjectPath;
  await refreshAll();
  showToast('Project removed from launcher', 'success');
}

async function updateConfiguredClients(channel) {
  await refreshOnboardingStatus();
  const codex = getClientStatus('codex');
  const claude = getClientStatus('claude');
  const antigravity = getClientStatus('antigravity');
  const opencode = getClientStatus('opencode');
  if (codex?.configured) {
    await updateCodexConfig(channel);
  }
  if (claude?.configured) {
    await updateClaudeConfig(channel);
  }
  if (antigravity?.configured) {
    await updateAntigravityConfig(channel);
  }
  if (opencode?.configured) {
    await updateOpenCodeConfig(channel);
  }
}

async function updateCodexConfig(channel) {
  await window.__TAURI__.core.invoke('update_codex_mcp_config', {
    channel: channel,
    mcpServerPath: config.mcp_server_path,
    toolGroups: config.tool_groups || 'core'
  });
}

async function updateClaudeConfig(channel) {
  await window.__TAURI__.core.invoke('update_claude_mcp_config', {
    channel: channel,
    mcpServerPath: config.mcp_server_path,
    toolGroups: config.tool_groups || 'core'
  });
}

async function updateAntigravityConfig(channel) {
  await window.__TAURI__.core.invoke('update_antigravity_mcp_config', {
    channel: channel,
    mcpServerPath: config.mcp_server_path,
    toolGroups: config.tool_groups || 'core'
  });
}

async function updateOpenCodeConfig(channel) {
  await window.__TAURI__.core.invoke('update_opencode_mcp_config', {
    channel: channel,
    mcpServerPath: config.mcp_server_path,
    toolGroups: config.tool_groups || 'core'
  });
}

async function applyToCodex() {
  const channel = getActiveChannel();
  if (!channel) return showToast('No Unity project selected', 'error');
  try {
    await updateCodexConfig(channel);
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Applied to Codex', 'success');
  } catch (error) {
    showToast('Codex configuration failed: ' + String(error), 'error');
  }
}

async function applyToClaudeCode() {
  const channel = getActiveChannel();
  if (!channel) return showToast('No Unity project selected', 'error');
  try {
    await updateClaudeConfig(channel);
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Applied to Claude Code', 'success');
  } catch (error) {
    showToast('Claude configuration failed: ' + String(error), 'error');
  }
}

async function disconnectFromCodex() {
  try {
    await window.__TAURI__.core.invoke('remove_codex_mcp_config');
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Codex disconnected', 'success');
  } catch (error) {
    showToast('Could not disconnect Codex', 'error');
  }
}

async function disconnectFromClaude() {
  try {
    await window.__TAURI__.core.invoke('remove_claude_mcp_config');
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Claude Code disconnected', 'success');
  } catch (error) {
    showToast('Could not disconnect Claude Code', 'error');
  }
}

async function applyToAntigravity() {
  const channel = getActiveChannel();
  if (!channel) return showToast('No Unity project selected', 'error');
  try {
    await updateAntigravityConfig(channel);
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Applied to Antigravity', 'success');
  } catch (error) {
    showToast('Antigravity configuration failed: ' + String(error), 'error');
  }
}

async function applyToOpenCode() {
  const channel = getActiveChannel();
  if (!channel) return showToast('No Unity project selected', 'error');
  try {
    await updateOpenCodeConfig(channel);
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Applied to OpenCode', 'success');
  } catch (error) {
    showToast('OpenCode configuration failed: ' + String(error), 'error');
  }
}

async function disconnectFromAntigravity() {
  try {
    await window.__TAURI__.core.invoke('remove_antigravity_mcp_config');
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('Antigravity disconnected', 'success');
  } catch (error) {
    showToast('Could not disconnect Antigravity', 'error');
  }
}

async function disconnectFromOpenCode() {
  try {
    await window.__TAURI__.core.invoke('remove_opencode_mcp_config');
    await refreshOnboardingStatus();
    updateSetupStatus();
    showToast('OpenCode disconnected', 'success');
  } catch (error) {
    showToast('Could not disconnect OpenCode', 'error');
  }
}

async function installExtension() {
  const channel = getActiveChannel();
  if (!channel) return showToast('No Unity project selected', 'error');
  try {
    await window.__TAURI__.core.invoke('install_unity_extension', {
      unityProjectPath: channel.unity_project_path
    });
    await refreshOnboardingStatus();
    updateUI();
    showToast('Unity bridge updated', 'success');
  } catch (error) {
    showToast(String(error), 'error');
  }
}

async function saveLauncherConfig(errorMessage) {
  try {
    await window.__TAURI__.core.invoke('save_config', { config: config });
    return true;
  } catch (error) {
    showToast(errorMessage + ': ' + String(error), 'error');
    return false;
  }
}

async function openDocumentation() {
  try {
    await window.__TAURI__.shell.open('https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP');
  } catch (error) {
    showToast('Could not open documentation', 'error');
  }
}

function getActiveChannel() {
  return config.channels.find(function(channel) {
    return channel.id === config.active_channel_id;
  });
}

function getClientStatus(id) {
  return onboarding?.clients?.find(function(client) { return client.id === id; });
}

function samePath(left, right) {
  return String(left || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() ===
    String(right || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

async function refreshFeedbackSettings() {
  const request = ++feedbackRequest;
  const project = selectedProjectPath;
  elements.localFeedback.disabled = true;
  elements.usageCheckIns.disabled = true;
  elements.localFeedback.checked = false;
  elements.usageCheckIns.checked = false;
  try {
    if (!project) { elements.feedbackStatus.textContent = 'Select a Unity project. Local only; nothing is uploaded.'; return; }
    const settings = await window.__TAURI__.core.invoke('get_project_feedback_settings', { unityProjectPath: project });
    if (request !== feedbackRequest || project !== selectedProjectPath) return;
    elements.localFeedback.checked = settings.enabled;
    elements.localFeedback.disabled = false;
    elements.usageCheckIns.checked = settings.usageCheckIns;
    elements.usageCheckIns.disabled = !settings.enabled;
    elements.feedbackStatus.textContent = settings.enabled ? settings.file : 'Local only. Nothing is uploaded.';
  } catch (error) {
    if (request === feedbackRequest) elements.feedbackStatus.textContent = String(error);
  }
}

async function saveFeedbackSettings() {
  const project = selectedProjectPath;
  const enabled = elements.localFeedback.checked;
  const usageCheckIns = enabled && elements.usageCheckIns.checked;
  ++feedbackRequest;
  elements.localFeedback.disabled = true;
  elements.usageCheckIns.disabled = true;
  try {
    await window.__TAURI__.core.invoke('set_project_feedback_settings', { unityProjectPath: project, enabled, usageCheckIns });
  } catch (error) { showToast('Feedback preference was not saved: ' + String(error), 'error'); }
  await refreshFeedbackSettings();
}

function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  if (config.automatic_update_checks === true) {
    void checkForUpdates();
    updateTimer = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  }
}

async function checkForUpdates() {
  if (elements.checkUpdatesBtn.disabled) return;
  elements.checkUpdatesBtn.disabled = true;
  elements.openReleaseBtn.hidden = true;
  releaseUrl = null;
  elements.updateStatus.textContent = 'Checking GitHub...';
  try {
    const { checkStableUpdate } = await import('./updates.js');
    const version = document.getElementById('appVersion').textContent.trim();
    const result = await checkStableUpdate(version);
    if (result.available) {
      releaseUrl = result.url;
      elements.openReleaseBtn.hidden = false;
      elements.updateStatus.textContent = 'Version ' + result.version + ' is available. Save work before installing; update project bridges afterward.';
    } else elements.updateStatus.textContent = 'No newer stable release found.';
  } catch (error) { elements.updateStatus.textContent = 'Update check failed: ' + String(error); }
  finally { elements.checkUpdatesBtn.disabled = false; }
}

function delay(milliseconds) {
  return new Promise(function(resolve) { setTimeout(resolve, milliseconds); });
}

function showToast(message, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 4500);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
