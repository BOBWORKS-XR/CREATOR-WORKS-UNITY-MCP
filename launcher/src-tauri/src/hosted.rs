//! Read-only MCP adapter for the suite's preview v1 inherited-pipe protocol.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, Read, Write},
    path::Path,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;

const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_CONFIG: usize = 256 * 1024;
const MAX_ID: u64 = 9_007_199_254_740_991;
pub const COMMANDS: &[&str] = &[
    "get_hosted_snapshot",
    "pick_project_folder",
    "open_official_url",
];
const OFFICIAL_URLS: &[&str] = &[
    "https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP",
    "https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases",
    "https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases",
    "https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    session: String,
    id: u64,
    command: String,
    args: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlArgs {
    url: String,
}

fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|_| "Invalid hosted command arguments.".into())
}

fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_REQUEST + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "Cannot read hosted request.")?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_REQUEST || bytes.last() != Some(&b'\n') {
        return Err("Oversized or incomplete hosted request.".into());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "Invalid hosted request.")?;
    if request.protocol != 1
        || request.session.len() != 64
        || !request.session.bytes().all(|c| c.is_ascii_hexdigit())
        || request.id > MAX_ID
        || !request.args.is_object()
    {
        return Err("Invalid hosted protocol, session or request ID.".into());
    }
    Ok(Some(request))
}

fn send(
    output: &mut impl Write,
    session: &str,
    id: u64,
    result: Result<Value, String>,
) -> Result<(), String> {
    let response = match result {
        Ok(value) => json!({"session": session, "id": id, "ok": true, "result": value}),
        Err(error) => json!({"session": session, "id": id, "ok": false, "error": error}),
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|_| "Cannot encode hosted response.")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_RESPONSE {
        return Err("Hosted response exceeds the size limit.".into());
    }
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .map_err(|_| "Host disconnected; no request will be replayed.".into())
}

fn assets(context: &tauri::Context<tauri::Wry>) -> Result<BTreeMap<String, String>, String> {
    let mut files = BTreeMap::new();
    let mut total = 0;
    for (key, _) in context.assets().iter() {
        // Assets::iter exposes compressed release bytes; get decodes them.
        let bytes = context
            .assets()
            .get(&key.as_ref().into())
            .ok_or("Cannot decode MCP asset.")?;
        let name = key.to_string().trim_start_matches('/').to_owned();
        if name.contains("..")
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/_-.".contains(&c))
        {
            return Err("Invalid bundled asset name.".into());
        }
        let encoded = STANDARD.encode(bytes);
        total += name.len() + encoded.len() + 6;
        if total > MAX_RESPONSE - 4096 {
            return Err("Bundled UI exceeds the preview size limit.".into());
        }
        files.insert(name, encoded);
    }
    Ok(files)
}

fn config_snapshot(
    current: &Path,
    legacy: &Path,
) -> Result<(Option<crate::LauncherConfig>, &'static str), String> {
    for (path, source) in [(current, "current"), (legacy, "legacy (not migrated)")] {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err("Cannot read saved MCP configuration; it was left unchanged.".into())
            }
        };
        let mut bytes = Vec::new();
        file.take((MAX_CONFIG + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read saved MCP configuration.")?;
        if bytes.len() > MAX_CONFIG {
            return Err("Saved configuration exceeds the preview size limit.".into());
        }
        let config: crate::LauncherConfig = serde_json::from_slice(&bytes)
            .map_err(|_| "Saved configuration is invalid; it was left unchanged.")?;
        if config.channels.len() > 256 {
            return Err("Too many projects for this bounded preview.".into());
        }
        return Ok((Some(config), source));
    }
    Ok((None, "none"))
}

fn dispatch(app: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    let _command = crate::lifecycle::LIFECYCLE
        .command()
        .map_err(String::from)?;
    match command {
        "get_hosted_snapshot" => {
            decode::<NoArgs>(args)?;
            // No get_config_path, root resolver, migrating loaders or client config readers.
            let base = dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?;
            let (config, source) = config_snapshot(
                &base
                    .join(crate::APP_CONFIG_DIR)
                    .join("launcher-config.json"),
                &base
                    .join(crate::LEGACY_APP_CONFIG_DIR)
                    .join("launcher-config.json"),
            )?;
            Ok(
                json!({ "config": config, "source": source, "readOnly": true,
                "resourceDir": app.path().resource_dir().map_err(|_| "Cannot locate MCP resources.")? }),
            )
        }
        "pick_project_folder" => {
            decode::<NoArgs>(args)?;
            let selection = app
                .dialog()
                .file()
                .set_title("Select a folder (read-only preview)")
                .blocking_pick_folder();
            Ok(json!(selection.map(|path| path.to_string())))
        }
        "open_official_url" => {
            let url = decode::<UrlArgs>(args)?.url;
            if !OFFICIAL_URLS.contains(&url.as_str()) {
                return Err("Only fixed official Creator Works links are allowed.".into());
            }
            // Keep the same shell plugin used by standalone; do not add another opener dependency.
            #[allow(deprecated)]
            app.shell()
                .open(url, None)
                .map_err(|_| "Cannot open official page.")?;
            Ok(Value::Null)
        }
        _ => Err("Unsupported hosted MCP command. This preview is read-only.".into()),
    }
}

fn serve(
    input: &mut impl BufRead,
    output: &mut impl Write,
    files: BTreeMap<String, String>,
    approve: impl FnOnce() -> bool,
    mut call: impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<(), String> {
    let hello = read_request(input)?.ok_or("Host disconnected before initialization.")?;
    if hello.id != 0 || hello.command != "initialize" {
        return Err("Expected hosted initialization.".into());
    }
    decode::<NoArgs>(hello.args)?;
    if !approve() {
        send(
            output,
            &hello.session,
            0,
            Err("Opening MCP in Hub was declined. Standalone MCP is unchanged.".into()),
        )?;
        return Ok(());
    }
    send(
        output,
        &hello.session,
        0,
        Ok(
            json!({"appId": "creator-works-mcp", "version": env!("CARGO_PKG_VERSION"), "protocol": 1, "files": files}),
        ),
    )?;
    let mut previous_id = 0;
    while let Some(request) = read_request(input)? {
        if request.session != hello.session || request.id <= previous_id {
            return Err("Mismatched or replayed hosted request.".into());
        }
        previous_id = request.id;
        if !COMMANDS.contains(&request.command.as_str()) {
            return Err("Unknown hosted MCP command.".into());
        }
        let result = call(&request.command, request.args);
        // Complete an accepted command before observing EOF; never replay after a lost reply.
        send(output, &hello.session, request.id, result)?;
    }
    Ok(())
}

#[cfg(windows)]
fn parent_host() -> Result<String, String> {
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    unsafe {
        if GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE
            || GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE
        {
            return Err("Hosted mode requires private inherited input and output pipes.".into());
        }
        for stream in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            if SetHandleInformation(GetStdHandle(stream), HANDLE_FLAG_INHERIT, 0) == 0 {
                return Err("Cannot prevent hosting pipe inheritance.".into());
            }
        }
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Cannot inspect parent process.".into());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent = 0;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            if entry.th32ProcessID == std::process::id() {
                parent = entry.th32ParentProcessID;
                break;
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        if parent == 0 {
            return Err("Cannot identify parent process.".into());
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent);
        if process.is_null() {
            return Err("Cannot open parent process identity.".into());
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if ok == 0 {
            return Err("Cannot inspect host executable.".into());
        }
        let path =
            String::from_utf16(&buffer[..length as usize]).map_err(|_| "Invalid host path.")?;
        // Routing check only, not publisher authentication; native consent is still required.
        if !Path::new(&path).file_name().is_some_and(|name| {
            name.to_string_lossy()
                .eq_ignore_ascii_case("creator-hub.exe")
        }) {
            return Err("Hosted mode must be launched directly by Creator Hub.".into());
        }
        Ok(path)
    }
}
#[cfg(not(windows))]
fn parent_host() -> Result<String, String> {
    Err("Native hosting preview is Windows-only.".into())
}

pub fn run() -> Result<(), String> {
    let host = parent_host()?;
    let mut context = tauri::generate_context!();
    let files = assets(&context)?;
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let result = serve(&mut std::io::stdin().lock(), &mut std::io::stdout().lock(), files,
                    || app.dialog().message(format!("Open MCP's read-only preview inside this Creator Hub window?\n\n{host}\n\nOnly continue if you just chose MCP in Hub. It can read saved launcher settings and show a folder picker. It cannot update bridges, migrate settings, install apps, or change shortcuts. The host path alone does not verify its publisher."))
                        .title("Open MCP in Creator Hub?").kind(MessageDialogKind::Info)
                        .buttons(MessageDialogButtons::OkCancelCustom("Open read-only preview".into(), "Not now".into())).blocking_show(),
                    |command, args| dispatch(&app, command, args));
                if let Err(error) = &result { eprintln!("Hosted MCP stopped: {error}"); }
                app.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context).map_err(|error| error.to_string())?
        .run(crate::lifecycle::run_event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u64, command: &str) -> String {
        format!(
            "{}\n",
            json!({"protocol":1,"session":"a".repeat(64),"id":id,"command":command,"args":{}})
        )
    }
    fn replies(output: &[u8]) -> Vec<Value> {
        std::str::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    #[test]
    fn initialization_and_decline_never_dispatch_a_command() {
        for approved in [true, false] {
            let mut output = Vec::new();
            serve(
                &mut request(0, "initialize").as_bytes(),
                &mut output,
                BTreeMap::new(),
                || approved,
                |_, _| panic!("Initialization must not invoke configuration or project commands"),
            )
            .unwrap();
            let reply = &replies(&output)[0];
            assert_eq!(reply["ok"], approved);
            if approved {
                assert_eq!(reply["result"]["appId"], "creator-works-mcp");
                assert_eq!(reply["result"].as_object().unwrap().len(), 4);
            } else {
                assert!(reply.get("result").is_none());
            }
        }
    }
    #[test]
    fn requests_are_sequential_and_errors_do_not_replay() {
        let input = request(0, "initialize") + &request(1, COMMANDS[0]) + &request(2, COMMANDS[0]);
        let mut count = 0;
        let mut output = Vec::new();
        serve(
            &mut input.as_bytes(),
            &mut output,
            BTreeMap::new(),
            || true,
            |name, _| {
                assert_eq!(name, COMMANDS[0]);
                count += 1;
                if count == 1 {
                    Err("fixture failure".into())
                } else {
                    Ok(json!(count))
                }
            },
        )
        .unwrap();
        assert_eq!(count, 2);
        let frames = replies(&output);
        assert_eq!(frames[1]["ok"], false);
        assert_eq!(frames[2]["result"], 2);
    }
    #[test]
    fn replay_wrong_session_and_mutation_commands_fail_closed() {
        for invalid in [
            request(0, COMMANDS[0]),
            request(1, COMMANDS[0]).replace(&"a".repeat(64), &"b".repeat(64)),
            request(1, "save_config"),
            request(1, "load_config"),
            request(1, "begin_ui_operation"),
            request(1, "shutdown"),
        ] {
            let mut output = Vec::new();
            let input = request(0, "initialize") + &invalid;
            assert!(serve(
                &mut input.as_bytes(),
                &mut output,
                BTreeMap::new(),
                || true,
                |_, _| panic!("invalid request dispatched")
            )
            .is_err());
            assert_eq!(replies(&output).len(), 1);
        }
    }
    #[test]
    fn protocol_bounds_and_argument_shapes_are_strict() {
        let valid = request(0, "initialize");
        for input in [
            vec![b'x'; MAX_REQUEST + 1],
            b"{}\n".to_vec(),
            vec![0xff, b'\n'],
            valid.trim_end().as_bytes().to_vec(),
            valid
                .replace("\"id\":0", "\"id\":9007199254740992")
                .into_bytes(),
            valid
                .replace("\"args\":{}", "\"args\":{},\"extra\":true")
                .into_bytes(),
            valid.replace("\"args\":{}", "\"args\":[]").into_bytes(),
        ] {
            assert!(read_request(&mut input.as_slice()).is_err());
        }
        assert!(read_request(&mut b"".as_slice()).unwrap().is_none());
        assert!(decode::<NoArgs>(json!({"path":"extra"})).is_err());
        assert!(decode::<UrlArgs>(json!({"url":"https://example.org", "with":"cmd"})).is_err());
        assert!(!OFFICIAL_URLS.contains(&"file:///C:/test.exe"));
        assert!(!OFFICIAL_URLS
            .contains(&"https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP?run=1"));
    }
    #[test]
    fn large_response_is_rejected_before_any_partial_write() {
        let mut output = Vec::new();
        assert!(send(
            &mut output,
            &"a".repeat(64),
            1,
            Ok(json!("x".repeat(MAX_RESPONSE)))
        )
        .is_err());
        assert!(output.is_empty());
    }
    #[test]
    fn lost_output_does_not_replay_or_start_the_next_request() {
        struct FailAfterHello {
            frames: usize,
        }
        impl Write for FailAfterHello {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.frames += 1;
                if self.frames > 1 {
                    Err(std::io::ErrorKind::BrokenPipe.into())
                } else {
                    Ok(data.len())
                }
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = 0;
        let input = request(0, "initialize") + &request(1, COMMANDS[0]) + &request(2, COMMANDS[0]);
        assert!(serve(
            &mut input.as_bytes(),
            &mut FailAfterHello { frames: 0 },
            BTreeMap::new(),
            || true,
            |_, _| {
                count += 1;
                Ok(Value::Null)
            }
        )
        .is_err());
        assert_eq!(count, 1);
    }
    #[test]
    fn config_reads_do_not_create_migrate_or_repair_files() {
        let root =
            std::env::temp_dir().join(format!("creator-mcp-hosted-{}", uuid::Uuid::new_v4()));
        let current = root.join("current/launcher-config.json");
        let legacy = root.join("legacy/launcher-config.json");
        assert!(config_snapshot(&current, &legacy).unwrap().0.is_none());
        assert!(!root.exists());
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let original = br#"{"channels":[],"active_channel_id":null,"auto_start":false,"mcp_server_path":"C:/old/server.js","tool_groups":"full","unrelated":"preserve"}"#;
        std::fs::write(&legacy, original).unwrap();
        let before = std::fs::metadata(&legacy).unwrap().modified().unwrap();
        let (config, source) = config_snapshot(&current, &legacy).unwrap();
        assert_eq!(source, "legacy (not migrated)");
        assert_eq!(config.unwrap().mcp_server_path, "C:/old/server.js");
        assert!(!current.parent().unwrap().exists());
        assert_eq!(std::fs::read(&legacy).unwrap(), original);
        assert_eq!(
            std::fs::metadata(&legacy).unwrap().modified().unwrap(),
            before
        );
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&current, "invalid").unwrap();
        assert!(config_snapshot(&current, &legacy).is_err());
        assert_eq!(std::fs::read_to_string(&current).unwrap(), "invalid");
        std::fs::write(&current, vec![b'x'; MAX_CONFIG + 1]).unwrap();
        assert!(config_snapshot(&current, &legacy).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn embedded_assets_decode_to_real_html_javascript_and_original_bitmap() {
        let files = assets(&tauri::generate_context!()).unwrap();
        let html = String::from_utf8(STANDARD.decode(&files["index.html"]).unwrap()).unwrap();
        assert!(html.contains("hostedPreview"));
        let script = String::from_utf8(STANDARD.decode(&files["runtime.js"]).unwrap()).unwrap();
        assert!(script.contains("CreatorRuntime"));
        assert_eq!(
            &STANDARD.decode(&files["creator-works-logo.png"]).unwrap()[..8],
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(COMMANDS.len(), 3);
    }
}
