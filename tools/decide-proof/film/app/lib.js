'use strict';
/* Kit of the decide-proof film page. The page is a pure function of the virtual clock: window.setTime(t) draws second t.
   No CSS transitions or animations, no timers, no Date, no Math.random. Elements are built once; per frame only display, opacity,
   transform and text change. Every digit on screen belongs to one of: a figure [data-fig] (text from facts.json), a derived value [data-dv]
   (computed by the scene builder from a named recorded line), a recorded line [data-rec], a live series value [data-series], or an exempt
   name/timecode (.ex-id .ex-tc .ex-tally .ex-nm). Words the checker reads back by OCR are phrases [data-ph]: their text comes from scene.phrases
   and their digits are still tagged one by one. window.__prov() lists every digit that belongs to none of them. */
const S = window.__SCENE__;
const FPS = S.fps, FIG = S.figures, DV = S.derived, PH = S.phrases;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ramp = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const ease = (x) => x * x * (3 - 2 * x);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const escT = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = (s) => escT(s).replace(/"/g, '&quot;');
const frameOf = (t) => Math.round(t * FPS);
const hms = (s) => { s = Math.floor(s); const p = (n) => String(n).padStart(2, '0'); return Math.floor(s / 3600) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60); };

/* ---------- text that carries a number ---------- */
function figH(id, cls) { const f = FIG[id]; if (!f) throw new Error('missing figure ' + id); return '<span class="fig ' + (cls || '') + '" data-fig="' + id + '">' + escT(f.text) + '</span>'; }
function dvH(id, cls) { const d = DV[id]; if (!d) throw new Error('missing derived value ' + id); return '<span class="dv ' + (cls || '') + '" data-dv="' + id + '">' + escT(d.text) + '</span>'; }
/* a name that may carry digits (benchmark, route, model): exempt like .ex-id but set in the display face */
function nmH(txt) { return '<span class="ex-nm">' + escT(txt) + '</span>'; }
function exH(cls, txt) { return '<span class="' + cls + '">' + escT(txt) + '</span>'; }
/* a phrase: plain text, names, identifiers, derived values and figures, exactly the parts the scene lists (its text is the element's textContent) */
function partH(p) { if (p.s !== undefined) return escT(p.s); if (p.nm !== undefined) return nmH(p.nm); if (p.id !== undefined) return exH('ex-id', p.id); if (p.dv !== undefined) return dvH(p.dv); return figH(p.fig); }
function phH(id, cls) { const p = PH[id]; if (!p) throw new Error('missing phrase ' + id); return '<span class="phr ' + (cls || '') + '" data-ph="' + id + '">' + p.parts.map(partH).join('') + '</span>'; }

/* ---------- registry of timed items ---------- */
const ITEMS = [], POST = [];
function el(tag, cls, css, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
function at(e, x, y, w, h) { e.style.position = 'absolute'; e.style.left = x + 'px'; e.style.top = y + 'px'; if (w != null) e.style.width = w + 'px'; if (h != null) e.style.height = h + 'px'; return e; }
function add(e, t0, t1, upd, parent) { (parent || document.getElementById('scene')).appendChild(e); const it = { e, t0, t1, upd, on: null, disp: e.style.display || '' }; ITEMS.push(it); e.style.display = 'none'; return it; }
function setTime(t) {
  for (const it of ITEMS) { const on = t >= it.t0 && t < it.t1; if (on !== it.on) { it.e.style.display = on ? (it.disp || '') : 'none'; it.on = on; } if (on && it.upd) it.upd(t, it.e); }
  for (const f of POST) f(t);
}

/* ---------- fonts: every face the scene names must be loaded and actually applied ---------- */
async function loadFonts() {
  const faces = [...document.fonts];
  for (const spec of S.fonts) {
    const face = faces.find((f) => f.family.replace(/["']/g, '') === spec.family && String(f.weight) === String(spec.weight));
    if (!face) throw new Error('font face not declared: ' + spec.family + ' ' + spec.weight);
    await face.load();
    if (face.status !== 'loaded') throw new Error('font face did not load: ' + spec.family + ' ' + spec.weight + ' (' + face.status + ')');
    if (!document.fonts.check(spec.weight + ' 40px "' + spec.family + '"')) throw new Error('document.fonts.check failed: ' + spec.family + ' ' + spec.weight);
  }
  await document.fonts.ready;
  /* applied, not merely loaded: a family that renders with its own metrics gives the same width whatever fallback follows it */
  for (const fam of [...new Set(S.fonts.map((f) => f.family))]) {
    const w = (fallback) => { const s = el('span', '', 'position:absolute;left:-9999px;top:0;font-size:100px;white-space:pre;font-family:"' + fam + '",' + fallback, 'iiiWWW000mm'); document.body.appendChild(s); const x = s.getBoundingClientRect().width; s.remove(); return x; };
    if (Math.abs(w('serif') - w('monospace')) > 0.01) throw new Error('font not applied (fallback shows through): ' + fam);
  }
}

/* ---------- read-back, provenance and layout audit (used by the builder, never by the frames) ---------- */
const shown = (e) => { let o = 1; for (let n = e; n && n.id !== 'stage'; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; o *= parseFloat(cs.opacity); } return o > 0.9; };
const rectOf = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
// a figure counts as shown only when at least 3/4 of its box is inside every ancestor that clips (overflow or clip-path);
// a line box may run a few pixels past its container while the glyphs stay inside, a row pushed out of a panel may not
const unclipped = (e) => { const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const [L, T, R, B] = clipOf(e); const w = Math.max(0, Math.min(r.right, R) - Math.max(r.left, L)), h = Math.max(0, Math.min(r.bottom, B) - Math.max(r.top, T)); return (w * h) / (r.width * r.height) >= 0.75; };
window.__readFig = (attr, id) => { const els = [...document.querySelectorAll('[' + attr + '="' + id + '"]')]; const vis = els.filter((e) => shown(e) && unclipped(e)); const e = vis[0] || els[0]; return { n: els.length, visible: vis.length > 0, text: e ? e.textContent : null, rect: vis[0] ? rectOf(vis[0]) : null }; };
/* live series values (running tallies, rows so far): text and rectangle of every one that is shown, with the lane and bench it belongs to */
window.__readSeries = () => [...document.querySelectorAll('[data-series]')].filter((e) => shown(e) && unclipped(e)).map((e) => ({ series: e.dataset.series, lane: e.dataset.lane === undefined ? null : Number(e.dataset.lane), bench: e.dataset.bench === undefined ? null : Number(e.dataset.bench), text: e.textContent, rect: rectOf(e) }));
window.__readRec = () => [...document.querySelectorAll('[data-rec]')].filter(shown).map((e) => ({ rec: e.dataset.rec, file: e.dataset.file, line: Number(e.dataset.line), sha256: e.dataset.sha, decide: e.dataset.decide || null, text: e.textContent, rect: rectOf(e) }));
window.__prov = () => {
  const bad = []; const tw = document.createTreeWalker(document.getElementById('stage'), NodeFilter.SHOW_TEXT); let nd;
  while ((nd = tw.nextNode())) { const txt = nd.nodeValue.trim(); if (!txt || !/\d/.test(txt)) continue; const p = nd.parentElement; if (p.closest('script,style') || !shown(p)) continue; if (!p.closest('[data-fig],[data-dv],[data-rec],[data-series],.ex-id,.ex-nm,.ex-tc,.ex-tally')) bad.push(txt.slice(0, 50)); }
  return bad;
};
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const rgba = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
const cratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const clipOf = (e) => { let L = 0, T = 0, R = 1920, B = 1080; for (let n = e; n && n.id !== 'stage'; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.overflow !== 'visible' || cs.clipPath !== 'none') { const r = n.getBoundingClientRect(); L = Math.max(L, r.left); T = Math.max(T, r.top); R = Math.min(R, r.right); B = Math.min(B, r.bottom); } } return [L, T, R, B]; };
const opac = (e) => { let o = 1; for (let n = e; n && n.id !== 'stage'; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
/* one frame: smallest text, safe area (x 95..1825, y 53..1027), text overlap, contrast of every visible text against the opaque colour behind it */
window.__audit = () => {
  const out = { n: 0, min_font: 999, outside_safe: [], overlaps: [], low_contrast: [], min_contrast: 99 }, boxes = [];
  const tw = document.createTreeWalker(document.getElementById('stage'), NodeFilter.SHOW_TEXT); let nd;
  while ((nd = tw.nextNode())) {
    const txt = nd.nodeValue.trim(); if (!txt) continue; const p = nd.parentElement; if (!shown(p)) continue;
    const cs = getComputedStyle(p), col = rgba(cs.color); if (col[3] < 0.5) continue;
    const rg = document.createRange(); rg.selectNodeContents(nd); const clip = clipOf(p), fs = parseFloat(cs.fontSize);
    const rs = [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map((r) => { const cy = r.top + r.height / 2, hh = fs * 0.36; return { L: Math.max(r.left, clip[0]), R: Math.min(r.right, clip[2]), T: Math.max(cy - hh, clip[1]), B: Math.min(cy + hh, clip[3]), full: r }; }).filter((r) => r.R - r.L > 2 && r.B - r.T > 2);
    if (!rs.length) continue;
    out.n++; out.min_font = Math.min(out.min_font, fs);
    const L = Math.min(...rs.map((r) => r.L)), T = Math.min(...rs.map((r) => r.full.top)), Rr = Math.max(...rs.map((r) => r.R)), B = Math.max(...rs.map((r) => r.full.bottom));
    if (L < 95 || Rr > 1825 || Math.max(T, clip[1]) < 53 || Math.min(B, clip[3]) > 1027) out.outside_safe.push(txt.slice(0, 40) + ' @' + [L, T, Rr, B].map(Math.round));
    const cx = (L + Rr) / 2, cy = (rs[0].T + rs[0].B) / 2; let bg = [227, 234, 230, 1];
    for (const e of document.elementsFromPoint(Math.min(1919, Math.max(0, cx)), Math.min(1079, Math.max(0, cy)))) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] >= 0.9 && e.id !== 'stage' && e.id !== 'scene' && e.id !== 'chrome' && !e.classList.contains('chap')) { bg = c; break; } }
    const c = cratio(col, bg); out.min_contrast = Math.min(out.min_contrast, c); if (c < 4.5) out.low_contrast.push(txt.slice(0, 30) + ' ' + c.toFixed(2));
    if (opac(p) > 0.9) boxes.push({ t: txt.slice(0, 24), p, rs });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; if (a.p === b.p || a.p.contains(b.p) || b.p.contains(a.p)) continue;
    const hit = a.rs.some((r1) => b.rs.some((r2) => Math.min(r1.R, r2.R) - Math.max(r1.L, r2.L) > 3 && Math.min(r1.B, r2.B) - Math.max(r1.T, r2.T) > 3)); if (hit) out.overlaps.push(a.t + ' / ' + b.t);
  }
  return out;
};
