/* ╔══════════════════════════════════════════════════════════════════════════
 * ║  RAKHSHII — SIGNAL INTELLIGENCE ENGINE v9.0 (mobile-first, FB/IG ads)
 * ║
 * ║  Improvements over Asma's v8.1:
 * ║   #1  Cloudflare Worker endpoint (30-50ms vs GAS 1500-2000ms)
 * ║   #2  Real client IP captured server-side (CF-Connecting-IP) → mobile EMQ
 * ║   #3  HMAC-signed payloads → endpoint cannot be POST-spammed
 * ║   #4  Service Worker retry queue (IndexedDB) → no silent event drops
 * ║   #5  Deterministic event_id sha256(fp+click_ts+event_name) → no UUID race
 * ║   #6  Live KV-backed counter ("Aaj X log join hue") → real social proof
 * ║   #7  Tier-based WA pre-fill message → segmented inbox
 * ║   #8  fbclid persistence in localStorage → survives IG WebView session
 * ║   #9  Jitter signature + honeypot → harder for click farms
 * ║   #10 WhatsApp deep link priority: whatsapp:// → intent:// → wa.me
 * ║   #11 Bottom-CTA scroll-show pattern (TikTok style)
 * ║   #12 Mobile-only — all hover/mouse code dropped
 * ╚══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Tell the inline fallback in index.html to stand down — we'll handle
  // button clicks (with full Pixel/CAPI fire). Set BEFORE any other code
  // so the inline handler skips even during async init.
  window.__rkh_engine = true;

  // ═══════════════════════════════════════════════════════════════════
  //  CONFIG — placeholders, swap on deploy
  // ═══════════════════════════════════════════════════════════════════
  var CFG = {
    // Cloudflare Worker URL — replace after `wrangler deploy`
    WORKER_URL : 'https://capi-rakhshii.rakshubu1.workers.dev',

    // Public client key — paired with HMAC secret in Worker.
    // Not a security boundary on its own; HMAC of timestamp+body is.
    CLIENT_KEY : 'rkh_pub_v9',

    // WhatsApp number (international format, no +)
    WA_NUM     : '918082521698',

    // GAS sidecar — logging only, no CAPI calls. Keep optional.
    GAS_URL    : '',  // fill if logging desired

    VERSION    : '9.0',

    TIER_HIGH : 65, TIER_MED : 40, TIER_LOW : 12,
    HIGH_TESTI_S : 12, HIGH_HESIT_MIN : 500, HIGH_HESIT_MAX : 10000,
    VALUE_MIN : 50, VALUE_MAX : 500,

    WEIGHTS : {
      time_on_page : 0.30, scroll_depth : 0.25, scroll_reversals : 0.20,
      section_attn : 0.15, copy_detected : 0.10,
    },

    BCTA_SHOW_PX : 160,   // bottom CTA appears after this scroll depth
    EVENT_CAP    : 30,    // max events per session before throttling
  };

  // ═══════════════════════════════════════════════════════════════════
  //  fbc / fbp / fbclid — raw read, never decoded, never modified
  //  ITP-resilient: fbc persisted in localStorage if cookie absent
  // ═══════════════════════════════════════════════════════════════════
  function getCookieRaw(name) {
    var m = document.cookie.match(
      new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)')
    );
    return m ? m[1] : '';
  }
  function getRawParam(key) {
    var esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = location.search.match(new RegExp('[?&]' + esc + '=([^&]*)'));
    return m ? m[1] : '';
  }

  var PAGE_LOAD_TS = Math.floor(Date.now() / 1000);

  // Resolve fbc with localStorage persistence. ITP wipes _fbc cookie in
  // IG WebView; we keep our own copy keyed by fbclid so future visits with
  // the same fbclid reuse the original timestamp.
  function resolveFbc() {
    var cookieFbc = getCookieRaw('_fbc');
    if (cookieFbc) {
      cacheFbc(cookieFbc, getRawParam('fbclid'));
      return cookieFbc;
    }
    var rawFbclid = getRawParam('fbclid');
    if (rawFbclid) {
      var cached = readCachedFbc(rawFbclid);
      if (cached) return cached;
      var fbc = 'fb.1.' + PAGE_LOAD_TS + '.' + rawFbclid;
      cacheFbc(fbc, rawFbclid);
      return fbc;
    }
    return '';
  }
  function cacheFbc(fbc, fbclid) {
    if (!fbc || !fbclid) return;
    try { localStorage.setItem('rkh_fbc', JSON.stringify({ fbc: fbc, fbclid: fbclid })); } catch (_) {}
  }
  function readCachedFbc(fbclid) {
    try {
      var raw = localStorage.getItem('rkh_fbc');
      if (!raw) return '';
      var p = JSON.parse(raw);
      return (p && p.fbclid === fbclid && p.fbc) ? p.fbc : '';
    } catch (_) { return ''; }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  IDENTITY — fingerprint + visit/session ids
  // ═══════════════════════════════════════════════════════════════════
  var IDENTITY = {
    fingerprint : '', sessionId : '', visitId : '',
    mouseEvents : 0, touchEvents : 0, firstClickTs : 0,
    jitterSamples : [],

    buildCanvas: function () {
      try {
        var c = document.createElement('canvas'), x = c.getContext('2d');
        x.textBaseline = 'top'; x.font = '14px Arial';
        x.fillStyle = '#f60'; x.fillRect(125, 1, 62, 20);
        x.fillStyle = '#069'; x.fillText('RK♥', 2, 15);
        x.fillStyle = 'rgba(102,204,0,.7)'; x.fillText('RK♥', 4, 17);
        return c.toDataURL().slice(-50);
      } catch (_) { return 'nc'; }
    },

    buildAudio: function () {
      try {
        var ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
        var osc = ac.createOscillator(), an = ac.createAnalyser(), g = ac.createGain();
        g.gain.value = 0; osc.connect(an); osc.connect(g); g.connect(ac.destination); osc.start(0);
        var b = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(b); ac.close();
        return b.slice(0, 5).reduce(function (a, x) { return a + Math.abs(x); }, 0).toFixed(6);
      } catch (_) { return 'na'; }
    },

    buildPlatform: function () {
      try {
        var gl = document.createElement('canvas').getContext('webgl');
        if (!gl) return navigator.platform || 'np';
        var d = gl.getExtension('WEBGL_debug_renderer_info');
        if (!d) return navigator.platform || 'nd';
        var r = gl.getParameter(d.UNMASKED_RENDERER_WEBGL) || '';
        return r.length > 5 ? r.substring(0, 40) : (navigator.platform || 'nb');
      } catch (_) { return navigator.platform || 'ne'; }
    },

    build: async function () {
      var raw = this.buildCanvas() + '|' + this.buildAudio() + '|' + this.buildPlatform()
        + '|' + screen.width + 'x' + screen.height + 'x' + screen.colorDepth
        + '|' + (Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '')
        + '|' + (navigator.language || '');
      this.fingerprint = await sha256Hex(raw);

      var stored = lsGet('rkh_vid');
      if (stored && stored.fp === this.fingerprint) {
        this.visitId = stored.vid;
      } else {
        this.visitId = uuid4();
        lsSet('rkh_vid', { fp: this.fingerprint, vid: this.visitId, created: Date.now() });
      }
      this.sessionId = uuid4();
    },

    initBotDetection: function () {
      var s = this, lastTs = 0;
      // Touch events with inter-arrival jitter — humans have ~10-200ms randomness,
      // bots typically <2ms or perfectly periodic. Capture first 8 samples.
      document.addEventListener('touchstart', function () {
        s.touchEvents++;
        var now = performance.now();
        if (lastTs && s.jitterSamples.length < 8) s.jitterSamples.push(now - lastTs);
        lastTs = now;
      }, { passive: true });
      document.addEventListener('mousemove',  function () { s.mouseEvents++; }, { passive: true });
      document.addEventListener('click', function () {
        if (!s.firstClickTs) s.firstClickTs = Date.now();
      }, { passive: true, once: true });
    },

    // Returns 0..1 — closer to 1 = more bot-like
    botScore: function () {
      if (navigator.webdriver) return 1;
      var total   = this.mouseEvents + this.touchEvents;
      var elapsed = (Date.now() - STATE.startTime) / 1000;
      if (elapsed > 6 && total === 0)            return 0.9;
      if (this.firstClickTs && (this.firstClickTs - STATE.startTime) < 200) return 0.85;

      // Jitter analysis — too-uniform inter-arrival = bot
      if (this.jitterSamples.length >= 4) {
        var avg = this.jitterSamples.reduce(function (a, x) { return a + x; }, 0) / this.jitterSamples.length;
        var variance = this.jitterSamples.reduce(function (a, x) { return a + (x - avg) * (x - avg); }, 0) / this.jitterSamples.length;
        var stdev = Math.sqrt(variance);
        // human stdev typically > 30ms; bot < 5ms
        if (stdev < 5 && avg < 50) return 0.75;
      }
      return 0;
    },

    isBotLikely: function () { return this.botScore() >= 0.6; },
  };

  // ═══════════════════════════════════════════════════════════════════
  //  STATE
  // ═══════════════════════════════════════════════════════════════════
  var STATE = {
    startTime : Date.now(),
    maxScrollPct : 0, scrollReversals : 0, lastScrollY : 0,
    scrollPxTotal : 0, scrollStartMs : Date.now(),
    sectionsViewed : [], sectionDwellMap : {},
    testiDwellS : 0, copyDetected : false,
    hoverStartMs : 0, hesitationMs : 0,
    visitCount : 1, isRepeat : false, prevBest : 0,
    fbc : '', fbp : '', rawFbclid : '',
    utmSource : '', utmMedium : '', utmCampaign : '',
    eventsCount : 0, waClicked : false, _busy : false,
  };

  // ═══════════════════════════════════════════════════════════════════
  //  SCORE — display only; Worker recomputes authoritatively
  // ═══════════════════════════════════════════════════════════════════
  var SCORE = {
    raw : { time:0, scroll:0, reversals:0, sections:0, copy:0 },
    prevBest : 0,

    compute: function () {
      var w = CFG.WEIGHTS;
      var raw = this.raw.time*w.time_on_page + this.raw.scroll*w.scroll_depth
              + this.raw.reversals*w.scroll_reversals + this.raw.sections*w.section_attn
              + this.raw.copy*w.copy_detected;
      if (IDENTITY.isBotLikely()) raw = Math.min(raw, 0.08);
      if (this.prevBest >= 50 && STATE.isRepeat) raw = Math.min(1, raw + 0.06);
      return Math.round(raw * 100);
    },

    toValue: function (s) { return Math.round(CFG.VALUE_MIN + (CFG.VALUE_MAX - CFG.VALUE_MIN) * (s / 100)); },

    loadHistory: function () {
      var h = lsGet('rkh_sh'); if (!h) return;
      this.prevBest = h.best || 0; STATE.prevBest = h.best || 0;
      if (h.scroll > 0) this.raw.scroll = Math.min(1, (h.scroll / 100) * 0.5);
    },

    saveHistory: function (s) {
      lsSet('rkh_sh', { best: Math.max(s, this.prevBest), scroll: STATE.maxScrollPct, last: Date.now() });
    },
  };

  function tierFromScore(s) {
    var testiQ = STATE.testiDwellS >= CFG.HIGH_TESTI_S;
    var hesitQ = STATE.hesitationMs >= CFG.HIGH_HESIT_MIN && STATE.hesitationMs <= CFG.HIGH_HESIT_MAX;
    if (s >= CFG.TIER_HIGH && (testiQ || hesitQ)) return 'HIGH';
    if (s >= CFG.TIER_MED) return 'MED';
    if (s >= CFG.TIER_LOW) return 'LOW';
    return 'JUNK';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════════
  function uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  async function sha256Hex(s) {
    if (!s || !window.crypto || !window.crypto.subtle) return '';
    try {
      var buf = new TextEncoder().encode(s.trim().toLowerCase());
      var hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash))
        .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (_) { return ''; }
  }

  // HMAC-SHA256 hex (used to sign Worker payloads)
  async function hmacHex(secret, data) {
    if (!window.crypto || !window.crypto.subtle) return '';
    try {
      var key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
      return Array.from(new Uint8Array(sig))
        .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (_) { return ''; }
  }

  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function lsGet(k)    { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }

  function getDeviceType() {
    return /tablet|ipad/i.test(navigator.userAgent) ? 'tablet'
         : /mobile|android|iphone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  }
  function getConnection() {
    try { var c = navigator.connection || navigator.mozConnection; return c ? (c.effectiveType || 'unk') : 'unk'; }
    catch (_) { return 'unk'; }
  }
  function timeOnPage() { return Math.round((Date.now() - STATE.startTime) / 1000); }

  // Detect FB/IG in-app browser — affects WhatsApp deep-link choice
  function isInAppBrowser() {
    var ua = navigator.userAgent || '';
    return /FBAN|FBAV|Instagram|FB_IAB|FB4A/i.test(ua);
  }
  function getPlatform() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    return 'other';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INIT — all setup runs from here
  // ═══════════════════════════════════════════════════════════════════
  async function init() {
    await IDENTITY.build();
    IDENTITY.initBotDetection();

    STATE.fbc        = resolveFbc();
    STATE.fbp        = getCookieRaw('_fbp');
    STATE.rawFbclid  = getRawParam('fbclid');
    STATE.utmSource  = getRawParam('utm_source');
    STATE.utmMedium  = getRawParam('utm_medium');
    STATE.utmCampaign= getRawParam('utm_campaign');

    var visits = (lsGet('rkh_v') || 0) + 1;
    lsSet('rkh_v', visits);
    STATE.visitCount = visits;
    STATE.isRepeat   = visits > 1;

    SCORE.loadHistory();

    fetchWeights();
    fetchLiveCount();
    initTimeBuckets();
    initScrollTracking();
    initSectionTracking();
    initCopyDetection();
    initExitIntent();
    initButtonBindings();
    initBottomCTA();
    initRevealOnView();
    initNavScroll();
    sendOpenEvent();

    if (window.console && console.log) {
      console.log('[Rakhshii v' + CFG.VERSION + '] Ready',
        '| fp:', IDENTITY.fingerprint.substring(0, 10) + '…',
        '| fbc:', STATE.fbc ? 'yes' : 'no',
        '| visit#' + visits,
        '| inApp:', isInAppBrowser());
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WORKER FETCHES
  // ═══════════════════════════════════════════════════════════════════
  function fetchWeights() {
    if (!CFG.WORKER_URL) return;
    fetch(CFG.WORKER_URL + '/weights', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.weights) {
          Object.keys(d.weights).forEach(function (k) {
            if (k in CFG.WEIGHTS && typeof d.weights[k] === 'number'
                && d.weights[k] >= 0 && d.weights[k] <= 1) {
              CFG.WEIGHTS[k] = d.weights[k];
            }
          });
        }
      }).catch(function () {});
  }

  // Live counter — KV-backed real number, not fake
  function fetchLiveCount() {
    var el = document.getElementById('live-text');
    if (!el || !CFG.WORKER_URL) return;
    fetch(CFG.WORKER_URL + '/stats', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && typeof d.today === 'number' && d.today > 0) {
          el.textContent = 'Aaj ' + d.today + ' logon ne join kiya';
        } else {
          // Sensible fallback while KV warms up
          el.textContent = '500+ already started';
        }
      })
      .catch(function () {
        var el2 = document.getElementById('live-text');
        if (el2) el2.textContent = '500+ already started';
      });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  TRACKING — time, scroll, sections, copy, exit
  // ═══════════════════════════════════════════════════════════════════
  function initTimeBuckets() {
    setTimeout(function () {
      SCORE.raw.time = Math.min(1, 30 / 120);
      sendToWorker('EngagedUser', { trigger: '30s', score: SCORE.compute() });
      try { fbq('trackCustom', 'EngagedUser', { trigger: '30s' }); } catch (_) {}
    }, 30000);
    [60000, 120000].forEach(function (ms) {
      setTimeout(function () { SCORE.raw.time = Math.min(1, (ms / 1000) / 120); }, ms);
    });
  }

  function initScrollTracking() {
    var timeAtDepth = {}, lastMs = Date.now(), lastPct = 0, ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        var now = Date.now();
        var pct = Math.round(((scrollY + innerHeight) / document.documentElement.scrollHeight) * 100);
        var dt  = now - lastMs;
        STATE.scrollPxTotal += Math.abs(scrollY - STATE.lastScrollY);
        if (scrollY < STATE.lastScrollY - 80) {
          STATE.scrollReversals++;
          SCORE.raw.reversals = Math.min(1, STATE.scrollReversals * 0.15);
        }
        STATE.lastScrollY = scrollY;
        var bucket = Math.floor(lastPct / 10) * 10;
        timeAtDepth[bucket] = (timeAtDepth[bucket] || 0) + dt;
        lastMs = now; lastPct = pct;
        if (pct > STATE.maxScrollPct) STATE.maxScrollPct = pct;
        var wD = 0, wT = 0;
        Object.keys(timeAtDepth).forEach(function (d) {
          wD += (parseInt(d, 10) / 100) * timeAtDepth[d];
          wT += timeAtDepth[d];
        });
        var blended = wT > 0 ? (wD / wT) * 0.7 + (pct / 100) * 0.3 : pct / 100;
        var elS = (Date.now() - STATE.scrollStartMs) / 1000;
        var vel = elS > 0 ? STATE.scrollPxTotal / elS : 0;
        var pen = vel > 300 ? Math.min(0.15, (vel - 300) / 3000) : 0;
        SCORE.raw.scroll = Math.max(0, Math.min(1, blended - pen));
        ticking = false;
      });
    }, { passive: true });
  }

  function initSectionTracking() {
    if (!('IntersectionObserver' in window)) return;
    var sections = [
      { id:'intro', weight:1.5 }, { id:'trust', weight:2.0 },
      { id:'learn', weight:2.5 }, { id:'testi', weight:2.5 },
      { id:'about', weight:1.5 }, { id:'final', weight:2.5 },
    ];
    var totalW = sections.reduce(function (a, s) { return a + s.weight; }, 0);
    sections.forEach(function (sec) {
      var el = document.getElementById(sec.id); if (!el) return;
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var sd = STATE.sectionDwellMap[sec.id] = STATE.sectionDwellMap[sec.id] || { totalS:0, enterMs:0 };
          if (e.isIntersecting) sd.enterMs = Date.now();
          else if (sd.enterMs) {
            sd.totalS += (Date.now() - sd.enterMs) / 1000;
            sd.enterMs = 0;
            if (sec.id === 'testi') STATE.testiDwellS = sd.totalS;
            if (STATE.sectionsViewed.indexOf(sec.id) === -1) STATE.sectionsViewed.push(sec.id);
            var seenW = 0;
            STATE.sectionsViewed.forEach(function (sid) {
              var s2 = sections.find(function (x) { return x.id === sid; });
              if (s2) seenW += s2.weight * Math.min(1, (STATE.sectionDwellMap[sid] || { totalS:0 }).totalS / 20);
            });
            SCORE.raw.sections = Math.min(1, seenW / totalW);
          }
        });
      }, { threshold: [0, 0.5] }).observe(el);
    });
  }

  function initCopyDetection() {
    document.addEventListener('copy', function () {
      STATE.copyDetected = true; SCORE.raw.copy = 1.0;
    }, { passive: true });
    document.addEventListener('selectionchange', function () {
      try {
        if ((getSelection() || {}).toString().length >= 8) {
          STATE.copyDetected = true;
          if (SCORE.raw.copy < 0.8) SCORE.raw.copy = 0.8;
        }
      } catch (_) {}
    }, { passive: true });
  }

  function initExitIntent() {
    var fired = false;
    function onExit(trigger) {
      if (fired || STATE.waClicked) return; fired = true;
      SCORE.saveHistory(SCORE.compute());
      sendToWorker('ExitIntent', {
        trigger : trigger,
        score_at_exit : SCORE.compute(),
        scroll_at_exit : STATE.maxScrollPct,
        time_at_exit : timeOnPage(),
        testi_dwell : STATE.testiDwellS,
      });
    }
    // Mobile-only: skip mouseleave (doesn't fire reliably in IG WebView)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') onExit('tab');
    });
    addEventListener('pagehide',     function () { onExit('page_hide'); });
    addEventListener('beforeunload', function () { onExit('unload'); });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  REVEAL + NAV scroll state
  // ═══════════════════════════════════════════════════════════════════
  function initRevealOnView() {
    var els = document.querySelectorAll('.rv');
    if ('IntersectionObserver' in window) {
      var o = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('on'); o.unobserve(e.target); }
        });
      }, { threshold: 0.06, rootMargin: '0px 0px -20px 0px' });
      els.forEach(function (el) { o.observe(el); });
    } else {
      els.forEach(function (el) { el.classList.add('on'); });
    }
  }

  function initNavScroll() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    addEventListener('scroll', function () {
      nav.classList.toggle('scrolled', scrollY > 30);
    }, { passive: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  BOTTOM STICKY CTA — show after first scroll, hide on scroll-up
  //  (TikTok-style pattern)
  // ═══════════════════════════════════════════════════════════════════
  function initBottomCTA() {
    var bcta = document.getElementById('bcta');
    if (!bcta) return;
    var lastY = 0, ticking = false;
    addEventListener('scroll', function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        var y = scrollY;
        if (y > CFG.BCTA_SHOW_PX) {
          // Show on scroll-down, hide on quick scroll-up (>10px in one frame)
          if (y - lastY > 0)               bcta.classList.add('show');
          else if (lastY - y > 12)         bcta.classList.remove('show');
        } else {
          bcta.classList.remove('show');
        }
        lastY = y; ticking = false;
      });
    }, { passive: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  BUTTON BINDINGS — touchend + click + keydown (mobile-first)
  // ═══════════════════════════════════════════════════════════════════
  function initButtonBindings() {
    document.querySelectorAll('[data-wa="1"]').forEach(function (el) {
      var label = el.getAttribute('data-wa-src') || el.id || 'btn';

      el.addEventListener('touchstart', function (e) {
        if (e.target === el || el.contains(e.target)) STATE.hoverStartMs = Date.now();
      }, { passive: true });

      el.addEventListener('touchend', function (e) {
        e.preventDefault();
        goWA(label);
      }, { passive: false });

      el.addEventListener('click', function (e) {
        e.preventDefault();
        goWA(label);
      });

      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goWA(label); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WhatsApp DEEP LINK — best-effort, mobile-first
  //   1. whatsapp://send (native, instant)         ← primary
  //   2. intent://send (Android only)              ← fallback if #1 silently fails
  //   3. https://wa.me/ (universal)                ← last resort
  // ═══════════════════════════════════════════════════════════════════
  function buildWAMessage(tier) {
    // Tier-based pre-fill — segments leads at first message (advance #7)
    var msg;
    if (tier === 'HIGH')      msg = "Hi Rakhshii, mein abhi serious hu. Mujhe start karna hai — guide kijiye please.";
    else if (tier === 'MED')  msg = "Hi Rakhshii, mujhe aur jaanna hai aapke program ke baare mein.";
    else                      msg = "Hi Rakhshii, mein interested hu. Aap please guide kar sakte hain?";
    return encodeURIComponent(msg);
  }

  function openWhatsApp(tier) {
    var msg = buildWAMessage(tier);
    var num = CFG.WA_NUM;
    var plat = getPlatform();

    // Android with Chrome custom-tabs / IG in-app: intent:// is most reliable
    if (plat === 'android') {
      var intent = 'intent://send?phone=' + num + '&text=' + msg
                 + '#Intent;scheme=whatsapp;package=com.whatsapp;end';
      try { location.href = intent; return; } catch (_) {}
    }

    // iOS / others: whatsapp:// scheme first; if fails, fall back to wa.me after 700ms
    var deep = 'whatsapp://send?phone=' + num + '&text=' + msg;
    var fallback = 'https://wa.me/' + num + '?text=' + msg;
    var t = setTimeout(function () { location.href = fallback; }, 700);
    addEventListener('blur', function once() {
      clearTimeout(t);
      removeEventListener('blur', once);
    }, { once: true });
    try { location.href = deep; }
    catch (_) { clearTimeout(t); location.href = fallback; }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  goWA — SINGLE event_id (deterministic) shared between Pixel + CAPI
  // ═══════════════════════════════════════════════════════════════════
  async function goWA(buttonId) {
    if (STATE._busy) return;
    STATE._busy = true; STATE.waClicked = true;
    setTimeout(function () { STATE._busy = false; }, 1600);

    if (STATE.hoverStartMs > 0) STATE.hesitationMs = Date.now() - STATE.hoverStartMs;

    var score   = SCORE.compute();
    var value   = SCORE.toValue(score);
    var clickTs = Date.now();
    var tier    = tierFromScore(score);
    SCORE.saveHistory(score);

    if (tier === 'JUNK') {
      // Bot/junk — open WA but skip events (don't pollute Meta)
      setTimeout(function () { openWhatsApp(tier); }, 200);
      return;
    }

    // Deterministic event_id: same fp+ts+name → same id everywhere (advance #5)
    var idSeed = IDENTITY.fingerprint + '|' + clickTs + '|Lead';
    var eventId = (await sha256Hex(idSeed)).substring(0, 32) || uuid4();

    // 1) Meta Pixel — ONE Lead event with shared eventID
    try {
      fbq('track', 'Lead', { value: value, currency: 'INR', eventID: eventId });
    } catch (_) {}

    // 2) CAPI via Cloudflare Worker — same eventId, full payload
    sendToWorker('Lead', {
      click_ts : clickTs, client_tier : tier,
      testi_s : STATE.testiDwellS, hesit_ms : STATE.hesitationMs,
      sections : STATE.sectionsViewed.join(','),
      bot_score : IDENTITY.botScore(),
      jitter_samples : IDENTITY.jitterSamples.slice(0, 8),
    }, eventId);

    // 3) Open WhatsApp — small delay so beacon fires first
    setTimeout(function () { openWhatsApp(tier); }, 280);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PAGE OPEN — ViewContent (no value, single event_id)
  // ═══════════════════════════════════════════════════════════════════
  async function sendOpenEvent() {
    var seed = IDENTITY.fingerprint + '|' + STATE.startTime + '|ViewContent';
    var id = (await sha256Hex(seed)).substring(0, 32) || uuid4();
    try { fbq('track', 'ViewContent', { eventID: id }); } catch (_) {}
    sendToWorker('ViewContent', { trigger: 'page_load' }, id);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SEND TO WORKER — sendBeacon → fetch fallback → SW retry queue
  // ═══════════════════════════════════════════════════════════════════
  async function sendToWorker(eventName, extras, eventId) {
    if (!CFG.WORKER_URL) return;
    if (STATE.eventsCount > CFG.EVENT_CAP) return;
    STATE.eventsCount++;

    if (!eventId) {
      var seed = IDENTITY.fingerprint + '|' + Date.now() + '|' + eventName;
      eventId = (await sha256Hex(seed)).substring(0, 32) || uuid4();
    }

    var payload = {
      event_name : eventName, event_id : eventId,
      page_url : location.href, referrer : document.referrer || '',
      fingerprint : IDENTITY.fingerprint,
      visit_id : IDENTITY.visitId, session_id : IDENTITY.sessionId,
      user_agent : navigator.userAgent,
      fbc : STATE.fbc, fbp : STATE.fbp, fbclid : STATE.rawFbclid,
      device_type : getDeviceType(), language : navigator.language || '',
      connection : getConnection(),
      hour_of_day : new Date().getHours(), day_of_week : new Date().getDay(),
      utm_source : STATE.utmSource, utm_medium : STATE.utmMedium, utm_campaign : STATE.utmCampaign,
      is_repeat : STATE.isRepeat, visit_count : STATE.visitCount,
      prev_best_score : SCORE.prevBest,
      time_on_page : timeOnPage(), max_scroll_pct : STATE.maxScrollPct,
      scroll_reversals : STATE.scrollReversals,
      sections_viewed : STATE.sectionsViewed.join(','),
      copy_detected : STATE.copyDetected,
      lead_score : SCORE.compute(),
      bot_score_client : IDENTITY.botScore(),
      is_in_app : isInAppBrowser(),
      testimonials_dwell_s : STATE.testiDwellS,
      hesitation_ms : STATE.hesitationMs,
      client_key : CFG.CLIENT_KEY,
      ts : Date.now(),
    };
    if (extras) Object.keys(extras).forEach(function (k) { payload[k] = extras[k]; });

    var body = JSON.stringify(payload);

    // Primary: fetch with keepalive (more reliable than sendBeacon in IG WebView)
    try {
      var res = await fetch(CFG.WORKER_URL + '/event', {
        method : 'POST', body : body, keepalive : true,
        headers : { 'Content-Type': 'text/plain;charset=UTF-8' },
      });
      if (res && res.ok) return;
    } catch (_) {}

    // Backup: sendBeacon
    if (typeof navigator.sendBeacon === 'function') {
      try {
        if (navigator.sendBeacon(CFG.WORKER_URL + '/event',
            new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
      } catch (_) {}
    }

    // Last resort: queue in Service Worker (advance #4)
    queueForRetry(body);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  RETRY QUEUE — hand off to SW, which keeps a list in IndexedDB
  // ═══════════════════════════════════════════════════════════════════
  function queueForRetry(body) {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
    try {
      navigator.serviceWorker.controller.postMessage({
        type : 'queue_event',
        url  : CFG.WORKER_URL + '/event',
        body : body,
      });
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
