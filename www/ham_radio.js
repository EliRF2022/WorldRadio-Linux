/* ================= HAMS / SDR page (single look for every SDR radio) ================= */
(function(){
  "use strict";
  const ham = {
    radios: [],         // sdrItems + mySdrs
    sel: -1,            // selected radio index
    ws: null,           // websocket to the radio
    buf: [],            // waterfall frames
    freq: 14074000,     // current tuning frequency (Hz)
    mode: 'USB',        // current mode
    connected: false,
    hamStatus: function(msg){ if (typeof toast === 'function') toast(msg); else console.log('[ham]', msg); },
    ctx: null,          // canvas ctx
    init: function(){
      ham.ctx = $('hamWater').getContext('2d');
      ham.resizeCanvas();
      ham.ctx.fillStyle = '#0a0f18';
      ham.ctx.fillRect(0,0,$('hamWater').width,$('hamWater').height);

      // build radio dropdown from public SDR list + users' receivers
      ham.radios = Array.isArray(sdrItems) ? sdrItems.slice() : [];
      var appMySdrs = [];
      try {
        var rawMy = localStorage.getItem('wr_my_sdrs');
        if (rawMy) {
          var parsedMy = JSON.parse(rawMy);
          if (Array.isArray(parsedMy)) appMySdrs = parsedMy;
        }
      } catch(e) {}
      ham.radios.forEach(function(r,i){
        var o = document.createElement('option');
        o.value = i;
        var nm = (r.name||'Unknown');
        var lt = (r.loc||'') + (r.cs ? ' · ' + r.cs : '');
        o.textContent = nm + (lt ? '  ·  '+lt : '');
        o.dataset.url = r.url || '';
        o.dataset.type = r.src || '';
        sel.appendChild(o);
      });
      sel.onchange = function(){ ham.sel = +sel.value; hamStatus('Selecting '+(ham.sel>=0?ham.radios[ham.sel].name:'—')); };
      hamStatus('Pick a radio at the top, then press Connect.');
      ham.freq = parseFloat(localStorage.getItem('ham_freq')||'14074000');
      ham.mode = localStorage.getItem('ham_mode')||'USB';
      $('hamFreq').textContent = ham.fmt(ham.freq);
      $('hamMode').textContent = ham.mode;
      $('hamFreqInput').value = ham.freq;
      ham.resizeCanvas();
    },
    resizeCanvas: function(){
      var cv = $('hamWater');
      cv.width = cv.clientWidth;
      cv.height = cv.clientHeight;
      if (ham.ctx) ham.ctx.fillRect(0,0,cv.width,cv.height);
    },
    fmt: function(hz){
      if (!hz) return '0';
      var h = Math.floor(hz/1e6), f = hz - h*1e6;
      if (h>0) return h+'.'+('00'+Math.round(f/1e4)).slice(-4)+' MHz';
      return (hz/1e3)+' kHz';
    },
    setFreq: function(hz, upd){
      ham.freq = +hz;
      if (upd) $('hamFreq').textContent = ham.fmt(hz);
      $('hamFreqInput').value = hz;
      localStorage.setItem('ham_freq', hz);
      if (ham.sel && ham.send) ham.send({cmd:'setfreq', freq:Math.round(hz)});
    },
    setMode: function(mode){
      mode = mode || $('hamMode').textContent || 'USB';
      if (mode===ham.mode) return;
      ham.mode = mode;
      $('hamMode').textContent = mode;
      localStorage.setItem('ham_mode', mode);
      if (ham.sel && ham.send) ham.send({cmd:'setmode', mode:mode});
    },
    send: function(obj){
      if (!ham.ws) return false;
      try { ham.ws.send(JSON.stringify(obj)); return true; } catch(e){ return false; }
    },
    recv: function(msg){
      try {
        var d = typeof msg==='string' ? JSON.parse(msg) : msg;
        if (d.type==='status'){
          if (d.freq && d.freq!==ham.freq) ham.setFreq(d.freq, false);
          if (d.mode && d.mode!==ham.mode) { ham.mode = d.mode; $('hamMode').textContent = d.mode; }
          return true;
        }
        if (d.type==='wave' || d.type==='waveform' || d.type==='waveform_frame'){
          ham.pushWave(d.data || d);
          return true;
        }
        return false;
      } catch(e){ return false; }
    },
    pushWave: function(data){
      ham.buf.push(data);
      if (ham.buf.length > 100) ham.buf.shift();
      requestAnimationFrame(ham.drawWave);
    },
    drawWave: function(){
      var cv = $('hamWater');
      var W = cv.width, H = cv.height;
      if (ham.ctx){
        ham.ctx.fillStyle = '#0a0f18';
        ham.ctx.fillRect(0,0,W,H);
      }
      if (!ham.buf.length) return;
      var rows = Math.min(200, H);
      var cols = W;
      var f = ham.buf.length;
      for (var c=0;c<cols;c++){
        var srcIdx = (c/f)|0;
        if (srcIdx >= ham.buf.length) break;
        var frame = ham.buf[srcIdx];
        if (!frame) continue;
        var h = frame.length || 0;
        for (var r=0;r<rows;r++){
          var srcY = (r/(rows))|0 * h;
          var v = (frame[srcY]||0)/255;
          var col = Math.round(v*255);
          var r_=0,g_=0,b_=0;
          if (col<43)      { b_=col*6; }
          else if (col<85) { b_=255; g_=col*6-255; }
          else if (col<170){ g_=col-85; r_=255; }
          else if (col<255){ r_=255; g_=255-(col-170)*6; }
          if (ham.ctx){
            ham.ctx.fillStyle = 'rgb('+r_+','+g_+','+b_+')';
            ham.ctx.fillRect(c, H-1-r, 1, 1);
          }
        }
      }
      ham.ctx.fillStyle = '#5aa6e0';
      ham.ctx.font = '9px monospace';
      ham.ctx.fillText('7.0', 6, H-10);
      ham.ctx.fillText('16.0', W-46, H-10);
    },
    connect: function(){
      var url = ham.radios[ham.sel] && ham.radios[ham.sel].url || '';
      var type = (ham.radios[ham.sel] && ham.radios[ham.sel].src) || '';
      if (!url) return hamStatus('No radio selected. Pick one from the list.');
      var base = url.replace(/[#?].*$/, '').replace(/\/+$/, '');
      var wsUrl = base;
      var prot = (location.protocol==='https:'?'wss:':'ws:');
      wsUrl = wsUrl.replace(/^http/, prot) + '/ws';
      ham.ws = new WebSocket(wsUrl);
      ham.ws.binaryType = 'arraybuffer';
      ham.ws.onopen = function(){
        ham.connected = true;
        $('hamConnect').textContent = 'Connected';
        $('hamConnect').classList.add('on');
        $('hamStatus').textContent = 'Connected to ' + ham.radios[ham.sel].name;
        ham.send({cmd:'getprofile'});
        ham.send({cmd:'setfreq', freq:Math.round(ham.freq)});
        ham.send({cmd:'setmode', mode:ham.mode});
        ham.send({cmd:'getwave'});
      };
      ham.ws.onmessage = function(e){
        var d = e.data;
        if (typeof d === 'string'){
          try { ham.recv(JSON.parse(d)); return; } catch(e){}
          ham.recv({type:'text', data:d});
        } else {
          ham.pushWave(new Uint8Array(d));
        }
      };
      ham.ws.onclose = function(){
        ham.connected = false;
        $('hamConnect').textContent = 'Connect';
        $('hamConnect').classList.remove('on');
        $('hamStatus').textContent = 'Disconnected';
      };
      ham.ws.onerror = function(){ hamStatus('Connection error — check the radio URL.'); };
    },
    disconnect: function(){
      if (ham.ws){ ham.ws.close(); ham.ws = null; }
      ham.connected = false;
      $('hamConnect').textContent = 'Connect';
      $('hamConnect').classList.remove('on');
      $('hamStatus').textContent = 'Disconnected';
    }
  };

  window.ham = ham;

  // boot: wait for sdrItems (loaded async) then init
  var checkSdrs = setInterval(function(){
    if (Array.isArray(sdrItems) && sdrItems.length) {
      clearInterval(checkSdrs);
      ham.init();
      setView('ham');
    } else if (typeof sdrItems === 'undefined'){
      if (document.readyState === 'complete') ham.init();
    }
  }, 250);
})();
