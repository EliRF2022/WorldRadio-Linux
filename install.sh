#!/usr/bin/env bash
#
# World Radio - Linux installer.
#
# One command:
#
#   curl -fsSL https://raw.githubusercontent.com/EliRF2022/WorldRadio-Linux/main/install.sh | bash
#
# What it does:
#   1. installs the one runtime dependency the app needs (a WebKitGTK typelib)
#   2. downloads the app from GitHub into /opt/worldradio
#   3. drops a launcher in /usr/bin and an entry in the applications menu
#
# Re-running it upgrades the app in place. Remove it with uninstall.sh.
#
set -eu

REPO="${WORLDRADIO_REPO:-EliRF2022/WorldRadio-Linux}"
BRANCH="${WORLDRADIO_BRANCH:-main}"
PREFIX="/opt/worldradio"
LAUNCHER="/usr/bin/worldradio"
DESKTOP="/usr/share/applications/worldradio.desktop"
ICON="/usr/share/icons/hicolor/scalable/apps/worldradio.svg"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '\n  ! %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ be root

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "need root (or sudo) to install"
    SUDO="sudo"
fi

# NOTE: do NOT try to help sudo here with `exec </dev/tty`. Under the documented
# `curl ... | bash` this script IS bash's stdin, so redirecting stdin makes bash
# read the rest of the SCRIPT from the terminal instead - it stops executing and
# hangs forever with no output. sudo opens the terminal for its password by
# itself, so nothing is needed.

step "World Radio for Linux"

# ------------------------------------------------------------------ packages

pkg_install() {                       # pkg_install <pkg> [pkg...]
    say "installing: $*"
    if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get install -y "$@"
    elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y "$@"
    elif command -v yum     >/dev/null 2>&1; then $SUDO yum install -y "$@"
    elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -S --noconfirm "$@"
    elif command -v zypper  >/dev/null 2>&1; then $SUDO zypper --non-interactive install "$@"
    elif command -v apk     >/dev/null 2>&1; then $SUDO apk add "$@"
    else die "no supported package manager found"
    fi
}

refresh_index() {
    if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq || true
    elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm || true
    fi
}

# The manager decides the package NAMES, and each distro names the two WebKitGTK
# flavours differently. Try the modern one (WebKit 6.0 + GTK4) first, then the
# older one (WebKit2 4.1 + GTK3); whichever installs is what the app will use.
webkit_flavour_installed() {
    for d in /usr/lib/girepository-1.0 /usr/lib64/girepository-1.0 /usr/lib/*/girepository-1.0; do
        if [ -f "$d/WebKit-6.0.typelib" ] && [ -f "$d/Gtk-4.0.typelib" ]; then echo gtk4; return 0; fi
        if [ -f "$d/WebKit2-4.1.typelib" ] && [ -f "$d/Gtk-3.0.typelib" ]; then echo gtk3; return 0; fi
    done
    return 1
}

install_webkit() {
    if f=$(webkit_flavour_installed); then
        say "WebKitGTK already present ($f)"
        return 0
    fi

    local sets=()
    if   command -v apt-get >/dev/null 2>&1; then
        sets=("gir1.2-webkit-6.0 gir1.2-gtk-4.0 python3-gi" \
              "gir1.2-webkit2-4.1 gir1.2-gtk-3.0 python3-gi")
    elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
        sets=("webkitgtk6.0 gtk4 python3-gobject" \
              "webkit2gtk4.1 gtk3 python3-gobject")
    elif command -v pacman >/dev/null 2>&1; then
        sets=("webkitgtk-6.0 gtk4 python-gobject" \
              "webkit2gtk-4.1 gtk3 python-gobject")
    elif command -v zypper >/dev/null 2>&1; then
        sets=("typelib-1_0-WebKit-6_0 typelib-1_0-Gtk-4_0 python3-gobject" \
              "typelib-1_0-WebKit2-4_1 typelib-1_0-Gtk-3_0 python3-gobject")
    elif command -v apk >/dev/null 2>&1; then
        sets=("py3-gobject3 webkit2gtk-4.1" \
              "py3-gobject3 webkit2gtk")
    fi

    [ ${#sets[@]} -gt 0 ] || die "cannot work out the package names for this distro"

    for s in "${sets[@]}"; do
        # shellcheck disable=SC2086
        if pkg_install $s; then
            if f=$(webkit_flavour_installed); then
                say "WebKitGTK ready ($f)"
                return 0
            fi
        fi
        say "that set did not provide WebKitGTK, trying the other flavour"
    done

    say "could not install WebKitGTK automatically."
    say "The app still runs - it will just open in Firefox instead of its own window."
    return 0
}

step "runtime dependency (WebKitGTK)"
refresh_index
install_webkit

# ------------------------------------------------------------------ download

step "downloading the app"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {                              # fetch <url> > file
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        curl -fsSL -H "Authorization: token ${GITHUB_TOKEN}" "$1"
    else
        curl -fsSL "$1"
    fi
}

got=""

# Running the installer out of a checkout? That copy is authoritative, and this
# has to be decided FIRST: checking afterwards meant a checkout without network
# access (or a private repo with no credentials) failed on the download before
# ever looking at the files sitting right there.
if [ -f "./worldradio_linux.py" ] && [ -d "./www" ]; then
    say "using the local copy in $(pwd)"
    got="$(pwd)"
elif command -v curl >/dev/null 2>&1; then
    # codeload is the canonical archive host. The friendlier-looking
    # github.com/<repo>/archive/... URL is NOT dependable: when GitHub applies a
    # rate limit or bot check it answers HTTP 200 with an HTML page, not a
    # redirect. Saved as .tar.gz that is a file which cannot be untarred. So
    # codeload goes first, and EVERY download is checked as a real archive
    # before it is trusted.
    for url in \
        "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
        "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    do
        say "downloading from $(printf '%s' "$url" | cut -d/ -f3)"
        if fetch "$url" > "$tmp/app.tar.gz" 2>/dev/null \
           && tar -tzf "$tmp/app.tar.gz" >/dev/null 2>&1 \
           && tar -xzf "$tmp/app.tar.gz" -C "$tmp" 2>/dev/null; then
            cand="$(find "$tmp" -maxdepth 1 -type d -name 'WorldRadio-Linux*' | head -1)"
            if [ -n "$cand" ] && [ -f "$cand/worldradio_linux.py" ] && [ -d "$cand/www" ]; then
                got="$cand"
                break
            fi
        fi
        say "  that source did not return a usable archive - trying the next one"
    done

    # A private repo answers 404 to an anonymous curl. The token may be missing,
    # or git may already hold credentials from a previous clone.
    if [ -z "$got" ] && command -v git >/dev/null 2>&1; then
        say "archive download failed - trying git (uses your saved credentials)"
        if git clone --depth 1 --branch "$BRANCH" \
               "https://github.com/$REPO.git" "$tmp/src" >/dev/null 2>&1; then
            got="$tmp/src"
        fi
    fi
fi

[ -n "$got" ] || die "could not download the app.
  If the repository is private, either set a token first:
      GITHUB_TOKEN=ghp_xxx  curl -fsSL .../install.sh | bash
  or clone the repo yourself and run ./install.sh from inside it."

[ -f "$got/worldradio_linux.py" ] || die "the download did not contain worldradio_linux.py"
[ -d "$got/www" ]                 || die "the download did not contain the www folder"

# ------------------------------------------------------------------ install

# Resolve the interpreter once: a desktop launcher inherits a minimal PATH, and
# -u (below) keeps the banner visible when the app is run from a terminal.
PYBIN="$(command -v python3 || echo /usr/bin/python3)"

step "installing to $PREFIX"
$SUDO rm -rf "$PREFIX"
$SUDO mkdir -p "$PREFIX"
$SUDO cp -r "$got/www" "$PREFIX/www"
$SUDO cp "$got/worldradio_linux.py" "$PREFIX/worldradio_linux.py"

# The host file may sit next to the launcher or, in a source checkout, in
# fallback-python/ under the old name.
host_src=""
for cand in "$got/worldradio_host.py" "$got/fallback-python/worldradio_pc.py"; do
    if [ -f "$cand" ]; then host_src="$cand"; break; fi
done
[ -n "$host_src" ] || die "worldradio_host.py is missing from the download"
$SUDO cp "$host_src" "$PREFIX/worldradio_host.py"

# Ship the icon and a wrapper with an absolute interpreter path: a desktop
# launcher does not go through PATH the way a shell does.
if [ -f "$got/worldradio.svg" ]; then
    $SUDO mkdir -p "$(dirname "$ICON")"
    $SUDO cp "$got/worldradio.svg" "$ICON"
fi

$SUDO tee "$LAUNCHER" >/dev/null <<EOF
#!/bin/sh
exec "$PYBIN" -u "$PREFIX/worldradio_linux.py" "\$@"
EOF
$SUDO chmod 755 "$LAUNCHER"

$SUDO tee "$DESKTOP" >/dev/null <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=World Radio
Comment=Radio stations, HF SDR receivers, satellites and aviation - worldwide
Exec=$LAUNCHER
Icon=worldradio
Terminal=false
Categories=AudioVideo;Network;HamRadio;
Keywords=radio;sdr;shortwave;ham;scanner;aviation;world;
StartupNotify=true
EOF
$SUDO chmod 644 "$DESKTOP"

# refresh the menu / icon caches when the tooling is there (best effort)
command -v update-desktop-database >/dev/null 2>&1 && \
    $SUDO update-desktop-database -q /usr/share/applications 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    $SUDO gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true

# ------------------------------------------------------------------ verify

step "checking the install"
problems=0
[ -x "$LAUNCHER" ] || { say "! launcher missing"; problems=1; }
[ -f "$PREFIX/www/index.html" ] || { say "! web assets missing"; problems=1; }
[ -f "$PREFIX/worldradio_host.py" ] || { say "! host script missing"; problems=1; }
python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)" \
    || { say "! python3 is too old (need 3.8+)"; problems=1; }

if [ "$problems" -eq 0 ]; then
    say "launcher   $LAUNCHER"
    say "files      $PREFIX"
    if f=$(webkit_flavour_installed); then
        say "window     WebKitGTK ($f) - real app window"
    else
        say "window     none - the app will open in Firefox"
    fi
fi

printf '\n\033[1mDone.\033[0m\n\n'
say "Start it from your applications menu (search for \"World Radio\"),"
say "or from a terminal:   worldradio"
printf '\n'

[ "$problems" -eq 0 ] || die "the install finished with problems (see above)"
exit 0
