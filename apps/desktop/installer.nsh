; The Windows installer's additions (package.json `build.nsis.include`).
;
; Registers the `openindustry://` link scheme (deepLink.cjs): what the browser's Help > Open in Desktop App fires.
; electron-builder's `protocols` setting covers macOS, AppX and the Linux packages but NOT NSIS (checked against
; app-builder-lib 26: no NSIS template reads it), so the keys are written here. SHELL_CONTEXT is the per-user hive
; for this per-user installer, the same place the app's own uninstall entry goes.
;
; An update runs the old version's uninstaller first, then installs; the guard keeps the link working throughout
; rather than removing and re-adding it.

!define OIP_LINK_KEY "Software\Classes\openindustry"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${OIP_LINK_KEY}" "" "URL:Open Industry Project link"
  WriteRegStr SHELL_CONTEXT "${OIP_LINK_KEY}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "${OIP_LINK_KEY}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${OIP_LINK_KEY}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey SHELL_CONTEXT "${OIP_LINK_KEY}"
  ${endIf}
!macroend
