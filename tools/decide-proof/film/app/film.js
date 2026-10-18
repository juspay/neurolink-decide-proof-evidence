'use strict';
/* The five chapters of the film, drawn from window.__SCENE__ only. Timing lives in the scene (the builder owns it); this file owns the layout.
   Layout region of a chapter: x 96..1824, y 124..940. The chrome (top bar, rail, caption) is drawn from y 56..104 and y 968..1024. */
const CH = Object.fromEntries(S.chapters.map((c) => [c.key, c]));
const TOTAL = S.total_seconds;
const fadeIn = (t0, d) => (t, e) => { e.style.opacity = String(ease(ramp(t, t0, t0 + (d || 0.3)))); };
function chapter(key) { const c = CH[key]; const root = el('div', 'chap'); add(root, c.t0, c.t1, null); return { root, t0: c.t0, t1: c.t1 }; }
const addIn = (c, e, t0, t1, upd) => add(e, t0, t1, upd, c.root);

/* ---------- typed rows: every character is a span, shown in order as a function of t ---------- */
function typedRows(rows, host) {
  const els = [], hot = [];
  for (const r of rows) {
    const d = el('div', 'row ' + r.k); if (r.k === 'hot') hot.push({ d, first: els.length });
    for (const sg of r.segs) {
      if (sg.s !== undefined) for (const ch of sg.s) { const s = el('span', '', 'visibility:hidden'); s.textContent = ch; d.appendChild(s); els.push({ e: s, w: 1 }); }
      else { const c = el('span', 'chip', 'visibility:hidden'); c.textContent = sg.chip; d.appendChild(c); els.push({ e: c, w: 10, chip: sg.name }); }
    }
    if (!r.segs.length) d.innerHTML = '&nbsp;';
    host.appendChild(d);
  }
  let acc = 0; for (const x of els) { x.to = acc + x.w; acc = x.to; }
  return { els, total: acc, k: 0, hot };
}
function setTyped(T, n) {
  let k = 0; { let lo = 0, hi = T.els.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T.els[m].to <= n) lo = m + 1; else hi = m; } k = lo; }
  if (k > T.k) for (let i = T.k; i < k; i++) T.els[i].e.style.visibility = 'visible'; else for (let i = k; i < T.k; i++) T.els[i].e.style.visibility = 'hidden';
  T.k = k; for (const h of T.hot) h.d.classList.toggle('hot-on', k > h.first);
}
const setRec = (e, rec, tag) => { e.dataset.rec = tag; e.dataset.file = rec.file; e.dataset.line = String(rec.line); e.dataset.sha = rec.sha256; };

/* ---------- chrome ---------- */
function buildChrome() {
  const chrome = document.getElementById('chrome');
  const left = at(el('div', '', 'white-space:nowrap;height:48px;line-height:48px'), 96, 56, 460, 48);
  left.innerHTML = '<i class="recdot"></i><span class="lab">REC</span> <span class="ex-id" style="font-size:24px;margin-left:12px">' + escT(S.audit_id) + '</span>';
  add(left, 0, TOTAL, null, chrome);
  const rail = at(el('div', 'rail'), 570, 56, 900, 48);
  const names = ['Request', 'Playback', 'Results', 'Proof', 'Method']; const spans = names.map((n) => { const s = el('span', '', '', n); rail.appendChild(s); return s; });
  add(rail, 0, TOTAL, (t) => { S.chapters.forEach((c, i) => { spans[i].className = t >= c.t0 && t < c.t1 ? 'on' : ''; }); }, chrome);
  const tc = at(el('div', 'ex-tc', 'font-weight:600;font-size:30px;text-align:right;height:48px;line-height:48px;letter-spacing:.06em'), 1500, 56, 325, 48);
  add(tc, 0, TOTAL, (t) => { tc.textContent = 'T+' + hms(t); }, chrome);
  add(at(el('div', '', 'background:var(--ink);height:3px'), 96, 112, 1728, 3), 0, TOTAL, null, chrome);
  add(at(el('div', '', 'background:var(--ink);height:3px'), 96, 958, 1728, 3), 0, TOTAL, null, chrome);
  // a caption is one line of capitals (y 966); with a second line the first moves up and the second sits below it in small type (y 998..1026)
  const cap = (key, html, t0, html2) => {
    const c = CH[key], a = t0 ?? c.t0 + 0.5;
    add(at(el('div', 'cap' + (html2 ? ' two' : ''), '', html), 96, html2 ? 962 : 966, 1728, html2 ? 36 : 56), a, c.t1, fadeIn(a), chrome);
    if (html2) add(at(el('div', 'cap2', '', html2), 96, 998, 1728, 28), a, c.t1, fadeIn(a), chrome);
  };
  cap('open', phH('open.product'), 1.2, phH('open.caption'));
  cap('replay', phH('replay.caption'), undefined, phH('replay.legend'));
  cap('results', 'Every number is counted from the recorded files');
  cap('proof', phH(S.proof.caption_ph), undefined, S.proof.remask_ph ? phH(S.proof.remask_ph) : undefined);
  cap('end', 'Built by script from the recordings');
  /* paper that moves like a chart recorder, one pixel step per frame at most */
  const paper = document.getElementById('paper'); let lastX = null;
  POST.push((t) => { const x = Math.round(t * 30); if (x !== lastX) { lastX = x; paper.style.backgroundPosition = [-x, 0, -x, 0, -x, 0, -x, 0].map((v) => v + 'px 0').join(','); } });
  /* tape wipes at the chapter boundaries: the bar crosses the frame in 0.7 s, the chapters swap behind it */
  const wipe = document.getElementById('wipe');
  POST.push((t) => { let x = null; for (const c of S.chapters.slice(1)) { const d = t - c.t0; if (d > -0.35 && d < 0.35) x = -1920 + (d + 0.35) / 0.7 * 3840; } if (x === null) wipe.style.display = 'none'; else { wipe.style.display = 'block'; wipe.style.transform = 'translateX(' + Math.round(x) + 'px)'; } });
}

/* ---------- chapter 1: one recorded exchange ---------- */
/* width of a text as the page sets it (a hidden span in the stage, so tabular numerals count); font is 'weight sizepx "Family"' */
const textW = (txt, font) => { const m = /^(\d+) ([\d.]+)px "(.+)"$/.exec(font); const s = el('span', '', 'position:absolute;left:-9999px;top:0;white-space:pre;font-weight:' + m[1] + ';font-size:' + m[2] + 'px;font-family:"' + m[3] + '"', txt); document.getElementById('stage').appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
function buildOpen() {
  const c = chapter('open'), X = S.exchange, T = X.t, rec = X.record;
  const reqP = at(el('div', 'panel'), 96, 124, 1030, 712), resP = at(el('div', 'panel'), 1150, 124, 674, 712);
  reqP.innerHTML = '<div class="ph"><span class="lab">Request</span><span class="r">' + exH('ex-id', X.route_label) + '</span></div>';
  resP.innerHTML = '<div class="ph"><span class="lab">Response</span><span class="r" data-slot="status"></span></div>';
  const reqRows = el('div', 'rows tight'), resRows = el('div', 'rows tight'); reqP.appendChild(reqRows); resP.appendChild(resRows);
  const reqT = typedRows(X.request.rows, reqRows), resT = typedRows(X.response.rows, resRows);
  setRec(reqRows, rec, 'exchange:request'); setRec(resRows, rec, 'exchange:response');
  addIn(c, reqP, 0.2, T.end, (t, e) => { e.style.opacity = String(ease(ramp(t, 0.2, 0.6))); setTyped(reqT, Math.floor(reqT.total * ramp(t, T.type0, T.type1))); });
  addIn(c, resP, 0.2, T.end, (t, e) => { e.style.opacity = String(ease(ramp(t, 0.3, 0.7))); setTyped(resT, Math.floor(resT.total * ramp(t, T.resp0 + 0.15, T.resp1))); });
  /* which variable the masked chip is, in the free space under the request */
  if (PH['open.mask']) { const m = el('div', 'masknote', '', phH('open.mask')); at(m, 22, 0, 986); m.style.top = 'auto'; m.style.bottom = '16px'; add(m, PH['open.mask'].t0 - 0.4, T.end, fadeIn(PH['open.mask'].t0 - 0.4), reqP); }
  /* the wire: the recorded wait counts up while the request is in flight and stands on its recorded value until the response has finished typing; only then does the status land */
  const wcss = 'font-weight:600;font-size:28px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim-panel);text-align:right;line-height:34px';
  const wslot = resP.querySelector('[data-slot=status]');
  const fmtT = (n) => Math.floor(n / 10) + '.' + (n % 10) + ' ms';
  const wait = el('div', '', wcss, 'Waiting <span data-series="wait"></span>'); const wv = wait.querySelector('span');
  add(wait, T.wire0, T.resp0, (t) => { wv.textContent = fmtT(Math.floor(X.wait_tenths * ease(ramp(t, T.wire0, T.resp0)))); }, wslot);
  add(el('div', '', wcss, 'Waited ' + dvH('open.latency')), T.resp0, T.status, null, wslot);
  add(el('div', 'ok', 'font-weight:700;font-size:44px;letter-spacing:.04em;line-height:34px;height:34px', 'HTTP ' + dvH('open.status')), T.status, T.end, (t, e) => fadeIn(T.status, 0.25)(t, e), wslot);
  /* readouts: the chosen option, the expected one with the verdict, tokens, latency. Widths are measured (fonts are loaded) so a long label never runs into the next cell. */
  const D = (id) => DV[id].text, hit = D('open.verdict') === 'HIT';
  const defs = [
    { k: 'Chosen option', vs: [[D('open.choice'), 'v', 'acc'], [' ' + D('open.label') + ' · p ' + D('open.p'), 's']], html: '<span class="v acc">' + dvH('open.choice') + '</span><span class="s"> ' + dvH('open.label') + ' · p ' + dvH('open.p') + '</span>' },
    { k: 'Expected option', vs: [[D('open.gold'), 'v'], [' ' + D('open.gold_label'), 's']], html: '<span class="v">' + dvH('open.gold') + '</span><span class="s"> ' + dvH('open.gold_label') + '</span>' },
    { k: 'Verdict', vs: [[D('open.verdict'), 'tag']], html: '<span class="verdict ' + (hit ? 'hit' : 'miss') + '">' + dvH('open.verdict') + '</span>' },
    { k: 'Tokens', vs: [[D('open.in'), 'v'], [' in ', 's'], [D('open.out'), 'v'], [' out', 's']], html: '<span class="v">' + dvH('open.in') + '</span><span class="s"> in </span><span class="v">' + dvH('open.out') + '</span><span class="s"> out</span>' },
    { k: 'Latency', vs: [[D('open.latency'), 'v']], html: '<span class="v">' + dvH('open.latency') + '</span>' },
  ];
  const widthsAt = (f) => defs.map((d) => Math.ceil(d.vs.reduce((a, [txt, kind]) => a + textW(txt, kind === 's' ? `500 ${30 * f}px "Barlow Condensed"` : `700 ${56 * f}px "Barlow Condensed"`), 0)) + (d.vs.some((q) => q[1] === 'tag') ? 36 : 0) + 10);
  let f = 1, ws = widthsAt(f); const GAP = 22;
  if (ws.reduce((a, b) => a + b, 0) + GAP * (defs.length - 1) > 1728) { f = 0.82; ws = widthsAt(f); }
  const spare = 1728 - ws.reduce((a, b) => a + b, 0); if (spare < GAP * (defs.length - 1)) throw new Error('the opening readouts do not fit in one row (' + spare + ' px spare)');
  const gap = Math.min(70, Math.floor(spare / (defs.length - 1))); let x = 96;
  defs.forEach((d, i) => {
    const e = at(el('div', 'cell'), x, 848, ws[i], 106); x += ws[i] + gap;
    e.innerHTML = '<div style="height:6px;background:var(--accent);margin-bottom:6px"></div><div class="k">' + d.k + '</div><div style="white-space:nowrap;line-height:64px;height:64px">' + d.html + '</div>';
    e.querySelectorAll('.v').forEach((q) => { q.style.fontSize = (56 * f) + 'px'; q.style.fontWeight = '700'; q.style.color = q.classList.contains('acc') ? 'var(--accent)' : 'var(--ink)'; });
    e.querySelectorAll('.s').forEach((q) => { q.style.fontSize = (30 * f) + 'px'; });
    e.querySelectorAll('.verdict').forEach((q) => { q.style.fontSize = (56 * f) + 'px'; });
    addIn(c, e, T.call + i * 0.15, T.end, fadeIn(T.call + i * 0.15, 0.3));
  });
}

/* ---------- chapter 2: the recording played back at speed ---------- */
const ACOL = { grid: '#2A4655', line: '#8FB0FF', head: '#FFFFFF', bg: '#0C1A23', div: '#62E3A4' };
const MONO_W = 14.4;   // advance of IBM Plex Mono at 24 px: the replay lines are set in character cells, the column heads sit on those cells
function buildReplay() {
  const c = chapter('replay'), ff = S.ff, K = ff.frames, nL = ff.lanes.length, tLand = ff.t0 + ff.land_frame / FPS;
  if (nL > 5) throw new Error('the replay layout holds up to five lanes, this audit has ' + nL);
  /* up to two lanes: side by side; three or four: two rows of two; five: three rows of two, the counters in the sixth place (dense) */
  const dense = nL > 4, compact = nL > 2, R = compact ? ff.window : 8, STREAM_H = R * 34;   // compact: the scene's window is the rows each lane really shows
  const fr = (t) => clamp(frameOf(t - ff.t0), 0, K - 1);
  const y0 = dense ? 124 : compact ? 316 : 374, laneH = dense ? 262 : compact ? 312 : 566, pitch = dense ? 272 : compact ? 322 : 296;
  const GX = 972, GY = y0 + 2 * pitch;   // dense: the sixth place of the grid
  /* counter, call time, shown time, speed, and what they mean */
  const BIGPX = dense ? 110 : compact ? 150 : 200;
  const cnt = at(el('div', 'cell'), dense ? GX : 96, dense ? GY : 124, dense ? 420 : 770, BIGPX + 36); cnt.innerHTML = '<div class="k"' + (dense ? ' style="font-size:24px;line-height:26px"' : '') + '>HTTP calls sent</div>';
  const bigCss = 'font-size:' + BIGPX + 'px;height:' + BIGPX + 'px;line-height:' + BIGPX + 'px;white-space:nowrap';
  const live = el('div', 'big', bigCss); live.dataset.series = 'counter'; cnt.appendChild(live);
  const fin = el('div', 'big', bigCss + ';margin-top:-' + BIGPX + 'px;color:var(--ink)', figH('ff.requests')); cnt.appendChild(fin);
  addIn(c, cnt, ff.t0 + 0.2, ff.t1, (t, e) => { e.style.opacity = String(ease(ramp(t, ff.t0 + 0.2, ff.t0 + 0.7))); live.style.visibility = t < tLand ? 'visible' : 'hidden'; fin.style.visibility = t < tLand ? 'hidden' : 'visible'; live.textContent = ff.counter[fr(t)]; });
  const spd = (x, w, k, key, big, q) => { const e = at(el('div', 'cell'), dense ? GX + 430 : x, dense ? GY + q * 66 : 124, dense ? 422 : w, dense ? 64 : 110); const kk = el('div', 'k', dense ? 'font-size:24px;line-height:26px' : '', k), vv = el('div', 'v', 'font-size:' + (dense ? 40 : big ? 64 : 56) + 'px;padding-top:' + (dense ? 0 : 16) + 'px;white-space:nowrap' + (big ? ';color:var(--accent)' : '')); vv.dataset.series = key; e.append(kk, vv);
    addIn(c, e, ff.t0 + 0.2, ff.t1, (t) => { e.style.opacity = String(ease(ramp(t, ff.t0 + 0.2, ff.t0 + 0.7))); const f = fr(t); vv.textContent = ff[key][f]; if (key === 'ratio') kk.textContent = f >= ff.land_frame ? 'Average speed' : 'Speed now'; }); };
  spd(880, 330, 'Call time, lanes added', 'rec', false, 0); spd(1230, 250, 'Shown time', 'shown', false, 1); spd(1500, 324, 'Speed now', 'ratio', true, 2);
  const note = dense ? at(el('div', 'note', 'font-size:28px;line-height:30px', phH('replay.note')), GX, GY + 200, 852, 62) : at(el('div', 'note', 'font-size:28px;line-height:30px', phH('replay.note')), 880, 250, 944, 64);
  addIn(c, note, ff.t0 + 1.0, ff.t1, fadeIn(ff.t0 + 1.0));
  /* lanes */
  const lanePos = (i) => (nL <= 2 ? { x: 96 + i * 876, y: y0, w: 852, h: laneH } : { x: 96 + (i % 2) * 876, y: y0 + Math.floor(i / 2) * pitch, w: 852, h: laneH });
  /* column heads: right edge of each right-aligned column, in character cells (time 0-11, HTTP 14-16, ms 19-23, tokens in 26-30, tokens out 33-37, answer from 40) */
  const HEADS = [['Time UTC', 0, 'l'], ['HTTP', 17, 'r'], ['ms', 24, 'r'], ['Tokens<br>in', 31, 'r'], ['Tokens<br>out', 38, 'r'], ['Answer', 40, 'l']];
  ff.lanes.forEach((L, li) => {
    const g = lanePos(li); const P = at(el('div', 'panel lane'), g.x, g.y, g.w, g.h);
    const ph = el('div', 'ph', '', '<span class="lab">' + nmH(L.label) + '</span><span class="r"><span data-series="lane-count"></span> HTTP calls</span>'); P.appendChild(ph);
    const cntEl = ph.querySelector('[data-series=lane-count]');
    const chips = el('div', '', 'padding:6px 22px 0;height:46px;white-space:nowrap'); if (!compact) P.appendChild(chips);
    const chipEls = L.benches.map((b) => { const s = el('span', 'benchchip', '', nmH(b.label)); chips.appendChild(s); return s; });
    const colh = el('div', 'colh2'); P.appendChild(colh);
    HEADS.forEach(([txt, col, side]) => { const sp = el('span', '', '', txt); const x = 22 + col * MONO_W; if (side === 'l') sp.style.left = x + 'px'; else { sp.style.width = '120px'; sp.style.left = (x - 120) + 'px'; sp.style.textAlign = 'right'; } colh.appendChild(sp); });
    const stream = el('div', 'stream', 'height:' + STREAM_H + 'px'); const inner = el('div', 'in'); stream.appendChild(inner); P.appendChild(stream);
    const rowsEl = []; for (let r = 0; r <= R; r++) { const d = el('div', 'l'); const a = el('span'), b = el('span'); d.append(a, b); inner.appendChild(d); rowsEl.push({ d, a, b }); }
    /* bottom: one tile per bench (running accuracy with the rows scored so far) and the pen trace */
    const BH = dense ? 88 : compact ? 104 : 132;
    const bottom = el('div', '', 'position:absolute;left:0;right:0;bottom:0;height:' + BH + 'px;border-top:2px solid var(--rule-panel)'); P.appendChild(bottom);
    const CW = 214, CHh = dense ? 70 : compact ? 84 : 108, nb = L.benches.length, tileW = Math.floor((g.w - 22 - CW - 22 - 18) / nb) - 8;
    // the value (at most '100.0%') and, to its right, two small lines (the longest is the biggest row count); the tile must hold both
    const VPX = 54, subX = Math.ceil(textW('100.0%', `700 ${VPX}px "Barlow Condensed"`)) + 14, subW = Math.ceil(Math.max(textW('so far', '500 24px "Barlow Condensed"'), ...L.benches.map((b) => textW(FIG[`ff.rows.${L.route}.${b.bench}`].text + ' rows', '500 24px "Barlow Condensed"')))) + 8;
    if (subX + subW > tileW) throw new Error('a replay tile is ' + tileW + ' px wide but its value and label need ' + (subX + subW));
    const tiles = L.benches.map((b, bi) => {
      const tl = at(el('div', 'tile'), 22 + bi * (tileW + 8), dense ? 4 : compact ? 8 : 14, tileW, 100); tl.innerHTML = '<div class="k">' + nmH(b.label) + '</div>';
      const lv = el('div', 'v', 'font-size:' + VPX + 'px;height:56px;white-space:nowrap;width:fit-content'); lv.dataset.series = 'accuracy'; lv.dataset.lane = String(li); lv.dataset.bench = String(bi);
      const fv = el('div', 'v', 'font-size:' + VPX + 'px;height:56px;white-space:nowrap;width:fit-content;margin-top:-56px;color:var(--on-panel)', figH(`ff.acc.${L.route}.${b.bench}`));
      const sub1 = at(el('div', 'sub'), subX, 30, tileW - subX, 56); sub1.innerHTML = 'so far<br><span data-series="scored" data-lane="' + li + '" data-bench="' + bi + '"></span> rows';
      const sub2 = at(el('div', 'sub'), subX, 30, tileW - subX, 56); sub2.innerHTML = 'final<br>' + figH(`ff.rows.${L.route}.${b.bench}`) + ' rows';
      tl.append(lv, fv, sub1, sub2); bottom.appendChild(tl); return { lv, fv, sub1, sub2, sc: sub1.querySelector('[data-series=scored]') };
    });
    const cv = el('canvas', 'pen'); cv.width = CW; cv.height = CHh; cv.style.cssText = 'position:absolute;right:22px;top:' + (dense ? 6 : compact ? 10 : 12) + 'px;width:' + CW + 'px;height:' + CHh + 'px;border:2px solid var(--rule-panel)'; bottom.appendChild(cv);
    const ctx = cv.getContext('2d'); let lastDraw = -1;
    const draw = (n) => {
      if (n === lastDraw) return; lastDraw = n; ctx.fillStyle = ACOL.bg; ctx.fillRect(0, 0, CW, CHh); ctx.strokeStyle = ACOL.grid; ctx.lineWidth = 1;
      for (let q = 1; q < 4; q++) { const y = Math.round(CHh * q / 4) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke(); }
      ctx.strokeStyle = ACOL.div; ctx.lineWidth = 1; for (const b of L.benches.slice(1)) { const x = Math.round(b.start / L.n_total * CW) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CHh); ctx.stroke(); }
      ctx.strokeStyle = ACOL.line; ctx.lineWidth = 3; ctx.lineJoin = 'round'; let pen = false, hx = 0, hy = 0, lastBench = -1;
      const benchAt = (i) => { for (let q = L.benches.length - 1; q >= 0; q--) if (i > L.benches[q].start) return q; return 0; };
      ctx.beginPath();
      for (let px = 0; px <= CW; px++) {
        const i = Math.min(n, Math.round(px / CW * L.n_total)); const v = L.trace[i]; const bq = benchAt(i);
        if (v < 0) { pen = false; if (i >= n) break; continue; }
        const y = CHh - 3 - (CHh - 6) * v / 1000; if (!pen || bq !== lastBench) ctx.moveTo(px, y); else ctx.lineTo(px, y);
        pen = true; lastBench = bq; hx = px; hy = y; if (i >= n) break;
      }
      ctx.stroke(); if (n > 0) { ctx.fillStyle = ACOL.head; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 6.2832); ctx.fill(); }
    };
    addIn(c, P, ff.t0 + 0.1, ff.t1, (t, e) => {
      e.style.opacity = String(ease(ramp(t, ff.t0 + 0.1, ff.t0 + 0.6))); const f = fr(t), n = ff.n[li][f], age = ff.age[li][f];
      cntEl.textContent = ff.count[li][f];
      chipEls.forEach((s, bi) => { const b = L.benches[bi]; s.className = 'benchchip' + (n >= b.end ? ' done' : (n > b.start ? ' on' : '')); });
      inner.style.top = String(-34 * ease(ramp(age, 0, 4))) + 'px';
      for (let r = 0; r <= R; r++) {
        const j = n - (R + 1) + r, ro = rowsEl[r], u = j >= 0 ? L.units[j] : null;
        if (!u) { ro.a.textContent = ''; ro.b.textContent = ''; ro.d.removeAttribute('data-rec'); continue; }
        const fld = u.f; ro.a.textContent = fld.slice(0, 5).join('  ') + '  '; ro.b.textContent = fld[5];
        ro.d.className = 'l ' + (u.k === 'b' ? 'bad' : u.k === 'r' ? 'warm' : u.k === 'w' ? 'dimp' : ''); ro.b.className = u.k === 'o' ? 'acc' : '';
        let bi = 0; for (let q = L.benches.length - 1; q >= 0; q--) if (j >= L.benches[q].start) { bi = q; break; }
        setRec(ro.d, { file: L.files[bi].wire, line: u.w[0], sha256: u.w[1] }, 'ff:' + li + ':' + j); ro.d.dataset.decide = u.d[0] + ':' + u.d[1];
      }
      tiles.forEach((tl, bi) => { const run = t < tLand; tl.lv.textContent = ff.acc[li][f][bi]; tl.lv.style.visibility = run ? 'visible' : 'hidden'; tl.fv.style.visibility = run ? 'hidden' : 'visible'; tl.sc.textContent = ff.scored[li][f][bi]; tl.sub1.style.visibility = run && ff.scored[li][f][bi] !== '0' ? 'visible' : 'hidden'; tl.sub2.style.visibility = run ? 'hidden' : 'visible'; });
      draw(n);
    });
  });
}

/* ---------- chapter 3: results ---------- */
function bar(c, x, y, w, h, bp, tIn, tEnd, cls) {
  const tr = at(el('div', 'bar-track ' + (cls || '')), x, y, w, h), fl = el('div', 'bar-fill'); tr.appendChild(fl);
  addIn(c, tr, tIn, tEnd, (t, e) => { e.style.opacity = String(ease(ramp(t, tIn, tIn + 0.25))); fl.style.width = Math.round((w - 4) * bp / 10000 * easeOut(ramp(t, tIn + 0.1, tIn + 1.3))) + 'px'; });
}
function textAt(c, cls, x, y, html, tIn, tEnd, css, w, upd) { const e = at(el('div', cls, css || ''), x, y, w); e.innerHTML = html; addIn(c, e, tIn, tEnd, upd ? (t, q) => { fadeIn(tIn, 0.3)(t, q); upd(t, q); } : fadeIn(tIn, 0.3)); return e; }
function buildResults() {
  const c = chapter('results'), R = S.results, T = R.t, benches = [...new Set(R.acc.map((r) => r.bench))], EA = T.endA, EB = T.end + 0.5, R0 = CH.results.t0;
  /* screen A: accuracy and out of scope. A number appears when its bar has landed, so a paused frame never shows a figure the bar has not reached. */
  textAt(c, 'h1', 96, 124, 'Accuracy', R0 + 0.2, EA, 'color:var(--ink)');
  textAt(c, 'note', 96, 192, 'correct ÷ rows · a failed kit request counts as wrong', R0 + 0.35, EA, '', 834);
  /* more rows than the list holds (a bar and a detail line take 84 px, so six rows in two groups at most): a grid, one line pair per route, one column per benchmark */
  const grid = Math.floor((610 - benches.length * 46) / R.acc.length) < 84;
  if (grid) {
    const routes = [...new Set(R.acc.map((r) => r.route))], COLW_A = 300, COLX_A = 380;
    if (benches.length > 2) throw new Error('the accuracy grid holds two benchmarks, this audit has ' + benches.length);
    const pitchA = clamp(Math.floor(562 / routes.length), 70, 112);
    benches.forEach((b, bi) => textAt(c, 'h2', COLX_A + bi * COLW_A, 244, nmH(R.acc.find((r) => r.bench === b).bench_label), R.acc.find((r) => r.bench === b).t_in - 0.3, EA));
    routes.forEach((rt, ri) => {
      const yy = 294 + ri * pitchA, first = R.acc.find((r) => r.route === rt);
      textAt(c, 'rlab', 96, yy, nmH(first.route_label), first.t_in, EA, 'font-size:26px;line-height:28px;white-space:normal;width:270px');
      benches.forEach((b, bi) => {
        const r = R.acc.find((q) => q.route === rt && q.bench === b), x = COLX_A + bi * COLW_A, land = r.t_in + T.accLand;
        textAt(c, 'rnum', x, yy, figH(r.acc), land, EA, 'font-size:44px');
        bar(c, x + 130, yy + 10, 150, 26, r.bp, r.t_in + 0.1, EA);
        textAt(c, 'rdet', x, yy + 46, figH(r.correct) + ' of ' + figH(r.rows) + ' · ' + figH(r.failed) + ' failed', land + 0.1, EA, 'font-size:28px');
      });
    });
  }
  const step = clamp(Math.floor((610 - benches.length * 46) / R.acc.length), 84, 128);
  let y = 244;
  (grid ? [] : benches).forEach((b) => {
    const rows = R.acc.filter((r) => r.bench === b);
    textAt(c, 'h2', 96, y, nmH(rows[0].bench_label), rows[0].t_in - 0.3, EA); y += 46;
    rows.forEach((r) => {
      const det = figH(r.correct) + ' of ' + figH(r.rows) + ' · ' + figH(r.failed) + ' failed', land = r.t_in + T.accLand;
      if (step >= 112) {
        const big = step >= 104;
        textAt(c, 'rlab', 96, y, nmH(r.route_label), r.t_in, EA);
        bar(c, 96, y + 38, 520, 34, r.bp, r.t_in + 0.1, EA);
        textAt(c, 'rnum', 640, y + 6, figH(r.acc), land, EA, 'font-size:' + (big ? 76 : 60) + 'px');
        textAt(c, 'rdet', 96, y + 78, det, land + 0.1, EA);
      } else {
        // compact (many rows): the detail rides on the label line (it fades in when the bar lands), the bar and the percentage share the line below
        textAt(c, 'rlab', 96, y, nmH(r.route_label) + '<span class="rdet-in"> · ' + det + '</span>', r.t_in, EA, '', undefined, (t, q) => { q.querySelector('.rdet-in').style.opacity = String(ease(ramp(t, land, land + 0.3))); });
        bar(c, 96, y + 40, 700, 30, r.bp, r.t_in + 0.1, EA);
        textAt(c, 'rnum', 820, y + 34, figH(r.acc), land, EA, 'font-size:44px');   // right of where the label lines end, so its crop holds only the number
      }
      y += step;
    });
  });
  if (R.oos.length) {
    const X0 = 990; textAt(c, 'h1', X0, 124, 'Out of scope', T.oosIn - 0.3, EA, 'color:var(--ink)');
    textAt(c, 'note', X0, 192, 'recall = caught ÷ out-of-scope rows · precision = caught ÷ said out-of-scope', T.oosIn - 0.1, EA, 'font-size:26px;line-height:30px', 834);
    // a block is the route name, two bars and the false-alarm line: 180 px, so three blocks of 200 leave a gap between them and end above the rule at 866
    const dense = Math.floor(600 / R.oos.length) < 150;   // five or more blocks: the route name on the left, recall and precision side by side
    const bh = dense ? Math.floor(600 / R.oos.length) : clamp(Math.floor(600 / R.oos.length), 150, 232), rowStep = bh >= 220 ? 70 : 58; let by = 262;
    R.oos.forEach((o) => {
      const land = o.t_in + T.oosLand;
      if (dense) {
        textAt(c, 'rlab', X0, by, nmH(o.route_label), o.t_in, EA, 'font-size:26px;line-height:28px;white-space:normal;width:190px');
        [['Recall', o.recall_bp, o.recall, o.caught_a, o.oos_rows, '', 200], ['Precision', o.precision_bp, o.precision, o.caught_b, o.said_oos, 'alt', 520]].forEach(([lab, bp, fp, f1, f2, alt, dx]) => {
          textAt(c, 'rlab', X0 + dx, by, lab + ' <span class="rdet-in" style="text-transform:none;letter-spacing:0">' + figH(f1) + ' of ' + figH(f2) + '</span>', o.t_in + 0.1, EA, 'font-size:24px;line-height:26px;letter-spacing:.08em;text-transform:uppercase');
          textAt(c, 'rnum', X0 + dx, by + 28, figH(fp), land, EA, 'font-size:44px');
          bar(c, X0 + dx + 130, by + 38, 160, 24, bp, o.t_in + 0.2, EA, alt);
        });
        textAt(c, 'rdet', X0 + 200, by + 76, 'False alarms: ' + figH(o.false_alarms) + ' · in-scope rows answered “out of scope”', land + 0.2, EA, 'font-size:24px');
        by += bh;
        return;
      }
      textAt(c, 'rlab', X0, by, nmH(o.route_label), o.t_in, EA);
      const line = (yy, lab, bp, fp, f1, f2, alt) => {
        textAt(c, 'rlab', X0, yy + 14, lab, o.t_in + 0.1, EA, 'font-size:26px;letter-spacing:.08em;text-transform:uppercase');
        bar(c, X0 + 150, yy + 12, 260, 32, bp, o.t_in + 0.2, EA, alt);
        textAt(c, 'rnum', X0 + 432, yy, figH(fp), land, EA, 'font-size:60px');
        textAt(c, 'rdet', X0 + 616, yy + 14, figH(f1) + ' of ' + figH(f2), land + 0.1, EA, 'font-size:28px');
      };
      line(by + 34, 'Recall', o.recall_bp, o.recall, o.caught_a, o.oos_rows, '');
      line(by + 34 + rowStep, 'Precision', o.precision_bp, o.precision, o.caught_b, o.said_oos, 'alt');
      textAt(c, 'rdet', X0, by + 34 + 2 * rowStep + 2, 'False alarms: ' + figH(o.false_alarms) + ' · in-scope rows answered “out of scope”', land + 0.2, EA, 'font-size:28px');
      by += bh;
    });
  }
  const tot = R.totals;
  add(at(el('div', '', 'background:var(--ink);height:3px'), 96, 866, 1728, 3), tot.t_in, EA, null, c.root);
  textAt(c, 'h2', 96, 884, figH(tot.attempts) + ' HTTP calls · ' + figH(tot.tokens) + ' input tokens · ' + figH(tot.cost) + ' at the listed prices', tot.t_in, EA, 'color:var(--ink);font-size:38px', 1728);
  /* screen B: cost and speed, one row per route and benchmark */
  textAt(c, 'h1', 96, 124, 'Cost and speed', T.bIn, EB, 'color:var(--ink)');
  textAt(c, 'note', 96, 192, phH('results.cost_note'), T.bIn + 0.2, EB, '', 1728);
  const COLX = [520, 690, 820, 940, 1160, 1370, 1580], COLW = [150, 110, 100, 200, 190, 190, 200];
  // a head must fit its column on one line (26 px capitals, 2 px letter-spacing), or the build stops
  R.cost_heads.forEach((h, i) => { if (textW(h.toUpperCase(), '600 26px "Barlow Condensed"') + 2 * h.length > COLW[i]) throw new Error('cost table head "' + h + '" does not fit its column'); textAt(c, 'rlab', COLX[i], 240, /\d/.test(h) ? nmH(h) : escT(h), T.bIn + 0.5, EB, 'font-size:26px;line-height:28px;letter-spacing:.08em;text-transform:uppercase;text-align:right;width:' + COLW[i] + 'px'); });
  add(at(el('div', '', 'background:var(--ink);height:3px'), 96, 276, 1728, 3), T.bIn + 0.5, EB, null, c.root);
  const rh = clamp(Math.floor(528 / R.cost.length), 56, 112), lf = rh >= 100 ? 28 : 26, RY0 = 298;
  R.cost.forEach((r, i) => {
    const yy = RY0 + i * rh;
    // a short row puts the route and the benchmark on one line when they fit the label column, else the benchmark goes under the route (two lines of 26 px)
    const two = rh >= 80 || textW(r.route_label + ' · ' + r.bench_label, '600 24px "Barlow Condensed"') > 390, tight = rh < 80 && two;
    textAt(c, 'rlab', 96, yy + (rh >= 80 ? 2 : 0), nmH(r.route_label) + (two ? '<br><span style="font-size:' + (tight ? 24 : lf) + 'px;color:var(--accent)">' + nmH(r.bench_label) + '</span>' : ' · ' + nmH(r.bench_label)), r.t_in, EB, 'font-size:' + (rh >= 80 ? lf : 24) + 'px;line-height:' + (rh >= 80 ? lf + 2 : tight ? 26 : 28) + 'px;white-space:normal;width:390px');
    r.cols.forEach((id, q) => textAt(c, 'rnum', COLX[q], yy, figH(id), r.t_in + 0.2, EB, 'font-size:' + (rh >= 80 ? 44 : 40) + 'px;text-align:right;width:' + COLW[q] + 'px'));
    add(at(el('div', '', 'background:var(--paper-2);height:2px'), 96, yy + rh - (tight ? 3 : 8), 1728, 2), r.t_in, EB, null, c.root);
  });
  const ct = R.cost_tot, ty = RY0 + R.cost.length * rh + 14;
  textAt(c, 'h2', 96, ty, 'All routes', ct.t_in, EB, 'color:var(--ink)');
  textAt(c, 'rnum', COLX[0], ty - 6, figH(ct.cols[0]), ct.t_in + 0.2, EB, 'font-size:48px;text-align:right;width:' + COLW[0] + 'px');
  // totals can be wider than a row's value (eight or more digits): right-aligned in boxes that grow to the left into empty columns
  textAt(c, 'rnum', COLX[3] + COLW[3] - 280, ty - 2, figH(ct.cols[1]), ct.t_in + 0.2, EB, 'font-size:40px;text-align:right;width:280px');
  textAt(c, 'rnum', COLX[4] + COLW[4] - 200, ty - 2, figH(ct.cols[2]), ct.t_in + 0.2, EB, 'font-size:40px;text-align:right;width:200px');
  textAt(c, 'note', 96, ty + 52, phH('results.cost_foot'), ct.t_in + 0.7, EB, 'font-size:26px', 1728);
}

/* ---------- chapter 4: proof ---------- */
function buildProof() {
  const c = chapter('proof'), P = S.proof, T = P.t, term = P.term;
  /* tall: the masked-values table does not fit above the fingerprints (many routes), so the terminal gets shorter, the fingerprints move under it in one column
     and the scan panel runs the full height of the page */
  const keysAll = [...new Set(P.masked.map((m) => m.route + '|' + m.name))];
  const holdsOf = (k) => { const m = P.masked.find((x) => x.route + '|' + x.name === k); return Boolean(m.holds && m.holds !== m.name); };
  const tall = 8 + 360 + keysAll.reduce((a, k) => a + (holdsOf(k) ? 88 : 58), 0) + 22 > (P.hashes.length <= 6 ? 800 : 736) + 40 - 124;
  const TERM_H = tall ? 362 : 540, OUTR = tall ? 8 : 14;
  const tp = at(el('div', 'panel term'), 96, 124, 1010, TERM_H); tp.innerHTML = '<div class="ph"><span class="lab">Terminal</span><span class="r">captured run, replayed</span></div>';
  const cmd = el('div', 'tl', 'height:30px;margin-top:12px;color:var(--on-panel)'); const cmdA = el('span', 'acc', '', '$ '), cmdB = el('span', 'ex-id', 'font-size:24px'); cmd.append(cmdA, cmdB); tp.appendChild(cmd);
  const out = el('div', 'out', 'height:' + OUTR * 30 + 'px;margin-top:8px'), inn = el('div', 'in'); out.appendChild(inn); tp.appendChild(out);
  const lines = term.lines.map((l) => { const d = el('div', 'tl ' + (/^ok\b/.test(l.text) ? 'pass' : /^(FAIL|VERDICT: \d+ of \d+ recounts differ)/.test(l.text) ? 'fail' : /^VERDICT/.test(l.text) ? 'verdict' : 'pass'), 'visibility:hidden', escT(l.text)); d.dataset.rec = 'term'; d.dataset.file = term.file; d.dataset.line = String(l.line); d.dataset.sha = l.sha256; inn.appendChild(d); return d; });
  let vis0 = 0, vis1 = 0;
  addIn(c, tp, T.cmd - 0.4, T.end, (t, e) => {
    e.style.opacity = String(ease(ramp(t, T.cmd - 0.4, T.cmd))); cmdB.textContent = term.shown.slice(0, Math.floor(term.shown.length * ramp(t, T.cmd, T.cmd + 1.3)));
    const total = lines.length, pr = ramp(t, T.out0, T.out1), count = Math.min(total, Math.floor(total * (0.2 * pr + 0.8 * pr * pr) + 1e-9) + (pr > 0.01 ? 1 : 0)), a = Math.max(0, count - OUTR);
    if (a !== vis0 || count !== vis1) { for (let i = Math.min(vis0, a); i < Math.max(vis1, count); i++) lines[i].style.visibility = i >= a && i < count ? 'visible' : 'hidden'; vis0 = a; vis1 = count; }
    inn.style.top = -a * 30 + 'px';
  });
  const chip = at(el('div', '', 'font-weight:600;font-size:30px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;height:40px;line-height:40px'), 96, TERM_H + 136, 1010, 44);
  chip.innerHTML = 'Real ' + dvH('proof.real') + ' s · shown ' + dvH('proof.shown') + ' s · ' + dvH('proof.ratio', 'acc') + ' ' + (term.direction === 'SLOWER' ? 'slower' : 'faster') + ' · exit <span class="ok">' + dvH('proof.exit') + '</span>';
  addIn(c, chip, T.chip, T.end, fadeIn(T.chip, 0.3));
  /* secret scan */
  // each masked value is a row of up to three lines (route, name with its counts, and, for a key, the variable it held); the panel grows with the rows and stops above the fingerprints (y 776)
  const maskedRowKeys = keysAll;
  const rowH = (k) => (tall ? 58 : holdsOf(k) ? 88 : 58);   // tall: the route and the variable it held share the first line
  const rowsTotal = maskedRowKeys.reduce((a, k) => a + rowH(k), 0);
  // up to six recordings keep their fingerprints low (y 800), which leaves the panel room down to y 840; more of them start at y 736 and the panel stops at y 776; tall: the panel runs down to y 940
  const FY = tall ? TERM_H + 124 + 12 + 44 + 12 : P.hashes.length <= 6 ? 800 : 736, panelMax = tall ? 940 - 124 : FY + 40 - 124;
  const panelH = Math.max(540, 8 + 360 + rowsTotal + 22);
  if (panelH > panelMax) throw new Error('the masked-values table does not fit above the fingerprints (' + maskedRowKeys.length + ' rows, ' + rowsTotal + ' px, the panel may be ' + panelMax + ' px high)');
  const sp = at(el('div', 'panel'), 1130, 124, 694, panelH); sp.innerHTML = '<div class="ph"><span class="lab">Secret scan</span><span class="r">audit folder</span></div>';
  const hit = at(el('div', 'hits'), 22, 76, 300, 240); hit.innerHTML = '<div class="k" style="font-weight:600;font-size:28px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim-panel)">Secret hits</div><div class="big v" style="font-size:190px;height:190px;line-height:190px;color:var(--ok-on-panel)">' + figH(P.scan_ids.hits) + '</div>';
  sp.appendChild(hit);
  const fb = at(el('div', 'cell'), 340, 84, 330, 230); fb.innerHTML = '<div class="k" style="color:var(--dim-panel)">Files scanned</div><div class="v" style="color:var(--on-panel);font-size:60px;padding-top:2px">' + figH(P.scan_ids.files) + '</div><div class="k" style="color:var(--dim-panel);margin-top:10px">Kit requests recorded</div><div class="v" style="color:var(--on-panel);font-size:60px;padding-top:2px">' + figH(P.scan_ids.recorded) + '</div><div class="s" style="color:var(--dim-panel);font-size:24px;line-height:28px">decide() calls, not HTTP calls</div>';
  sp.appendChild(fb);
  /* masked values: rows = route and name, columns = benches (164 px each, so the names of the benches never touch) */
  const benchKeys = Object.keys(S.labels.benches), rowsK = maskedRowKeys, COLP = 164;
  const mt = at(el('div', '', 'border-top:2px solid var(--rule-panel)'), 22, 318, 650, panelH - 318 - 10); sp.appendChild(mt);
  const hdr = el('div', 'tl', 'padding:0;height:30px;margin-top:6px;color:var(--dim-panel);font-family:var(--display);font-weight:600;letter-spacing:.06em;text-transform:uppercase', 'Masked values'); mt.appendChild(hdr);
  benchKeys.forEach((b, bi) => { const h = at(el('div', 'tl', 'padding:0;height:30px;text-align:right;color:var(--dim-panel);font-family:var(--display);font-weight:600;letter-spacing:.04em;text-transform:uppercase'), 650 - COLP * (benchKeys.length - bi) - 8, 6, COLP - 8); h.innerHTML = nmH(S.labels.benches[b].label); mt.appendChild(h); });
  let ry = 42;
  rowsK.forEach((k) => {
    const [route, name] = k.split('|'); const hh = rowH(k); const m0 = P.masked.find((x) => x.route === route && x.name === name);
    const d = at(el('div', 'tl', 'padding:2px 0 0;height:' + hh + 'px;border-top:1px solid var(--rule-panel)'), 0, ry, 650, hh); ry += hh;
    d.innerHTML = '<div style="height:24px;line-height:24px;color:var(--dim-panel)">' + exH('ex-id', route) + (tall && holdsOf(k) ? ' · holds ' + exH('ex-id', m0.holds) : '') + '</div><div style="height:28px;line-height:28px">' + exH('ex-id', name) + '</div>' + (hh > 60 ? '<div style="height:28px;line-height:28px;color:var(--dim-panel)">holds ' + exH('ex-id', m0.holds) + '</div>' : '');
    benchKeys.forEach((b, bi) => { const m = P.masked.find((x) => x.route === route && x.bench === b && x.name === name); if (m) { const sx = el('span', '', 'position:absolute;top:26px;height:28px;line-height:28px;right:' + (COLP * (benchKeys.length - 1 - bi) + 8) + 'px;width:' + (COLP - 40) + 'px;text-align:right', figH(m.fig)); d.appendChild(sx); } });
    mt.appendChild(d);
  });
  addIn(c, sp, T.scan - 0.4, T.end, (t, e) => { e.style.opacity = String(ease(ramp(t, T.scan - 0.4, T.scan))); });
  /* fingerprints */
  const hl = at(el('div', 'h2', 'color:var(--ink);font-size:30px;white-space:nowrap'), 96, FY); hl.innerHTML = 'Fingerprints of the recorded files · ' + exH('ex-id', 'sha256') + ', first ten'; addIn(c, hl, T.hashIn - 0.4, T.end, fadeIn(T.hashIn - 0.4));
  if (P.hashes.length > 10) throw new Error('the fingerprint table holds ten recordings, this audit has ' + P.hashes.length);
  const hrows = P.hashes, per = Math.ceil(hrows.length / 2), padTo = Math.max(18, ...hrows.map((h) => (h.route + ' ' + h.bench).length));   // the wire column lines up whatever the longest name
  hrows.forEach((h, i) => {
    const col = tall ? 0 : Math.floor(i / per), row = tall ? i : i % per; const x = 96 + col * 880, y = FY + 46 + row * 32;
    const d = at(el('div', 'hashrow'), x, y, 860, 30);
    const wid = `proof.hash.${h.route}.${h.bench}.wire`, did = `proof.hash.${h.route}.${h.bench}.decide`;
    d.innerHTML = exH('ex-id', (h.route + ' ' + h.bench).padEnd(padTo)) + ' wire <span class="h" data-dv="' + wid + '"></span>  decide <span class="h" data-dv="' + did + '"></span>';
    const sw = d.querySelectorAll('.h'); const t0 = T.hashIn + i * 0.12;
    addIn(c, d, t0, T.end, (t) => { d.style.opacity = String(ease(ramp(t, t0, t0 + 0.2))); const n = clamp(Math.floor((t - t0) / 0.05), 0, 10); [wid, did].forEach((id, q) => { const txt = DV[id].text; sw[q].textContent = txt.slice(0, n) + '·'.repeat(Math.max(0, txt.length - n)); }); });
  });
}

/* ---------- chapter 5: end card ---------- */
let ENDC = null;
function buildEnd() {
  const c = chapter('end'), E = S.end, t0 = E.t0;
  const p = at(el('div', 'endp'), 96, 124, 1728, 816);
  addIn(c, p, t0 + 0.2, CH.end.t1, fadeIn(t0 + 0.2, 0.4));
  /* a column: each item takes the next free place, so nothing moves when a later one fades in */
  const col = at(el('div', 'endc'), 0, 0, 1728, 808); p.appendChild(col); ENDC = col;
  const put = (cls, html, t, last) => { const e = el('div', cls, '', html); add(e, t, CH.end.t1, fadeIn(t, 0.35), col); return e; };
  put('t', 'Counted, not typed', t0 + 0.3);
  const cls = { product: 'b', keys: 'b', counted: 'b', offline: 'b', limits: 'b lim', note: 'a', remask: 'a', credit: 'a' };
  E.items.forEach((it) => put(cls[PH[it.ph].role] || 'a', phH(it.ph), it.t));
  const lic = E.attribution.map((a) => '<b>' + exH('ex-id', a.id) + '</b> · ' + escT(a.owner) + ' · ' + exH('ex-id', a.licence)).join(' · ');
  put('a lic', 'Data used under licence: ' + lic, E.licence_t);
  const date = E.date_ids.length ? 'Recorded ' + E.date_ids.map((id) => figH(id)).join(' and ') + ' · ' : '';
  put('a', date + 'audit ' + exH('ex-id', S.audit_id), E.date_t);
}

(async function main() {
  try {
    await loadFonts();
    buildChrome(); buildOpen(); buildReplay(); buildResults(); buildProof(); buildEnd();
    /* the finished end card must sit inside its panel: setTime is a pure function of t, so looking at it here changes nothing */
    setTime(CH.end.t1 - 0.5); { const last = ENDC.lastElementChild; const over = last.getBoundingClientRect().bottom - (ENDC.parentElement.getBoundingClientRect().bottom - 20); if (over > 0) throw new Error('the end card runs ' + Math.round(over) + ' px past its panel'); } setTime(0);
    window.setTime = setTime; window.__chapters = S.chapters; window.__total = TOTAL; window.__ready = true;
  } catch (e) { window.__error = String(e && e.stack || e); }
})();
