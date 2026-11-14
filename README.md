# World Radio — Linux

A desktop app for World Radio: **7,600+ live radio stations**, **1,800+ HF SDR
receivers**, satellites, aviation, news, weather and scanner feeds on one map —
the same app that ships for Android and Windows, as a proper Linux window.

![icon](worldradio.svg)

## Install (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/EliRF2022/WorldRadio-Linux/main/install.sh | bash
```

That installs the one runtime dependency it needs (a WebKitGTK typelib), downloads
the app into `/opt/worldradio`, and adds **World Radio** to your applications menu.
The repository is public, so the line above needs no account and no token.

**Then:** open your applications menu, search for **World Radio**, and click it.
From a terminal it is simply `worldradio`.

Works on Ubuntu, Debian, Linux Mint, Fedora, RHEL, Rocky, Arch, Manjaro, openSUSE
and Alpine — the installer detects the package manager and picks the right
WebKitGTK flavour for the distro.

## Remove

```sh
curl -fsSL https://raw.githubusercontent.com/EliRF2022/WorldRadio-Linux/main/uninstall.sh | bash
```

Removes the app, launcher, icon and menu entry. Leaves the WebKitGTK packages
installed, since other apps may use them.

## Options

```sh
worldradio                  # normal launch
worldradio --browser        # open in Firefox instead of its own window
worldradio --no-open        # serve only, print the address
worldradio --size 1400x900  # bigger window
worldradio --port 9000      # different port (default 8770, first free above it)
```

## How it works

`worldradio_host.py` serves the web app from `http://127.0.0.1:<port>` and stands
in for the Kotlin/WebView2 bridge the Android and Windows builds use. It has to be
a local server because the page's JavaScript cannot read the radio/news/aviation
feeds cross-origin by itself, and WebGL refuses cross-origin textures.

`worldradio_linux.py` adds the window: a native **WebKitGTK** view, chosen
automatically between

| flavour | packages | distros |
|---|---|---|
| WebKit 6.0 + GTK4 | `gir1.2-webkit-6.0 gir1.2-gtk-4.0` | Ubuntu 24.04+, Debian 13+, Fedora 40+ |
| WebKit2 4.1 + GTK3 | `gir1.2-webkit2-4.1 gir1.2-gtk-3.0` | older Debian/Ubuntu, RHEL 8-era |

If neither is present the app still runs — it just opens in the default browser
and says so. Nothing is vendored and there are no Python dependencies at all: the
whole host is standard library.

## Files

| path | what |
|---|---|
| `www/` | the web app — identical to the Android and Windows builds |
| `worldradio_linux.py` | window + launch logic |
| `worldradio_host.py` | local server and `/api/*` endpoints |
| `install.sh` / `uninstall.sh` | one-command install / remove |
| `worldradio.svg` | app icon |

## Notes

- Closing the window quits the app (it does not leave a server running in the
  background).
- Receiver pages open inside the same window, the way the Android build does.
- The app needs no account, no key and no configuration.

## Creator

**Eric (KA3KDL)** — ham radio operator

- GitHub: [EliRF2022](https://github.com/EliRF2022)
- Callsign: KA3KDL
