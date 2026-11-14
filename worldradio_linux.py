#!/usr/bin/env python3
"""
World Radio - Linux desktop edition.

The page itself is the same one the Android and Windows builds ship. The host
(worldradio_host.py, sitting next to this file) serves it from http://127.0.0.1
and stands in for the Kotlin/WebView2 bridge the other builds use, because the
page's JavaScript cannot read those feeds cross-origin by itself.

The only thing this file adds is the window: a real WebKitGTK window, so World
Radio is an app you click in the menu rather than a browser tab. Firefox is only
used if no usable WebKitGTK is installed.

    worldradio-linux                  # normal launch
    worldradio-linux --browser        # Firefox instead of a WebKit window
    worldradio-linux --no-open        # serve only, print the address
    worldradio-linux --size 1400x900
    worldradio-linux --port 9000
"""

import argparse
import glob
import importlib.util
import os
import sys
import threading
import webbrowser
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "World Radio"


# ------------------------------------------------------------------- the host

def load_host():
    """Import worldradio_host.py next to this script."""
    path = os.path.join(HERE, "worldradio_host.py")
    if not os.path.isfile(path):
        sys.exit("worldradio_host.py is missing next to this script\n"
                 "  (expected %s)" % path)
    spec = importlib.util.spec_from_file_location("worldradio_host", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------------ the window

def _typelib(name):
    """True when <name>.typelib is present.

    Checked on disk rather than with gi.require_version() on purpose: gi PINS a
    namespace the moment require_version() succeeds, so a failed probe for
    Gtk 4.0 would make a later Gtk 3.0 attempt impossible to satisfy.
    """
    wanted = "%s.typelib" % name
    dirs = ["/usr/lib/girepository-1.0", "/usr/lib64/girepository-1.0"]
    dirs += glob.glob("/usr/lib/*/girepository-1.0")
    dirs += glob.glob("/usr/local/lib/*/girepository-1.0")
    for d in dirs:
        if os.path.isfile(os.path.join(d, wanted)):
            return True
    return False


def pick_flavour():
    """Which WebKitGTK is installed here.

    Two flavours exist and either may be the one present:
      gtk4 - WebKit 6.0  + GTK4   (Ubuntu 24.04+, Debian 13+, Fedora 40+)
      gtk3 - WebKit2 4.1 + GTK3   (older distros)
    """
    if _typelib("WebKit-6.0") and _typelib("Gtk-4.0"):
        return "gtk4"
    if _typelib("WebKit2-4.1") and _typelib("Gtk-3.0"):
        return "gtk3"
    return None


def hook_new_windows(view):
    """The page opens receivers (and article links) with window.open().

    WebKit does not act on that by itself - without this the click looks dead,
    which is exactly the bug class we are trying to avoid. Load the request in
    the same view, the same way the Android build does.
    """
    def on_create(v, action):
        try:
            v.load_uri(action.get_request().get_uri())
        except Exception as e:
            print("  ! could not open link: %s" % e)
        return None            # we handled it; do not create another view

    try:
        view.connect("create", on_create)
    except Exception as e:
        print("  ! could not hook window.open: %s" % e)


def run_window(url, size, flavour):
    """Blocking: runs the GTK main loop until the window is closed."""
    import gi
    w, h = size

    if flavour == "gtk4":
        gi.require_version("Gtk", "4.0")
        gi.require_version("WebKit", "6.0")
        from gi.repository import Gtk, WebKit

        app = Gtk.Application(application_id="com.worldradio.linux")

        def on_activate(a):
            view = WebKit.WebView()
            hook_new_windows(view)
            view.load_uri(url)
            win = Gtk.ApplicationWindow(application=a)
            win.set_title(APP_NAME)
            win.set_default_size(w, h)
            win.set_child(view)
            win.present()

        app.connect("activate", on_activate)
        app.run(None)
        return

    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gtk, WebKit2

    view = WebKit2.WebView()
    hook_new_windows(view)
    view.load_uri(url)

    win = Gtk.Window()
    win.set_title(APP_NAME)
    win.set_default_size(w, h)
    win.add(view)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    Gtk.main()


# ---------------------------------------------------------------------- main

def wait_forever():
    """Park until Ctrl-C - used when the page lives in a browser, not our window."""
    try:
        while True:
            threading.Event().wait(3600)
    except KeyboardInterrupt:
        print("\n  stopped")


def main():
    ap = argparse.ArgumentParser(description="%s - Linux desktop edition" % APP_NAME)
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--size", default="1100x840", help="window WxH")
    ap.add_argument("--browser", action="store_true",
                    help="open Firefox instead of a WebKit window")
    ap.add_argument("--no-open", action="store_true", help="serve only")
    args = ap.parse_args()

    host = load_host()

    if not os.path.isdir(host.WWW):
        sys.exit("web assets not found:\n  %s" % host.WWW)

    try:
        w, h = (int(v) for v in args.size.lower().split("x"))
    except Exception:
        w, h = 1100, 840

    port = host.free_port(args.port)
    srv = ThreadingHTTPServer(("127.0.0.1", port), host.Handler)
    url = "http://127.0.0.1:%d/" % port

    print()
    print("  %s - Linux desktop edition" % APP_NAME)
    print("  " + "-" * 46)
    print("  serving  %s" % host.WWW)
    print("  address  %s" % url)

    def serve():
        try:
            srv.serve_forever()
        except Exception:
            pass

    if args.no_open:
        print("  Ctrl-C to stop")
        print()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped")
        finally:
            srv.server_close()
        return

    # The window must own the main thread, so the server goes to a daemon one.
    threading.Thread(target=serve, daemon=True).start()

    if args.browser:
        webbrowser.open(url)
        print("  opened   default browser")
        print("  Ctrl-C to stop")
        print()
        try:
            while True:
                threading.Event().wait(3600)
        except KeyboardInterrupt:
            print("\n  stopped")
        srv.server_close()
        return

    flavour = pick_flavour()
    if flavour is None:
        print("  ! no WebKitGTK found (looked for WebKit-6.0/Gtk-4.0 and")
        print("    WebKit2-4.1/Gtk-3.0 typelibs) - falling back to the browser.")
        print("    Re-run the installer to add it, or use --browser to silence this.")
        webbrowser.open(url)
        print("  Ctrl-C to stop")
        print()
        wait_forever()
    else:
        print("  window   WebKitGTK (%s)" % flavour)
        print()
        try:
            run_window(url, (w, h), flavour)
            # run_window only returns when the window was closed, and closing
            # the app has to quit it - not leave a headless server running.
            print("  window closed - stopped")
        except Exception as e:
            print("  ! could not open the WebKit window: %s: %s" % (type(e).__name__, e))
            print("    falling back to the browser")
            webbrowser.open(url)
            print("  Ctrl-C to stop")
            print()
            wait_forever()

    srv.server_close()


if __name__ == "__main__":
    main()
