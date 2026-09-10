; -Command reparses trailing arguments and loses spaces in $INSTDIR. Use a
; packaged script and -File; append \. so a trailing slash cannot escape a quote.
!define CREATOR_PREFLIGHT_SCRIPT "${__FILEDIR__}\installer-preflight.ps1"
ReserveFile "${CREATOR_PREFLIGHT_SCRIPT}"
Var CreatorPreflightPassed

; Modern UI calls this after .onInit restores $INSTDIR and before any page,
; including Tauri's page that can invoke an already-installed uninstaller.
!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "Review existing GUI initialization before adding MCP preflight"
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT CreatorMcpPreflight

!macro CreatorDefinePreflight PREFIX
Function ${PREFIX}CreatorMcpPreflight
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $CreatorPreflightPassed 0
  ; Also check the prior current-user location if /D changes the destination.
  ReadRegStr $2 HKCU "Software\Creator Works\Creator Works MCP" ""
  StrCpy $3 $INSTDIR

creator_preflight_retry:
  InitPluginsDir
  StrCpy $1 "Cannot prepare the bundled preflight script."
  ClearErrors
  File /oname=$PLUGINSDIR\creator-mcp-preflight.ps1 "${CREATOR_PREFLIGHT_SCRIPT}"
  IfErrors creator_preflight_unavailable
  nsExec::ExecToStack /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\creator-mcp-preflight.ps1" -InstallDir "$3\."`
  Pop $0
  Pop $1
  StrCmp $0 "0" creator_preflight_next
  StrCmp $0 "10" creator_preflight_busy creator_preflight_unavailable

creator_preflight_busy:
  IfSilent creator_preflight_cancel
  MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL \
    "Creator Works MCP files are in use.$\r$\n$\r$\nSave your work and fully exit Creator Works MCP and AI clients using it: Codex, Claude Code, Antigravity, OpenCode, or another MCP client. Closing only the MCP launcher may leave its private runtime running.$\r$\n$\r$\nThen click Retry, or Cancel to stop Setup. No applications will be force-closed." /SD IDCANCEL \
    IDRETRY creator_preflight_retry IDCANCEL creator_preflight_cancel

creator_preflight_unavailable:
  IfSilent creator_preflight_cancel
  MessageBox MB_ICONSTOP|MB_RETRYCANCEL \
    "Setup could not verify access to Creator Works MCP files. Nothing further will be installed or removed.$\r$\n$\r$\nFully exit the MCP launcher and its AI clients (Codex, Claude Code, Antigravity, OpenCode, or others), then Retry. If this persists, Cancel and share the installer filename and Setup details with support. Do not choose Ignore on a file-write error.$\r$\n$\r$\nCheck result: $1" /SD IDCANCEL \
    IDRETRY creator_preflight_retry IDCANCEL creator_preflight_cancel

creator_preflight_cancel:
  DetailPrint "MCP preflight blocked Setup; no application was force-closed."
  SetErrorLevel 10
  Quit

creator_preflight_next:
  StrCmp $2 "" creator_preflight_ready
  StrCmp $2 $3 creator_preflight_ready
  StrCpy $3 $2
  StrCpy $2 ""
  Goto creator_preflight_retry
creator_preflight_ready:
  StrCpy $CreatorPreflightPassed 1
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro CreatorDefinePreflight ""
!insertmacro CreatorDefinePreflight "un."

!macro NSIS_HOOK_PREINSTALL
  Call CreatorMcpPreflight
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  Call un.CreatorMcpPreflight
!macroend

; These template calls immediately follow our preinstall/preuninstall hooks.
; Consume the successful guard instead of Tauri's default silent GUI force-kill.
; A legacy uninstaller already on disk remains outside this replacement.
!ifmacrondef CheckIfAppIsRunning
  !error "Expected Tauri running-app macro missing; review installer template"
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  ${If} $CreatorPreflightPassed != 1
    SetErrorLevel 11
    Abort "MCP preflight did not complete. No application will be force-closed."
  ${EndIf}
  StrCpy $CreatorPreflightPassed 0
!macroend
