; No real installation/uninstallation, registry writes, shortcuts or application launch.
; Only a marker in the caller-owned fixture directory is written if preflight passes.
Unicode true
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!macro CheckIfAppIsRunning executableName productName
  !error "The production preflight must replace this macro"
!macroend
!include "${HOOK_PATH}"
Name "Creator MCP hook test fixture"
OutFile "${TEST_OUTPUT}"
InstallDir "${FIXTURE_ROOT}"
SilentInstall silent
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section
  ; Exercise the exact native transport separately so a busy registered old
  ; installation cannot conceal an incorrectly passed fixture path.
  InitPluginsDir
  File /oname=$PLUGINSDIR\creator-mcp-preflight.ps1 "${CREATOR_PREFLIGHT_SCRIPT}"
  StrCpy $3 $INSTDIR
  nsExec::ExecToStack /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\creator-mcp-preflight.ps1" -InstallDir "$3\."`
  Pop $0
  Pop $1
  ${If} $0 != 10
    SetErrorLevel 90
    Quit
  ${EndIf}
  StrLen $2 "An MCP file is locked"
  StrCpy $1 $1 $2
  ${If} $1 != "An MCP file is locked"
    SetErrorLevel 91
    Quit
  ${EndIf}
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "creator-works-mcp-launcher" "Creator Works MCP"
  FileOpen $0 "$INSTDIR\preflight-passed.txt" w
  FileWrite $0 "fixture only"
  FileClose $0
SectionEnd
