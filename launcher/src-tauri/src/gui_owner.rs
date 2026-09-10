//! Exclusive ownership for compatible writable Windows presentations.
//! Read-only hosting and client-owned MCP stdio servers never acquire this file.
use std::{
    fs::{self, File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::Path,
};

const LOCK_FILE: &str = "launcher-gui.lock";

#[derive(Debug)]
pub struct GuiWriteOwner {
    _file: File,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OwnershipError {
    Busy,
    Unavailable,
}

impl GuiWriteOwner {
    pub fn current_user() -> Result<Self, OwnershipError> {
        let root = dirs::config_dir().ok_or(OwnershipError::Unavailable)?;
        Self::acquire(&root.join(crate::APP_CONFIG_DIR))
    }

    fn acquire(settings_directory: &Path) -> Result<Self, OwnershipError> {
        fs::create_dir_all(settings_directory).map_err(|_| OwnershipError::Unavailable)?;
        // Windows resolves aliases/case to the same file identity. Denying all
        // sharing also prevents deleting/replacing the lock while it is held.
        // Keep this ordinary file on release; deleting it introduces a race.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(settings_directory.join(LOCK_FILE))
            .map_err(|error| match error.raw_os_error() {
                Some(32 | 33) => OwnershipError::Busy,
                _ => OwnershipError::Unavailable,
            })?;
        Ok(Self { _file: file })
    }
}

pub fn show_blocked(error: OwnershipError) {
    use windows_sys::{
        core::w,
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONEXCLAMATION, MB_OK},
    };
    let message = match error {
        OwnershipError::Busy => w!("Creator Works MCP settings are already being managed by another compatible window. Close that window before opening another writable MCP window. No application has been stopped."),
        OwnershipError::Unavailable => w!("Creator Works MCP could not reserve access to its launcher settings. No settings were changed. Check the settings folder permissions before trying again."),
    };
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message,
            w!("Creator Works MCP"),
            MB_OK | MB_ICONEXCLAMATION,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Command};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("creator-gui-owner-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn same_settings_aliases_are_exclusive_and_release_without_truncation() {
        let fixture = Fixture::new();
        let marker = fixture.0.join(LOCK_FILE);
        fs::write(&marker, b"preserve-existing-marker").unwrap();
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&fixture.0).unwrap_err(),
            OwnershipError::Busy
        );
        let alias = PathBuf::from(fixture.0.to_string_lossy().to_lowercase()).join(".");
        assert_eq!(
            GuiWriteOwner::acquire(&alias).unwrap_err(),
            OwnershipError::Busy
        );
        let canonical = fs::canonicalize(&fixture.0).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&canonical).unwrap_err(),
            OwnershipError::Busy
        );
        assert!(fs::remove_file(&marker).is_err());
        drop(owner);
        assert_eq!(fs::read(&marker).unwrap(), b"preserve-existing-marker");
        let again = GuiWriteOwner::acquire(&fixture.0).unwrap();
        drop(again);
    }

    #[test]
    fn other_settings_roots_are_independent_and_access_errors_are_not_idle() {
        let first = Fixture::new();
        let second = Fixture::new();
        let _a = GuiWriteOwner::acquire(&first.0).unwrap();
        let b = GuiWriteOwner::acquire(&second.0).unwrap();
        drop(b);
        fs::remove_file(second.0.join(LOCK_FILE)).unwrap();
        fs::create_dir(second.0.join(LOCK_FILE)).unwrap();
        assert_eq!(
            GuiWriteOwner::acquire(&second.0).unwrap_err(),
            OwnershipError::Unavailable
        );
    }

    #[test]
    #[ignore = "subprocess fixture, invoked by cross_process_ownership"]
    fn process_fixture() {
        let Some(root) = std::env::var_os("CREATOR_GUI_OWNER_TEST_ROOT") else {
            return;
        };
        let result = GuiWriteOwner::acquire(Path::new(&root));
        std::process::exit(match result {
            Ok(_) => 0,
            Err(OwnershipError::Busy) => 10,
            Err(_) => 11,
        });
    }

    #[test]
    fn cross_process_ownership() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let child = || {
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "gui_owner::tests::process_fixture", "--ignored"])
                .env("CREATOR_GUI_OWNER_TEST_ROOT", &fixture.0)
                .creation_flags(0x08000000)
                .status()
                .unwrap()
                .code()
        };
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        assert_eq!(child(), Some(10));
        drop(owner);
        assert_eq!(child(), Some(0));
        let owner = GuiWriteOwner::acquire(&fixture.0).unwrap();
        drop(owner);
    }
}
