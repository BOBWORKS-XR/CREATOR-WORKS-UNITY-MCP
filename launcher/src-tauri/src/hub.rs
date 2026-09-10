use serde::Serialize;
use std::ffi::OsString;
use std::io::Write;

pub const INFO_FLAG: &str = "--creator-hub-info";
pub const HOST_FLAG: &str = "--creator-hub-host";
const MAX_INFO_BYTES: usize = 4096;

#[derive(Debug, PartialEq)]
pub enum EntryMode {
    Standalone,
    Info,
    PreviewHost,
    InvalidHubArguments,
}

pub fn entry_mode(arguments: &[OsString]) -> EntryMode {
    if arguments.len() == 1 && arguments[0] == INFO_FLAG {
        EntryMode::Info
    } else if arguments.len() == 1 && arguments[0] == HOST_FLAG {
        EntryMode::PreviewHost
    } else if arguments.iter().any(|value| {
        value
            .to_string_lossy()
            .to_ascii_lowercase()
            .starts_with("--creator-hub")
    }) {
        EntryMode::InvalidHubArguments
    } else {
        EntryMode::Standalone
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppIdentity {
    schema_version: u8,
    app_id: &'static str,
    display_name: &'static str,
    version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    capabilities: Vec<&'static str>,
}

pub fn write_identity(output: &mut impl Write) -> Result<(), &'static str> {
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => return Err("Unsupported Hub platform"),
    };
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => return Err("Unsupported Hub architecture"),
    };
    let identity = AppIdentity {
        schema_version: 1,
        app_id: "creator-works-mcp",
        display_name: "Creator Works MCP",
        version: env!("CARGO_PKG_VERSION"),
        platform,
        architecture,
        // Only add a native lifecycle capability after its packaged-platform test passes.
        capabilities: vec!["launch.standalone"],
    };
    let mut bytes =
        serde_json::to_vec(&identity).map_err(|_| "Could not serialize Hub identity")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_INFO_BYTES {
        return Err("Hub identity exceeds output limit");
    }
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .map_err(|_| "Could not write Hub identity")
}

pub fn handle_entry(arguments: &[OsString]) -> Option<i32> {
    match entry_mode(arguments) {
        EntryMode::Standalone | EntryMode::PreviewHost => None,
        EntryMode::Info => Some(match write_identity(&mut std::io::stdout().lock()) {
            Ok(()) => 0,
            Err(message) => {
                eprintln!("{message}");
                1
            }
        }),
        EntryMode::InvalidHubArguments => {
            eprintln!("Use --creator-hub-info alone, or --creator-hub-host alone; no other Hub arguments are accepted.");
            Some(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosting_is_an_exact_preview_entry_not_an_advertised_capability() {
        assert_eq!(entry_mode(&[HOST_FLAG.into()]), EntryMode::PreviewHost);
        for args in [
            vec![HOST_FLAG.into(), "extra".into()],
            vec![HOST_FLAG.into(), INFO_FLAG.into()],
            vec!["--CREATOR-HUB-HOST".into()],
            vec!["--creator-hub-host=1".into()],
        ] {
            assert_eq!(entry_mode(&args), EntryMode::InvalidHubArguments);
        }
    }

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn exact_info_flag_only() {
        assert_eq!(entry_mode(&args(&[INFO_FLAG])), EntryMode::Info);
        for values in [
            vec![INFO_FLAG, "--project", "C:/Other"],
            vec!["--output", "receipt.json", INFO_FLAG],
            vec![INFO_FLAG, INFO_FLAG],
            vec!["--creator-hub-info=anything"],
            vec!["--creator-hub-unknown"],
            vec!["--creator-hub"],
            vec!["--CREATOR-HUB-INFO"],
        ] {
            assert_eq!(entry_mode(&args(&values)), EntryMode::InvalidHubArguments);
        }
    }

    #[test]
    fn standalone_args_never_become_routes_or_commands() {
        assert_eq!(entry_mode(&[]), EntryMode::Standalone);
        assert_eq!(
            entry_mode(&args(&["--project", "C:/Other", "--repair"])),
            EntryMode::Standalone
        );
    }

    #[test]
    fn identity_is_bounded_and_contains_only_static_build_metadata() {
        let mut output = vec![];
        write_identity(&mut output).unwrap();
        assert!(output.len() <= MAX_INFO_BYTES);
        assert_eq!(output.iter().filter(|b| **b == b'\n').count(), 1);
        assert_eq!(output.last(), Some(&b'\n'));
        let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 7);
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["appId"], "creator-works-mcp");
        assert_eq!(value["displayName"], "Creator Works MCP");
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["platform"], std::env::consts::OS);
        assert_eq!(value["architecture"], std::env::consts::ARCH);
        assert_eq!(
            value["capabilities"],
            serde_json::json!(["launch.standalone"])
        );
    }

    #[test]
    fn output_failure_is_not_success() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(write_identity(&mut Broken).is_err());
    }
}
