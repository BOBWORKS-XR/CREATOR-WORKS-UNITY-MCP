//! Writable hosting never falls back to the developer checkout or an old bundle.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

include!(concat!(env!("OUT_DIR"), "/hosted_payload.rs"));

pub struct Root(pub PathBuf);

pub fn lock_image(path: &Path) -> Result<(File, String), String> {
    if !path.is_absolute() {
        return Err("Hosted files require absolute paths.".into());
    }
    for ancestor in path.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
            let link = meta.file_type().is_symlink();
            #[cfg(windows)]
            let link = {
                use std::os::windows::fs::MetadataExt;
                link || meta.file_attributes() & 0x400 != 0
            };
            if link {
                return Err("Hosted files cannot use symbolic links or junctions.".into());
            }
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options
        .open(path)
        .map_err(|_| format!("Cannot open required hosted file: {}", path.display()))?;
    let metadata = file.metadata().map_err(|_| "Cannot inspect hosted file.")?;
    if !metadata.is_file() || metadata.len() > 128 * 1024 * 1024 {
        return Err("Hosted file is invalid or exceeds the size limit.".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot verify hosted file.")?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok((file, format!("{:x}", digest.finalize())))
}

pub fn lock(directory: &Path) -> Result<Vec<File>, String> {
    verify(directory, FILES)
}

fn verify(directory: &Path, files: &[(&str, &str)]) -> Result<Vec<File>, String> {
    files.iter().map(|(name, expected)| {
        let (file, hash) = lock_image(&directory.join(name))?;
        if hash != *expected { return Err(format!("Hosted payload does not match this MCP build: {name}. No setup operation was started.")); }
        Ok(file)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_mismatched_and_changed_payloads_are_not_accepted() {
        let root = std::env::temp_dir().join(format!("creator-payload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        // macOS temp_dir can contain the system /var -> /private/var link.
        let root = root.canonicalize().unwrap();
        let path = root.join("server.mjs");
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let expected = [("server.mjs", hash.as_str())];
        assert!(verify(&root, &expected).is_err());
        std::fs::write(&path, b"wrong").unwrap();
        assert!(verify(&root, &expected).is_err());
        std::fs::write(&path, b"fixture").unwrap();
        let handles = verify(&root, &expected).unwrap();
        #[cfg(windows)]
        {
            assert!(std::fs::write(&path, b"changed").is_err());
            assert!(std::fs::remove_file(&path).is_err());
        }
        drop(handles);
        std::fs::write(&path, b"changed").unwrap();
        assert!(verify(&root, &expected).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }
}
