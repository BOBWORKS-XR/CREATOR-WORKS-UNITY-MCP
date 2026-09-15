//! Read-only structural review. Never extract or execute community archives.
use flate2::read::GzDecoder;
use std::{
    collections::{BTreeMap, HashSet},
    io::Read,
    path::Path,
};

const MAX_EXPANDED: u64 = 128 * 1024 * 1024;
const MAX_RECORDS: usize = 20_000;

#[derive(Debug)]
pub struct Asset {
    pub path: String,
    pub code: bool,
    pub scene: bool,
}

#[derive(Debug)]
pub struct Review {
    pub assets: Vec<Asset>,
}

#[derive(Default)]
struct Record {
    path: Option<String>,
    meta: Option<String>,
    asset: bool,
}

fn guid(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn asset_path(value: &str) -> bool {
    value.len() <= 1024
        && value.starts_with("Assets/")
        && value.split('/').all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.ends_with(['.', ' '])
                && !part.starts_with('.')
                && !part
                    .chars()
                    .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
        && !value.to_ascii_lowercase().ends_with(".meta")
}

pub fn inspect(bytes: &[u8]) -> Result<Review, String> {
    inspect_bounded(bytes, MAX_EXPANDED, MAX_RECORDS)
}

fn inspect_bounded(bytes: &[u8], max_expanded: u64, max_records: usize) -> Result<Review, String> {
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Package exceeds the download limit.".into());
    }
    let mut expanded = Vec::new();
    GzDecoder::new(bytes)
        .take(max_expanded + 1)
        .read_to_end(&mut expanded)
        .map_err(|_| "Package is not a complete gzip archive.")?;
    if expanded.len() as u64 > max_expanded {
        return Err("Expanded package exceeds the review limit.".into());
    }
    let mut archive = tar::Archive::new(expanded.as_slice());
    let mut records: BTreeMap<String, Record> = BTreeMap::new();
    let mut members = HashSet::new();
    for member in archive.entries().map_err(|_| "Invalid package archive.")? {
        let mut member = member.map_err(|_| "Invalid package archive member.")?;
        let name = String::from_utf8(member.path_bytes().into_owned())
            .map_err(|_| "Invalid archive path.")?;
        let kind = member.header().entry_type();
        if members.len() >= max_records {
            return Err("Package has too many archive members.".into());
        }
        if !members.insert(name.to_ascii_lowercase()) {
            return Err("Package has duplicate archive members.".into());
        }
        if kind.is_dir() && guid(name.trim_end_matches('/')) {
            continue;
        }
        if !kind.is_file() {
            return Err("Package links and special archive members are not supported.".into());
        }
        let (id, file) = name
            .split_once('/')
            .ok_or("Invalid Unity package layout.")?;
        if !guid(id) || !matches!(file, "pathname" | "asset" | "asset.meta" | "preview.png") {
            return Err("Package is not a supported Unity asset archive.".into());
        }
        let record = records.entry(id.to_ascii_lowercase()).or_default();
        if file == "asset" {
            record.asset = true;
        }
        if matches!(file, "pathname" | "asset.meta") {
            let limit = if file == "pathname" { 2048 } else { 256 * 1024 };
            if member.size() > limit {
                return Err("Package metadata exceeds the review limit.".into());
            }
            let mut text = String::new();
            member
                .read_to_string(&mut text)
                .map_err(|_| "Invalid package metadata.")?;
            if file == "pathname" {
                record.path = Some(text.trim_end_matches(['\r', '\n']).to_owned());
            } else {
                record.meta = Some(text);
            }
        }
    }
    if records.is_empty() {
        return Err("Package has no Unity assets.".into());
    }
    let mut destinations = HashSet::new();
    let mut assets = Vec::new();
    for (id, record) in records {
        let path = record.path.ok_or("Package asset has no pathname.")?;
        if !asset_path(&path) {
            return Err("Package contains an unsafe or non-Assets destination.".into());
        }
        if !destinations.insert(path.to_ascii_lowercase()) {
            return Err("Package has conflicting destination paths.".into());
        }
        let meta = record.meta.ok_or("Package asset has no metadata.")?;
        let ids: Vec<_> = meta
            .lines()
            .filter_map(|line| line.strip_prefix("guid: "))
            .collect();
        if ids.len() != 1 || !ids[0].trim().eq_ignore_ascii_case(&id) {
            return Err("Package GUID does not match its asset metadata.".into());
        }
        if !record.asset && !meta.lines().any(|line| line == "folderAsset: yes") {
            return Err("Package asset payload is missing.".into());
        }
        let lower = path.to_ascii_lowercase();
        let code = [".cs", ".dll", ".asmdef", ".asmref", ".rsp", ".js", ".boo"]
            .iter()
            .any(|ext| lower.ends_with(ext));
        assets.push(Asset {
            scene: lower.ends_with(".unity"),
            code,
            path,
        });
    }
    assets.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Review { assets })
}

impl Review {
    pub fn summary(&self, project: &Path) -> String {
        let existing = self
            .assets
            .iter()
            .filter(|a| {
                project.join(&a.path).exists() || project.join(format!("{}.meta", a.path)).exists()
            })
            .count();
        let mut text = format!(
            "{} asset paths; {} code/assembly files; {} scenes; {} existing destination paths.\n",
            self.assets.len(),
            self.assets.iter().filter(|a| a.code).count(),
            self.assets.iter().filter(|a| a.scene).count(),
            existing
        );
        for asset in self.assets.iter().take(8) {
            let display: String = asset.path.chars().take(160).collect();
            text.push_str(&format!("\n{display}"));
            if asset.path.chars().count() > 160 {
                text.push_str("...");
            }
        }
        if self.assets.len() > 8 {
            text.push_str("\n... Review the remaining files in Unity.");
        }
        text.push_str("\n\nOriginal paths and GUIDs are retained. Unity may also match existing assets by GUID. Review replacements in Unity; this check does not prove code safety, dependencies or SDK compatibility.");
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    const ID: &str = "1234567890abcdef1234567890abcdef";
    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, name, *data).unwrap();
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar.into_inner().unwrap()).unwrap();
        gzip.finish().unwrap()
    }
    fn package(path: &str) -> Vec<u8> {
        archive(&[
            (&format!("{ID}/pathname"), path.as_bytes()),
            (
                &format!("{ID}/asset.meta"),
                format!("fileFormatVersion: 2\nguid: {ID}\n").as_bytes(),
            ),
            (&format!("{ID}/asset"), b"harmless fixture"),
        ])
    }
    #[test]
    fn retains_paths_and_identifies_code_scenes_and_collisions_without_writes() {
        let review = inspect(&package("Assets/Editor/Example.cs")).unwrap();
        assert_eq!(review.assets[0].path, "Assets/Editor/Example.cs");
        assert!(review.assets[0].code);
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("Assets/Editor")).unwrap();
        let existing = root.path().join("Assets/Editor/Example.cs");
        std::fs::write(&existing, "user content").unwrap();
        assert!(review
            .summary(root.path())
            .contains("1 existing destination"));
        assert_eq!(std::fs::read_to_string(existing).unwrap(), "user content");
        assert!(inspect(&package("Assets/Test.unity")).unwrap().assets[0].scene);
    }
    #[test]
    fn rejects_unsafe_destinations_on_every_host_platform() {
        for path in [
            "../escape",
            "Assets/../escape",
            "Packages/test/a.cs",
            "Assets/a\\b",
            "Assets/a:stream",
            "Assets/NUL.txt",
            "Assets/COM1",
            "Assets/..",
            "Assets/.git/config",
            "Assets/a.",
            "Assets/a ",
            "Assets/A.meta",
            "Assets/a\ncs",
            "assets/a.cs",
            "Assets//a.cs",
        ] {
            assert!(inspect(&package(path)).is_err(), "{path}");
        }
    }
    #[test]
    fn rejects_size_member_limits_truncation_duplicates_and_foreign_formats() {
        let bytes = package("Assets/a.txt");
        assert!(inspect_bounded(&bytes, 64, 20).is_err());
        assert!(inspect_bounded(&bytes, MAX_EXPANDED, 2).is_err());
        assert!(inspect(&bytes[..bytes.len() - 8]).is_err());
        assert!(inspect(b"not gzip").is_err());
        assert!(inspect(&archive(&[("package/package.json", b"{}")])).is_err());
        assert!(inspect(&archive(&[
            (&format!("{ID}/pathname"), b"Assets/a"),
            (&format!("{ID}/pathname"), b"Assets/b")
        ]))
        .is_err());
    }
    #[test]
    fn rejects_missing_or_mismatching_guid_and_payload() {
        let path = format!("{ID}/pathname");
        let meta = format!("{ID}/asset.meta");
        assert!(inspect(&archive(&[(&path, b"Assets/a")])).is_err());
        assert!(inspect(&archive(&[(&path, b"Assets/a"), (&meta, b"guid: wrong")])).is_err());
        let metadata = format!("guid: {ID}\n");
        assert!(inspect(&archive(&[
            (&path, b"Assets/a"),
            (&meta, metadata.as_bytes())
        ]))
        .is_err());
        let folder = format!("guid: {ID}\nfolderAsset: yes\n");
        assert!(inspect(&archive(&[
            (&path, b"Assets/a"),
            (&meta, folder.as_bytes())
        ]))
        .is_ok());
    }
    #[test]
    fn rejects_symlinks_and_case_colliding_destinations() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o644);
        builder
            .append_link(&mut header, format!("{ID}/asset"), "../../outside")
            .unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&builder.into_inner().unwrap()).unwrap();
        assert!(inspect(&gzip.finish().unwrap()).is_err());
        let id2 = "abcdef1234567890abcdef1234567890";
        let a = format!("guid: {ID}\nfolderAsset: yes\n");
        let b = format!("guid: {id2}\nfolderAsset: yes\n");
        assert!(inspect(&archive(&[
            (&format!("{ID}/pathname"), b"Assets/Test"),
            (&format!("{ID}/asset.meta"), a.as_bytes()),
            (&format!("{id2}/pathname"), b"Assets/test"),
            (&format!("{id2}/asset.meta"), b.as_bytes())
        ]))
        .is_err());
    }
    #[test]
    fn approval_summary_stays_bounded_without_changing_asset_paths() {
        let path = format!("Assets/{}.asset", "a".repeat(900));
        let review = Review {
            assets: (0..20)
                .map(|_| Asset {
                    path: path.clone(),
                    code: false,
                    scene: false,
                })
                .collect(),
        };
        let root = tempfile::tempdir().unwrap();
        let text = review.summary(root.path());
        assert!(text.len() < 2000);
        assert!(text.contains("remaining files"));
        assert_eq!(review.assets[0].path, path);
    }
    #[test]
    #[ignore = "Read-only inspection of an explicitly selected local package"]
    fn inspect_selected_package() {
        let path =
            std::env::var_os("CREATOR_PLUGIN_INSPECT_PACKAGE").expect("Select a local package");
        let bytes = std::fs::read(path).unwrap();
        let review = inspect(&bytes).unwrap();
        println!("{review:#?}");
    }
}
