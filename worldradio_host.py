#!/usr/bin/env python3
"""
World Radio - desktop edition.

Serves the Android app's `assets/www` folder over http://127.0.0.1 and stands in
for the Kotlin bridge the APK uses. Everything here is Python stdlib - no pip
install, no API keys.

Why a server at all? The app's JS cannot fetch the news feeds itself: a browser
refuses cross-origin reads, and WebGL refuses cross-origin textures. Running the
page from http://127.0.0.1 makes it same-origin with these /api/* endpoints, so
the page's desktop bridge shim can pull everything through us.

    python worldradio_pc.py                 # 127.0.0.1:8770, opens a window
    python worldradio_pc.py --port 9000     # different port
    python worldradio_pc.py --browser       # normal browser tab instead
    python worldradio_pc.py --size 1400x900 # bigger window
"""

import argparse
import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# A self-contained bundle keeps the web assets in ./www next to this script;
# inside the Android project they live under app/src/main/assets/www; and the
# shipped fallback-python/ folder sits beside the bundle's own www.
_CANDIDATES = [
    os.path.join(HERE, "www"),
    os.path.join(ROOT, "www"),
    os.path.join(ROOT, "app", "src", "main", "assets", "www"),
]
WWW = next((p for p in _CANDIDATES if os.path.isdir(p)), _CANDIDATES[0])

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorldRadioPC/1.0"

MIRRORS = [
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
]

# An AM outlet almost always shows its frequency and band in its name.
AM_NAME = re.compile(r"(\b\d{3,4}\s*am\b|\bam\s*\d{3,4}\b|\(am\)|\bam\s*[-–]\s*\d)", re.I)
FM_HINT = re.compile(r"\bfm\b|\d\s*fm\b|\b\d{3}\.\d|\b\d{4}\.\d", re.I)


def is_am(name):
    """True for AM-band outlets. Radio Browser has no band field, so the name
    is the only signal; FM names are excluded first so "Radio Disney 94.3" and
    "LOVE FM" are never mistaken for AM just because they carry the 'am' tag."""
    n = name or ""
    if FM_HINT.search(n):
        return False
    return bool(AM_NAME.search(n))


# Same list the Android build uses. ARRL is a plain RSS feed; fcc.gov returns
# 403 to non-browser clients, so FCC news and the Enforcement Bureau's letters
# come through Google News' source filter instead.
FEEDS = [
    ("Fox News", "https://feeds.foxnews.com/foxnews/latest"),
    ("Fox Business", "https://feeds.foxbusiness.com/foxbusiness/latest.xml"),
    ("Breitbart", "https://www.breitbart.com/feed/"),
    ("The Blaze", "https://theblaze.com/feed/"),
    ("ZeroHedge", "https://feeds.feedburner.com/zerohedge/feed"),
    ("Washington Times", "https://www.washingtontimes.com/rss/headlines/news/"),
    ("OANN", "https://www.oann.com/feed/"),
    ("AP News", "https://feedx.net/rss/ap.xml"),
    ("ARRL", "https://www.arrl.org/news/rss"),
    ("FCC", "https://news.google.com/rss/search?q=source%3Afcc.gov"
            "&hl=en-US&gl=US&ceid=US%3Aen"),
    ("FCC Enforcement", "https://news.google.com/rss/search?q=FCC+enforcement+letter"
                        "&hl=en-US&gl=US&ceid=US%3Aen"),
]

TLE_URL = ("https://celestrak.org/NORAD/elements/gp.php"
           "?GROUP=amateur&GROUP=weather&FORMAT=tle")

CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


# --------------------------------------------------------------------- http

def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/xml, text/xml, "
                  "application/json, image/*, */*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def http_text(url, timeout=20):
    return http_get(url, timeout).decode("utf-8", "replace")


# --------------------------------------------------------------------- feeds

def _local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def _epoch(raw):
    """RFC-822 (RSS) or ISO-8601 (Atom) -> epoch millis, 0 when unparseable."""
    if not raw:
        return 0
    try:
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
    except Exception:
        pass
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def parse_feed(xml, source):
    """RSS 2.0 or Atom -> [{s,t,u,d}]. Handles Atom's <link href=...>."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        try:
            root = ET.fromstring(CTRL.sub("", xml))
        except Exception:
            return []

    out = []
    for node in root.iter():
        if _local(node.tag) not in ("item", "entry"):
            continue
        title = link = date = None
        for ch in node:
            n = _local(ch.tag)
            if n == "title" and title is None:
                title = (ch.text or "").strip()
            elif n == "link" and link is None:
                link = (ch.get("href") or ch.text or "").strip()
            elif n in ("pubdate", "published", "updated", "date") and date is None:
                date = (ch.text or "").strip()
        if title and link:
            out.append({"s": source, "t": title, "u": link, "d": _epoch(date)})
    return out


def fetch_feed(pair):
    source, url = pair
    try:
        return parse_feed(http_text(url), source)
    except Exception as e:
        log("feed %-16s %s" % (source, e))
        return []


def api_news():
    rows = []
    with ThreadPoolExecutor(max_workers=len(FEEDS)) as ex:
        for part in ex.map(fetch_feed, FEEDS):
            rows.extend(part)
    rows.sort(key=lambda r: -(r.get("d") or 0))
    log("news: %d items from %d feeds" % (len(rows), len(FEEDS)))
    return json.dumps(rows, ensure_ascii=True)


# ------------------------------------------------------------------- tiles

_tile_cache = {}
_tile_lock = threading.Lock()


def api_tile(url):
    """Fetch a map tile and hand it back as a data: URL (WebGL needs that)."""
    if not url.startswith(("http://", "https://")):
        raise ValueError("bad tile url")
    with _tile_lock:
        hit = _tile_cache.get(url)
    if hit:
        return hit
    data = http_get(url, timeout=15)
    if data[:3] == b"\xff\xd8\xff":
        ctype = "image/jpeg"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        ctype = "image/png"
    else:
        ctype = "image/jpeg"
    out = "data:%s;base64,%s" % (ctype, base64.b64encode(data).decode("ascii"))
    with _tile_lock:
        if len(_tile_cache) > 600:
            _tile_cache.clear()
        _tile_cache[url] = out
    return out


# ------------------------------------------------------------------ simple

_PSK_CACHE = {"key": "", "at": 0.0, "body": ""}


def api_aircraft(lat, lon, radius):
    """Live aircraft from adsb.lol. Keyless, but sends no CORS headers, so the
    page cannot call it - it comes through here. Empty list on any failure."""
    import urllib.request
    try:
        req = urllib.request.Request(
            "https://api.adsb.lol/v2/point/%s/%s/%d" % (lat, lon, radius),
            headers={"User-Agent": "WorldRadio/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        # adsb.lol allows 500 requests/day and answers 429 when spent. OpenSky
        # is free and keyless, so fall back to it rather than showing an empty sky.
        return _opensky_aircraft(lat, lon, radius)


def _opensky_aircraft(lat, lon, radius):
    """OpenSky fallback, converted to the same {"ac":[...]} shape as adsb.lol.

    OpenSky reports altitude in metres and speed in m/s, and carries no aircraft
    type - so heights are converted to feet, speeds to knots, and the type is
    left out (the page falls back to a generic icon).
    """
    import math
    import urllib.request
    try:
        la = float(lat)
        lo = float(lon)
        dlat = radius / 60.0
        dlon = radius / (60.0 * math.cos(math.radians(la)))
        url = ("https://opensky-network.org/api/states/all"
               "?lamin=%s&lomin=%s&lamax=%s&lomax=%s"
               % (la - dlat, lo - dlon, la + dlat, lo + dlon))
        req = urllib.request.Request(url, headers={"User-Agent": "WorldRadio/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
        ac = []
        for st in (d.get("states") or []):
            if not st or len(st) < 11:
                continue
            ac.append({
                "hex": st[0],
                "flight": (st[1] or "").strip(),
                "lon": st[5],
                "lat": st[6],
                "alt_baro": "ground" if st[8] else round((st[7] or 0) * 3.28084),
                "gs": round((st[9] or 0) * 1.94384),
                "track": round(st[10] or 0),
            })
        return json.dumps({"ac": ac})
    except Exception:
        return '{"ac":[]}'


def api_pskspots(freq, minutes=15):
    """PSK Reporter reception reports for the app's FT8 view.

    Cached for 60 s: the service allows roughly one request a minute per IP, so
    a second caller (or a spammed refresh button) gets the previous answer
    rather than an HTTP 503. Failures come back as '!<reason>' so the page can
    show what actually went wrong.
    """
    import time
    minutes = max(1, min(60, int(minutes)))
    key = "%s|%d" % (freq, minutes)
    now = time.time()
    if _PSK_CACHE["key"] == key and (now - _PSK_CACHE["at"]) < 60:
        return _PSK_CACHE["body"]
    url = ("https://retrieve.pskreporter.info/query?rronly=1"
           "&flowStartSeconds=-%d&frange=%s&rptlimit=400&mode=FT8"
           % (minutes * 60, urllib.parse.quote(freq, safe="")))
    try:
        body = http_text(url, timeout=30)
    except Exception as e:
        body = "!PSK Reporter: %s" % e
    _PSK_CACHE.update({"key": key, "at": now, "body": body})
    return body


def api_stations(limit=6000):
    """The broad list plus an AM pass, merged and de-duplicated.

    Returns JSON text, same shape as api_news(): a list of station objects.
    """
    seen, out = set(), []

    def absorb(rows):
        for s in rows or []:
            sid = s.get("stationuuid")
            if not sid or sid in seen:
                continue
            seen.add(sid)
            s["am"] = is_am((s.get("name") or "").strip())
            out.append(s)

    absorb(json.loads(_rb("/json/stations/search?limit=%d&has_geo_info=true"
                          "&hidebroken=true&order=votes&reverse=true" % limit)))
    absorb(json.loads(_rb("/json/stations/search?tag=am&limit=2500&has_geo_info=true"
                          "&hidebroken=true")))
    return json.dumps(out)


def _rb(path):
    for host in MIRRORS:
        try:
            return http_text("%s%s" % (host, path), 40)
        except Exception as e:
            log("mirror %s failed: %s" % (host, e))
    return None


def api_temps():
    """A coarse world temperature grid, from one Open-Meteo request."""
    lats = [str(la) for la in range(-77, 78, 14) for _ in range(24)]
    lons = [str(lo) for _ in range(12) for lo in range(-168, 180, 15)]
    raw = http_text(
        "https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
        "&current=temperature_2m,wind_speed_10m,wind_direction_10m"
        % (",".join(lats), ",".join(lons)), 40)
    pts = []
    for o in json.loads(raw or "[]"):
        cur = o.get("current") or {}
        t = cur.get("temperature_2m")
        if t is None:
            continue
        p = {"lat": o.get("latitude"), "lon": o.get("longitude"), "t": t}
        # wind drives the streamline layer; same request, so no extra API call
        if cur.get("wind_speed_10m") is not None:
            p["ws"] = cur["wind_speed_10m"]
            p["wd"] = cur.get("wind_direction_10m")
        pts.append(p)
    return json.dumps(pts)


def _read_asset(name):
    with open(os.path.join(WWW, name), "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def api_weather(q):
    lat = float(q["lat"][0])
    lon = float(q["lon"][0])
    return http_text(
        "https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,"
        "weather_code,wind_speed_10m,wind_direction_10m"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
        "&timezone=auto&forecast_days=7" % (lat, lon))


def api_geocode(q):
    name = urllib.parse.quote(q["q"][0], safe="")
    return http_text("https://geocoding-api.open-meteo.com/v1/search"
                     "?name=%s&count=8&language=en&format=json" % name)


def api_tles():
    return http_text(TLE_URL, 25)


# ------------------------------------------------------------------ server

def log(msg):
    sys.stdout.write("  %s\n" % msg)
    sys.stdout.flush()


class Handler(BaseHTTPRequestHandler):
    server_version = "WorldRadioPC"

    def log_message(self, *a):
        pass                                   # keep the console readable

    def _send(self, body, ctype, code=200):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _fail(self, msg, code=502):
        log("  ! %s" % msg)
        self._send(json.dumps({"error": str(msg)}), "application/json", code)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        q = urllib.parse.parse_qs(parsed.query)

        if not path.startswith("/api/"):
            return self._static(path)

        try:
            if path == "/api/news":
                return self._send(api_news(), "application/json")
            if path == "/api/sdr":
                return self._send(_read_asset("sdr.json"), "application/json")
            if path == "/api/aircraft":
                lat = (q.get("lat") or ["34.35"])[0]
                lon = (q.get("lon") or ["-80.08"])[0]
                try:
                    rad = int((q.get("radius") or ["250"])[0])
                except ValueError:
                    rad = 250
                if rad < 50:
                    rad = 50
                if rad > 2000:
                    rad = 2000
                return self._send(api_aircraft(lat, lon, rad), "application/json")
            if path == "/api/pskspots":
                freq = (q.get("freq") or ["14000000,14350000"])[0]
                try:
                    mins = int((q.get("minutes") or ["15"])[0])
                except ValueError:
                    mins = 15
                return self._send(api_pskspots(freq, mins), "application/xml")
            if path == "/api/stations":
                limit = int(q.get("limit", ["6000"])[0])
                return self._send(api_stations(limit), "application/json")
            if path == "/api/temps":
                return self._send(api_temps(), "application/json")
            if path == "/api/weather":
                return self._send(api_weather(q), "application/json")
            if path == "/api/geocode":
                return self._send(api_geocode(q), "application/json")
            if path == "/api/tles":
                return self._send(api_tles(), "text/plain")
            if path == "/api/tile":
                return self._send(api_tile(q["u"][0]), "text/plain")
            if path == "/api/ping":
                return self._send("pong", "text/plain")
        except Exception as e:
            return self._fail("%s: %s" % (type(e).__name__, e))

        self._fail("unknown endpoint %s" % path, 404)

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        target = os.path.normpath(os.path.join(WWW, rel))
        if not target.startswith(WWW):                  # no path escape
            return self._fail("forbidden", 403)
        if not os.path.isfile(target):
            # a bare name like /mobile.html should still resolve
            alt = os.path.normpath(os.path.join(WWW, os.path.basename(rel)))
            if os.path.isfile(alt):
                target = alt
            else:
                return self._send("not found: %s" % rel, "text/plain", 404)

        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".txt": "text/plain; charset=utf-8",
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".svg": "image/svg+xml",
        }.get(os.path.splitext(target)[1].lower(), "application/octet-stream")
        with open(target, "rb") as fh:
            self._send(fh.read(), ctype)


# ------------------------------------------------------------------ launch

EDGES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_edge():
    for e in EDGES:
        if os.path.isfile(e):
            return e
    return None


def free_port(start):
    for p in range(start, start + 40):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free port near %d" % start)


def open_window(url, size, use_browser):
    w, h = size
    if not use_browser:
        edge = find_edge()
        if edge:
            # --app gives a chromeless window, i.e. it looks like a real app
            subprocess.Popen([edge, "--app=" + url,
                              "--window-size=%d,%d" % (w, h),
                              "--no-first-run", "--no-default-browser-check"],
                             creationflags=0x00000008)   # DETACHED_PROCESS
            return "Edge app window"
    webbrowser.open(url)
    return "default browser"


def main():
    ap = argparse.ArgumentParser(description="World Radio - desktop edition")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--size", default="1100x840", help="window WxH")
    ap.add_argument("--browser", action="store_true",
                    help="open a normal browser tab instead of an app window")
    ap.add_argument("--no-open", action="store_true", help="serve only")
    args = ap.parse_args()

    if not os.path.isdir(WWW):
        sys.exit("assets folder not found:\n  %s\n"
                 "Run this from inside the WorldRadio project." % WWW)

    try:
        w, h = (int(v) for v in args.size.lower().split("x"))
    except Exception:
        w, h = 1100, 840

    port = free_port(args.port)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port

    print()
    print("  World Radio - desktop edition")
    print("  " + "-" * 46)
    print("  serving  %s" % WWW)
    print("  address  %s" % url)
    if not args.no_open:
        how = open_window(url, (w, h), args.browser)
        print("  opened   %s (%dx%d)" % (how, w, h))
    print("  Ctrl-C to stop")
    print()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
