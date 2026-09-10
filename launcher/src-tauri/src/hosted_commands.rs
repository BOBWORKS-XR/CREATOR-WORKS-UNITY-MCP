//! The normal MCP UI uses these existing handlers in both presentations.
use serde::Deserialize;
use serde_json::Value;

pub const COMMANDS: &[&str] = &[
    "begin_ui_operation",
    "finish_ui_operation",
    "load_config",
    "save_config",
    "discover_unity_projects",
    "get_onboarding_status",
    "add_project",
    "one_click_setup",
    "get_project_sdk_profile",
    "get_unity_extension_status",
    "update_configured_unity_extensions",
    "update_codex_mcp_config",
    "update_claude_mcp_config",
    "update_antigravity_mcp_config",
    "update_opencode_mcp_config",
    "remove_codex_mcp_config",
    "remove_claude_mcp_config",
    "remove_antigravity_mcp_config",
    "remove_opencode_mcp_config",
    "install_unity_extension",
    "set_unity_custom_scripts",
    "set_unity_allow_all_tests",
    "get_project_feedback_settings",
    "set_project_feedback_settings",
];

pub fn needs_workflow(command: &str) -> bool {
    COMMANDS.contains(&command)
        && !matches!(
            command,
            "begin_ui_operation"
                | "finish_ui_operation"
                | "get_onboarding_status"
                | "get_project_sdk_profile"
                | "get_unity_extension_status"
                | "get_project_feedback_settings"
        )
}

macro_rules! args {
    ($value:expr, {$($field:ident: $kind:ty),* $(,)?}) => {{
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args { $($field: $kind),* }
        serde_json::from_value::<Args>($value).map_err(|_| "Invalid hosted command arguments.".to_owned())?
    }};
}
fn encoded(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Cannot encode MCP result.".into())
}

pub fn dispatch(app: &tauri::AppHandle, command: &str, value: Value) -> Result<Value, String> {
    match command {
        "load_config" => {
            args!(value, {});
            encoded(crate::load_config(app.clone())?)
        }
        "save_config" => {
            let a = args!(value, {config: crate::LauncherConfig});
            crate::save_config(a.config)?;
            Ok(Value::Null)
        }
        "discover_unity_projects" => {
            args!(value, {});
            encoded(crate::discover_unity_projects(app.clone())?)
        }
        "get_onboarding_status" => {
            let a = args!(value, {unity_project_path: Option<String>});
            encoded(crate::get_onboarding_status(
                app.clone(),
                a.unity_project_path,
            ))
        }
        "add_project" => {
            let a = args!(value, {project_path: String});
            encoded(crate::add_project(a.project_path)?)
        }
        "one_click_setup" => {
            let a = args!(value, {unity_project_path: String, configure_codex: bool, configure_claude: bool,
                configure_antigravity: bool, configure_opencode: bool, tool_groups: String, enable_custom_scripts: bool});
            encoded(crate::one_click_setup(
                app.clone(),
                a.unity_project_path,
                a.configure_codex,
                a.configure_claude,
                a.configure_antigravity,
                a.configure_opencode,
                a.tool_groups,
                a.enable_custom_scripts,
            )?)
        }
        "get_project_sdk_profile" => {
            let a = args!(value, {unity_project_path: String});
            encoded(crate::get_project_sdk_profile(a.unity_project_path))
        }
        "get_unity_extension_status" => {
            let a = args!(value, {unity_project_path: String});
            encoded(crate::get_unity_extension_status(
                app.clone(),
                a.unity_project_path,
            )?)
        }
        "update_configured_unity_extensions" => {
            args!(value, {});
            encoded(crate::update_configured_unity_extensions(app.clone())?)
        }
        "install_unity_extension" => {
            let a = args!(value, {unity_project_path: String});
            crate::install_unity_extension(app.clone(), a.unity_project_path)?;
            Ok(Value::Null)
        }
        "update_codex_mcp_config"
        | "update_claude_mcp_config"
        | "update_antigravity_mcp_config"
        | "update_opencode_mcp_config" => {
            let a = args!(value, {channel: crate::ProjectChannel, mcp_server_path: String, tool_groups: String});
            let update = match command {
                "update_codex_mcp_config" => crate::update_codex_mcp_config,
                "update_claude_mcp_config" => crate::update_claude_mcp_config,
                "update_antigravity_mcp_config" => crate::update_antigravity_mcp_config,
                _ => crate::update_opencode_mcp_config,
            };
            update(app.clone(), a.channel, a.mcp_server_path, a.tool_groups)?;
            Ok(Value::Null)
        }
        "remove_codex_mcp_config"
        | "remove_claude_mcp_config"
        | "remove_antigravity_mcp_config"
        | "remove_opencode_mcp_config" => {
            args!(value, {});
            let remove = match command {
                "remove_codex_mcp_config" => crate::remove_codex_mcp_config,
                "remove_claude_mcp_config" => crate::remove_claude_mcp_config,
                "remove_antigravity_mcp_config" => crate::remove_antigravity_mcp_config,
                _ => crate::remove_opencode_mcp_config,
            };
            remove()?;
            Ok(Value::Null)
        }
        "set_unity_custom_scripts" | "set_unity_allow_all_tests" => {
            let a = args!(value, {unity_project_path: String, enabled: bool});
            if command == "set_unity_custom_scripts" {
                crate::set_unity_custom_scripts(a.unity_project_path, a.enabled)?;
            } else {
                crate::set_unity_allow_all_tests(a.unity_project_path, a.enabled)?;
            }
            Ok(Value::Null)
        }
        "get_project_feedback_settings" => {
            let a = args!(value, {unity_project_path: String});
            crate::get_project_feedback_settings(a.unity_project_path)
        }
        "set_project_feedback_settings" => {
            let a =
                args!(value, {unity_project_path: String, enabled: bool, usage_check_ins: bool});
            crate::set_project_feedback_settings(a.unity_project_path, a.enabled, a.usage_check_ins)
        }
        _ => Err("Unsupported writable MCP command.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn write_commands_require_a_workflow_but_read_queries_do_not() {
        for command in [
            "load_config",
            "save_config",
            "discover_unity_projects",
            "one_click_setup",
            "install_unity_extension",
            "remove_codex_mcp_config",
            "set_project_feedback_settings",
        ] {
            assert!(needs_workflow(command), "{command}");
        }
        for command in [
            "begin_ui_operation",
            "finish_ui_operation",
            "get_project_sdk_profile",
            "get_onboarding_status",
        ] {
            assert!(!needs_workflow(command));
        }
        let mut names = COMMANDS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), COMMANDS.len());
    }
    #[test]
    fn arguments_reject_unknown_fields_and_wrong_types() {
        fn decode(value: Value) -> Result<Value, String> {
            let a = args!(value, {unity_project_path: String, enabled: bool});
            Ok(json!({"path":a.unity_project_path,"enabled":a.enabled}))
        }
        assert!(decode(json!({"unityProjectPath":"X", "enabled":true})).is_ok());
        assert!(decode(json!({"unityProjectPath":"X", "enabled":"true"})).is_err());
        assert!(decode(json!({"unityProjectPath":"X", "enabled":true,"extra":1})).is_err());
    }
}
