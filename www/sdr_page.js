/* =====================================================================
   SDR PAGE  —  a handset-style remote for OpenWebRX / OpenWebRX+ receivers
   ---------------------------------------------------------------------
   A STATIC page. It never opens the receiver's own web GUI: it speaks to the
   receiver over its websocket and draws the whole display itself, so the page
   stays put and the controls drive the radio.

   Protocol (read out of the receiver's own compiled/receiver.js):
     ws://host:port/ws/           <- NOTE the trailing slash
     on open :  "SERVER DE CLIENT client=openwebrx.js type=receiver"
     out     :  {"type":"setfrequency","params":{"frequency":Hz[,"key":...]}}
                {"type":"dspcontrol","params":{"mod":"usb"}}
                {"type":"selectprofile","params":{"profile":id}}
     in      :  JSON   config{center_freq,samp_rate,fft_size,...} | smeter{value}
                       modes{value} | profiles | features | dial_frequencies
                binary byte0 = 1 FFT (Float32, dB) | 2 audio (Int16 mono, 12 kHz)
                               3 secondary FFT | 4 HD audio | 6 HD stereo
   ===================================================================== */
(function () {
"use strict";

  function el(id) { return document.getElementById(id); }

  /* each S-unit is 6 dB; HF IARU S9 = -73 dBm, S0 = -127 dBm */
  var DB_S0 = -127, DB_PER_S = 6;

  var STEPS = [1, 10, 100, 1000, 5000, 9000, 10000, 12500, 25000, 100000, 1000000];
  var STEP_LBL = { 1: "1 Hz", 10: "10 Hz", 100: "100 Hz", 1000: "1 kHz", 5000: "5 kHz",
                   9000: "9 kHz", 10000: "10 kHz", 12500: "12.5 kHz", 25000: "25 kHz",
                   100000: "100 kHz", 1000000: "1 MHz" };
  var BANDS = [["160m", 1840000], ["80m", 3700000], ["40m", 7100000], ["30m", 10125000],
               ["20m", 14100000], ["17m", 18100000], ["15m", 21100000], ["12m", 24950000],
               ["10m", 28400000], ["CB 11m", 27065000], ["6m", 50125000], ["2m", 144200000]];
  /* [display name, modulation id]. The id is what the receiver wants, and it is
     NOT the display name: "FM" is really "nfm" on an OpenWebRX server, and
     sending "fm" is silently accepted but produces NO audio at all. */
  var FALLBACK_MODES = [["AM", "am"], ["LSB", "lsb"], ["USB", "usb"],
                        ["CW", "cw"], ["SAM", "sam"], ["FM", "nfm"], ["WFM", "wfm"]];
  /* These four are always visible as buttons; everything else the receiver
     offers (CW, SAM, WFM, ...) goes in the "more" dropdown beside them. */
  var PRIMARY_MODES = ["am", "nfm", "usb", "lsb"];
  var PRIMARY_ORDER = { am: 0, nfm: 1, fm: 1, usb: 2, lsb: 3 };
  var DB_MIN = -120, DB_MAX = -30;          /* fallback window if the server says nothing */
  var CENTRE_COLOUR = "#ff2b2b";            /* solid red centre marker on both canvases */
  var WF_LUT = null;                        /* 256-entry colour table from the server scheme */

  var S = {
    ws: null, connected: false, ready: false,
    radios: [], pick: -1,
    freq: 27065000, mode: "AM", step: 1000, tuneAt: null, zoom: 1, lastFft: null, visCenter: null,
    wfMin: -120, wfMax: -30, wfUser: false, centerKnown: 0,
    rateOf: { 2: 12000, 4: 48000, 6: 48000 }, estByType: {}, rulerLabels: [], rds: null,
    proto: "owrx", kiwi: null, kiwiTs: null, kiwiTimer: null, audioUnlocked: false,
    center: 0, bw: 0, fftSize: 0,
    smeterDb: DB_S0, smeterOffset: 0, modeBp: null,
    audioCtx: null, nextPlay: 0, playing: false,
    audioComp: "adpcm", fftComp: "adpcm",
    rate: 12000,
    spec: null, sctx: null,
    water: null, wctx: null,
    hist: null, hctx: null, hRow: 0,
    keys: "", keyOpen: false
  };

  /* ---------------------------------------------------------- formatting */
  function pad3(hz) { return (hz / 1e6).toFixed(3).padStart(7, "0"); }
  function put(x) { return x.toFixed(1); }

  function fmtShort(hz) {
    if (hz >= 1e6) return (hz / 1e6).toFixed(4) + " MHz";
    return Math.round(hz / 1e3) + " kHz";
  }

  function bandName(hz) {
    var best = "", d = Infinity;
    BANDS.forEach(function (b) { var x = Math.abs(hz - b[1]); if (x < d) { d = x; best = b[0]; } });
    if (d < 1500000) return best;
    if (hz >= 87500000 && hz <= 108000000) return "FM broadcast";
    if (hz >= 530000 && hz <= 1710000) return "MW broadcast";
    if (hz >= 2300000 && hz <= 26100000) return "shortwave";
    if (hz >= 47000000 && hz <= 70000000) return "TV / 6m";
    return "";
  }

  function dbToS(db) { return Math.max(0, Math.min(15, (db - DB_S0) / DB_PER_S)); }

  function sLabel(s) {
    if (s < 9) return "S" + Math.round(s);
    return "S9+" + Math.round((s - 9) * DB_PER_S);
  }

  function status(msg, cls) {
    var t = el("sdrStatus");
    if (!t) return;
    t.textContent = msg || "";
    t.className = "sdr-status" + (cls ? " " + cls : "");
  }

  /* ------------------------------------------------------------- receivers */
  function sdrKeyFor(url, name) {
    /* the magic key only exists on the owner's own receiver */
    var n = (name || "") + " " + (url || "");
    return /ka3kdl|192\.168\.1\.67|75\.182\.152\.23|memagic/i.test(n) ? "memagic" : "";
  }

  /* This page speaks ONE protocol: the OpenWebRX websocket. The bundled list is
     mostly KiwiSDR (1208 of 1820) and WebSDR/UberSDR, which can never answer that
     handshake - offering them here just produced "connecting... disconnected".
     Keep OpenWebRX entries (plus anything with no type at all, so a future list
     that drops the field still works); the others open from the map instead. */
  function isOpenWebrx(r) {
    var s = String((r && (r.src || r.s)) || "").toLowerCase();
    if (!s) return true;                       /* unknown -> give it a chance */
    return s.indexOf("openwebrx") >= 0;
  }
  function isOfflineRec(r) {
    var o = r && r.offline;
    return o === 1 || o === "1" || o === true || o === "true";
  }
  function goodList() {
    try {
      var a = JSON.parse(localStorage.getItem("sdr_good") || "[]");
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function markGood(url) {
    if (!url) return;
    var l = goodList().filter(function (u) { return u !== url; });
    l.unshift(url);
    try { localStorage.setItem("sdr_good", JSON.stringify(l.slice(0, 60))); } catch (e) {}
  }
  /* ======================================================= KiwiSDR protocol
     A SECOND protocol behind the same UI (1208 of the bundled 1820 receivers).
     Verified live against a real KiwiSDR:
       - two sockets, both with the same 62-bit session id:
             /ws/kiwi/<ts>/SND   audio (and spectrum), /ws/kiwi/<ts>/W/F  waterfall
       - "SET auth t=kiwi p=#" is sent TWICE; the second one is what makes the
         receiver send cfg_loaded
       - "SET AR OK in=12000 out=48000" must be a REPLY to the receiver's
         "audio_init=... audio_rate=..." message. Sent sooner the socket is closed
         with 1005 and nothing ever streams - that single ordering rule is the
         whole reason this protocol looked impossible at first.
       - SND frame: "SND" + flags + 4-byte seq + 2-byte S-meter, samples from
         byte 10 (mono) / 20 (stereo), 16-bit, endianness from flags bit0
       - any non-"SND" frame on that socket is the spectrum (values from byte 5)
       - W/F frame: 1040 bytes = 16-byte header + 1024 waterfall values, one line
         per frame; the newest line doubles as the spectrum
     Frequency is kHz (not Hz) and mode names differ slightly (FM, not WFM). */
  var KIWI_MODES = {
    am:   { mod: "am",   lo: -4000, hi: 4000 },
    sam:  { mod: "sam",  lo: -4000, hi: 4000 },
    lsb:  { mod: "lsb",  lo: -2700, hi: -300 },
    usb:  { mod: "usb",  lo: 300,   hi: 2700 },
    cw:   { mod: "cw",   lo: 400,   hi: 800  },
    cwn:  { mod: "cwn",  lo: 400,   hi: 800  },
    nfm:  { mod: "nfm",  lo: -5000, hi: 5000 },
    fm:   { mod: "fm",   lo: -5000, hi: 5000 },
    wfm:  { mod: "fm",   lo: -8000, hi: 8000 },
    dig:  { mod: "usb",  lo: 300,   hi: 2700 }
  };
  var KIWI_LIST = ["AM", "SAM", "LSB", "USB", "CW", "NFM", "FM"];
  function kiwiHost(url) {
    var h = String(url || "").replace(/^wss?:\/\//i, "").replace(/^https?:\/\//i, "");
    h = h.replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (h.indexOf("/") > 0) h = h.substring(0, h.indexOf("/"));
    if (!/:\d+$/.test(h)) h += ":8073";
    return h;
  }
  function kiwiConnect(hz) {
    if (S.kiwi) kiwiDisconnect();
    var r = S.radios[S.pick];
    var host = kiwiHost(r && r.url);
    S.proto = "kiwi";
    S.kiwiTs = S.kiwiTs || String(Math.floor(Math.random() * 4.6e18));
    S.kiwi = { host: host, snd: null, wf: null, ready: false, dbMin: -100, dbMax: 0,
               smeterRaw: 0, frames: 0, wfLines: 0 };
    S.rateOf = { 2: 12000, 4: 12000, 6: 12000 };       /* kiwi audio is 12 kHz */
    S.kiwi.adpcm = { stepIndex: 0, predictor: 0 };
    S.audioComp = "none";                              /* SET compression=0 below */
    S.wfMin = -100; S.wfMax = 0; wfShowLevels();
    var base = (String(r.url).indexOf("https://") === 0 ? "wss://" : "ws://") + host + "/ws/kiwi/" + S.kiwiTs;
    /* ---- audio socket */
    var s = new WebSocket(base + "/SND");
    S.kiwi.snd = s;
    s.binaryType = "arraybuffer";
    var stage = 0;
    s.onopen = function () {
      S.connected = true; setConnBtn(true);
      status("Connecting to KiwiSDR " + (r.name || host) + " \u2026");
      kiwiSay("SET auth t=kiwi p=#");
    };
    s.onmessage = function (ev) {
      if (typeof ev.data === "string") return;
      var u8 = new Uint8Array(ev.data);
      var tag = String.fromCharCode(u8[0], u8[1], u8[2]);
      if (tag === "MSG") {
        var txt = "";
        for (var i = 4; i < u8.length; i++) txt += String.fromCharCode(u8[i]);
        if (stage === 0) {                       /* first burst -> send auth again */
          stage = 1; kiwiSay("SET auth t=kiwi p=#");
        } else if (stage === 1 && /(^| )cfg_loaded/.test(txt)) {
          stage = 2; kiwiSay("SET AR OK in=12000 out=48000");   /* the gate */
        } else if (stage === 2 && /audio_init/.test(txt)) {
          stage = 3;
          kiwiSay("SERVER DE CLIENT openwebrx.js SND");
          kiwiSay("SET dbug_v=0,0,0,0,0");
          kiwiSay("SET browser=WorldRadio");
          /* ready FIRST: kiwiTune() refuses to send until it is set, and a KiwiSDR
             does not stream audio until it has been told a mode and frequency */
          S.kiwi.ready = true;
          kiwiTune(true);
          kiwiSay("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
          kiwiSay("SET compression=0");
          status("Connected \u00b7 " + (r.name || host) + " (KiwiSDR)", "ok");
          setModes(KIWI_LIST);
          markGood(r.url);
          startAudio();
          kiwiStart();
        }
        var ad = txt.match(/audio_adpcm_state=(-?\d+),(-?\d+)/);
        if (ad) { kiwiAdpcmReset(); S.kiwi.adpcm.stepIndex = Math.max(0, Math.min(88, +ad[1])); S.kiwi.adpcm.predictor = +ad[2]; }
        var cf = txt.match(/center_freq=(\d+)/), bw = txt.match(/bandwidth=(\d+)/);
        /* The receiver answering mid-drag used to set visCenter back to ITS centre, so the
       display jumped backwards and then forwards again on the next move - the owner saw
       it as a spring. Accept the receiver's centre only when the user is not actively
       tuning (and has not been for a moment); until then the DIAL owns the display. */
    if (cf) { S.center = +cf[1]; if (userTuneQuiet()) S.visCenter = S.center; }
        if (bw) S.bw = +bw[1];
        if (cf || bw) { drawScale(); redrawLast(); }
        return;
      }
      if (tag === "SND") { kiwiSnd(u8); return; }
      kiwiSpectrum(u8, 5);                       /* any other frame = spectrum */
    };
    s.onclose = function (ev) { kiwiClosed(ev, r); };
    s.onerror = function () { S.lastError = "Cannot reach " + (r.name || host) + " (KiwiSDR)."; };
    /* ---- waterfall socket */
    var w = new WebSocket(base + "/W/F");
    S.kiwi.wf = w;
    w.binaryType = "arraybuffer";
    w.onopen = function () {
      kiwiWSay("SET auth t=kiwi p=#");
      kiwiWSay("SERVER DE CLIENT openwebrx.js W/F");
      kiwiWSay("SET send_dB=1"); kiwiWSay("SET zoom=0 start=0");
      kiwiWSay("SET maxdb=0 mindb=-100"); kiwiWSay("SET interp=13");
      kiwiWSay("SET window_func=2"); kiwiWSay("SET wf_speed=4");
    };
    w.onmessage = function (ev) {
      if (typeof ev.data === "string") return;
      var u8 = new Uint8Array(ev.data);
      if (String.fromCharCode(u8[0], u8[1], u8[2]) !== "W/F") return;
      S.kiwi.wfLines++;
      kiwiSpectrum(u8, 16);                      /* 16-byte header, then 1024 values */
    };
    S.kiwiTimer = setInterval(function () { try { kiwiSay("SET keepalive"); } catch (e) {} }, 5000);
  }
  function kiwiSay(line) { try { if (S.kiwi && S.kiwi.snd && S.kiwi.snd.readyState === 1) S.kiwi.snd.send(line); } catch (e) {} }
  function kiwiWSay(line) { try { if (S.kiwi && S.kiwi.wf && S.kiwi.wf.readyState === 1) S.kiwi.wf.send(line); } catch (e) {} }
  function kiwiStart() { try { startAudio(); } catch (e) {} }
  function kiwiDisconnect() {
    if (S.kiwiTimer) { clearInterval(S.kiwiTimer); S.kiwiTimer = null; }
    if (S.kiwi) {
      try { if (S.kiwi.snd) S.kiwi.snd.close(); } catch (e) {}
      try { if (S.kiwi.wf) S.kiwi.wf.close(); } catch (e) {}
      S.kiwi = null;
    }
  }
  function kiwiClosed(ev, r) {
    if (S.lastError) { status(S.lastError, "bad"); S.lastError = ""; }
    else if (!S.gotData) status((r && (r.name || r.url) || "That KiwiSDR") +
        " refused the connection \u2014 it may be full or offline.", "bad");
    else status("Disconnected.", "");
    S.connected = false; setConnBtn(false);
  }
  /* KiwiSDR sends IMA ADPCM. Its decoder (ImaAdpcmDecode) uses the TEXTBOOK order -
     take the step for the CURRENT index, apply the nibble, THEN advance the index -
     while the OpenWebRX codec in this same file advances first and uses the leftover
     step. They are genuinely different, so this file keeps both. Flag bits are the
     receiver's own: 0x08 stereo, 0x10 compressed, 0x40 squelch, 0x80 little-endian. */
  function kiwiAdpcmReset() { if (S.kiwi) S.kiwi.adpcm = { stepIndex: 0, predictor: 0 }; }
  function kiwiAdpcmNibble(n, st) {
    var step = IMA_STEP[st.stepIndex];
    var diff = step >> 3;
    if (n & 1) diff += step >> 2;
    if (n & 2) diff += step >> 1;
    if (n & 4) diff += step;
    if (n & 8) diff = -diff;
    st.predictor += diff;
    if (st.predictor > 32767) st.predictor = 32767;
    else if (st.predictor < -32768) st.predictor = -32768;
    st.stepIndex += IMA_IDX[n];
    if (st.stepIndex < 0) st.stepIndex = 0;
    else if (st.stepIndex > 88) st.stepIndex = 88;
    return st.predictor;
  }
  function kiwiSnd(u8) {
    if (u8.length < 12) return;
    S.gotData = true;
    var flags = u8[3];
    S.kiwi.smeterRaw = (u8[8] << 8) | u8[9];
    S.smeterDb = -100 + (S.kiwi.smeterRaw / 255) * 80;      /* approximate, raw is device-tuned */
    drawSmeter();
    var stereo = !!(flags & 0x08);
    var compressed = !!(flags & 0x10);
    var squelched = !!(flags & 0x40);
      S.squelched = squelched;   /* the scanner reads this */
    var little = !!(flags & 0x80);
    var off = stereo ? 20 : 10;
    if (u8.length - off < 8) return;
    var pcm;
    if (compressed) {
      if (!S.kiwi.adpcm) kiwiAdpcmReset();
      var bytes = u8.length - off;
      pcm = new Int16Array(bytes * 2);
      var st = S.kiwi.adpcm;
      for (var b = 0; b < bytes; b++) {
        var by = u8[off + b];
        pcm[b * 2] = kiwiAdpcmNibble(by & 0x0F, st);
        pcm[b * 2 + 1] = kiwiAdpcmNibble((by >> 4) & 0x0F, st);
      }
    } else {
      var n = (u8.length - off) >> 1;
      pcm = new Int16Array(n);
      var dv = new DataView(u8.buffer, u8.byteOffset + off, n * 2);
      for (var i = 0; i < n; i++) pcm[i] = dv.getInt16(i * 2, little);
    }
    if (squelched) pcm.fill(1);
    S.kiwi.frames++;
    S.kiwi.samples = (S.kiwi.samples || 0) + pcm.length;
    S.kiwi.comp = compressed; S.kiwi.flags = flags;
    if (!S.kiwi.t0) S.kiwi.t0 = performance.now();
    for (var q = 0; q < pcm.length; q += 8) {          /* cheap level stats for diagnosis */
      var v = pcm[q] < 0 ? -pcm[q] : pcm[q];
      if (v > (S.kiwi.peak || 0)) S.kiwi.peak = v;
      S.kiwi.pow = (S.kiwi.pow || 0) + (pcm[q] * pcm[q]) / 64;
      S.kiwi.cnt = (S.kiwi.cnt || 0) + 1;
    }
    dbg.audio = (dbg.audio || 0) + 1;
    dbg.pickRate = "kiwi:12000";
    if (audioReady()) pushAudio(pcm, 12000);
  }
  function kiwiSpectrum(u8, off) {
    var n = u8.length - off;
    if (n < 16) return;
    var f = new Float32Array(n);
    var lo = S.kiwi ? S.kiwi.dbMin : -100, hi = S.kiwi ? S.kiwi.dbMax : 0;
    for (var i = 0; i < n; i++) f[i] = lo + (u8[off + i] / 255) * (hi - lo);
    S.lastFft = f;
    dbg.fft = (dbg.fft || 0) + 1;
    queueFft(f);
  }
  function kiwiTune(force) {
    if (S.proto !== "kiwi" || !S.kiwi) return;
    if (!S.kiwi.ready && !force) return;
    var m = KIWI_MODES[S.mode] || KIWI_MODES.am;
    var f = (S.freq / 1000).toFixed(3);
    kiwiSay("SET mod=" + m.mod + " low_cut=" + m.lo + " high_cut=" + m.hi + " freq=" + f);
  }

  /* which protocol does this receiver speak? The bundled list says so (`src`). */
  function protoOf(r) {
    var s = String((r && (r.src || r.s)) || "").toLowerCase();
    if (s.indexOf("kiwi") >= 0) return "kiwi";
    if (s.indexOf("openwebrx") >= 0 || !s) return "owrx";
    return "other";
  }

  function buildPick() {
    var sel = el("sdrPick");
    if (!sel) return;
    var list = [], skipped = 0, total = 0;

    try {
      var pub = (typeof sdrItems !== "undefined" && Array.isArray(sdrItems)) ? sdrItems : [];
      total = pub.length;
      var good = goodList();
      pub.forEach(function (r) {
        if (!r || !r.url) return;
        var pr = protoOf(r);
        if ((pr !== "owrx" && pr !== "kiwi") || isOfflineRec(r)) { skipped++; return; }
        list.push({ name: r.name || r.url, loc: r.loc || r.cs || "", url: r.url,
                    src: r.src || r.s || "", proto: pr, wasGood: good.indexOf(r.url) >= 0 });
      });
      /* receivers that have worked before float to the top - with 400 of them,
         finding a live one again matters more than the list's original order */
      list.sort(function (a, b) { return (b.wasGood ? 1 : 0) - (a.wasGood ? 1 : 0); });
    } catch (e) {}

    /* the owner's own receiver goes on top */
    try {
      if (typeof MY_SDR_NAME !== "undefined" && typeof MY_SDR_URL !== "undefined") {
        list = list.filter(function (r) { return r.url !== MY_SDR_URL; });
        list.unshift({ name: MY_SDR_NAME, loc: "my receiver", url: MY_SDR_URL, src: "openwebrx",
                   proto: "owrx", mine: true });
      }
    } catch (e2) {}

    S.radios = list;
    sel.innerHTML = "";
    var ph = document.createElement("option");
    ph.value = "-1";
    ph.textContent = (skipped
      ? "— pick a receiver (" + list.length + " of " + total + " usable) —"
      : "— pick a receiver (" + list.length + ") —") +
      (S.kwCount ? "" : "");
    sel.appendChild(ph);

    list.forEach(function (r, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = (r.wasGood ? "\u2713 " : "") + (r.name || "Unknown") + (r.loc ? "  ·  " + r.loc : "");
      sel.appendChild(o);
    });

    var saved = null;
    try { saved = localStorage.getItem("sdr_pick"); } catch (e3) {}
    if (saved !== null && +saved >= 0 && +saved < list.length) {
      sel.value = saved;
      S.pick = +saved;
    }
  }

  /* --------------------------------------------------------------- connect */
  function wsFor(url) {
    var base = String(url).replace(/[#?].*$/, "").replace(/\/+$/, "");
    var out = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
    if (!/^wss?:/i.test(out)) out = "ws://" + out;
    return out + "/ws/";
  }

  function connect() {
    unlockAudio();                       /* the tap's activation is needed here, not later */
    var r = S.radios[S.pick];
    if (!r || !r.url) { status("Pick a receiver at the top first.", "bad"); return; }
    disconnect(true);

    if (protoOf(r) === "kiwi") { kiwiConnect(); return; }
    S.proto = "owrx";
    /* coming back from a KiwiSDR: its 12 kHz must not leak into the OpenWebRX hd
       stream, which really is 48 kHz (playing that at 12 kHz is the slow-motion bug) */
    S.rateOf = { 2: 12000, 4: 48000, 6: 48000 };
    S.audioComp = "adpcm";
    var url = wsFor(r.url);
    status("Connecting to " + (r.name || r.url) + " …");
    try { S.ws = new WebSocket(url); }
    catch (e) { status("That receiver's address looks wrong.", "bad"); return; }
    S.ws.binaryType = "arraybuffer";

    S.gotData = false;
    S.openedAt = performance.now();
    S.ws.onopen = function () {
      S.connected = true;
      /* the handshake the receiver's own client sends - without it no stream */
      try { S.ws.send("SERVER DE CLIENT client=openwebrx.js type=receiver"); } catch (e) {}
      status("Connected · " + (r.name || ""), "ok");
      setConnBtn(true);
      startAudio();
      send({ type: "setfrequency", params: freqParams(S.freq) });
      send({ type: "dspcontrol", params: dspParams() });
      /* The demodulator does NOT run until the client sends this one. Without
         it the server streams FFT only - no audio, and no S-meter readings. */
      send({ type: "dspcontrol", action: "start" });
    };

    S.ws.onmessage = function (ev) {
      if (typeof ev.data === "string") { onJson(ev.data); return; }
      onBinary(ev.data);
    };

    S.ws.onclose = function () {
      var wasUp = S.connected, got = S.gotData;
      S.connected = false;
      setConnBtn(false);
      if (S.lastError) { status(S.lastError, "bad"); S.lastError = ""; return; }
      if (!got) {
        status((r.name || r.url) + " refused the connection — it may be full, offline, " +
               "or not an OpenWebRX receiver (KiwiSDR / WebSDR open from the Map view).", "bad");
      } else status(wasUp ? "Disconnected." : "Disconnected.", "");
    };

    S.ws.onerror = function () {
      S.lastError = "Cannot reach " + (r.name || r.url) + " — it looks offline, or the network is blocking it.";
    };
  }

  function disconnect(quiet) {
    kiwiDisconnect();
    if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
    S.connected = false;
    setConnBtn(false);
    if (!quiet) status("Disconnected.", "");
  }

  function send(obj) {
    if (!S.ws || S.ws.readyState !== 1) return false;
    try { S.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function freqParams(hz) {
    var p = { frequency: Math.round(hz) };
    var k = sdrKeyFor(S.radios[S.pick] && S.radios[S.pick].url, S.radios[S.pick] && S.radios[S.pick].name);
    if (k) p.key = k;
    return p;
  }

  /* ================================================================== ADPCM
     The receiver reports audio_compression AND fft_compression = "adpcm" - both
     streams are IMA-ADPCM. Handing those compressed bytes to an Int16Array is
     what made the audio chop and the waterfall pure noise. This is the same
     codec the receiver's own client uses. */
  var IMA_IDX  = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
  var IMA_STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,
    60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,
    449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,
    2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,
    9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];

  function Adpcm() { this.reset(); }
  Adpcm.prototype.reset = function () {
    this.stepIndex = 0; this.predictor = 0; this.step = 0;
    this.synchronized = 0; this.syncCounter = 0; this.phase = 0;
    this.syncBuffer = new Uint8Array(8); this.syncBufferIndex = 0;
  };
  Adpcm.prototype.nibble = function (n) {
    /* Decode order matters and this matches the receiver's own codec
       (ImaAdpcmCodec.decodeNibble) sample-for-sample: advance the index, use the
       step left over from the previous sample, then refresh the step. Do not
       "fix" this into the textbook order - measured against OpenWebRX's own
       decoder on the same stream it is 161,680/161,680 identical as written. */
    this.stepIndex += IMA_IDX[n];
    if (this.stepIndex < 0) this.stepIndex = 0; else if (this.stepIndex > 88) this.stepIndex = 88;
    var diff = this.step >> 3;
    if (n & 1) diff += this.step >> 2;
    if (n & 2) diff += this.step >> 1;
    if (n & 4) diff += this.step;
    if (n & 8) diff = -diff;
    this.predictor += diff;
    if (this.predictor < -32768) this.predictor = -32768;
    else if (this.predictor > 32767) this.predictor = 32767;
    this.step = IMA_STEP[this.stepIndex];
    return this.predictor;
  };
  Adpcm.prototype.decode = function (b) {           /* FFT: reset per frame */
    var out = new Int16Array(b.length * 2), i;
    for (i = 0; i < b.length; i++) {
      out[i * 2] = this.nibble(b[i] & 0x0F);
      out[i * 2 + 1] = this.nibble((b[i] >> 4) & 0x0F);
    }
    return out;
  };
  /* ---- stereo (websocket type 6, "hd stereo"). Ported from the receiver's own
     ImaAdpcmCodec.decodeStereoWithSync: after the sync word come EIGHT bytes of
     runtime data (stepIndex+predictor for each of the two channels), then each
     byte carries two nibbles for channel 1 followed by two bytes for channel 2.
     The mono nibble() above is verified sample-for-sample against the receiver,
     so it is left untouched and this uses its own state machine. */
  Adpcm.prototype.resetStereo = function () {
    this.st1 = { stepIndex: 0, predictor: 0, step: 0 };
    this.st2 = { stepIndex: 0, predictor: 0, step: 0 };
    this.sphase = 0; this.ssync = 0; this.ssyncCount = 0;
    this.ssyncBuf = new Uint8Array(8); this.ssyncIdx = 0;
  };
  Adpcm.prototype.nibbleSt = function (n, st) {
    st.stepIndex += IMA_IDX[n];
    if (st.stepIndex < 0) st.stepIndex = 0; else if (st.stepIndex > 88) st.stepIndex = 88;
    var diff = st.step >> 3;
    if (n & 1) diff += st.step >> 2;
    if (n & 2) diff += st.step >> 1;
    if (n & 4) diff += st.step;
    if (n & 8) diff = -diff;
    st.predictor += diff;
    if (st.predictor < -32768) st.predictor = -32768;
    else if (st.predictor > 32767) st.predictor = 32767;
    st.step = IMA_STEP[st.stepIndex];
    return st.predictor;
  };
  Adpcm.prototype.decodeStereo = function (b) {
    if (!this.st1) this.resetStereo();
    var o0 = new Int16Array(b.length * 2), o1 = new Int16Array(b.length * 2), oi = 0, i;
    for (i = 0; i < b.length; i++) {
      if (this.sphase === 0) {
        if (b[i] !== ("SYNC".charCodeAt(this.ssync++))) this.ssync = 0;
        if (this.ssync === 4) { this.ssyncIdx = 0; this.sphase = 1; }
      } else if (this.sphase === 1) {
        this.ssyncBuf[this.ssyncIdx++] = b[i];
        if (this.ssyncIdx === 8) {
          var sd = new Int16Array(this.ssyncBuf.buffer, 0, 4);
          this.st1.stepIndex = sd[0]; this.st1.predictor = sd[1];
          this.st2.stepIndex = sd[2]; this.st2.predictor = sd[3];
          this.ssyncCount = 1000; this.sphase = 2;
        }
      } else {
        o0[oi] = this.nibbleSt(b[i] & 0x0F, this.st1);
        o0[oi + 1] = this.nibbleSt((b[i] >> 4) & 0x0F, this.st1);
        i += 1;
        o1[oi] = this.nibbleSt(b[i] & 0x0F, this.st2);
        o1[oi + 1] = this.nibbleSt((b[i] >> 4) & 0x0F, this.st2);
        oi += 2;
        if (this.ssyncCount-- === 0) { this.ssync = 0; this.sphase = 0; }
      }
    }
    return [o0.slice(0, oi), o1.slice(0, oi)];
  };

  Adpcm.prototype.decodeSync = function (b) {       /* audio: carries "SYNC" */
    var out = new Int16Array(b.length * 2), oi = 0, i;
    for (i = 0; i < b.length; i++) {
      if (this.phase === 0) {
        if (b[i] !== ("SYNC".charCodeAt(this.synchronized++))) this.synchronized = 0;
        if (this.synchronized === 4) { this.syncBufferIndex = 0; this.phase = 1; }
      } else if (this.phase === 1) {
        this.syncBuffer[this.syncBufferIndex++] = b[i];
        if (this.syncBufferIndex === 4) {
          var sd = new Int16Array(this.syncBuffer.buffer, 0, 2);
          this.stepIndex = sd[0]; this.predictor = sd[1];
          this.syncCounter = 1000; this.phase = 2;
        }
      } else {
        out[oi++] = this.nibble(b[i] & 0x0F);
        out[oi++] = this.nibble((b[i] >> 4) & 0x0F);
        if (this.syncCounter-- === 0) { this.synchronized = 0; this.phase = 0; }
      }
    }
    return oi ? out.subarray(0, oi) : out.subarray(0, 0);
  };

  var audioCodec = new Adpcm();
  var fftCodec = new Adpcm();
  var FFT_PAD = 10;                 /* same as COMPRESS_FFT_PAD_N in csdr.c */

  /* The stream rate is MEASURED, never assumed: this receiver sends 16 kHz, and
     playing 16 kHz data at 12 kHz is exactly why the audio dragged and chopped. */
  function snapRate(hz) {
    var C = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 36000, 44100, 48000];
    var best = 0, d = 1e9;
    C.forEach(function (c) { var x = Math.abs(c - hz); if (x < d) { d = x; best = c; } });
    if (best && d / best < 0.06) return best;
    return hz > 6000 ? Math.round(hz) : 0;
  }
  /* Is a measured rate believable for this stream type? Guards against a stalled
     or gap-ridden window producing a nonsense rate. Exposed through
     sdrPage.testing so the harness can assert it directly. */
  function rateAcceptable(type, hz) {
    var expect = (type === 2) ? 12000 : 48000;
    if (!isFinite(hz) || hz <= 0) return false;
    return Math.abs(hz - expect) / expect <= 0.25;
  }

  /* ============================================== PASSBAND / BANDWIDTH HANDLES
     The receiver takes low_cut / high_cut (Hz either side of the dial) and the app
     already sends them per mode. These are light-grey edges drawn on the spectrum
     that can be dragged to widen or narrow the mode, the way OpenWebRX does it.
     The handles sit at true frequency offsets from the CENTRE, so they stay put
     while signals slide underneath during a tune. */
  /* Not every receiver publishes low_cut/high_cut for every mode (the owner's does
     not), which left the handles with nothing to grab. These are the conventional
     passbands for the modes that have an adjustable one; a receiver's own values
     always win. Channelised modes (nfm/wfm) are deliberately absent - their
     bandwidth belongs to the channel, not to a sliding window. */
  var DEFAULT_BP = [
    [/^sam/, -5000, 5000],
    [/^am/,  -4500, 4500],
    [/^lsb/, -2700, -100],
    [/^usb/,  100,  2700],
    [/^cw/,   -400,   400],
    [/^dig|^rtty|^psk/, -1500, 1500]
  ];
  /* The app holds the friendly uppercase id ("AM") while receivers and these tables
     use lowercase ("am"); look the passband up case-insensitively or nothing matches. */
  function bpKey(mode) {
    if (!S.modeBp || !mode) return null;
    if (S.modeBp[mode]) return mode;
    var lc = String(mode).toLowerCase();
    if (S.modeBp[lc]) return lc;
    var ks = Object.keys(S.modeBp);
    for (var i = 0; i < ks.length; i++) if (ks[i].toLowerCase() === lc) return ks[i];
    return null;
  }
  function bpFor(mode) {
    if (!mode) return null;
    var k = bpKey(mode);
    var fromRx = k ? S.modeBp[k] : null;
    if (fromRx) {
      var lo = +fromRx.low_cut, hi = +fromRx.high_cut;
      if (isFinite(lo) && isFinite(hi) && hi - lo >= 50) return { lo: lo, hi: hi, from: "receiver" };
    }
    var lc = String(mode).toLowerCase();
    for (var i = 0; i < DEFAULT_BP.length; i++)
      if (DEFAULT_BP[i][0].test(lc)) return { lo: DEFAULT_BP[i][1], hi: DEFAULT_BP[i][2], from: "default" };
    return null;              /* no adjustable passband for this mode */
  }
  function bandCuts() {
    var bp = bpFor(S.mode);
    if (!bp) return null;
    /* bpFor() normalises to {lo,hi}; reading .low_cut/.high_cut here silently
       produced undefined and the handles never appeared. */
    var lo = +bp.lo, hi = +bp.hi;
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 50) return null;
    return { lo: lo, hi: hi, from: bp.from };
  }
  function cutToPx(hz, W, span) { return ((hz + span / 2) / span) * W; }
  function pxToCut(x, W, span) { return (x / W - 0.5) * span; }
  function drawBand(g, W, H) {
    var cuts = bandCuts();
    if (!cuts) { dbg.bandWhy = "no passband for mode " + S.mode +
                   " (modeBp keys: " + (S.modeBp ? Object.keys(S.modeBp).join(",") : "null") + ")"; return; }
    var span = visSpan();
    if (!span) { dbg.bandWhy = "visSpan 0 (bw " + S.bw + ")"; return; }
    dbg.bandWhy = "drawn";
    var x1 = cutToPx(cuts.lo, W, span), x2 = cutToPx(cuts.hi, W, span);
    if (x2 < x1) { var q = x1; x1 = x2; x2 = q; }
    dbg.band = { lo: Math.round(cuts.lo), hi: Math.round(cuts.hi), from: cuts.from,
                 xLo: Math.round(x1), xHi: Math.round(x2),
                 width: Math.round(cuts.hi - cuts.lo), dragging: S.bwDrag ? S.bwDrag.which : null };
    g.save();
    /* a subtle shade BETWEEN the edges only (the owner asked for this one back after the
       one outside them - the fill under the curve - was removed) */
    g.fillStyle = "rgba(120,190,255,.10)";
    g.fillRect(x1, 0, Math.max(1, x2 - x1), H);
    g.strokeStyle = "rgba(190,205,220,.75)";
    g.lineWidth = 1.5;
    [x1, x2].forEach(function (x) {
      g.beginPath(); g.moveTo(x + 0.25, 0); g.lineTo(x + 0.25, H); g.stroke();
      g.fillStyle = "rgba(210,222,235,.9)";                 /* grip */
      g.fillRect(x - 3.5, 0, 7, 4);
    });
    g.restore();
  }
  function bwLabel(text) {
    var b = el("sdrBwRead");
    if (!b) {
      b = document.createElement("span");
      b.id = "sdrBwRead";
      b.setAttribute("style", "position:absolute;z-index:6;background:rgba(8,14,22,.92);" +
        "border:1px solid #3a4a5e;border-radius:4px;padding:1px 6px;font:11px/1.35 monospace;" +
        "color:#dbe6f2;pointer-events:none;display:none");
      var host = document.querySelector("#sdrView .sdr-scale") || document.querySelector("#sdrView");
      if (host) { host.style.position = host.style.position || "relative"; host.appendChild(b); }
    }
    if (!b) return;
    if (!text) { b.style.display = "none"; return; }
    b.textContent = text;
    b.style.display = "block";
    b.style.left = "50%";
    b.style.transform = "translateX(-50%)";
    b.style.top = "16px";
  }
  function sendBand() {
    /* a dragged passband is the user's, so remember it per mode - it must survive a
       mode switch and a reconnect */
    if (!S.modeBp) S.modeBp = {};
    var c = bandCuts();
    if (c) S.modeBp[bpKey(S.mode) || String(S.mode).toLowerCase()] = { low_cut: c.lo, high_cut: c.hi };
    if (S.proto === "kiwi") { try { kiwiTune(); } catch (e) {} return; }
    try { send({ type: "dspcontrol", params: dspParams() }); } catch (e) {}
  }
  function wireBand() {
    var sp = el("sdrSpectrum");
    if (!sp || sp.dataset.bwired) return;
    sp.dataset.bwired = "1";
    function canvasX(ev) {
      var r = sp.getBoundingClientRect();
      if (!(r.width > 0)) return null;
      return (ev.clientX - r.left) * (sp.width / r.width);
    }
    function hit(ev) {
      var cuts = bandCuts();
      var span = visSpan();
      if (!cuts || !span || !sp.width) return null;
      var x = canvasX(ev);
      if (x === null) return null;
      var xl = cutToPx(cuts.lo, sp.width, span), xh = cutToPx(cuts.hi, sp.width, span);
      /* nearest handle wins: when the span is wide the two edges can sit only a few
         pixels apart, so "lo first" would make the right edge unreachable */
      var near = Math.max(12, sp.width * 0.04);
      var dl = Math.abs(x - xl), dh = Math.abs(x - xh);
      if (dl <= near || dh <= near) return dl <= dh ? "lo" : "hi";
      return null;
    }
    /* capture phase + stopPropagation, so grabbing an edge never falls through to
       the tune handler (a bandwidth drag must never retune the radio) */
    sp.addEventListener("pointerdown", function (ev) {
      var which = hit(ev);
      if (!which) return;
      S.bwDrag = { which: which, span: visSpan() };
      try { sp.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.stopPropagation(); ev.preventDefault();
      var c = bandCuts();
      bwLabel((c.hi - c.lo).toFixed(0) + " Hz");
      scheduleDisplay();
    }, true);
    sp.addEventListener("pointermove", function (ev) {
      if (!S.bwDrag) return;
      ev.stopPropagation();
      try { ev.preventDefault(); } catch (e) {}
      var x = canvasX(ev);
      if (x === null) return;
      var span = S.bwDrag.span || visSpan();
      var want = Math.round(pxToCut(x, sp.width, span) / 50) * 50;      /* 50 Hz grid */
      var c = bandCuts();
      if (!c) return;
      if (S.bwDrag.which === "lo") c.lo = Math.min(want, c.hi - 100);
      else c.hi = Math.max(want, c.lo + 100);
      var lim = Math.min(span / 2, 20000);
      c.lo = Math.max(-lim, Math.min(lim, c.lo));
      c.hi = Math.max(-lim, Math.min(lim, c.hi));
      /* cap the WINDOW, not just each edge - otherwise both edges could sit at their
         own limit and the window would be 40 kHz, which is nonsense for voice modes */
      var MAXW = 20000;
      if (c.hi - c.lo > MAXW) {
        if (S.bwDrag.which === "lo") c.lo = c.hi - MAXW; else c.hi = c.lo + MAXW;
      }
      if (c.hi - c.lo < 100) {                  /* keep a usable minimum window */
        if (S.bwDrag.which === "lo") c.lo = c.hi - 100; else c.hi = c.lo + 100;
      }
      S.modeBp[bpKey(S.mode) || String(S.mode).toLowerCase()] = { low_cut: c.lo, high_cut: c.hi };
      dbg.bandSet = { lo: c.lo, hi: c.hi, which: S.bwDrag.which };
      bwLabel((c.hi - c.lo).toFixed(0) + " Hz   (" + (c.lo / 1000).toFixed(1) + " / " +
              (c.hi / 1000).toFixed(1) + " k)");
      var now = Date.now();
      if (now - (S.bwDrag.last || 0) >= 150) { S.bwDrag.last = now; sendBand(); }
      scheduleDisplay();
    }, true);
    function end(ev) {
      if (!S.bwDrag) return;
      ev.stopPropagation();
      try { sp.releasePointerCapture(ev.pointerId); } catch (e) {}
      S.bwDrag = null;
      sendBand();
      setTimeout(function () { bwLabel(null); }, 900);
      scheduleDisplay();
    }
    sp.addEventListener("pointerup", end, true);
    sp.addEventListener("pointercancel", end, true);
  }

  /* Rate per stream type.
     These are PROTOCOL CONSTANTS: the receiver streams 12 kHz for type 2 and 48 kHz
     for the hd stream. Do NOT replace them with a measurement.
     Measured over a real 150s listen against a live receiver the arrival jitter read
     9,101 / 9,475 / 9,582 / 10,138 / 11,025 / 14,375 around a true 12,000 and the old
     code ADOPTED those numbers, so the playback rate moved 19 times in 150 seconds -
     each move an audible pitch/tempo step ("sounds like it keeps changing filters").
     The receiver's own audio never changed: tone (zcr 2862->2888) and level
     (rms 9430->9570) were flat the whole time. Fixed rates, always. */
  function rateForType(type, count) {
    var FIXED = { 2: 12000, 4: 48000, 6: 48000 };
    if (!S.rateOf) S.rateOf = { 2: 12000, 4: 48000, 6: 48000 };
    if (FIXED[type]) {
      if (S.rateOf[type] !== FIXED[type]) S.rateOf[type] = FIXED[type];   /* undo any old wobble */
      if (count) {                       /* keep a rolling measurement purely as a readout */
        if (!S.estByType) S.estByType = {};
        var em = S.estByType[type];
        var nw = performance.now();
        if (!em) S.estByType[type] = { n: count, t0: nw };
        else {
          em.n += count;
          var elm = (nw - em.t0) / 1000;
          if (elm >= 1.5) { dbg["meas" + type] = Math.round(em.n / elm); em.n = 0; em.t0 = nw; }
        }
      }
      return FIXED[type];
    }
    /* An unknown stream type: this is the only case where a measurement is allowed
       to decide, and it must repeat before it is trusted. */
    var def = 12000;
    if (S.rateOf[type] === undefined) S.rateOf[type] = def;
    if (!S.estByType) S.estByType = {};
    var e = S.estByType[type];
    var now = performance.now();
    if (!e) { S.estByType[type] = { n: count || 0, t0: now, last: 0, agree: 0 }; return S.rateOf[type]; }
    e.n += (count || 0);
    var el = (now - e.t0) / 1000;
    if (el < 2.0) return S.rateOf[type];
    var hz = e.n / el;
    dbg["meas" + type] = Math.round(hz);
    var snapped = snapRate(hz);
    /* three windows in a row that agree to within 1% before believing it */
    if (e.last && Math.abs(snapped - e.last) / Math.max(1, e.last) < 0.01) e.agree = (e.agree || 0) + 1;
    else e.agree = 0;
    e.last = snapped;
    if (e.agree >= 3 && snapped && snapped !== S.rateOf[type]) {
      S.rateOf[type] = snapped;
      S.nextPlay = 0;
      dbg["rateFix" + type] = snapped;
    }
    e.n = 0; e.t0 = now;
    return S.rateOf[type];
  }

  /* Playback is ready as soon as we are connected and have an audio context.
     There used to be a wait here for a one-shot rate measurement to finish; the
     rates are now per stream type with correct defaults (12 kHz normal / 48 kHz
     hd) and are re-measured continuously, so waiting is pointless - and the flag
     it waited on was gone, which muted EVERY mode. */
  function audioReady() {
    return !!(S.playing && S.audioCtx);
  }

  /* ----------------------------------------------------------- incoming */
  function cfgApply(c) {
    if (!c) return;
    if (c.center_freq) { S.center = +c.center_freq; if (userTuneQuiet()) S.visCenter = S.center; }
    if (c.waterfall_colors) buildLut(c.waterfall_colors);
    packLut();
    if (c.waterfall_levels && !S.wfUser) {
      if (c.waterfall_levels.min !== undefined) S.wfMin = +c.waterfall_levels.min;
      if (c.waterfall_levels.max !== undefined) S.wfMax = +c.waterfall_levels.max;
      wfShowLevels();
    }
    if (c.samp_rate) S.bw = +c.samp_rate;
    if (c.fft_size) { S.fftSize = +c.fft_size; resetWaterfall(); }
    if (c.audio_compression) S.audioComp = c.audio_compression;
    if (c.fft_compression) S.fftComp = c.fft_compression;
    if (c.initial_squelch_level !== undefined) {
      var sq = el("sdrSquelch");
      if (sq) sq.value = String(c.initial_squelch_level);
    }
    layoutCanvases();
    drawScale();
    drawMismatch();
  }

  /* Some receivers only move their centre once a client is actually listening,
     so the scale can show one band while the dial shows yours. Say so instead
     of quietly showing two different frequencies. */
  function drawMismatch() {
    if (!S.center || !S.bw || !S.connected) return;
    if (Math.abs(S.freq - S.center) > S.bw / 2) {
      status("Radio is parked on " + put((S.center - S.bw / 2) / 1e6) + "-" +
             put((S.center + S.bw / 2) / 1e6) + " MHz — choose that band in \u2630 Menu.",
             "bad");
    } else if (S.connected) {
      status("Connected.", "ok");
    }
  }

  function onJson(txt) {
    var j;
    try { j = JSON.parse(txt); } catch (e) { return; }
    if (!j || !j.type) return;

    switch (j.type) {
      case "config":
        /* the entire config object arrives under json.value, NOT at the top */
        S.gotData = true;                     /* proof this receiver really streams */
        try { var rcv = S.radios[S.pick]; if (rcv) markGood(rcv.url); } catch (e) {}
        cfgApply(j.value || j);
        break;

      case "secondary_demod":
        /* RDS / service text arrives as {type:"secondary_demod", value:{...}} */
        rdsUpdate(j.value || j);
        break;

      case "error":
        S.lastError = "Receiver said: " + (j.value || "error");
        status(S.lastError, "bad");
        break;

      case "smeter":
        /* the value is a LINEAR POWER RATIO, not dB - using it raw is why the
           meter read nonsense like "0.0 dBm" */
        if (j.value !== undefined && j.value !== null && +j.value > 0) {
          S.smeterDb = 10 * Math.log10(+j.value);
          drawSmeter();
        }
        break;

      case "modes":
        setModes(j.value);
        break;

      case "profiles":
        if (Array.isArray(j.value)) fillProfiles(j.value);
        break;

      case "receiver_details":
        if (j.value && j.value.name) {
          var b = el("sdrRcvName");
          if (b) b.textContent = j.value.name;
        }
        break;

      case "dial_frequencies":
        drawScale();
        break;
    }
  }

  /* Diagnostics + robustness. A frame whose payload is not a whole number of
     samples used to throw RangeError out of the socket handler, which silently
     killed EVERY FFT frame - the waterfall stayed blank while audio worked,
     because audio frames happen to be even-length. Trim instead of throwing. */
  var dbg = { fft: 0, audio: 0, lastLen: 0, bins: 0, err: "",
              fmin: 1e9, fmax: -1e9, measured: 0, rateFix: 0 };
  window.sdrDebug = dbg;

  function onBinary(buf) {
    try {
      var u8 = new Uint8Array(buf);
      if (u8.length < 2) return;
      var type = u8[0];
      var body = buf.slice(1);
      var n = body.byteLength;

      if (type === 1) {                        /* FFT */
        dbg.fft++; dbg.lastLen = n; S.gotData = true;
        var f, k;
        if (S.fftComp === "adpcm") {
          fftCodec.reset();
          var raw = fftCodec.decode(u8.subarray(1));
          var m = raw.length - FFT_PAD;
          if (m < 8) return;
          f = new Float32Array(m);
          for (k = 0; k < m; k++) f[k] = raw[k + FFT_PAD] / 100;   /* -> dB */
        } else {
          var n4 = n - (n % 4);
          if (n4 < 4) return;
          f = new Float32Array(body, 0, n4 / 4);
        }
        dbg.bins = f.length;
        if (!S.fftSize) S.fftSize = f.length;
      S.lastFft = f;
        for (k = 0; k < f.length; k++) {
          if (f[k] < dbg.fmin) dbg.fmin = f[k];
          if (f[k] > dbg.fmax) dbg.fmax = f[k];
        }
    queueFft(f);
      } else if (type === 2 || type === 4 || type === 6) {   /* audio */
        /* type 2 = normal audio (~12 kHz), type 4 = "hd audio", type 6 = hd stereo.
           The reference client (compiled/receiver.js: case 4/6) feeds all three
           through the SAME ImaAdpcmCodec and only changes the RESAMPLER, because
           hd audio runs at 36-48 kHz. Playing the hd stream at 12 kHz is what
           made WFM sound like slow-motion demons. */
        dbg.audio++;
        dbg.lastType = type;
        var pcm;
        if (S.audioComp === "adpcm") {
          if (type === 6) {
            var lr = audioCodec.decodeStereo(u8.subarray(1));
            var L = lr[0], R = lr[1], mm = Math.min(L.length, R.length);
            pcm = new Int16Array(mm);
            for (var q = 0; q < mm; q++) pcm[q] = ((L[q] + R[q]) / 2) | 0;   /* downmix */
            dbg.stereo = true; dbg.stereoSamples = mm;
          } else {
            pcm = audioCodec.decodeSync(u8.subarray(1));
          }
        } else {
          var n2 = n - (n % 2);
          if (n2 < 2) return;
          if (type === 6) {                       /* uncompressed stereo: deinterleave */
            var all = new Int16Array(body, 0, n2 / 2), hl = all.length >> 1;
            pcm = new Int16Array(hl);
            for (var w = 0; w < hl; w++) pcm[w] = ((all[w * 2] + all[w * 2 + 1]) / 2) | 0;
          } else {
            pcm = new Int16Array(body, 0, n2 / 2);
          }
        }
        if (!pcm.length) return;
        var rr = rateForType(type, pcm.length);
        dbg.pickRate = type + ":" + rr;         /* which rate this stream is played at */
        if (audioReady()) pushAudio(pcm, rr);
      }
    } catch (e) {
      dbg.err = String((e && e.message) || e);
    }
  }

  /* ------------------------------------------------------------- audio */
  /* Browsers and WebViews only trust an AudioContext that was created or resumed
     INSIDE a user gesture. This page used to create it in the websocket onopen
     callback, so on a slow first connect the activation had expired by then: the
     context stayed suspended and every frame was dropped - "no audio until I open
     something else first". unlockAudio() is called straight from the tap. */
  function unlockAudio() {
    try {
      if (!S.audioCtx) {
        S.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        S.nextPlay = 0;
      }
      if (S.audioCtx.state !== "running") {
        var pr = S.audioCtx.resume();
        if (pr && pr.then) pr.then(function () { audioHint(); }, function () { audioHint(); });
      }
      audioHint();
      return S.audioCtx;
    } catch (e) { return null; }
  }
  /* Show a tap-to-enable button whenever the context is not actually running, so a
     blocked context is visible instead of silent. */
  function audioHint() {
    var b = el("sdrAudioHint");
    if (!b) return;
    var bad = !S.audioCtx || S.audioCtx.state !== "running";
    b.classList.toggle("hide", !bad);
    if (bad) b.textContent = "\ud83d\udd07 Tap for audio";
  }
  function wireAudioUnlock() {
    if (S.audioUnlocked) { audioHint(); return; }
    S.audioUnlocked = true;
    /* any tap inside the SDR view unlocks, plus the explicit hint button */
    var view = document.querySelector("#sdrView") || document.body;
    var once = function () { unlockAudio(); };
    view.addEventListener("pointerdown", once, { passive: true });
    view.addEventListener("touchstart", once, { passive: true });
    view.addEventListener("click", once);
    var b = el("sdrAudioHint");
    if (b) b.onclick = function (ev) { try { ev.stopPropagation(); } catch (e) {} unlockAudio(); };
    audioHint();
  }
  function startAudio() {
    try {
      unlockAudio();                       /* no-op when already running */
      if (!S.audioCtx) return;
      S.playing = true;
      audioCodec.reset();
      S.estByType = {}; S.nextPlay = 0;
      var v = el("sdrVol");
      setGain(v ? +v.value / 100 : 0.8);
    } catch (e) {}
  }

  var gainNode = null;
  function setGain(g) {
    if (!S.audioCtx) return;
    if (!gainNode) { gainNode = S.audioCtx.createGain(); gainNode.connect(S.audioCtx.destination); }
    gainNode.gain.value = Math.max(0, Math.min(2, g));
  }

  /* Decoded PCM, scheduled back-to-back at the MEASURED stream rate. */
  function pushAudio(i16, rate) {
    if (!S.playing || !S.audioCtx || !i16.length) return;
    if (S.audioCtx.state !== "running") {      /* blocked: say so instead of silently dropping */
      dbg.blocked = (dbg.blocked || 0) + 1;
      audioHint();
      return;
    }
    var ctx = S.audioCtx;
    var n = i16.length;
    var useRate = rate || S.rate || 12000;
    var b = ctx.createBuffer(1, n, useRate);
    var ch = b.getChannelData(0);
    for (var i = 0; i < n; i++) ch[i] = (i16[i] + 0.5) / 32768;
    var src = ctx.createBufferSource();
    src.buffer = b;
    if (gainNode) src.connect(gainNode); else src.connect(ctx.destination);

    var now = ctx.currentTime;
    /* Only re-prime when the queue has genuinely run dry. The old test fired
       whenever the lead fell under 50 ms and every re-prime jumped the clock
       150 ms forward - a hole in the audio 20+ times a second. That WAS the
       chop. A 220 ms lead absorbs normal network jitter. */
    if (S.nextPlay < now) S.nextPlay = now + 0.22;
    src.start(S.nextPlay);
    dbg.pushed = (dbg.pushed || 0) + 1;        /* buffers actually scheduled to play */
    dbg.pushedSamples = (dbg.pushedSamples || 0) + n;
    /* tone + level tracking: zero-crossing rate is a cheap bandwidth proxy, so a
       mid-listen change of "filter" (tone) shows up here as a step */
    var zc = 0, sq = 0, prev = 0;
    for (var z = 0; z < n; z++) { var v2 = ch[z]; sq += v2 * v2; if ((v2 >= 0) !== (prev >= 0)) zc++; prev = v2; }
    dbg.zc = (dbg.zc || 0) + zc; dbg.zcN = (dbg.zcN || 0) + n;
    dbg.pcmPow = (dbg.pcmPow || 0) + sq; dbg.pcmN = (dbg.pcmN || 0) + n;
    S.nextPlay += b.duration;
    if (S.nextPlay - now > 1.5) S.nextPlay = now + 0.22;
  }

  /* -------------------------------------------------------- tune / mode */
  function setFreq(hz, fromUser) {
    if (!isFinite(hz) || hz < 1000 || hz > 6000000000) return;
    S.freq = Math.round(hz);
    if (fromUser) { S.visCenter = S.freq; S.userTuneAt = Date.now(); }      /* follow the finger, not the round trip */
    drawFreq();
    drawScale();
    try { updateBandLabel(); } catch (e) {}
    scheduleDisplay();
    try { localStorage.setItem("sdr_freq", S.freq); } catch (e) {}
    if (fromUser) {
      if (S.proto === "kiwi") kiwiTune();
      else send({ type: "setfrequency", params: freqParams(S.freq) });
    }
  }

  function nudge(dir) { setFreq(S.freq + dir * S.step, true); }

  /* modes are identified by the ID the receiver uses (nfm, wfm, lsb...), while
     the button shows the friendly name. */
  var RDS_MODES = { wfm: 1, nfm: 1, am: 1 };      /* demods that can carry RDS/service text */
  function dspParams() {
    /* offset_freq is where the DEMODULATOR sits inside the passband, and the
       receiver keeps its last value if you never send one. Leave it out and the
       demod can sit off to the side: the spectrum and waterfall still show the
       signal (they are drawn around the centre frequency) while the audio is
       nothing but noise. A receiver whose profile happens to hold offset 0 works
       fine, which is why this only bites on some servers. The app always
       re-centres on tune, so the demod belongs at 0. */
    var p = { mod: S.mode, offset_freq: 0 };
    if (RDS_MODES[S.mode]) p.secondary_mod = "rds";   /* ask for the station text stream */
    var bpk = bpKey(S.mode);
    if (bpk) { p.low_cut = S.modeBp[bpk].low_cut; p.high_cut = S.modeBp[bpk].high_cut; }
    else { var bd = bpFor(S.mode); if (bd) { p.low_cut = bd.lo; p.high_cut = bd.hi; } }
    return p;
  }

  /* keep the "more" dropdown showing the active mode when it lives in there */
  function setModeSel() {
    /* When the active mode is one of the "more" entries, the dropdown must SHOW it
       (selected option text) and look active, so you can see what you picked;
       back on a primary mode it falls back to the "more\u2026" placeholder. */
    var sel = el("sdrModeMore");
    if (!sel || !sel.options) return;
    var inList = false;
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === S.mode) inList = true;
    sel.value = inList ? S.mode : "";
    if (inList) sel.classList.add("on"); else sel.classList.remove("on");
  }


  function setMode(m, fromUser) {
    m = String(m || "").toLowerCase();
    if (!m) return;
    S.mode = m;
    var box = el("sdrModes");
    if (box) {
      box.querySelectorAll(".smode").forEach(function (b) {
        b.classList.toggle("on", b.dataset.m === m);
      });
    }
    setModeSel();
    try { localStorage.setItem("sdr_mode", m); } catch (e) {}
    if (fromUser) {
      if (S.proto === "kiwi") { kiwiTune(); }
      else send({ type: "dspcontrol", params: dspParams() });
    }
  }

  function setModes(list) {
    var box = el("sdrModes");
    if (!box) return;
    var norm = [];
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (typeof x === "string") {
        norm.push({ id: x.toLowerCase(), name: x.toUpperCase(), bp: null });
      } else if (x && (x.modulation || x.mod)) {
        /* only the plain analog modes drive cleanly from here; the digital
           ones need a secondary demodulator and are left off for now */
        if (x.type && x.type !== "analog") return;
        var id = String(x.modulation || x.mod).toLowerCase();
        norm.push({ id: id, name: String(x.name || id).toUpperCase(), bp: x.bandpass || null });
      }
    });
    if (!norm.length) norm = FALLBACK_MODES.map(function (p) { return { id: p[1], name: p[0], bp: null }; });

    S.modeBp = {};
    norm.forEach(function (m) { if (m.bp) S.modeBp[m.id] = m.bp; });

    var prim = [], more = [];
    norm.forEach(function (m) { (PRIMARY_MODES.indexOf(m.id) >= 0 ? prim : more).push(m); });
    function ord(m) {                     /* \"|| 9\" would turn AM's 0 into 9 */
      var v = PRIMARY_ORDER[m.id];
      return v === undefined ? 9 : v;
    }
    prim.sort(function (a, b) {
      var d = ord(a) - ord(b);
      return d || a.name.localeCompare(b.name);
    });

    var h = prim.map(function (m) {
      return '<button type="button" class="smode' + (m.id === S.mode ? " on" : "") +
             '" data-m="' + m.id + '">' + m.name + "</button>";
    }).join("");
    if (more.length) {
      h += '<select id="sdrModeMore" class="sdr-more" title="more modes">' +
           '<option value="">more\u2026</option>' +
           more.map(function (m) {
             return '<option value="' + m.id + '"' + (m.id === S.mode ? " selected" : "") +
                    ">" + m.name + "</option>";
           }).join("") + "</select>";
    }
    try { dbg("modes -> buttons: " + prim.map(function (m) { return m.id; }).join(",") +
              " | dropdown: " + more.map(function (m) { return m.id; }).join(",")); } catch (e) {}
    box.innerHTML = h;
    box.querySelectorAll(".smode").forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.m, true); };
    });
    /* the dropdown drives the modes that are not buttons. Scoped to the box so it
       cannot depend on an id lookup. */
    var sel = box.querySelector(".sdr-more");
    if (sel) {
      sel.onchange = function () {
        /* Do NOT reset to the placeholder here: setModeSel() owns the dropdown
           state, so a mode picked from here stays visible (and highlighted) until
           a primary mode is chosen instead. Resetting it was why the control
           always read "more…" no matter what you selected. */
        if (this.value) setMode(this.value, true);
      };
    }
    setModeSel();
  }

  function fillProfiles(list) {
    var sel = el("sdrProfiles");
    if (!sel) return;
    sel.innerHTML = '<option value="">— band / profile —</option>' + list.map(function (p) {
      var id = p.id || p.profile || p.name || "";
      var nm = p.name || id;
      return '<option value="' + id + '">' + nm + "</option>";
    }).join("");
    sel.onchange = function () {
      if (!sel.value) return;
      send({ type: "selectprofile", params: { profile: sel.value } });
      status("Switching to " + sel.value + " …");
    };
  }

  function setConnBtn(on) {
    var b = el("sdrConnBtn");
    if (b) {
      /* it behaves as the radio's power switch, so it is labelled that way regardless
         of state; the state reads from the colour (green = off, red = on) and the
         status line, not from a second label. */
      b.textContent = "Power";
      b.classList.toggle("on", !!on);
      b.setAttribute("title", on ? "power off" : "power on");
    }
    var d = el("sdrDot");
    if (d) d.classList.toggle("live", !!on);
  }

  /* ===================================================================
     DISPLAY  —  big frequency, mode row, spectrum, waterfall, S-meter
     =================================================================== */

  /* Per-digit frequency readout. Each digit is its own span carrying its weight
     (`data-step`), which is what lets the mouse wheel over the readout change the
     MHz / kHz / Hz digit the pointer is actually on. Rebuilt only when the text
     changes, and listeners live on the container so they survive a rebuild. */
  function freqDigits() {
    var f = el("sdrFreq");
    if (!f) return;
    var s = pad3(S.freq);
    if (S.freqStr === s && f.firstChild) return;
    S.freqStr = s;
    f.textContent = "";
    var right = s.length - 1 - s.indexOf(".");     /* digits right of the point */
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) === ".") { f.appendChild(document.createTextNode(".")); right--; continue; }
      var k = 0;                                    /* digits to the right of this one */
      for (var j = i + 1; j < s.length; j++) if (s.charAt(j) !== ".") k++;
      var sp = document.createElement("span");
      sp.textContent = s.charAt(i);
      sp.className = "sdr-dig";
      sp.setAttribute("data-k", String(k));
      /* rightmost digit follows the tuning step when it is finer than 1 kHz */
      var hz = Math.pow(10, 3 + k);
      if (k === 0 && S.step && S.step < 1000) hz = S.step;
      sp.setAttribute("data-step", String(hz));
      f.appendChild(sp);
    }
  }

  function freqDigitWheel(ev) {
    var sp = ev.target && ev.target.dataset ? ev.target : null;
    if (!sp || sp.dataset.step === undefined) return;
    var step = +sp.dataset.step;
    if (!step) return;
    try { ev.preventDefault(); } catch (e) {}
    var dir = ev.deltaY < 0 ? 1 : -1;
    var hz = S.freq + dir * step;
    if (hz < 10000) hz = 10000;
    setFreq(hz, true);
    S.tuneAt = 0.5;
    try { dbg("wheel " + (dir > 0 ? "+" : "-") + (step >= 1000 ? (step / 1000) + " kHz" : step + " Hz")); } catch (e) {}
  }
  function wireFreqDigits() {
    var f = el("sdrFreq");
    if (!f || f.dataset.wheeled) { if (f) freqDigits(); return; }
    f.dataset.wheeled = "1";
    f.addEventListener("wheel", freqDigitWheel, { passive: false });
    /* show which digit the wheel will move */
    f.addEventListener("mouseover", function (ev) { ev.target.classList.add("hot"); });
    f.addEventListener("mouseout", function (ev) { ev.target.classList.remove("hot"); });
    var st = document.getElementById("sdrDigStyle");
    if (!st) {
      st = document.createElement("style");
      st.id = "sdrDigStyle";
      st.textContent = "#sdrScaleL,#sdrScaleR{font-size:12.5px;font-weight:600;color:#cfd8e3}" +
                       ".sdr-scale .sdr-axis{font-size:11px}" +
                       ".sdr-dig{display:inline-block;padding:0 1px;border-radius:3px;cursor:ns-resize}" +
                       ".sdr-dig.hot{background:rgba(255,43,43,.30);color:#fff}" +
                       "#sdrFreq{user-select:none}";
      document.head.appendChild(st);
    }
    freqDigits();
  }

  function drawFreq() {
    var f = el("sdrFreq");
    if (f) freqDigits();
    try { favBadge(); } catch (e) {}
    var b = el("sdrBand");
    if (b) b.textContent = bandName(S.freq);
    var st = el("sdrStepLbl");
    if (st) st.textContent = STEP_LBL[S.step] || (S.step + " Hz");
    var u = el("sdrFreqUnit");
    if (u) u.textContent = "MHz";
  }

  function drawScale() {
    var l = el("sdrScaleL"), r = el("sdrScaleR");
    if (!l || !r) return;
    if (!S.center || !S.bw) { l.textContent = "—"; r.textContent = "—"; return; }
    var half = visSpan() / 2;
    l.textContent = ((S.center - half) / 1e6).toFixed(3);
    r.textContent = ((S.center + half) / 1e6).toFixed(3);
    var sp = el("sdrSpanLbl");
    if (sp && S.bw) sp.textContent = (visSpan() / 1000).toFixed(visSpan() < 10000 ? 1 : 0) + " kHz";
  }


  /* ============================================== tuning: tap = jump, slide = fine
     The visible span is S.center +/- visSpan()/2 - the same numbers the scale
     labels show - so any x maps straight to a frequency.

       tap   (press and release without moving): jump to that spot
       slide (press and drag left/right): fine tune, dial-style - sliding right
              raises the frequency. The jump only happens on release as a tap, so
              starting a slide no longer yanks the frequency first.
       pinch (two fingers): zoom the display in/out.

     Tuning re-centres the receiver (this client demodulates at the centre of the
     span), which is why the signal stays in the middle while you slide. */
  /* The centre the DISPLAY is drawn at. Everything used to be drawn against the
     receiver's reported centre, so while a tune was in flight the trace, the ruler
     and the new waterfall rows all stayed put until the receiver answered - the
     spectrum visibly lagged the finger and then raced to catch up. Drawing against
     the DIAL makes the whole display follow the finger instantly; when the receiver
     confirms, its centre equals the dial and the shift goes to zero by itself, so
     there is no jump back. */
  /* has the user stopped moving the dial for long enough that the receiver's own centre
     can take over the display again? */
  function userTuneQuiet() { return !(S.bwDrag || tuneDrag.on) && (Date.now() - (S.userTuneAt || 0) > 700); }
  function visCenterHz() {
    return (S.visCenter === null || S.visCenter === undefined) ? (S.center || S.freq) : S.visCenter;
  }
  /* pixel shift that maps a bin drawn around S.center onto the visible centre */
  function centreShiftPx(W) {
    if (!S.center) return 0;
    var span = visSpan();
    if (!span) return 0;
    var px = ((S.center - visCenterHz()) / span) * W;
    if (!isFinite(px)) return 0;
    return px < -W ? -W : (px > W ? W : px);
  }
  function visSpan() {
    if (!S.bw) return 0;
    return S.bw / (S.zoom > 1 ? S.zoom : 1);
  }
  var ZOOM_STEPS = [1, 2, 4, 8, 16];
  function setZoom(z, quiet) {
    z = +z || 1;
    if (z < ZOOM_STEPS[0]) z = ZOOM_STEPS[0];
    if (z > ZOOM_STEPS[ZOOM_STEPS.length - 1]) z = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    S.zoom = z;
    try { localStorage.setItem("sdr_zoom", String(z)); } catch (e) {}
    var rd = el("sdrZoomVal");
    if (rd) rd.textContent = "\u00d7" + (z < 1 ? 1 : z);
    drawScale();
    if (!quiet) redrawLast();
  }
  function zoomNudge(dir) {
    var i = ZOOM_STEPS.indexOf(S.zoom);
    if (i < 0) i = 0;
    setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))]);
  }
  /* keep the newest FFT frame so a zoom/scale change redraws instantly instead of
     waiting for the next one (which looks like the control did nothing) */
  function redrawLast() {
    if (!S.lastFft) return;
    try { drawSpectrum(S.lastFft); } catch (e) {}
    try { drawWaterfall(S.lastFft, true); } catch (e) {}
  }

  function tuneFromX(cv, clientX) {
    if (!S.center || !S.bw || !cv) return null;
    var r = cv.getBoundingClientRect();
    if (!r.width) return null;
    var frac = (clientX - r.left) / r.width;
    frac = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
    var hz = visCenterHz() + (frac - 0.5) * visSpan();
    if (S.step) hz = Math.round(hz / S.step) * S.step;      /* land on the step grid */
    return { hz: Math.round(hz), frac: frac };
  }

  var tuneDrag = { on: false, last: 0 };
  var pinch = null, pointers = {};
  function wireTuneCanvas(cv) {
    if (!cv || cv.dataset.tuned) return;
    cv.dataset.tuned = "1";
    cv.style.cursor = "crosshair";
    cv.style.touchAction = "none";        /* let us own the gestures */

    function down(ev) {
      pointers[ev.pointerId] = ev.clientX;
      try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
      try { ev.preventDefault(); } catch (e) {}
      var ids = Object.keys(pointers);
      if (ids.length === 2) {             /* two fingers = zoom, not tuning */
        pinch = { d0: Math.abs(pointers[ids[0]] - pointers[ids[1]]), z0: S.zoom || 1 };
        tuneDrag.on = false;
        return;
      }
      var r = cv.getBoundingClientRect();
      /* a zero-width canvas (panel hidden mid-layout) divides by zero and would
         compute a nonsense frequency - refuse the gesture instead */
      if (!(r.width > 8)) { tuneDrag = { on: false, last: 0 }; return; }
      tuneDrag = { on: true, last: 0, x0: ev.clientX, f0: S.freq, w: r.width, moved: false };
    }

    function move(ev) {
      if (pointers[ev.pointerId] !== undefined) pointers[ev.pointerId] = ev.clientX;
      var ids = Object.keys(pointers);
      if (ids.length >= 2 && pinch) {     /* pinch: scale the zoom by the spread */
        var d = Math.abs(pointers[ids[0]] - pointers[ids[1]]);
        if (pinch.d0 > 8) {
          var z = pinch.z0 * (d / pinch.d0);
          var snapped = ZOOM_STEPS[ZOO()];
          function ZOO() {                 /* nearest tabulated zoom */
            var best = 0;
            for (var i = 1; i < ZOOM_STEPS.length; i++)
              if (Math.abs(ZOOM_STEPS[i] - z) < Math.abs(ZOOM_STEPS[best] - z)) best = i;
            return best;
          }
          if (snapped !== S.zoom) setZoom(snapped);
        }
        try { ev.preventDefault(); } catch (e) {}
        return;
      }
      if (!tuneDrag.on) return;
      var dx = ev.clientX - tuneDrag.x0;
      if (!tuneDrag.moved && Math.abs(dx) < 6) return;      /* still a tap */
      tuneDrag.moved = true;
      var span = visSpan() || 1;
      /* grab-and-pull: dragging right moves the band right, i.e. LOWERS the dial */
      var hz = tuneDrag.f0 - (dx / (tuneDrag.w || 1)) * span;
      if (!isFinite(hz) || hz < 1000 || hz > 6000000000) return;   /* never tune to garbage */
      if (S.step) hz = Math.round(hz / S.step) * S.step;
      S.tuneAt = 0.5;
      /* Update the display on EVERY move so the spectrum tracks the finger; only
         the message to the radio is throttled. Throttling the display itself was
         what made the slide feel like it lagged behind the waterfall. */
      var due = (Date.now() - tuneDrag.last >= 120);
      if (due) tuneDrag.last = Date.now();
      S.visCenter = Math.round(hz);      /* the display follows EVERY move */
      S.userTuneAt = Date.now();
      setFreq(hz, due);                  /* only the radio message is throttled */
      scheduleDisplay();
      try { dbg("slide " + (hz / 1e6).toFixed(4) + " MHz"); } catch (e) {}
      try { ev.preventDefault(); } catch (e) {}
    }

    function up(ev, fromLeave) {
      if (pointers[ev.pointerId] !== undefined) delete pointers[ev.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (!tuneDrag.on) return;
      /* a slide that wanders off the canvas is a cancel, not a tap - otherwise
         releasing outside the waterfall jumps the frequency */
      var wasTap = !tuneDrag.moved && !fromLeave;
      tuneDrag.on = false;
      if (wasTap) {                        /* a tap still jumps to that spot */
        var fav = favHitTest(cv, ev.clientX);      /* ...unless it is on a saved station */
        if (fav) {
          setMode(fav.mode || S.mode, true);
          setFreq(fav.hz, true);
          S.tuneAt = 0.5;
          try { dbg("favourite " + fav.name + " " + fmtShort(fav.hz)); } catch (e2) {}
          return;
        }
        var t = tuneFromX(cv, ev.clientX);
        if (t) {
          S.tuneAt = 0.5;
          setFreq(t.hz, true);
          try { dbg("tap " + (t.hz / 1e6).toFixed(4) + " MHz"); } catch (e) {}
        }
      }
      setTimeout(function () { if (!tuneDrag.on) S.tuneAt = null; }, 1200);
    }

    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", function (ev) { up(ev, false); });
    cv.addEventListener("pointercancel", function (ev) { up(ev, true); });
    cv.addEventListener("pointerleave", function (ev) { up(ev, true); });
    cv.addEventListener("wheel", function (ev) {              /* desktop: wheel = zoom */
      try { ev.preventDefault(); } catch (e) {}
      zoomNudge(ev.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }
  function wireTune() {
    wireTuneCanvas(el("sdrWater"));
    wireTuneCanvas(el("sdrSpectrum"));
    wireZoomUI();
    wireWfUI();
    wireRds();
    wireFavs();
    wireAudioHintUI();
    try { setConnBtn(!!S.connected); } catch (e) {}   /* "Power" from the first paint */
    buildSmeterScale();
    wireBand();
    buildBandPicker();
    moveMenuButton();
    setTimeout(buildSmeterScale, 400);
    wireAudioUnlock();
    wireFit();
  }

  /* zoom buttons, injected next to the scale so no markup has to change */
  function wireZoomUI() {
    if (el("sdrZoomRow")) { setZoom(S.zoom, true); return; }
    var scale = null;
    ["sdrScaleR", "sdrScaleL"].some(function (id) {
      var e2 = el(id);
      if (e2 && e2.parentNode) { scale = e2.parentNode; return true; }
      return false;
    });
    if (!scale) return;
    var row = document.createElement("div");
    row.id = "sdrZoomRow";
    row.setAttribute("style", "display:flex;align-items:center;gap:6px;margin:2px 0 4px;" +
                              "justify-content:center;font-size:11px;color:#8b98a8;");
    row.innerHTML = '<button type="button" class="mini" id="sdrZoomOut" title="zoom out">\u2212</button>' +
                    '<span id="sdrSpanLbl" style="min-width:62px;text-align:center;color:#8b98a8">span</span>' +
                    '<span id="sdrZoomVal" style="min-width:28px;text-align:center;color:#00e5ff;font-weight:700">\u00d71</span>' +
                    '<button type="button" class="mini" id="sdrZoomIn" title="zoom in">+</button>' +
                    '<button type="button" class="mini" id="sdrZoomRst" title="zoom out fully">\u27f2</button>' +
                    '<span style="opacity:.75">tap = jump &middot; slide = fine tune</span>';
    scale.parentNode.insertBefore(row, scale.nextSibling);
    var zo = el("sdrZoomOut"), zi = el("sdrZoomIn"), zr = el("sdrZoomRst");
    if (zo) zo.onclick = function () { zoomNudge(-1); };
    if (zi) zi.onclick = function () { zoomNudge(1); };
    if (zr) zr.onclick = function () { setZoom(1); };
    setZoom(S.zoom, true);
  }

  /* ============================================== waterfall level / colour controls
     Injected into the menu sheet at runtime so no markup has to change. The window
     is shared by the spectrum and the waterfall (same dB scale). */
  function wfShowLevels() {
    var rd = el("sdrWfVal");
    if (rd) rd.textContent = Math.round(S.wfMin) + " \u2192 " + Math.round(S.wfMax) + " dB";
  }
  function wfSet(min, max, byUser) {
    if (min !== undefined && min !== null) S.wfMin = +min;
    if (max !== undefined && max !== null) S.wfMax = +max;
    if (S.wfMax - S.wfMin < 6) S.wfMax = S.wfMin + 6;      /* never collapse the window */
    if (byUser) S.wfUser = true;
    try {
      localStorage.setItem("sdr_wfmin", String(S.wfMin));
      localStorage.setItem("sdr_wfmax", String(S.wfMax));
      localStorage.setItem("sdr_wfuser", S.wfUser ? "1" : "0");
    } catch (e) {}
    var a = el("sdrWfMin"), b = el("sdrWfMax");
    if (a) a.value = String(Math.round(S.wfMin));
    if (b) b.value = String(Math.round(S.wfMax));
    wfShowLevels();
    redrawLast();
  }
  /* fit the window to what is actually arriving (5th-95th percentile of the frame) */
  function wfAuto() {
    var f = S.lastFft;
    if (!f || !f.length) { status("Auto needs a live signal first."); return; }
    var arr = [];
    for (var i = 0; i < f.length; i++) if (isFinite(f[i])) arr.push(f[i]);
    if (arr.length < 8) { status("Auto needs a live signal first."); return; }
    arr.sort(function (a2, b2) { return a2 - b2; });
    var clamp = function (v) { return v < -150 ? -150 : (v > 0 ? 0 : v); };
    var lo = clamp(arr[Math.floor(arr.length * 0.05)] - 3);
    var hi = clamp(arr[Math.floor(arr.length * 0.95)] + 6);
    if (hi - lo < 10) hi = lo + 10;                 /* keep the window usable */
    wfSet(lo, hi, true);
  }
  function wireWfUI() {
    if (el("sdrWfRow")) { wfShowLevels(); return; }
    var sheet = el("sdrSheet");
    if (!sheet) return;
    var host = document.createElement("div");
    host.id = "sdrWfRow";
    host.innerHTML = '<div class="sdr-row"><label>Waterfall floor</label>' +
                     '<input id="sdrWfMin" type="range" min="-140" max="-40" value="-88"></div>' +
                     '<div class="sdr-row"><label>Waterfall top</label>' +
                     '<input id="sdrWfMax" type="range" min="-80" max="0" value="-20"></div>' +
                     '<div class="sdr-row"><label id="sdrWfVal" style="font-weight:600;color:#00e5ff">\u2014</label>' +
                     '<span style="display:flex;gap:6px">' +
                     '<button type="button" class="mini" id="sdrWfAuto">Auto</button>' +
                     '<button type="button" class="mini" id="sdrWfRst">Reset</button></span></div>';
    var bands = el("sdrBands");
    if (bands && bands.parentNode === sheet) sheet.insertBefore(host, bands);
    else sheet.appendChild(host);
    var a = el("sdrWfMin"), b = el("sdrWfMax");
    if (a) a.oninput = function () { wfSet(a.value, undefined, true); };
    if (b) b.oninput = function () { wfSet(undefined, b.value, true); };
    var au = el("sdrWfAuto"); if (au) au.onclick = wfAuto;
    var rs = el("sdrWfRst"); if (rs) rs.onclick = function () { S.wfUser = false; wfSet(-88, -20, false); };
    wfSet(S.wfMin, S.wfMax, S.wfUser);
  }

  /* ============================================== BAND PICKER (inside the spectrum box)
     A small drop-down in the spectrum's top-left corner that jumps straight to a band.
     It reuses the app's own BANDS table and bandName() helper - no second list to
     keep in sync. Short labels ("11m"), no descriptions, exactly like the reference. */
  function shortBand(hz) {
    var n = "";
    try { n = bandName(hz) || ""; } catch (e) { n = ""; }
    if (!n) return "band";
    var m = n.match(/(\d+\s*m|\d+\s*cm)/i);
    return m ? m[1].replace(/\s+/g, "") : n;
  }
  function bandPickerHost() {
    var sp = el("sdrSpectrum");
    if (!sp || !sp.parentNode) return null;
    var wrap = el("sdrSpecWrap");
    if (!wrap) {                                  /* wrap the canvas so we can sit on top of it */
      wrap = document.createElement("div");
      wrap.id = "sdrSpecWrap";
      wrap.setAttribute("style", "position:relative;width:100%;line-height:0");
      sp.parentNode.insertBefore(wrap, sp);
      wrap.appendChild(sp);
    }
    return wrap;
  }
  function buildBandPicker() {
    var wrap = bandPickerHost();
    if (!wrap || el("sdrBandBtn")) return;
    var btn = document.createElement("button");
    btn.id = "sdrBandBtn";
    btn.type = "button";
    btn.setAttribute("style", "position:absolute;left:6px;top:4px;z-index:5;margin:0;" +
      "padding:1px 7px;border:1px solid #2ee6d6;border-radius:4px;background:rgba(8,38,45,.92);" +
      "color:#7ff5ea;font:600 11px/1.5 monospace;cursor:pointer;line-height:1.5");
    btn.textContent = shortBand(S.freq);
    btn.title = "switch band";
    var list = document.createElement("div");
    list.id = "sdrBandList";
    list.setAttribute("style", "position:absolute;left:6px;top:24px;z-index:6;display:none;" +
      "background:rgba(6,18,24,.97);border:1px solid #2ee6d6;border-radius:6px;padding:4px;" +
      "max-height:180px;overflow:auto;box-shadow:0 6px 18px rgba(0,0,0,.5)");
    BANDS.forEach(function (b) {
      var it = document.createElement("button");
      it.type = "button";
      it.setAttribute("style", "display:block;width:100%;margin:1px 0;padding:2px 10px;text-align:left;" +
        "border:0;border-radius:4px;background:transparent;color:#cfe9ee;font:600 11px/1.6 monospace;" +
        "cursor:pointer");
      it.textContent = b[0];
      it.dataset.hz = String(b[1]);
      it.onclick = function (ev) {
        try { ev.stopPropagation(); } catch (e) {}
        var f = +it.dataset.hz;
        if (isFinite(f)) {
          S.visCenter = f;                 /* the display follows the band immediately */
          S.userTuneAt = Date.now();
          setFreq(f, true);
          scheduleDisplay();
        }
        list.style.display = "none";
        dbg.bandPick = { chose: it.textContent, hz: f };
      };
      list.appendChild(it);
    });
    function closeList() { list.style.display = "none"; }
    function openList() { list.style.display = "block"; dbg.bandListOpen = true; }
    /* the button must never start a tune drag on the spectrum underneath */
    btn.addEventListener("pointerdown", function (ev) {
      ev.stopPropagation(); ev.preventDefault();
    }, true);
    btn.onclick = function (ev) {
      try { ev.stopPropagation(); } catch (e) {}
      if (list.style.display === "block") closeList(); else openList();
    };
    list.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); }, true);
    /* a capture-phase document handler runs BEFORE the list's own handler, so without
       this test it closed the list on the very tap that was choosing a band */
    document.addEventListener("pointerdown", function (ev) {
      if (btn.contains(ev.target) || list.contains(ev.target)) return;
      closeList();
    }, true);
    wrap.appendChild(btn);
    wrap.appendChild(list);
    dbg.bandPicker = { bands: BANDS.length, label: btn.textContent };
  }
  function updateBandLabel() {
    var b = el("sdrBandBtn");
    if (b) { b.textContent = shortBand(S.freq); dbg.bandPicker = { bands: BANDS.length, label: b.textContent }; }
  }

  /* ============================================== frequency ruler
     Ticks + labels across the visible span, so you can read where a signal is
     instead of only seeing the two end values in the corners. */
  function niceStepFor(spanHz, want) {
    var raw = spanHz / Math.max(1, want);
    var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var cands = [1 * pow, 2 * pow, 5 * pow, 10 * pow];
    for (var i = 0; i < cands.length; i++) if (cands[i] >= raw) return cands[i];
    return cands[cands.length - 1];
  }
  /* ============================================== frequency favourites
     Save whatever station you are listening to, keep it marked on the spectrum and
     waterfall, and tap the marker to jump back. Device-local; a separate key from
     the app's own station favourites (wr_favs) so the two never collide. */
  var FAV_KEY = "sdr_favs";
  function favList() {
    try {
      var a = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function favStore(l) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(l.slice(0, 60))); } catch (e) {}
    favBadge();
    redrawLast();
  }
  function favFind(hz, mode) {
    var l = favList(), m = String(mode || S.mode).toLowerCase();   /* modes must compare case-insensitively */
    for (var i = 0; i < l.length; i++)
      if (Math.abs(l[i].hz - hz) < 500 && String(l[i].mode || "").toLowerCase() === m) return { i: i, f: l[i] };
    return null;
  }
  function favAdd(hz, name, mode) {
    var l = favList(), m = String(mode || S.mode).toLowerCase();
    var hit = favFind(hz, m);
    if (hit) { if (name) hit.f.name = name; }
    else l.push({ hz: Math.round(hz), name: name || fmtShort(hz), mode: m, t: Date.now() });
    favStore(l);
  }
  function favRemove(hz, mode) {
    var hit = favFind(hz, mode);
    if (hit) { var l = favList(); l.splice(hit.i, 1); favStore(l); }
  }
  function favBadge() { try { buildFavStar(); favStarSync(); } catch (e) {}
    var l = favList(), here = favFind(S.freq, S.mode);
    var b = el("sdrFavBtn"), o = el("sdrFavOpen");
    if (b) {
      b.textContent = here ? "\u2605 Saved" : "\u2606 Save";
      b.classList.toggle("on", !!here);
    }
    if (o) {
      o.textContent = "\u2605 " + l.length;
      o.classList.toggle("on", l.length > 0);
    }
  }
  /* markers: a gold line at each saved frequency, named on the spectrum */
  function favX(hz, W) {
    var span = visSpan();
    /* map from the VISIBLE centre (not S.center): the trace follows the finger, so a marker
       pinned to the receiver's centre visibly chased the drag and then snapped forward */
    var c = visCenterHz();
    if (!span || !c) return null;
    var lo = c - span / 2;
    if (hz < lo || hz > lo + span) return null;
    return ((hz - lo) / span) * W;
  }
  function drawFavs(g, W, H, named) {
    var l = favList();
    if (!l.length || !g) return;
    g.save();
    g.font = "700 10px ui-monospace, Menlo, Consolas, monospace";
    g.textAlign = "left";
    g.textBaseline = "top";
    for (var i = 0; i < l.length; i++) {
      var x = favX(l[i].hz, W);
      if (x === null || x < 3 || x > W - 3) continue;
      g.strokeStyle = "#ffd166";
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
      if (named) {
        var lbl = "\u2605 " + String(l[i].name || "").slice(0, 14);
        var tw = g.measureText(lbl).width;
        var bx = Math.max(2, Math.min(W - tw - 4, x + 3));
        g.fillStyle = "rgba(0,0,0,.6)";
        g.fillRect(bx - 1, 1, tw + 4, 11);
        g.fillStyle = "#ffd166";
        g.fillText(lbl, bx + 1, 1.5);
      } else {
        g.fillStyle = "#ffd166";
        g.fillRect(x - 2, 0, 5, 3);
      }
    }
    g.restore();
  }
  /* tapping near a marker beats the normal tune-to-tap */
  function favHitTest(cv, clientX) {
    var l = favList();
    if (!l.length) return null;
    var r = cv.getBoundingClientRect();
    if (!r.width) return null;
    var best = null, bd = 15;
    for (var i = 0; i < l.length; i++) {
      var x = favX(l[i].hz, r.width);
      if (x === null) continue;
      var d = Math.abs(x - (clientX - r.left));
      if (d < bd) { bd = d; best = l[i]; }
    }
    return best;
  }
  function favRender() {
    var box = el("sdrFavList");
    if (!box) return;
    var l = favList();
    /* materialise the default bank on favourites that never had one, so renaming that bank
       carries them with it (otherwise they silently follow "whatever bank is first") */
    var _mig = false;
    l.forEach(function (f) { if (!f.grp) { f.grp = favGroupName(f); _mig = true; } });
    if (_mig) favStore(l);
    var body = el("sdrFavBody");
    if (!body) {
      box.innerHTML = '<div class="fav-head"></div><div id="sdrFavBody"></div>';
      body = el("sdrFavBody");
    }
    var head = box.querySelector(".fav-head");
    if (head) {
      var scanN = l.filter(function (x) { return x.scan !== false; }).length;
      head.innerHTML = '<b>\u2605 Favourites</b><small>' + l.length + ' saved \u00b7 ' + scanN + ' scanning</small>' +
        '<button type="button" class="mini" id="sdrFavAll">ALL</button>' +
        '<button type="button" class="mini" id="sdrFavNone">NONE</button>' +
        '<button type="button" class="mini" id="sdrFavClose2">\u2715</button>';
      var ba = el("sdrFavAll"), bn = el("sdrFavNone"), bc = el("sdrFavClose2");
      if (ba) ba.onclick = function (ev) { ev.stopPropagation(); favAll(true); };
      if (bn) bn.onclick = function (ev) { ev.stopPropagation(); favAll(false); };
      if (bc) bc.onclick = function (ev) { ev.stopPropagation(); favClose(); };
    }
    if (!l.length) body.innerHTML = '<div class="fav-empty">No saved stations yet. Tune something and tap \u2606 star beside the frequency.</div>';
    else body.innerHTML = l.slice().sort(function (a, b) { return a.hz - b.hz; }).map(function (f, i) {
      return '<div class="fav-row" data-hz="' + f.hz + '" data-mode="' + (f.mode || "") + '">' +
             '<span class="fav-name">\u2605 ' + String(f.name || "").replace(/</g, "&lt;") + '</span>' +
             '<span class="fav-freq">' + fmtShort(f.hz) + " " + String(f.mode || "").toUpperCase() + '</span>' +
             '<button type="button" class="fav-check' + ((f.scan === false) ? "" : " on") + '" ' +
                    'data-hz="' + f.hz + '" data-mode="' + String(f.mode || "") + '" ' +
                    'title="tick to include in the scanner">' + ((f.scan === false) ? "\u2610" : "\u2611") + '</button>' +
             '<button type="button" class="fav-edit" data-hz="' + f.hz + '" data-mode="' + String(f.mode || "") + '" title="rename">\u270e</button>' +
             '<button type="button" class="fav-grp" data-hz="' + f.hz + '" data-mode="' + String(f.mode || "") + '" title="bank">' + favGroupName(f).replace(/</g, "&lt;") + '</button>' +
             '<button type="button" class="mini fav-x" data-hz="' + f.hz + '" data-mode="' + String(f.mode || "") + '">\u2715</button></div>';
    }).join("");
    try { fitFavList(); } catch (e) {}
    box.querySelectorAll(".fav-row").forEach(function (row) {
      row.onclick = function (ev) {
        if (ev.target.classList.contains("fav-x") || ev.target.classList.contains("fav-check") ||
            ev.target.classList.contains("fav-edit") || ev.target.classList.contains("fav-grp")) return;
        setMode(row.dataset.mode || S.mode, true);
        setFreq(+row.dataset.hz, true);
        favClose();
      };
    });
    box.querySelectorAll(".fav-edit").forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var hit = favFind(+b.dataset.hz, b.dataset.mode);
        if (!hit) return;
        var cur = (favList()[hit.i] || {}).name || fmtShort(hit.f.hz);
        var n = window.prompt("Name for " + fmtShort(hit.f.hz) + " " + String(hit.f.mode || "").toUpperCase(), cur);
        if (n === null) return;
        renameFav(+b.dataset.hz, b.dataset.mode, n);
      };
    });
    box.querySelectorAll(".fav-grp").forEach(function (b) {
      b.onclick = function (ev) { ev.stopPropagation(); grpSheetOpen("assign", +b.dataset.hz, b.dataset.mode); };
    });
    box.querySelectorAll(".fav-check").forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var l2 = favList();
        var hit = favFind(+b.dataset.hz, b.dataset.mode);   /* match by freq+mode, never by index */
        if (!hit) return;
        l2[hit.i].scan = (l2[hit.i].scan === false);        /* toggle: missing means "scan" */
        favStore(l2);
        var was = SCAN.on;
        if (was) scanStop();
        favRender();
        if (was) scanStart();
      };
    });
    box.querySelectorAll(".fav-x").forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        /* identify the favourite by FREQUENCY+mode. The rows are displayed sorted by frequency, so
           a list index points at a DIFFERENT favourite than the row tapped - which is why deleting
           asked for confirmation, said yes, and then appeared to do nothing (splice at NaN). */
        var hit = favFind(+b.dataset.hz, b.dataset.mode);
        if (!hit) return;
        var l2 = favList();
        var name = (l2[hit.i] || {}).name || fmtShort(+b.dataset.hz);
        if (window.confirm("Delete " + name + " from favourites?")) {
          l2.splice(hit.i, 1);
          favStore(l2);
          var was = SCAN.on; if (was) scanStop();
          favRender();
          if (was) scanStart();
        }
      };
    });
  }
  function favAll(on) {
    var l = favList();
    l.forEach(function (f) { if (on) delete f.scan; else f.scan = false; });
    favStore(l);
    var was = SCAN.on; if (was) scanStop();
    favRender();
    if (was) scanStart();
  }
  function favOpen() {
    var box = el("sdrFavList");
    if (!box) return;
    favRender();
    box.classList.toggle("hide");
    try { fitFavList(); } catch (e) {}
  }
  function favClose() { var b = el("sdrFavList"); if (b) b.classList.add("hide"); }
  function favSaveRow(show) {
    var row = el("sdrFavRow");
    if (!row) return;
    if (!show) { row.classList.add("hide"); return; }
    var inp = el("sdrFavName");
    if (inp) {
      var hint = (S.rds && S.rds.ps ? S.rds.ps + " " : "") + fmtShort(S.freq) + " " + String(S.mode).toUpperCase();
      inp.value = hint;
    }
    row.classList.remove("hide");
    if (inp) { try { inp.focus(); inp.select(); } catch (e) {} }
  }
  /* ================================================= fit the page to the screen
     #sdrView is a flex column that scrolls internally and whose children never
     shrink (`#sdrView > *{flex:0 0 auto}`), so it ALWAYS scrolled. The two canvases
     now absorb whatever height is left after the fixed rows, so frequency, modes,
     spectrum, waterfall, S-meter and status are all on screen at once - and nobody
     has to reach past the waterfall to scroll, which is how people re-tune by accident. */
  function sdrSpace() {
    var view = document.querySelector("#sdrView");
    if (!view) return null;
    var r = view.getBoundingClientRect();
    var cs = getComputedStyle(view);
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var room = (r.height > 150) ? r.height : ((window.innerHeight || 600) - r.top);
    return room - pad - 2;      /* the panel's own height is the area we must fill */
  }
  /* How tall is the app's own top bar on THIS device? The panel used a hard-coded 55px
     spacer, which left the receiver row jammed against the header on phones (the buttons
     nearly touching the clock) and squeezed the receiver list. Measure the real chrome:
     the tallest fixed/sticky element pinned to the top of the viewport that is not ours. */
  function topChromeBottom() {
    /* The app's bar is #top. Measure it directly - and if its search-results overlay is open,
       subtract that so we get the bar height, not the overlay. */
    var el2 = document.getElementById("top");
    if (el2 && el2.offsetHeight > 0) {
      var h = el2.getBoundingClientRect().height;
      var res = document.getElementById("results");
      if (res && res.offsetHeight > 0) h -= res.getBoundingClientRect().height;
      if (h > 24) return Math.min(320, h);
    }
    var maxB = 0, all;
    try { all = document.querySelectorAll("body *"); } catch (e) { return 0; }
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.id === "sdrView" || (e.closest && e.closest("#sdrView"))) continue;
      var cs;
      try { cs = getComputedStyle(e); } catch (e2) { continue; }
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (!e.offsetHeight || e.offsetHeight > 320) continue;
      var r = e.getBoundingClientRect();
      if (r.height > 0 && r.top < 10 && r.bottom > maxB) maxB = r.bottom;
    }
    return maxB;
  }
  function applyTopClearance() {
    var head = document.querySelector("#sdrView .sdr-head");
    if (!head) return;
    var chrome = topChromeBottom();
    if (!chrome) return;
    var pad = Math.round(chrome) + 8;      /* a real gap under the header */
    try { head.style.setProperty("padding-top", pad + "px", "important"); }
    catch (e) { head.style.paddingTop = pad + "px"; }
    dbg.topClearance = { chrome: Math.round(chrome), pad: pad };
  }
  function fitSdr(attempt) {
    attempt = attempt || 0;
    var view = document.querySelector("#sdrView");
    if (!view) { dbg.fitWhy = "no #sdrView"; return; }
    var spec = el("sdrSpectrum"), water = el("sdrWater");
    if (!spec || !water) { dbg.fitWhy = "no canvases"; return; }
    try { applyTopClearance(); } catch (e) {}
    var space = sdrSpace();
    /* NOTE: offsetParent is null for this panel even when it is plainly on screen
       (the app positions its panels absolutely), so visibility is judged from real
       geometry - that bug silently skipped the fit entirely. */
    if (view.getBoundingClientRect().height < 120 || !space || space < 200) {
      /* not laid out yet (view hidden, or the tab was just tapped): retry shortly */
      if (attempt < 8) setTimeout(function () { fitSdr(attempt + 1); }, 50 + attempt * 70);
      dbg.fitWhy = "not laid out (attempt " + attempt + ", space " + (space ? Math.round(space) : "null") + ")";
      return;
    }
    var fixed = 0, kids = view.children, i, c, cs, mt, mb;
    for (i = 0; i < kids.length; i++) {
      c = kids[i];
      if (c === spec || c === water) continue;
      if (!c.offsetHeight) continue;                          /* hidden row */
      cs = getComputedStyle(c);
      if (cs.position === "fixed") continue;                  /* keypad / sheet / favourites */
      mt = parseFloat(cs.marginTop) || 0; mb = parseFloat(cs.marginBottom) || 0;
      fixed += c.offsetHeight + mt + mb;
    }
    var room = space - fixed;
    var specH, waterH;
    /* on very short screens the canvases give up a few pixels so the squelch/volume sliders
       stay on screen without scrolling */
    var shortView = window.innerHeight <= 700;
    if (room < 150) {                                         /* very tight: minimum viable */
      specH = shortView ? 34 : 44; waterH = shortView ? 44 : 60;
    } else {
      specH = Math.round(Math.min(110, Math.max(shortView ? 38 : 48, room * 0.30)));
      waterH = Math.round(Math.max(shortView ? 44 : 58, room - specH));
      if (specH + waterH > room) waterH = Math.max(shortView ? 44 : 58, room - specH);
    }
    spec.style.height = specH + "px";
    water.style.height = waterH + "px";
    spec.style.display = "block";
    water.style.display = "block";
    layoutCanvases();
    redrawLast();
    try { drawSpecRulerStrip(); } catch (e) {}
    dbg.fitWhy = "ok";
    dbg.fit = { space: Math.round(space), fixed: Math.round(fixed), room: Math.round(room),
                specH: specH, waterH: waterH, attempt: attempt,
                viewScroll: view.scrollHeight - view.clientHeight };
  }
  /* A dedicated stylesheet, appended LAST and with !important: several sheets are
     injected after #sdrDigStyle, so equal-specificity rules there were winning and
     the trims silently did nothing. index.html itself is untouched. */
  function sdrFitCss() {
    var id = "sdrFitStyle", st = document.getElementById(id);
    if (!st) { st = document.createElement("style"); st.id = id; document.head.appendChild(st); }
    /* ALWAYS applied, outside every media query: the menu icon is SVG now, but the button's
       size and its centring must hold on any screen (a 1080-tall Fire TV never matched the
       old max-height:900px block, which is exactly why the icon was invisible there). */
    var always =
      "#sdrMenuBtn{display:inline-flex!important;align-items:center!important;justify-content:center!important;" +
      "width:32px!important;min-width:32px!important;height:28px!important;padding:0!important;font-size:0!important}" +
      "#sdrMenuBtn .sdr-bars2{display:block!important;width:18px!important;height:13px!important;visibility:visible!important;" +
      "opacity:1!important;background:none!important}" +
      "#sdrMenuBtn .sdr-bars2 rect{fill:#eaf2ff!important}";
    st.textContent = always +
      "@media (max-height:1200px){" +
      "#sdrView{padding:0 8px 8px!important}" +
      "#sdrView .sdr-head{padding:55px 0 2px!important;min-height:0!important}" +
      "#sdrView .sdr-head *{line-height:1.15!important}" +
      "#sdrView .sdr-top{margin:5px 0 0!important;gap:8px!important;min-height:0!important;align-items:center!important;" +
      "flex-wrap:nowrap!important}" +
      "#sdrPick{flex:1 1 auto!important;min-width:0!important;max-width:none!important;font-size:12.5px!important}" +
      /* the clock belongs INLINE beside the list (own-line looked like a second header);
         compact so the list keeps most of the row */
      "#sdrClock{margin:0!important;flex:0 0 auto!important;order:0!important;font-size:10.5px!important;" +
      "padding:0 5px!important;height:24px!important;line-height:24px!important;opacity:.9!important}" +
      "#sdrView .sdr-top select,#sdrView .sdr-top .sdr-pill{height:26px!important;font-size:12px!important;line-height:1.1!important}" +
      "#sdrPick{flex:1 1 auto!important;min-width:0!important}" +
      "#sdrMenuBtn{width:32px!important;min-width:32px!important;height:28px!important;padding:0!important;" +
      "display:inline-flex!important;align-items:center!important;justify-content:center!important;font-size:0!important}" +
      "" +
      "#sdrSScale i{letter-spacing:0!important;text-shadow:none!important}" +
      "#sdrView .sdr-head .sdr-menu,#sdrMenuBtn2{display:none!important}" +
      "#sdrView .sdr-freqrow{margin:0!important;min-height:0!important}" +
      "#sdrFreq{font-size:46px!important;line-height:1.0!important;margin:1px 0 0!important;letter-spacing:.5px!important}" +
      "#sdrView .sdr-sub{display:none!important}" +
      "#sdrView .sdr-modes{margin:2px 0 0!important;gap:4px!important}" +
      "#sdrView .sdr-modes button{padding:3px 6px!important;font-size:11.5px!important;line-height:1.1!important}" +
      "#sdrView .sdr-scale{margin:0!important;font-size:11px!important;line-height:1.1!important;min-height:0!important}" +
      "#sdrZoomRow{margin:2px 0!important;font-size:11px!important;min-height:0!important}" +
      "#sdrZoomRow *{line-height:1.1!important}" +
      "#sdrView .sdr-meter{margin:2px 0 0!important;padding:2px 0!important;gap:6px!important;min-height:0!important}" +
      "#sdrView .sdr-track{height:27px!important}" +
      ".sdr-sval{font-size:14px!important}#sdrDbm{font-size:10.5px!important}" +
      "#sdrView .sdr-status{margin:1px 0 0!important;padding:1px 0!important;font-size:11.5px!important;line-height:1.15!important;min-height:0!important}" +
      "#sdrAudioHint{margin:2px 0!important;padding:2px 8px!important;font-size:11.5px!important}" +
      "#sdrView .sdr-bottom{margin:9px 0 2px!important;padding:0!important;position:relative!important;" +
      "min-height:44px!important;display:flex!important;align-items:center!important;" +
      "justify-content:space-between!important;gap:10px!important}" +
      "#sdrConnBtn{position:absolute!important;left:50%!important;top:50%!important;" +
      "transform:translate(-50%,-50%)!important;height:34px!important;min-width:104px!important;" +
      "padding:0 16px!important;font-size:13.5px!important;letter-spacing:.4px!important}" +
      "#sdrView .sdr-bottom>*{flex:0 0 auto!important}" +
      "#sdrView .sdr-status{margin-top:10px!important;padding:2px 0 1px!important;line-height:1.4!important}" +
      "#sdrAudioHint{margin:5px 0!important;padding:3px 9px!important}" +
      "#sdrView .sdr-scale{margin:2px 0 1px!important}" +
      "#sdrView .sdr-rds{margin:2px 0 0!important;padding:2px 6px!important;font-size:10.5px!important;line-height:1.15!important}" +
      "}" +
      /* very short panels (old phones, small landscape): give up the panel title and
         the step line - the app's own header already names the page - so the Connect
         button and the S-meter stay reachable without scrolling. */
      "@media (max-height:760px){" +
      "#sdrView .sdr-head>*:not(.sdr-top){display:none!important}" +
      "#sdrView .sdr-head{padding:55px 0 0!important}" +
      "#sdrFreq{font-size:40px!important}" +
      "#sdrZoomRow{margin:1px 0!important}" +
      "#sdrView .sdr-modes button{padding:2px 5px!important;font-size:11px!important}" +
      "#sdrView .sdr-meter{padding:1px 0!important}" +
      "}" +
      "@media (max-height:600px){" +
      "#sdrFreq{font-size:34px!important}" +
      "#sdrView .sdr-top{margin:2px 0 0!important}" +
      "#sdrView .sdr-modes button{padding:2px 5px!important;font-size:11px!important}" +
      "#sdrView .sdr-scale{margin:0!important}" +
      "#sdrView .sdr-meter{margin:2px 0 0!important;padding:1px 0!important}" +
      "#sdrView .sdr-status{margin-top:4px!important;padding:0!important;font-size:11px!important}" +
      "#sdrView .sdr-bottom{margin-top:4px!important;min-height:34px!important}" +
      "#sdrConnBtn{height:28px!important;font-size:12px!important}" +
      "#sdrSpecRuler{height:15px!important}" +
      "@media (max-height:800px){#sdrLive{flex-direction:row!important;gap:6px!important;padding:3px 6px!important}" +
      ".sdr-live .lv{flex:1 1 0;min-width:0;min-height:20px}" +
      ".sdr-live label{width:auto!important;font-size:10px!important}" +
      ".sdr-live b{min-width:34px!important;font-size:10.5px!important}" +
      ".sdr-live input[type=range]{height:18px!important}}" +
      "}" +
      /* ---- S-meter as a discrete LED bar (31 segments, blue on dark) ---- */
      "#sdrView .sdr-track{height:27px!important;border-radius:5px!important;background:#141a21!important;" +
      "border:1px solid #232c36!important;overflow:hidden!important}" +
      "#sdrSmeterBar{opacity:0!important}" +
      "#sdrLeds{position:absolute;inset:0;display:flex;gap:1px;padding:1px;pointer-events:none;z-index:2}" +
      "#sdrLeds i{flex:1 1 0;min-width:0;background:#1c232b;border-radius:1px}" +
      "#sdrLeds i.on{background:#00aef0;box-shadow:0 0 5px rgba(0,174,240,.6)}" +
      "#sdrLeds i.on.hi{background:#ff3b3b;box-shadow:0 0 5px rgba(255,59,59,.65)}" +
      /* ---- auto-scale by ratio: the frequency always fits, whatever the screen ---- */
      "#sdrFreq{white-space:nowrap!important;max-width:100%!important}" +
      /* ---- favourites-only scanner + a readable receiver picker ---- */
      ".sdr-scan{display:flex;align-items:center;gap:8px;margin:8px 0 0;padding:6px 8px;" +
      "background:#101722;border:1px solid #2a2f3a;border-radius:10px}" +
      "#sdrScanBtn{flex:0 0 auto;height:30px;padding:0 12px;border-radius:8px;border:1px solid #2a3648;" +
      "background:#16202c;color:#9fe8ff;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap}" +
      "#sdrScanBtn.on{background:#0f2a1a;border-color:#1f6b3f;color:#5ef2a0}" +
      "#sdrScanInfo{flex:1 1 auto;min-width:0;font:11.5px/1.25 ui-monospace,Consolas,monospace;color:#8a94a6;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#sdrScanInfo.hot{color:#ffcc55}" +
      "#sdrPickBtn{flex:1 1 auto!important;min-width:0!important;height:32px!important;display:flex;" +
      "align-items:center;gap:6px;padding:0 10px!important;border-radius:8px!important;border:1px solid #2a3648;" +
      "background:#141c27;color:#e8f1fa;font-size:14px!important;cursor:pointer;text-align:left}" +
      "#sdrPickBtn span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#sdrPick.sdr-pick-native{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}" +
      "#sdrPickBtn i{flex:0 0 auto;font-style:normal;color:#7c8798}" +
      ".sdr-picksheet{position:fixed;inset:0;z-index:60;background:rgba(4,7,12,.97);display:flex;" +
      "flex-direction:column;padding:calc(var(--safe-t,0px) + 10px) 12px 12px}" +
      ".sdr-picksheet.hide{display:none!important}" +
      ".sdr-pickhead{display:flex;gap:8px;align-items:center;margin-bottom:8px}" +
      "#sdrPickSearch{flex:1 1 auto;min-width:0;height:36px;border-radius:9px;border:1px solid #2a3648;" +
      "background:#0d141d;color:#e8f1fa;font-size:14px;padding:0 10px}" +
      "#sdrPickClose{flex:0 0 auto;width:36px;height:36px;border-radius:9px;border:1px solid #2a3648;" +
      "background:#16202c;color:#e8f1fa;font-size:16px;cursor:pointer}" +
      "#sdrPickList{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch}" +
      ".sdr-pickrow{display:flex;align-items:center;gap:8px;padding:11px 10px;border-bottom:1px solid #1b2430;" +
      "color:#e8f1fa;font-size:14.5px;cursor:pointer}" +
      ".sdr-pickrow:active{background:#16202c}" +
      ".sdr-pickrow.cur{background:#12212e;color:#9fe8ff}" +
      ".sdr-pickrow b{flex:0 0 auto;font-size:10.5px;font-weight:700;color:#0b1218;background:#7fd0ff;" +
      "border-radius:5px;padding:2px 5px}" +
      ".sdr-pickrow span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      /* ---- receiver list gets its width back; a favourite star beside the frequency ---- */
      "#sdrView .sdr-top{gap:6px!important}" +
      "#sdrMenuBtn{flex:0 0 auto!important;min-width:26px!important;padding:0 5px!important}" +
      "#sdrPick{flex:1 1 auto!important;min-width:0!important;max-width:none!important;" +
      "font-size:12.5px!important;text-overflow:ellipsis!important}" +
      "@media (max-width:440px){#sdrClock{display:none!important}}" +
      ".sdr-favstar{flex:0 0 auto;width:36px;height:36px;border-radius:10px;background:#1a2230;" +
      "border:1px solid #2a3648;color:#7c8798;font-size:20px;line-height:1;cursor:pointer;" +
      "padding:0;display:flex;align-items:center;justify-content:center;transition:all .12s}" +
      ".sdr-favstar:active{transform:scale(.94)}" +
      ".sdr-favstar.on{color:#ffd166;border-color:#6b5a24;background:#241f10;" +
      "box-shadow:0 0 10px rgba(255,209,102,.28)}" +
      "@media (max-height:800px){#sdrLive{flex-direction:row!important;gap:6px!important;padding:3px 6px!important}" +
      ".sdr-live .lv{flex:1 1 0;min-width:0;min-height:20px}" +
      ".sdr-live label{width:auto!important;font-size:10px!important}" +
      ".sdr-live b{min-width:34px!important;font-size:10.5px!important}" +
      ".sdr-live input[type=range]{height:18px!important}" +
      "#sdrScan{margin:2px 0 0!important;padding:4px 6px!important}}" +
      "";
  }
  /* The ☰ sat at the far right of the top row with margin-left:auto, which wrapped it
     onto its own line on a phone (the owner read that as "the menu at the bottom").
     Put it immediately beside the receiver picker and draw it as two bars. */
  function moveMenuButton() {
    var old = el("sdrMenuBtn2");
    if (old && old.parentNode) old.parentNode.removeChild(old);   /* the bottom "☰ Menu" */
    var sel = el("sdrPick"), mb = el("sdrMenuBtn");
    if (!sel || !mb) return;
    if (!mb.dataset.beside) {
      mb.dataset.beside = "1";
      mb.style.marginLeft = "4px";
      mb.style.flex = "0 0 auto";
      mb.setAttribute("title", "settings");
      mb.setAttribute("aria-label", "settings");
      /* Two real boxes, not a gradient: a CSS-gradient glyph rendered blank on the
         owner's device (font-size:0 on the button also made any glyph vanish). */
      /* Inline SVG with solid rects: immune to font-size:0, to button styling, and to any
         stylesheet that fails to apply. Measured rects in the verification. */
      mb.innerHTML = '<svg class="sdr-bars2" width="18" height="13" viewBox="0 0 18 13" ' +
        'aria-hidden="true" focusable="false" style="display:block">' +
        '<rect x="0" y="0" width="18" height="3" fill="#eaf2ff"></rect>' +
        '<rect x="0" y="5" width="18" height="3" fill="#eaf2ff"></rect>' +
        '<rect x="0" y="10" width="18" height="3" fill="#eaf2ff"></rect></svg>';
      /* LEFT of the receiver picker */
      if (sel.parentNode) sel.parentNode.insertBefore(mb, sel);
    }
  }
  function wireFit() {
    var run = function () { requestAnimationFrame(function () { fitSdr(0); try { alignSmeterScale(); } catch (e) {} }); };
    window.addEventListener("resize", function () { setTimeout(function () { try { applyTopClearance(); fitSdr(0); } catch (e) {} }, 60); });
    if (S.fitWired) { run(); return; }
    S.fitWired = true;
    /* the view is shown by toggling its class - that is the moment to measure */
    var view = document.querySelector("#sdrView");
    if (view && window.MutationObserver) {
      new MutationObserver(function () { if (!view.classList.contains("hide")) run(); })
        .observe(view, { attributes: true, attributeFilter: ["class", "style"] });
    }
    var tab = el("viewSdr");
    if (tab) tab.addEventListener("click", function () { setTimeout(run, 30); });
    window.addEventListener("resize", function () { setTimeout(run, 40); });
    window.addEventListener("orientationchange", function () { setTimeout(run, 120); });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", function () { setTimeout(run, 40); });
    var st = document.getElementById("sdrDigStyle");
    if (st && st.textContent.indexOf("/* fit-compact2 */") < 0) { st.textContent += "/* fit-compact2 */"; }
    sdrFitCss();
    run();
  }
  /* S-meter scale. The bar spans -127..-13 dBm linearly, which is exactly
     S0..S9 (6 dB per unit) plus +10..+60 over S9 - so ticks placed by the same
     formula line up with the bar for any calibration offset. */
  var S_TICKS = [["S0",0],["1",1],["3",3],["5",5],["7",7],["9",9],
                 ["+10",10],["+20",20],["+30",30],["+40",40],["+50",50],["+60",60]];
  function tickPct(n) {
    var dbm = (n <= 9) ? (-127 + 6 * n) : (-73 + n);
    return (dbm + 127) / 114 * 100;
  }
  /* S-meter scale: its own full-width row BELOW the meter. It was put inside the
     meter row, which is a flex row, so it never showed on the owner's device. */
  var S_TICKS = [["S0",0],["1",1],["3",3],["5",5],["7",7],["9",9],
                 ["+10",10],["+20",20],["+30",30],["+40",40],["+50",50],["+60",60]];
  function tickPct(n) {
    var dbm = (n <= 9) ? (-127 + 6 * n) : (-73 + n);
    return (dbm + 127) / 114 * 100;
  }
  /* S-meter scale, pinned to the METER BAR's own box. It was full width, so its
     numbers could not line up with a bar that only occupies part of the row (the
     S-value and dBm text sit beside it) - the owner saw the scale "going across the
     screen" instead of under the meter reading. */
  var S_TICKS = [["S0",0],["1",1],["3",3],["5",5],["7",7],["9",9],
                 ["+10",10],["+20",20],["+30",30],["+40",40],["+50",50],["+60",60]];
  function tickPct(n) {
    var dbm = (n <= 9) ? (-127 + 6 * n) : (-73 + n);
    return (dbm + 127) / 114 * 100;
  }
  var S_SCALE_INSET = 14;      /* the strip is WIDER than the bar so the end numbers fit inside */
  function alignSmeterScale() {
    var meter = document.querySelector("#sdrView .sdr-meter");
    var track = document.querySelector("#sdrView .sdr-track");
    var wrap = el("sdrSScale");
    if (!meter || !track || !wrap) return;
    var tw = track.offsetWidth || 0;
    if (!tw) return;
    /* The strip extends past the bar at both ends - but never past the METER'S own box, or the
       numbers would sit outside the frame (which is exactly what the owner kept seeing). */
    var mcs = getComputedStyle(meter);
    var padL = parseFloat(mcs.paddingLeft) || 0, padR = parseFloat(mcs.paddingRight) || 0;
    var contentW = Math.max(40, (meter.clientWidth || tw) - padL - padR);
    var wantLeft = track.offsetLeft - S_SCALE_INSET;
    var left = Math.max(0, Math.min(wantLeft, contentW - 40));
    var width = Math.min(contentW - left, tw + S_SCALE_INSET * 2);
    var insetUsed = Math.max(0, track.offsetLeft - left);      /* real inset, may be small */
    var stripW = width;
    wrap.style.left = left + "px";
    wrap.style.width = width + "px";
    wrap.style.top = (track.offsetTop + track.offsetHeight + 3) + "px";
    var ticks = wrap.querySelectorAll("b"), labs = wrap.querySelectorAll("i");
    S_TICKS.forEach(function (tk, i2) {
      var x = insetUsed + (tickPct(tk[1]) / 100) * tw;
      var lab = labs[i2];
      if (ticks[i2]) ticks[i2].style.left = x.toFixed(1) + "px";
      if (!lab) return;
      /* keep the label inside the strip by its own width, so no number can hang outside */
      var w = lab.offsetWidth || 14, half = w / 2;
      var lx = x;
      if (lx - half < 1) lx = 1 + half;
      if (lx + half > stripW - 1) lx = stripW - 1 - half;
      lab.style.left = lx.toFixed(1) + "px";
    });
    dbg.sscaleAlign = { left: left, width: Math.round(width), top: wrap.style.top,
                        trackLeft: track.offsetLeft, trackW: tw, insetUsed: Math.round(insetUsed),
                        meterContentW: Math.round(contentW) };
  }
  
  /* ---------- S-meter LED bar: 31 discrete segments, blue on dark ----------
     The reference is a segmented LED bargraph: 31 tall thin segments, lit ones bright blue
     (#00aef0), unlit near-black, with white S labels and red +dB labels. The app's own
     #sdrSmeterBar still receives the real value from the radio, so the LEDs are driven from ITS
     width - the app's telemetry path is left completely alone. */
  var LED_COUNT = 31, LED_TARGET_W = 10;
  function ledCountFor(track) {
    var tw = track.clientWidth || 0;
    var n = Math.round(tw / LED_TARGET_W);
    return Math.max(18, Math.min(80, n));      /* ~31 on a phone, more on a wide screen */
  }
  function buildLeds(n) {
    var track = document.querySelector("#sdrView .sdr-track");
    if (!track) return;
    var old = track.querySelector("#sdrLeds");
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement("div");
    box.id = "sdrLeds";
    var h = "";
    for (var i = 0; i < n; i++) h += "<i></i>";
    box.innerHTML = h;
    track.appendChild(box);
    LED_COUNT = n;
  }
  function setLeds(pct) {
    var box = document.querySelector("#sdrLeds");
    if (!box) return;
    pct = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
    var n = Math.round(pct / 100 * LED_COUNT);
    /* the +dB region reads RED, exactly like a real S-meter: a segment is hot when its centre
       sits at or past the +10 tick (tickPct(10) = 56.14% of the span). Below that it is blue. */
    var hot = tickPct(10);
    var kids = box.children;
    for (var i = 0; i < kids.length; i++) {
      var want = "", cls;
      if (i < n) {
        var centre = (i + 0.5) / LED_COUNT * 100;
        want = (centre >= hot) ? "on hi" : "on";
      }
      cls = kids[i].className;
      if (cls !== want) kids[i].className = want;
    }
    dbg.leds = { pct: Math.round(pct), lit: n, of: LED_COUNT,
                 hotFrom: Math.round(hot), red: [...kids].filter(function (k) { return k.className === "on hi"; }).length };
    dbg.ledTest = setLeds;   /* test hook */
  }
  function syncLeds() {
    var bar = el("sdrSmeterBar"), track = document.querySelector("#sdrView .sdr-track");
    if (!bar || !track) return;
    var tw = track.clientWidth || 0;
    if (!tw) return;
    if (ledCountFor(track) !== LED_COUNT && track.querySelector("#sdrLeds")) buildLeds(ledCountFor(track));
    var bw = bar.getBoundingClientRect().width || 0;   /* the app keeps this width live */
    setLeds((bw / tw) * 100);
    dbg.leds.w = Math.round(tw);
  }
  function startLeds() {
    buildLeds(ledCountFor(document.querySelector("#sdrView .sdr-track")));
    syncLeds();
    if (!window.__ledTimer) window.__ledTimer = setInterval(function () { syncLeds(); try { pickerTick(); } catch (e) {} }, 100);
  }
  function buildSmeterScale() {
    var meter = document.querySelector("#sdrView .sdr-meter");
    var track = document.querySelector("#sdrView .sdr-track");
    if (!meter || !track) return;
    var old = el("sdrSScale");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    meter.style.position = "relative";
    var pad = parseFloat(getComputedStyle(meter).paddingBottom) || 0;
    if (pad < 24) meter.style.paddingBottom = (pad + 24) + "px";
    var wrap = document.createElement("div");
    wrap.id = "sdrSScale";
    wrap.setAttribute("style", "position:absolute;height:16px;display:block;" +
      "font:10px/1 monospace;color:rgba(214,230,246,.82);user-select:none;z-index:3");
    S_TICKS.forEach(function (tk) {
      var pct = tickPct(tk[1]);
      var tick = document.createElement("b");
      tick.setAttribute("style", "position:absolute;top:0;left:0;width:1px;" +
        "height:" + (tk[1] === 0 || tk[1] === 9 || tk[1] === 60 ? "4" : "2") + "px;" +
        "background:" + (tk[1] >= 10 ? "rgba(255,90,90,.85)" : "rgba(214,230,246,.6)") +
        ";transform:translateX(-50%)");
      var lab = document.createElement("i");
      /* "S0" at 0% and "+60" at 100% were half outside the meter box (the owner circled
         them spilling out of the frame): the outermost labels anchor to the edges instead
         of being centred on their tick. */
      /* positions are set in px by alignSmeterScale (against the bar, inside the wider strip) */
      lab.setAttribute("style", "position:absolute;top:5px;transform:translateX(-50%);" +
        "font-style:normal;white-space:nowrap;font-weight:700;" +
        "color:" + (tk[1] >= 10 ? "#ff5a5a" : "rgba(232,240,248,.95)"));
      lab.textContent = tk[0];
      wrap.appendChild(tick);
      wrap.appendChild(lab);
    });
    var mark = document.createElement("span");
    mark.id = "sdrSScaleMark";
    mark.setAttribute("style", "position:absolute;top:0;width:1px;height:5px;background:#ffd166;left:0%");
    wrap.appendChild(mark);
    meter.appendChild(wrap);
    alignSmeterScale();
    if (!el("sdrLeds")) startLeds(); else syncLeds();
    dbg.sscale = { count: wrap.querySelectorAll("i").length, pct: S_TICKS.map(function (x) {
      return [x[0], +tickPct(x[1]).toFixed(1)]; }) };
  }
  function wireAudioHintUI() {
    if (el("sdrAudioHint")) return;
    var st = document.querySelector("#sdrView .sdr-status") || document.querySelector(".sdr-status");
    if (!st || !st.parentNode) return;
    var b = document.createElement("button");
    b.id = "sdrAudioHint";
    b.type = "button";
    b.className = "mini hide";
    b.setAttribute("style", "margin:4px 0 2px;color:#ffd166;border-color:#ffd166");
    b.textContent = "\ud83d\udd07 Tap for audio";
    st.parentNode.insertBefore(b, st.nextSibling);
    var ds = document.getElementById("sdrDigStyle");
    if (ds && ds.textContent.indexOf("#sdrAudioHint") < 0) {
      ds.textContent += "#sdrAudioHint.hide{display:none!important}#sdrAudioHint{font-weight:700}";
    }
  }
  function wireFavs() {
    if (el("sdrFavBtn")) { favBadge(); return; }
    var bottom = document.querySelector("#sdrView .sdr-bottom") || document.querySelector(".sdr-bottom");
    if (!bottom) return;
    var wrap = document.createElement("span");
    wrap.id = "sdrFavWrap";
    wrap.setAttribute("style", "display:inline-flex;gap:6px;align-items:center");
    wrap.innerHTML = '<button id="sdrFavBtn" type="button" class="mini" title="save or remove this station">\u2606 Save</button>' +
                     '<button id="sdrFavOpen" type="button" class="mini" title="saved stations">\u2605 0</button>';
    bottom.appendChild(wrap);
    var row = document.createElement("div");
    row.id = "sdrFavRow";
    row.className = "sdr-favrow hide";
    row.innerHTML = '<input id="sdrFavName" type="text" placeholder="station name" autocomplete="off">' +
                    '<button id="sdrFavOk" type="button" class="mini">Save</button>' +
                    '<button id="sdrFavCancel" type="button" class="mini">Cancel</button>';
    var anchor = el("sdrRds") || document.querySelector(".sdr-meter");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(row, anchor.nextSibling);
    else bottom.parentNode.insertBefore(row, bottom);
    var list = document.createElement("div");
    list.id = "sdrFavList";
    list.className = "sdr-favlist hide";
    list.innerHTML = '<div class="fav-head"><span>\u2605 Saved stations</span>' +
                     '<button id="sdrFavClose" type="button" class="mini">\u2715</button></div><div id="sdrFavBody"></div>';
    var host = document.querySelector("#sdrView") || bottom.parentNode;
    host.appendChild(list);
    var st = document.getElementById("sdrDigStyle");
    if (st && st.textContent.indexOf(".sdr-favlist{") < 0) {
      st.textContent += ".sdr-favrow{display:flex;gap:6px;align-items:center;margin:6px 0 2px}" +
        ".sdr-favrow.hide{display:none!important}" +
        "#sdrFavName{flex:1;min-width:90px;background:#0b1622;color:#cfd8e3;border:1px solid #1d3a52;" +
        "border-radius:6px;padding:5px 7px;font-size:13px}" +
        ".sdr-favlist{position:fixed;left:0;right:0;bottom:0;max-height:64vh;overflow:auto;z-index:60;" +
        "background:#0a1220;border-top:1px solid #1d3a52;padding:8px 10px 14px}" +
        ".sdr-favlist.hide{display:none!important}" +
        ".fav-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;color:#ffd166;margin-bottom:6px}" +
        ".fav-row{display:flex;gap:8px;align-items:center;padding:7px 4px;border-bottom:1px solid #142331}" +
        ".fav-name{flex:1;color:#e8eef5;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".fav-freq{color:#00e5ff;font-size:12px;white-space:nowrap}" +
        ".fav-empty{opacity:.75;padding:8px 2px}" +
      /* ---- favourites sheet: full height, check marks, ALL/NONE ---- */
      ".sdr-favlist{max-height:84vh!important;border-radius:14px 14px 0 0!important;" +
      "border:1px solid #2a3648;border-bottom:0;background:#0c131c}" +
      ".fav-head{display:flex;gap:8px;align-items:center;position:sticky;top:0;background:#0c131c;" +
      "padding:8px 4px;z-index:2}" +
      ".fav-head b{flex:1 1 auto;color:#ffd166;font-size:14px;font-weight:700}" +
      ".fav-head small{color:#7c8798;font-weight:600;font-size:11px}" +
      ".fav-head button{flex:0 0 auto;font-size:11px!important;padding:5px 9px!important}" +
      "#sdrFavBody{padding-bottom:14px}" +
      ".fav-check{flex:0 0 auto;width:30px;height:30px;border-radius:8px;border:1px solid #33404f;" +
      "background:#141c27;color:#6f7a8a;font-size:16px;line-height:1;cursor:pointer;padding:0}" +
      ".fav-check.on{border-color:#6b5a24;background:#241f10;color:#ffd166}" +
      ".fav-row{padding:8px 4px!important}" +
      /* ---- favourites list: real scrolling + buttons that hold their text ---- */
      ".sdr-favlist{display:flex!important;flex-direction:column!important;" +
      "max-height:min(84vh,660px)!important;overflow:hidden!important}" +
      ".fav-head{position:static!important;flex:0 0 auto!important;flex-wrap:wrap;row-gap:6px}" +
      ".fav-head b{flex:1 1 auto;min-width:120px}" +
      "#sdrFavBody{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;" +
      "overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;" +
      "overscroll-behavior:contain!important;touch-action:pan-y!important;padding-bottom:22px!important}" +
      ".fav-head button{flex:0 0 auto!important;height:30px!important;min-width:50px!important;width:auto!important;max-width:none!important;display:inline-flex!important;" +
      "align-items:center!important;justify-content:center!important;font-size:11px!important;" +
      "line-height:1!important;white-space:nowrap!important;overflow:hidden!important;padding:0 8px!important}" +
      ".fav-check{display:inline-flex!important;align-items:center!important;justify-content:center!important;" +
      "font-size:15px!important;line-height:1!important;overflow:hidden!important;padding:0!important}" +
      ".fav-x{display:inline-flex!important;align-items:center!important;justify-content:center!important;" +
      "font-size:13px!important;line-height:1!important;min-width:34px!important;height:30px!important;" +
      "overflow:hidden!important;padding:0!important}" +
      ".fav-row{gap:6px!important}" +
      ".fav-scan,.fav-check,.fav-x{flex:0 0 auto!important}" +
      /* ---- squelch + volume live on the front page, under the scanner row ---- */
      ".sdr-live{display:flex;flex-direction:column;gap:3px;margin:5px 0 0;padding:4px 8px;" +
      "background:#101722;border:1px solid #2a2f3a;border-radius:10px}" +
      ".sdr-live .lv{display:flex;align-items:center;gap:7px;min-height:22px}" +
      ".sdr-live label{flex:0 0 auto;width:52px;font-size:10.5px;font-weight:700;color:#8a94a6;" +
      "text-transform:uppercase;letter-spacing:.6px}" +
      ".sdr-live input[type=range]{flex:1 1 auto;min-width:0;height:20px;accent-color:#00e5ff}" +
      ".sdr-live b{flex:0 0 auto;min-width:44px;text-align:right;font:11px/1 ui-monospace,Consolas,monospace;" +
      "color:#9fe8ff}" +

      /* ---- favourite: rename + group chips, and a group picker sheet ---- */
      ".fav-grp{flex:0 0 auto;max-width:96px;font-size:10.5px!important;font-weight:700;padding:4px 7px!important;" +
      "border-radius:6px!important;border:1px solid #2f4a63!important;background:#12212e!important;" +
      "color:#9fe8ff!important;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".fav-edit{flex:0 0 auto;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;" +
      "font-size:14px!important;line-height:1!important;padding:0!important;border-radius:8px!important;" +
      "border:1px solid #33404f!important;background:#141c27!important;color:#8fa2b8!important;cursor:pointer}" +
      "#sdrScanGrp{flex:0 0 auto;height:30px;padding:0 9px!important;border-radius:8px!important;" +
      "border:1px solid #2f4a63!important;background:#12212e!important;color:#9fe8ff!important;" +
      "font-size:11.5px!important;font-weight:700;cursor:pointer;white-space:nowrap;max-width:110px;" +
      "overflow:hidden;text-overflow:ellipsis}" +
      ".grp-row{display:flex;gap:8px;align-items:center;padding:10px;border-bottom:1px solid #1b2430;color:#e8f1fa}" +
      ".grp-row span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".grp-row small{color:#8a94a6;font-size:11px}" +
      ".grp-row.cur{background:#12212e;color:#9fe8ff}" +
      "#sdrGrpSheet .sdr-pickhead b{flex:1 1 auto;color:#ffd166}" +

      /* ---- our own draggable scrollbar (Android ignores ::-webkit-scrollbar) ---- */
      "#sdrFavBar{position:absolute;right:3px;width:13px;display:none;z-index:6;touch-action:none;" +
      "border-radius:7px;background:#0d141d}" +
      "#sdrFavThumb{position:absolute;left:2px;right:2px;top:0;height:40px;border-radius:6px;" +
      "background:#4d5f75;cursor:grab}" +
      "#sdrFavThumb.drag{background:#63799a;cursor:grabbing}" +
      "#sdrFavBody{padding-right:16px!important}" +

      /* ---- fixed-height favourites box (~5 rows) with a real, draggable scrollbar ---- */
      ".sdr-favlist{height:auto!important;max-height:none!important;overflow:hidden!important}" +
      "#sdrFavBody{overflow-y:auto!important;scrollbar-width:thin!important;" +
      "scrollbar-color:#4d5f75 #0d141d!important}" +
      "#sdrFavBody::-webkit-scrollbar{width:12px}" +
      "#sdrFavBody::-webkit-scrollbar-track{background:#0d141d;border-radius:7px}" +
      "#sdrFavBody::-webkit-scrollbar-thumb{background:#4d5f75;border-radius:7px;" +
      "border:3px solid #0d141d;min-height:36px}" +
      "#sdrFavBody::-webkit-scrollbar-thumb:hover{background:#63799a}" +



      ".fav-scan{flex:0 0 auto;font-size:10.5px;font-weight:700;padding:3px 7px!important;border-radius:6px!important;" +
      "border:1px solid #33404f!important;background:#141c27!important;color:#6f7a8a!important;cursor:pointer}" +
      ".fav-scan.on{border-color:#6b5a24!important;background:#241f10!important;color:#ffd166!important}" +

        ".mini.on{color:#ffd166;border-color:#ffd166}";
    }
    var b = el("sdrFavBtn"), o = el("sdrFavOpen");
    if (b) b.onclick = function () {
      var here = favFind(S.freq, S.mode);
      if (here) { favRemove(S.freq, S.mode); favSaveRow(false); }
      else favSaveRow(!(el("sdrFavRow") && !el("sdrFavRow").classList.contains("hide")));
    };
    if (o) o.onclick = favOpen;
    var ok = el("sdrFavOk"), cx = el("sdrFavCancel"), inp = el("sdrFavName"), cl = el("sdrFavClose");
    if (ok) ok.onclick = function () {
      favAdd(S.freq, (inp && inp.value.trim()) || fmtShort(S.freq), S.mode);
      favSaveRow(false);
    };
    if (inp) inp.onkeydown = function (ev) { if (ev.key === "Enter" && ok) ok.onclick(); };
    if (cx) cx.onclick = function () { favSaveRow(false); };
    if (cl) cl.onclick = favClose;
    favBadge();
  }

  function drawRuler(g, W, H, place) {
    if (!g || !S.center || !S.bw) return;
    var span = visSpan();
    if (!span) return;
    var step = niceStepFor(span, W < 420 ? 3 : 5);
    var c = visCenterHz();
    var lo = c - span / 2, hi = c + span / 2;
    var first = Math.ceil(lo / step) * step;
    var bottom = (place === "bottom");
    var y = bottom ? H - 13 : 1;
    var labels = [];
    dbg.rulerTicks = [];
    g.save();
    g.font = "600 11px ui-monospace, Menlo, Consolas, monospace";
    g.textAlign = "center";
    g.textBaseline = "top";
    for (var f = first; f <= hi; f += step) {
      var x = ((f - lo) / span) * W;
      if (x < 12 || x > W - 12) continue;
      var isCentre = Math.abs(f - c) < step / 2;         /* the dial frequency */
      if (isCentre) { x = W / 2; }
      dbg.rulerTicks.push({ f: f, x: Math.round(x), centre: isCentre });
      g.strokeStyle = bottom ? "rgba(255,255,255,.20)"
                             : (isCentre ? "rgba(0,229,255,.95)" : "rgba(255,255,255,.14)");
      g.lineWidth = isCentre ? 2 : 1;
      g.beginPath();
      g.moveTo(x + 0.5, bottom ? H - 13 : 0);
      g.lineTo(x + 0.5, (bottom ? H - 13 : 0) + (isCentre ? 9 : 5));
      g.stroke();
      var lbl = span < 120000 ? (f / 1000).toFixed(0) + " kHz"
              : span < 3000000 ? (f / 1e6).toFixed(3)
              : (f / 1e6).toFixed(2);
      labels.push(lbl);
      /* the dial frequency is labelled in cyan and bold, matching its tick */
      g.font = isCentre ? "800 11px ui-monospace, Menlo, Consolas, monospace"
                        : "600 11px ui-monospace, Menlo, Consolas, monospace";
      var tw = g.measureText(lbl).width;
      g.fillStyle = isCentre ? "rgba(0,22,30,.88)" : "rgba(0,0,0,.55)";
      g.fillRect(x - tw / 2 - 2, y, tw + 4, 12);
      g.fillStyle = isCentre ? "#00e5ff" : "rgba(207,216,227,.93)";
      g.fillText(lbl, x, y + 0.5);
    }
    g.restore();
    S.rulerLabels = labels;
  }

  /* ============================================== station text (RDS)
     WFM carries RDS: station name (PS), programme type, "now playing" from RadioText
     Plus (artist/title) and scrolling RadioText - the IDs and titles stations send.
     The receiver delivers it as JSON: {type:"secondary_demod", value:{...}}. */
  function rdsTags(v) {
    var out = {};
    try {
      var arr = v && v.radiotext_plus && v.radiotext_plus.tags;
      if (Array.isArray(arr)) arr.forEach(function (o) {
        if (!o) return;
        if (o.name !== undefined && o.value !== undefined) out[String(o.name)] = String(o.value);
        else Object.keys(o).forEach(function (k) { out[k] = o[k]; });
      });
      else if (arr && typeof arr === "object") Object.keys(arr).forEach(function (k) { out[k] = arr[k]; });
    } catch (e) {}
    return out;
  }
  function rdsUpdate(v) {
    if (!v || typeof v !== "object") return;
    var g = rdsTags(v);
    var ps = g["stationname.short"] || g["stationname.long"] || v.ps || "";
    var artist = g["item.artist"] || "", title = g["item.title"] || "";
    var now = artist && title ? (artist + " \u2013 " + title) : (artist || title || "");
    var rt = v.radiotext || "";
    var parts = [];
    if (v.pi) parts.push("PI " + v.pi);
    if (v.prog_type) parts.push(v.prog_type);
    if (g["programme.now"]) parts.push(g["programme.now"]);
    if (!ps && !now && !rt && !parts.length) return;      /* nothing worth showing */
    S.rds = { ps: ps, now: now, rt: rt, meta: parts.join(" \u00b7 ") };
    var box = el("sdrRds");
    if (!box) return;
    box.classList.remove("hide");
    var a = el("rdsPs"), b = el("rdsNow"), c = el("rdsRt"), d = el("rdsMeta");
    if (a) a.textContent = ps || "RDS";
    if (b) { b.textContent = now; b.style.display = now ? "" : "none"; }
    if (c) { c.textContent = rt; c.style.display = rt ? "" : "none"; }
    if (d) d.textContent = S.rds.meta;
  }
  function wireRds() {
    if (el("sdrRds")) return;
    /* sits in the gap under the S-meter, above the connect/disconnect line */
    var anchor = document.querySelector("#sdrView .sdr-meter") || document.querySelector(".sdr-meter") || el("sdrModes");
    if (!anchor || !anchor.parentNode) return;
    var box = document.createElement("div");
    box.id = "sdrRds";
    box.className = "sdr-rds hide";
    box.innerHTML = '<div class="rds-line1"><span id="rdsPs">RDS</span>' +
                    '<span id="rdsMeta" class="rds-meta"></span></div>' +
                    '<div id="rdsNow" class="rds-now"></div>' +
                    '<div id="rdsRt" class="rds-rt"></div>';
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
    var st = document.getElementById("sdrDigStyle");
    if (st && st.textContent.indexOf(".sdr-rds{") < 0) {
      st.textContent += ".sdr-rds{margin:6px 0 2px;padding:5px 8px;border:1px solid #1d3a52;" +
        "border-radius:7px;background:rgba(10,30,45,.55);font-size:12px;line-height:1.35}" +
        ".sdr-rds.hide{display:none!important}" +
        ".rds-line1{display:flex;gap:8px;align-items:baseline}" +
        "#rdsPs{font-weight:800;color:#00e5ff;letter-spacing:.4px}" +
        ".rds-meta{opacity:.75;font-size:11px}" +
        ".rds-now{font-weight:700;color:#ffd166;margin-top:2px}" +
        ".rds-rt{opacity:.88;margin-top:1px}";
    }
  }

  function drawTuneCursor(g, W, H) {
    if (S.tuneAt === null || S.tuneAt === undefined || !g) return;
    var x = Math.round(S.tuneAt * W) + 0.5;
    g.save();
    g.strokeStyle = "#ffb020";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.restore();
  }


  function layoutCanvases() {
    var sp = el("sdrSpectrum"), wt = el("sdrWater");
    if (!sp || !wt) return;

    var w = Math.max(240, sp.clientWidth || 0);
    var sh = Math.max(50, sp.clientHeight || 90);
    if (sp.width !== w || sp.height !== sh) { sp.width = w; sp.height = sh; }
    S.spec = sp; S.sctx = sp.getContext("2d");

    var wh = Math.max(80, wt.clientHeight || 220);
    if (wt.width !== w || wt.height !== wh) { wt.width = w; wt.height = wh; }
    S.water = wt; S.wctx = wt.getContext("2d");

    var bins = S.fftSize || 512;
    if (!S.hist || S.hist.width !== bins || S.hist.height !== wh) {
      S.hist = document.createElement("canvas");
      S.hist.width = bins; S.hist.height = wh;
      S.hctx = S.hist.getContext("2d");
      S.hctx.fillStyle = "#04070c";
      S.hctx.fillRect(0, 0, bins, wh);
    }
  }

  function resetWaterfall() {
    if (!S.hctx || !S.hist) return;
    S.hctx.fillStyle = "#04070c";
    S.hctx.fillRect(0, 0, S.hist.width, S.hist.height);
  }

  /* Build a 256-entry table by interpolating the receiver's own colour stops
     (config.waterfall_colors, e.g. ZoranWaterfall: black-blue-cyan-green-yellow-red).
     Falls back to the built-in ramp when the server does not send one. */
  function buildLut(stops) {
    if (!stops || stops.length < 2) { WF_LUT = null; return; }
    var lut = new Array(256);
    for (var i = 0; i < 256; i++) {
      var v = i / 255 * (stops.length - 1);
      var a = Math.floor(v), b = Math.min(stops.length - 1, a + 1), f = v - a;
      var ca = +stops[a] || 0, cb = +stops[b] || 0;
      var r = ((ca >> 16) & 255) * (1 - f) + ((cb >> 16) & 255) * f;
      var g = ((ca >> 8) & 255) * (1 - f) + ((cb >> 8) & 255) * f;
      var bl = (ca & 255) * (1 - f) + (cb & 255) * f;
      lut[i] = "rgb(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(bl) + ")";
    }
    WF_LUT = lut;
  }  packLut();


  /* Packed copies of the colour table. vToColour() hands back an "rgb(r,g,b)"
     STRING and drawWaterfall used to slice+split+coerce it PER BIN PER FRAME -
     ~1000 string operations every frame, which is what made the spectrum fall
     behind and "back up" while dragging. A Uint32 write per bin replaces it. */
  var WF_LUT32 = null, WF_LE = true;
  (function () {                              /* endianness, once */
    var b = new Uint8Array(4); new Uint32Array(b.buffer)[0] = 0x01020304;
    WF_LE = (b[0] === 4);
  })();
  function packLut() {
    if (!WF_LUT) { WF_LUT32 = null; return; }
    var p = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var q = WF_LUT[i].slice(4, -1).split(",");
      var r = +q[0] & 255, g = +q[1] & 255, bl = +q[2] & 255;
      p[i] = WF_LE ? ((255 << 24) | (bl << 16) | (g << 8) | r) | 0
                   : ((r << 24) | (g << 16) | (bl << 8) | 255) | 0;
    }
    WF_LUT32 = p;
  }
  /* fallback ramp in the same packed form, used when the receiver sent no scheme */
  function packedFallback(v) {
    var r, g, bl;
    if (v < 0.33) { var t1 = v / 0.33; r = 0; g = (t1 * 40) | 0; bl = (t1 * 150) | 0; }
    else if (v < 0.66) { var t2 = (v - 0.33) / 0.33; r = 0; g = (40 + t2 * 180) | 0; bl = (150 + t2 * 105) | 0; }
    else { var t3 = (v - 0.66) / 0.34; r = (t3 * 255) | 0; g = 255; bl = 255; }
    return WF_LE ? ((255 << 24) | (bl << 16) | (g << 8) | r) | 0
                 : ((r << 24) | (g << 16) | (bl << 8) | 255) | 0;
  }
  function vToColour(v) {                     /* 0..1 -> black-blue-cyan-white */
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    if (WF_LUT) return WF_LUT[(v * 255) | 0];
    var r, g, b;
    if (v < 0.33) { var t = v / 0.33; r = 0; g = Math.round(t * 40); b = Math.round(t * 150); }
    else if (v < 0.66) { var t2 = (v - 0.33) / 0.33; r = 0; g = Math.round(40 + t2 * 180); b = Math.round(150 + t2 * 105); }
    else { var t3 = (v - 0.66) / 0.34; r = Math.round(t3 * 255); g = 255; b = 255; }
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function drawSpectrum(f) {
    if (!S.sctx || !S.spec) return;
    var W = S.spec.width, H = S.spec.height, n = f.length;
    var g = S.sctx;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#04070c";
    g.fillRect(0, 0, W, H);

    /* faint dB gridlines */
    g.strokeStyle = "rgba(120,160,200,.13)";
    g.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (frac) {
      var y = Math.round((1 - frac) * H) + 0.5;
      if (y > 0 && y < H) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    });

    g.beginPath();
    g.moveTo(0, H);
    var z0 = (n / 2) * (1 - 1 / (S.zoom > 1 ? S.zoom : 1));
    var zs = n / (S.zoom > 1 ? S.zoom : 1);
    /* Draw against the VISUAL centre so the trace follows the finger. This is a
       single stable offset that shrinks to zero when the receiver confirms the new
       centre, so the trace travels with the drag instead of lagging behind it and
       then snapping - it never rocks, because the shift only ever converges. */
    var sh = centreShiftPx(W);
    dbg.shiftPx = Math.round(sh);
    drawBand(g, W, H);
    /* Map pixel -> FFT bin BY FREQUENCY across the receiver's WHOLE bandwidth, not just the zoom
       window. The old mapping only had data inside the zoom window, so the strip that slid in
       during a drag was held as a flat edge ("flat until it stops, then it picks up the noise").
       The receiver already delivers the full bandwidth, so the incoming side is real data. */
    var _vc = visCenterHz(), _span = visSpan();
    var _dispLo = _vc - _span / 2;
    var _bwLo = (S.center || 0) - (S.bw || 0) / 2, _bwSpan = S.bw || 1;
    var binAt = function (x) {
      var hz = _dispLo + (x / W) * _span;
      var t = (hz - _bwLo) / _bwSpan;
      var i = Math.round(t * (n - 1));
      if (!isFinite(i)) i = 0;
      if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
      return i;
    };
    for (var x = 0; x < W; x++) {
      var i = binAt(x);
      var v = (f[i] - S.wfMin) / ((S.wfMax - S.wfMin) || 1);
      if (v < 0) v = 0; if (v > 1) v = 1;
      var y = H - v * (H - 2);
      if (x === 0) g.lineTo(0, y); else g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    /* The gradient wash under the curve was the "pale blue shadow that goes below the
       spectrum line" the owner circled: it is gone. The curve itself is still drawn
       (the brighter pass below), so the spectrum reads as a line, not a filled shape. */

    g.beginPath();
    for (var x2 = 0; x2 < W; x2++) {
      var i2 = binAt(x2);
      var v2 = (f[i2] - S.wfMin) / ((S.wfMax - S.wfMin) || 1);
      if (v2 < 0) v2 = 0; if (v2 > 1) v2 = 1;
      var y2 = H - v2 * (H - 2);
      if (x2 === 0) g.moveTo(0, y2); else g.lineTo(x2, y2);
    }
    g.strokeStyle = "#00e5ff";
    g.lineWidth = 1.4;
    g.stroke();

    /* centre marker + tuning cursor */
    g.strokeStyle = CENTRE_COLOUR;
    g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
    /* the ruler moved to the TOP of the spectrum (the owner wanted it up there with the
       dial frequency highlighted, like the waterfall). Favours stay at the bottom. */
    /* only the red needle belongs inside the spectrum; the ruler is its own strip
       ABOVE the box (see drawSpecRulerStrip) */
    g.save();
    g.strokeStyle = CENTRE_COLOUR;
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
    g.restore();
    S._sqlLineDrawn = true;
    S._sqlLineY = y;
    drawFavs(g, W, H, true);
    /* no separate tuning cursor: this client re-centres on every tune, so it would
       always be drawn on top of the centre marker and hide it */
  }

  /* Only the NEWEST fft is drawn, at most once per animation frame. Frames used to
     be drawn as they arrived; when each one costs more than the gap between them a
     backlog builds and the spectrum visibly "backs up" and then races to catch up.
     Dropping superseded frames bounds the work at one draw per frame. */
  var pendingFft = null, fftRaf = 0;
  function queueFft(f) {
    if (!f || !f.length) return;
    if (fftRaf) { pendingFft = f; dbg.fftDropped = (dbg.fftDropped || 0) + 1; return; }
    pendingFft = f;
    fftRaf = requestAnimationFrame(function () {
      fftRaf = 0;
      var g2 = pendingFft; pendingFft = null;
      if (!g2) return;
      var t0 = performance.now();
      try { drawSpectrum(g2); } catch (e) {}
      try { drawWaterfall(g2); } catch (e) {}
      try { drawSpecRulerStrip(); } catch (e) {}
      var ms = performance.now() - t0;
      dbg.fftDrawn = (dbg.fftDrawn || 0) + 1;
      dbg.fftMs = Math.round(ms);
      if (ms > (dbg.fftMsMax || 0)) dbg.fftMsMax = Math.round(ms);
    });
  }
  /* Frequency ruler drawn ON TOP of the spectrum (it was only on the waterfall, so the
     spectrum was "blind" while sliding). Rendered once per span into an offscreen strip
     and blitted, so it costs one drawImage per frame. It uses the same visCenterHz() as
     everything else, so it travels with the finger. */
  function spRuler(W) {
    var sig = W + "|" + Math.round(visCenterHz() || 0) + "|" + Math.round(visSpan() || 0) + "|" + (S.zoom || 1);
    if (!S.spRulerCv || S.spRulerSig !== sig) {
      if (!S.spRulerCv) S.spRulerCv = document.createElement("canvas");
      var hh = 16;
      S.spRulerCv.width = W; S.spRulerCv.height = hh;
      var oc = S.spRulerCv.getContext("2d");
      oc.clearRect(0, 0, W, hh);
      try { drawRuler(oc, W, hh, "top"); } catch (e) {}
      S.spRulerSig = sig;
    }
    return S.spRulerCv;
  }
  /* The frequency ruler as its own STRIP above the spectrum box - the owner asked for a
     ruler on top of the spectrum, not numbers inside it. Same geometry and the same
     visCenterHz(), so it travels with the finger exactly like the spectrum does. */
  function specRulerCanvas() {
    var cv = el("sdrSpecRuler");
    if (cv) return cv;
    var sp = el("sdrSpectrum");
    if (!sp || !sp.parentNode) return null;
    cv = document.createElement("canvas");
    cv.id = "sdrSpecRuler";
    cv.setAttribute("style", "display:block;width:100%;height:17px;box-sizing:border-box");
    /* keep it ABOVE the spectrum box, i.e. before the wrapper if there is one */
    var wrap = el("sdrSpecWrap");
    var before = (wrap && wrap.parentNode === sp.parentNode) ? wrap : sp;
    sp.parentNode.insertBefore(cv, before);
    return cv;
  }
  function drawSpecRulerStrip() {
    var cv = specRulerCanvas(), sp = el("sdrSpectrum");
    if (!cv || !sp || !S.center || !S.bw) return;
    var W = Math.max(120, sp.width || sp.clientWidth || 0);
    if (!W) return;
    if (cv.width !== W) cv.width = W;
    var H = 17;
    if (cv.height !== H) cv.height = H;
    var g = cv.getContext("2d");
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#04070c";
    g.fillRect(0, 0, W, H);
    try { g.drawImage(spRuler(W), 0, 0); } catch (e) {}
    g.strokeStyle = CENTRE_COLOUR;              /* red mark at the dial */
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
    dbg.specRuler = { w: W, h: H, present: true };
  }

  /* Repaint what the user sees without inventing a new waterfall row. */
  function repaintWaterfall() {
    if (!S.wctx || !S.hist || !S.water) return;
    var W = S.water.width, H = S.water.height;
    S.wctx.drawImage(S.hist, 0, 0, S.hist.width, H, 0, 0, W, H);
    S.wctx.save();
    S.wctx.strokeStyle = CENTRE_COLOUR;
    S.wctx.lineWidth = 1.4;
    S.wctx.beginPath(); S.wctx.moveTo(W / 2, 0); S.wctx.lineTo(W / 2, H); S.wctx.stroke();
    S.wctx.restore();
    drawOverlay(W, H);
  }
  var dispRaf = 0;
  function scheduleDisplay() {
    if (dispRaf) return;
    dispRaf = requestAnimationFrame(function () {
      dispRaf = 0;
      try { if (S.lastFft) drawSpectrum(S.lastFft); } catch (e) {}
      try { repaintWaterfall(); } catch (e) {}
      try { drawSpecRulerStrip(); } catch (e) {}
      dbg.shiftPx = Math.round(centreShiftPx(S.spec ? S.spec.width : 400));
    });
  }
  function drawWaterfall(f) {
    if (!S.hctx || !S.hist || !S.wctx) return;
    var bins = S.hist.width, H = S.hist.height, n = f.length;

    /* shift the history down one pixel, then write the new row on top */
    S.hctx.drawImage(S.hist, 0, 1);
    var img = S.rowImg;
    if (!img || img.width !== bins) {          /* allocate the row ONCE, not per frame */
      img = S.rowImg = S.hctx.createImageData(bins, 1);
      S.rowU32 = new Uint32Array(img.data.buffer);
    }
    var row = S.rowU32, tbl = WF_LUT32;
    /* same frequency-based mapping as the spectrum, so a sliding waterfall row is real data too */
    var _wvc = visCenterHz(), _wspan = visSpan();
    var _wLo = _wvc - _wspan / 2;
    var _wbwLo = (S.center || 0) - (S.bw || 0) / 2, _wbwSpan = S.bw || 1;
    for (var x = 0; x < bins; x++) {
      var _hz = _wLo + (x / bins) * _wspan;
      var bi = Math.round(((_hz - _wbwLo) / _wbwSpan) * (n - 1));
      if (!isFinite(bi)) bi = 0;
      if (bi < 0) bi = 0; else if (bi > n - 1) bi = n - 1;
      var i = bi;
      var v = (f[i] - S.wfMin) / ((S.wfMax - S.wfMin) || 1);
      v = v < 0 ? 0 : (v > 1 ? 1 : v);
      row[x] = tbl ? tbl[(v * 255) | 0] : packedFallback(v);
    }
    S.hctx.putImageData(img, 0, 0);

    var W = S.water.width;
    S.wctx.drawImage(S.hist, 0, 0, bins, H, 0, 0, W, H);
    /* the waterfall had no centre marker at all - only the cursor while tuning */
    S.wctx.save();
    S.wctx.strokeStyle = CENTRE_COLOUR;
    S.wctx.lineWidth = 1.4;
    S.wctx.beginPath(); S.wctx.moveTo(W / 2, 0); S.wctx.lineTo(W / 2, H); S.wctx.stroke();
    S.wctx.restore();
    drawOverlay(W, H);
  }

  /* The ruler labels and favourite markers only change when the span does, but they
     were redrawn every frame. Render them once into an offscreen canvas and blit. */
  function drawOverlay(W, H) {
    var sig = W + "|" + H + "|" + Math.round(S.center || 0) + "|" + Math.round(visCenterHz() || 0) +
              "|" + Math.round(S.bw || 0) +
              "|" + (S.zoom || 1) + "|" + (S.favs ? S.favs.length : 0) + "|" + Math.round(S.tuneAt * 100 || 0);
    if (!S.ovCv || S.ovSig !== sig) {
      if (!S.ovCv) S.ovCv = document.createElement("canvas");
      S.ovCv.width = W; S.ovCv.height = H;
      var oc = S.ovCv.getContext("2d");
      oc.clearRect(0, 0, W, H);
      /* the frequency ruler is OUT of the waterfall - the owner wants the frequencies in
         one place only (the strip above the spectrum), and fewer things to redraw */
      try { drawFavs(oc, W, H, false); } catch (e) {}
      S.ovSig = sig;
    }
    S.wctx.drawImage(S.ovCv, 0, 0);
  }


function drawSmeter() {
    var dbm = S.smeterDb + S.smeterOffset;
    var bar = el("sdrSmeterBar");
    if (bar) {
      var pct = (dbm + 127) / 114 * 100;
      pct = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
      bar.style.width = pct.toFixed(1) + "%";
    }
    var v = el("sdrSmeterVal");
    if (v) v.textContent = sLabel(dbToS(dbm));
    var mark = el("sdrSScaleMark");
    if (mark) mark.style.left = S.smeterDb === null ? "0%" :
      Math.max(0, Math.min(100, (S.smeterDb + S.smeterOffset + 127) / 114 * 100)).toFixed(1) + "%";
    var d = el("sdrDbm");
    if (d) d.textContent = dbm.toFixed(1) + " dBm";
  }

  /* ===================================================================
     KEYPAD  —  type a frequency straight in
     =================================================================== */
  function keypadOpen() {
    S.keys = "";
    S.keyOpen = true;
    var k = el("sdrKeys");
    if (k) k.textContent = "—";
    var p = el("sdrKeypad");
    if (p) p.classList.remove("hide");
  }
  function keypadClose() {
    S.keyOpen = false;
    var p = el("sdrKeypad");
    if (p) p.classList.add("hide");
  }
  function keyPress(ch) {
    if (!S.keyOpen) return;
    if (ch === "C") { S.keys = ""; }
    else if (ch === "<") { S.keys = S.keys.slice(0, -1); }
    else if (ch === "E") { keypadApply(); return; }
    else {
      if (ch === "." && S.keys.indexOf(".") >= 0) return;
      if (S.keys.length < 11) S.keys += ch;
    }
    var k = el("sdrKeys");
    if (k) k.textContent = S.keys || "—";
  }
  function keypadApply() {
    var t = S.keys.trim();
    if (!t) { keypadClose(); return; }
    var mhz = parseFloat(t);
    if (isFinite(mhz)) setFreq(mhz * 1e6, true);
    keypadClose();
  }

  /* ===================================================================
     MENU SHEET + WIRING
     =================================================================== */
  function sheetToggle(show) {
    var s = el("sdrSheet");
    if (!s) return;
    s.classList.toggle("hide", show === undefined ? !s.classList.contains("hide") : !show);
  }

  function clockTick() {
    var c = el("sdrClock");
    if (!c) return;
    var n = new Date();
    c.textContent = ("0" + n.getHours()).slice(-2) + ":" + ("0" + n.getMinutes()).slice(-2);
  }

  function wire() {
    if (S.ready) return;
    S.ready = true;

    /* saved state */
    try {
      var f = localStorage.getItem("sdr_freq");
      if (f) S.freq = +f;
      var m = localStorage.getItem("sdr_mode");
      if (m) {
        /* a previously saved display NAME ("FM") is not a valid id ("nfm") */
        var alias = { fm: "nfm", wfm: "wfm", bcfm: "bcfm" };
        S.mode = alias[m.toLowerCase()] || m.toLowerCase();
      }
      var o = localStorage.getItem("sdr_off");
      if (o !== null) S.smeterOffset = +o;
      var st = localStorage.getItem("sdr_step");
      if (st && +st > 0) S.step = +st;
      var zz = localStorage.getItem("sdr_zoom");
      if (zz && +zz >= 1) S.zoom = +zz;
      var wmin = localStorage.getItem("sdr_wfmin"), wmax = localStorage.getItem("sdr_wfmax");
      if (wmin !== null) S.wfMin = +wmin;
      if (wmax !== null) S.wfMax = +wmax;
      S.wfUser = localStorage.getItem("sdr_wfuser") === "1";
    } catch (e) {}

    buildPick();

    var pick = el("sdrPick");
    if (pick) pick.onchange = function () {
      S.pick = +pick.value;
      try { localStorage.setItem("sdr_pick", S.pick); } catch (e) {}
      if (S.pick >= 0) {
        var r = S.radios[S.pick];
        status("Selected " + (r.name || "") + " — press Power.");
        if (S.connected) connect();
      }
    };

    var up = el("sdrUp"), dn = el("sdrDn");
    if (up) up.onclick = function () { nudge(1); };
    if (dn) dn.onclick = function () { nudge(-1); };

    var fEl = el("sdrFreq");
    if (fEl) fEl.onclick = keypadOpen;          /* tap = type a frequency */
    wireFreqDigits();

    var kb = el("sdrKeys");   /* the readout doubles as a tap-to-type hint */
    if (kb) kb.onclick = keypadOpen;

    var pad = el("sdrPad");
    if (pad) pad.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { keyPress(b.dataset.k); };
    });
    var kc = el("sdrKeyClose");
    if (kc) kc.onclick = keypadClose;

    var mb = el("sdrMenuBtn");
    if (mb) mb.onclick = function () { sheetToggle(); };
    var sc = el("sdrSheetClose");
    if (sc) sc.onclick = function () { sheetToggle(false); };
    var mb2 = el("sdrMenuBtn2");
    if (mb2) mb2.onclick = function () { sheetToggle(); };

    var cb = el("sdrConnBtn");
    if (cb) cb.onclick = function () { S.connected ? disconnect() : connect(); };

    var vol = el("sdrVol");
    if (vol) vol.oninput = function () { setGain(+vol.value / 100); };

    var sq = el("sdrSquelch");
    if (sq) sq.oninput = function () { send({ type: "dspcontrol", params: { squelch_level: +sq.value } }); };

    var stepSel = el("sdrStepSel");
    if (stepSel) {
      stepSel.innerHTML = STEPS.map(function (s) {
        return '<option value="' + s + '"' + (s === S.step ? " selected" : "") + ">" +
               (STEP_LBL[s] || s + " Hz") + "</option>";
      }).join("");
      stepSel.onchange = function () {
        S.step = +stepSel.value;
        try { localStorage.setItem("sdr_step", S.step); } catch (e) {}
        drawFreq();
      };
    }

    var off = el("sdrOffset");
    if (off) {
      off.value = String(S.smeterOffset);
      off.oninput = function () {
        S.smeterOffset = +off.value;
        try { localStorage.setItem("sdr_off", S.smeterOffset); } catch (e) {}
        drawSmeter();
      };
    }

    var bands = el("sdrBands");
    if (bands) bands.innerHTML = BANDS.map(function (b) {
      return '<button type="button" class="sband" data-hz="' + b[1] + '">' + b[0] + "</button>";
    }).join("");
    if (bands) bands.querySelectorAll(".sband").forEach(function (b) {
      b.onclick = function () { setFreq(+b.dataset.hz, true); setMode("am", true); sheetToggle(false); };
    });

    setModes(FALLBACK_MODES);
    drawFreq();
    drawSmeter();
    drawScale();
    layoutCanvases();
    clockTick();
    setInterval(clockTick, 20000);

    window.addEventListener("resize", function () { layoutCanvases(); try { autoFit(); } catch (e) {} });
    status("Pick a receiver at the top, then press Power.");
  }


  /* ---------- favourite star right beside the frequency ----------
     The owner wants to star the frequency he is listening to without hunting for the Save button:
     one tap adds the tuned frequency+mode, another removes it. favBadge() already runs on every
     tune, so the star's state is driven from there and can never go stale. */
  function buildFavStar() {
    var row = document.querySelector("#sdrView .sdr-freqrow");
    if (!row || el("sdrFavStar")) return;
    var box = row.querySelector(".sdr-freqbox");
    var b = document.createElement("button");
    b.type = "button";
    b.id = "sdrFavStar";
    b.className = "sdr-favstar";
    b.textContent = "\u2606";
    b.title = "Save this frequency to favourites";
    b.onclick = function (ev) {
      ev.stopPropagation();
      var hit = favFind(S.freq, S.mode);
      if (hit) favRemove(S.freq, S.mode); else favAdd(S.freq, fmtShort(S.freq), S.mode);
      S.ovSig = null;                 /* force the marker layer to redraw at once */
      favBadge();
      favRender();
    };
    if (box && box.parentNode) box.parentNode.insertBefore(b, box.nextSibling);
    else row.appendChild(b);
  }
  function favStarSync() {
    var b = el("sdrFavStar");
    if (!b) return;
    var here = favFind(S.freq, S.mode);
    var want = here ? "\u2605" : "\u2606";
    if (b.textContent !== want) b.textContent = want;
    b.classList.toggle("on", !!here);
    b.title = here ? "Remove from favourites" : "Save this frequency to favourites";
  }

  /* ---------- automatic scaling ----------
     Phones, tablets and desktops all differ, and the frequency readout is the one thing that must
     never clip: the last digit used to wrap onto a second line once the star took its width. So
     the readout is sized from the space it actually has (measure the text, scale the font), and
     the surrounding chrome scales from one ratio K derived from the panel width. Nothing is
     hard-coded per device - it re-measures on every show and resize. */
  var _mc = null;
  function _measureCtx() {
    if (!_mc) { try { _mc = document.createElement("canvas").getContext("2d"); } catch (e) { _mc = null; } }
    return _mc;
  }
  function sdrRatio() {
    var host = document.getElementById("sdrView") || document.body;
    var w = host.clientWidth || 420;
    return Math.max(0.80, Math.min(1, w / 420));
  }
  function fitFreqFont() {
    var f = el("sdrFreq");
    if (!f || !f.parentNode) return;
    var box = f.parentNode;
    var avail = (box.clientWidth || box.offsetWidth) - 4;
    if (avail < 40) return;
    /* Measure the ACTUAL text with a Range after pinning the font to a reference size. A canvas
       measureText with a css font-family shorthand silently fell back to 10px sans, so "measure"
       was meaningless and every screen clamped to the maximum (which then still wrapped). */
    var REF = 40;
    f.style.setProperty("font-size", REF + "px", "important");
    f.style.setProperty("white-space", "nowrap", "important");
    var nat = 1;
    try {
      var r = document.createRange();
      r.selectNodeContents(f);
      nat = r.getBoundingClientRect().width || 1;
    } catch (e) {}
    var size = Math.floor(REF * (avail / nat) * 0.97);
    if (!isFinite(size) || size <= 0) size = REF;
    size = Math.max(16, Math.min(56, size));
    f.style.setProperty("font-size", size + "px", "important");
    dbg.freqFitFit = { avail: Math.round(avail), naturalAt40: Math.round(nat), size: size };
  }
  function scaleChrome() {
    var K = sdrRatio();
    var tr = document.querySelector("#sdrView .sdr-track");
    if (tr) tr.style.setProperty("height", Math.round(27 * K) + "px", "important");
    var star = el("sdrFavStar");
    if (star) { star.style.width = star.style.height = Math.round(36 * K) + "px";
                star.style.fontSize = Math.round(20 * K) + "px"; }
    var rounds = document.querySelectorAll("#sdrView .sdr-round");
    for (var i = 0; i < rounds.length; i++) {
      rounds[i].style.width = rounds[i].style.height = Math.round(34 * K) + "px";
      rounds[i].style.fontSize = Math.round(24 * K) + "px";
    }
    var mbtn = document.querySelectorAll("#sdrView .sdr-modes button");
    for (var j = 0; j < mbtn.length; j++)
      mbtn[j].style.setProperty("font-size", (11.5 * K).toFixed(1) + "px", "important");
    var sub = document.querySelector("#sdrView .sdr-sub");
    if (sub) sub.style.setProperty("font-size", (10.5 * K).toFixed(1) + "px", "important");
    dbg.ratio = Math.round(K * 100);
  }
  function autoFit() { try { scaleChrome(); fitFreqFont(); } catch (e) {} }

  /* self-adjusting: watch the panel itself, so ANY size change (phone, tablet, rotation,
     desktop resize) re-fits the frequency and the chrome without a hard-coded breakpoint */
  function startAutoFit() {
    try { patchSpectrumForSql(); } catch (e) {}
    var host = document.getElementById("sdrView");
    if (!host) return;
    autoFit();
    if (window.ResizeObserver && !window.sdrAutoFitObserver) {
      window.sdrAutoFitObserver = new ResizeObserver(function () { try { autoFit(); } catch (e) {} });
      window.sdrAutoFitObserver.observe(host);
    }
    if (!window.__afTimers) {
      window.__afTimers = [setTimeout(autoFit, 120), setTimeout(autoFit, 600), setTimeout(autoFit, 1600)];
    }
  }

  /* ================= favourites-only scanner =================
     Scans ONLY saved favourites, in frequency order - the owner keeps police/fire channels on 800MHz
     and wants to sit on those instead of stepping through every frequency. It tunes with the same
     setFreq/setMode the UI uses, dwells briefly on each, and HOLDS when the channel is busy (read
     from the S-meter fill), so a live transmission is not cut off. */
  var SCAN = { on: false, i: 0, timer: null, dwellMs: 1600, minPct: 12, lastFreq: 0, hits: 0,
               carrier: false, quiet: 0, forcePct: null, forceDb: null,
               mode: "carrier", secs: 3 };

  /* ---------- scan resume mode + a findable favourites button ----------
     The owner could not find the favourites list at all: its only button lived in the audio panel.
     It now has a button in the scanner row AND a row inside the hamburger menu, and the list shows
     a check mark per favourite for "scan this one". Resume follows the RADIO's squelch: while the
     audio is being squelched (nothing there) it keeps scanning; the moment the squelch opens it
     stops and stays - or stays a programmable number of seconds in timed mode. */
  function squelchDb() { var q = el("sdrSquelch"); var v = q ? +q.value : -150; return isFinite(v) ? v : -150; }
  function busyNow() {
    if (SCAN.forceDb !== null && SCAN.forceDb !== undefined) return SCAN.forceDb >= squelchDb();
    var sq = squelchDb();
    if (S.kiwi && S.squelched !== undefined && sq > -149) return !S.squelched;   /* the radio's own gate */
    if (sq > -149) return (S.smeterDb || -150) >= sq;
    return scanSignalPct() >= SCAN.minPct;
  }
  function scanModeLoad() {
    try {
      var m = localStorage.getItem("sdr_scan_mode"); if (m === "timed" || m === "carrier") SCAN.mode = m;
      var s = +localStorage.getItem("sdr_scan_secs"); if (isFinite(s) && s >= 1 && s <= 60) SCAN.secs = s;
    } catch (e) {}
  }
  function scanModeSave() {
    try { localStorage.setItem("sdr_scan_mode", SCAN.mode); localStorage.setItem("sdr_scan_secs", String(SCAN.secs)); } catch (e) {}
    scanModeLabel();
  }
  function scanModeLabel() {
    var t = el("sdrScanMode");
    if (t) t.textContent = SCAN.mode === "timed" ? SCAN.secs + "s" : "carrier";
    var sel = el("sdrScanResume"), num = el("sdrScanSecs");
    if (sel && sel.value !== SCAN.mode) sel.value = SCAN.mode;
    if (num && +num.value !== SCAN.secs) num.value = String(SCAN.secs);
  }
  function buildScanSettings() {
    var sheet = el("sdrSheet");
    if (!sheet || el("sdrScanResume")) return;
    var r1 = document.createElement("div"); r1.className = "sdr-row";
    r1.innerHTML = '<label>Scan resume</label><select id="sdrScanResume">' +
      '<option value="carrier">Carrier - hold until signal gone</option>' +
      '<option value="timed">Timed - hold N seconds</option></select>';
    var r2 = document.createElement("div"); r2.className = "sdr-row";
    r2.innerHTML = '<label>Hold seconds</label><input id="sdrScanSecs" type="number" min="1" max="60" value="3">';
    var r3 = document.createElement("div"); r3.className = "sdr-row";
    r3.innerHTML = '<label>Favourites</label><button type="button" id="sdrFavOpenMenu" class="mini">\u2605 Open list</button>';
    sheet.appendChild(r1); sheet.appendChild(r2); sheet.appendChild(r3);
    el("sdrScanResume").onchange = function () { SCAN.mode = this.value; scanModeSave(); };
    el("sdrScanSecs").onchange = function () { var v = +this.value; if (v >= 1 && v <= 60) SCAN.secs = v; else this.value = String(SCAN.secs); scanModeSave(); };
    el("sdrFavOpenMenu").onclick = function (ev) { ev.stopPropagation(); sheetToggle(false); favOpen(); };
    scanModeLabel();
  }
  function scanSignalPct() {
    if (SCAN.forcePct !== null && SCAN.forcePct !== undefined) return SCAN.forcePct;  /* test hook */
    var bar = el("sdrSmeterBar"), tr = document.querySelector("#sdrView .sdr-track");
    if (!bar || !tr) return 0;
    var tw = tr.clientWidth || 0;
    if (!tw) return 0;
    return (bar.getBoundingClientRect().width / tw) * 100;
  }
  function scanFavs() {   /* only favourites marked SCAN (missing flag = scannable) */
    var g = scanGroup();
    return favList().filter(function (f) {
        if (f.scan === false) return false;
        return g === "ALL" || favGroupName(f) === g;
      }).sort(function (a, b) { return a.hz - b.hz; });
  }
  function scanInfo(txt, hot) {
    var i = el("sdrScanInfo");
    if (!i) return;
    i.textContent = txt;
    i.className = hot ? "hot" : "";
  }
  function scanStep() {
    if (!SCAN.on) return;
    var host = el("sdrView");
    if (!host || host.classList.contains("hide")) return scanStop();
    var l = scanFavs();
    if (!l.length) return scanStop("Nothing marked SCAN - open your favourites and turn SCAN on");
    if (SCAN.i >= l.length) SCAN.i = 0;
    var f = l[SCAN.i];
    SCAN.lastFreq = Math.round(f.hz);
    try { setFreq(f.hz, true); } catch (e) {}
    try { if (f.mode) setMode(f.mode, true); } catch (e) {}
    SCAN.carrier = false; SCAN.quiet = 0;
    scanLine(f, 0, false);
    /* give the channel a moment to reveal a carrier, then move on if it stays quiet */
    SCAN.timer = setTimeout(scanPulse, SCAN.dwellMs);
  }
  /* carrier resume: sitting on a channel that is talking means STAY, and only move on once the
     signal has actually gone (-two quiet reads in a row-), then a short pause before the next */
  function scanPulse() {
    if (!SCAN.on) return;
    var host = el("sdrView");
    if (!host || host.classList.contains("hide")) return scanStop();
    var l = scanFavs();
    var f = l[SCAN.i] || {};
    var busy = busyNow();
    if (busy) {
      scanLine(f, scanSignalPct(), true);
      if (SCAN.mode === "timed" && !SCAN.carrier) {
        /* timed: stay exactly the programmed time, then move on regardless */
        SCAN.carrier = true;
        SCAN.timer = setTimeout(function () {
          scanLine(f, 0, false, "held " + SCAN.secs + "s \u2014 next");
          SCAN.carrier = false;
          SCAN.timer = setTimeout(function () { SCAN.i++; scanStep(); }, 600);
        }, SCAN.secs * 1000);
      } else {
        SCAN.carrier = true; SCAN.quiet = 0;
        SCAN.timer = setTimeout(scanPulse, 300);   /* carrier: keep listening */
      }
      return;
    }
    if (SCAN.carrier) {
      SCAN.quiet++;
      if (SCAN.quiet < 2) { SCAN.timer = setTimeout(scanPulse, 400); return; }
      scanLine(f, 0, false, "signal gone \u2014 next");
      SCAN.carrier = false;
      SCAN.timer = setTimeout(function () { SCAN.i++; scanStep(); }, 1200);
      return;
    }
    SCAN.timer = setTimeout(function () { SCAN.i++; scanStep(); }, SCAN.dwellMs);
  }
  function scanLine(f, pct, busy, note) {
    var l = scanFavs();
    var head = (SCAN.i + 1) + "/" + l.length + "  " + fmtShort(f.hz || S.freq) + " " +
               String(f.mode || S.mode).toUpperCase() + "  " + (f.name || "");
    scanInfo(head + (busy ? "   \u25b6 SIGNAL " + Math.round(pct) + "% \u2014 holding" :
                     (note ? "   " + note : "")), !!busy);
  }
  function scanStart() {
    if (SCAN.on) return;
    var l = scanFavs();
    if (!l.length) { scanInfo("No favourites saved - tap the \u2606 star beside the frequency first"); return; }
    SCAN.on = true; SCAN.i = 0; SCAN.hits = 0;
    var b = el("sdrScanBtn");
    if (b) { b.textContent = "\u25a0 STOP"; b.classList.add("on"); }
    scanStep();
  }
  function scanStop(msg) {
    SCAN.on = false;
    if (SCAN.timer) { clearTimeout(SCAN.timer); SCAN.timer = null; }
    var b = el("sdrScanBtn");
    if (b) { b.textContent = "\u25b6 SCAN FAVS"; b.classList.remove("on"); }
    var n = scanFavs().length;
    var all = favList().length;
    scanInfo(msg || (n ? n + " of " + all + " favourites marked SCAN \u00b7 tap to start" +
                         (SCAN.hits ? "  (" + SCAN.hits + " active)" : "") :
                       (all ? "no favourites marked SCAN - open \u2605 favourites and tap SKIP/SCAN"
                            : "No favourites yet")));
  }
  function scanToggle() { if (SCAN.on) scanStop(); else scanStart(); }
  function buildScanPanel() {
    var host = el("sdrView");
    if (!host || el("sdrScan")) return;
    var box = document.createElement("div");
    box.id = "sdrScan";
    box.className = "sdr-scan";
    box.innerHTML = '<button type="button" id="sdrScanBtn">\u25b6 SCAN FAVS</button>' +
                    '<button type="button" id="sdrFavOpenScan">\u2605 FAVS</button>' +
                    '<button type="button" id="sdrScanGrp">ALL banks</button>' +
                    '<span id="sdrScanInfo"></span>' +
                    '<b id="sdrScanMode"></b>';
    host.appendChild(box);
    el("sdrScanBtn").onclick = function (ev) { ev.stopPropagation(); scanToggle(); };
    el("sdrFavOpenScan").onclick = function (ev) { ev.stopPropagation(); favOpen(); };
    el("sdrScanGrp").onclick = function (ev) { ev.stopPropagation(); grpSheetOpen("scan"); };
    scanModeLoad(); scanModeLabel(); scanStop();
  }
  /* ================= readable receiver picker =================
     The native <select> clipped its text on the phone (OS text scaling) and is unusable with
     hundreds of receivers. This draws our own button in the same row plus a full-screen list with
     a search box; picking a row sets the real <select> and fires its change event, so every bit of
     the app's existing selection logic keeps working untouched. */
  function pickLabel() {
    var sel = el("sdrPick");
    if (!sel) return "";
    var o = sel.options[sel.selectedIndex];
    return o ? String(o.textContent || "").replace(/^\s*\u2014\s*|\s*\u2014\s*$/g, "") : "";
  }
  function syncPickBtn() {
    var sel = el("sdrPick"), btn = el("sdrPickBtn");
    if (!sel || !btn) return;
    var lbl = pickLabel() || "pick a receiver";
    var s = btn.firstElementChild;
    if (s && s.textContent !== lbl) s.textContent = lbl;
    var cur = sel.selectedIndex;
    if (btn.dataset.idx !== String(cur)) btn.dataset.idx = String(cur);
  }
  function pickSheetRender(filter) {
    var list = el("sdrPickList"), sel = el("sdrPick");
    if (!list || !sel) return;
    var f = String(filter || "").toLowerCase(), out = "", n = 0;
    for (var i = 0; i < sel.options.length; i++) {
      var txt = String(sel.options[i].textContent || "");
      if (i === 0 && /pick a receiver/i.test(txt)) continue;      /* the placeholder is not a choice */
      if (f && txt.toLowerCase().indexOf(f) < 0) continue;
      var tag = /kiwi/i.test(txt) ? '<b>Kiwi</b>' : '';
      out += '<div class="sdr-pickrow' + (i === sel.selectedIndex ? " cur" : "") + '" data-i="' + i + '">' +
             tag + '<span>' + txt.replace(/</g, "&lt;") + '</span></div>';
      n++;
      if (n > 900) break;
    }
    list.innerHTML = out || '<div class="sdr-pickrow">no match</div>';
    list.querySelectorAll(".sdr-pickrow").forEach(function (r) {
      r.onclick = function () {
        var i2 = +r.dataset.i;
        if (!isFinite(i2)) return;
        sel.selectedIndex = i2;
        try { sel.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
        syncPickBtn();
        pickSheetClose();
      };
    });
  }
  function pickSheetOpen() {
    var sh = el("sdrPickSheet");
    if (!sh) return;
    sh.classList.remove("hide");
    var s = el("sdrPickSearch");
    if (s) { s.value = ""; }
    pickSheetRender("");
    if (s) { try { s.focus(); } catch (e) {} }
  }
  function pickSheetClose() { var sh = el("sdrPickSheet"); if (sh) sh.classList.add("hide"); }
  function buildPickSheet() {
    var row = document.querySelector("#sdrView .sdr-top"), sel = el("sdrPick");
    if (!row || !sel || el("sdrPickBtn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "sdrPickBtn";
    btn.innerHTML = "<span></span><i>\u25be</i>";
    btn.onclick = function (ev) { ev.stopPropagation(); pickSheetOpen(); };
    row.insertBefore(btn, sel);
    sel.classList.add("sdr-pick-native");                        /* hidden, still owns the state */
    var sheet = document.createElement("div");
    sheet.id = "sdrPickSheet";
    sheet.className = "sdr-picksheet hide";
    sheet.innerHTML = '<div class="sdr-pickhead"><input id="sdrPickSearch" type="search" ' +
      'placeholder="search receivers" autocomplete="off"><button type="button" id="sdrPickClose">\u2715</button></div>' +
      '<div id="sdrPickList"></div>';
    document.body.appendChild(sheet);
    el("sdrPickClose").onclick = pickSheetClose;
    el("sdrPickSearch").oninput = function () { pickSheetRender(this.value); };
    syncPickBtn();
  }
  function pickerTick() { try { buildPickSheet(); buildScanPanel(); buildLiveSliders(); syncLiveSliders(); drawSqlMark(); syncPickBtn();   buildScanSettings(); scanModeLabel();
    buildGrpSheet(); buildGrpSettings(); scanGrpLabel();
    var lb = el("sdrFavList");
    if (lb && !lb.classList.contains("hide")) {
      var sig = lb.offsetWidth + ":" + (el("sdrFavBody") ? el("sdrFavBody").querySelectorAll(".fav-row").length : 0);
      if (sig !== window.__favSig) { window.__favSig = sig; fitFavList(); }
    }
  } catch (e) {} }

  /* The list must NOT grow with the number of favourites: it is a fixed box about five rows tall
     and everything beyond that lives behind a scrollbar you can drag with a mouse. */
  var FAV_VISIBLE_ROWS = 5;
  function fitFavList() {
    var list = el("sdrFavList"), body = el("sdrFavBody");
    if (!list || !body || list.classList.contains("hide")) return;
    var rows = body.querySelectorAll(".fav-row");
    var head = list.querySelector(".fav-head");
    var hh = head ? head.offsetHeight : 0;
    var rh = rows.length ? (rows[0].offsetHeight || 46) : 44;
    var shown = Math.min(rows.length || 1, FAV_VISIBLE_ROWS);
    /* size the SCROLL AREA to exactly N rows: the box then wraps it (header included) and never
       grows with the list, whatever the header does or how many favourites exist */
    body.style.setProperty("height", (shown * rh + 22) + "px", "important");  /* +22 = bottom padding, so a short list does not fake an overflow */
    body.style.setProperty("flex", "0 0 auto", "important");
    list.style.setProperty("max-height", "none", "important");
    list.style.height = "auto";
    try { buildFavBar(); favBarApply(); } catch (e) {}
    dbg.favBox = { rows: rows.length, rowH: rh, headH: hh, boxH: Math.round(list.offsetHeight),
                   shownRows: shown, scrollable: body.scrollHeight > body.clientHeight + 2 };
  }

  /* A finger/mouse-draggable scrollbar. Android WebView ignores ::-webkit-scrollbar, so the only
     way to give a real bar you can grab is to draw one and drive scrollTop from it. */
  function buildFavBar() {
    var list = el("sdrFavList"), body = el("sdrFavBody");
    if (!list || !body) return;
    var bar = el("sdrFavBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "sdrFavBar";
      bar.innerHTML = '<div id="sdrFavThumb"></div>';
      list.appendChild(bar);
      body.addEventListener("scroll", function () { favBarApply(); }, { passive: true });
    }
    var thumb = el("sdrFavThumb");
    var dragging = false, startY = 0, startTop = 0;
    function scrollRange() { return Math.max(0, body.scrollHeight - body.clientHeight); }
    function place() {
      bar.style.top = body.offsetTop + "px";
      bar.style.height = body.clientHeight + "px";
    }
    thumb.onpointerdown = function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      dragging = true; startY = ev.clientY;
      startTop = parseFloat(thumb.style.top) || 0;
      thumb.classList.add("drag");
      try { thumb.setPointerCapture(ev.pointerId); } catch (e) {}
    };
    thumb.onpointermove = function (ev) {
      if (!dragging) return;
      var track = bar.clientHeight, th = thumb.offsetHeight;
      var maxTop = Math.max(1, track - th), range = scrollRange();
      var top = Math.max(0, Math.min(maxTop, startTop + (ev.clientY - startY)));
      thumb.style.top = top + "px";
      body.scrollTop = (top / maxTop) * range;
    };
    function endDrag() { dragging = false; thumb.classList.remove("drag"); }
    thumb.onpointerup = endDrag; thumb.onpointercancel = endDrag; window.__favBarEnd = endDrag;
    bar.onpointerdown = function (ev) {           /* tapping the track jumps to that spot */
      if (ev.target === thumb) return;
      var r = bar.getBoundingClientRect(), th = thumb.offsetHeight;
      var top = Math.max(0, Math.min(bar.clientHeight - th, ev.clientY - r.top - th / 2));
      thumb.style.top = top + "px";
      body.scrollTop = (top / Math.max(1, bar.clientHeight - th)) * scrollRange();
    };
  }
  function favBarApply() {
    var list = el("sdrFavList"), body = el("sdrFavBody"), bar = el("sdrFavBar"), thumb = el("sdrFavThumb");
    if (!list || !body || !bar || !thumb || list.classList.contains("hide")) return;
    var range = body.scrollHeight - body.clientHeight;
    if (range <= 2) { bar.style.display = "none"; return; }
    bar.style.display = "block";
    bar.style.top = body.offsetTop + "px";
    bar.style.height = body.clientHeight + "px";
    var track = bar.clientHeight || 1;
    var th = Math.max(36, Math.round(body.clientHeight / body.scrollHeight * track));
    thumb.style.height = th + "px";
    var maxTop = Math.max(1, track - th);
    thumb.style.top = Math.round(body.scrollTop / range * maxTop) + "px";
    dbg.favBar = { range: range, track: track, thumb: th, top: Math.round(body.scrollTop / range * maxTop) };
  }

  /* ================= favourite names + groups/banks =================
     Two gaps the owner hit: a favourite always showed the frequency as its name, and there was no
     way to sort favourites into banks ("Police", "Ambulance", ...) so the scanner could work one
     bank at a time. Groups live in sdr_scan_groups; each favourite carries a grp name; renaming a
     group rewrites every favourite that referenced the old name. */
  var GRP_KEY = "sdr_scan_groups", GRP_SEL = "sdr_scan_group";
  var DEFAULT_GROUPS = ["Group 1", "Group 2", "Group 3", "Group 4"];
  function groupsList() {
    try {
      var a = JSON.parse(localStorage.getItem(GRP_KEY) || "[]");
      if (Array.isArray(a) && a.length) return a.map(function (x) { return String(x); });
    } catch (e) {}
    return DEFAULT_GROUPS.slice();
  }
  function groupsStore(a) { try { localStorage.setItem(GRP_KEY, JSON.stringify(a)); } catch (e) {} }
  function favGroupName(f) {
    var g = String((f && f.grp) || "").trim();
    var l = groupsList();
    return g && l.indexOf(g) >= 0 ? g : l[0];
  }
  function setFavGroup(hz, mode, name) {
    var hit = favFind(hz, mode);
    if (!hit) return;
    var l = favList();
    l[hit.i].grp = name;
    favStore(l);
    favRender();
  }
  function renameFav(hz, mode, name) {
    var hit = favFind(hz, mode);
    if (!hit) return;
    var l = favList();
    l[hit.i].name = String(name || "").slice(0, 40) || fmtShort(l[hit.i].hz);
    favStore(l);
    favRender();
  }
  function scanGroup() { try { return localStorage.getItem(GRP_SEL) || "ALL"; } catch (e) { return "ALL"; } }
  function setScanGroup(n) {
    try { localStorage.setItem(GRP_SEL, String(n || "ALL")); } catch (e) {}
    scanGrpLabel();
    var was = SCAN.on; if (was) { scanStop(); scanStart(); } else scanStop();
  }
  function scanGrpLabel() {
    var b = el("sdrScanGrp");
    if (b) b.textContent = scanGroup() === "ALL" ? "ALL banks" : scanGroup();
  }
  function grpCount(n) {
    return favList().filter(function (f) { return f.scan !== false && favGroupName(f) === n; }).length;
  }
  function groupsRenamed(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    var l = favList(), touched = false;
    l.forEach(function (f) { if (String(f.grp || "") === oldName) { f.grp = newName; touched = true; } });
    if (touched) favStore(l);
    if (scanGroup() === oldName) { try { localStorage.setItem(GRP_SEL, newName); } catch (e) {} }
    scanGrpLabel();
  }
  /* --- the picker: assign a favourite to a bank, or choose the bank to scan --- */
  var GRP_MODE = { kind: "assign", hz: 0, mode: "" };
  function grpSheetOpen(kind, hz, mode) {
    GRP_MODE = { kind: kind, hz: hz || 0, mode: mode || "" };
    var sh = el("sdrGrpSheet");
    if (!sh) return;
    sh.classList.remove("hide");
    grpSheetRender();
  }
  function grpSheetClose() { var sh = el("sdrGrpSheet"); if (sh) sh.classList.add("hide"); }
  function grpSheetRender() {
    var list = el("sdrGrpList");
    if (!list) return;
    var l = groupsList(), cur = GRP_MODE.kind === "scan" ? scanGroup() : "";
    var html = "";
    if (GRP_MODE.kind === "scan") {      /* "ALL" is a scan choice, not a bank to file a station in */
      html += '<div class="grp-row' + (cur === "ALL" ? " cur" : "") + '" data-g="ALL">' +
              '<span>ALL banks</span><small>' + favList().filter(function (f) { return f.scan !== false; }).length +
              ' stations</small></div>';
    }
    l.forEach(function (g) {
      var isCur = (GRP_MODE.kind === "scan") ? (cur === g) : false;
      html += '<div class="grp-row' + (isCur ? " cur" : "") + '" data-g="' + g.replace(/"/g, "&quot;") + '">' +
              '<span>' + g.replace(/</g, "&lt;") + '</span><small>' + grpCount(g) + ' scanning</small></div>';
    });
    if (GRP_MODE.kind === "assign") {
      html += '<div class="grp-row" data-g="__new"><span>\u002b New bank\u2026</span><small></small></div>';
    }
    list.innerHTML = html;
    list.querySelectorAll(".grp-row").forEach(function (r) {
      r.onclick = function () {
        var g = r.dataset.g;
        if (g === "__new") {
          var n = window.prompt("New bank name", "Bank " + (groupsList().length + 1));
          if (!n) return;
          var a = groupsList();
          if (a.indexOf(n) < 0 && a.length < 8) a.push(String(n).slice(0, 24));
          groupsStore(a);
          if (GRP_MODE.kind === "assign") setFavGroup(GRP_MODE.hz, GRP_MODE.mode, String(n).slice(0, 24));
          grpSheetRender();
          return;
        }
        if (GRP_MODE.kind === "scan") { setScanGroup(g); grpSheetClose(); }
        else { setFavGroup(GRP_MODE.hz, GRP_MODE.mode, g); grpSheetClose(); }
      };
    });
  }
  function buildGrpSheet() {
    if (el("sdrGrpSheet")) return;
    var sh = document.createElement("div");
    sh.id = "sdrGrpSheet";
    sh.className = "sdr-picksheet hide";
    sh.innerHTML = '<div class="sdr-pickhead"><b id="sdrGrpTitle">Bank</b>' +
                   '<button type="button" id="sdrGrpClose">\u2715</button></div><div id="sdrGrpList"></div>';
    document.body.appendChild(sh);
    el("sdrGrpClose").onclick = grpSheetClose;
  }
  /* --- bank names, editable, in the hamburger menu --- */
  function buildGrpSettings() {
    var sheet = el("sdrSheet");
    if (!sheet || el("sdrGrpNames")) return;
    var box = document.createElement("div");
    box.id = "sdrGrpNames";
    box.innerHTML = '<div class="sdr-row"><label>Banks</label><small id="sdrGrpHint">tap a name to rename</small></div><div id="sdrGrpInputs"></div>';
    sheet.appendChild(box);
    grpInputsRender();
  }
  function grpInputsRender() {
    var host = el("sdrGrpInputs");
    if (!host) return;
    var l = groupsList();
    host.innerHTML = l.map(function (g, i) {
      return '<div class="sdr-row"><input type="text" data-i="' + i + '" value="' + g.replace(/"/g, "&quot;") + '">' +
             '<button type="button" class="mini grp-del" data-i="' + i + '">\u2715</button></div>';
    }).join("") + '<div class="sdr-row"><label></label><button type="button" class="mini" id="sdrGrpAdd">\u002b Add bank</button></div>';
    host.querySelectorAll("input[data-i]").forEach(function (inp) {
      inp.onchange = function () {
        var i = +inp.dataset.i, l2 = groupsList(), old = l2[i];
        var n = String(inp.value || "").trim().slice(0, 24);
        if (!n) { inp.value = old; return; }
        if (l2.indexOf(n) >= 0 && l2.indexOf(n) !== i) { inp.value = old; return; }
        l2[i] = n;
        groupsStore(l2);
        groupsRenamed(old, n);
        favRender();
        grpInputsRender();
      };
    });
    host.querySelectorAll(".grp-del").forEach(function (b) {
      b.onclick = function () {
        var i = +b.dataset.i, l2 = groupsList();
        if (l2.length <= 1) return;
        var old = l2[i];
        l2.splice(i, 1);
        groupsStore(l2);
        var l3 = favList();
        l3.forEach(function (f) { if (String(f.grp || "") === old) f.grp = l2[0]; });
        favStore(l3);
        if (scanGroup() === old) { try { localStorage.setItem(GRP_SEL, l2[0]); } catch (e) {} }
        grpInputsRender(); favRender(); scanGrpLabel();
      };
    });
    var add = el("sdrGrpAdd");
    if (add) add.onclick = function () {
      var l2 = groupsList();
      if (l2.length >= 8) return;
      l2.push("Group " + (l2.length + 1));
      groupsStore(l2);
      grpInputsRender();
    };
  }

  /* ================= squelch line on the spectrum =================
     Other SDRs draw the squelch threshold across the spectrum so you can see where the gate sits
     against the noise. The squelch slider is in the same dB units as the spectrum window
     (S.wfMin..S.wfMax), so the line is just that value mapped to a y position. Wrapped around the
     existing draw so it lands on top of the trace every frame. */
  function drawSqlLine() {
    var sp = el("sdrSpectrum");
    if (!sp || !S.sctx) return;
    var g = S.sctx, W = sp.width, H = sp.height;
    var sql = squelchDb();
    var q = el("sdrSquelch");
    var lo = q ? +q.min : -150;
    var off = (q && +q.value <= lo + 1);
    if (off || !isFinite(sql)) {
      /* switching the squelch off must clear the line at once - on the next frame it would already be
         gone, but the canvas keeps the last painted line until then */
      if (S._sqlLineDrawn) {
        S._sqlLineDrawn = false;
        if (S.lastFft) { try { drawSpectrum(S.lastFft); } catch (e) {} }
        else if (S._sqlLineY != null) { try { g.clearRect(0, Math.round(S._sqlLineY) - 9, W, 13); } catch (e) {} }
      }
      dbg.sqlLine = { off: true }; return;
    }
    var span = (S.wfMax - S.wfMin) || 1;
    var v = (sql - S.wfMin) / span;
    if (v < 0) v = 0; if (v > 1) v = 1;
    var y = H - v * (H - 2);
    g.save();
    g.setLineDash([5, 4]);
    g.lineWidth = 1.6;
    g.strokeStyle = "rgba(255,204,85,.9)";
    g.beginPath();
    g.moveTo(0, Math.round(y) + 0.5);
    g.lineTo(W, Math.round(y) + 0.5);
    g.stroke();
    g.setLineDash([]);
    var lbl = "SQL " + Math.round(sql) + " dB";
    g.font = "700 10px ui-monospace, Consolas, monospace";
    var tw = g.measureText(lbl).width;
    var bx = Math.max(2, W - tw - 8);
    g.fillStyle = "rgba(8,12,18,.78)";
    g.fillRect(bx - 3, Math.round(y) - 9, tw + 6, 11);
    g.fillStyle = "#ffcc55";
    g.fillText(lbl, bx, Math.round(y) - 1);
    g.restore();
    dbg.sqlLine = { sql: sql, y: Math.round(y), wfMin: S.wfMin, wfMax: S.wfMax, off: false };
  }

  /* squelch marker on the S-meter: the slider is in the same server-side dB the meter reports, so
     converting through the S-meter offset puts the mark exactly where the gate opens on the S scale */
  function drawSqlMark() {
    var tr = document.querySelector("#sdrView .sdr-track");
    if (!tr) return;
    var q = el("sdrSquelch");
    var mark = el("sdrSqlMark");
    if (!q || +q.value <= (+q.min + 1)) { if (mark) mark.style.display = "none"; dbg.sqlMark = { off: true }; return; }
    var dbm = (+q.value) + (S.smeterOffset || 0);
    var pct = ((dbm + 127) / 114) * 100;
    if (!isFinite(pct) || pct < 1 || pct > 99) { if (mark) mark.style.display = "none"; dbg.sqlMark = { out: Math.round(pct) }; return; }
    if (!mark) {
      mark = document.createElement("b");
      mark.id = "sdrSqlMark";
      mark.setAttribute("style", "position:absolute;top:0;bottom:0;width:2px;background:#ffcc55;" +
        "box-shadow:0 0 4px rgba(255,204,85,.75);z-index:5;pointer-events:none");
      tr.appendChild(mark);
    }
    mark.style.display = "block";
    mark.style.left = Math.round((pct / 100) * (tr.clientWidth || 0) - 1) + "px";
    dbg.sqlMark = { pct: Math.round(pct), dbm: Math.round(dbm), db: +q.value };
  }
  function patchSpectrumForSql() {
    if (window.__sqlPatched || typeof drawSpectrum !== "function") return;
    var orig = drawSpectrum;
    drawSpectrum = function (f) {
      orig(f);
      try { drawSqlLine(); } catch (e) {}
    };
    window.__sqlPatched = true;
  }

  /* ================= squelch + volume on the front page =================
     Both lived inside the hamburger sheet, which covers the waterfall while it is open - useless for
     something you adjust WHILE listening. They are mirrored here under the scanner row and bound to
     the same elements, so either control moves both and the squelch line follows instantly. */
  function buildLiveSliders() {
    var host = el("sdrScan") ? el("sdrScan").parentNode : el("sdrView");
    if (!host || el("sdrLive")) return;
    var box = document.createElement("div");
    box.id = "sdrLive";
    box.className = "sdr-live";
    box.innerHTML =
      '<div class="lv"><label for="sdrSqlLite">Squelch</label>' +
      '<input id="sdrSqlLite" type="range" step="1"><b id="sdrSqlLiteVal">-150</b></div>' +
      '<div class="lv"><label for="sdrVolLite">Volume</label>' +
      '<input id="sdrVolLite" type="range" step="1"><b id="sdrVolLiteVal">80</b></div>';
    var anchor = el("sdrScan");
    if (anchor && anchor.nextSibling) host.insertBefore(box, anchor.nextSibling);
    else host.appendChild(box);
    var sq = el("sdrSquelch"), vol = el("sdrVol");
    var s1 = el("sdrSqlLite"), v1 = el("sdrVolLite");
    if (sq && s1) { s1.min = sq.min; s1.max = sq.max; }
    if (vol && v1) { v1.min = vol.min; v1.max = vol.max; }
    if (s1) s1.oninput = function () {
      var t = el("sdrSquelch");
      if (t) { t.value = s1.value; try { t.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {} }
      var lb = el("sdrSqlLiteVal"); if (lb) lb.textContent = String(Math.round(+s1.value));
      try { drawSqlLine(); drawSqlMark(); } catch (e) {}
    };
    if (v1) v1.oninput = function () {
      var t = el("sdrVol");
      if (t) { t.value = v1.value; try { t.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {} }
      var lb = el("sdrVolLiteVal"); if (lb) lb.textContent = String(Math.round(+v1.value));
    };
    syncLiveSliders();
  }
  function syncLiveSliders() {
    var sq = el("sdrSquelch"), vol = el("sdrVol");
    var s1 = el("sdrSqlLite"), v1 = el("sdrVolLite");
    var s1v = el("sdrSqlLiteVal"), v1v = el("sdrVolLiteVal");
    if (sq && s1 && s1.value !== sq.value) s1.value = sq.value;
    if (vol && v1 && v1.value !== vol.value) v1.value = vol.value;
    if (s1v && s1) s1v.textContent = String(Math.round(+s1.value));
    if (v1v && v1) v1v.textContent = String(Math.round(+v1.value));
    dbg.live = { squelch: sq ? +sq.value : null, volume: vol ? +vol.value : null };
  }
  window.sdrPage = {
    testing: { queueFft: function (arr) { queueFft(arr); },
               resetMeters: function () { dbg.zc = 0; dbg.zcN = 0; dbg.pcmPow = 0; dbg.pcmN = 0;
                                            dbg.pushed = 0; dbg.pushedSamples = 0; },
               rateAcceptable: rateAcceptable, rdsUpdate: rdsUpdate, setModeSel: setModeSel, ledSet: setLeds, scanForce: function (v) { SCAN.forcePct = v; },
               scanForceDb: function (v) { SCAN.forceDb = v; }, sqlLine: drawSqlLine, sqlMark: drawSqlMark, squelchDb: squelchDb, syncLiveSliders: syncLiveSliders, groupsList: groupsList, setScanGroup: setScanGroup, scanGroup: scanGroup,
               renameFav: renameFav, setFavGroup: setFavGroup, favGroupName: favGroupName, busyNow: busyNow, scanMode: function (m) { if (m) { SCAN.mode = m; scanModeSave(); } return SCAN.mode; }, scanFavs: scanFavs, scanSignal: scanSignalPct,
               favAdd: favAdd, favRemove: favRemove, favList: favList, favRender: favRender,
               favHitTest: favHitTest, favSaveRow: favSaveRow, drawFavs: drawFavs },
    onShow: function () { startAutoFit();
      wire();
      try { fitSdr(); } catch (e) {}
      buildPick();
      layoutCanvases();
      wireTune();
      drawFreq(); drawScale(); drawSmeter();
    },
    layout: function () { layoutCanvases(); fitSdr(); },
    fit: function () { fitSdr(); },
    debug: function () {
      return { freq: S.freq, center: S.center, zoom: S.zoom, wfMin: S.wfMin, wfMax: S.wfMax,
               wfUser: S.wfUser, rateOf: S.rateOf, meas2: dbg.meas2, meas4: dbg.meas4,
               stereo: dbg.stereo || false, stereoSamples: dbg.stereoSamples || 0, rds: S.rds || null,
               audioState: S.audioCtx ? S.audioCtx.state : "none", blockedFrames: dbg.blocked || 0,
               fitWhy: dbg.fitWhy || null, fit: dbg.fit || null,
               fftDrawn: dbg.fftDrawn || 0, fftDropped: dbg.fftDropped || 0,
               visSpan: visSpan(),
      bw: S.bw,
      shiftPx: dbg.shiftPx === undefined ? null : dbg.shiftPx, bandWhy: dbg.bandWhy || null,
               band: dbg.band || null, bandSet: dbg.bandSet || null, bw: S.bw, rateOf: S.rateOf,
               sscale: dbg.sscale || null, sscaleAlign: dbg.sscaleAlign || null,
               rulerTicks: dbg.rulerTicks || null, specRuler: dbg.specRuler || null,
               bandPicker: dbg.bandPicker || null, bandPick: dbg.bandPick || null,
               topClearance: dbg.topClearance || null,
               visCentreDbg: S.visCenter, userQuiet: !(S.bwDrag || tuneDrag.on) && (Date.now() - (S.userTuneAt || 0) > 700),
               visCenter: S.visCenter, shownCentre: visCenterHz(), rcvCentre: S.center,
               fftMs: dbg.fftMs || 0, fftMsMax: dbg.fftMsMax || 0, smeterDb: S.smeterDb,
               zcr: dbg.zcN ? Math.round(dbg.zc / dbg.zcN * 12000) : 0,
               rmsPcm: dbg.pcmN ? Math.round(Math.sqrt(dbg.pcmPow / dbg.pcmN) * 32768) : 0,
               rateRejected: (dbg.rejected2 || 0) + (dbg.rejected4 || 0),
               proto: S.proto, kiwiFrames: S.kiwi ? S.kiwi.frames : 0, kiwiWf: S.kiwi ? S.kiwi.wfLines : 0,
               kiwiCompressed: S.kiwi ? !!S.kiwi.comp : null, kiwiFlags: S.kiwi ? S.kiwi.flags : null,
               kiwiPeak: S.kiwi && S.kiwi.peak ? S.kiwi.peak : 0,
               kiwiRms: S.kiwi && S.kiwi.cnt ? Math.round(Math.sqrt(S.kiwi.pow / S.kiwi.cnt)) : 0,
               kiwiSps: S.kiwi && S.kiwi.t0 ? Math.round((S.kiwi.samples || 0) / ((performance.now() - S.kiwi.t0) / 1000)) : 0,
               kiwiReady: S.kiwi ? S.kiwi.ready : false, kiwiStage: S.gotData ? "streaming" : "handshake",
               favs: favList().map(function (f) { return f.name + "@" + f.hz + "/" + f.mode; }),
               favMarkers: favList().filter(function (f) { return favX(f.hz, 1) !== null; }).length,
               pickRate: dbg.pickRate, rateFixes: [dbg.rateFix2, dbg.rateFix4],
               pushed: dbg.pushed || 0, pushedSamples: dbg.pushedSamples || 0,
               lastType: dbg.lastType, ruler: S.rulerLabels || [],
               lut: WF_LUT ? WF_LUT[255] : null, connected: S.connected, mode: S.mode };
    }
  };

  /* build early when the receiver list is already there */
  var tries = 0;
  var t = setInterval(function () {
    tries++;
    var ok = false;
    try { ok = (typeof sdrItems !== "undefined" && Array.isArray(sdrItems) && sdrItems.length > 0); } catch (e) {}
    if (ok || tries > 80) { clearInterval(t); wire(); }
  }, 250);
})();
