import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const main = fs.readFileSync('launcher/src-tauri/src/main.rs', 'utf8');
const lifecycle = fs.readFileSync('launcher/src-tauri/src/lifecycle.rs', 'utf8');

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
  assert.match(hook, /Get-Process -ErrorAction Stop/);
  assert.match(hook, /will not force-close it/);
  assert.match(hook, /installerProtocol remains 0/);
  assert.doesNotMatch(hook, /KillProcess|Stop-Process|taskkill|TerminateProcess/);
});
