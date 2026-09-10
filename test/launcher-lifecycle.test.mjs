import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const main = fs.readFileSync('launcher/src-tauri/src/main.rs', 'utf8');
const lifecycle = fs.readFileSync('launcher/src-tauri/src/lifecycle.rs', 'utf8');

test('writable Windows UI reserves settings ownership after read-only entries and before building UI', () => {
  const entry = main.slice(main.indexOf('fn main()'));
  assert.ok(entry.indexOf('hosted::run()') < entry.indexOf('GuiWriteOwner::current_user()'));
  assert.ok(entry.indexOf('GuiWriteOwner::current_user()') < entry.indexOf('tauri::Builder::default()'));
  assert.match(entry, /let _gui_owner = match/);
  const owner = fs.readFileSync('launcher/src-tauri/src/gui_owner.rs', 'utf8');
  assert.match(owner, /dirs::config_dir\(\)/);
  assert.match(owner, /\.share_mode\(0\)/);
  assert.match(owner, /\.truncate\(false\)/);
});

test('every app command uses a completion-lifetime guard and async additions require an audit', () => {
  assert.match(main, /\.invoke_handler\(\|invoke\| \{\s*let Ok\(_command\) = lifecycle::LIFECYCLE.command\(\)/);
  assert.match(main, /handler\(invoke\)/);
  assert.doesNotMatch(main, /#\[tauri::command[^\]]*async|#\[tauri::command[^\]]*\]\s*async fn/);
});

test('native close and exit share the atomic guard, not frontend busy detection', () => {
  assert.match(main, /\.on_window_event\(lifecycle::window_event\)/);
  assert.match(main, /\.run\(lifecycle::run_event\)/);
  assert.match(lifecycle, /CloseRequested \{ api, \.\. \}[\s\S]*?request_close\(\)[\s\S]*?api.prevent_close/);
  assert.match(lifecycle, /ExitRequested \{ api, \.\. \}[\s\S]*?request_close\(\)[\s\S]*?api.prevent_exit/);
  assert.match(lifecycle, /CreatorSuite.LifecycleProtocol/);
  assert.match(lifecycle, /CreatorSuite.LauncherBusy/);
  assert.match(lifecycle, /CreatorSuite.Closing/);
  assert.doesNotMatch(lifecycle, /std::fs|std::net|Command::|TerminateProcess|KillProcess|std::process::exit/);
});

test('new installer and uninstaller replace the force-kill macro with refusal', () => {
  const hook = fs.readFileSync('launcher/src-tauri/windows/installer-hooks.nsh', 'utf8');
  assert.match(hook, /!macroundef CheckIfAppIsRunning/);
  assert.match(hook, /!macro CheckIfAppIsRunning executableName productName/);
  const guard = fs.readFileSync('launcher/src-tauri/windows/installer-preflight.ps1', 'utf8');
  assert.match(hook, /MUI_CUSTOMFUNCTION_GUIINIT CreatorMcpPreflight/);
  assert.match(hook, /NSIS_HOOK_PREUNINSTALL/);
  assert.match(hook, /Call un\.CreatorMcpPreflight/);
  assert.match(hook, /\$CreatorPreflightPassed != 1/);
  assert.match(guard, /Get-CimInstance Win32_Process/);
  assert.match(hook, /No applications will be force-closed/);
  assert.doesNotMatch(hook + guard, /KillProcess|Stop-Process|taskkill|TerminateProcess/);
});
