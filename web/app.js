/* Verse — kinetic lyrics renderer
 * The native shell calls:
 *   verse.track({id,name,artist,album,duration,artwork})
 *   verse.position(seconds, playing)
 *   verse.audio(rms, bass, onset)
 *   verse.status(code)
 * Open index.html?demo in a browser to preview without Spotify.
 */
'use strict';

(() => {
  // ------------------------------------------------------------------ utils
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const c01 = (v) => clamp(v, 0, 1);
  const lerp = (a, b, p) => a + (b - a) * p;
  const E = {
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    outQuart: (p) => 1 - Math.pow(1 - p, 4),
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    inCubic: (p) => p * p * p,
    outBack: (p) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('verse:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('verse:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() ||
    '-apple-system, "Helvetica Neue", Arial, sans-serif';
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const FREEZE = params.has('t') ? parseFloat(params.get('t')) : null;

  const stage = $('#stage');
  const dotsEl = $('#dots');
  const dotEls = [...dotsEl.children];
  const blobA = $('#blobA'), blobB = $('#blobB'), flashEl = $('#flash');
  const hud = $('#hud'), hudTitle = $('#hud-title'), hudArtist = $('#hud-artist'), fill = $('#progress-fill');
  const msg = $('#message'), toastEl = $('#toast'), dbg = $('#debug');
  const glowEl = $('#glow'), fogEl = $('#fog'), glowBtn = $('#glow-btn');
  const coverEl = $('#cover'), coverLayers = [...coverEl.children], coverBtn = $('#cover-btn');
  const visBtn = $('#vis-btn');
  const artEl = $('#art3d'), artCam = artEl.querySelector('.cam'), artGloss = artEl.querySelector('.gloss');
  const artImgs = [artEl.querySelector('.backdrop'), artEl.querySelector('.face'), artEl.querySelector('.refl'), ...artEl.querySelectorAll('.edge')];

  // ------------------------------------------------------------------ state
  const S = {
    track: null,
    lines: [],
    title: null,
    status: 'boot',
    anchorPos: 0, anchorAt: performance.now(), playing: false,
    corr: 0, corrTarget: 0,
    offset: store.get('offset', 0),
    lastMode: 'calm',
    lyricsState: 'none', // none | loading | ok | missing | instrumental | error
    fetchToken: 0,
  };
  const A = {
    has: false, lastAt: 0,
    rms: 0, rmsSlow: 0, bass: 0, peak: 0.25, bassPeak: 0.05,
    loudSlow: 0, bassN: 0,
    kick: 0, shake: 0, shakeAt: 0, shakeAng: 0,
    onsets: [],
  };
  const EXIT = { calm: 0.4, mid: 0.3, high: 0.28 };
  const PULSE = { calm: 0.006, mid: 0.016, high: 0.032 };
  const FLASH = { calm: 0.0, mid: 0.35, high: 0.75 };

  // ------------------------------------------------------------------ time
  const LATENCY = 0.03;
  function baseTime(now) {
    return S.playing ? S.anchorPos + (now - S.anchorAt) / 1000 : S.anchorPos;
  }
  function rawTime(now) {
    if (FREEZE != null) return FREEZE;
    return baseTime(now) + S.corr;
  }
  const songTime = (now) => rawTime(now) + S.offset + (FREEZE != null ? 0 : LATENCY);

  // ------------------------------------------------------------------ text measuring
  const meas = document.createElement('canvas').getContext('2d');
  function textW(text, weight, ls) {
    meas.font = `${weight} 100px ${FONT}`;
    return meas.measureText(text).width + ls * 100 * [...text].length;
  }

  // ------------------------------------------------------------------ lyrics
  const cleanTitle = (s) => (s || '')
    .replace(/\s*[-–—]\s*(\d{4}\s*)?(remaster|remastered|version|edit|mix|remix|live|mono|stereo|deluxe|bonus|from\b|single).*$/i, '')
    .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/ig, '')
    .trim();
  const primaryArtist = (s) => (s || '').split(/\s*(?:,|&| x | feat\.? | ft\.? )\s*/i)[0].trim();

  // When running inside the Mac app, network goes through Swift (no CORS limits).
  const NATIVE = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.net;
  const pendingNet = new Map();
  let netId = 0;
  function nativeGet(url, kind) {
    return new Promise((resolve) => {
      const id = ++netId;
      pendingNet.set(id, resolve);
      NATIVE.postMessage({ id, url, kind });
      setTimeout(() => { if (pendingNet.has(id)) { pendingNet.delete(id); resolve({ status: 0, error: 'timed out' }); } }, 25000);
    });
  }

  async function getJSON(url) {
    if (NATIVE) {
      const r = await nativeGet(url, 'text');
      if (!r || r.error || (r.status && r.status !== 200 && r.status !== 404)) {
        S.netError = (r && (r.error || ('HTTP ' + r.status))) || 'no response';
      }
      try { return r && r.body ? JSON.parse(r.body) : null; } catch (e) { S.netError = 'bad JSON'; return null; }
    }
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; } finally { clearTimeout(to); }
  }

  // Loose name normaliser for matching Spotify titles to LRCLIB entries
  const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[([].*?[)\]]/g, '').replace(/\s[-–—]\s.*$/, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

  async function findLyrics(tr) {
    const cached = store.get('lrc:' + tr.id, null);
    if (cached) return cached;
    const base = 'https://lrclib.net/api/';
    const q = (o) => new URLSearchParams(o).toString();
    const d = Math.round(tr.duration || 0);
    const name = cleanTitle(tr.name), artist = primaryArtist(tr.artist);
    const wantT = norm(name), wantA = norm(artist);

    // score a candidate: title must match, artist should match, closer length wins
    const score = (x) => {
      if (!x || x.instrumental) return x && x.instrumental ? 1 : -1;
      const tn = norm(x.trackName), an = norm(x.artistName);
      let sc;
      if (tn === wantT) sc = 60;
      else if (tn && wantT && (tn.includes(wantT) || wantT.includes(tn))) sc = 30;
      else return -1;
      if (an === wantA) sc += 40;
      else if (an && wantA && (an.includes(wantA) || wantA.includes(an))) sc += 25;
      else sc -= 30;
      if (d && x.duration) {
        const dd = Math.abs(x.duration - d);
        if (dd > 30) return -1;          // almost certainly a different version
        sc += 25 - dd;                   // prefer the closest length
      }
      return sc;
    };

    // ask in parallel: exact match + fuzzy search
    const ask = () => Promise.all([
      getJSON(base + 'get?' + q({ track_name: tr.name, artist_name: tr.artist, album_name: tr.album || '', duration: d })),
      getJSON(base + 'search?' + q({ track_name: name, artist_name: artist })),
    ]);
    let [exact, list1] = await ask();
    if (list1 == null) { // search failed (site hiccup) — try once more
      await new Promise((r) => setTimeout(r, 1500));
      [exact, list1] = await ask();
    }
    let cands = [];
    if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) cands.push(exact);
    if (Array.isArray(list1)) cands = cands.concat(list1);
    const bestOf = (arr, pred) => arr.filter(pred).map((x) => [score(x), x]).filter(([sc]) => sc > 0)
      .sort((a, b) => b[0] - a[0])[0];

    let syncedBest = bestOf(cands, (x) => x.syncedLyrics);
    if (!syncedBest) {
      const list2 = await getJSON(base + 'search?' + q({ q: name + ' ' + artist }));
      if (Array.isArray(list2)) cands = cands.concat(list2);
      syncedBest = bestOf(cands, (x) => x.syncedLyrics);
    }

    let out = null;
    if (syncedBest) out = { synced: syncedBest[1].syncedLyrics, instrumental: false };
    else if (cands.some((x) => x.instrumental && score({ ...x, instrumental: false }) > 0)) out = { synced: '', instrumental: true };
    else {
      const plainBest = bestOf(cands, (x) => x.plainLyrics);
      if (plainBest) out = { synced: '', plain: plainBest[1].plainLyrics, instrumental: false };
    }
    if (out) store.set('lrc:' + tr.id, out);
    return out;
  }

  // Plain (untimed) lyrics: spread lines across the song by length.
  // Rough, but better than a blank screen — use [ / ] to nudge.
  function plainToEntries(text, duration) {
    const rows = text.split(/\r?\n/).map((x) => x.trim());
    const D = duration || 200;
    const start = Math.min(D * 0.08, 16), end = D * 0.93;
    const w = rows.map((r) => (r ? 1.2 + r.length * 0.045 : 1.6)); // blank line = stanza pause
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const out = [];
    let acc = 0;
    rows.forEach((r, i) => {
      out.push({ t: start + (end - start) * (acc / total), text: r, wt: null });
      acc += w[i];
    });
    return out;
  }

  function parseLRC(text) {
    const out = [];
    const tagRe = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
    for (const raw of text.split(/\r?\n/)) {
      const tags = [...raw.matchAll(tagRe)];
      if (!tags.length) continue;
      let body = raw.replace(tagRe, '').trim();
      let wt = null;
      if (/<\d+:\d+(?:\.\d+)?>/.test(body)) {
        wt = [];
        const re = /<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g;
        let m;
        while ((m = re.exec(body))) {
          const t = +m[1] * 60 + parseFloat(m[2]);
          for (const w of m[3].trim().split(/\s+/).filter(Boolean)) wt.push(t);
        }
        body = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      }
      for (const tg of tags) out.push({ t: +tg[1] * 60 + parseFloat(tg[2].replace(':', '.')), text: body, wt });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  const core = (w) => w.replace(/[^\p{L}\p{N}']/gu, '');

  function buildLines(entries, duration) {
    const lines = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.text || /^[♪♫\s.…-]*$/.test(e.text)) continue;
      const words = e.text.split(/\s+/).filter(Boolean);
      const weights = words.map((w) => 0.14 + 0.058 * core(w).length);
      const est = weights.reduce((a, b) => a + b, 0);
      const next = entries[i + 1];
      const nextT = next ? next.t : Math.min(e.t + est * 1.6 + 3, duration || 1e9);
      const D = Math.max(0.35, nextT - e.t);
      const span = Math.min(D * 0.9, Math.max(est, Math.min(D * 0.55, est * 2.2)));
      let times;
      if (e.wt && e.wt.length === words.length) times = e.wt.slice();
      else {
        let acc = 0;
        times = words.map((w, k) => { const t = e.t + (span * acc) / est; acc += weights[k]; return t; });
      }
      const lastW = times[times.length - 1];
      const singEnd = Math.max(e.t + span, lastW + 0.2);
      let exitStart;
      if (nextT - singEnd > 4) exitStart = singEnd + 1.8;
      else exitStart = Math.min(Math.max(lastW + 0.28, nextT - 0.3), nextT - 0.1);

      // ad-libs (in parentheses) and emphasis
      let depth = 0;
      const adlib = words.map((w) => {
        const opens = (w.match(/\(/g) || []).length, closes = (w.match(/\)/g) || []).length;
        const inside = depth > 0 || opens > 0;
        depth = Math.max(0, depth + opens - closes);
        return inside;
      });
      let emph = words.findIndex((w) => /!/.test(w));
      if (emph < 0 && words.length >= 3) {
        let best = -1, bl = 4;
        words.forEach((w, k) => { const l = core(w).length; if (!adlib[k] && l > bl) { bl = l; best = k; } });
        emph = best;
      }

      lines.push({
        t: e.t, nextT, exitStart, words, times, adlib, emph,
        wps: words.length / Math.max(0.5, span),
        mode: null, el: null, items: null, rot: 0,
      });
    }
    return lines;
  }

  // ------------------------------------------------------------------ energy → mode
  function energyFor(L) {
    const dens = c01((L.wps - 1.3) / 2.4);
    if (!A.has || performance.now() - A.lastAt > 3000) return { e: dens, dens, loud: 0, beat: 0 };
    const now = performance.now();
    const rate = A.onsets.filter((x) => now - x < 4000).length / 4;
    const beat = c01(rate / 2.0);
    const loud = c01(A.loudSlow * 1.15);
    return { e: 0.45 * loud + 0.35 * beat + 0.2 * dens, dens, loud, beat };
  }
  function pickMode(e) {
    const m = S.lastMode;
    if (m === 'calm') return e > 0.66 ? 'high' : e > 0.4 ? 'mid' : 'calm';
    if (m === 'mid') return e > 0.64 ? 'high' : e < 0.3 ? 'calm' : 'mid';
    return e < 0.26 ? 'calm' : e < 0.55 ? 'mid' : 'high';
  }

  // ------------------------------------------------------------------ layout
  function partition(widths, gap, n) {
    const N = widths.length;
    n = Math.min(n, N);
    const pre = [0];
    widths.forEach((w, i) => pre.push(pre[i] + w));
    const rowW = (a, b) => pre[b] - pre[a] + gap * (b - a - 1);
    const target = rowW(0, N) / n;
    const dp = Array.from({ length: n + 1 }, () => new Array(N + 1).fill(Infinity));
    const cut = Array.from({ length: n + 1 }, () => new Array(N + 1).fill(0));
    dp[0][0] = 0;
    for (let r = 1; r <= n; r++) {
      for (let b = r; b <= N; b++) {
        for (let a = r - 1; a < b; a++) {
          if (dp[r - 1][a] === Infinity) continue;
          const c = dp[r - 1][a] + Math.pow(rowW(a, b) - target, 2);
          if (c < dp[r][b]) { dp[r][b] = c; cut[r][b] = a; }
        }
      }
    }
    const rows = [];
    let b = N;
    for (let r = n; r >= 1; r--) { const a = cut[r][b]; rows.unshift([a, b]); b = a; }
    return rows;
  }

  function rowCount(em) { return em <= 5.2 ? 1 : em <= 11.5 ? 2 : em <= 19 ? 3 : 4; }

  // Justified poster stack: every row scaled to the same width.
  function layoutStack(words, mode, W, H, opts = {}) {
    const weight = mode === 'high' ? 900 : 800;
    const ls = mode === 'high' ? -0.03 : -0.025;
    const disp = words.map((w) => w.toUpperCase());
    const wid = disp.map((w) => textW(w, weight, ls));
    const gap = 24; // at 100px
    const blockW = opts.blockW || Math.min(W * (mode === 'high' ? 0.84 : 0.78), 1500);
    const maxFs = opts.maxFs || H * (mode === 'high' ? 0.3 : 0.24);
    const minFs = 14;

    // rows: optionally isolate the emphasised word in high mode
    let groups = [[0, words.length]];
    const em = opts.emph;
    if (mode === 'high' && em != null && em >= 0 && words.length >= 4) {
      groups = [];
      if (em > 0) groups.push([0, em]);
      groups.push([em, em + 1]);
      if (em < words.length - 1) groups.push([em + 1, words.length]);
    }
    let rows = [];
    for (const [a, b] of groups) {
      const ws = wid.slice(a, b);
      const total = ws.reduce((x, y) => x + y, 0) + gap * (ws.length - 1);
      const n = rowCount(total / 100);
      for (const [ra, rb] of partition(ws, gap, n)) rows.push([a + ra, a + rb]);
    }
    if (rows.length > 5) { // too many rows, fall back to plain balanced split
      const total = wid.reduce((x, y) => x + y, 0) + gap * (wid.length - 1);
      rows = partition(wid, gap, Math.min(4, rowCount(total / 100)));
    }

    let rs = rows.map(([a, b]) => {
      const w100 = wid.slice(a, b).reduce((x, y) => x + y, 0) + gap * (b - a - 1);
      return { a, b, w100, fs: clamp((blockW * 100) / w100, minFs, maxFs) };
    });

    const place = (scale) => {
      const items = [];
      let y = 0, prevFs = null, maxW = 0;
      const CAP_TOP = 0.15, BASE = 0.87;
      rs.forEach((r, ri) => {
        const fs = r.fs * scale;
        if (prevFs != null) y += BASE * prevFs + 0.15 * Math.min(prevFs, fs) - CAP_TOP * fs;
        else y = -CAP_TOP * fs;
        const rw = (r.w100 * fs) / 100;
        maxW = Math.max(maxW, rw);
        r._y = y; r._fs = fs; r._w = rw;
        prevFs = fs;
      });
      const last = rs[rs.length - 1];
      const h = last._y + BASE * last._fs;
      rs.forEach((r, ri) => {
        let x = (maxW - r._w) / 2;
        for (let k = r.a; k < r.b; k++) {
          items.push({ k, x, y: r._y, fs: r._fs, row: ri, text: disp[k] });
          x += ((wid[k] + gap) * r._fs) / 100;
        }
      });
      return { items, w: maxW, h };
    };
    let out = place(1);
    const maxH = opts.maxH || H * 0.68;
    if (out.h > maxH) out = place(maxH / out.h);
    out.items.sort((p, q) => p.k - q.k);
    out.rows = rs.length;
    return out;
  }

  // Calm: centred, mixed case, gentle wrap.
  function layoutCalm(words, W, H) {
    let fs = clamp(Math.min(H * 0.088, W * 0.062), 20, 96);
    const ls = -0.012;
    for (let attempt = 0; attempt < 6; attempt++) {
      const maxW = Math.min(W * 0.8, fs * 15);
      const wid = words.map((w) => (textW(w, 500, ls) * fs) / 100);
      const sp = 0.27 * fs;
      const rows = [];
      let cur = [], cw = 0;
      wid.forEach((w, k) => {
        const add = cur.length ? sp + w : w;
        if (cur.length && cw + add > maxW) { rows.push({ ks: cur, w: cw }); cur = [k]; cw = w; }
        else { cur.push(k); cw += add; }
      });
      if (cur.length) rows.push({ ks: cur, w: cw });
      if (rows.length > 3 && attempt < 5) { fs *= 0.86; continue; }
      const lh = fs * 1.22;
      const bw = Math.max(...rows.map((r) => r.w));
      const items = [];
      rows.forEach((r, ri) => {
        let x = (bw - r.w) / 2;
        r.ks.forEach((k) => { items.push({ k, x, y: ri * lh, fs, row: ri, text: words[k] }); x += wid[k] + sp; });
      });
      items.sort((p, q) => p.k - q.k);
      return { items, w: bw, h: rows.length * lh, rows: rows.length };
    }
  }

  // ------------------------------------------------------------------ DOM build
  function build(L) {
    const W = innerWidth, H = innerHeight;
    if (!L.mode) {
      if (L.isTitle) L.mode = 'mid';
      else {
        const en = energyFor(L);
        L.energy = en;
        L.mode = pickMode(en.e);
        S.lastMode = L.mode;
      }
      L.rot = L.mode === 'high' ? (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.2) : 0;
    }
    const lay = L.mode === 'calm'
      ? layoutCalm(L.words, W, H)
      : layoutStack(L.words, L.mode, W, H, L.isTitle
        ? { blockW: Math.min(W * 0.58, 1100), maxFs: H * 0.17, maxH: H * 0.5 }
        : { emph: L.emph });

    const el = document.createElement('div');
    el.className = 'line mode-' + L.mode + (L.isTitle ? ' title' : '');
    el.style.width = lay.w + 'px';
    el.style.height = lay.h + 'px';
    el.style.transformOrigin = '50% 50%';
    const useMask = L.mode === 'mid';
    L.items = lay.items.map((it) => {
      const w = document.createElement('span');
      w.className = 'w' + (useMask ? ' mask' : '') +
        (!L.isTitle && L.mode !== 'calm' && it.k === L.emph ? ' emph' : '') +
        (L.adlib && L.adlib[it.k] ? ' adlib' : '');
      w.style.left = it.x + 'px';
      w.style.top = it.y + 'px';
      w.style.fontSize = it.fs + 'px';
      const inner = document.createElement('span');
      inner.className = 'i';
      inner.textContent = it.text;
      w.appendChild(inner);
      el.appendChild(w);
      return { ...it, el: w, inner };
    });
    if (L.isTitle) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      const sfs = clamp(H * 0.022, 11, 17);
      sub.style.fontSize = sfs + 'px';
      sub.style.top = lay.h + sfs * 2 + 'px';
      sub.textContent = L.sub || '';
      el.appendChild(sub);
      const note = document.createElement('div');
      note.className = 'sub';
      note.style.fontSize = sfs * 0.85 + 'px';
      note.style.top = lay.h + sfs * 4.6 + 'px';
      note.style.letterSpacing = '.18em';
      note.style.color = 'rgba(255,255,255,.35)';
      el.appendChild(note);
      L.subEl = sub; L.noteEl = note;
    }
    stage.appendChild(el);
    L.el = el;
  }
  function destroy(L) { if (L.el) { L.el.remove(); L.el = null; L.items = null; } }

  // ------------------------------------------------------------------ per-frame render
  // Only touch the DOM when a value actually changes.
  function set(el, prop, val) {
    const c = el._c || (el._c = {});
    if (c[prop] !== val) { c[prop] = val; el.style[prop] = val; }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  function renderLine(L, t, now) {
    const mode = L.mode;
    const ex = c01((t - L.exitStart) / EXIT[mode]);
    let impact = 0;

    for (const it of L.items) {
      const dt = t - L.times[it.k];
      const w = it.el, wi = it.inner;
      if (mode === 'calm') {
        const p = E.outCubic(c01(dt / 0.75));
        set(w, 'opacity', String(r2(p)));
        set(w, 'transform', `translate3d(0,${r2((1 - p) * it.fs * 0.32)}px,0)`);
        set(w, 'filter', p > 0 && p < 1 ? `blur(${r2((1 - p) * 6)}px)` : 'none');
      } else if (mode === 'mid') {
        const p = E.outExpo(c01(dt / 0.6));
        const ep = E.inCubic(c01((t - L.exitStart - it.row * 0.035) / 0.24));
        const y = ep > 0 ? -ep * 112 : (1 - p) * 112;
        set(wi, 'transform', `translate3d(0,${r2(y)}%,0)`);
        set(w, 'opacity', dt < 0 ? '0' : '1');
      } else {
        const p = c01(dt / 0.34);
        const sc = lerp(1.75, 1, E.outBack(p));
        set(w, 'opacity', String(r2(c01(dt / 0.06))));
        set(w, 'transform', `scale(${Math.round(sc * 1000) / 1000})`);
        if (dt >= 0 && dt < 0.4) impact = Math.max(impact, Math.exp(-dt / 0.09));
      }
    }

    // line-level motion
    const pulse = 1 + PULSE[mode] * A.kick + (mode === 'high' ? 0.018 * impact : 0);
    let tx = 0, ty = 0, rot = L.rot, sc = pulse, op = 1, blur = 0;
    if (mode === 'high') {
      const sh = Math.max(A.shake, impact * 0.5);
      const ph = (now - A.shakeAt) * 0.055;
      tx = Math.cos(A.shakeAng) * Math.sin(ph) * 9 * sh;
      ty = Math.sin(A.shakeAng) * Math.sin(ph) * 9 * sh;
      sc *= 1 + E.inCubic(ex) * 0.32;
      op = 1 - E.inCubic(ex);
    } else if (mode === 'calm') {
      ty = -E.inCubic(ex) * 26;
      op = 1 - ex;
    }
    set(L.el, 'transform', `translate(-50%,-50%) translate3d(${r2(tx)}px,${r2(ty)}px,0) rotate(${r2(rot)}deg) scale(${Math.round(sc * 1000) / 1000})`);
    set(L.el, 'opacity', String(r2(op)));
  }

  // ------------------------------------------------------------------ title card
  function makeTitle(tr, base) {
    const name = cleanTitle(tr.name) || tr.name || '';
    const words = name.split(/\s+/).filter(Boolean);
    return {
      isTitle: true, words, sub: tr.artist || '',
      times: words.map((w, k) => base + 0.25 + k * 0.11),
      exitStart: Infinity, mode: null, el: null, items: null,
      adlib: null, emph: -1, rot: 0,
    };
  }

  function setLines(lyr) {
    S.lines.forEach(destroy);
    const title = S.title;
    if (title) {
      const first = lyr.length ? lyr[0].t : Infinity;
      const ex = first - 0.75;
      if (lyr.length && ex - title.times[0] < 1.8) { destroy(title); S.title = null; }
      else title.exitStart = ex - title.times[0] > 14 ? title.times[0] + 6 : ex;
    }
    S.lines = lyr;
  }

  // ------------------------------------------------------------------ palette
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }
  function applyPalette(acc, c1, c2) {
    const r = document.documentElement.style;
    r.setProperty('--accent', acc.join(','));
    r.setProperty('--c1', c1.join(','));
    r.setProperty('--c2', c2.join(','));
    // bright versions of the album colours for the border glow
    const bright = (c, l) => { const [h, s] = rgbToHsl(c[0], c[1], c[2]); return hslToRgb(h, Math.max(s, 0.55), l); };
    const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
    r.setProperty('--g1', rgb(acc));
    r.setProperty('--g2', rgb(bright(c1, 0.62)));
    r.setProperty('--g3', rgb(bright(c2, 0.6)));
  }
  const DEFAULT_PAL = () => applyPalette([255, 64, 110], [70, 40, 120], [20, 60, 110]);

  // album art background: two layers so covers crossfade between songs
  let coverIdx = 0, coverToken = 0;
  function showCover(src) {
    S.coverSrc = src || null;
    if (src) { const im = new Image(); im.onload = () => Cloud.build(im); im.src = src; }
    artImgs.forEach((el) => { el.style.backgroundImage = src ? `url("${src}")` : 'none'; });
    const next = coverLayers[coverIdx ^ 1], cur = coverLayers[coverIdx];
    next.style.backgroundImage = src ? `url("${src}")` : 'none';
    if (src) next.classList.add('show'); else next.classList.remove('show');
    cur.classList.remove('show');
    coverIdx ^= 1;
  }

  function loadPalette(url) {
    const token = ++coverToken;
    if (!url) { showCover(null); return DEFAULT_PAL(); }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (token === coverToken) showCover(img.src);
      try {
        const c = document.createElement('canvas'); c.width = c.height = 36;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 36, 36);
        const d = g.getImageData(0, 0, 36, 36).data;
        const bins = Array.from({ length: 18 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        let ar = 0, ag = 0, ab = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
          ar += d[i]; ag += d[i + 1]; ab += d[i + 2]; n++;
          if (s < 0.2 || l < 0.1 || l > 0.9) continue;
          const w = s * (1 - Math.abs(l - 0.5) * 1.4);
          const bi = Math.floor(h * 18) % 18;
          bins[bi].w += w; bins[bi].r += d[i] * w; bins[bi].g += d[i + 1] * w; bins[bi].b += d[i + 2] * w;
        }
        const ranked = bins.map((b, i) => ({ ...b, i })).filter((b) => b.w > 0.6).sort((a, b) => b.w - a.w);
        if (!ranked.length) {
          const [, , l] = rgbToHsl(ar / n, ag / n, ab / n);
          applyPalette([255, 255, 255].map((v) => v * 0.92), hslToRgb(0, 0, clamp(l * 0.4, 0.12, 0.22)), hslToRgb(0, 0, 0.1));
          return;
        }
        const col = (b) => rgbToHsl(b.r / b.w, b.g / b.w, b.b / b.w);
        const top = ranked[0];
        const second = ranked.find((b) => Math.min(Math.abs(b.i - top.i), 18 - Math.abs(b.i - top.i)) >= 2) || top;
        const [h1, s1] = col(top), [h2, s2] = col(second);
        applyPalette(
          hslToRgb(h1, Math.max(s1, 0.62), 0.64),
          hslToRgb(h1, Math.max(s1, 0.5) * 0.9, 0.3),
          hslToRgb(h2, Math.max(s2, 0.45) * 0.85, 0.24),
        );
      } catch (e) { DEFAULT_PAL(); }
    };
    img.onerror = DEFAULT_PAL;
    if (NATIVE) nativeGet(url, 'image').then((r) => { if (r && r.body) img.src = r.body; else DEFAULT_PAL(); });
    else img.src = url;
  }

  // ------------------------------------------------------------------ UI bits
  let toastTimer = 0;
  function toast(text, ms = 1400) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  const MESSAGES = {
    'no-spotify': ['Spotify isn’t installed', 'Install the Spotify desktop app. Verse reads whatever it’s playing.'],
    'not-running': ['Open Spotify', 'Play a song and the lyrics will show up here.'],
    'idle': ['Nothing playing', 'Hit play in Spotify.'],
    'auth': ['Let Verse see Spotify', 'System Settings → Privacy & Security → Automation → Verse → turn on Spotify. Then reopen Verse.'],
    'error': ['Couldn’t read Spotify', ''],
    'boot': ['', ''],
  };
  function showMessage(code, detail) {
    const m = MESSAGES[code];
    if (!m || !m[0]) { msg.classList.remove('show'); return; }
    msg.querySelector('.m-title').textContent = m[0];
    msg.querySelector('.m-sub').textContent = detail || m[1];
    msg.classList.add('show');
  }

  // ---- border effect: strip → fog → off
  const BORDER_MODES = ['strip', 'fog', 'off'];
  const BORDER_NAMES = { strip: 'Border · Strip', fog: 'Border · Fog', off: 'Border · Off' };
  let borderMode = 'off';
  function setBorder(mode, announce) {
    borderMode = BORDER_MODES.includes(mode) ? mode : 'off';
    glowEl.classList.toggle('on', borderMode === 'strip');
    fogEl.classList.toggle('on', borderMode === 'fog');
    glowBtn.classList.toggle('strip', borderMode === 'strip');
    glowBtn.classList.toggle('fog', borderMode === 'fog');
    store.set('border', borderMode);
    if (announce) toast(BORDER_NAMES[borderMode], 900);
  }
  let visMode = 'card';
  function setVis(mode, announce) {
    visMode = mode === 'cloud' ? 'cloud' : 'card';
    artEl.classList.toggle('cloud', visMode === 'cloud');
    visBtn.classList.toggle('cloud', visMode === 'cloud');
    store.set('vis', visMode);
    if (announce) toast(visMode === 'cloud' ? 'Visualiser · Point cloud' : 'Visualiser · Floating card', 900);
  }
  setVis(params.get('vis') || store.get('vis', 'card'), false);
  visBtn.addEventListener('click', (e) => { e.stopPropagation(); setVis(visMode === 'cloud' ? 'card' : 'cloud', true); });

  function setCover(on, announce) {
    coverEl.classList.toggle('on', on);
    coverBtn.classList.toggle('on', on);
    document.body.classList.toggle('cover-on', on);
    store.set('cover', on);
    if (announce) toast(on ? 'Album art background on' : 'Album art background off', 900);
  }
  setCover(params.has('cover') || store.get('cover', false), false);
  coverBtn.addEventListener('click', (e) => { e.stopPropagation(); setCover(!coverEl.classList.contains('on'), true); });
  window.__showCover = showCover; // used by the demo preview

  const cycleBorder = () => setBorder(BORDER_MODES[(BORDER_MODES.indexOf(borderMode) + 1) % BORDER_MODES.length], true);
  setBorder(params.get('border') || store.get('border', store.get('glow', false) ? 'strip' : 'off'), false);
  glowBtn.addEventListener('click', (e) => { e.stopPropagation(); cycleBorder(); });

  let lastMove = performance.now();
  addEventListener('mousemove', () => { lastMove = performance.now(); document.body.style.cursor = 'default'; });

  function nudge(d) {
    S.offset = Math.round((S.offset + d) * 100) / 100;
    if (d === 0) S.offset = 0;
    store.set('offset', S.offset);
    toast(S.offset === 0 ? 'Sync reset' : `Lyrics ${S.offset > 0 ? 'earlier' : 'later'} · ${Math.abs(S.offset).toFixed(1)}s`);
  }
  addEventListener('keydown', (e) => {
    if (e.metaKey) return;
    const big = e.shiftKey ? 0.5 : 0.1;
    if (e.key === ']' || e.key === '}') nudge(big);
    else if (e.key === '[' || e.key === '{') nudge(-big);
    else if (e.key === '0') nudge(0);
    else if (e.key === 'd' || e.key === 'D') dbg.classList.toggle('show');
    else if (e.key === 'g' || e.key === 'G') cycleBorder();
    else if (e.key === 'b' || e.key === 'B') setCover(!coverEl.classList.contains('on'), true);
    else if (e.key === 'v' || e.key === 'V') setVis(visMode === 'cloud' ? 'card' : 'cloud', true);
  });
  addEventListener('resize', () => { S.lines.forEach(destroy); if (S.title) destroy(S.title); });

  // ------------------------------------------------------------------ public API
  const verse = {
    track(tr) {
      if (S.track && S.track.id === tr.id) return;
      S.track = tr;
      S.status = 'ok'; showMessage('ok');
      S.lines.forEach(destroy); S.lines = [];
      if (S.title) destroy(S.title);
      const base = Math.max(0, rawTime(performance.now()));
      S.title = makeTitle(tr, base < 4 ? 0 : base);
      S.lastMode = 'calm';
      hudTitle.textContent = tr.name || '';
      hudArtist.textContent = tr.artist || '';
      loadPalette(tr.artwork);
      verse.refetch();
    },
    async refetch(force) {
      const tr = S.track; if (!tr || tr.id === 'demo') return;
      if (force) store.set('lrc:' + tr.id, null);
      const token = ++S.fetchToken;
      S.lyricsState = 'loading';
      S.netError = null;
      if (S.title) S.title.note = 'Finding lyrics…';
      const res = await findLyrics(tr);
      if (token !== S.fetchToken) return;
      if (res && res.synced) {
        S.lyricsState = 'ok';
        setLines(buildLines(parseLRC(res.synced), tr.duration));
      } else if (res && res.plain) {
        S.lyricsState = 'approx';
        setLines(buildLines(plainToEntries(res.plain, tr.duration), tr.duration));
        if (S.title) S.title.note = 'Not synced · timing estimated';
        toast('No synced lyrics for this one · timing is estimated', 3500);
      } else {
        S.lyricsState = res && res.instrumental ? 'instrumental' : 'missing';
        setLines([]);
        if (S.title) S.title.exitStart = Math.max(S.title.times[0], rawTime(performance.now())) + 6;
        if (S.title) S.title.note = S.lyricsState === 'instrumental' ? 'Instrumental'
          : S.netError ? 'Lyrics lookup failed · ' + S.netError + ' · ⌘R to retry'
          : 'No synced lyrics found';
      }
    },
    // Never jump the clock for small drift: steer it gently instead,
    // so words don't stutter every time Spotify reports its position.
    position(pos, playing) {
      const now = performance.now();
      const est = baseTime(now);
      if (!playing || !S.playing || Math.abs(pos - (est + S.corr)) > 1.0) {
        S.anchorPos = pos; S.anchorAt = now; S.corr = 0; S.corrTarget = 0;
      } else {
        S.corrTarget += ((pos - est) - S.corrTarget) * 0.35;
      }
      S.playing = !!playing;
    },
    audio(rms, bass, onset) {
      const now = performance.now();
      A.has = true; A.lastAt = now;
      // slow loudness relative to a long-memory peak (~45s half-life), so
      // quiet verses read quiet and choruses read loud within a song
      A.rmsSlow += (rms - A.rmsSlow) * 0.03;
      A.peak = Math.max(A.rmsSlow, A.peak * 0.99975, 0.08);
      A.bassPeak = Math.max(bass, A.bassPeak * 0.9994, 0.01);
      A.loudSlow = A.rmsSlow / A.peak;
      A.bassN += (bass / A.bassPeak - A.bassN) * 0.3;
      if (onset) {
        A.kick = 1;
        A.shake = 1; A.shakeAt = now; A.shakeAng = Math.random() * Math.PI * 2;
        A.onsets.push(now);
        while (A.onsets.length && now - A.onsets[0] > 5000) A.onsets.shift();
      }
    },
    status(code, detail) {
      S.status = code;
      if (code === 'audio-denied') { toast('Beat reaction off · allow Verse in Screen & System Audio Recording, then reopen', 6000); return; }
      if (code !== 'ok') {
        S.track = null; S.playing = false;
        S.lines.forEach(destroy); S.lines = [];
        if (S.title) { destroy(S.title); S.title = null; }
        hudTitle.textContent = ''; hudArtist.textContent = '';
      }
      showMessage(code, detail);
    },
    nudge,
    _net(id, arr) {
      const r = pendingNet.get(id);
      if (r) { pendingNet.delete(id); r(arr ? arr[0] : null); }
    },
  };
  window.verse = verse;

  // ------------------------------------------------------------------ frame loop
  let lastNow = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    if (DEMO) demoTick(now);

    // ease clock correction at most 0.12s per second (invisible)
    const step = 0.12 * dt;
    S.corr += clamp(S.corrTarget - S.corr, -step, step);

    A.kick *= Math.exp(-dt / 0.13);
    A.shake *= Math.exp(-dt / 0.16);

    const t = songTime(now);
    let activeMode = S.lastMode;
    let anyVisible = false;

    const all = S.title ? [S.title, ...S.lines] : S.lines;
    for (const L of all) {
      const exitLen = L.mode ? EXIT[L.mode] : 0.45;
      const vis = t >= L.times[0] - 0.05 && t < L.exitStart + exitLen;
      if (vis) {
        if (!L.el) build(L);
        renderLine(L, t, now);
        if (L.isTitle && L.noteEl && L.noteEl.textContent !== (L.note || '')) L.noteEl.textContent = L.note || '';
        anyVisible = true;
        activeMode = L.mode;
      } else if (L.el) destroy(L);
    }

    // instrumental dots / 3D album art
    let dotsOp = 0, artTarget = 0;
    if (!anyVisible && S.lines.length) {
      let prevEnd = -Infinity, nextT = Infinity;
      for (const L of S.lines) {
        const end = L.exitStart + EXIT[L.mode || 'mid'];
        if (end <= t) prevEnd = Math.max(prevEnd, end);
        else if (L.times[0] > t) { nextT = Math.min(nextT, L.times[0]); }
      }
      const startsAt = (S.title ? S.title.exitStart + 0.3 : -Infinity);
      const from = Math.max(prevEnd, startsAt);
      if (nextT < Infinity && nextT - from > 2.5) {
        const op = c01((t - from - 0.3) / 0.6) * c01((nextT - t - 0.35) / 0.6);
        if (nextT - from >= 6 && S.coverSrc) artTarget = op; else dotsOp = op;
      }
    }
    if (!anyVisible && S.coverSrc && S.track && (S.lyricsState === 'missing' || S.lyricsState === 'instrumental')) artTarget = 1;
    renderArt(artTarget, dt, now);
    dotsEl.style.opacity = dotsOp * 0.75;
    if (dotsOp > 0) dotEls.forEach((d, i) => {
      const b = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now * 0.004 - i * 0.9));
      d.style.transform = `scale(${b * (1 + 0.25 * A.kick)})`;
      d.style.opacity = 0.35 + 0.65 * b;
    });

    // background
    const ts = now / 1000;
    const bassF = A.has ? A.bassN : 0;
    set(blobA, 'transform', `translate3d(${r2(Math.sin(ts * 0.11) * 14)}vw, ${r2(Math.cos(ts * 0.09) * 10)}vh, 0) scale(${r2(1 + 0.07 * bassF)})`);
    set(blobB, 'transform', `translate3d(${r2(Math.cos(ts * 0.08 + 2) * 16)}vw, ${r2(Math.sin(ts * 0.12 + 1) * 12)}vh, 0) scale(${r2(1.05 + 0.05 * bassF)})`);
    const glow = A.has ? 0.38 + 0.25 * A.loudSlow : 0.5;
    set(blobA, 'opacity', String(r2(glow))); set(blobB, 'opacity', String(r2(glow * 0.9)));
    set(flashEl, 'opacity', String(r2(A.kick * FLASH[activeMode])));

    // hud
    const idle = now - lastMove > 2600;
    hud.classList.toggle('hidden', idle && S.playing);
    if (idle && S.playing) document.body.style.cursor = 'none';
    if (S.track && S.track.duration) set(fill, 'width', (c01(rawTime(now) / S.track.duration) * 100).toFixed(1) + '%');

    if (dbg.classList.contains('show')) {
      const cur = all.find((L) => L.el && !L.isTitle);
      const en = cur && cur.energy;
      dbg.textContent =
        `t ${t.toFixed(2)}  offset ${S.offset.toFixed(2)}\n` +
        `mode ${activeMode}  lyrics ${S.lyricsState}\n` +
        `audio ${A.has ? 'on' : 'off'}  loud ${A.loudSlow.toFixed(2)}  bass ${A.bassN.toFixed(2)}\n` +
        (en ? `energy ${en.e.toFixed(2)} (loud ${en.loud.toFixed(2)} beat ${en.beat.toFixed(2)} dens ${en.dens.toFixed(2)})` : '');
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ 3D album art shots
  // A slow virtual camera moving around the cover. Each shot lasts SHOT seconds
  // and eases into the next one.
  const SHOT = 7.5, BLEND = 1.6;
  const SHOTS = [
    (u, z) => ({ rx: 6, ry: lerp(-24, -6, u), rz: 0, tx: 0, ty: 0, tz: lerp(-260, 30, E.outCubic(u)), s: 1 }),            // dolly in
    (u, z) => ({ rx: 10, ry: lerp(30, -30, u), rz: -2, tx: lerp(-40, 40, u), ty: 0, tz: -70, s: 1 }),                    // orbit
    (u, z) => ({ rx: lerp(36, 20, u), ry: -12, rz: 4, tx: 0, ty: lerp(70, 20, u), tz: lerp(-120, 60, u), s: 1 }),        // low angle push
    (u, z) => ({ rx: 4, ry: lerp(-8, 8, u), rz: lerp(-6, -2, u), tx: lerp(0.3, -0.3, u) * z, ty: lerp(0.24, -0.12, u) * z, tz: 0, s: 2.3 }), // macro pan
    (u, z) => ({ rx: 50, ry: 0, rz: lerp(-16, 16, u), tx: 0, ty: 40, tz: -60, s: 1.05 }),                                // top-down float
    (u, z) => ({ rx: -8, ry: lerp(-38, -16, u), rz: 2, tx: lerp(-0.18, 0, u) * z, ty: -10, tz: lerp(40, -40, u), s: 1.15 }), // side reveal
  ];
  const ART = { op: 0, clock: 0, seed: 0, visible: false };
  function shotParams(time, z) {
    const n = SHOTS.length;
    const k = Math.floor(time / SHOT), u = (time % SHOT) / SHOT;
    const a = SHOTS[(k + ART.seed) % n](u, z);
    const blendStart = 1 - BLEND / SHOT;
    if (u < blendStart) return a;
    const b = SHOTS[(k + 1 + ART.seed) % n](0, z);
    const w = (u - blendStart) / (1 - blendStart);
    const sm = w * w * (3 - 2 * w);
    const o = {};
    for (const key in a) o[key] = lerp(a[key], b[key], sm);
    return o;
  }
  function renderArt(target, dt, now) {
    ART.op += (target - ART.op) * Math.min(1, dt * 3.2);
    if (ART.op < 0.004 && target === 0) {
      if (ART.visible) { set(artEl, 'opacity', '0'); ART.visible = false; ART.clock = 0; ART.seed = (ART.seed + 2) % SHOTS.length; }
      return;
    }
    ART.visible = true;
    ART.clock += dt;
    set(artEl, 'opacity', String(r2(ART.op)));
    if (visMode === 'cloud') { Cloud.render(ART.clock, dt); return; }
    const sz = Math.round(Math.min(innerWidth, innerHeight) * 0.5);
    artEl.style.setProperty('--sz', sz + 'px');
    const p = shotParams(ART.clock, sz);
    const kick = 1 + 0.012 * A.kick;
    set(artCam, 'transform',
      `translate3d(${r2(p.tx)}px,${r2(p.ty)}px,${r2(p.tz)}px) rotateX(${r2(p.rx)}deg) rotateY(${r2(p.ry)}deg) rotateZ(${r2(p.rz)}deg) scale(${Math.round(p.s * kick * 1000) / 1000})`);
    set(artGloss, 'backgroundPosition', `${r2(50 - p.ry * 2.2)}% 0`);
    set(artEl, 'opacity', String(r2(ART.op)));
  }

  // ------------------------------------------------------------------ 3D point cloud
  // The cover becomes ~40k points; brightness pushes points toward the camera,
  // so you fly through the artwork. Bass kicks burst the points and punch the camera.
  const Cloud = (() => {
    const canvas = $('#cloud');
    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: false });
    if (!gl) return { build() {}, render() {} };

    const VS = `
      attribute vec3 aPos; attribute vec3 aCol; attribute float aSeed;
      uniform mat4 uProj, uView;
      uniform float uTime, uKick, uBass, uPx;
      varying vec3 vCol; varying float vA;
      void main() {
        vec3 p = aPos;
        float burst = uKick * (0.10 + 0.32 * aSeed);
        p.z += burst * (p.z >= 0.0 ? 1.0 : -1.0) + uBass * 0.06 * aSeed;
        p.xy *= 1.0 + uKick * 0.035;
        p += 0.010 * vec3(sin(uTime * 0.7 + aSeed * 40.0), cos(uTime * 0.6 + aSeed * 31.0), sin(uTime * 0.5 + aSeed * 17.0));
        vec4 mv = uView * vec4(p, 1.0);
        gl_Position = uProj * mv;
        float dist = max(0.05, -mv.z);
        gl_PointSize = clamp(uPx * (1.0 + uKick * 0.5) / dist, 1.0, 48.0);
        vCol = aCol;
        vA = smoothstep(0.06, 0.4, dist) * smoothstep(9.0, 3.5, dist);
      }`;
    const FS = `
      precision mediump float;
      varying vec3 vCol; varying float vA;
      uniform float uGlow;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.1, d) * vA;
        gl_FragColor = vec4(vCol * (0.9 + uGlow * 0.5), a * 0.75);
      }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('cloud shader', gl.getProgramInfoLog(prog)); return { build() {}, render() {} }; }
    const loc = {};
    ['aPos', 'aCol', 'aSeed'].forEach((n) => { loc[n] = gl.getAttribLocation(prog, n); });
    ['uProj', 'uView', 'uTime', 'uKick', 'uBass', 'uPx', 'uGlow'].forEach((n) => { loc[n] = gl.getUniformLocation(prog, n); });
    const buf = gl.createBuffer();
    let count = 0;

    function build(img) {
      const N = 150;   // 22.5k points: plenty of detail, light on the GPU
      const c = document.createElement('canvas'); c.width = c.height = N;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, N, N);
      let d;
      try { d = g.getImageData(0, 0, N, N).data; } catch (e) { return; }
      const DUST = 1800;
      const arr = new Float32Array((N * N + DUST) * 7);
      let o = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 4;
        const r = d[k] / 255, gg = d[k + 1] / 255, b = d[k + 2] / 255;
        const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
        const seed = Math.random();
        arr[o++] = (i / N - 0.5) * 2;
        arr[o++] = -(j / N - 0.5) * 2;
        arr[o++] = (lum - 0.45) * 0.55 + (seed - 0.5) * 0.03;
        arr[o++] = r; arr[o++] = gg; arr[o++] = b;
        arr[o++] = seed;
      }
      // floating dust in the same colours, so the space feels volumetric
      for (let n = 0; n < DUST; n++) {
        const k = Math.floor(Math.random() * N * N) * 4;
        arr[o++] = (Math.random() - 0.5) * 4.5;
        arr[o++] = (Math.random() - 0.5) * 3.2;
        arr[o++] = (Math.random() - 0.5) * 4.0;
        arr[o++] = d[k] / 255 * 0.8; arr[o++] = d[k + 1] / 255 * 0.8; arr[o++] = d[k + 2] / 255 * 0.8;
        arr[o++] = Math.random();
      }
      const total = N * N + DUST;
      for (let i = total - 1; i > 0; i--) {           // shuffle points (7 floats each)
        const j = Math.floor(Math.random() * (i + 1));
        for (let f = 0; f < 7; f++) { const tmp = arr[i * 7 + f]; arr[i * 7 + f] = arr[j * 7 + f]; arr[j * 7 + f] = tmp; }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      count = total;
    }

    // --- tiny matrix helpers
    const PM = new Float32Array(16), VM = new Float32Array(16);
    function persp(fovy, asp, n, f) {
      const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f);
      PM.fill(0); PM[0] = t / asp; PM[5] = t; PM[10] = (f + n) * nf; PM[11] = -1; PM[14] = 2 * f * n * nf;
      return PM;
    }
    function lookAt(e, c, up) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
      let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      VM.set([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
      return VM;
    }

    // camera shots: [eye, target] as functions of u (0..1)
    const L3 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
    const CSHOTS = [
      (u) => [L3([0, 0, 3.4], [0.1, -0.05, 1.05], E.outCubic(u)), [0, 0, 0]],                         // fly in
      (u) => { const a = lerp(-1.0, 1.0, u); return [[Math.sin(a) * 1.9, 0.35, Math.cos(a) * 1.9], [0, 0, 0]]; }, // orbit
      (u) => [[lerp(-1.3, 1.3, u), -0.55, 0.42], [lerp(-0.9, 1.7, u), -0.1, -0.2]],                    // skim the surface
      (u) => [[lerp(0.25, -0.1, u), lerp(0.1, -0.05, u), lerp(1.6, -0.9, u)], [0, 0, -4]],               // dive through
      (u) => [[lerp(-0.4, 0.4, u), 1.7, 0.9], [0, 0, 0]],                                              // top-down drift
      (u) => [L3([1.6, -0.4, 0.7], [0.6, 0.2, 0.55], u), L3([-0.2, 0.1, 0], [0.2, -0.1, 0], u)],        // low corner reveal
    ];
    const CSHOT = 8, CBLEND = 1.8;
    function camAt(time, seed) {
      const n = CSHOTS.length, k = Math.floor(time / CSHOT), u = (time % CSHOT) / CSHOT;
      const [e1, t1] = CSHOTS[(k + seed) % n](u);
      const bs = 1 - CBLEND / CSHOT;
      if (u < bs) return [e1, t1];
      const [e2, t2] = CSHOTS[(k + 1 + seed) % n](0);
      const w = (u - bs) / (1 - bs), s = w * w * (3 - 2 * w);
      return [L3(e1, e2, s), L3(t1, t2, s)];
    }

    // Adaptive quality: if frames get slow, drop resolution / point count;
    // if there's headroom for a while, step back up. Keeps it smooth on any Mac.
    const QUALITY = [
      { dpr: 1.5, frac: 1 }, { dpr: 1, frac: 1 }, { dpr: 1, frac: 0.65 }, { dpr: 0.75, frac: 0.45 },
    ];
    let q = 0, slowEma = 1 / 60, calmFor = 0, settle = 0;
    function adapt(dt) {
      slowEma += (dt - slowEma) * 0.08;
      settle = Math.max(0, settle - dt);
      if (settle > 0) return;
      if (slowEma > 1 / 48 && q < QUALITY.length - 1) { q++; settle = 1.5; calmFor = 0; }
      else if (slowEma < 1 / 58) { calmFor += dt; if (calmFor > 6 && q > 0) { q--; settle = 1.5; calmFor = 0; } }
      else calmFor = 0;
    }

    let punch = 0;
    function render(time, dt) {
      if (!count) return;
      adapt(dt);
      const Q = QUALITY[q];
      const dpr = Math.min(Q.dpr, devicePixelRatio || 1);
      const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // bass punch: camera jumps toward the target on kicks, then eases back
      punch += (A.kick - punch) * Math.min(1, dt * 18);
      let [eye, tgt] = camAt(time, ART.seed);
      const dir = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]];
      const dl = Math.hypot(...dir) || 1;
      const push = 0.16 * punch;
      eye = [eye[0] + dir[0] / dl * push, eye[1] + dir[1] / dl * push, eye[2] + dir[2] / dl * push];
      const sh = 0.012 * A.shake;
      eye[0] += Math.sin(time * 37) * sh; eye[1] += Math.cos(time * 41) * sh;

      const fov = 55 * Math.PI / 180;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.uProj, false, persp(fov, w / h, 0.02, 30));
      gl.uniformMatrix4fv(loc.uView, false, lookAt(eye, tgt, [0, 1, 0]));
      gl.uniform1f(loc.uTime, time);
      gl.uniform1f(loc.uKick, A.kick);
      gl.uniform1f(loc.uGlow, A.kick);
      gl.uniform1f(loc.uBass, A.has ? A.bassN : 0);
      // bigger points when fewer are drawn, so the image stays filled in
      gl.uniform1f(loc.uPx, (h / (2 * Math.tan(fov / 2))) * 0.0135 / Math.sqrt(Q.frac));

      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const st = 7 * 4;
      gl.enableVertexAttribArray(loc.aPos); gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, st, 0);
      gl.enableVertexAttribArray(loc.aCol); gl.vertexAttribPointer(loc.aCol, 3, gl.FLOAT, false, st, 12);
      gl.enableVertexAttribArray(loc.aSeed); gl.vertexAttribPointer(loc.aSeed, 1, gl.FLOAT, false, st, 24);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, Math.floor(count * Q.frac));
    }
    return { build, render };
  })();

  // ------------------------------------------------------------------ demo
  const DEMO_LRC = `
[00:03.00]Streetlights hum a quiet tune
[00:07.20]I'm counting cars beneath the moon
[00:11.40]Every window holds a little fire
[00:15.80]And I keep walking, walking higher
[00:20.00]Turn it up, the city's waking now
[00:22.60]Feel the floor begin to shake somehow
[00:25.20]Hearts in sync and every light is on
[00:27.80]We don't stop
[00:29.00]Run it back, run it loud tonight
[00:31.20]Neon bleeding into blinding white
[00:33.40]We don't stop until the morning comes
[00:35.80]Louder, louder, beat it like a drum
[00:38.20](yeah, yeah)
[00:39.60]`;
  const DEMO_LEN = 44;
  let demoStart = 0, demoNextBeat = 0, demoLastAudio = 0;
  function demoTick(now) {
    if (FREEZE == null) {
      const t = ((now - demoStart) / 1000) % DEMO_LEN;
      S.anchorPos = t; S.anchorAt = now; S.playing = true;
    }
    if (now - demoLastAudio < 16) return;
    demoLastAudio = now;
    const t = songTime(now);
    const sec = t < 19.6 ? 0 : t < 27.6 ? 1 : t < 39.5 ? 2 : 0;
    const rms = [0.12, 0.32, 0.8][sec] * (0.9 + 0.1 * Math.random());
    const period = [Infinity, 0.94, 0.47][sec];
    let onset = 0;
    if (t >= demoNextBeat || demoNextBeat - t > 2) {
      demoNextBeat = isFinite(period) ? Math.ceil(t / period + 0.001) * period : t + 0.5;
      if (isFinite(period)) onset = 1;
    }
    verse.audio(rms, rms * 0.6, onset);
  }
  if (DEMO) {
    demoStart = performance.now();
    applyPalette([255, 72, 120], [92, 36, 150], [16, 70, 130]);
    verse.track({ id: 'demo', name: 'Neon Hours', artist: 'Verse Demo', album: '', duration: DEMO_LEN, artwork: '' });
    applyPalette([255, 72, 120], [92, 36, 150], [16, 70, 130]);
    S.lyricsState = 'ok';
    setLines(buildLines(parseLRC(DEMO_LRC), DEMO_LEN));
    A.peak = 0.8;
    if (FREEZE != null) {
      // warm the audio model so the frozen frame picks the right mode
      for (let i = 0; i < 400; i++) {
        const sec = FREEZE < 19.6 ? 0 : FREEZE < 27.6 ? 1 : 2;
        verse.audio([0.12, 0.32, 0.8][sec], 0.3, sec && i % [0, 56, 28][sec] === 0 ? 1 : 0);
      }
      A.onsets = A.onsets.map((x, i, arr) => performance.now() - (arr.length - i) * (FREEZE < 27.6 ? 940 : 470));
    }
  } else {
    showMessage('not-running');
  }
  requestAnimationFrame(frame);
})();
