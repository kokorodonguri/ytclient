# Custom NSIS pieces for the Windows installer.
#
# Background: installing over an existing install used to fail every time with
# "Failed to uninstall old application files ... : 2", so the only way to
# install a new build was to uninstall the old one by hand first. Two separate
# defects in the stock electron-builder behaviour produced that, and each is
# addressed by one of the macros below.

# --- 1. Actually close the running app -------------------------------------
#
# The stock CHECK_APP_RUNNING decides whether the app is running by piping
# `tasklist` into `find` through cmd.exe and then kills it with a taskkill
# narrowed by /fi "PID ne <installer>" and /fi "USERNAME eq %USERNAME%". When
# that detection wrongly reports "not running", the entire kill block is
# skipped, every app process stays alive, and the old uninstaller then cannot
# move the locked executable out of the way.
#
# So do not ask a process listing anything. The only question that matters is
# whether the installed executable can be overwritten, so ask the filesystem:
# try to open it for writing. Windows refuses that for as long as any process
# still has the image mapped, which covers the main process and every Electron
# child process at once.
#
# CHECK_APP_RUNNING prefers customCheckAppRunning when it is defined, so this
# replaces the default in both the installer and the uninstaller.
#
# ASCII only on purpose: makensis is fussy about the encoding of included
# scripts, and a mangled comment here would break the build.

!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2

  StrCpy $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  # Nothing installed yet means nothing can be holding a lock.
  ${If} ${FileExists} "$R2"
    StrCpy $R1 0

    ${Do}
      # Opening for append needs write access but does not modify the file.
      ClearErrors
      FileOpen $R0 "$R2" a
      ${IfNot} ${Errors}
        FileClose $R0
        ${ExitDo}
      ${EndIf}

      IntOp $R1 $R1 + 1
      ${If} $R1 = 1
        DetailPrint `Closing running "${PRODUCT_NAME}"...`
      ${EndIf}

      ${If} $R1 > 8
        # Electron's helper processes never answer WM_CLOSE, so after the main
        # window has had its few seconds the tree has to come down by force.
        nsExec::Exec `"$SYSDIR\taskkill.exe" /f /t /im "${APP_EXECUTABLE_FILENAME}"`
      ${Else}
        # Deliberately no /t: with it taskkill just returns 128 and closes
        # nothing, which is what burns the whole grace period for no gain.
        nsExec::Exec `"$SYSDIR\taskkill.exe" /im "${APP_EXECUTABLE_FILENAME}"`
      ${EndIf}
      Pop $R0

      # Give up after ~30s and let the user close it by hand rather than spin
      # forever. /SD IDCANCEL keeps silent installs from hanging on a dialog.
      ${If} $R1 > 60
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
        Quit
        StrCpy $R1 0
      ${EndIf}

      Sleep 500
    ${Loop}
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

# --- 2. Never let a failed rename block the install ------------------------
#
# Before uninstalling, the stock uninstaller renames every installed file into
# $PLUGINSDIR\old-install so it can roll back if extraction fails. That target
# sits deeper than the install directory, so any path already close to
# MAX_PATH (260) goes over it and the rename fails. The stock code treats that
# as fatal: it restores the files and aborts with exit code 2, which is what
# the installer reports as "Failed to uninstall old application files ... : 2".
#
# An install that has such paths can therefore never be upgraded, only
# uninstalled by hand -- and the by-hand uninstall works purely because it
# skips this rename path entirely (no --updated flag) and goes straight to
# RMDir /r.
#
# The rename is only a rollback convenience, so degrade to deleting in place
# instead of refusing to install. Everything below matches the stock behaviour
# apart from that.

!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "Cannot move $R0 aside; deleting in place without rollback."
      Push ""
      Call un.restoreFiles
      Pop $R0
    ${endif}
  ${endif}

  RMDir /r $INSTDIR
!macroend
