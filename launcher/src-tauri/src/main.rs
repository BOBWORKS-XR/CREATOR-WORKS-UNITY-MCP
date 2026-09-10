// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod feedback;
mod hub;
mod jsonc;
mod lifecycle;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::path::BaseDirectory;
use tauri::Manager;

const LEGACY_SERVER_PATH: &str = "C:/tools/banter-mcp/dist/index.js";
const MCP_CLIENT_ID: &str = "creator-works";
const LEGACY_MCP_CLIENT_ID: &str = "banter";
const APP_CONFIG_DIR: &str = "creator-works-mcp";
const LEGACY_APP_CONFIG_DIR: &str = "banter-mcp";
const MCP_ROOT_ENV: &str = "CREATOR_WORKS_MCP_ROOT";
const LEGACY_MCP_ROOT_ENV: &str = "BANTWORKS_MCP_ROOT";
const TOOL_GROUPS_ENV: &str = "CREATOR_WORKS_TOOL_GROUPS";
const UNITY_BRIDGE_FILE_NAME: &str = "BanterMCPBridge.cs";
const UNITY_BRIDGE_LOGO_FILE_NAME: &str = "CreatorWorksMCPLogo.png";

/// A scene channel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectChannel {
    id: String,
    name: String,
    unity_project_path: String,
    scene_path: Option<String>,
    enabled: bool,
}

/// Full launcher configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherConfig {
    channels: Vec<ProjectChannel>,
    active_channel_id: Option<String>,
    #[serde(default)]
    mcp_server_path: String,
    auto_start: bool,
    #[serde(default)]
    enable_custom_scripts: bool,
    #[serde(default = "default_allow_all_tests")]
    allow_all_tests: bool,
    #[serde(default = "default_tool_groups")]
    tool_groups: String,
    #[serde(default)]
    automatic_update_checks: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredProject {
    name: String,
    path: String,
    unity_version: Option<String>,
    last_modified: Option<i64>,
    source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
    id: String,
    name: String,
    detected: bool,
    configured: bool,
    config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    ready: bool,
    bundled: bool,
    command: Option<String>,
    version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSetupStatus {
    valid: bool,
    bridge_installed: bool,
    bridge_current: bool,
    state_status: String,
    sdk_profile: SdkProfileStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnityExtensionStatus {
    installed: bool,
    current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SdkPackageStatus {
    package_id: String,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SdkProfileStatus {
    profile: String,
    label: String,
    creator_sdk: bool,
    legacy_banter: bool,
    packages: Vec<SdkPackageStatus>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeUpdateSummary {
    checked: usize,
    updated: usize,
    current: usize,
    failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingStatus {
    runtime: RuntimeStatus,
    clients: Vec<ClientStatus>,
    project: Option<ProjectSetupStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupResult {
    channel: ProjectChannel,
    bridge_installed: bool,
    codex_configured: bool,
    claude_configured: bool,
    antigravity_configured: bool,
    opencode_configured: bool,
    runtime_command: String,
}

fn default_allow_all_tests() -> bool {
    true
}

fn default_tool_groups() -> String {
    "core".to_string()
}

fn normalize_tool_groups(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(default_tool_groups());
    }
    if value == "all" {
        return Ok("all".to_string());
    }

    let mut entries: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    entries.sort_unstable();
    entries.dedup();

    if entries.is_empty() {
        return Err(
            "Tool groups must contain all, none, core, read, author, test, banter, or shadergraph"
                .to_string(),
        );
    }

    if entries.contains(&"all") || entries.contains(&"none") {
        if entries.len() != 1 {
            return Err("Tool groups cannot combine 'all' or 'none' with other groups".to_string());
        }
        return Ok(entries[0].to_string());
    }

    const KNOWN_GROUPS: [&str; 6] = ["core", "read", "author", "test", "banter", "shadergraph"];
    let unknown: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|entry| !KNOWN_GROUPS.contains(entry))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "Unknown tool groups: {}. Use all, none, core, read, author, test, banter, or shadergraph",
            unknown.join(", ")
        ));
    }

    Ok(KNOWN_GROUPS
        .iter()
        .copied()
        .filter(|group| entries.contains(group))
        .collect::<Vec<_>>()
        .join(","))
}

fn find_mcp_server_path(root: &Path) -> Option<PathBuf> {
    [
        root.join("creator-works-mcp.mjs"),
        root.join("release").join("creator-works-mcp.mjs"),
        root.join("banter-mcp.mjs"),
        root.join("release").join("banter-mcp.mjs"),
        root.join("dist").join("index.js"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn unity_bridge_path(root: &Path) -> PathBuf {
    root.join("unity-extension")
        .join("Editor")
        .join(UNITY_BRIDGE_FILE_NAME)
}

fn unity_bridge_logo_path(root: &Path) -> PathBuf {
    root.join("unity-extension")
        .join("Editor")
        .join(UNITY_BRIDGE_LOGO_FILE_NAME)
}

fn is_valid_mcp_root(root: &Path) -> bool {
    find_mcp_server_path(root).is_some()
        && unity_bridge_path(root).is_file()
        && unity_bridge_logo_path(root).is_file()
}

fn normalized_existing_path(path: PathBuf) -> PathBuf {
    let canonical = fs::canonicalize(&path).unwrap_or(path);
    let value = canonical.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    canonical
}

fn get_persistent_server_dir() -> Option<PathBuf> {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .map(|dir| dir.join(APP_CONFIG_DIR).join("server"))
}

fn is_ephemeral_path(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    path_str.contains("/tmp/.mount_")
        || path_str.contains("/.mount_")
        || path_str.starts_with("/tmp/")
        || path_str.starts_with("/var/tmp/")
}

fn sync_ephemeral_bundle(source_root: &Path) -> Option<PathBuf> {
    let dest_root = get_persistent_server_dir()?;
    let _ = fs::create_dir_all(&dest_root);
    let _ = fs::create_dir_all(dest_root.join("runtime"));
    let _ = fs::create_dir_all(dest_root.join("unity-extension").join("Editor"));

    let files_to_sync = [
        "creator-works-mcp.mjs",
        "banter-mcp.mjs",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "runtime/VERSION",
        "runtime/LICENSE",
        "unity-extension/Editor/BanterMCPBridge.cs",
        "unity-extension/Editor/CreatorWorksMCPLogo.png",
    ];

    for relative_file in files_to_sync {
        let src = source_root.join(relative_file);
        let dst = dest_root.join(relative_file);
        if src.is_file() {
            let _ = fs::copy(&src, &dst);
        }
    }

    let creator_bundle = dest_root.join("creator-works-mcp.mjs");
    let banter_bundle = dest_root.join("banter-mcp.mjs");
    if creator_bundle.is_file() && !banter_bundle.is_file() {
        let _ = fs::copy(&creator_bundle, &banter_bundle);
    } else if banter_bundle.is_file() && !creator_bundle.is_file() {
        let _ = fs::copy(&banter_bundle, &creator_bundle);
    }

    let binary_name = if cfg!(windows) { "node.exe" } else { "node" };
    let src_node = source_root.join("runtime").join(binary_name);
    let dst_node = dest_root.join("runtime").join(binary_name);
    if src_node.is_file() {
        let should_copy = if dst_node.is_file() {
            let src_len = fs::metadata(&src_node).map(|m| m.len()).unwrap_or(0);
            let dst_len = fs::metadata(&dst_node).map(|m| m.len()).unwrap_or(0);
            src_len != dst_len || src_len == 0
        } else {
            true
        };
        if should_copy {
            let _ = fs::copy(&src_node, &dst_node);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dst_node, fs::Permissions::from_mode(0o755));
        }
    }

    // Also mirror to legacy bantworks-mcp/server so existing configurations
    // referencing the former directory remain functional.
    if let Some(base) = dirs::data_local_dir().or_else(dirs::data_dir) {
        let legacy_dir = base.join("bantworks-mcp").join("server");
        if legacy_dir.is_dir() {
            let _ = fs::create_dir_all(legacy_dir.join("runtime"));
            let _ = fs::create_dir_all(legacy_dir.join("unity-extension").join("Editor"));
            for relative_file in files_to_sync {
                let src = dest_root.join(relative_file);
                let dst = legacy_dir.join(relative_file);
                if src.is_file() {
                    let _ = fs::copy(&src, &dst);
                }
            }
            let legacy_node = legacy_dir.join("runtime").join(binary_name);
            if dst_node.is_file() {
                let _ = fs::copy(&dst_node, &legacy_node);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&legacy_node, fs::Permissions::from_mode(0o755));
                }
            }
        }
    }

    if is_valid_mcp_root(&dest_root) {
        Some(dest_root)
    } else {
        None
    }
}

fn resolve_mcp_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some((variable, configured_root)) = std::env::var_os(MCP_ROOT_ENV)
        .map(|value| (MCP_ROOT_ENV, value))
        .or_else(|| std::env::var_os(LEGACY_MCP_ROOT_ENV).map(|value| (LEGACY_MCP_ROOT_ENV, value)))
    {
        let root = PathBuf::from(configured_root);
        if !is_valid_mcp_root(&root) {
            return Err(format!(
                "{} does not contain the MCP server and Unity bridge: {}",
                variable,
                root.display()
            ));
        }
        return Ok(normalized_existing_path(root));
    }

    for server_name in ["creator-works-mcp.mjs", "banter-mcp.mjs"] {
        if let Ok(resource_server) = app
            .path()
            .resolve(format!("server/{}", server_name), BaseDirectory::Resource)
        {
            if let Some(root) = resource_server.parent() {
                if is_valid_mcp_root(root) {
                    if is_ephemeral_path(root) {
                        if let Some(persistent_root) = sync_ephemeral_bundle(root) {
                            return Ok(normalized_existing_path(persistent_root));
                        }
                    } else {
                        return Ok(normalized_existing_path(root.to_path_buf()));
                    }
                }
            }
        }
    }

    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if is_valid_mcp_root(&source_root) {
        return Ok(normalized_existing_path(source_root));
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            for candidate in [executable_dir.join("server"), executable_dir.to_path_buf()] {
                if is_valid_mcp_root(&candidate) {
                    if is_ephemeral_path(&candidate) {
                        if let Some(persistent_root) = sync_ephemeral_bundle(&candidate) {
                            return Ok(normalized_existing_path(persistent_root));
                        }
                    } else {
                        return Ok(normalized_existing_path(candidate));
                    }
                }
            }
        }
    }

    if let Some(persistent_dir) = get_persistent_server_dir() {
        if is_valid_mcp_root(&persistent_dir) {
            return Ok(normalized_existing_path(persistent_dir));
        }
    }

    if let Some(base) = dirs::data_local_dir().or_else(dirs::data_dir) {
        for legacy_name in ["bantworks-mcp", "banter-mcp"] {
            let legacy_dir = base.join(legacy_name).join("server");
            if is_valid_mcp_root(&legacy_dir) {
                return Ok(normalized_existing_path(legacy_dir));
            }
        }
    }

    Err(format!(
        "Could not locate the bundled MCP server and Unity bridge. Reinstall Creator Works MCP or set {} to a valid distribution root.",
        MCP_ROOT_ENV
    ))
}

fn default_mcp_server_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_mcp_root(app)?;
    find_mcp_server_path(&root).ok_or_else(|| {
        format!(
            "MCP server bundle was not found under resolved root: {}",
            root.display()
        )
    })
}

fn bundled_node_path(root: &Path) -> PathBuf {
    let binary_name = if cfg!(windows) { "node.exe" } else { "node" };
    root.join("runtime").join(binary_name)
}

fn find_command_on_path(command: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    let candidates = if cfg!(windows) {
        vec![
            format!("{}.exe", command),
            format!("{}.cmd", command),
            command.to_string(),
        ]
    } else {
        vec![command.to_string()]
    };

    env::split_paths(&path).find_map(|directory| {
        candidates
            .iter()
            .map(|candidate| directory.join(candidate))
            .find(|candidate| candidate.is_file())
    })
}

fn resolve_node_command(app: &tauri::AppHandle) -> Result<(PathBuf, bool), String> {
    let root = resolve_mcp_root(app)?;
    let bundled = [
        bundled_node_path(&root),
        root.join("release")
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" }),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file());
    if let Some(bundled) = bundled {
        return Ok((normalized_existing_path(bundled), true));
    }

    find_command_on_path("node")
        .map(|path| (normalized_existing_path(path), false))
        .ok_or_else(|| {
            "The bundled Node runtime is missing and Node.js was not found on PATH. Reinstall Creator Works MCP."
                .to_string()
        })
}

fn is_legacy_server_path(value: &str) -> bool {
    value
        .replace('\\', "/")
        .eq_ignore_ascii_case(LEGACY_SERVER_PATH)
}

fn is_legacy_server_bundle_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("banter-mcp.mjs"))
        .unwrap_or(false)
}

fn validate_mcp_server_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("MCP server path is required".to_string());
    }

    let path = PathBuf::from(value);
    if !path.is_file() {
        return Err(format!(
            "MCP server file does not exist: {}",
            path.display()
        ));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !matches!(
        extension.to_ascii_lowercase().as_str(),
        "js" | "mjs" | "cjs"
    ) {
        return Err("MCP server path must point to a .js, .mjs, or .cjs file".to_string());
    }

    Ok(normalized_existing_path(path))
}

fn config_path_for(directory_name: &str) -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(directory_name)
        .join("launcher-config.json")
}

/// Get the current config path, retaining read migration from the former product name.
fn get_config_path() -> PathBuf {
    let config_path = config_path_for(APP_CONFIG_DIR);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    config_path
}

fn get_legacy_config_path() -> PathBuf {
    config_path_for(LEGACY_APP_CONFIG_DIR)
}

fn upgrade_loaded_config(
    config: &mut LauncherConfig,
    replacement_server_path: Option<&Path>,
) -> Result<bool, String> {
    let mut changed = false;

    if let Some(path) = replacement_server_path {
        let replacement = path.to_string_lossy().to_string();
        if config.mcp_server_path != replacement {
            config.mcp_server_path = replacement;
            changed = true;
        }
    }

    let normalized_tool_groups = normalize_tool_groups(&config.tool_groups)?;
    if config.tool_groups != normalized_tool_groups {
        config.tool_groups = normalized_tool_groups;
        changed = true;
    }

    Ok(changed)
}

/// Write a text file by publishing a complete temporary file in the same directory.
/// This prevents launcher/config readers from observing truncated JSON or TOML.
fn publish_temporary_file(temporary_path: &Path, destination: &Path) -> std::io::Result<()> {
    if !destination.exists() {
        return fs::rename(temporary_path, destination);
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

        let destination_wide: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let temporary_wide: Vec<u16> = temporary_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // Both paths remain valid, null-terminated UTF-16 buffers for the duration of the call.
        let replaced = unsafe {
            ReplaceFileW(
                destination_wide.as_ptr(),
                temporary_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if replaced != 0 {
            return Ok(());
        }

        let replace_error = std::io::Error::last_os_error();
        if !destination.exists() {
            return fs::rename(temporary_path, destination);
        }
        Err(replace_error)
    }

    #[cfg(not(windows))]
    {
        fs::rename(temporary_path, destination)
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Path has no file name: {}", path.display()))?;
    let temporary_path = parent.join(format!(".{}.{}.tmp", file_name, uuid::Uuid::new_v4()));

    fs::write(&temporary_path, content).map_err(|e| {
        format!(
            "Failed to write temporary file {}: {}",
            temporary_path.display(),
            e
        )
    })?;

    match publish_temporary_file(&temporary_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(format!("Failed to publish {}: {}", path.display(), error))
        }
    }
}

/// Load configuration from disk
#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<LauncherConfig, String> {
    let config_path = get_config_path();
    let legacy_config_path = get_legacy_config_path();
    let source_path = if config_path.exists() {
        Some(config_path.clone())
    } else if legacy_config_path.exists() {
        Some(legacy_config_path)
    } else {
        None
    };

    if let Some(source_path) = source_path {
        let content = fs::read_to_string(&source_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let mut config: LauncherConfig =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
        let needs_server_migration = config.mcp_server_path.trim().is_empty()
            || is_legacy_server_path(&config.mcp_server_path)
            || is_legacy_server_bundle_path(&config.mcp_server_path)
            || !Path::new(&config.mcp_server_path).is_file()
            || is_ephemeral_path(Path::new(&config.mcp_server_path));
        let replacement_server_path = if needs_server_migration {
            Some(default_mcp_server_path(&app)?)
        } else {
            None
        };
        let config_changed =
            upgrade_loaded_config(&mut config, replacement_server_path.as_deref())?;
        if source_path != config_path || config_changed {
            let migrated = serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Failed to migrate launcher config: {}", e))?;
            atomic_write(&config_path, &migrated)?;
        }
        Ok(config)
    } else {
        Ok(LauncherConfig {
            channels: vec![],
            active_channel_id: None,
            mcp_server_path: default_mcp_server_path(&app)?.to_string_lossy().to_string(),
            auto_start: false,
            enable_custom_scripts: false,
            allow_all_tests: true,
            tool_groups: default_tool_groups(),
            automatic_update_checks: false,
        })
    }
}

/// Save configuration to disk
#[tauri::command]
fn save_config(mut config: LauncherConfig) -> Result<(), String> {
    let config_path = get_config_path();
    config.mcp_server_path = validate_mcp_server_path(&config.mcp_server_path)?
        .to_string_lossy()
        .to_string();
    config.tool_groups = normalize_tool_groups(&config.tool_groups)?;
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    atomic_write(&config_path, &content)
}

/// Add a new scene channel
#[tauri::command]
fn add_channel(name: String, scene_path: String) -> Result<ProjectChannel, String> {
    let scene_file = PathBuf::from(&scene_path);

    if !scene_file.exists() {
        return Err(format!("Scene file does not exist: {}", scene_path));
    }

    // Validate it's a .unity file
    if scene_file.extension().map(|e| e.to_str().unwrap_or("")) != Some("unity") {
        return Err("Not a valid Unity scene file (must be .unity)".to_string());
    }

    // Extract project path from scene path (go up to find Assets folder)
    let mut project_path: Option<PathBuf> = None;
    let mut current = scene_file.parent();

    while let Some(dir) = current {
        if dir.file_name().map(|n| n.to_str().unwrap_or("")) == Some("Assets") {
            project_path = dir.parent().map(|p| p.to_path_buf());
            break;
        }
        current = dir.parent();
    }

    let unity_project_path = project_path
        .ok_or("Could not find Unity project root (no Assets folder in path)")?
        .to_string_lossy()
        .to_string();

    let channel = ProjectChannel {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        unity_project_path,
        scene_path: Some(scene_path),
        enabled: true,
    };

    Ok(channel)
}

fn is_valid_unity_project(path: &Path) -> bool {
    path.is_dir() && path.join("Assets").is_dir() && path.join("ProjectSettings").is_dir()
}

fn project_path_key(path: &Path) -> String {
    normalized_existing_path(path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn channel_for_project(project_path: &Path) -> Result<ProjectChannel, String> {
    if !is_valid_unity_project(project_path) {
        return Err(format!(
            "Not a Unity project (Assets and ProjectSettings folders are required): {}",
            project_path.display()
        ));
    }

    let project_path = normalized_existing_path(project_path.to_path_buf());
    let name = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Unity Project")
        .to_string();

    Ok(ProjectChannel {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        unity_project_path: project_path.to_string_lossy().to_string(),
        scene_path: None,
        enabled: true,
    })
}

#[tauri::command]
fn add_project(project_path: String) -> Result<ProjectChannel, String> {
    channel_for_project(Path::new(&project_path))
}

fn projects_from_unity_hub(path: &Path) -> Vec<DiscoveredProject> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(data) = root.get("data").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };

    data.values()
        .filter_map(|entry| {
            let project_path = entry.get("path")?.as_str()?;
            let project_path = PathBuf::from(project_path);
            if !is_valid_unity_project(&project_path) {
                return None;
            }

            let project_path = normalized_existing_path(project_path);
            let name = entry
                .get("title")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    project_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| "Unity Project".to_string());

            Some(DiscoveredProject {
                name,
                path: project_path.to_string_lossy().to_string(),
                unity_version: entry
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string),
                last_modified: entry
                    .get("lastModified")
                    .and_then(serde_json::Value::as_i64),
                source: "Unity Hub".to_string(),
            })
        })
        .collect()
}

#[tauri::command]
fn discover_unity_projects(app: tauri::AppHandle) -> Result<Vec<DiscoveredProject>, String> {
    let config = load_config(app)?;
    let mut projects = Vec::new();
    let mut seen = HashSet::new();

    for channel in config.channels {
        let path = PathBuf::from(&channel.unity_project_path);
        if !is_valid_unity_project(&path) || !seen.insert(project_path_key(&path)) {
            continue;
        }
        projects.push(DiscoveredProject {
            name: channel.name,
            path: normalized_existing_path(path).to_string_lossy().to_string(),
            unity_version: None,
            last_modified: None,
            source: "Creator Works MCP".to_string(),
        });
    }

    if let Some(config_dir) = dirs::config_dir() {
        let hub_projects = config_dir.join("UnityHub").join("projects-v1.json");
        for project in projects_from_unity_hub(&hub_projects) {
            if seen.insert(project_path_key(Path::new(&project.path))) {
                projects.push(project);
            }
        }
    }

    projects.sort_by(|left, right| {
        right
            .last_modified
            .unwrap_or_default()
            .cmp(&left.last_modified.unwrap_or_default())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(projects)
}

/// Validate a Unity scene file path
#[tauri::command]
fn validate_unity_scene(path: String) -> Result<bool, String> {
    let scene_path = PathBuf::from(&path);

    if !scene_path.exists() {
        return Ok(false);
    }

    // Check if it's a .unity file
    if scene_path.extension().map(|e| e.to_str().unwrap_or("")) != Some("unity") {
        return Ok(false);
    }

    // Check if it's inside an Assets folder (valid Unity project structure)
    let path_str = path.replace("\\", "/");
    Ok(path_str.contains("/Assets/"))
}

/// Get Claude Code config path
fn get_claude_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude.json")
}

/// Get Codex config path
fn get_codex_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("config.toml")
}

/// Get Antigravity MCP config path (`~/.gemini/config/mcp_config.json`)
/// Used by Antigravity IDE and Antigravity CLI; the global location lives
/// under `~/.gemini/config` regardless of the host OS.
fn get_antigravity_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".gemini")
        .join("config")
        .join("mcp_config.json")
}

/// Get OpenCode MCP config path (`~/.config/opencode/opencode.jsonc` on
/// Linux, `~/Library/Application Support/opencode/opencode.jsonc` on macOS,
/// `%APPDATA%\opencode\opencode.jsonc` on Windows — `dirs::config_dir()`
/// resolves those consistently).
fn get_opencode_config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("opencode")
        .join("opencode.jsonc")
}

/// Read current Claude Code MCP configuration
#[tauri::command]
fn get_claude_mcp_config() -> Result<serde_json::Value, String> {
    let config_path = get_claude_config_path();

    if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read Claude config: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse Claude config: {}", e))
    } else {
        Ok(serde_json::json!({}))
    }
}

fn build_claude_mcp_config(
    mut config: serde_json::Value,
    channel: &ProjectChannel,
    node_command: &str,
    mcp_server_path: &str,
    tool_groups: &str,
) -> Result<serde_json::Value, String> {
    if !config.is_object() {
        return Err("Claude config root must be a JSON object".to_string());
    }
    if config.get("mcpServers").is_none() {
        config["mcpServers"] = serde_json::json!({});
    } else if !config["mcpServers"].is_object() {
        return Err("Claude config mcpServers must be a JSON object".to_string());
    }

    if let Some(servers) = config["mcpServers"].as_object_mut() {
        servers.remove(MCP_CLIENT_ID);
        servers.remove(LEGACY_MCP_CLIENT_ID);
    }

    let mut env = serde_json::json!({
        "UNITY_PROJECT_PATH": channel.unity_project_path,
        TOOL_GROUPS_ENV: normalize_tool_groups(tool_groups)?
    });
    if let Some(scene) = &channel.scene_path {
        env["UNITY_SCENE_PATH"] = serde_json::json!(scene);
    }

    config["mcpServers"][MCP_CLIENT_ID] = serde_json::json!({
        "command": node_command,
        "args": [mcp_server_path],
        "env": env
    });
    Ok(config)
}

/// Update Claude Code MCP configuration for a channel
#[tauri::command]
fn update_claude_mcp_config(
    app: tauri::AppHandle,
    channel: ProjectChannel,
    mcp_server_path: String,
    tool_groups: String,
) -> Result<(), String> {
    let config_path = get_claude_config_path();
    let mcp_server_path = validate_mcp_server_path(&mcp_server_path)?
        .to_string_lossy()
        .to_string();
    let tool_groups = normalize_tool_groups(&tool_groups)?;

    let config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read Claude config: {}", e))?;
        serde_json::from_str(&content).map_err(|e| {
            format!(
                "Failed to parse Claude config; refusing to overwrite it: {}",
                e
            )
        })?
    } else {
        serde_json::json!({})
    };

    let node_command = resolve_node_command(&app)?.0.to_string_lossy().to_string();
    let config = build_claude_mcp_config(
        config,
        &channel,
        &node_command,
        &mcp_server_path,
        &tool_groups,
    )?;

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize Claude config: {}", e))?;

    atomic_write(&config_path, &content)
}

fn build_codex_mcp_config(
    existing: &str,
    channel: &ProjectChannel,
    node_command: &str,
    mcp_server_path: &str,
    tool_groups: &str,
) -> Result<String, String> {
    let tool_groups = normalize_tool_groups(tool_groups)?;
    let mut content = remove_client_mcp_tables(existing, MCP_CLIENT_ID);
    content = remove_client_mcp_tables(&content, LEGACY_MCP_CLIENT_ID);

    if !content.ends_with('\n') && !content.is_empty() {
        content.push('\n');
    }

    content.push_str(&format!("\n[mcp_servers.{}]\n", MCP_CLIENT_ID));
    content.push_str(&format!(
        "command = \"{}\"\n",
        escape_toml_string(&node_command.replace("\\", "/"))
    ));
    content.push_str(&format!(
        "args = [\"{}\"]\n",
        escape_toml_string(mcp_server_path)
    ));
    content.push_str("startup_timeout_sec = 20\n");
    content.push_str("tool_timeout_sec = 600\n");
    content.push_str(&format!("\n[mcp_servers.{}.env]\n", MCP_CLIENT_ID));
    content.push_str(&format!(
        "UNITY_PROJECT_PATH = \"{}\"\n",
        escape_toml_string(&channel.unity_project_path.replace("\\", "/"))
    ));
    content.push_str(&format!(
        "{} = \"{}\"\n",
        TOOL_GROUPS_ENV,
        escape_toml_string(&tool_groups)
    ));
    if let Some(scene) = &channel.scene_path {
        content.push_str(&format!(
            "UNITY_SCENE_PATH = \"{}\"\n",
            escape_toml_string(&scene.replace("\\", "/"))
        ));
    }
    Ok(content)
}

/// Remove Creator Works MCP and its former Banter entry from Claude config.
#[tauri::command]
fn remove_claude_mcp_config() -> Result<(), String> {
    let config_path = get_claude_config_path();

    if !config_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Claude config: {}", e))?;

    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Claude config: {}", e))?;

    if let Some(servers) = config.get_mut("mcpServers") {
        if let Some(obj) = servers.as_object_mut() {
            obj.remove(MCP_CLIENT_ID);
            obj.remove(LEGACY_MCP_CLIENT_ID);
        }
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize Claude config: {}", e))?;

    atomic_write(&config_path, &content)
}

/// Update Codex MCP configuration for a channel
#[tauri::command]
fn update_codex_mcp_config(
    app: tauri::AppHandle,
    channel: ProjectChannel,
    mcp_server_path: String,
    tool_groups: String,
) -> Result<(), String> {
    let config_path = get_codex_config_path();
    let mcp_server_path = validate_mcp_server_path(&mcp_server_path)?
        .to_string_lossy()
        .to_string();

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Codex config directory: {}", e))?;
    }

    let existing = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read Codex config: {}", e))?
    } else {
        String::new()
    };

    let node_command = resolve_node_command(&app)?.0.to_string_lossy().to_string();
    let content = build_codex_mcp_config(
        &existing,
        &channel,
        &node_command,
        &mcp_server_path,
        &tool_groups,
    )?;

    atomic_write(&config_path, &content)
}

/// Remove Creator Works MCP and its former Banter entry from Codex config.
#[tauri::command]
fn remove_codex_mcp_config() -> Result<(), String> {
    let config_path = get_codex_config_path();

    if !config_path.exists() {
        return Ok(());
    }

    let existing = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Codex config: {}", e))?;
    let content = remove_client_mcp_tables(
        &remove_client_mcp_tables(&existing, MCP_CLIENT_ID),
        LEGACY_MCP_CLIENT_ID,
    );

    atomic_write(&config_path, &content)
}

/// Read the current Antigravity MCP configuration (returns an empty object if
/// the file is missing or unreadable, matching the Claude Code handler).
#[tauri::command]
fn get_antigravity_mcp_config() -> Result<serde_json::Value, String> {
    let config_path = get_antigravity_config_path();

    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Antigravity config: {}", e))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse Antigravity config: {}", e))
}

fn build_antigravity_mcp_config(
    mut config: serde_json::Value,
    channel: &ProjectChannel,
    node_command: &str,
    mcp_server_path: &str,
    tool_groups: &str,
) -> Result<serde_json::Value, String> {
    if !config.is_object() {
        return Err("Antigravity config root must be a JSON object".to_string());
    }
    if config.get("mcpServers").is_none() {
        config["mcpServers"] = serde_json::json!({});
    } else if !config["mcpServers"].is_object() {
        return Err("Antigravity config mcpServers must be a JSON object".to_string());
    }

    let mut env = serde_json::json!({
        "UNITY_PROJECT_PATH": channel.unity_project_path,
        TOOL_GROUPS_ENV: normalize_tool_groups(tool_groups)?
    });
    if let Some(scene) = &channel.scene_path {
        env["UNITY_SCENE_PATH"] = serde_json::json!(scene);
    }

    if let Some(servers) = config["mcpServers"].as_object_mut() {
        servers.remove(LEGACY_MCP_CLIENT_ID);
    }
    config["mcpServers"][MCP_CLIENT_ID] = serde_json::json!({
        "command": node_command,
        "args": [mcp_server_path],
        "env": env
    });
    Ok(config)
}

#[tauri::command]
fn update_antigravity_mcp_config(
    app: tauri::AppHandle,
    channel: ProjectChannel,
    mcp_server_path: String,
    tool_groups: String,
) -> Result<(), String> {
    let config_path = get_antigravity_config_path();
    let mcp_server_path = validate_mcp_server_path(&mcp_server_path)?
        .to_string_lossy()
        .to_string();
    let tool_groups = normalize_tool_groups(&tool_groups)?;

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Antigravity config directory: {}", e))?;
    }

    let config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read Antigravity config: {}", e))?;
        if content.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&content).map_err(|e| {
                format!(
                    "Failed to parse Antigravity config; refusing to overwrite it: {}",
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let node_command = resolve_node_command(&app)?.0.to_string_lossy().to_string();
    let config = build_antigravity_mcp_config(
        config,
        &channel,
        &node_command,
        &mcp_server_path,
        &tool_groups,
    )?;

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize Antigravity config: {}", e))?;

    atomic_write(&config_path, &content)
}

#[tauri::command]
fn remove_antigravity_mcp_config() -> Result<(), String> {
    let config_path = get_antigravity_config_path();

    if !config_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Antigravity config: {}", e))?;
    if content.trim().is_empty() {
        return Ok(());
    }
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Antigravity config: {}", e))?;

    if let Some(servers) = config.get_mut("mcpServers") {
        if let Some(obj) = servers.as_object_mut() {
            obj.remove(MCP_CLIENT_ID);
            obj.remove(LEGACY_MCP_CLIENT_ID);
        }
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize Antigravity config: {}", e))?;

    atomic_write(&config_path, &content)
}

/// Read the current OpenCode MCP configuration. OpenCode stores its config
/// as JSONC (JSON with comments) at `~/.config/opencode/opencode.jsonc`, so
/// we strip line comments before parsing.
#[tauri::command]
fn get_opencode_mcp_config() -> Result<serde_json::Value, String> {
    let config_path = get_opencode_config_path();
    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read OpenCode config: {}", e))?;
    parse_opencode_config(&content)
}

fn parse_opencode_config(content: &str) -> Result<serde_json::Value, String> {
    jsonc::parse(content).map_err(|e| format!("Failed to parse OpenCode config: {}", e))
}
fn build_opencode_mcp_config(
    mut config: serde_json::Value,
    channel: &ProjectChannel,
    node_command: &str,
    mcp_server_path: &str,
    tool_groups: &str,
) -> Result<serde_json::Value, String> {
    if !config.is_object() {
        return Err("OpenCode config root must be a JSON object".to_string());
    }
    if config.get("mcp").is_none() {
        config["mcp"] = serde_json::json!({});
    } else if !config["mcp"].is_object() {
        return Err("OpenCode config 'mcp' must be a JSON object".to_string());
    }

    let mut environment = serde_json::json!({
        "UNITY_PROJECT_PATH": channel.unity_project_path,
        TOOL_GROUPS_ENV: normalize_tool_groups(tool_groups)?
    });
    if let Some(scene) = &channel.scene_path {
        environment["UNITY_SCENE_PATH"] = serde_json::json!(scene);
    }

    if let Some(mcp) = config["mcp"].as_object_mut() {
        mcp.remove(LEGACY_MCP_CLIENT_ID);
    }
    config["mcp"][MCP_CLIENT_ID] = serde_json::json!({
        "type": "local",
        "command": [node_command, mcp_server_path],
        "enabled": true,
        "environment": environment,
    });
    Ok(config)
}

#[tauri::command]
fn update_opencode_mcp_config(
    app: tauri::AppHandle,
    channel: ProjectChannel,
    mcp_server_path: String,
    tool_groups: String,
) -> Result<(), String> {
    let config_path = get_opencode_config_path();
    let mcp_server_path = validate_mcp_server_path(&mcp_server_path)?
        .to_string_lossy()
        .to_string();
    let tool_groups = normalize_tool_groups(&tool_groups)?;

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create OpenCode config directory: {}", e))?;
    }

    let content = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read OpenCode config: {}", e))?;
        parse_opencode_config(&content)?;
        content
    } else {
        "{}".to_string()
    };

    let node_command = resolve_node_command(&app)?.0.to_string_lossy().to_string();
    let config = build_opencode_mcp_config(
        serde_json::json!({ "mcp": {} }),
        &channel,
        &node_command,
        &mcp_server_path,
        &tool_groups,
    )?;
    let entry = config["mcp"][MCP_CLIENT_ID].clone();
    let content =
        jsonc::update_managed_entry(&content, "mcp", MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID, &entry)
            .map_err(|e| format!("Failed to update OpenCode config: {}", e))?;

    atomic_write(&config_path, &content)
}

#[tauri::command]
fn remove_opencode_mcp_config() -> Result<(), String> {
    let config_path = get_opencode_config_path();
    if !config_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read OpenCode config: {}", e))?;
    let content =
        jsonc::remove_managed_entries(&content, "mcp", MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID)
            .map_err(|e| format!("Failed to update OpenCode config: {}", e))?;
    atomic_write(&config_path, &content)
}

fn remove_toml_table_block(content: &str, table_name: &str) -> String {
    let target = format!("[{}]", table_name);
    let mut output = Vec::new();
    let mut skipping = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == target {
            skipping = true;
            continue;
        }

        if skipping && trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping = false;
        }

        if !skipping {
            output.push(line);
        }
    }

    let mut result = output.join("\n");
    if content.ends_with('\n') && !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

fn remove_client_mcp_tables(content: &str, client_id: &str) -> String {
    let without_server = remove_toml_table_block(content, &format!("mcp_servers.{}", client_id));
    remove_toml_table_block(&without_server, &format!("mcp_servers.{}.env", client_id))
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Check if Unity extension is installed in a project
#[tauri::command]
fn check_unity_extension(unity_project_path: String) -> Result<bool, String> {
    let extension_path = unity_bridge_destination(Path::new(&unity_project_path));

    Ok(extension_path.exists())
}

fn unity_bridge_destination(project_path: &Path) -> PathBuf {
    project_path
        .join("Assets")
        .join("Editor")
        .join(UNITY_BRIDGE_FILE_NAME)
}

fn unity_bridge_logo_destination(project_path: &Path) -> PathBuf {
    project_path
        .join("Assets")
        .join("Editor")
        .join(UNITY_BRIDGE_LOGO_FILE_NAME)
}

fn files_match(source: &Path, destination: &Path) -> bool {
    fs::read(source)
        .and_then(|source_bytes| {
            fs::read(destination).map(|destination_bytes| source_bytes == destination_bytes)
        })
        .unwrap_or(false)
}

fn unity_extension_status(source: &Path, project_path: &Path) -> UnityExtensionStatus {
    let destination = unity_bridge_destination(project_path);
    let logo_source = source
        .parent()
        .map(|parent| parent.join(UNITY_BRIDGE_LOGO_FILE_NAME));
    let logo_destination = unity_bridge_logo_destination(project_path);
    let installed = destination.is_file();
    let current = installed
        && files_match(source, &destination)
        && logo_source
            .as_deref()
            .map(|logo| files_match(logo, &logo_destination))
            .unwrap_or(false);
    UnityExtensionStatus { installed, current }
}

#[tauri::command]
fn get_unity_extension_status(
    app: tauri::AppHandle,
    unity_project_path: String,
) -> Result<UnityExtensionStatus, String> {
    let source = unity_bridge_path(&resolve_mcp_root(&app)?);
    Ok(unity_extension_status(
        &source,
        Path::new(&unity_project_path),
    ))
}

/// Install Unity extension to a project
#[tauri::command]
fn install_unity_extension(
    app: tauri::AppHandle,
    unity_project_path: String,
) -> Result<(), String> {
    let root = resolve_mcp_root(&app)?;
    let source = unity_bridge_path(&root);
    let logo_source = unity_bridge_logo_path(&root);

    let dest_dir = PathBuf::from(&unity_project_path)
        .join("Assets")
        .join("Editor");

    let dest = dest_dir.join(UNITY_BRIDGE_FILE_NAME);
    let logo_dest = dest_dir.join(UNITY_BRIDGE_LOGO_FILE_NAME);

    if !source.exists() {
        return Err(format!(
            "Unity bridge source was not found: {}",
            source.display()
        ));
    }
    if !logo_source.exists() {
        return Err(format!(
            "Unity bridge logo was not found: {}",
            logo_source.display()
        ));
    }

    if !PathBuf::from(&unity_project_path).join("Assets").is_dir() {
        return Err(format!(
            "Not a Unity project (Assets folder not found): {}",
            unity_project_path
        ));
    }

    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create Editor directory: {}", e))?;

    if dest.exists() {
        let backup_dir = PathBuf::from(&unity_project_path)
            .join(".bantworks-mcp")
            .join("backups");
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("Failed to create bridge backup directory: {}", e))?;
        let backup = backup_dir.join(format!("BanterMCPBridge-{}.cs", uuid::Uuid::new_v4()));
        fs::copy(&dest, &backup)
            .map_err(|e| format!("Failed to back up existing Unity bridge: {}", e))?;
    }

    let temporary_dest = dest_dir.join(format!(".BanterMCPBridge-{}.tmp", uuid::Uuid::new_v4()));
    let temporary_logo_dest =
        dest_dir.join(format!(".CreatorWorksMCPLogo-{}.tmp", uuid::Uuid::new_v4()));
    fs::copy(&source, &temporary_dest)
        .map_err(|e| format!("Failed to stage Unity bridge: {}", e))?;
    if let Err(error) = fs::copy(&logo_source, &temporary_logo_dest) {
        let _ = fs::remove_file(&temporary_dest);
        return Err(format!("Failed to stage Unity bridge logo: {}", error));
    }
    publish_temporary_file(&temporary_logo_dest, &logo_dest).map_err(|e| {
        let _ = fs::remove_file(&temporary_dest);
        let _ = fs::remove_file(&temporary_logo_dest);
        format!("Failed to install Unity bridge logo: {}", e)
    })?;
    publish_temporary_file(&temporary_dest, &dest).map_err(|e| {
        let _ = fs::remove_file(&temporary_dest);
        format!("Failed to install Unity bridge: {}", e)
    })?;

    Ok(())
}

#[tauri::command]
fn update_configured_unity_extensions(
    app: tauri::AppHandle,
) -> Result<BridgeUpdateSummary, String> {
    let config = load_config(app.clone())?;
    let source = unity_bridge_path(&resolve_mcp_root(&app)?);
    let mut summary = BridgeUpdateSummary {
        checked: 0,
        updated: 0,
        current: 0,
        failed: Vec::new(),
    };
    let mut seen = HashSet::new();

    for channel in config.channels {
        let project_path = PathBuf::from(&channel.unity_project_path);
        if !is_valid_unity_project(&project_path) || !seen.insert(project_path_key(&project_path)) {
            continue;
        }

        summary.checked += 1;
        if unity_extension_status(&source, &project_path).current {
            summary.current += 1;
            continue;
        }

        match install_unity_extension(app.clone(), channel.unity_project_path.clone()) {
            Ok(()) => summary.updated += 1,
            Err(error) => summary.failed.push(format!("{}: {}", channel.name, error)),
        }
    }

    Ok(summary)
}

/// Get the MCP root directory
#[tauri::command]
fn get_mcp_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(resolve_mcp_root(&app)?.to_string_lossy().to_string())
}

fn command_is_available(command: &str) -> bool {
    find_command_on_path(command).is_some()
}

fn codex_is_configured() -> bool {
    fs::read_to_string(get_codex_config_path())
        .map(|content| {
            content.lines().any(|line| {
                let line = line.trim();
                line == format!("[mcp_servers.{}]", MCP_CLIENT_ID)
                    || line == format!("[mcp_servers.{}]", LEGACY_MCP_CLIENT_ID)
            })
        })
        .unwrap_or(false)
}

fn claude_is_configured() -> bool {
    fs::read_to_string(get_claude_config_path())
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|config| {
            let servers = config.get("mcpServers")?;
            servers
                .get(MCP_CLIENT_ID)
                .or_else(|| servers.get(LEGACY_MCP_CLIENT_ID))
                .cloned()
        })
        .is_some()
}

fn antigravity_is_configured() -> bool {
    fs::read_to_string(get_antigravity_config_path())
        .ok()
        .and_then(|content| {
            if content.trim().is_empty() {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(&content).ok()
        })
        .and_then(|config| {
            let servers = config.get("mcpServers")?;
            servers
                .get(MCP_CLIENT_ID)
                .or_else(|| servers.get(LEGACY_MCP_CLIENT_ID))
                .cloned()
        })
        .is_some()
}

fn opencode_is_configured() -> bool {
    fs::read_to_string(get_opencode_config_path())
        .ok()
        .and_then(|content| parse_opencode_config(&content).ok())
        .and_then(|config| {
            let servers = config.get("mcp")?;
            servers
                .get(MCP_CLIENT_ID)
                .or_else(|| servers.get(LEGACY_MCP_CLIENT_ID))
                .cloned()
        })
        .is_some()
}

fn client_statuses() -> Vec<ClientStatus> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    vec![
        ClientStatus {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            detected: home.join(".codex").is_dir() || command_is_available("codex"),
            configured: codex_is_configured(),
            config_path: get_codex_config_path().to_string_lossy().to_string(),
        },
        ClientStatus {
            id: "claude".to_string(),
            name: "Claude Code".to_string(),
            detected: home.join(".claude").is_dir()
                || get_claude_config_path().is_file()
                || command_is_available("claude"),
            configured: claude_is_configured(),
            config_path: get_claude_config_path().to_string_lossy().to_string(),
        },
        ClientStatus {
            id: "antigravity".to_string(),
            name: "Antigravity".to_string(),
            detected: home.join(".gemini").is_dir()
                || get_antigravity_config_path().is_file()
                || command_is_available("antigravity"),
            configured: antigravity_is_configured(),
            config_path: get_antigravity_config_path().to_string_lossy().to_string(),
        },
        ClientStatus {
            id: "opencode".to_string(),
            name: "OpenCode".to_string(),
            detected: get_opencode_config_path().is_file() || command_is_available("opencode"),
            configured: opencode_is_configured(),
            config_path: get_opencode_config_path().to_string_lossy().to_string(),
        },
    ]
}

fn sdk_version_from_json(
    manifest: &serde_json::Value,
    lock: &serde_json::Value,
    package_id: &str,
) -> Option<String> {
    lock.get("dependencies")
        .and_then(|dependencies| dependencies.get(package_id))
        .and_then(|entry| entry.get("version"))
        .and_then(|version| version.as_str())
        .or_else(|| {
            manifest
                .get("dependencies")
                .and_then(|dependencies| dependencies.get(package_id))
                .and_then(|version| version.as_str())
        })
        .map(str::to_string)
}

fn sdk_version_label(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("git+")
        || value.contains(".git#")
    {
        return "Git".to_string();
    }
    if lower.starts_with("file:") {
        return "Local".to_string();
    }
    if value.len() > 32 {
        return "Custom".to_string();
    }
    value.to_string()
}

fn project_sdk_profile(project_path: &Path) -> SdkProfileStatus {
    const CREATOR_PACKAGE: &str = "com.sidequest.creator-sdk";
    const BANTER_PACKAGE: &str = "com.sidequest.banter";

    let manifest_path = project_path.join("Packages").join("manifest.json");
    let manifest_source = match fs::read_to_string(&manifest_path) {
        Ok(source) => source,
        Err(error) => {
            return SdkProfileStatus {
                profile: "unknown".to_string(),
                label: "SDK unknown".to_string(),
                creator_sdk: false,
                legacy_banter: false,
                packages: Vec::new(),
                error: Some(format!(
                    "Could not read {}: {}",
                    manifest_path.display(),
                    error
                )),
            }
        }
    };
    let manifest: serde_json::Value = match serde_json::from_str(&manifest_source) {
        Ok(value) => value,
        Err(error) => {
            return SdkProfileStatus {
                profile: "unknown".to_string(),
                label: "SDK unknown".to_string(),
                creator_sdk: false,
                legacy_banter: false,
                packages: Vec::new(),
                error: Some(format!(
                    "Could not parse {}: {}",
                    manifest_path.display(),
                    error
                )),
            }
        }
    };
    let lock_path = project_path.join("Packages").join("packages-lock.json");
    let lock = fs::read_to_string(&lock_path)
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let direct_dependencies = manifest
        .get("dependencies")
        .and_then(|dependencies| dependencies.as_object());
    let locked_dependencies = lock
        .get("dependencies")
        .and_then(|dependencies| dependencies.as_object());
    let has_package = |package_id: &str| {
        direct_dependencies
            .map(|dependencies| dependencies.contains_key(package_id))
            .unwrap_or(false)
            || locked_dependencies
                .map(|dependencies| dependencies.contains_key(package_id))
                .unwrap_or(false)
    };

    let creator_sdk = has_package(CREATOR_PACKAGE);
    let legacy_banter = has_package(BANTER_PACKAGE);
    let mut packages = Vec::new();
    if creator_sdk {
        packages.push(SdkPackageStatus {
            package_id: CREATOR_PACKAGE.to_string(),
            version: sdk_version_from_json(&manifest, &lock, CREATOR_PACKAGE),
        });
    }
    if legacy_banter {
        packages.push(SdkPackageStatus {
            package_id: BANTER_PACKAGE.to_string(),
            version: sdk_version_from_json(&manifest, &lock, BANTER_PACKAGE),
        });
    }

    let (profile, label) = match (creator_sdk, legacy_banter) {
        (true, true) => ("hybrid", "Hybrid Banter + Creator SDK".to_string()),
        (true, false) => {
            let version = packages
                .first()
                .and_then(|package| package.version.as_deref());
            (
                "creator",
                version.map_or_else(
                    || "Creator SDK".to_string(),
                    |value| format!("Creator SDK {}", sdk_version_label(value)),
                ),
            )
        }
        (false, true) => {
            let version = packages
                .first()
                .and_then(|package| package.version.as_deref());
            (
                "banter",
                version.map_or_else(
                    || "Banter SDK".to_string(),
                    |value| format!("Banter SDK {}", sdk_version_label(value)),
                ),
            )
        }
        (false, false) => ("none", "Unity only".to_string()),
    };

    SdkProfileStatus {
        profile: profile.to_string(),
        label,
        creator_sdk,
        legacy_banter,
        packages,
        error: None,
    }
}

#[tauri::command]
fn get_project_sdk_profile(unity_project_path: String) -> SdkProfileStatus {
    project_sdk_profile(Path::new(&unity_project_path))
}

fn project_setup_status(source_bridge: Option<&Path>, project_path: &Path) -> ProjectSetupStatus {
    let valid = is_valid_unity_project(project_path);
    let extension = source_bridge
        .map(|source| unity_extension_status(source, project_path))
        .unwrap_or(UnityExtensionStatus {
            installed: unity_bridge_destination(project_path).is_file(),
            current: false,
        });
    let state_dir = project_path.join(".bantworks-mcp").join("state");
    let state_files = [
        "scene-hierarchy.json",
        "editor-state.json",
        "project-instance.json",
        "console-log.json",
        "import-status.json",
        "compilation-status.json",
        "prefab-catalog.json",
    ];
    let newest_modified = state_files
        .iter()
        .filter_map(|name| fs::metadata(state_dir.join(name)).ok()?.modified().ok())
        .max();
    let state_status = match newest_modified {
        None => "missing",
        Some(modified) => {
            let age = SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default();
            if age.as_secs() <= 10 {
                "fresh"
            } else {
                "stale"
            }
        }
    };

    ProjectSetupStatus {
        valid,
        bridge_installed: extension.installed,
        bridge_current: extension.current,
        state_status: state_status.to_string(),
        sdk_profile: project_sdk_profile(project_path),
    }
}

#[tauri::command]
fn get_onboarding_status(
    app: tauri::AppHandle,
    unity_project_path: Option<String>,
) -> OnboardingStatus {
    let source_bridge = resolve_mcp_root(&app)
        .ok()
        .map(|root| unity_bridge_path(&root));
    let runtime = match resolve_node_command(&app) {
        Ok((command, bundled)) => RuntimeStatus {
            ready: true,
            bundled,
            command: Some(command.to_string_lossy().to_string()),
            version: if bundled {
                "Node.js 24 LTS".to_string()
            } else {
                "System Node.js".to_string()
            },
        },
        Err(_) => RuntimeStatus {
            ready: false,
            bundled: false,
            command: None,
            version: "Unavailable".to_string(),
        },
    };

    OnboardingStatus {
        runtime,
        clients: client_statuses(),
        project: unity_project_path
            .filter(|path| !path.trim().is_empty())
            .map(|path| project_setup_status(source_bridge.as_deref(), Path::new(&path))),
    }
}

#[tauri::command]
fn one_click_setup(
    app: tauri::AppHandle,
    unity_project_path: String,
    configure_codex: bool,
    configure_claude: bool,
    configure_antigravity: bool,
    configure_opencode: bool,
    tool_groups: String,
    enable_custom_scripts: bool,
) -> Result<SetupResult, String> {
    let candidate = channel_for_project(Path::new(&unity_project_path))?;
    let mcp_server_path = default_mcp_server_path(&app)?.to_string_lossy().to_string();
    let runtime_command = resolve_node_command(&app)?.0.to_string_lossy().to_string();
    let tool_groups = normalize_tool_groups(&tool_groups)?;

    if configure_claude {
        get_claude_mcp_config()?;
    }
    if configure_antigravity {
        get_antigravity_mcp_config()?;
    }
    if configure_opencode {
        get_opencode_mcp_config()?;
    }

    let mut config = load_config(app.clone())?;
    let key = project_path_key(Path::new(&candidate.unity_project_path));
    let channel = if let Some(existing) = config
        .channels
        .iter_mut()
        .find(|channel| project_path_key(Path::new(&channel.unity_project_path)) == key)
    {
        existing.enabled = true;
        existing.clone()
    } else {
        config.channels.push(candidate.clone());
        candidate
    };

    config.active_channel_id = Some(channel.id.clone());
    config.mcp_server_path = mcp_server_path.clone();
    config.auto_start = true;
    config.enable_custom_scripts = enable_custom_scripts;
    config.tool_groups = tool_groups.clone();
    let allow_all_tests = config.allow_all_tests;
    save_config(config)?;

    install_unity_extension(app.clone(), channel.unity_project_path.clone())?;
    set_unity_custom_scripts(channel.unity_project_path.clone(), enable_custom_scripts)?;
    set_unity_allow_all_tests(channel.unity_project_path.clone(), allow_all_tests)?;

    if configure_codex {
        update_codex_mcp_config(
            app.clone(),
            channel.clone(),
            mcp_server_path.clone(),
            tool_groups.clone(),
        )?;
    }
    if configure_claude {
        update_claude_mcp_config(
            app.clone(),
            channel.clone(),
            mcp_server_path.clone(),
            tool_groups.clone(),
        )?;
    }
    if configure_antigravity {
        update_antigravity_mcp_config(
            app.clone(),
            channel.clone(),
            mcp_server_path.clone(),
            tool_groups.clone(),
        )?;
    }
    if configure_opencode {
        update_opencode_mcp_config(app, channel.clone(), mcp_server_path, tool_groups)?;
    }

    Ok(SetupResult {
        channel,
        bridge_installed: true,
        codex_configured: configure_codex,
        claude_configured: configure_claude,
        antigravity_configured: configure_antigravity,
        opencode_configured: configure_opencode,
        runtime_command,
    })
}

#[tauri::command]
fn begin_ui_operation() -> Result<u32, &'static str> {
    lifecycle::LIFECYCLE.begin_workflow()
}

#[tauri::command]
fn finish_ui_operation(id: u32) -> Result<(), &'static str> {
    lifecycle::LIFECYCLE.finish_workflow(id)
}

fn main() {
    if let Some(code) = hub::handle_entry(&env::args_os().skip(1).collect::<Vec<_>>()) {
        std::process::exit(code);
    }

    // Linux-only: work around WebKitGTK failures on Wayland sessions and
    // certain GPU drivers where the DMA-BUF renderer can't allocate a
    // backing buffer for the WebView ("Failed to create GBM buffer of size
    // 900x700: Invalid argument"). Falling back to the CPU renderer keeps
    // the launcher functional on CachyOS / Arch and similar hosts without
    // hurting visual quality on systems where DMA-BUF works correctly.
    #[cfg(target_os = "linux")]
    {
        if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // Honour an explicit GDK_BACKEND override (e.g. GDK_BACKEND=x11) but
        // do not force one — Wayland is the default on modern distros and
        // works on most systems once DMA-BUF is disabled.
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                lifecycle::LIFECYCLE.attach_window(window.hwnd()?.0 as usize);
            }
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
        })
        .on_window_event(lifecycle::window_event)
        .invoke_handler(|invoke| {
            let Ok(_command) = lifecycle::LIFECYCLE.command() else {
                invoke
                    .resolver
                    .reject("Launcher is closing or lifecycle state is unavailable");
                return true;
            };
            // All registered handlers are synchronous. Keep the guard alive
            // through response generation, including failed command arguments.
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                begin_ui_operation,
                finish_ui_operation,
                load_config,
                save_config,
                add_channel,
                add_project,
                validate_unity_scene,
                discover_unity_projects,
                get_claude_mcp_config,
                update_claude_mcp_config,
                remove_claude_mcp_config,
                update_codex_mcp_config,
                remove_codex_mcp_config,
                get_antigravity_mcp_config,
                update_antigravity_mcp_config,
                remove_antigravity_mcp_config,
                get_opencode_mcp_config,
                update_opencode_mcp_config,
                remove_opencode_mcp_config,
                check_unity_extension,
                get_unity_extension_status,
                get_project_sdk_profile,
                install_unity_extension,
                update_configured_unity_extensions,
                get_mcp_root,
                set_unity_custom_scripts,
                set_unity_allow_all_tests,
                get_onboarding_status,
                get_project_feedback_settings,
                set_project_feedback_settings,
                one_click_setup,
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(lifecycle::run_event);
}

fn update_unity_launcher_settings<F>(unity_project_path: &str, update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Value),
{
    let state_dir = PathBuf::from(unity_project_path)
        .join(".bantworks-mcp")
        .join("state");

    fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create MCP state directory: {}", e))?;

    let settings_path = state_dir.join("launcher-settings.json");

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read launcher settings: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Invalid launcher settings; preserving existing file: {}", e))?
    } else {
        serde_json::json!({})
    };

    if !settings.is_object() {
        return Err(
            "Launcher settings must be a JSON object; preserving existing file".to_string(),
        );
    }
    update(&mut settings);

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    atomic_write(&settings_path, &content)?;

    Ok(())
}

/// Set the custom scripts preference in Unity project's MCP state
/// This writes to the project runtime state folder which the Unity extension reads
#[tauri::command]
fn set_unity_custom_scripts(unity_project_path: String, enabled: bool) -> Result<(), String> {
    update_unity_launcher_settings(&unity_project_path, |settings| {
        settings["enableCustomScripts"] = serde_json::json!(enabled);
    })
}

/// Set the allow all tests preference in Unity project's MCP state
/// This writes to the project runtime state folder which the Unity extension reads
#[tauri::command]
fn set_unity_allow_all_tests(unity_project_path: String, enabled: bool) -> Result<(), String> {
    update_unity_launcher_settings(&unity_project_path, |settings| {
        settings["allowAllTests"] = serde_json::json!(enabled);
    })
}

#[tauri::command]
fn get_project_feedback_settings(unity_project_path: String) -> Result<serde_json::Value, String> {
    feedback::read(&unity_project_path)
}

#[tauri::command]
fn set_project_feedback_settings(
    unity_project_path: String,
    enabled: bool,
    usage_check_ins: bool,
) -> Result<serde_json::Value, String> {
    feedback::write(&unity_project_path, enabled, usage_check_ins)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "creator-works-launcher-test-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn finds_release_bundle_and_bridge_without_a_machine_specific_root() {
        let root = temporary_root();
        let server = root.join("release").join("creator-works-mcp.mjs");
        let bridge = unity_bridge_path(&root);
        let logo = unity_bridge_logo_path(&root);
        fs::create_dir_all(server.parent().unwrap()).unwrap();
        fs::create_dir_all(bridge.parent().unwrap()).unwrap();
        fs::write(&server, "// fixture").unwrap();
        fs::write(&bridge, "// fixture").unwrap();
        fs::write(&logo, "logo fixture").unwrap();

        assert_eq!(find_mcp_server_path(&root), Some(server));
        assert!(is_valid_mcp_root(&root));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recognizes_both_legacy_windows_path_forms() {
        assert!(is_legacy_server_path("C:/tools/banter-mcp/dist/index.js"));
        assert!(is_legacy_server_path(
            "c:\\tools\\banter-mcp\\dist\\index.js"
        ));
        assert!(!is_legacy_server_path("D:/custom/banter-mcp.mjs"));
        assert!(is_legacy_server_bundle_path(
            "D:/installed/server/banter-mcp.mjs"
        ));
        assert!(is_legacy_server_bundle_path(
            "D:\\installed\\server\\BANTER-MCP.MJS"
        ));
        assert!(!is_legacy_server_bundle_path(
            "D:/installed/server/creator-works-mcp.mjs"
        ));
    }

    #[test]
    fn persists_loaded_config_upgrades_for_existing_creator_works_configs() {
        let mut config = LauncherConfig {
            channels: vec![],
            active_channel_id: None,
            mcp_server_path: "D:/installed/server/banter-mcp.mjs".to_string(),
            auto_start: true,
            enable_custom_scripts: false,
            allow_all_tests: true,
            tool_groups: " ShaderGraph, Read, read ".to_string(),
            automatic_update_checks: false,
        };
        let replacement = Path::new("D:/installed/server/creator-works-mcp.mjs");

        assert!(upgrade_loaded_config(&mut config, Some(replacement)).unwrap());
        assert_eq!(
            config.mcp_server_path,
            "D:/installed/server/creator-works-mcp.mjs"
        );
        assert_eq!(config.tool_groups, "read,shadergraph");
        assert!(!upgrade_loaded_config(&mut config, None).unwrap());
    }

    #[test]
    fn removes_windows_verbatim_prefixes_from_client_paths() {
        assert_eq!(
            normalized_existing_path(PathBuf::from(r"\\?\C:\BANTWORKS\node.exe")),
            PathBuf::from(r"C:\BANTWORKS\node.exe")
        );
        assert_eq!(
            normalized_existing_path(PathBuf::from(r"\\?\UNC\server\share\node.exe")),
            PathBuf::from(r"\\server\share\node.exe")
        );
    }

    #[test]
    fn removes_only_the_target_codex_tables() {
        let input = "model = \"gpt\"\n\n[mcp_servers.creator-works]\ncommand = \"node\"\n\n[mcp_servers.creator-works.env]\nUNITY_PROJECT_PATH = \"X\"\n\n[other]\nkeep = true\n";
        let result = remove_client_mcp_tables(input, MCP_CLIENT_ID);

        assert!(result.contains("model = \"gpt\""));
        assert!(result.contains("[other]"));
        assert!(!result.contains("mcp_servers.creator-works"));
        assert!(!result.contains("UNITY_PROJECT_PATH"));
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let root = temporary_root();
        let path = root.join("config.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, "old").unwrap();

        atomic_write(&path, "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tool_groups_are_normalized_and_fail_closed() {
        assert_eq!(normalize_tool_groups(""), Ok("core".to_string()));
        assert_eq!(normalize_tool_groups("core"), Ok("core".to_string()));
        assert_eq!(
            normalize_tool_groups("banter, read,banter"),
            Ok("read,banter".to_string())
        );
        assert_eq!(normalize_tool_groups("none"), Ok("none".to_string()));
        assert_eq!(
            normalize_tool_groups("shadergraph,read,author"),
            Ok("read,author,shadergraph".to_string())
        );
        assert!(normalize_tool_groups("all,read").is_err());
        assert!(normalize_tool_groups("admin").is_err());
        assert!(normalize_tool_groups(",,,").is_err());
    }

    #[test]
    fn client_configs_include_the_selected_tool_groups() {
        let channel = ProjectChannel {
            id: "channel".to_string(),
            name: "Project".to_string(),
            unity_project_path: "E:\\unity\\Project".to_string(),
            scene_path: Some("E:\\unity\\Project\\Assets\\Main.unity".to_string()),
            enabled: true,
        };

        let claude = build_claude_mcp_config(
            serde_json::json!({
                "keep": true,
                "mcpServers": {
                    "other": {},
                    "banter": { "command": "old" },
                    "creator-works": { "command": "stale" }
                }
            }),
            &channel,
            "C:\\CreatorWorks\\runtime\\node.exe",
            "C:\\CreatorWorks\\creator-works-mcp.mjs",
            "banter,read",
        )
        .unwrap();
        assert_eq!(claude["keep"], true);
        assert!(claude["mcpServers"]["other"].is_object());
        assert!(claude["mcpServers"]["banter"].is_null());
        assert_eq!(
            claude["mcpServers"]["creator-works"]["env"]["CREATOR_WORKS_TOOL_GROUPS"],
            "read,banter"
        );

        let codex = build_codex_mcp_config(
            "model = \"gpt\"\n\n[mcp_servers.banter]\ncommand = \"old\"\n\n[mcp_servers.banter.env]\nOLD = \"true\"\n\n[other]\nkeep = true\n",
            &channel,
            "C:/CreatorWorks/runtime/node.exe",
            "C:/CreatorWorks/creator-works-mcp.mjs",
            "read,banter",
        )
        .unwrap();
        assert!(codex.contains("model = \"gpt\""));
        assert!(codex.contains("[other]"));
        assert!(codex.contains("[mcp_servers.creator-works]"));
        assert!(!codex.contains("[mcp_servers.banter]"));
        assert!(codex.contains("CREATOR_WORKS_TOOL_GROUPS = \"read,banter\""));
        assert!(codex.contains("UNITY_SCENE_PATH = \"E:/unity/Project/Assets/Main.unity\""));
        assert!(codex.contains("command = \"C:/CreatorWorks/runtime/node.exe\""));

        assert!(build_claude_mcp_config(
            serde_json::json!([]),
            &channel,
            "node",
            "server.mjs",
            "all"
        )
        .is_err());
    }

    #[test]
    fn project_folder_setup_does_not_require_a_scene_file() {
        let root = temporary_root().join("First Project");
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();

        let channel = channel_for_project(&root).unwrap();
        assert_eq!(channel.name, "First Project");
        assert_eq!(channel.scene_path, None);
        assert!(channel.enabled);

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn extension_status_detects_stale_project_copies() {
        let root = temporary_root();
        let project = root.join("Project");
        let source = root.join("BanterMCPBridge.cs");
        let logo_source = root.join(UNITY_BRIDGE_LOGO_FILE_NAME);
        let destination = unity_bridge_destination(&project);
        let logo_destination = unity_bridge_logo_destination(&project);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&source, "current bridge").unwrap();
        fs::write(&logo_source, "current logo").unwrap();
        fs::write(&destination, "old bridge").unwrap();

        let stale = unity_extension_status(&source, &project);
        assert!(stale.installed);
        assert!(!stale.current);

        fs::copy(&source, &destination).unwrap();
        fs::copy(&logo_source, &logo_destination).unwrap();
        let current = unity_extension_status(&source, &project);
        assert!(current.installed);
        assert!(current.current);

        fs::write(&logo_destination, "old logo").unwrap();
        let stale_logo = unity_extension_status(&source, &project);
        assert!(stale_logo.installed);
        assert!(!stale_logo.current);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sdk_profile_distinguishes_banter_creator_hybrid_and_plain_unity() {
        let root = temporary_root();
        let project = root.join("Project");
        fs::create_dir_all(project.join("Assets")).unwrap();
        fs::create_dir_all(project.join("ProjectSettings")).unwrap();
        fs::create_dir_all(project.join("Packages")).unwrap();

        fs::write(
            project.join("Packages").join("manifest.json"),
            r#"{"dependencies":{"com.sidequest.banter":"3.1.2"}}"#,
        )
        .unwrap();
        let banter = project_sdk_profile(&project);
        assert_eq!(banter.profile, "banter");
        assert_eq!(banter.label, "Banter SDK 3.1.2");
        assert!(banter.legacy_banter);
        assert!(!banter.creator_sdk);

        fs::write(
            project.join("Packages").join("manifest.json"),
            r#"{"dependencies":{"com.sidequest.creator-sdk":"3.2.17"}}"#,
        )
        .unwrap();
        let creator = project_sdk_profile(&project);
        assert_eq!(creator.profile, "creator");
        assert_eq!(creator.label, "Creator SDK 3.2.17");
        assert!(creator.creator_sdk);
        assert!(!creator.legacy_banter);

        fs::write(
            project.join("Packages").join("manifest.json"),
            r#"{"dependencies":{"com.sidequest.creator-sdk":"4.0.0","com.sidequest.banter":"3.2.2"}}"#,
        )
        .unwrap();
        let hybrid = project_sdk_profile(&project);
        assert_eq!(hybrid.profile, "hybrid");
        assert_eq!(hybrid.packages.len(), 2);

        fs::write(
            project.join("Packages").join("manifest.json"),
            r#"{"dependencies":{"com.unity.visualscripting":"1.9.1"}}"#,
        )
        .unwrap();
        let plain = project_sdk_profile(&project);
        assert_eq!(plain.profile, "none");
        assert_eq!(plain.label, "Unity only");

        fs::write(
            project.join("Packages").join("manifest.json"),
            r#"{"dependencies":{"com.sidequest.creator-sdk":"https://github.com/SideQuestVR/BanterSDK.git#feature/greenfield"}}"#,
        )
        .unwrap();
        let git_creator = project_sdk_profile(&project);
        assert_eq!(git_creator.label, "Creator SDK Git");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_manifest_reports_unknown_sdk_instead_of_guessing() {
        let root = temporary_root();
        let project = root.join("Project");
        fs::create_dir_all(project.join("Packages")).unwrap();
        fs::write(project.join("Packages").join("manifest.json"), "not-json").unwrap();

        let profile = project_sdk_profile(&project);
        assert_eq!(profile.profile, "unknown");
        assert!(profile.error.unwrap().contains("Could not parse"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unity_hub_discovery_filters_missing_projects() {
        let root = temporary_root();
        let valid = root.join("Valid");
        let missing = root.join("Missing");
        fs::create_dir_all(valid.join("Assets")).unwrap();
        fs::create_dir_all(valid.join("ProjectSettings")).unwrap();
        let hub_path = root.join("projects-v1.json");
        let fixture = serde_json::json!({
            "schema_version": "v1",
            "data": {
                valid.to_string_lossy().to_string(): {
                    "title": "Valid Project",
                    "path": valid,
                    "version": "6000.3.10f1",
                    "lastModified": 42
                },
                missing.to_string_lossy().to_string(): {
                    "title": "Missing Project",
                    "path": missing,
                    "version": "6000.3.10f1"
                }
            }
        });
        fs::write(&hub_path, serde_json::to_string(&fixture).unwrap()).unwrap();

        let projects = projects_from_unity_hub(&hub_path);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Valid Project");
        assert_eq!(projects[0].unity_version.as_deref(), Some("6000.3.10f1"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn antigravity_and_opencode_configs_include_tool_groups_and_paths() {
        let channel = ProjectChannel {
            id: "channel-1".to_string(),
            name: "Project".to_string(),
            unity_project_path: "/home/user/Unity/Project".to_string(),
            scene_path: Some("/home/user/Unity/Project/Assets/Main.unity".to_string()),
            enabled: true,
        };

        let antigravity = build_antigravity_mcp_config(
            serde_json::json!({ "mcpServers": {} }),
            &channel,
            "/home/user/.local/share/bantworks-mcp/server/runtime/node",
            "/home/user/.local/share/bantworks-mcp/server/banter-mcp.mjs",
            "all",
        )
        .unwrap();

        assert_eq!(
            antigravity["mcpServers"][MCP_CLIENT_ID]["command"],
            "/home/user/.local/share/bantworks-mcp/server/runtime/node"
        );
        assert_eq!(
            antigravity["mcpServers"][MCP_CLIENT_ID]["args"][0],
            "/home/user/.local/share/bantworks-mcp/server/banter-mcp.mjs"
        );
        assert_eq!(
            antigravity["mcpServers"][MCP_CLIENT_ID]["env"]["UNITY_PROJECT_PATH"],
            "/home/user/Unity/Project"
        );
        assert_eq!(
            antigravity["mcpServers"][MCP_CLIENT_ID]["env"][TOOL_GROUPS_ENV],
            "all"
        );
        assert_eq!(
            antigravity["mcpServers"][MCP_CLIENT_ID]["env"]["UNITY_SCENE_PATH"],
            "/home/user/Unity/Project/Assets/Main.unity"
        );

        let opencode = build_opencode_mcp_config(
            serde_json::json!({ "mcp": {} }),
            &channel,
            "/home/user/.local/share/bantworks-mcp/server/runtime/node",
            "/home/user/.local/share/bantworks-mcp/server/banter-mcp.mjs",
            "read,banter",
        )
        .unwrap();

        assert_eq!(opencode["mcp"][MCP_CLIENT_ID]["type"], "local");
        assert_eq!(opencode["mcp"][MCP_CLIENT_ID]["enabled"], true);
        assert_eq!(
            opencode["mcp"][MCP_CLIENT_ID]["command"][0],
            "/home/user/.local/share/bantworks-mcp/server/runtime/node"
        );
        assert_eq!(
            opencode["mcp"][MCP_CLIENT_ID]["command"][1],
            "/home/user/.local/share/bantworks-mcp/server/banter-mcp.mjs"
        );
        assert_eq!(
            opencode["mcp"][MCP_CLIENT_ID]["environment"][TOOL_GROUPS_ENV],
            "read,banter"
        );
    }

    #[test]
    fn ephemeral_path_detection_identifies_appimage_mounts() {
        assert!(is_ephemeral_path(Path::new(
            "/tmp/.mount_BANTWOHGiine/usr/lib/BANTWORKS-MCP/server/banter-mcp.mjs"
        )));
        assert!(is_ephemeral_path(Path::new(
            "/tmp/.mount_abc123/server/runtime/node"
        )));
        assert!(is_ephemeral_path(Path::new(
            "/var/tmp/something/banter-mcp.mjs"
        )));
        assert!(!is_ephemeral_path(Path::new(
            "/home/user/.local/share/bantworks-mcp/server/banter-mcp.mjs"
        )));
        assert!(!is_ephemeral_path(Path::new(
            "/usr/lib/BANTWORKS-MCP/server/banter-mcp.mjs"
        )));
    }

    #[test]
    fn sync_ephemeral_bundle_extracts_all_required_mcp_artifacts() {
        let temp_dir =
            std::env::temp_dir().join(format!("test-ephemeral-{}", uuid::Uuid::new_v4()));
        let source_root = temp_dir.join("mount/server");
        fs::create_dir_all(source_root.join("runtime")).unwrap();
        fs::create_dir_all(source_root.join("unity-extension").join("Editor")).unwrap();

        fs::write(source_root.join("creator-works-mcp.mjs"), "// server").unwrap();
        fs::write(source_root.join("LICENSE"), "MIT").unwrap();
        fs::write(source_root.join("THIRD_PARTY_NOTICES.md"), "Notices").unwrap();
        fs::write(source_root.join("runtime").join("VERSION"), "v24.0.0").unwrap();
        fs::write(source_root.join("runtime").join("LICENSE"), "Node").unwrap();
        let binary_name = if cfg!(windows) { "node.exe" } else { "node" };
        fs::write(source_root.join("runtime").join(binary_name), "#!/bin/sh").unwrap();
        fs::write(
            source_root
                .join("unity-extension")
                .join("Editor")
                .join("BanterMCPBridge.cs"),
            "// bridge",
        )
        .unwrap();
        fs::write(
            source_root
                .join("unity-extension")
                .join("Editor")
                .join(UNITY_BRIDGE_LOGO_FILE_NAME),
            "PNG",
        )
        .unwrap();

        assert!(is_valid_mcp_root(&source_root));

        let synced = sync_ephemeral_bundle(&source_root);
        assert!(synced.is_some(), "sync_ephemeral_bundle should succeed");
        let dest_root = synced.unwrap();
        assert!(is_valid_mcp_root(&dest_root));
        assert!(dest_root.join("creator-works-mcp.mjs").is_file());
        assert!(dest_root.join("banter-mcp.mjs").is_file());
        assert!(dest_root.join("runtime").join(binary_name).is_file());
        assert!(dest_root
            .join("unity-extension")
            .join("Editor")
            .join("BanterMCPBridge.cs")
            .is_file());
        assert!(dest_root
            .join("unity-extension")
            .join("Editor")
            .join(UNITY_BRIDGE_LOGO_FILE_NAME)
            .is_file());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn launcher_settings_updates_preserve_fields_and_defaults() {
        let root = temporary_root();
        let project_path = root.to_string_lossy().to_string();

        // Deserializing older config without allow_all_tests defaults to true
        let legacy_json = r#"{
            "channels": [],
            "active_channel_id": null,
            "mcp_server_path": "",
            "auto_start": false,
            "enable_custom_scripts": true,
            "tool_groups": "all"
        }"#;
        let config: LauncherConfig = serde_json::from_str(legacy_json).unwrap();
        assert!(
            config.allow_all_tests,
            "allow_all_tests should default to true for backwards compatibility"
        );

        // Setting custom scripts writes launcher-settings.json
        set_unity_custom_scripts(project_path.clone(), true).unwrap();
        let settings_path = root
            .join(".bantworks-mcp")
            .join("state")
            .join("launcher-settings.json");
        let content = fs::read_to_string(&settings_path).unwrap();
        let val: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(val["enableCustomScripts"], true);

        // Setting allow_all_tests preserves enableCustomScripts
        set_unity_allow_all_tests(project_path.clone(), false).unwrap();
        let content = fs::read_to_string(&settings_path).unwrap();
        let val: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(val["enableCustomScripts"], true);
        assert_eq!(val["allowAllTests"], false);

        for invalid in ["{broken", "[]", "null"] {
            fs::write(&settings_path, invalid).unwrap();
            assert!(set_unity_allow_all_tests(project_path.clone(), true).is_err());
            assert_eq!(fs::read_to_string(&settings_path).unwrap(), invalid);
        }

        let _ = fs::remove_dir_all(root);
    }
}
