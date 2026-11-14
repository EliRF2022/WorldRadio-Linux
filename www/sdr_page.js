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
  var DB_MIN = -120, DB_MAX = -30;          /* spectrum / waterfall window */

  var S = {
    ws: null, connected: false, ready: false,
    radios: [], pick: -1,
    freq: 27065000, mode: "AM", step: 1000,
    center: 0, bw: 0, fftSize: 0,
    smeterDb: DB_S0, smeterOffset: 0, modeBp: null,
    audioCtx: null, nextPlay: 0, playing: false,
    audioComp: "adpcm", fftComp: "adpcm",
    rate: 48000, estN: 0, estT0: 0, rateChecked: false,
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

  function buildPick() {
    var sel = el("sdrPick");
    if (!sel) return;
    var list = [];

    try {
      var pub = (typeof sdrItems !== "undefined" && Array.isArray(sdrItems)) ? sdrItems : [];
      pub.forEach(function (r) {
        if (r && r.url) list.push({ name: r.name || r.url, loc: r.loc || r.cs || "", url: r.url });
      });
    } catch (e) {}

    /* the owner's own receiver goes on top */
    try {
      if (typeof MY_SDR_NAME !== "undefined" && typeof MY_SDR_URL !== "undefined") {
        list = list.filter(function (r) { return r.url !== MY_SDR_URL; });
        list.unshift({ name: MY_SDR_NAME, loc: "my receiver", url: MY_SDR_URL });
      }
    } catch (e2) {}

    S.radios = list;
    sel.innerHTML = "";
    var ph = document.createElement("option");
    ph.value = "-1";
    ph.textContent = "— pick a receiver (" + list.length + ") —";
    sel.appendChild(ph);

    list.forEach(function (r, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = (r.name || "Unknown") + (r.loc ? "  ·  " + r.loc : "");
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
    var r = S.radios[S.pick];
    if (!r || !r.url) { status("Pick a receiver at the top first.", "bad"); return; }
    disconnect(true);

    var url = wsFor(r.url);
    status("Connecting to " + (r.name || r.url) + " …");
    try { S.ws = new WebSocket(url); }
    catch (e) { status("That receiver's address looks wrong.", "bad"); return; }
    S.ws.binaryType = "arraybuffer";

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
      S.connected = false;
      setConnBtn(false);
      status("Disconnected.", "");
    };

    S.ws.onerror = function () { status("Connection error — that receiver may be offline or busy.", "bad"); };
  }

  function disconnect(quiet) {
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
    var C = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
    var best = 0, d = 1e9;
    C.forEach(function (c) { var x = Math.abs(c - hz); if (x < d) { d = x; best = c; } });
    if (best && d / best < 0.06) return best;
    return hz > 6000 ? Math.round(hz) : 0;
  }
  function rateSample(count) {
    var now = performance.now();
    if (!S.estT0) { S.estT0 = now; S.estN = 0; return; }
    S.estN += count;
    var el = (now - S.estT0) / 1000;
    if (el < 1.5) return;
    S.rateChecked = true;
    var hz = S.estN / el;
    dbg.measured = Math.round(hz);
    var snapped = snapRate(hz);
    if (snapped && snapped !== S.rate) {
      S.rate = snapped;
      S.nextPlay = 0;                        /* re-prime at the corrected rate */
      dbg.rateFix = snapped;
    }
  }

  /* Stay quiet for the ~1.5 s it takes to MEASURE the rate, rather than playing
     a second and a half at the wrong speed - a 3x-too-slow start reads as
     "laggy". If the squelch is shut and no audio is arriving at all, give up
     waiting after 4 s and go with the default so we are ready when it opens. */
  function audioReady() {
    if (S.rateChecked) return true;
    if (S.estT0 && (performance.now() - S.estT0) > 4000) return true;
    return false;
  }

  /* ----------------------------------------------------------- incoming */
  function cfgApply(c) {
    if (!c) return;
    if (c.center_freq) S.center = +c.center_freq;
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
        cfgApply(j.value || j);
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
        dbg.fft++; dbg.lastLen = n;
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
        for (k = 0; k < f.length; k++) {
          if (f[k] < dbg.fmin) dbg.fmin = f[k];
          if (f[k] > dbg.fmax) dbg.fmax = f[k];
        }
        drawSpectrum(f);
        drawWaterfall(f);
      } else if (type === 2 || type === 4) {   /* audio */
        dbg.audio++;
        var pcm;
        if (S.audioComp === "adpcm") {
          pcm = audioCodec.decodeSync(u8.subarray(1));
        } else {
          var n2 = n - (n % 2);
          if (n2 < 2) return;
          pcm = new Int16Array(body, 0, n2 / 2);
        }
        if (!pcm.length) return;
        if (!S.rateChecked) rateSample(pcm.length);
        if (audioReady()) pushAudio(pcm);
      }
    } catch (e) {
      dbg.err = String((e && e.message) || e);
    }
  }

  /* ------------------------------------------------------------- audio */
  function startAudio() {
    try {
      if (!S.audioCtx) {
        S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        S.nextPlay = 0;
      }
      if (S.audioCtx.state !== "running") S.audioCtx.resume();
      S.playing = true;
      audioCodec.reset();
      S.estN = 0; S.estT0 = 0; S.rateChecked = false; S.nextPlay = 0;
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
  function pushAudio(i16) {
    if (!S.playing || !S.audioCtx || !i16.length) return;
    var ctx = S.audioCtx;
    var n = i16.length;
    var b = ctx.createBuffer(1, n, S.rate);
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
    S.nextPlay += b.duration;
    if (S.nextPlay - now > 1.5) S.nextPlay = now + 0.22;
  }

  /* -------------------------------------------------------- tune / mode */
  function setFreq(hz, fromUser) {
    if (!isFinite(hz) || hz < 1000 || hz > 6000000000) return;
    S.freq = Math.round(hz);
    drawFreq();
    drawScale();
    try { localStorage.setItem("sdr_freq", S.freq); } catch (e) {}
    if (fromUser) send({ type: "setfrequency", params: freqParams(S.freq) });
  }

  function nudge(dir) { setFreq(S.freq + dir * S.step, true); }

  /* modes are identified by the ID the receiver uses (nfm, wfm, lsb...), while
     the button shows the friendly name. */
  function dspParams() {
    var p = { mod: S.mode };
    var bp = S.modeBp && S.modeBp[S.mode];
    if (bp) { p.low_cut = bp.low_cut; p.high_cut = bp.high_cut; }
    return p;
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
    try { localStorage.setItem("sdr_mode", m); } catch (e) {}
    if (fromUser) send({ type: "dspcontrol", params: dspParams() });
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

    box.innerHTML = norm.map(function (m) {
      return '<button type="button" class="smode' + (m.id === S.mode ? " on" : "") +
             '" data-m="' + m.id + '">' + m.name + "</button>";
    }).join("");
    box.querySelectorAll(".smode").forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.m, true); };
    });
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
    if (b) { b.textContent = on ? "Disconnect" : "Connect"; b.classList.toggle("on", !!on); }
    var d = el("sdrDot");
    if (d) d.classList.toggle("live", !!on);
  }

  /* ===================================================================
     DISPLAY  —  big frequency, mode row, spectrum, waterfall, S-meter
     =================================================================== */

  function drawFreq() {
    var f = el("sdrFreq");
    if (f) f.textContent = pad3(S.freq);
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
    l.textContent = put((S.center - S.bw / 2) / 1e6);
    r.textContent = put((S.center + S.bw / 2) / 1e6);
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

  function vToColour(v) {                     /* 0..1 -> black-blue-cyan-white */
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
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
    [-40, -60, -80, -100, -120].forEach(function (d) {
      var y = Math.round((DB_MAX - d) / (DB_MAX - DB_MIN) * H) + 0.5;
      if (y > 0 && y < H) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    });

    g.beginPath();
    g.moveTo(0, H);
    for (var x = 0; x < W; x++) {
      var i = Math.floor(x / W * n);
      var v = (f[i] - DB_MIN) / (DB_MAX - DB_MIN);
      if (v < 0) v = 0; if (v > 1) v = 1;
      var y = H - v * (H - 2);
      if (x === 0) g.lineTo(0, y); else g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    var grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "rgba(0,229,255,.55)");
    grd.addColorStop(1, "rgba(0,229,255,.05)");
    g.fillStyle = grd;
    g.fill();

    g.beginPath();
    for (var x2 = 0; x2 < W; x2++) {
      var i2 = Math.floor(x2 / W * n);
      var v2 = (f[i2] - DB_MIN) / (DB_MAX - DB_MIN);
      if (v2 < 0) v2 = 0; if (v2 > 1) v2 = 1;
      var y2 = H - v2 * (H - 2);
      if (x2 === 0) g.moveTo(0, y2); else g.lineTo(x2, y2);
    }
    g.strokeStyle = "#00e5ff";
    g.lineWidth = 1.4;
    g.stroke();

    /* centre marker + tuning cursor */
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
  }

  function drawWaterfall(f) {
    if (!S.hctx || !S.hist || !S.wctx) return;
    var bins = S.hist.width, H = S.hist.height, n = f.length;

    /* shift the history down one pixel, then write the new row on top */
    S.hctx.drawImage(S.hist, 0, 1);
    var img = S.hctx.createImageData(bins, 1);
    var d = img.data;
    for (var x = 0; x < bins; x++) {
      var i = Math.floor(x / bins * n);
      var v = (f[i] - DB_MIN) / (DB_MAX - DB_MIN);
      v = v < 0 ? 0 : (v > 1 ? 1 : v);
      var c = vToColour(v);
      /* parse the "rgb(r,g,b)" we just built, cheaply */
      var p = c.slice(4, -1).split(",");
      d[x * 4] = +p[0]; d[x * 4 + 1] = +p[1]; d[x * 4 + 2] = +p[2]; d[x * 4 + 3] = 255;
    }
    S.hctx.putImageData(img, 0, 0);

    var W = S.water.width;
    S.wctx.drawImage(S.hist, 0, 0, bins, H, 0, 0, W, H);
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
    } catch (e) {}

    buildPick();

    var pick = el("sdrPick");
    if (pick) pick.onchange = function () {
      S.pick = +pick.value;
      try { localStorage.setItem("sdr_pick", S.pick); } catch (e) {}
      if (S.pick >= 0) {
        var r = S.radios[S.pick];
        status("Selected " + (r.name || "") + " — press Connect.");
        if (S.connected) connect();
      }
    };

    var up = el("sdrUp"), dn = el("sdrDn");
    if (up) up.onclick = function () { nudge(1); };
    if (dn) dn.onclick = function () { nudge(-1); };

    var fEl = el("sdrFreq");
    if (fEl) fEl.onclick = keypadOpen;

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

    window.addEventListener("resize", function () { layoutCanvases(); });
    status("Pick a receiver at the top, then press Connect.");
  }

  window.sdrPage = {
    onShow: function () {
      wire();
      buildPick();
      layoutCanvases();
      drawFreq(); drawScale(); drawSmeter();
    },
    layout: function () { layoutCanvases(); }
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
