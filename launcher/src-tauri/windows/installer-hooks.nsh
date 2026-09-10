; Tauri's default macro kills the GUI in silent/passive mode. Replace it for
; both this installer and its generated uninstaller. This cannot change an
; already-installed legacy uninstaller; installerProtocol remains 0.
!ifmacrondef CheckIfAppIsRunning
  !error "Expected Tauri running-app macro is missing; review installer template"
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& { param([string]$$exe); try { $$name = [IO.Path]::GetFileNameWithoutExtension($$exe); $$running = @(Get-Process -ErrorAction Stop | Where-Object { $$_.ProcessName -eq $$name }); if ($$running.Count -gt 0) { exit 10 }; exit 0 } catch { exit 11 } }" "${executableName}"`
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK \
      "${productName} is running, or Setup could not verify that it is closed.$\r$\n$\r$\nFinish your work and close the app, then try again. Setup will not force-close it." /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
creator_works_mcp_runtime_check:
  ClearErrors
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& { param([string]$$installDir); $$target = [IO.Path]::GetFullPath((Join-Path $$installDir 'server\runtime\node.exe')); try { $$running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.Name -eq 'node.exe' -and $$_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($$_.ExecutablePath), $$target, [StringComparison]::OrdinalIgnoreCase) }) } catch { exit 11 }; if ($$running.Count -gt 0) { exit 10 }; exit 0 }" "$INSTDIR"`
  Pop $0
  Pop $1

  StrCmp $0 "0" creator_works_mcp_runtime_ready
  StrCmp $0 "10" creator_works_mcp_runtime_locked

  MessageBox MB_ICONSTOP|MB_OK \
    "Setup could not check whether Creator Works MCP is still running.$\r$\n$\r$\nClose Codex, Claude Code, and Creator Works MCP, then run Setup again." /SD IDOK
  SetErrorLevel 11
  Abort

creator_works_mcp_runtime_locked:
  IfSilent creator_works_mcp_runtime_silent_abort creator_works_mcp_runtime_prompt

creator_works_mcp_runtime_prompt:
  MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL \
    "Creator Works MCP is currently running inside Codex or Claude Code.$\r$\n$\r$\nSave your work, fully close those applications, then click Retry. Setup will not force-close them." \
    IDRETRY creator_works_mcp_runtime_check \
    IDCANCEL creator_works_mcp_runtime_abort

creator_works_mcp_runtime_abort:
  SetErrorLevel 10
  Abort

creator_works_mcp_runtime_silent_abort:
  DetailPrint "Creator Works MCP runtime is in use; close MCP clients before upgrading."
  SetErrorLevel 10
  Quit

creator_works_mcp_runtime_ready:
!macroend
