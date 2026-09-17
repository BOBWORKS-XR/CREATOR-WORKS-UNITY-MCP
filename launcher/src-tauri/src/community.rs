//! Community listings are data, never installation authority or executable commands.
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[path = "community_package.rs"]
mod package;

pub const ROOT: &str = "https://raw.githubusercontent.com/SideQuestVR/Creator-Community/main/";
const REPO: &str = "https://github.com/SideQuestVR/Creator-Community";
const MAX_LISTING: u64 = 16 * 1024;
const MAX_DOWNLOAD: u64 = 32 * 1024 * 1024;
const PROJECT_IMPORT_ENABLED: bool = true;

pub fn require_import_preview() -> Result<(), String> {
    if PROJECT_IMPORT_ENABLED {
        Ok(())
    } else {
        Err("Unity menu installation and project imports are not enabled in this prerelease. Download the package and review its instructions instead.".into())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Listing {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    schema_version: u32,
    id: String,
    version: String,
    name: String,
    category: String,
    description: String,
    author: Author,
    license: String,
    license_path: String,
    instructions_path: String,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    discussion_url: Option<String>,
    #[serde(default)]
    preview_image: Option<String>,
    compatibility: Compatibility,
    dependencies: Vec<String>,
    includes_code: bool,
    scope: String,
    #[serde(default)]
    ai_assisted: Option<bool>,
    test_notes: String,
    #[serde(default)]
    download: Option<Download>,
    #[serde(default)]
    usage: String,
    #[serde(default)]
    contents: Vec<String>,
    #[serde(default = "pending")]
    review_status: String,
}
fn pending() -> String {
    "pending".into()
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Author {
    name: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    discord: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compatibility {
    unity: Vec<String>,
    creator_sdk: Vec<String>,
    banter_sdk: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Download {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    path: Option<String>,
    byte_length: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    schema_version: u32,
    entries: Vec<String>,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    entries: Vec<Listing>,
    media: Vec<Gallery>,
    warnings: Vec<String>,
    stale: bool,
    #[serde(rename = "projectImportEnabled")]
    project_import_enabled: bool,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            media: Vec::new(),
            warnings: Vec::new(),
            stale: false,
            project_import_enabled: PROJECT_IMPORT_ENABLED,
        }
    }
}
#[derive(Default)]
pub struct Community(Mutex<Option<(Instant, Snapshot)>>);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreviewMedia {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    poster: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Gallery {
    id: String,
    items: Vec<PreviewMedia>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaIndex {
    schema_version: u32,
    galleries: Vec<Gallery>,
}
fn preview_url(value: &str, extensions: &[&str]) -> bool {
    (path_ok(value) || web_url(value, true))
        && extensions
            .iter()
            .any(|extension| value.ends_with(extension))
}
fn parse_media(bytes: &[u8]) -> Result<Vec<Gallery>, String> {
    if bytes.len() > 256 * 1024 {
        return Err("Preview gallery exceeds its size limit.".into());
    }
    let index: MediaIndex =
        serde_json::from_slice(bytes).map_err(|_| "Invalid preview gallery.")?;
    let mut ids = HashSet::new();
    if index.schema_version != 1 || index.galleries.len() > 50 {
        return Err("Unsupported preview gallery.".into());
    }
    for gallery in &index.galleries {
        if !text_ok(&gallery.id, 100)
            || !ids.insert(&gallery.id)
            || gallery.items.is_empty()
            || gallery.items.len() > 8
        {
            return Err("Invalid preview gallery entries.".into());
        }
        for item in &gallery.items {
            let valid = match item.kind.as_str() {
                "image" => {
                    preview_url(&item.url, &[".png", ".jpg", ".jpeg"]) && item.poster.is_none()
                }
                "gif" => preview_url(&item.url, &[".gif"]),
                "webm" => preview_url(&item.url, &[".webm"]),
                _ => false,
            };
            if !valid
                || (item.kind != "image"
                    && !item
                        .poster
                        .as_deref()
                        .is_some_and(|p| preview_url(p, &[".png", ".jpg", ".jpeg"])))
            {
                return Err("Unapproved preview media or missing static poster.".into());
            }
        }
    }
    Ok(index.galleries)
}

fn text_ok(s: &str, max: usize) -> bool {
    !s.trim().is_empty()
        && s.len() <= max
        && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn path_ok(s: &str) -> bool {
    s.len() <= 500
        && s.contains('/')
        && s.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.starts_with('.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}
fn web_url(s: &str, media: bool) -> bool {
    let Ok(url) = Url::parse(s) else {
        return false;
    };
    if s.len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some("cdn.sidequestvr.com") => url.path().starts_with("/file/"),
        Some("raw.githubusercontent.com") => url
            .path()
            .starts_with("/SideQuestVR/Creator-Community/main/"),
        Some("github.com" | "discord.com") => !media && url.path() != "/",
        Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => !media,
        _ => false,
    }
}
fn repository_url(path: &str) -> Result<String, String> {
    if !path_ok(path) {
        return Err("Invalid community repository path.".into());
    }
    Ok(format!("{ROOT}{path}"))
}
impl Listing {
    fn validate(&self) -> Result<(), String> {
        let versions = [
            &self.compatibility.unity,
            &self.compatibility.creator_sdk,
            &self.compatibility.banter_sdk,
        ];
        if self.schema_version != 1
            || !text_ok(&self.id, 100)
            || !self.id.contains('.')
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
            || semver::Version::parse(&self.version).is_err()
            || self.version.len() > 80
            || !text_ok(&self.name, 120)
            || !text_ok(&self.description, 2000)
            || !text_ok(&self.author.name, 120)
            || !text_ok(&self.license, 120)
            || !text_ok(&self.test_notes, 4000)
            || ![
                "prefab",
                "graph",
                "recipe",
                "plugin",
                "community-tool",
                "mcp-tool",
                "ai-skill",
            ]
            .contains(&self.category.as_str())
            || !["editor-only", "runtime", "both", "instructions-only"]
                .contains(&self.scope.as_str())
            || !["pending", "listed"].contains(&self.review_status.as_str())
            || !path_ok(&self.license_path)
            || !path_ok(&self.instructions_path)
            || self.usage.len() > 4000
            || self.contents.len() > 200
            || self.contents.iter().any(|p| !text_ok(p, 500))
            || self.dependencies.len() > 50
            || self.dependencies.iter().any(|s| !text_ok(s, 200))
            || versions
                .iter()
                .any(|items| items.len() > 50 || items.iter().any(|s| !text_ok(s, 80)))
            || self
                .author
                .discord
                .as_ref()
                .is_some_and(|s| !text_ok(s, 120))
        {
            return Err("Invalid community listing fields.".into());
        }
        for url in [&self.source_url, &self.discussion_url, &self.author.url]
            .into_iter()
            .flatten()
        {
            if !web_url(url, false) {
                return Err("Unapproved community link.".into());
            }
        }
        if let Some(image) = &self.preview_image {
            if !path_ok(image) && !web_url(image, true) {
                return Err("Unapproved preview image.".into());
            }
        }
        if let Some(d) = &self.download {
            if d.byte_length == 0
                || d.byte_length > MAX_DOWNLOAD
                || d.sha256.len() != 64
                || !d
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("Invalid community download size or checksum.".into());
            }
            download_url(d)?;
        }
        Ok(())
    }
}
fn download_url(d: &Download) -> Result<String, String> {
    match (&d.url, &d.path) {
        (Some(url), None)
            if web_url(url, false)
                && Url::parse(url).is_ok_and(|u| {
                    u.path().ends_with(".unitypackage") || u.path().ends_with(".zip")
                }) =>
        {
            Ok(url.clone())
        }
        (None, Some(path)) if path.ends_with(".unitypackage") || path.ends_with(".zip") => {
            repository_url(path)
        }
        _ => Err("Unapproved community package URL.".into()),
    }
}
fn client() -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .user_agent("Creator-Community-Browser/1")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            // Signed GitHub asset redirects may contain query parameters, but not a new host.
            let u = a.url();
            let asset = u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
                && u.port().is_none()
                && matches!(
                    u.host_str(),
                    Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
                );
            if a.previous().len() < 3 && (web_url(u.as_str(), false) || asset) {
                a.follow()
            } else {
                a.error("Unapproved community redirect")
            }
        }))
        .build()
        .map_err(|_| "Could not initialize community downloads.".into())
}
fn fetch(client: &Client, url: &str, max: u64) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| {
            "Community catalogue or file unavailable. Check your connection and try again."
        })?;
    if response.content_length().is_some_and(|n| n > max) {
        return Err("Community file exceeds its size limit.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Community download was interrupted.")?;
    if bytes.len() as u64 > max {
        return Err("Community file exceeds its size limit.".into());
    }
    Ok(bytes)
}
fn load() -> Result<Snapshot, String> {
    let client = client()?;
    let index: Index =
        serde_json::from_slice(&fetch(&client, &format!("{ROOT}index.json"), 32 * 1024)?)
            .map_err(|_| "Invalid community index.")?;
    if index.schema_version != 1 || index.entries.len() > 50 {
        return Err("Unsupported community index.".into());
    }
    let mut snapshot = Snapshot::default();
    let mut ids = HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    for path in index.entries {
        if Instant::now() > deadline {
            snapshot.warnings.push(
                "Some listings could not be loaded within the time limit. Refresh to try again."
                    .into(),
            );
            break;
        }
        let parsed: Result<Listing, String> = (|| {
            let url = repository_url(&path)?;
            if !path.starts_with("packages/") || !path.ends_with("/listing.json") {
                return Err("Invalid listing path.".into());
            }
            let entry: Listing = serde_json::from_slice(&fetch(&client, &url, MAX_LISTING)?)
                .map_err(|_| "Invalid listing JSON.")?;
            entry.validate()?;
            if !ids.insert(entry.id.clone()) {
                return Err("Duplicate package identifier.".into());
            }
            Ok(entry)
        })();
        match parsed {
            Ok(entry) => snapshot.entries.push(entry),
            Err(_) => snapshot
                .warnings
                .push("A listing could not be loaded or did not pass validation.".into()),
        }
    }
    // Optional sidecar: older consumers reject added listing fields. Media failure
    // must never hide otherwise valid packages or become installation authority.
    if let Ok(media_client) = Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        match fetch(&media_client, &format!("{ROOT}media.json"), 256 * 1024)
            .and_then(|bytes| parse_media(&bytes))
        {
            Ok(media) => snapshot.media = media,
            Err(_) => snapshot
                .warnings
                .push("Preview galleries unavailable. Cover images are still available.".into()),
        }
    }
    Ok(snapshot)
}
pub fn catalogue_worker(handle: tauri::AppHandle, refresh: bool) -> Result<Snapshot, String> {
    let state = handle.state::<Community>();
    let mut cache = state.0.lock().map_err(|_| "Community catalogue is busy.")?;
    if !refresh {
        if let Some((time, snapshot)) = &*cache {
            if time.elapsed() < Duration::from_secs(180) {
                return Ok(snapshot.clone());
            }
        }
    }
    match load() {
        Ok(snapshot) => {
            *cache = Some((Instant::now(), snapshot.clone()));
            Ok(snapshot)
        }
        Err(error) => {
            if let Some((_, snapshot)) = cache.as_mut() {
                snapshot.stale = true;
                snapshot.warnings = vec![error];
                Ok(snapshot.clone())
            } else {
                Err(error)
            }
        }
    }
}
fn selected(handle: &tauri::AppHandle, id: &str, fresh: bool) -> Result<Listing, String> {
    let state = handle.state::<Community>();
    let cache = state
        .0
        .try_lock()
        .map_err(|_| "Community catalogue is refreshing. Try again shortly.")?;
    let (time, snapshot) = cache
        .as_ref()
        .ok_or("Open the community catalogue first.")?;
    if fresh && (snapshot.stale || time.elapsed() > Duration::from_secs(180)) {
        return Err("Refresh the catalogue before downloading.".into());
    }
    snapshot
        .entries
        .iter()
        .find(|e| e.id == id)
        .cloned()
        .ok_or("This contribution is no longer listed. Refresh the catalogue.".into())
}
pub fn open_link_worker(handle: tauri::AppHandle, id: String, kind: String) -> Result<(), String> {
    let url = match kind.as_str() {
        "submit" => format!("{REPO}/issues/new?template=contribution.yml"),
        "catalogue" => REPO.into(),
        _ => {
            let entry = selected(&handle, &id, false)?;
            match kind.as_str() {
                "source" => entry.source_url.ok_or("No source link supplied.")?,
                "discussion" => entry.discussion_url.ok_or("No discussion link supplied.")?,
                "instructions" => format!("{REPO}/blob/main/{}", entry.instructions_path),
                "license" => format!("{REPO}/blob/main/{}", entry.license_path),
                _ => return Err("Unknown community link.".into()),
            }
        }
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x08000000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open the community link.".into())
}
fn verify_download(bytes: &[u8], d: &Download) -> Result<(), String> {
    if bytes.len() as u64 != d.byte_length || format!("{:x}", Sha256::digest(bytes)) != d.sha256 {
        return Err(
            "Package size or checksum does not match the listing. Nothing was saved.".into(),
        );
    }
    Ok(())
}
fn save_verified(bytes: &[u8], d: &Download, path: &std::path::Path) -> Result<(), String> {
    verify_download(bytes, d)?;
    let parent = path.parent().ok_or("Invalid download location.")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot write to this folder.")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Could not save the package.")?;
    temporary.persist_noclobber(path).map_err(|_| {
        "The destination already exists or could not be saved. Existing files were not overwritten."
    })?;
    Ok(())
}
pub fn download_worker(handle: tauri::AppHandle, id: String) -> Result<String, String> {
    let entry = selected(&handle, &id, true)?;
    if entry.review_status != "listed" {
        return Err("This contribution is awaiting review. Download is not enabled.".into());
    }
    let d = entry
        .download
        .as_ref()
        .ok_or("This contribution has no package download.")?;
    let url = download_url(d)?;
    let extension = if Url::parse(&url).is_ok_and(|u| u.path().ends_with(".unitypackage")) {
        "unitypackage"
    } else {
        "zip"
    };
    let Some(path) = handle
        .dialog()
        .file()
        .set_file_name(format!("{}-{}.{}", entry.id, entry.version, extension))
        .add_filter("Community package", &[extension])
        .blocking_save_file()
    else {
        return Ok("Download cancelled.".into());
    };
    let path = path
        .into_path()
        .map_err(|_| "Choose a local download location.")?;
    let bytes = fetch(&client()?, &url, d.byte_length)?;
    save_verified(&bytes, d, &path)?;
    Ok(format!(
        "Saved to {}. Checksum matched; no files were imported into Unity.",
        path.display()
    ))
}

fn importable(entry: &Listing) -> Result<&Download, String> {
    if !matches!(
        entry.category.as_str(),
        "graph" | "prefab" | "plugin" | "community-tool"
    ) {
        return Err(
            "This contribution uses its own installation instructions, not Unity asset import."
                .into(),
        );
    }
    if !matches!(entry.scope.as_str(), "editor-only" | "runtime" | "both") {
        return Err("Instructions-only contributions cannot be imported into Unity.".into());
    }
    if entry.review_status != "listed" {
        return Err("This contribution is awaiting review. Project import is not enabled.".into());
    }
    let download = entry
        .download
        .as_ref()
        .ok_or("This entry has no package download.")?;
    if !Url::parse(&download_url(download)?).is_ok_and(|u| u.path().ends_with(".unitypackage")) {
        return Err("Only .unitypackage files can be sent to Unity. Download ZIP files separately and review their instructions.".into());
    }
    Ok(download)
}
pub fn queue_import_worker(
    handle: tauri::AppHandle,
    id: String,
    project_id: String,
) -> Result<crate::community_project::Outcome, String> {
    require_import_preview()?;
    let entry = selected(&handle, &id, true)?;
    let download = importable(&entry)?;
    let target = crate::community_project::selected(&handle, &project_id)?;
    if target.helper != "installed" {
        return Err("Add the matching Unity menu before sending packages to this project.".into());
    }
    let bytes = fetch(&client()?, &download_url(download)?, download.byte_length)?;
    verify_download(&bytes, download)?;
    let review = package::inspect(&bytes)?;
    let approved = handle.dialog().message(format!("Send {} {} to {} for review?\n\n{}\nUnity {} / {}\n\n{}\n\nThe verified package will be queued outside Assets. In Unity, use Creator Plugins > Browse to review file selection and decide whether to import. Code may execute on import. No scene will be saved automatically.", entry.name, entry.version, target.name, target.path, target.unity_version, target.sdk, review.summary(std::path::Path::new(&target.path)))).title("Review package contents").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom("Send for review".into(), "Cancel".into())).blocking_show();
    if !approved {
        return Ok(crate::community_project::Outcome {
            project_id,
            request_id: String::new(),
            status: "cancelled".into(),
            message: "Cancelled. No package was queued or imported.".into(),
        });
    }
    let current = selected(&handle, &id, true)?;
    let current_download = importable(&current)?;
    if current.version != entry.version
        || current_download.sha256 != download.sha256
        || download_url(current_download)? != download_url(download)?
    {
        return Err("The listing changed. Refresh and review it again before sending.".into());
    }
    crate::community_project::queue(
        &target,
        &entry.id,
        &entry.version,
        &entry.name,
        &download.sha256,
        &bytes,
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn media_sidecar_is_optional_bounded_and_requires_static_posters() {
        let image = serde_json::json!({"type":"image", "url":"assets/example/front.png"});
        let mut index = serde_json::json!({"schemaVersion":1,"galleries":[{"id":"example.six-images","items":vec![image;6]}]});
        let parse = |v: &serde_json::Value| parse_media(&serde_json::to_vec(v).unwrap());
        assert_eq!(parse(&index).unwrap()[0].items.len(), 6);
        for kind in ["gif", "webm"] {
            index["galleries"][0]["items"][0] = serde_json::json!({"type":kind,"url":format!("assets/example/demo.{kind}"),"poster":"assets/example/poster.png"});
            assert!(parse(&index).is_ok());
            index["galleries"][0]["items"][0]
                .as_object_mut()
                .unwrap()
                .remove("poster");
            assert!(parse(&index).is_err());
        }
        for url in [
            "https://evil.test/a.png",
            "https://cdn.sidequestvr.com/file/1/a.svg",
            "assets/../a.png",
            "https://cdn.sidequestvr.com/file/1/a.png?x=1",
        ] {
            index["galleries"][0]["items"][0] = serde_json::json!({"type":"image","url":url});
            assert!(parse(&index).is_err());
        }
        index["galleries"][0]["items"] = serde_json::json!(vec![
            serde_json::json!({"type":"image","url":"assets/example/a.png"});
            9
        ]);
        assert!(parse(&index).is_err());
        assert!(parse_media(&vec![b' '; 256 * 1024 + 1]).is_err());
        assert!(parse_media(br#"{"schemaVersion":1,"galleries":[]}"#)
            .unwrap()
            .is_empty());
    }
    use super::*;
    #[test]
    fn experimental_import_capability_matches_native_gate() {
        assert!(require_import_preview().is_ok());
        assert_eq!(
            serde_json::to_value(Snapshot::default()).unwrap()["projectImportEnabled"],
            true
        );
    }
    #[test]
    fn only_reviewed_unitypackages_can_be_queued() {
        let mut entry: Listing = serde_json::from_str(include_str!(
            "../../tests/fixtures/community/start-location.json"
        ))
        .unwrap();
        assert!(importable(&entry).is_err());
        entry.review_status = "listed".into();
        assert!(importable(&entry).is_ok());
        for category in ["mcp-tool", "ai-skill", "recipe"] {
            entry.category = category.into();
            assert!(importable(&entry).is_err());
        }
        entry.category = "graph".into();
        entry.scope = "instructions-only".into();
        assert!(importable(&entry).is_err());
        entry.scope = "both".into();
        entry.download.as_mut().unwrap().url =
            Some("https://cdn.sidequestvr.com/file/1/test.zip".into());
        assert!(importable(&entry).is_err());
    }
    #[test]
    fn saving_checks_integrity_and_never_replaces_an_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.zip");
        let d = Download {
            url: None,
            path: Some("packages/test/a.zip".into()),
            byte_length: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        };
        assert!(save_verified(b"bad", &d, &path).is_err());
        assert!(!path.exists());
        save_verified(b"abc", &d, &path).unwrap();
        std::fs::write(&path, b"existing user file").unwrap();
        assert!(save_verified(b"abc", &d, &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"existing user file");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    #[ignore = "Explicit read-only network acceptance: public catalogue and supplied package; no import or save"]
    fn public_catalogue_and_supplied_package_are_readable() {
        let snapshot = load().unwrap();
        assert!(!snapshot.stale);
        assert!(snapshot.warnings.is_empty());
        let entry: Listing = serde_json::from_str(include_str!(
            "../../tests/fixtures/community/start-location.json"
        ))
        .unwrap();
        let download = entry.download.as_ref().unwrap();
        let bytes = fetch(
            &client().unwrap(),
            &download_url(download).unwrap(),
            download.byte_length,
        )
        .unwrap();
        verify_download(&bytes, download).unwrap();
    }
    #[test]
    fn repository_paths_cannot_escape() {
        for s in [
            "../a",
            "packages/../a",
            "/a/b",
            "a//b",
            "a/%2e%2e/b",
            "a\\b/c",
            "https://x/a",
            "a/b?x",
        ] {
            assert!(!path_ok(s), "{s}");
        }
        assert!(path_ok(
            "packages/egon-gb.start-location/0.0.0-review.1/listing.json"
        ));
    }
    #[test]
    fn links_are_https_and_allowlisted() {
        for s in [
            "http://cdn.sidequestvr.com/file/1/a.png",
            "https://evil.test/a",
            "https://github.com.evil.test/a",
            "https://bob@github.com/a",
            "https://github.com:443/a",
            "https://127.0.0.1/a",
            "file:///C:/a",
        ] {
            // Url normalizes an explicit default port; it is still HTTPS to the exact allowed host.
            if s != "https://github.com:443/a" {
                assert!(!web_url(s, false), "{s}");
            }
        }
        assert!(web_url(
            "https://cdn.sidequestvr.com/file/4591279/image.png",
            true
        ));
        assert!(!web_url("https://github.com/user/repo", true));
    }
    #[test]
    fn test_listing_is_valid_and_describes_executable_content() {
        let entry: Listing = serde_json::from_str(include_str!(
            "../../tests/fixtures/community/start-location.json"
        ))
        .unwrap();
        entry.validate().unwrap();
        assert!(entry.includes_code);
        assert_eq!(entry.category, "graph");
        assert_eq!(entry.compatibility.creator_sdk.len(), 0);
        let mut bad = entry.clone();
        bad.preview_image = Some("javascript:alert(1)".into());
        assert!(bad.validate().is_err());
        bad = entry;
        bad.download.as_mut().unwrap().sha256 = "x".repeat(64);
        assert!(bad.validate().is_err());
    }
    #[test]
    fn catalogue_categories_accept_ai_contributions_without_enabling_unity_import() {
        let mut entry: Listing = serde_json::from_str(include_str!(
            "../../tests/fixtures/community/start-location.json"
        ))
        .unwrap();
        entry.review_status = "listed".into();
        for category in ["mcp-tool", "ai-skill"] {
            entry.category = category.into();
            entry.download.as_mut().unwrap().url =
                Some("https://cdn.sidequestvr.com/file/1/tool.zip".into());
            entry.validate().unwrap();
            assert!(importable(&entry).is_err());
            let download = entry.download.take();
            entry.scope = "instructions-only".into();
            entry.validate().unwrap();
            assert!(importable(&entry).is_err());
            entry.download = download;
        }
        entry.category = "unknown-tool".into();
        assert!(entry.validate().is_err());
    }
    #[test]
    fn checksum_and_length_are_both_required() {
        let mut d = Download {
            url: None,
            path: Some("packages/test/a.zip".into()),
            byte_length: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        };
        assert!(verify_download(b"abc", &d).is_ok());
        assert!(verify_download(b"abd", &d).is_err());
        d.byte_length = 4;
        assert!(verify_download(b"abc", &d).is_err());
    }
}
