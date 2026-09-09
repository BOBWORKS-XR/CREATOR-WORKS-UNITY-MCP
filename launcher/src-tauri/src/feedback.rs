use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn folder(project: &str) -> Result<PathBuf, String> {
    let project = Path::new(project);
    if !super::is_valid_unity_project(project) {
        return Err("Select a valid Unity project first".into());
    }
    let root = project.join(".bantworks-mcp");
    let folder = root.join("feedback");
    for path in [
        &root,
        &folder,
        &folder.join("settings.json"),
        &folder.join("MCP_FEEDBACK.md"),
        &folder.join("check-ins.json"),
    ] {
        if fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Linked feedback paths are not supported".into());
        }
    }
    Ok(folder)
}

pub fn read(project: &str) -> Result<Value, String> {
    let folder = folder(project)?;
    let file = folder.join("settings.json");
    let settings: Value = if file.exists() {
        if fs::metadata(&file).map_err(|e| e.to_string())?.len() > 16384 {
            return Err("Feedback settings are too large".into());
        }
        serde_json::from_str(&fs::read_to_string(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        json!({})
    };
    if !settings.is_object() {
        return Err("Invalid feedback settings; file was preserved".into());
    }
    Ok(json!({"enabled": settings["feedbackEnabled"] == true,
        "usageCheckIns": settings["feedbackEnabled"] == true && settings["usageCheckInsEnabled"] == true,
        "file": folder.join("MCP_FEEDBACK.md").to_string_lossy()}))
}

struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn write(project: &str, enabled: bool, check_ins: bool) -> Result<Value, String> {
    let folder = folder(project)?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let lock_path = folder.join(".write-lock");
    let lock_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|_| {
            "Feedback is busy or an interrupted write left a lock; no settings changed".to_string()
        })?;
    let _lock = Lock(lock_path);
    drop(lock_file);
    read(project)?;
    let journal = folder.join("MCP_FEEDBACK.md");
    if enabled && !journal.exists() {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(journal)
            .map_err(|e| e.to_string())?;
        file.write_all(b"# Creator Works MCP - Private Feedback\n\nLocal, optional notes. Nothing is uploaded automatically. Usage is self-reported, not measured token savings. Review and remove private content before sharing this file.\n").map_err(|e| e.to_string())?;
    }
    if enabled && !folder.join(".gitignore").exists() {
        let mut ignore = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(folder.join(".gitignore"))
            .map_err(|e| e.to_string())?;
        ignore.write_all(b"*\n").map_err(|e| e.to_string())?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    super::atomic_write(
        &folder.join("check-ins.json"),
        &json!({"lastPromptAt": now, "tasks": 0}).to_string(),
    )?;
    super::atomic_write(
        &folder.join("settings.json"),
        &json!({"feedbackEnabled": enabled, "usageCheckInsEnabled": enabled && check_ins})
            .to_string(),
    )?;
    read(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_is_opt_in_and_preserves_the_private_journal() {
        let root = std::env::temp_dir().join(format!("creator-feedback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        let project = root.to_str().unwrap();
        assert_eq!(read(project).unwrap()["enabled"], false);
        assert!(!root.join(".bantworks-mcp").exists());
        let enabled = write(project, true, true).unwrap();
        assert_eq!(enabled["usageCheckIns"], true);
        let file = PathBuf::from(enabled["file"].as_str().unwrap());
        fs::write(&file, "Private manual entry").unwrap();
        assert_eq!(write(project, false, true).unwrap()["usageCheckIns"], false);
        assert_eq!(fs::read_to_string(&file).unwrap(), "Private manual entry");
        assert_eq!(
            fs::read_to_string(file.parent().unwrap().join(".gitignore")).unwrap(),
            "*\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_locked_feedback_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!("creator-feedback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        let project = root.to_str().unwrap();
        write(project, true, false).unwrap();
        let folder = folder(project).unwrap();
        fs::write(folder.join("settings.json"), "broken").unwrap();
        assert!(write(project, false, false).is_err());
        assert_eq!(
            fs::read_to_string(folder.join("settings.json")).unwrap(),
            "broken"
        );
        assert!(!folder.join(".write-lock").exists());
        fs::write(folder.join(".write-lock"), "").unwrap();
        assert!(write(project, false, false).is_err());
        assert!(folder.join(".write-lock").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
