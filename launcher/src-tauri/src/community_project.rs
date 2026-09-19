//! User-selected project authority and an Editor-reviewed package inbox, never asset extraction.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const PACKAGE: &str = "Packages/com.creatorworks.plugins";
const AREA: &str = ".creator-plugins";
const MAX_JSON: u64 = 2 * 1024 * 1024;
const MAX_PACKAGE: u64 = crate::community::transfer::MAX_PACKAGE;
// Exact alpha.8 helper from 4ab615c; earlier public Hub releases had no helper.
const LEGACY_HASHES: &[&str] = &[
    "7d4cbdef640f5cc89c45a6c1fad1046586ea73fbf22e8ff68252e5a3b463843e",
    "7e1bc8fb937a3324de67fb2439b8e943dda3efc6b62684da2697e1bfcfe7414e",
    "4af0449cdb8f192a2a0ec8498db78790cf9f185e08fb9bac95c237ad7e152a5d",
    "d7ebb4482f1194a51ad85789f11b60e9525a310b3d3b3893d9624bd22b4aa85a",
];
// Exact helper shipped in Hub 0.1.0, Setup 0.3.0 and MCP 2.7.0.
const STABLE_HASHES: &[&str] = &[
    "b9624dfda50c815913ee4e3555c3b5abcfdfc3a557c7eaf3bcb2061dbde08faf",
    "7e1bc8fb937a3324de67fb2439b8e943dda3efc6b62684da2697e1bfcfe7414e",
    "4af0449cdb8f192a2a0ec8498db78790cf9f185e08fb9bac95c237ad7e152a5d",
    "eb62f266835bf42814c3decc224197cb74842fc316428390645d314ca28243a7",
];
// Exact grid helper shipped with Hub 0.1.1 through 0.1.6.
const GRID_HASHES: &[&str] = &[
    "b9624dfda50c815913ee4e3555c3b5abcfdfc3a557c7eaf3bcb2061dbde08faf",
    "7e1bc8fb937a3324de67fb2439b8e943dda3efc6b62684da2697e1bfcfe7414e",
    "4af0449cdb8f192a2a0ec8498db78790cf9f185e08fb9bac95c237ad7e152a5d",
    "506799fb7c9a3868d212c635217ba853084e20fc6b22c772b7565fb54ac8ab07",
];
const FILES: &[(&str, &[u8])] = &[
    (
        "package.json",
        include_bytes!("../../unity/com.creatorworks.plugins/package.json"),
    ),
    (
        "LICENSE.md",
        include_bytes!("../../unity/com.creatorworks.plugins/LICENSE.md"),
    ),
    (
        "Editor/CreatorWorks.Plugins.Editor.asmdef",
        include_bytes!(
            "../../unity/com.creatorworks.plugins/Editor/CreatorWorks.Plugins.Editor.asmdef"
        ),
    ),
    (
        "Editor/CreatorPluginsWindow.cs",
        include_bytes!("../../unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs"),
    ),
];

#[derive(Default)]
pub struct ProjectImports(Mutex<BTreeMap<String, Target>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    pub path: String,
    pub unity_version: String,
    pub sdk: String,
    pub helper: String,
    pub open: bool,
    #[serde(skip)]
    fingerprint: String,
}
#[derive(Serialize)]
pub struct Targets {
    projects: Vec<Target>,
    warnings: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    schema_version: u32,
    request_id: String,
    project_path: String,
    package_id: String,
    version: String,
    name: String,
    byte_length: u64,
    sha256: String,
    package_file: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    request_id: String,
    status: String,
    message: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub project_id: String,
    pub request_id: String,
    pub status: String,
    pub message: String,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[allow(unused_mut)]
                let mut linked = meta.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    linked |= meta.file_attributes() & 0x400 != 0;
                }
                if linked {
                    return Err(
                        "Project and plugin paths cannot contain symbolic links or junctions."
                            .into(),
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("A project path could not be inspected.".into()),
        }
    }
    Ok(())
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    reject_links(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Project file is unavailable.")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Project file could not be read.")?;
    if bytes.len() as u64 > limit {
        return Err("Project file exceeds its size limit.".into());
    }
    Ok(bytes)
}
fn json(path: &Path) -> Result<serde_json::Value, String> {
    serde_json::from_slice(&read(path, MAX_JSON)?)
        .map_err(|_| "Project metadata is invalid.".into())
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    let value = path.to_string_lossy();
    if !path.is_absolute()
        || value.starts_with("\\\\")
        || value.starts_with("//")
        || path
            .components()
            .any(|p| p == std::path::Component::ParentDir)
    {
        return Err("Choose an absolute local Unity project folder.".into());
    }
    reject_links(path)?;
    let result = path
        .canonicalize()
        .map_err(|_| "Project folder is unavailable.")?;
    #[cfg(windows)]
    {
        if let Some(value) = result.to_string_lossy().strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(value));
        }
    }
    Ok(result)
}
fn helper_state(root: &Path) -> Result<&'static str, String> {
    helper_contents(&root.join(PACKAGE), true)
}
fn helper_contents(destination: &Path, allow_unity_metadata: bool) -> Result<&'static str, String> {
    reject_links(destination)?;
    if !destination.exists() {
        return Ok("missing");
    }
    let mut current = true;
    let mut legacy = true;
    let mut stable = true;
    let mut grid = true;
    for (index, (name, expected)) in FILES.iter().enumerate() {
        let Ok(bytes) = read(&destination.join(name), 256 * 1024) else {
            return Ok("different");
        };
        current &= bytes == *expected;
        let hash = digest(&bytes);
        legacy &= hash == LEGACY_HASHES[index];
        stable &= hash == STABLE_HASHES[index];
        grid &= hash == GRID_HASHES[index];
    }
    if !current && !legacy && !stable && !grid {
        return Ok("different");
    }
    let mut pending = vec![destination.to_path_buf()];
    let mut count = 0;
    while let Some(folder) = pending.pop() {
        for entry in fs::read_dir(folder).map_err(|_| "Unity helper files cannot be inspected.")? {
            let path = entry
                .map_err(|_| "Unity helper files cannot be inspected.")?
                .path();
            count += 1;
            if count > 64 {
                return Ok("different");
            }
            reject_links(&path)?;
            let relative = path
                .strip_prefix(destination)
                .map_err(|_| "Invalid Unity helper path.")?
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                if !FILES
                    .iter()
                    .any(|(name, _)| name.starts_with(&format!("{relative}/")))
                {
                    return Ok("different");
                }
                pending.push(path);
                continue;
            }
            if !(FILES.iter().any(|(name, _)| *name == relative)
                || allow_unity_metadata && relative.ends_with(".meta"))
            {
                return Ok("different");
            }
        }
    }
    Ok(if current { "installed" } else { "outdated" })
}
fn editor_open(root: &Path) -> Result<bool, String> {
    let path = root.join("Temp/UnityLockfile");
    reject_links(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Unity denies sharing while the Editor owns this file. A stale,
        // unlocked file is not evidence of a running Editor. Never delete it.
        match fs::OpenOptions::new().read(true).share_mode(0).open(path) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Ok(true), // Sharing/access failures remain fail-closed.
        }
    }
    #[cfg(unix)]
    {
        if !path.exists() {
            return Ok(false);
        }
        use fs2::FileExt;
        match fs::File::open(&path) {
            Ok(file) => match file.try_lock_exclusive() {
                Ok(()) => {
                    let _ = file.unlock();
                    Ok(false)
                }
                Err(_) => Ok(true),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Ok(true),
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        Ok(path.exists())
    }
}
fn inspect(path: &Path) -> Result<Target, String> {
    let root = canonical(path)?;
    for folder in ["Assets", "Packages", "ProjectSettings"] {
        reject_links(&root.join(folder))?;
        if !root.join(folder).is_dir() {
            return Err("The selected folder is not a complete Unity project.".into());
        }
    }
    let version = read(&root.join("ProjectSettings/ProjectVersion.txt"), 8192)?;
    let version_text =
        std::str::from_utf8(&version).map_err(|_| "Project Unity version is invalid.")?;
    let unity = version_text
        .lines()
        .find_map(|l| l.strip_prefix("m_EditorVersion: "))
        .filter(|v| v.len() < 64 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'))
        .ok_or("Project Unity version is missing.")?;
    let mut parts = unity.split('.');
    let major = parts
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let minor = parts
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    if major < 2022 || major == 2022 && minor < 3 {
        return Err("Creator Plugins requires Unity 2022.3 or newer.".into());
    }
    let manifest = read(&root.join("Packages/manifest.json"), MAX_JSON)?;
    let value: serde_json::Value =
        serde_json::from_slice(&manifest).map_err(|_| "Project package manifest is invalid.")?;
    let dependencies = value["dependencies"]
        .as_object()
        .ok_or("Project package dependencies are invalid.")?;
    let has = |name: &str| {
        dependencies.contains_key(name)
            || json(&root.join("Packages").join(name).join("package.json"))
                .is_ok_and(|v| v["name"] == name)
    };
    let sdk = match (
        has("com.sidequest.creator-sdk"),
        has("com.sidequest.banter"),
    ) {
        (true, true) => "Creator SDK + Banter",
        (true, false) => "Creator SDK / Altspace",
        (false, true) => "Banter SDK",
        _ => "Unity / no SDK detected",
    };
    let path = root.to_string_lossy().into_owned();
    let id = digest(
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path.clone()
        }
        .as_bytes(),
    );
    let fingerprint = digest(&[version.as_slice(), b"\0", manifest.as_slice()].concat());
    Ok(Target {
        id,
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path,
        unity_version: unity.into(),
        sdk: sdk.into(),
        helper: helper_state(&root)?.into(),
        open: editor_open(&root)?,
        fingerprint,
    })
}
fn remember(handle: &tauri::AppHandle, target: Target) -> Result<Target, String> {
    let state = handle.state::<ProjectImports>();
    let mut map = state.0.lock().map_err(|_| "Project list is busy.")?;
    if map.len() >= 200 && !map.contains_key(&target.id) {
        return Err("Project list limit reached. Restart the app to choose other projects.".into());
    }
    map.insert(target.id.clone(), target.clone());
    Ok(target)
}
pub fn selected(handle: &tauri::AppHandle, id: &str) -> Result<Target, String> {
    let target = handle
        .state::<ProjectImports>()
        .0
        .lock()
        .map_err(|_| "Project list is busy.")?
        .get(id)
        .cloned()
        .ok_or("Choose a project from the current list first.")?;
    fresh(&target)
}
fn fresh(target: &Target) -> Result<Target, String> {
    let checked = inspect(Path::new(&target.path))?;
    if checked.id != target.id || checked.fingerprint != target.fingerprint {
        return Err("Project packages or Unity version changed. Refresh projects and review the target again.".into());
    }
    Ok(checked)
}
fn stored_paths() -> (Vec<PathBuf>, Vec<String>) {
    let mut paths = Vec::new();
    let mut warnings = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        let file = local.join("CreatorHub/projects.json");
        if file.exists() {
            match json(&file) {
                Ok(v) => {
                    if let Some(values) = v["paths"].as_array() {
                        paths.extend(
                            values
                                .iter()
                                .take(200)
                                .filter_map(|p| p.as_str().map(PathBuf::from)),
                        );
                    }
                }
                Err(_) => {
                    warnings.push("Creator Hub's saved project list could not be read.".into())
                }
            }
        }
    }
    if let Some(config) = dirs::config_dir() {
        for relative in [
            "creator-works-mcp/launcher-config.json",
            "banter-mcp/launcher-config.json",
        ] {
            let file = config.join(relative);
            if file.exists() {
                match json(&file) {
                    Ok(v) => {
                        if let Some(rows) = v["channels"].as_array() {
                            paths.extend(rows.iter().take(200).filter_map(|row| {
                                row["unity_project_path"].as_str().map(PathBuf::from)
                            }));
                        }
                    }
                    Err(_) => warnings.push(
                        "An MCP project list could not be read. Choose a folder manually.".into(),
                    ),
                }
            }
        }
    }
    (paths, warnings)
}
pub fn projects_worker(handle: tauri::AppHandle, extra: Vec<PathBuf>) -> Result<Targets, String> {
    let (mut paths, mut warnings) = stored_paths();
    paths.extend(extra);
    paths.extend(
        handle
            .state::<ProjectImports>()
            .0
            .lock()
            .map_err(|_| "Project list is busy.")?
            .values()
            .map(|t| PathBuf::from(&t.path)),
    );
    let mut map = BTreeMap::new();
    let mut skipped = 0;
    for path in paths.into_iter().take(800) {
        match inspect(&path) {
            Ok(target) if map.len() < 200 => {
                map.insert(target.id.clone(), target);
            }
            _ => skipped += 1,
        }
    }
    if skipped > 0 {
        warnings.push("Some saved folders are unavailable or unsupported. You can choose another project folder.".into());
    }
    let mut projects: Vec<_> = map.values().cloned().collect();
    projects.sort_by_key(|t| t.name.to_lowercase());
    *handle
        .state::<ProjectImports>()
        .0
        .lock()
        .map_err(|_| "Project list is busy.")? = map;
    Ok(Targets { projects, warnings })
}
pub fn pick_worker(handle: tauri::AppHandle) -> Result<Option<Target>, String> {
    let Some(path) = handle.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    remember(
        &handle,
        inspect(
            &path
                .into_path()
                .map_err(|_| "Choose a local project folder.")?,
        )?,
    )
    .map(Some)
}
fn area(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = root.join(AREA).join(relative);
    reject_links(&path)?;
    Ok(path)
}
fn operation(root: &Path) -> Result<fs::File, String> {
    let path = area(root, "desktop.lock")?;
    fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| "Could not create the plugin workspace.")?;
    reject_links(&path)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|_| "Could not open the plugin operation lock.")?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| {
        "Another Creator app is changing this project's plugin queue. Try again after it finishes."
    })?;
    Ok(lock)
}
fn save_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    reject_links(path)?;
    let parent = path.parent().ok_or("Invalid plugin output path.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the plugin output folder.")?;
    reject_links(path)?;
    let mut file = tempfile::Builder::new()
        .prefix(".tmp-")
        .tempfile_in(parent)
        .map_err(|_| "Could not stage the plugin file.")?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Could not save the plugin file.")?;
    file.persist_noclobber(path)
        .map_err(|_| "A plugin file already exists or cannot be saved; nothing was overwritten.")?;
    Ok(())
}
fn publish_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // No MOVEFILE_REPLACE_EXISTING: preserve even an empty raced directory.
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        };
        if result != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(source.as_os_str().as_bytes())?;
        let to = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
        // These flags preserve a raced destination, including an empty directory.
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (source, destination);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Atomic helper installation is not supported on this platform.",
        ))
    }
}
const HELPER_PUBLISH_RETRIES: usize = 20;
const HELPER_PUBLISH_BUDGET: std::time::Duration = std::time::Duration::from_secs(1);
fn transient_publication_error(error: &std::io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32))
}
fn publish_helper(
    target: &Target,
    staging: &Path,
    mut wait_for_reader: impl FnMut(std::time::Duration),
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + HELPER_PUBLISH_BUDGET;
    let staged_snapshot = helper_snapshot(staging)?;
    for attempt in 0..=HELPER_PUBLISH_RETRIES {
        let checked = fresh(target)?;
        if checked.open || checked.helper != "missing" {
            return Err(
                "The project or helper changed during installation. Nothing was replaced.".into(),
            );
        }
        if helper_contents(staging, true)? != "installed"
            || helper_snapshot(staging)? != staged_snapshot
        {
            return Err("Staged Unity helper files changed. Nothing was installed.".into());
        }
        if attempt > 0 && std::time::Instant::now() >= deadline {
            return Err("Timed out waiting for the Unity helper files to become available. Existing files were not replaced. Close other apps using this project folder and try again.".into());
        }
        match publish_directory(staging, &Path::new(&checked.path).join(PACKAGE)) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if attempt < HELPER_PUBLISH_RETRIES
                    && transient_publication_error(&error)
                    && !remaining.is_zero()
                {
                    // Windows denies directory renames while readers hold descendants open.
                    // Recheck consent-bound project state and staged bytes after every wait.
                    wait_for_reader(remaining.min(std::time::Duration::from_millis(50)));
                    if std::time::Instant::now() < deadline {
                        continue;
                    }
                }
                return Err(format!("Could not add the Unity helper: {error}. Existing files were not replaced. Close other apps using this project folder and try again."));
            }
        }
    }
    unreachable!("the final publication attempt returns its result")
}
fn helper_snapshot(folder: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let mut folders = vec![folder.to_path_buf()];
    let mut count = 0;
    while let Some(current) = folders.pop() {
        reject_links(&current)?;
        for entry in fs::read_dir(current).map_err(|_| "Could not inspect the helper backup.")? {
            let path = entry
                .map_err(|_| "Could not inspect the helper backup.")?
                .path();
            count += 1;
            if count > 64 {
                return Err("Helper backup exceeds its file limit.".into());
            }
            reject_links(&path)?;
            let relative = path
                .strip_prefix(folder)
                .map_err(|_| "Invalid helper backup path.")?
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                files.insert(format!("{relative}/"), Vec::new());
                folders.push(path);
            } else {
                files.insert(relative, read(&path, 256 * 1024)?);
            }
        }
    }
    Ok(files)
}
fn upgrade_helper(
    target: &Target,
    staging: &Path,
    publish: impl FnOnce(&Target, &Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let checked = fresh(target)?;
    if checked.open || checked.helper != "outdated" {
        return Err("The project or old helper changed. Refresh projects before updating.".into());
    }
    let root = Path::new(&checked.path);
    let destination = root.join(PACKAGE);
    let before = helper_snapshot(&destination)?;
    // Preserve Unity's GUID/import metadata without copying executable files into staging.
    for (name, bytes) in &before {
        if name.ends_with(".meta") {
            save_new(&staging.join(name), bytes)?;
        }
    }
    if helper_contents(staging, true)? != "installed" {
        return Err("Staged helper changed. Nothing was updated.".into());
    }
    let backup_root = area(root, "helper-backups")?;
    fs::create_dir_all(&backup_root).map_err(|_| "Could not create the helper backup folder.")?;
    let backup_owner = tempfile::Builder::new()
        .prefix("upgrade-")
        .tempdir_in(&backup_root)
        .map_err(|_| "Could not reserve a helper backup.")?;
    // Keep the backup even on failure; it is never a disposable temporary directory.
    let backup = backup_owner.keep().join("com.creatorworks.plugins");
    let latest = fresh(target)?;
    if latest.open || latest.helper != "outdated" || helper_snapshot(&destination)? != before {
        return Err("The project or helper changed before backup. Nothing was updated.".into());
    }
    reject_links(&backup)?;
    publish_directory(&destination, &backup).map_err(|error| {
        format!("Could not back up the old helper: {error}. Nothing was updated.")
    })?;
    let result = (|| {
        if helper_contents(&backup, true)? != "outdated" || helper_snapshot(&backup)? != before {
            return Err("The old helper changed during backup.".into());
        }
        publish(&checked, staging)
    })();
    if let Err(error) = result {
        // Never replace a directory another app/user created after the backup.
        let restored = reject_links(&destination)
            .and_then(|_| reject_links(&backup))
            .and_then(|_| publish_directory(&backup, &destination).map_err(|e| e.to_string()));
        return Err(if restored.is_ok() {
            format!("{error} The previous helper was restored; no update was installed.")
        } else {
            format!("{error} Existing files were not replaced. Your previous helper is preserved at {}. Close Unity and restore that folder before continuing.", backup.display())
        });
    }
    Ok(backup)
}
fn install(target: &Target) -> Result<(), String> {
    let approved_helper = target.helper.clone();
    let target = fresh(target)?;
    let root = Path::new(&target.path);
    if target.helper == "installed" {
        return Ok(());
    }
    if target.helper == "outdated" && approved_helper != "outdated" {
        return Err("The helper changed after selection. Refresh projects before updating.".into());
    }
    if !matches!(target.helper.as_str(), "missing" | "outdated") {
        return Err(
            "Existing Creator Plugins files differ from this build. They were not overwritten."
                .into(),
        );
    }
    if target.open {
        return Err("Close this project's Unity Editor before adding or updating its Creator Plugins menu. No lock file was removed.".into());
    }
    let _guard = operation(root)?;
    let staging = tempfile::Builder::new()
        .prefix(".helper-")
        .tempdir_in(area(root, "")?)
        .map_err(|_| "Could not stage the Unity helper.")?;
    for (name, bytes) in FILES {
        save_new(&staging.path().join(name), bytes)?;
    }
    if target.helper == "outdated" {
        upgrade_helper(&target, staging.path(), |target, staging| {
            publish_helper(target, staging, std::thread::sleep)
        })
        .map(|_| ())
    } else {
        publish_helper(&target, staging.path(), std::thread::sleep)
    }
}
pub fn install_worker(handle: tauri::AppHandle, project_id: String) -> Result<String, String> {
    crate::community::require_import_preview()?;
    let target = selected(&handle, &project_id)?;
    if target.helper == "installed" {
        return Ok("The matching Creator Plugins menu is already installed.".into());
    }
    if !matches!(target.helper.as_str(), "missing" | "outdated") || target.open {
        return install(&target).map(|_| String::new());
    }
    let upgrading = target.helper == "outdated";
    let (title, action, detail) = if upgrading {
        ("Update Unity menu", "Update menu", "The recognized old helper will be backed up under .creator-plugins/helper-backups before replacement. Unity metadata is preserved. Locally modified or unknown helper files will not be overwritten.")
    } else {
        (
            "Add Unity menu",
            "Add menu",
            "Existing files will not be overwritten.",
        )
    };
    let approved = handle.dialog().message(format!("{action} for {}?\n\n{}\n\nThis changes only the Editor package at {}. Its code runs when Unity opens this project. It does not install MCP, import community assets or save scenes. {detail}", target.name, target.path, PACKAGE)).title(title).kind(MessageDialogKind::Info).buttons(MessageDialogButtons::OkCancelCustom(action.into(), "Cancel".into())).blocking_show();
    if !approved {
        return Ok("Menu installation cancelled. No project files were changed.".into());
    }
    // Do not turn an approved fresh install into an upgrade if the target changes.
    if fresh(&target)?.helper != target.helper {
        return Err(
            "The helper changed after confirmation. Refresh projects and review it again.".into(),
        );
    }
    install(&target)?;
    remember(&handle, inspect(Path::new(&target.path))?)?;
    Ok(if upgrading {
        "Creator Plugins menu updated. The previous helper is backed up under .creator-plugins/helper-backups. Open Unity, then choose Creator Plugins > Browse."
    } else {
        "Creator Plugins menu added. Open this project in Unity, then choose Creator Plugins > Browse."
    }.into())
}
fn validate_request(request: &ImportRequest, root: &Path) -> Result<(), String> {
    let expected = canonical(root)?.to_string_lossy().into_owned();
    let same = if cfg!(windows) {
        expected.eq_ignore_ascii_case(&request.project_path)
    } else {
        expected == request.project_path
    };
    if request.schema_version != 1
        || !hex(&request.request_id, 32)
        || !hex(&request.sha256, 64)
        || !same
        || request.package_file != format!("{}.unitypackage", request.sha256)
        || request.byte_length == 0
        || request.byte_length > MAX_PACKAGE
        || request.package_id.len() > 100
        || !request.package_id.contains('.')
        || !request
            .package_id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        || !request
            .package_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
        || semver::Version::parse(&request.version).is_err()
        || request.name.trim().is_empty()
        || request.name.len() > 120
        || request
            .name
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("Invalid project import request.".into());
    }
    Ok(())
}
fn receipt(root: &Path, request_id: &str) -> Result<Option<Receipt>, String> {
    if !hex(request_id, 32) {
        return Err("Invalid import request identifier.".into());
    }
    let file = area(root, &format!("receipts/{request_id}.json"))?;
    if !file.exists() {
        return Ok(None);
    }
    decode_receipt(&read(&file, 16 * 1024)?, request_id).map(Some)
}
fn decode_receipt(bytes: &[u8], request_id: &str) -> Result<Receipt, String> {
    let result: Receipt = serde_json::from_slice(bytes)
        .map_err(|_| "Unity import receipt is invalid. Its outcome is unknown.")?;
    if result.schema_version != 1
        || result.request_id != request_id
        || !["queued", "review", "imported", "cancelled", "failed"]
            .contains(&result.status.as_str())
        || result.message.trim().is_empty()
        || result.message.encode_utf16().count() > 4000
        || result
            .message
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(
            "Unity import receipt did not match this request. Its outcome is unknown.".into(),
        );
    }
    Ok(result)
}
fn prepare_inbox(root: &Path, package_id: &str) -> Result<(), String> {
    let inbox = area(root, "inbox")?;
    if !inbox.exists() {
        return Ok(());
    }
    let mut completed = Vec::new();
    let mut unresolved = 0;
    let mut duplicate = false;
    // Validate the entire bounded snapshot before moving any terminal requests.
    for (index, entry) in fs::read_dir(&inbox)
        .map_err(|_| "Plugin inbox cannot be read.")?
        .enumerate()
    {
        if index >= 1000 {
            return Err(
                "Plugin inbox exceeds its recovery limit. Existing history was preserved.".into(),
            );
        }
        let path = entry.map_err(|_| "Plugin inbox cannot be read.")?.path();
        let bytes = read(&path, 16 * 1024)?;
        let prior: ImportRequest = serde_json::from_slice(&bytes).map_err(|_| {
            "An existing plugin request is invalid. Existing history was preserved."
        })?;
        validate_request(&prior, root)?;
        if path.file_name().unwrap_or_default().to_string_lossy()
            != format!("{}.json", prior.request_id)
        {
            return Err("Plugin inbox filename does not match its request.".into());
        }
        let archived = area(root, &format!("history/requests/{}.json", prior.request_id))?;
        if archived.exists() {
            return Err(
                "A plugin request exists in both inbox and history. Existing files were preserved."
                    .into(),
            );
        }
        let receipt_path = area(root, &format!("receipts/{}.json", prior.request_id))?;
        let receipt_bytes = if receipt_path.exists() {
            Some(read(&receipt_path, 16 * 1024)?)
        } else {
            None
        };
        let result = receipt_bytes
            .as_ref()
            .map(|bytes| decode_receipt(bytes, &prior.request_id))
            .transpose()?;
        match result {
            Some(result)
                if matches!(result.status.as_str(), "imported" | "cancelled" | "failed") =>
            {
                completed.push((path, archived, bytes, receipt_path, receipt_bytes.unwrap()))
            }
            Some(_) => return Err(
                "An older intermediate receipt needs inspection in Unity. No history was changed."
                    .into(),
            ),
            None => {
                unresolved += 1;
                duplicate |= prior.package_id == package_id;
            }
        }
    }
    if unresolved >= 100 {
        return Err("The plugin inbox is full with 100 unresolved requests. Finish or cancel existing imports before adding another.".into());
    }
    if duplicate {
        return Err("This package already has an unresolved Unity request. Review that request before adding it again.".into());
    }
    for (source, destination, bytes, receipt_path, receipt_bytes) in completed {
        fs::create_dir_all(destination.parent().unwrap())
            .map_err(|_| "Could not create plugin history.")?;
        reject_links(&destination)?;
        if read(&source, 16 * 1024)? != bytes || read(&receipt_path, 16 * 1024)? != receipt_bytes {
            return Err(
                "A plugin request changed before archival. No new import was queued.".into(),
            );
        }
        publish_directory(&source, &destination).map_err(|e| {
            format!("Could not retain completed import history: {e}. No new import was queued.")
        })?;
        if read(&destination, 16 * 1024)? != bytes {
            return Err("A plugin request changed during archival. Inspect its preserved history before continuing.".into());
        }
    }
    Ok(())
}
#[cfg(test)]
pub fn queue(
    target: &Target,
    package_id: &str,
    version: &str,
    name: &str,
    sha256: &str,
    bytes: &[u8],
) -> Result<Outcome, String> {
    queue_stream(
        target,
        package_id,
        version,
        name,
        sha256,
        &mut std::io::Cursor::new(bytes),
        bytes.len() as u64,
    )
}

pub fn queue_stream(
    target: &Target,
    package_id: &str,
    version: &str,
    name: &str,
    sha256: &str,
    source: &mut (impl Read + Seek),
    byte_length: u64,
) -> Result<Outcome, String> {
    let target = fresh(target)?;
    let root = Path::new(&target.path);
    if target.helper != "installed" {
        return Err("Add the matching Unity menu to this project before sending packages.".into());
    }
    if !hex(sha256, 64) || byte_length == 0 || byte_length > MAX_PACKAGE {
        return Err("Package checksum did not match. Nothing was queued.".into());
    }
    crate::community::transfer::verify(source, byte_length, sha256)?;
    let _guard = operation(root)?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Could not create an import request identifier.")?;
    let request_id: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let request = ImportRequest {
        schema_version: 1,
        request_id: request_id.clone(),
        project_path: target.path.clone(),
        package_id: package_id.into(),
        version: version.into(),
        name: name.into(),
        byte_length,
        sha256: sha256.into(),
        package_file: format!("{sha256}.unitypackage"),
    };
    validate_request(&request, root)?;
    let file = area(root, &format!("packages/{}", request.package_file))?;
    if file.exists() {
        reject_links(&file)?;
        let mut cache = fs::File::open(&file).map_err(|_| "Cannot read cached package.")?;
        crate::community::transfer::verify(&mut cache, byte_length, sha256)
            .map_err(|_| "The existing cached package differs. It was not overwritten.")?;
    }
    fresh(&target)?;
    prepare_inbox(root, package_id)?;
    if !file.exists() {
        let parent = file.parent().ok_or("Invalid package cache.")?;
        fs::create_dir_all(parent).map_err(|_| "Cannot create package cache.")?;
        reject_links(&file)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot create package cache file.")?;
        let copied = std::io::copy(&mut source.take(byte_length + 1), temp.as_file_mut())
            .map_err(|_| "Could not cache package. Check free disk space.")?;
        if copied != byte_length {
            return Err("Package changed during caching.".into());
        }
        crate::community::transfer::verify(temp.as_file_mut(), byte_length, sha256)?;
        temp.as_file()
            .sync_all()
            .map_err(|_| "Could not finish caching package.")?;
        reject_links(&file)?;
        temp.persist_noclobber(&file).map_err(|_| {
            "Package cache already exists or could not be saved. Nothing was overwritten."
        })?;
    }
    if fresh(&target)?.helper != "installed" {
        return Err("The Unity helper changed. No import request was sent.".into());
    }
    save_new(
        &area(root, &format!("inbox/{request_id}.json"))?,
        &serde_json::to_vec(&request).map_err(|_| "Could not encode the import request.")?,
    )?;
    Ok(Outcome { project_id: target.id, request_id, status: "queued".into(), message: "Queued, not imported. In this project's Unity Editor, open Creator Plugins > Browse and choose Import into project.".into() })
}
pub fn status_worker(
    handle: tauri::AppHandle,
    project_id: String,
    request_id: String,
) -> Result<Outcome, String> {
    let target = selected(&handle, &project_id)?;
    status(&target, &request_id)
}
fn status(target: &Target, request_id: &str) -> Result<Outcome, String> {
    if !hex(request_id, 32) {
        return Err("Invalid import request identifier.".into());
    }
    let root = Path::new(&target.path);
    let _guard = operation(root)?;
    let inbox = area(root, &format!("inbox/{request_id}.json"))?;
    let history = area(root, &format!("history/requests/{request_id}.json"))?;
    if inbox.exists() && history.exists() {
        return Err(
            "A plugin request exists in both inbox and history. Its outcome is unknown.".into(),
        );
    }
    let archived = !inbox.exists();
    let request: ImportRequest =
        serde_json::from_slice(&read(if archived { &history } else { &inbox }, 16 * 1024)?)
            .map_err(|_| "Import request is invalid.")?;
    validate_request(&request, root)?;
    if request.request_id != request_id {
        return Err("Import request identity changed.".into());
    }
    let (state, message) = match receipt(root, request_id)? {
        Some(r) if matches!(r.status.as_str(), "imported" | "cancelled" | "failed") => (r.status, r.message),
        Some(_) => return Err("This request has an older intermediate receipt. It was preserved; inspect its outcome in Unity before continuing. No import was retried.".into()),
        None => {
            if archived { return Err("Archived plugin request has no final receipt. Its outcome is unknown.".into()); }
            let active_path = area(root, "active-review.json")?;
            let active = if active_path.exists() {
                let active: ImportRequest = serde_json::from_slice(&read(&active_path, 16 * 1024)?)
                    .map_err(|_| "Active Unity review is invalid. Its outcome is unknown.")?;
                validate_request(&active, root)?;
                Some(active)
            } else { None };
            if let Some(active) = active.filter(|r| r.request_id == request_id) {
                if active != request {
                    return Err("Active Unity review differs from the queued request. Its outcome is unknown.".into());
                }
                ("review".into(), "Unity review is active. Waiting for the matching final import outcome; no import success is assumed.".into())
            } else {
                ("queued".into(), "Waiting for Unity. Open this project, then Creator Plugins > Browse. No import has been confirmed.".into())
            }
        }
    };
    Ok(Outcome {
        project_id: target.id.clone(),
        request_id: request_id.into(),
        status: state,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grid_helper_gallery_upgrade_backs_up_and_rejects_user_edits() {
        let old: &[(&str, &[u8])] = &[
            ("package.json", include_bytes!("../../tests/fixtures/helper-stable-0.1.6/unity/com.creatorworks.plugins/package.json")),
            ("LICENSE.md", include_bytes!("../../tests/fixtures/helper-stable-0.1.6/unity/com.creatorworks.plugins/LICENSE.md")),
            ("Editor/CreatorWorks.Plugins.Editor.asmdef", include_bytes!("../../tests/fixtures/helper-stable-0.1.6/unity/com.creatorworks.plugins/Editor/CreatorWorks.Plugins.Editor.asmdef")),
            ("Editor/CreatorPluginsWindow.cs", include_bytes!("../../tests/fixtures/helper-stable-0.1.6/unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs")),
        ];
        for modified in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            project(temp.path());
            for ((name, bytes), hash) in old.iter().zip(GRID_HASHES) {
                assert_eq!(digest(bytes), *hash);
                save_new(&temp.path().join(PACKAGE).join(name), bytes).unwrap();
            }
            if modified {
                fs::write(
                    temp.path()
                        .join(PACKAGE)
                        .join("Editor/CreatorPluginsWindow.cs"),
                    b"user edits",
                )
                .unwrap();
            }
            let before = helper_snapshot(&temp.path().join(PACKAGE)).unwrap();
            let target = inspect(temp.path()).unwrap();
            assert_eq!(
                target.helper,
                if modified { "different" } else { "outdated" }
            );
            if modified {
                assert!(install(&target).is_err());
                assert_eq!(helper_snapshot(&temp.path().join(PACKAGE)).unwrap(), before);
            } else {
                install(&target).unwrap();
                assert_eq!(helper_state(temp.path()).unwrap(), "installed");
                let backup = fs::read_dir(area(temp.path(), "helper-backups").unwrap())
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                assert_eq!(
                    helper_snapshot(&backup.join("com.creatorworks.plugins")).unwrap(),
                    before
                );
            }
        }
    }
    const STABLE_FILES: &[(&str, &[u8])] = &[
        ("package.json", include_bytes!("../../tests/fixtures/helper-stable-0.1.0/unity/com.creatorworks.plugins/package.json")),
        ("LICENSE.md", include_bytes!("../../tests/fixtures/helper-stable-0.1.0/unity/com.creatorworks.plugins/LICENSE.md")),
        ("Editor/CreatorWorks.Plugins.Editor.asmdef", include_bytes!("../../tests/fixtures/helper-stable-0.1.0/unity/com.creatorworks.plugins/Editor/CreatorWorks.Plugins.Editor.asmdef")),
        ("Editor/CreatorPluginsWindow.cs", include_bytes!("../../tests/fixtures/helper-stable-0.1.0/unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs")),
    ];
    #[test]
    fn stable_helper_grid_upgrade_preserves_backup_and_refuses_modified_or_mixed_files() {
        for mutation in ["none", "modified", "mixed"] {
            let temp = tempfile::tempdir().unwrap();
            project(temp.path());
            for ((name, bytes), hash) in STABLE_FILES.iter().zip(STABLE_HASHES) {
                assert_eq!(digest(bytes), *hash, "stable fixture changed: {name}");
                save_new(&temp.path().join(PACKAGE).join(name), bytes).unwrap();
            }
            let package = temp.path().join(PACKAGE);
            save_new(&package.join("Editor.meta"), b"guid: stable-folder\n").unwrap();
            if mutation == "modified" {
                fs::write(package.join("Editor/CreatorPluginsWindow.cs"), "user edits").unwrap();
            } else if mutation == "mixed" {
                fs::write(package.join("package.json"), OLD_FILES[0].1).unwrap();
            }
            let before = helper_snapshot(&package).unwrap();
            let target = inspect(temp.path()).unwrap();
            if mutation == "none" {
                assert_eq!(target.helper, "outdated");
                install(&target).unwrap();
                assert_eq!(helper_state(temp.path()).unwrap(), "installed");
                let backups: Vec<_> = fs::read_dir(area(temp.path(), "helper-backups").unwrap())
                    .unwrap()
                    .map(Result::unwrap)
                    .collect();
                assert_eq!(backups.len(), 1);
                assert_eq!(
                    helper_snapshot(&backups[0].path().join("com.creatorworks.plugins")).unwrap(),
                    before
                );
                assert_eq!(
                    fs::read(package.join("Editor.meta")).unwrap(),
                    b"guid: stable-folder\n"
                );
                assert_eq!(
                    fs::read_to_string(temp.path().join("Assets/Manual.unity")).unwrap(),
                    "manually arranged scene"
                );
            } else {
                assert_eq!(target.helper, "different");
                assert!(install(&target).is_err());
                assert_eq!(helper_snapshot(&package).unwrap(), before);
            }
        }
    }
    const OLD_FILES: &[(&str, &[u8])] = &[
        ("package.json", include_bytes!("../../tests/fixtures/helper-alpha8/unity/com.creatorworks.plugins/package.json")),
        ("LICENSE.md", include_bytes!("../../tests/fixtures/helper-alpha8/unity/com.creatorworks.plugins/LICENSE.md")),
        ("Editor/CreatorWorks.Plugins.Editor.asmdef", include_bytes!("../../tests/fixtures/helper-alpha8/unity/com.creatorworks.plugins/Editor/CreatorWorks.Plugins.Editor.asmdef")),
        ("Editor/CreatorPluginsWindow.cs", include_bytes!("../../tests/fixtures/helper-alpha8/unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs")),
    ];
    fn old_helper(root: &Path) -> Target {
        project(root);
        for ((name, bytes), expected) in OLD_FILES.iter().zip(LEGACY_HASHES) {
            assert_eq!(digest(bytes), *expected, "legacy fixture changed: {name}");
            save_new(&root.join(PACKAGE).join(name), bytes).unwrap();
        }
        save_new(
            &root.join(PACKAGE).join("Editor.meta"),
            b"guid: retained-folder\n",
        )
        .unwrap();
        save_new(
            &root
                .join(PACKAGE)
                .join("Editor/CreatorPluginsWindow.cs.meta"),
            b"guid: retained-script\n",
        )
        .unwrap();
        inspect(root).unwrap()
    }
    fn current_staging(root: &Path) -> tempfile::TempDir {
        let staging = tempfile::tempdir_in(root).unwrap();
        for (name, bytes) in FILES {
            save_new(&staging.path().join(name), bytes).unwrap();
        }
        staging
    }
    #[test]
    fn known_helper_upgrade_backs_up_exact_files_and_preserves_metadata_and_project() {
        let temp = tempfile::tempdir().unwrap();
        let target = old_helper(temp.path());
        assert_eq!(target.helper, "outdated");
        let before = helper_snapshot(&temp.path().join(PACKAGE)).unwrap();
        let manifest = fs::read(temp.path().join("Packages/manifest.json")).unwrap();
        install(&target).unwrap();
        assert_eq!(helper_state(temp.path()).unwrap(), "installed");
        let backups = fs::read_dir(area(temp.path(), "helper-backups").unwrap())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            helper_snapshot(&backups[0].path().join("com.creatorworks.plugins")).unwrap(),
            before
        );
        for (name, bytes) in before.iter().filter(|(name, _)| name.ends_with(".meta")) {
            assert_eq!(
                fs::read(temp.path().join(PACKAGE).join(name)).unwrap(),
                *bytes
            );
        }
        assert_eq!(
            fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("Assets/Manual.unity")).unwrap(),
            "manually arranged scene"
        );
    }
    #[test]
    fn unknown_or_open_old_helper_never_moves() {
        for mutation in ["code", "extra", "open"] {
            let temp = tempfile::tempdir().unwrap();
            let target = old_helper(temp.path());
            let mut editor = None;
            match mutation {
                "code" => fs::write(
                    temp.path()
                        .join(PACKAGE)
                        .join("Editor/CreatorPluginsWindow.cs"),
                    "custom code",
                )
                .unwrap(),
                "extra" => fs::write(
                    temp.path().join(PACKAGE).join("Editor/User.cs"),
                    "custom code",
                )
                .unwrap(),
                _ => {
                    fs::create_dir(temp.path().join("Temp")).unwrap();
                    fs::write(temp.path().join("Temp/UnityLockfile"), "").unwrap();
                    editor = Some(hold_editor(temp.path()));
                }
            }
            let before = helper_snapshot(&temp.path().join(PACKAGE)).unwrap();
            assert!(install(&target).is_err());
            assert_eq!(helper_snapshot(&temp.path().join(PACKAGE)).unwrap(), before);
            assert!(!area(temp.path(), "helper-backups").unwrap().exists());
            drop(editor);
        }
    }
    #[test]
    fn failed_upgrade_restores_the_complete_previous_helper() {
        let temp = tempfile::tempdir().unwrap();
        let target = old_helper(temp.path());
        let before = helper_snapshot(&temp.path().join(PACKAGE)).unwrap();
        let staging = current_staging(temp.path());
        let error = upgrade_helper(&target, staging.path(), |_, _| {
            Err("Fixture publication failure.".into())
        })
        .unwrap_err();
        assert!(error.contains("previous helper was restored"));
        assert_eq!(helper_snapshot(&temp.path().join(PACKAGE)).unwrap(), before);
    }
    #[test]
    fn failed_upgrade_preserves_backup_and_a_raced_destination() {
        let temp = tempfile::tempdir().unwrap();
        let target = old_helper(temp.path());
        let before = helper_snapshot(&temp.path().join(PACKAGE)).unwrap();
        let staging = current_staging(temp.path());
        let error = upgrade_helper(&target, staging.path(), |_, _| {
            fs::create_dir(temp.path().join(PACKAGE)).unwrap();
            fs::write(temp.path().join(PACKAGE).join("User.cs"), "raced user data").unwrap();
            Err("Fixture raced destination.".into())
        })
        .unwrap_err();
        assert!(error.contains("previous helper is preserved at"));
        assert_eq!(
            fs::read_to_string(temp.path().join(PACKAGE).join("User.cs")).unwrap(),
            "raced user data"
        );
        let backup = fs::read_dir(area(temp.path(), "helper-backups").unwrap())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            helper_snapshot(&backup.join("com.creatorworks.plugins")).unwrap(),
            before
        );
    }
    #[test]
    fn fresh_install_selection_never_silently_authorizes_an_upgrade() {
        let temp = tempfile::tempdir().unwrap();
        let missing = project(temp.path());
        old_helper(temp.path());
        assert!(install(&missing).unwrap_err().contains("after selection"));
        assert_eq!(helper_state(temp.path()).unwrap(), "outdated");
    }
    #[test]
    #[ignore = "Explicit concurrent filesystem diagnostic; preserves only failed disposable fixtures"]
    fn stress_helper_publication() {
        let failures = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let failures = &failures;
                scope.spawn(move || {
                    for _ in 0..25 {
                        let fixture = tempfile::tempdir().unwrap();
                        let target = project(fixture.path());
                        if let Err(error) = install(&target) {
                            let path = fixture.keep();
                            failures
                                .lock()
                                .unwrap()
                                .push(format!("{}: {error}", path.display()));
                        }
                    }
                });
            }
        });
        let failures = failures.into_inner().unwrap();
        assert!(
            failures.is_empty(),
            "Failed fixture evidence: {failures:#?}"
        );
    }
    #[test]
    #[ignore = "Creates a new disposable native-to-Unity fixture from three explicitly pinned harmless test exports; no Unity launch"]
    fn prepare_native_unity_acceptance() {
        let unity_version = std::env::var("CREATOR_PLUGIN_TEST_UNITY_VERSION")
            .unwrap_or_else(|_| "6000.3.21f1".into());
        assert!(matches!(
            unity_version.as_str(),
            "2022.3.39f1" | "6000.3.21f1"
        ));
        let source = PathBuf::from(
            std::env::var_os("CREATOR_PLUGIN_TEST_EXPORTS")
                .expect("Set the directory containing the three reviewed fixture exports"),
        );
        let exports = [
            (
                "01 Cancel check",
                "cf44ff0b807bca2b44523d1b0cf1388614a362171ac589d7f045c4c35c16c0e6",
            ),
            (
                "02 Text import check",
                "167d85162873ff3653c2ac654616df900e0d15cfe07877d7d3e65cba60c489a6",
            ),
            (
                "03 C# import check",
                "d6340d1ed6c8d7aa31ba0de3c4ed4d699286d7ef568a88e4199315a60d445d96",
            ),
        ];
        let payloads: Vec<_> = exports
            .iter()
            .enumerate()
            .map(|(index, (_, expected))| {
                let bytes = read(
                    &source.join(format!("fixture-{}.unitypackage", index + 1)),
                    MAX_PACKAGE,
                )
                .unwrap();
                assert_eq!(
                    digest(&bytes),
                    *expected,
                    "Only the reviewed harmless exports may be used"
                );
                bytes
            })
            .collect();
        let artifacts = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("artifacts");
        fs::create_dir_all(&artifacts).unwrap();
        let fixture = tempfile::Builder::new()
            .prefix("plugins-native-")
            .tempdir_in(&artifacts)
            .unwrap();
        let root = fixture.path();
        for folder in ["Assets", "Packages", "ProjectSettings"] {
            fs::create_dir(root.join(folder)).unwrap();
        }
        save_new(
            &root.join("Packages/manifest.json"),
            br#"{"dependencies":{}}"#,
        )
        .unwrap();
        save_new(
            &root.join("ProjectSettings/ProjectVersion.txt"),
            format!("m_EditorVersion: {unity_version}\n").as_bytes(),
        )
        .unwrap();
        save_new(
            &root.join(".creator-plugins-interactive-fixture"),
            b"Disposable native writer/import test only.\n",
        )
        .unwrap();
        let target = inspect(root).unwrap();
        install(&target).unwrap();
        let mut outcomes = Vec::new();
        for (index, ((name, hash), bytes)) in exports.iter().zip(&payloads).enumerate() {
            let result = queue(
                &target,
                &format!("fixture.native-{}", index + 1),
                "1.0.0",
                name,
                hash,
                bytes,
            )
            .unwrap();
            assert_eq!(result.status, "queued");
            outcomes.push(result);
        }
        let report = serde_json::json!({ "projectPath": target.path, "helperSha256": digest(FILES[3].1), "requests": outcomes });
        save_new(
            &root.join("native-writer-result.json"),
            &serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        let kept = fixture.keep();
        println!("NATIVE_UNITY_FIXTURE={}\n{}", kept.display(), report);
    }
    fn project(root: &Path) -> Target {
        for folder in ["Assets", "Packages", "ProjectSettings"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        fs::write(
            root.join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 6000.3.21f1\n",
        )
        .unwrap();
        fs::write(
            root.join("Packages/manifest.json"),
            r#"{"dependencies":{"com.sidequest.creator-sdk":"4.0.14"}}"#,
        )
        .unwrap();
        fs::write(root.join("Assets/Manual.unity"), "manually arranged scene").unwrap();
        inspect(root).unwrap()
    }
    #[test]
    #[ignore = "Creates a new disposable Unity fixture and queues the explicitly selected, hash-pinned 93 MB package; does not launch Unity"]
    fn prepare_large_import_acceptance() {
        let source = std::env::var_os("CREATOR_PLUGIN_LARGE_PACKAGE")
            .expect("Select the verified package file");
        let mut file = fs::File::open(source).unwrap();
        let hash = "b9a99519a74bdbd5d75d997bed87118896c39a4d712b9ff708e63520ea4fdf94";
        crate::community::transfer::verify(&mut file, 93_245_650, hash).unwrap();
        let artifacts = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("artifacts");
        fs::create_dir_all(&artifacts).unwrap();
        let fixture = tempfile::Builder::new()
            .prefix("plugins-large-")
            .tempdir_in(&artifacts)
            .unwrap();
        let root = fixture.path();
        project(root);
        fs::rename(
            root.join("Assets/Manual.unity"),
            root.join("Assets/Manual.txt"),
        )
        .unwrap();
        fs::write(root.join("Packages/manifest.json"), br#"{"dependencies":{"com.unity.render-pipelines.universal":"17.3.0","com.unity.probuilder":"6.1.2","com.unity.modules.uielements":"1.0.0"}}"#).unwrap();
        let target = inspect(root).unwrap();
        install(&target).unwrap();
        save_new(
            &root.join(".large-package-test-fixture"),
            b"Disposable opt-in import test",
        )
        .unwrap();
        let outcome = queue_stream(
            &target,
            "fixture.warehouse-loft",
            "0.1.0",
            "Warehouse Loft streaming acceptance",
            hash,
            &mut file,
            93_245_650,
        )
        .unwrap();
        assert_eq!(outcome.status, "queued");
        save_new(
            &root.join("native-queue-result.json"),
            &serde_json::to_vec_pretty(&outcome).unwrap(),
        )
        .unwrap();
        fs::create_dir_all(root.join("Assets/Editor/PluginTests")).unwrap();
        for name in [
            "CreatorPluginsLargeImportSmoke.cs",
            "CreatorWorks.Plugins.Editor.Tests.asmdef",
        ] {
            fs::copy(
                artifacts.parent().unwrap().join("scripts/unity").join(name),
                root.join("Assets/Editor/PluginTests").join(name),
            )
            .unwrap();
        }
        println!("LARGE_IMPORT_FIXTURE={}", fixture.keep().display());
    }
    fn hold_editor(root: &Path) -> fs::File {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        #[cfg(unix)]
        options.write(true);
        let file = options.open(root.join("Temp/UnityLockfile")).unwrap();
        #[cfg(unix)]
        {
            use fs2::FileExt;
            file.lock_exclusive().unwrap();
        }
        file
    }
    #[test]
    fn stale_editor_lock_is_preserved_and_does_not_block_menu_installation() {
        let temp = tempfile::tempdir().unwrap();
        project(temp.path());
        fs::create_dir(temp.path().join("Temp")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        fs::write(&lock, "stale lock fixture").unwrap();
        let held = hold_editor(temp.path());
        assert!(inspect(temp.path()).unwrap().open);
        drop(held);
        let target = inspect(temp.path()).unwrap();
        assert!(!target.open);
        install(&target).unwrap();
        assert_eq!(fs::read_to_string(lock).unwrap(), "stale lock fixture");
        assert_eq!(
            fs::read_to_string(temp.path().join("Assets/Manual.unity")).unwrap(),
            "manually arranged scene"
        );
    }
    #[test]
    fn helper_install_is_editor_only_and_preserves_existing_content() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        let manifest = fs::read(temp.path().join("Packages/manifest.json")).unwrap();
        install(&target).unwrap();
        assert_eq!(helper_state(temp.path()).unwrap(), "installed");
        install(&target).unwrap();
        assert_eq!(
            fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("Assets/Manual.unity")).unwrap(),
            "manually arranged scene"
        );
        let asm: serde_json::Value = serde_json::from_slice(FILES[2].1).unwrap();
        assert_eq!(asm["includePlatforms"], serde_json::json!(["Editor"]));
        fs::write(
            temp.path().join(PACKAGE).join("package.json"),
            "user edited helper",
        )
        .unwrap();
        assert!(install(&target).unwrap_err().contains("not overwritten"));
        assert_eq!(
            fs::read_to_string(temp.path().join(PACKAGE).join("package.json")).unwrap(),
            "user edited helper"
        );
    }
    #[test]
    fn open_or_changed_projects_cannot_install() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        fs::create_dir(temp.path().join("Temp")).unwrap();
        fs::write(temp.path().join("Temp/UnityLockfile"), "").unwrap();
        let held = hold_editor(temp.path());
        assert!(install(&target).is_err());
        assert!(!temp.path().join(PACKAGE).exists());
        drop(held);
        fs::remove_file(temp.path().join("Temp/UnityLockfile")).unwrap();
        fs::write(
            temp.path().join("Packages/manifest.json"),
            r#"{"dependencies":{}}"#,
        )
        .unwrap();
        assert!(install(&target).unwrap_err().contains("changed"));
        assert!(!temp.path().join(PACKAGE).exists());
    }
    #[test]
    fn queue_is_external_bound_and_never_claims_import() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        install(&target).unwrap();
        let bytes = b"harmless test fixture";
        let hash = digest(bytes);
        assert!(queue(
            &target,
            "test.graph",
            "1.0.0",
            "Test",
            &"0".repeat(64),
            bytes
        )
        .is_err());
        let outcome = queue(&target, "test.graph", "1.0.0", "Test", &hash, bytes).unwrap();
        assert_eq!(outcome.status, "queued");
        assert!(status(&target, &outcome.request_id)
            .unwrap()
            .message
            .contains("No import"));
        assert!(queue(&target, "test.graph", "1.0.0", "Test", &hash, bytes).is_err());
        assert_eq!(
            fs::read(
                temp.path()
                    .join(AREA)
                    .join(format!("packages/{hash}.unitypackage"))
            )
            .unwrap(),
            bytes
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("Assets/Manual.unity")).unwrap(),
            "manually arranged scene"
        );
        let r = Receipt {
            schema_version: 1,
            request_id: outcome.request_id.clone(),
            status: "cancelled".into(),
            message: "Unity cancelled the import.".into(),
        };
        save_new(
            &area(
                temp.path(),
                &format!("receipts/{}.json", outcome.request_id),
            )
            .unwrap(),
            &serde_json::to_vec(&r).unwrap(),
        )
        .unwrap();
        assert_eq!(
            status(&target, &outcome.request_id).unwrap().status,
            "cancelled"
        );
        assert!(queue(&target, "test.graph", "1.0.0", "Test", &hash, bytes).is_ok());
        assert!(status(&target, "../../escape").is_err());
        fs::write(
            area(
                temp.path(),
                &format!("receipts/{}.json", outcome.request_id),
            )
            .unwrap(),
            "{}",
        )
        .unwrap();
        assert!(status(&target, &outcome.request_id).is_err());
    }
    #[test]
    fn cached_user_file_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        install(&target).unwrap();
        let hash = digest(b"fixture");
        let file = area(temp.path(), &format!("packages/{hash}.unitypackage")).unwrap();
        save_new(&file, b"existing user bytes").unwrap();
        assert!(queue(&target, "test.graph", "1.0.0", "Test", &hash, b"fixture").is_err());
        assert_eq!(fs::read(file).unwrap(), b"existing user bytes");
    }
    fn queued_fixture(root: &Path) -> (Target, ImportRequest) {
        let target = project(root);
        install(&target).unwrap();
        let outcome = queue(
            &target,
            "fixture.status",
            "1.0.0",
            "Test",
            &digest(b"fixture"),
            b"fixture",
        )
        .unwrap();
        let request = serde_json::from_slice(
            &read(
                &area(root, &format!("inbox/{}.json", outcome.request_id)).unwrap(),
                16 * 1024,
            )
            .unwrap(),
        )
        .unwrap();
        (target, request)
    }
    #[test]
    fn status_derives_review_without_writes_and_prefers_immutable_final_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let (target, request) = queued_fixture(temp.path());
        assert_eq!(
            status(&target, &request.request_id).unwrap().status,
            "queued"
        );
        let active = area(temp.path(), "active-review.json").unwrap();
        let bytes = serde_json::to_vec(&request).unwrap();
        save_new(&active, &bytes).unwrap();
        for _ in 0..20 {
            assert_eq!(
                status(&target, &request.request_id).unwrap().status,
                "review"
            );
        }
        assert_eq!(fs::read(&active).unwrap(), bytes);
        assert!(!area(temp.path(), "receipts").unwrap().exists());
        let receipt = Receipt {
            schema_version: 1,
            request_id: request.request_id.clone(),
            status: "imported".into(),
            message: "Matching Unity callback.".into(),
        };
        let file = area(
            temp.path(),
            &format!("receipts/{}.json", request.request_id),
        )
        .unwrap();
        let bytes = serde_json::to_vec(&receipt).unwrap();
        save_new(&file, &bytes).unwrap();
        assert_eq!(
            status(&target, &request.request_id).unwrap().status,
            "imported"
        );
        assert!(active.exists());
        assert_eq!(fs::read(file).unwrap(), bytes);
    }
    #[test]
    fn malformed_or_mismatched_active_review_cannot_claim_progress() {
        let temp = tempfile::tempdir().unwrap();
        let (target, mut request) = queued_fixture(temp.path());
        let active = area(temp.path(), "active-review.json").unwrap();
        fs::write(&active, b"{}").unwrap();
        assert!(status(&target, &request.request_id).is_err());
        request.name = "Changed request".into();
        let bytes = serde_json::to_vec(&request).unwrap();
        fs::write(&active, &bytes).unwrap();
        assert!(status(&target, &request.request_id)
            .unwrap_err()
            .contains("differs"));
        assert_eq!(fs::read(active).unwrap(), bytes);
    }
    #[test]
    fn another_valid_active_request_does_not_advance_this_queue_item() {
        let temp = tempfile::tempdir().unwrap();
        let (target, mut request) = queued_fixture(temp.path());
        let original_id = request.request_id.clone();
        request.request_id = "0".repeat(32);
        save_new(
            &area(temp.path(), "active-review.json").unwrap(),
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        assert_eq!(status(&target, &original_id).unwrap().status, "queued");
    }
    #[test]
    fn legacy_intermediate_receipts_remain_untouched_and_are_not_treated_as_final() {
        let temp = tempfile::tempdir().unwrap();
        let (target, request) = queued_fixture(temp.path());
        let file = area(
            temp.path(),
            &format!("receipts/{}.json", request.request_id),
        )
        .unwrap();
        let receipt = Receipt {
            schema_version: 1,
            request_id: request.request_id.clone(),
            status: "review".into(),
            message: "Legacy preview record".into(),
        };
        let bytes = serde_json::to_vec(&receipt).unwrap();
        save_new(&file, &bytes).unwrap();
        assert!(status(&target, &request.request_id)
            .unwrap_err()
            .contains("older intermediate"));
        assert_eq!(fs::read(file).unwrap(), bytes);
        assert!(queue(
            &target,
            "fixture.status",
            "1.0.0",
            "Test",
            &digest(b"fixture"),
            b"fixture"
        )
        .is_err());
    }
    #[test]
    fn desktop_operations_exclude_each_other() {
        let temp = tempfile::tempdir().unwrap();
        project(temp.path());
        let first = operation(temp.path()).unwrap();
        assert!(operation(temp.path()).is_err());
        drop(first);
        assert!(operation(temp.path()).is_ok());
    }
    #[test]
    fn unexpected_helper_code_is_not_an_exact_match_but_unity_meta_is_allowed() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        install(&target).unwrap();
        fs::write(
            temp.path().join(PACKAGE).join("package.json.meta"),
            "Unity metadata",
        )
        .unwrap();
        assert_eq!(helper_state(temp.path()).unwrap(), "installed");
        let extra = temp.path().join(PACKAGE).join("Editor/Unexpected.cs");
        fs::write(&extra, "additional code").unwrap();
        assert_eq!(helper_state(temp.path()).unwrap(), "different");
        assert!(install(&target).is_err());
        assert_eq!(fs::read(extra).unwrap(), b"additional code");
    }
    #[test]
    fn publishing_never_replaces_even_an_empty_raced_directory() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("staging");
        let destination = temp.path().join("existing");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("owned.txt"), "staged").unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(publish_directory(&source, &destination).is_err());
        assert!(destination.is_dir());
        assert!(!destination.join("owned.txt").exists());
        assert!(source.join("owned.txt").exists());
        let unused = temp.path().join("new-helper");
        publish_directory(&source, &unused).unwrap();
        assert!(unused.join("owned.txt").exists());
    }
    #[cfg(windows)]
    #[test]
    fn windows_open_descendant_prevents_directory_publication() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("staging");
        let destination = temp.path().join("published");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("held.txt"), "unchanged").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(source.join("held.txt"))
            .unwrap();
        let error = publish_directory(&source, &destination).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(5));
        assert!(!destination.exists());
        assert_eq!(fs::read(source.join("held.txt")).unwrap(), b"unchanged");
        drop(held);
        publish_directory(&source, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("held.txt")).unwrap(),
            b"unchanged"
        );
    }
    #[cfg(windows)]
    fn held_helper(root: &Path) -> (Target, tempfile::TempDir, fs::File) {
        let target = project(root);
        let staging = tempfile::tempdir_in(root).unwrap();
        for (name, bytes) in FILES {
            save_new(&staging.path().join(name), bytes).unwrap();
        }
        let held = fs::File::open(staging.path().join("Editor/CreatorPluginsWindow.cs")).unwrap();
        (target, staging, held)
    }
    #[cfg(windows)]
    #[test]
    fn helper_publication_recovers_after_reader_releases() {
        let root = tempfile::tempdir().unwrap();
        let (target, staging, held) = held_helper(root.path());
        let mut held = Some(held);
        let mut waits = 0;
        publish_helper(&target, staging.path(), |_| {
            waits += 1;
            drop(held.take());
        })
        .unwrap();
        assert!(waits > 0 && waits <= HELPER_PUBLISH_RETRIES);
        assert_eq!(helper_state(root.path()).unwrap(), "installed");
        assert_eq!(
            fs::read(root.path().join("Assets/Manual.unity")).unwrap(),
            b"manually arranged scene"
        );
    }
    #[cfg(windows)]
    #[test]
    fn helper_publication_stops_after_bounded_reader_wait() {
        let root = tempfile::tempdir().unwrap();
        let (target, staging, _held) = held_helper(root.path());
        let mut waits = 0;
        let error = publish_helper(&target, staging.path(), |_| waits += 1).unwrap_err();
        assert!(waits > 0 && waits <= HELPER_PUBLISH_RETRIES);
        assert!(
            error.contains("os error 5") || error.contains("Timed out"),
            "{error}"
        );
        assert!(error.contains("try again"));
        assert!(!root.path().join(PACKAGE).exists());
        assert_eq!(helper_contents(staging.path(), false).unwrap(), "installed");
    }
    #[cfg(windows)]
    #[test]
    fn helper_publication_rechecks_changes_during_wait() {
        for change in [
            "editor",
            "manifest",
            "unity-version",
            "destination",
            "matching-destination",
            "foreign-destination",
            "staged-bytes",
            "extra-code",
            "extra-metadata",
            "extra-directory",
        ] {
            let root = tempfile::tempdir().unwrap();
            let (target, staging, held) = held_helper(root.path());
            let mut held = Some(held);
            let mut editor = None;
            let mut waits = 0;
            let error = publish_helper(&target, staging.path(), |_| {
                waits += 1;
                drop(held.take());
                match change {
                    "editor" => {
                        fs::create_dir_all(root.path().join("Temp")).unwrap();
                        fs::write(root.path().join("Temp/UnityLockfile"), "fixture editor")
                            .unwrap();
                        editor = Some(hold_editor(root.path()));
                    }
                    "manifest" => fs::write(
                        root.path().join("Packages/manifest.json"),
                        r#"{"dependencies":{}}"#,
                    )
                    .unwrap(),
                    "unity-version" => fs::write(
                        root.path().join("ProjectSettings/ProjectVersion.txt"),
                        "m_EditorVersion: 2022.3.39f1\n",
                    )
                    .unwrap(),
                    "destination" => fs::create_dir(root.path().join(PACKAGE)).unwrap(),
                    "matching-destination" => {
                        for (name, bytes) in FILES {
                            save_new(&root.path().join(PACKAGE).join(name), bytes).unwrap();
                        }
                    }
                    "foreign-destination" => {
                        fs::create_dir(root.path().join(PACKAGE)).unwrap();
                        fs::write(root.path().join(PACKAGE).join("owner.txt"), "another owner")
                            .unwrap();
                    }
                    "staged-bytes" => {
                        fs::write(staging.path().join("package.json"), "changed").unwrap()
                    }
                    "extra-code" => {
                        fs::write(staging.path().join("Editor/Unexpected.cs"), "changed").unwrap()
                    }
                    "extra-metadata" => {
                        fs::write(staging.path().join("package.json.meta"), "changed").unwrap()
                    }
                    "extra-directory" => fs::create_dir(staging.path().join("Unexpected")).unwrap(),
                    _ => unreachable!(),
                }
            })
            .unwrap_err();
            assert_eq!(waits, 1, "{change}: {error}");
            if change == "matching-destination" {
                assert_eq!(helper_state(root.path()).unwrap(), "installed");
                assert!(staging.path().join("package.json").exists());
            } else {
                assert!(
                    !root.path().join(PACKAGE).join("package.json").exists(),
                    "{change}"
                );
            }
            if change == "foreign-destination" {
                assert_eq!(
                    fs::read(root.path().join(PACKAGE).join("owner.txt")).unwrap(),
                    b"another owner"
                );
            }
            assert_eq!(
                fs::read(root.path().join("Assets/Manual.unity")).unwrap(),
                b"manually arranged scene"
            );
            if change == "destination" {
                assert!(root.path().join(PACKAGE).is_dir());
            }
        }
    }
    #[cfg(windows)]
    #[test]
    fn helper_publication_does_not_attempt_again_after_deadline() {
        let root = tempfile::tempdir().unwrap();
        let (target, staging, held) = held_helper(root.path());
        let mut held = Some(held);
        let mut waits = 0;
        let error = publish_helper(&target, staging.path(), |_| {
            waits += 1;
            drop(held.take());
            std::thread::sleep(HELPER_PUBLISH_BUDGET);
        })
        .unwrap_err();
        assert_eq!(waits, 1);
        assert!(error.contains("os error 5"));
        assert!(!root.path().join(PACKAGE).exists());
    }
    #[cfg(windows)]
    #[test]
    fn helper_publication_rejects_a_descendant_junction_during_wait() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let (target, staging, held) = held_helper(root.path());
        let external = root.path().join("outside-stage");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("owner.txt"), "untouched").unwrap();
        let prepared_link = root.path().join("prepared-junction");
        // NTFS directory junctions need no symlink privilege; paths are data, not script text.
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "New-Item -ItemType Junction -Path $env:CREATOR_TEST_JUNCTION -Target $env:CREATOR_TEST_JUNCTION_TARGET -ErrorAction Stop | Out-Null"])
            .env("CREATOR_TEST_JUNCTION", &prepared_link)
            .env("CREATOR_TEST_JUNCTION_TARGET", &external)
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut held = Some(held);
        let mut waits = 0;
        let error = publish_helper(&target, staging.path(), |_| {
            waits += 1;
            drop(held.take());
            fs::rename(&prepared_link, staging.path().join("Linked")).unwrap();
        })
        .unwrap_err();
        assert_eq!(waits, 1);
        assert!(error.contains("symbolic links or junctions"), "{error}");
        assert!(!root.path().join(PACKAGE).exists());
        assert_eq!(fs::read(external.join("owner.txt")).unwrap(), b"untouched");
    }
    #[test]
    fn helper_publication_retry_classification_is_narrow() {
        for code in [2, 3, 17, 80, 87, 112, 183] {
            assert!(!transient_publication_error(
                &std::io::Error::from_raw_os_error(code)
            ));
        }
        for code in [5, 32] {
            assert_eq!(
                transient_publication_error(&std::io::Error::from_raw_os_error(code)),
                cfg!(windows)
            );
        }
    }
    #[test]
    fn a_full_inbox_cannot_accept_an_unpolled_101st_request() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        install(&target).unwrap();
        let outcome = queue(
            &target,
            "test.original",
            "1.0.0",
            "Test",
            &digest(b"fixture"),
            b"fixture",
        )
        .unwrap();
        let mut request: ImportRequest = serde_json::from_slice(
            &read(
                &area(temp.path(), &format!("inbox/{}.json", outcome.request_id)).unwrap(),
                16 * 1024,
            )
            .unwrap(),
        )
        .unwrap();
        for id in 1..100 {
            request.request_id = format!("{id:032x}");
            save_new(
                &area(temp.path(), &format!("inbox/{}.json", request.request_id)).unwrap(),
                &serde_json::to_vec(&request).unwrap(),
            )
            .unwrap();
        }
        assert!(queue(
            &target,
            "test.extra",
            "1.0.0",
            "Test",
            &digest(b"new bytes"),
            b"new bytes"
        )
        .unwrap_err()
        .contains("full"));
        assert_eq!(
            fs::read_dir(area(temp.path(), "inbox").unwrap())
                .unwrap()
                .count(),
            100
        );
        assert!(!area(
            temp.path(),
            &format!("packages/{}.unitypackage", digest(b"new bytes"))
        )
        .unwrap()
        .exists());
    }
    #[test]
    fn repeated_terminal_imports_archive_without_losing_receipts_or_status() {
        let temp = tempfile::tempdir().unwrap();
        let (target, mut request) = queued_fixture(temp.path());
        let first = request.request_id.clone();
        for _ in 0..125 {
            let request_bytes = serde_json::to_vec(&request).unwrap();
            let receipt_bytes = serde_json::to_vec(&Receipt {
                schema_version: 1,
                request_id: request.request_id.clone(),
                status: "cancelled".into(),
                message: "Fixture cancellation".into(),
            })
            .unwrap();
            let receipt_path = area(
                temp.path(),
                &format!("receipts/{}.json", request.request_id),
            )
            .unwrap();
            save_new(&receipt_path, &receipt_bytes).unwrap();
            let next = queue(
                &target,
                "fixture.status",
                "1.0.0",
                "Test",
                &digest(b"fixture"),
                b"fixture",
            )
            .unwrap();
            assert_eq!(
                fs::read(
                    area(
                        temp.path(),
                        &format!("history/requests/{}.json", request.request_id)
                    )
                    .unwrap()
                )
                .unwrap(),
                request_bytes
            );
            assert_eq!(fs::read(receipt_path).unwrap(), receipt_bytes);
            assert_eq!(
                status(&target, &request.request_id).unwrap().status,
                "cancelled"
            );
            request = serde_json::from_slice(
                &read(
                    &area(temp.path(), &format!("inbox/{}.json", next.request_id)).unwrap(),
                    16 * 1024,
                )
                .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            fs::read_dir(area(temp.path(), "inbox").unwrap())
                .unwrap()
                .count(),
            1
        );
        assert_eq!(
            fs::read_dir(area(temp.path(), "history/requests").unwrap())
                .unwrap()
                .count(),
            125
        );
        assert_eq!(status(&target, &first).unwrap().status, "cancelled");
    }
    #[test]
    fn archival_refuses_bad_receipts_and_collisions_before_moving_anything() {
        for bad in ["malformed", "intermediate", "collision", "bad-request"] {
            let temp = tempfile::tempdir().unwrap();
            let (target, request) = queued_fixture(temp.path());
            let original = read(
                &area(temp.path(), &format!("inbox/{}.json", request.request_id)).unwrap(),
                16 * 1024,
            )
            .unwrap();
            let receipt_path = area(
                temp.path(),
                &format!("receipts/{}.json", request.request_id),
            )
            .unwrap();
            let final_bytes = serde_json::to_vec(&Receipt {
                schema_version: 1,
                request_id: request.request_id.clone(),
                status: if bad == "intermediate" {
                    "review"
                } else {
                    "cancelled"
                }
                .into(),
                message: "Fixture".into(),
            })
            .unwrap();
            save_new(
                &receipt_path,
                if bad == "malformed" {
                    b"{}"
                } else {
                    &final_bytes
                },
            )
            .unwrap();
            if bad == "collision" {
                save_new(
                    &area(
                        temp.path(),
                        &format!("history/requests/{}.json", request.request_id),
                    )
                    .unwrap(),
                    b"existing history",
                )
                .unwrap();
            }
            if bad == "bad-request" {
                save_new(
                    &area(temp.path(), &format!("inbox/{}.json", "0".repeat(32))).unwrap(),
                    b"{}",
                )
                .unwrap();
            }
            assert!(
                queue(
                    &target,
                    "fixture.next",
                    "1.0.0",
                    "Test",
                    &digest(b"fixture"),
                    b"fixture"
                )
                .is_err(),
                "{bad}"
            );
            assert_eq!(
                read(
                    &area(temp.path(), &format!("inbox/{}.json", request.request_id)).unwrap(),
                    16 * 1024
                )
                .unwrap(),
                original
            );
            if bad != "collision" {
                assert!(!area(temp.path(), "history").unwrap().exists());
            }
        }
    }
    #[test]
    fn history_status_requires_terminal_receipt_and_respects_queue_lock() {
        let temp = tempfile::tempdir().unwrap();
        let (target, request) = queued_fixture(temp.path());
        let guard = operation(temp.path()).unwrap();
        assert!(status(&target, &request.request_id)
            .unwrap_err()
            .contains("Another Creator app"));
        drop(guard);
        let source = area(temp.path(), &format!("inbox/{}.json", request.request_id)).unwrap();
        let dest = area(
            temp.path(),
            &format!("history/requests/{}.json", request.request_id),
        )
        .unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        publish_directory(&source, &dest).unwrap();
        assert!(status(&target, &request.request_id)
            .unwrap_err()
            .contains("no final receipt"));
        save_new(&source, &fs::read(&dest).unwrap()).unwrap();
        assert!(status(&target, &request.request_id)
            .unwrap_err()
            .contains("both inbox and history"));
    }
    #[test]
    fn receipts_match_unity_text_limits_without_accepting_control_characters() {
        let id = "a".repeat(32);
        for message in [
            " ".into(),
            "bad\rline".into(),
            "bad\0line".into(),
            "x".repeat(4001),
            "\u{1f600}".repeat(2001),
        ] {
            let bytes = serde_json::to_vec(&Receipt {
                schema_version: 1,
                request_id: id.clone(),
                status: "cancelled".into(),
                message,
            })
            .unwrap();
            assert!(decode_receipt(&bytes, &id).is_err());
        }
        let bytes = serde_json::to_vec(&Receipt {
            schema_version: 1,
            request_id: id.clone(),
            status: "cancelled".into(),
            message: "Lines\nand\ttabs".into(),
        })
        .unwrap();
        assert!(decode_receipt(&bytes, &id).is_ok());
    }
    #[test]
    fn inbox_allows_the_100th_unresolved_request() {
        let temp = tempfile::tempdir().unwrap();
        let (target, mut request) = queued_fixture(temp.path());
        for id in 1..99 {
            request.request_id = format!("{id:032x}");
            request.package_id = format!("fixture.item{id}");
            save_new(
                &area(temp.path(), &format!("inbox/{}.json", request.request_id)).unwrap(),
                &serde_json::to_vec(&request).unwrap(),
            )
            .unwrap();
        }
        queue(
            &target,
            "fixture.last",
            "1.0.0",
            "Test",
            &digest(b"fixture"),
            b"fixture",
        )
        .unwrap();
        assert_eq!(
            fs::read_dir(area(temp.path(), "inbox").unwrap())
                .unwrap()
                .count(),
            100
        );
    }
    #[test]
    fn queue_identity_rejects_leading_punctuation_and_control_characters() {
        let temp = tempfile::tempdir().unwrap();
        let target = project(temp.path());
        install(&target).unwrap();
        assert!(queue(
            &target,
            ".test",
            "1.0.0",
            "Test",
            &digest(b"fixture"),
            b"fixture"
        )
        .is_err());
        assert!(queue(
            &target,
            "test.graph",
            "1.0.0",
            "Test\0name",
            &digest(b"fixture"),
            b"fixture"
        )
        .is_err());
        assert!(!area(temp.path(), "inbox").unwrap().exists());
    }
}
