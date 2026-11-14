#!/usr/bin/env bash
#
# World Radio - Linux uninstaller.
#
#   curl -fsSL https://raw.githubusercontent.com/EliRF2022/WorldRadio-Linux/main/uninstall.sh | bash
#
# Removes the app, its launcher, icon and menu entry. The WebKitGTK packages are
# left alone on purpose - other apps on the machine may well be using them.
#
set -eu

PREFIX="/opt/worldradio"
LAUNCHER="/usr/bin/worldradio"
DESKTOP="/usr/share/applications/worldradio.desktop"
ICON="/usr/share/icons/hicolor/scalable/apps/worldradio.svg"

say() { printf '  %s\n' "$*"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo "need root (or sudo)" >&2; exit 1; }
    SUDO="sudo"
fi

# No `exec </dev/tty` here on purpose: under `curl ... | bash` this file is bash's
# stdin, so redirecting stdin makes bash read the rest of the script from the
# terminal and hang. sudo opens the terminal for its password on its own.

printf '\n== Removing World Radio\n\n'

# Plain ifs rather than `[ ... ] && { ... }`, which under `set -e` aborts the
# whole script the first time something is already gone.
if [ -e "$PREFIX" ];   then $SUDO rm -rf "$PREFIX";   say "removed $PREFIX"; fi
if [ -e "$LAUNCHER" ]; then $SUDO rm -f  "$LAUNCHER"; say "removed $LAUNCHER"; fi
if [ -e "$DESKTOP" ];  then $SUDO rm -f  "$DESKTOP";  say "removed the menu entry"; fi
if [ -e "$ICON" ];     then $SUDO rm -f  "$ICON";     say "removed the icon"; fi

if command -v update-desktop-database >/dev/null 2>&1; then
    $SUDO update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    $SUDO gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi

printf '\n  Done. The WebKitGTK packages were left installed (other apps may use them).\n\n'
