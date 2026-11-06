'use strict';
/* NOVO-BE — in-browser processing pipeline.
 *
 * Decodes the raw DMA frames of the NOVO detector backend, runs charge-integration pulse
 * processing (baseline, CFD time, short/long gate charges, PSD) and serves histograms to the
 * page through `localApi(path, body)`, a small in-process router. Nothing leaves the browser.
 *
 * Frame format (4096 bytes): 0x55 | detector id u16 | timestamp u64 (1/1.3 GHz ticks) |
 * enabled features u32 | packet counter u8 | raw size u16 | pad | 253 blocks of [CH1 x4, CH0 x4]
 * u16 samples | pad | CRC16. Samples are 14-bit two's complement ADC codes shifted left by 2.
 */
const localApi = (() => {
  const FRAME = 4096, HDR = 32, NS = 1012, NBLK = 253, MAGIC = 0x55, ADC_MAX = 8191, ADC_MIN = -8192, TICK_NS = 1 / 1.3;
  const code = v => (v << 16) >> 18;   // u16 raw -> signed 14-bit two's complement code

  // ================================================================ frames
  function readBin(buf, name, fileIndex) {
    const n = Math.floor(buf.byteLength / FRAME);
    const dv = new DataView(buf);
    const f = {
      n, ts: new BigUint64Array(n), cnt: new Uint8Array(n), det: new Uint16Array(n), ef: new Uint32Array(n),
      size: new Uint16Array(n), crc: new Uint16Array(n), magic: new Uint8Array(n),
      ch0: new Uint16Array(n * NS), ch1: new Uint16Array(n * NS),
      src: new Int32Array(n).fill(fileIndex), idx: new Int32Array(n), files: [name], bytes: buf.byteLength,
    };
    for (let i = 0; i < n; i++) {
      const off = i * FRAME;
      f.magic[i] = dv.getUint8(off); f.det[i] = dv.getUint16(off + 1, true); f.ts[i] = dv.getBigUint64(off + 3, true);
      f.ef[i] = dv.getUint32(off + 11, true); f.cnt[i] = dv.getUint8(off + 15); f.size[i] = dv.getUint16(off + 16, true);
      f.crc[i] = dv.getUint16(off + 4094, true); f.idx[i] = i;
      const raw = new Uint16Array(buf, off + HDR, 2 * NS);     // little-endian host assumed
      const row = i * NS;
      for (let b = 0; b < NBLK; b++) {
        const s = b * 8, d = row + b * 4;
        f.ch1[d] = raw[s]; f.ch1[d + 1] = raw[s + 1]; f.ch1[d + 2] = raw[s + 2]; f.ch1[d + 3] = raw[s + 3];
        f.ch0[d] = raw[s + 4]; f.ch0[d + 1] = raw[s + 5]; f.ch0[d + 2] = raw[s + 6]; f.ch0[d + 3] = raw[s + 7];
      }
    }
    return f;
  }

  function merge(parts) {
    const n = parts.reduce((a, p) => a + p.n, 0);
    const cat = (key, Ctor) => { const out = new Ctor(parts.reduce((a, p) => a + p[key].length, 0)); let o = 0; for (const p of parts) { out.set(p[key], o); o += p[key].length; } return out; };
    const all = {
      n, ts: cat('ts', BigUint64Array), cnt: cat('cnt', Uint8Array), det: cat('det', Uint16Array), ef: cat('ef', Uint32Array),
      size: cat('size', Uint16Array), crc: cat('crc', Uint16Array), magic: cat('magic', Uint8Array),
      ch0: cat('ch0', Uint16Array), ch1: cat('ch1', Uint16Array), src: cat('src', Int32Array), idx: cat('idx', Int32Array),
      files: parts.flatMap(p => p.files), bytes: parts.reduce((a, p) => a + p.bytes, 0),
    };
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (all.ts[a] < all.ts[b] ? -1 : all.ts[a] > all.ts[b] ? 1 : 0));
    const f = { n, files: all.files, bytes: all.bytes, gap: new Int32Array(n) };
    for (const [key, Ctor] of [['ts', BigUint64Array], ['cnt', Uint8Array], ['det', Uint16Array], ['ef', Uint32Array], ['size', Uint16Array], ['crc', Uint16Array], ['magic', Uint8Array], ['src', Int32Array], ['idx', Int32Array]]) {
      f[key] = new Ctor(n); for (let i = 0; i < n; i++) f[key][i] = all[key][order[i]];
    }
    for (const key of ['ch0', 'ch1']) {
      f[key] = new Uint16Array(n * NS);
      for (let i = 0; i < n; i++) f[key].set(all[key].subarray(order[i] * NS, order[i] * NS + NS), i * NS);
    }
    for (let i = 1; i < n; i++) f.gap[i] = ((f.cnt[i] - f.cnt[i - 1] + 256) % 256) - 1;
    return f;
  }

  function headerIssues(f) {
    let badMagic = 0, badSize = 0, lost = 0, gaps = 0, crcPlaceholder = f.n > 0;
    for (let i = 0; i < f.n; i++) {
      if (f.magic[i] !== MAGIC) badMagic++; if (f.size[i] !== 2 * NS) badSize++;
      if (f.gap[i]) { lost += f.gap[i]; gaps++; } if (f.crc[i] !== 0x3333) crcPlaceholder = false;
    }
    return { bad_magic: badMagic, bad_size: badSize, lost_frames: lost, gap_events: gaps, crc_placeholder: crcPlaceholder };
  }

  // ================================================================ pulse processing
  const DEFAULT_PARAMS = {
    polarity: 'auto', baseline_samples: 200, threshold: 25.0, cfd_fraction: 0.5, pre_gate: 6, short_gate: 90, long_gate: 480,
    search_start: 0, search_end: NS, sample_ns: TICK_NS, ts_ns: TICK_NS, psd_cut: 0.147,
  };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  function validated(p) {
    const q = { ...p };
    q.polarity = ['auto', 'pos', 'neg'].includes(q.polarity) ? q.polarity : 'auto';
    q.baseline_samples = clamp(Math.round(q.baseline_samples), 4, NS - 8);
    q.threshold = Math.max(+q.threshold || 0, 0); q.cfd_fraction = clamp(+q.cfd_fraction || 0.5, 0.05, 0.95);
    q.pre_gate = clamp(Math.round(q.pre_gate), 0, 100); q.short_gate = clamp(Math.round(q.short_gate), 1, NS);
    q.long_gate = clamp(Math.round(q.long_gate), q.short_gate, NS);
    q.search_start = clamp(Math.round(q.search_start), 0, NS - 2); q.search_end = clamp(Math.round(q.search_end), q.search_start + 2, NS);
    q.sample_ns = Math.max(+q.sample_ns || 2, 1e-3); q.ts_ns = Math.max(+q.ts_ns || 1, 1e-6); q.psd_cut = +q.psd_cut;
    return q;
  }
  function percentile(arr, pct) {
    const a = Float64Array.from(arr).sort(); if (!a.length) return 0;
    const k = (a.length - 1) * pct / 100, lo = Math.floor(k), hi = Math.ceil(k);
    return a[lo] + (a[hi] - a[lo]) * (k - lo);
  }

  // baseline = mean of the first `baseline_samples`; amp = peak above baseline (polarity auto-detected);
  // t0 = last crossing of cfd_fraction*amp before the peak (interpolated); gates open at floor(t0)+1-pre_gate;
  // Q_short / Q_long = sums over the gates; PSD = (Q_long - Q_short) / Q_long; pile-up = second peak inside the long gate.
  function processChannel(raw, n, p) {
    const B = p.baseline_samples;
    const baseline = new Float32Array(n), noise = new Float32Array(n);
    const posMax = new Float32Array(n), negMax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const row = i * NS; let sum = 0, sq = 0;
      for (let j = 0; j < B; j++) { const v = code(raw[row + j]); sum += v; sq += v * v; }
      const m = sum / B; baseline[i] = m; noise[i] = Math.sqrt(Math.max(0, sq / B - m * m));
      let mx = -Infinity, mn = Infinity;
      for (let j = 0; j < NS; j++) { const v = code(raw[row + j]); if (v > mx) mx = v; if (v < mn) mn = v; }
      posMax[i] = mx - m; negMax[i] = m - mn;
    }
    const polarity = p.polarity !== 'auto' ? p.polarity : (percentile(posMax, 99) >= percentile(negMax, 99) ? 'pos' : 'neg');
    const sign = polarity === 'pos' ? 1 : -1;
    const amp = new Float32Array(n), peakIdx = new Int32Array(n), t0 = new Float32Array(n).fill(NaN), gateStart = new Int32Array(n);
    const qshort = new Float32Array(n), qlong = new Float32Array(n), psd = new Float32Array(n).fill(NaN);
    const valid = new Uint8Array(n), saturated = new Uint8Array(n), pileup = new Uint8Array(n), tot = new Int32Array(n);
    const s = new Float32Array(NS), sm = new Float32Array(NS);
    for (let i = 0; i < n; i++) {
      const row = i * NS, base = baseline[i];
      let cMax = -1e9, cMin = 1e9;
      for (let j = 0; j < NS; j++) { const c = code(raw[row + j]); if (c > cMax) cMax = c; if (c < cMin) cMin = c; s[j] = sign * (c - base); }
      saturated[i] = polarity === 'pos' ? (cMax >= ADC_MAX ? 1 : 0) : (cMin <= ADC_MIN ? 1 : 0);
      let pk = p.search_start, best = -Infinity;
      for (let j = p.search_start; j < p.search_end; j++) if (s[j] > best) { best = s[j]; pk = j; }
      peakIdx[i] = pk; amp[i] = best;
      const level = p.cfd_fraction * best;
      let jc = -1;
      for (let j = pk - 1; j >= 0; j--) if (s[j] < level && s[j + 1] >= level) { jc = j; break; }
      const found = jc >= 0; const jcc = found ? jc : 0;
      if (found) { const y0 = s[jcc], y1 = s[jcc + 1]; const frac = y1 > y0 ? clamp((level - y0) / Math.max(y1 - y0, 1e-6), 0, 1) : 0; t0[i] = jcc + frac; }
      const g0 = clamp(jcc + 1 - p.pre_gate, 0, NS), gs = Math.min(g0 + p.short_gate, NS), gl = Math.min(g0 + p.long_gate, NS);
      gateStart[i] = g0;
      let qs = 0, ql = 0, nt = 0;
      for (let j = g0; j < gl; j++) { ql += s[j]; if (j < gs) qs += s[j]; const cv = code(raw[row + j]); if (polarity === 'pos' ? cv >= ADC_MAX : cv <= ADC_MIN) nt++; }
      tot[i] = nt;
      qshort[i] = qs; qlong[i] = ql; if (ql > 0) psd[i] = (ql - qs) / ql;
      const level2 = Math.max(p.threshold, 0.04 * best); let pu = 0;
      for (let j = 1; j < NS - 1; j++) sm[j] = (s[j - 1] + s[j] + s[j + 1]) / 3; sm[0] = s[0]; sm[NS - 1] = s[NS - 1];
      let rm = sm[pk];
      for (let j = pk + 1; j < gl && !pu; j++) { if (sm[j] < rm) rm = sm[j]; if (j >= pk + 4 && j >= 2 && j < NS - 2 && sm[j] >= level2 && sm[j] - rm >= level2 && sm[j] >= sm[j - 1] && sm[j] > sm[j + 1] && sm[j] >= sm[j - 2] && sm[j] > sm[j + 2]) pu = 1; }
      rm = sm[pk];
      for (let j = pk - 1; j >= 0 && !pu; j--) { if (sm[j] < rm) rm = sm[j]; if (j <= pk - 4 && j >= 2 && j < NS - 2 && sm[j] >= level2 && sm[j] - rm >= level2 && sm[j] >= sm[j - 1] && sm[j] > sm[j + 1] && sm[j] >= sm[j - 2] && sm[j] > sm[j + 2]) pu = 1; }
      pileup[i] = pu;
      valid[i] = (found && best >= p.threshold && ql > 0 && (gl - g0) === p.long_gate) ? 1 : 0;
    }
    return { baseline, noise, amp, peak_idx: peakIdx, t0, gate_start: gateStart, qshort, qlong, psd, valid, saturated, pileup, tot, polarity };
  }

  // ================================================================ histograms and fits
  function hist1d(x, nbins, lo, hi) {
    const counts = new Int32Array(nbins), w = (hi - lo) / nbins;
    for (let i = 0; i < x.length; i++) { const v = x[i]; if (!Number.isFinite(v) || v < lo || v > hi) continue; let k = Math.floor((v - lo) / w); if (k === nbins) k = nbins - 1; counts[k]++; }
    const edges = Array.from({ length: nbins + 1 }, (_, i) => lo + i * w);
    return { counts: Array.from(counts), edges };
  }
  function autoRange(x) {
    const f = x.filter(Number.isFinite); if (!f.length) return [0, 1];
    let hi = percentile(f, 99.8) * 1.05, lo = 0; for (let i = 0; i < f.length; i++) if (f[i] < lo) lo = f[i];
    if (hi <= lo) hi = lo + 1; return [lo, hi];
  }
  function hist2d(x, y, nx, ny, xr, yr) {
    const z = Array.from({ length: ny }, () => new Int32Array(nx));
    const wx = (xr[1] - xr[0]) / nx, wy = (yr[1] - yr[0]) / ny;
    for (let i = 0; i < x.length; i++) {
      const a = x[i], b = y[i]; if (!Number.isFinite(a) || !Number.isFinite(b) || a < xr[0] || a > xr[1] || b < yr[0] || b > yr[1]) continue;
      let kx = Math.floor((a - xr[0]) / wx), ky = Math.floor((b - yr[0]) / wy); if (kx === nx) kx = nx - 1; if (ky === ny) ky = ny - 1; z[ky][kx]++;
    }
    return { z: z.map(r => Array.from(r)), x: Array.from({ length: nx + 1 }, (_, i) => xr[0] + i * wx), y: Array.from({ length: ny + 1 }, (_, i) => yr[0] + i * wy) };
  }
  function nelderMead(fn, x0, { maxIter = 4000, step = null } = {}) {
    const n = x0.length;
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += step ? step[i] : (p[i] !== 0 ? 0.1 * Math.abs(p[i]) : 0.01); simplex.push(p); }
    let vals = simplex.map(fn);
    for (let it = 0; it < maxIter; it++) {
      const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
      simplex = order.map(i => simplex[i]); vals = order.map(i => vals[i]);
      if (Math.abs(vals[n] - vals[0]) <= 1e-10 * (Math.abs(vals[0]) + 1e-12) && it > 50) break;
      const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
      const worst = simplex[n];
      const xr = c.map((v, j) => v + (v - worst[j])); const fr = fn(xr);
      if (fr < vals[0]) { const xe = c.map((v, j) => v + 2 * (v - worst[j])); const fe = fn(xe); if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; } }
      else if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; }
      else {
        const xc = c.map((v, j) => v + 0.5 * (worst[j] - v)); const fc = fn(xc);
        if (fc < vals[n]) { simplex[n] = xc; vals[n] = fc; }
        else { for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); vals[i] = fn(simplex[i]); } }
      }
    }
    const best = vals.indexOf(Math.min(...vals)); return simplex[best];
  }
  const gauss = (x, a, mu, s) => a * Math.exp(-0.5 * ((x - mu) / s) ** 2);
  function fitTwoGaussians(counts, edges) {
    const total = counts.reduce((a, b) => a + b, 0); if (total < 50) return null;
    const centers = edges.slice(0, -1).map((e, i) => 0.5 * (e + edges[i + 1]));
    const bw = edges[1] - edges[0];
    let acc = 0, split = centers[0]; for (let i = 0; i < counts.length; i++) { acc += counts[i]; if (acc >= total / 2) { split = centers[i]; break; } }
    const moments = mask => { let w = 0, m = 0, mx = 0; for (let i = 0; i < counts.length; i++) if (mask(centers[i])) { w += counts[i]; m += centers[i] * counts[i]; if (counts[i] > mx) mx = counts[i]; } if (w <= 0) return [split, bw, 1]; const mu = m / w; let v = 0; for (let i = 0; i < counts.length; i++) if (mask(centers[i])) v += (centers[i] - mu) ** 2 * counts[i]; return [mu, Math.max(Math.sqrt(v / w), bw), mx]; };
    const [mu1, s1, a1] = moments(c => c < split), [mu2, s2, a2] = moments(c => c >= split);
    const lo = edges[0], hi = edges[edges.length - 1], span = hi - lo;
    const bound = q => [Math.max(q[0], 0), clamp(q[1], lo, hi), clamp(Math.abs(q[2]), 1e-4, span), Math.max(q[3], 0), clamp(q[4], lo, hi), clamp(Math.abs(q[5]), 1e-4, span)];
    const chi2 = q => { const b = bound(q); let sum = 0; for (let i = 0; i < counts.length; i++) { const d = gauss(centers[i], b[0], b[1], b[2]) + gauss(centers[i], b[3], b[4], b[5]) - counts[i]; sum += d * d; } return sum; };
    let q = bound(nelderMead(chi2, [a1, mu1, s1, a2, mu2, s2]));
    q = bound(nelderMead(chi2, q));
    let [A1, M1, S1, A2, M2, S2] = q;
    if (M1 > M2) [A1, M1, S1, A2, M2, S2] = [A2, M2, S2, A1, M1, S1];
    const fwhm1 = 2.3548 * S1, fwhm2 = 2.3548 * S2;
    const fom = (fwhm1 + fwhm2) > 0 ? Math.abs(M2 - M1) / (fwhm1 + fwhm2) : 0;
    return { gamma: { amp: A1, mu: M1, sigma: S1, fwhm: fwhm1 }, neutron: { amp: A2, mu: M2, sigma: S2, fwhm: fwhm2 }, fom, curve: centers.map(x => gauss(x, A1, M1, S1) + gauss(x, A2, M2, S2)), centers };
  }
  function fitSingleGaussian(counts, edges) {
    const total = counts.reduce((a, b) => a + b, 0); if (total < 30) return null;
    const centers = edges.slice(0, -1).map((e, i) => 0.5 * (e + edges[i + 1])); let m = 0; for (let i = 0; i < counts.length; i++) m += centers[i] * counts[i]; m /= total; let v = 0; for (let i = 0; i < counts.length; i++) v += (centers[i] - m) ** 2 * counts[i]; const s0 = Math.max(Math.sqrt(v / total), edges[1] - edges[0]);
    const chi2 = q => { let sum = 0; const a = Math.max(q[0], 0), mu = q[1], sg = Math.max(Math.abs(q[2]), 1e-4); for (let i = 0; i < counts.length; i++) { const d = gauss(centers[i], a, mu, sg) - counts[i]; sum += d * d; } return sum; };
    const q = nelderMead(chi2, [Math.max(...counts), m, s0]); const a = Math.max(q[0], 0), mu = q[1], sg = Math.abs(q[2]);
    return { amp: a, mu, sigma: sg, fwhm: 2.3548 * sg, curve: centers.map(x => gauss(x, a, mu, sg)), centers };
  }
  function dtHist(tsNs, nbins = 80) {
    if (tsNs.length < 2) return { edges: [], counts: [] };
    const t = Float64Array.from(tsNs).sort(); const dt = [];
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 0) dt.push(t[i] - t[i - 1]);
    if (!dt.length) return { edges: [], counts: [] };
    let mn = Infinity, mx = -Infinity, sum = 0; for (const d of dt) { if (d < mn) mn = d; if (d > mx) mx = d; sum += d; }
    const lo = Math.log10(Math.max(1, mn)), hi = Math.log10(mx * 1.05);
    const edges = Array.from({ length: nbins + 1 }, (_, i) => 10 ** (lo + (hi - lo) * i / nbins));
    const counts = new Array(nbins).fill(0);
    for (const d of dt) { let k = Math.floor((Math.log10(d) - lo) / (hi - lo) * nbins); k = clamp(k, 0, nbins - 1); counts[k]++; }
    const sorted = Float64Array.from(dt).sort();
    return { edges, counts, mean_ns: sum / dt.length, median_ns: sorted[Math.floor(sorted.length / 2)] };
  }
  function rateCurve(tsNs, nbins = 120) {
    if (!tsNs.length) return { t: [], cps: [], bin_s: 0 };
    let mn = Infinity, mx = -Infinity; for (let i = 0; i < tsNs.length; i++) { if (tsNs[i] < mn) mn = tsNs[i]; if (tsNs[i] > mx) mx = tsNs[i]; }
    const span = Math.max((mx - mn) / 1e9, 1e-9), binS = span / nbins, counts = new Array(nbins).fill(0);
    for (let i = 0; i < tsNs.length; i++) { let k = Math.floor((tsNs[i] - mn) / 1e9 / binS); if (k === nbins) k = nbins - 1; counts[k]++; }
    return { t: counts.map((_, i) => (i + 0.5) * binS), cps: counts.map(c => c / binS), bin_s: binS };
  }

  // ================================================================ run state
  const L = { runs: new Map(), name: null, meta: null, frames: null, params: validated(DEFAULT_PARAMS), results: {}, processed: false, dirty: false, procRange: null, processMs: 0,
    coinc: { enabled: true, window_ns: 3.0, center_ns: 0 }, twin: { enabled: false, t0_s: null, t1_s: null }, excludePileup: true, classifier: { mode: 'cut' } };
  const need = () => { if (!L.frames) throw new Error('Open a run first'); };
  const needProc = () => { need(); if (!L.processed) throw new Error('Run not processed yet: pick the time window on the Time tab and press "Process window"'); };
  const tsNs = () => { const f = L.frames, out = new Float64Array(f.n), t0 = f.ts[0]; for (let i = 0; i < f.n; i++) out[i] = Number(f.ts[i] - t0) * L.params.ts_ns; return out; };
  const duration = () => { const t = tsNs(); return t.length > 1 ? t[t.length - 1] / 1e9 : 0; };
  function timeMask() { const t = tsNs(), out = new Uint8Array(t.length), a = L.twin.t0_s, b = L.twin.t1_s; for (let i = 0; i < t.length; i++) { const s = t[i] / 1e9; out[i] = ((a == null || s >= a) && (b == null || s <= b)) ? 1 : 0; } return out; }
  function windowRange() { const n = L.frames.n; if (!L.twin.enabled) return [0, n]; const m = timeMask(); let i0 = -1, i1 = 0; for (let i = 0; i < n; i++) if (m[i]) { if (i0 < 0) i0 = i; i1 = i + 1; } return i0 < 0 ? [0, 0] : [i0, i1]; }
  function emptyLike(r, n, i0) { const out = {}; for (const [k, v] of Object.entries(r)) { if (k === 'polarity') { out[k] = v; continue; } const f = new v.constructor(n); if (k === 't0' || k === 'psd') f.fill(NaN); f.set(v, i0); out[k] = f; } return out; }
  function process() {
    const t = performance.now(), n = L.frames.n, [i0, i1] = windowRange(), res = {};
    for (const ch of [0, 1]) { const full = ch === 0 ? L.frames.ch0 : L.frames.ch1; const sub = processChannel(full.subarray(i0 * NS, i1 * NS), i1 - i0, L.params); res[ch] = (i0 === 0 && i1 === n) ? sub : emptyLike(sub, n, i0); }
    L.results = res; L.processed = true; L.dirty = false; L.procRange = [i0, i1]; L.processMs = performance.now() - t;
    return summary();
  }
  function gmean() { const a = L.results[0].qlong, b = L.results[1].qlong, out = new Float32Array(a.length); for (let i = 0; i < a.length; i++) out[i] = Math.sqrt(Math.max(a[i], 0) * Math.max(b[i], 0)); return out; }
  const energy = ch => ch === 2 ? gmean() : L.results[ch].qlong;
  function pick(arr, mask) { const out = []; for (let i = 0; i < arr.length; i++) if (mask(i)) out.push(arr[i]); return out; }
  function coincMask() {
    const r0 = L.results[0], r1 = L.results[1], n = L.frames.n, m = new Uint8Array(n), center = L.coinc.center_ns || 0, w = L.coinc.window_ns;
    for (let i = 0; i < n; i++) if (r0.valid[i] && r1.valid[i] && Number.isFinite(r0.t0[i]) && Number.isFinite(r1.t0[i]) && Math.abs((r1.t0[i] - r0.t0[i]) * L.params.sample_ns - center) < w) m[i] = 1;
    return m;
  }
  function coincStats() {
    if (!L.processed) return { ...L.coinc, both_valid: 0, inside: 0, outside: 0, ch0_only: 0, ch1_only: 0 };
    const r0 = L.results[0], r1 = L.results[1], cm = coincMask(); let both = 0, inside = 0, c0 = 0, c1 = 0;
    for (let i = 0; i < L.frames.n; i++) { if (r0.valid[i] && r1.valid[i]) { both++; if (cm[i]) inside++; } else if (r0.valid[i]) c0++; else if (r1.valid[i]) c1++; }
    return { ...L.coinc, both_valid: both, inside, outside: both - inside, ch0_only: c0, ch1_only: c1 };
  }
  function timewinStats() { const n = L.frames ? L.frames.n : 0; const t = n ? tsNs() : null; const full = n > 1 ? t[n - 1] / 1e9 : 0; let inside = 0; if (n) { const m = timeMask(); for (let i = 0; i < n; i++) inside += m[i]; } const t0 = L.twin.t0_s ?? 0, t1 = L.twin.t1_s ?? full; return { ...L.twin, frames_inside: inside, frames_total: n, duration_s: Math.max(0, t1 - t0), run_duration_s: full }; }
  // per-channel validity narrowed by the pile-up, coincidence and time-window filters
  function validMask(ch) {
    if (!L.processed) { if (L.twin.enabled) return timeMask(); const all = new Uint8Array(L.frames.n); all.fill(1); return all; }
    const v = L.results[ch].valid, pu = L.results[ch].pileup, cm = L.coinc.enabled ? coincMask() : null, tm = L.twin.enabled ? timeMask() : null, out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] && (!L.excludePileup || !pu[i]) && (!cm || cm[i]) && (!tm || tm[i]) ? 1 : 0;
    return out;
  }
  function pileupStats() { const o = { exclude: L.excludePileup }; if (!L.processed) return o; for (const ch of [0, 1]) { const r = L.results[ch]; let f = 0, a = 0; for (let i = 0; i < r.valid.length; i++) if (r.valid[i]) { a++; if (r.pileup[i]) f++; } o[`ch${ch}_flagged`] = f; o[`ch${ch}_valid_all`] = a; } return o; }
  const singleSource = () => (L.classifier.mode === 'gamma_only' || L.classifier.mode === 'neutron_only') ? L.classifier.mode : null;
  function neutronMask(ch) {
    const n = L.frames.n, out = new Uint8Array(n), psd = chView(ch).psd;
    if (singleSource()) { if (L.classifier.mode === 'neutron_only') for (let i = 0; i < n; i++) out[i] = Number.isFinite(psd[i]) ? 1 : 0; return out; }
    const cut = L.params.psd_cut; for (let i = 0; i < n; i++) out[i] = Number.isFinite(psd[i]) && psd[i] > cut ? 1 : 0;
    return out;
  }
  function summary() {
    need(); const f = L.frames, dur = duration();
    const out = { name: L.name, files: f.files, frames: f.n, duration_s: dur, frame_rate: dur > 0 ? f.n / dur : 0, header: headerIssues(f), meta: L.meta, params: { ...L.params }, process_ms: L.processMs, processed: L.processed, dirty: L.dirty,
      proc_range: L.procRange ? { i0: L.procRange[0], i1: L.procRange[1], frames: L.procRange[1] - L.procRange[0] } : null, channels: {}, bytes: f.bytes, coinc: coincStats(), timewin: timewinStats(), pileup_filter: pileupStats(), classifier: { ...L.classifier } };
    for (const ch of L.processed ? [0, 1] : []) {
      const r = L.results[ch], vm = validMask(ch), nmk = neutronMask(ch); let nv = 0, sat = 0, pu = 0, nn = 0, nva = 0;
      for (let i = 0; i < f.n; i++) { if (r.saturated[i]) sat++; if (r.valid[i]) nva++; if (vm[i]) { nv++; if (r.pileup[i]) pu++; if (nmk[i]) nn++; } }
      const effDur = L.twin.enabled ? timewinStats().duration_s : dur;
      out.channels[ch] = { polarity: r.polarity, valid: nv, invalid: f.n - nv, valid_all: nva, saturated: sat, pileup: pu, cps: effDur > 0 ? nv / effDur : 0, neutrons: nn, gammas: nv - nn, saturated_frac: f.n ? sat / f.n : 0 };
    }
    return out;
  }
  // view 2 = both ends combined: PSD from the summed charges, energy = sqrt(Q0*Q1)
  function psdCombined() { const a = L.results[0], b = L.results[1], out = new Float32Array(a.qlong.length); for (let i = 0; i < out.length; i++) { const q = a.qlong[i] + b.qlong[i]; out[i] = q > 0 ? ((a.qlong[i] - a.qshort[i]) + (b.qlong[i] - b.qshort[i])) / q : NaN; } return out; }
  function chView(ch) { if (ch === 2) { const v0 = validMask(0), v1 = validMask(1), v = new Uint8Array(v0.length); for (let i = 0; i < v.length; i++) v[i] = v0[i] && v1[i] ? 1 : 0; return { vm: v, psd: psdCombined() }; } return { vm: validMask(ch), psd: L.results[ch].psd }; }
  function psdAutoRange(ch) {
    const cv = chView(ch), p = pick(cv.psd, i => cv.vm[i]).filter(Number.isFinite);
    if (p.length < 10) return [-0.1, 0.8];
    const lo = percentile(p, 0.5), hi = percentile(p, 99.5), pad = Math.max(0.02, 0.15 * (hi - lo));
    return [Math.max(-1, lo - pad), Math.min(1.5, hi + pad)];
  }
  function psd2d(ch, ne, npsd, elo, ehi, plo, phi) {
    const cv = chView(ch), vm = cv.vm, e = pick(energy(ch), i => vm[i]), p = pick(cv.psd, i => vm[i]);
    if (plo == null || phi == null) { const [alo, ahi] = psdAutoRange(ch); plo = plo == null ? alo : plo; phi = phi == null ? ahi : phi; }
    if (elo == null || ehi == null) { const [alo, ahi] = autoRange(e); elo = elo == null ? alo : elo; ehi = ehi == null ? ahi : ehi; }
    return { ...hist2d(e, p, ne, npsd, [elo, ehi], [plo, phi]), n: e.length };
  }
  function psd1d(ch, elo, ehi, nbins, plo, phi) {
    const cv = chView(ch), e = energy(ch), vm = cv.vm;
    if (plo == null || phi == null) { const [alo, ahi] = psdAutoRange(ch); plo = plo == null ? alo : plo; phi = phi == null ? ahi : phi; }
    const p = pick(cv.psd, i => vm[i] && e[i] >= elo && e[i] < ehi), h = hist1d(p, nbins, plo, phi), nmk = neutronMask(ch); let nN = 0, nG = 0;
    for (let i = 0; i < L.frames.n; i++) if (vm[i] && e[i] >= elo && e[i] < ehi && Number.isFinite(cv.psd[i])) { if (nmk[i]) nN++; else nG++; }
    const sgl = singleSource();
    return { ...h, n: p.length, fit: sgl ? null : fitTwoGaussians(h.counts, h.edges), band: sgl ? fitSingleGaussian(h.counts, h.edges) : null, neutrons: nN, gammas: nG, classifier: L.classifier.mode };
  }
  function timeHists(ch) {
    const vm = validMask(ch), t = tsNs(), tv = pick(t, i => vm[i]);
    let rate = rateCurve(tv);
    if (tv.length && t.length > 1) { const span = Math.max(t[t.length - 1] / 1e9, 1e-9), nb = 120, bs = span / nb, counts = new Array(nb).fill(0); for (const v of tv) { let k = Math.floor(v / 1e9 / bs); if (k === nb) k = nb - 1; counts[k]++; } rate = { t: counts.map((_, i) => (i + 0.5) * bs), cps: counts.map(c => c / bs), bin_s: bs }; }
    return { dt: dtHist(tv), rate, frame_rate: rateCurve(t), timewin: timewinStats() };
  }
  function waveform(i) {
    need(); const f = L.frames; i = clamp(i | 0, 0, f.n - 1); const p = L.params, t = tsNs();
    const out = { i, n: f.n, ts: f.ts[i].toString(), t_us: t[i] / 1e3, cnt: f.cnt[i], det: f.det[i], ef: f.ef[i], size: f.size[i], crc: f.crc[i], gap: f.gap[i], file: f.files[f.src[i]], file_idx: f.idx[i], channels: {} };
    for (const ch of [0, 1]) {
      const raw = (ch === 0 ? f.ch0 : f.ch1).subarray(i * NS, i * NS + NS), r = L.processed ? L.results[ch] : processChannel(raw, 1, p), k = L.processed ? i : 0, g0 = r.gate_start[k];
      out.channels[ch] = { samples: Array.from(raw, code), baseline: r.baseline[k], noise: r.noise[k], amp: r.amp[k], peak_idx: r.peak_idx[k], t0: Number.isFinite(r.t0[k]) ? r.t0[k] : null,
        gate: [g0, Math.min(g0 + p.short_gate, NS), Math.min(g0 + p.long_gate, NS)], qshort: r.qshort[k], qlong: r.qlong[k], psd: Number.isFinite(r.psd[k]) ? r.psd[k] : null,
        valid: !!r.valid[k], pileup: !!r.pileup[k], saturated: !!r.saturated[k], tot: r.tot[k], polarity: r.polarity, neutron: L.processed ? !!neutronMask(ch)[i] : null };
    }
    return out;
  }
  function nextValid(i, ch, step) { if (!L.processed) return clamp(i + step, 0, L.frames.n - 1); const v = validMask(ch); for (let j = i + step; j >= 0 && j < v.length; j += step) if (v[j]) return j; return i; }

  // ---------------------------------------------------------------- CoMPASS-style ROOT export (needs rootwriter.js)
  // TTree "Data_R" holds every frame of the processed window, "Data_F" the events passing the active filters.
  // Branches as CoMPASS: Channel/s Timestamp/l Board/s Energy/s EnergyShort/s Flags/i and optionally
  // Samples (TArrayS). Timestamp = picoseconds from the first sample of the first frame; Energy = Q_long / divisor,
  // EnergyShort = Q_short / divisor (the divisor keeps the values within 16 bits).
  const TRIGGER_SAMPLE = 500;
  const FLAG_BITS = { 1: 'pile-up: second pulse inside the long gate', 2: 'ADC saturation', 4: 'no valid pulse (no CFD crossing, below threshold or gate truncated)', 8: 'frames lost before this event (packet counter gap)', 16: 'outside the two-end coincidence window', 64: 'classified as neutron by the active n/γ classifier' };
  const clampU16 = v => v < 0 ? 0 : v > 65535 ? 65535 : v;
  function exportCompass(o) {
    needProc(); if (typeof RootWriter === 'undefined') throw new Error('rootwriter.js is not loaded');
    o = o || {};
    const f = L.frames, [i0, i1] = L.procRange, p = L.params, ts0 = f.ts[0];
    const tickPs = p.ts_ns * 1000, sampPs = p.sample_ns * 1000;
    const perChannel = o.per_channel !== false, filtered = o.filtered !== false, wave = !!o.waveforms, cfd = o.cfd !== false;
    let scale = +o.energy_scale || 0, qmax = 0;
    for (const ch of [0, 1]) { const q = L.results[ch].qlong; for (let i = i0; i < i1; i++) if (q[i] > qmax) qmax = q[i]; }
    if (!(scale > 0)) { scale = 1; while (qmax / scale > 65535) scale *= 2; }
    const run = (L.name || 'run').replace(/[^A-Za-z0-9_.-]+/g, '_'), det = i1 > i0 ? f.det[i0] : 0;
    const all = new Uint8Array(f.n); all.fill(1, i0, i1);
    const sets = [{ tag: 'R', folder: 'RAW', tree: 'Data_R', title: 'CoMPASS RAW events', masks: [all, all] }];
    if (filtered) sets.push({ tag: 'F', folder: 'FILTERED', tree: 'Data_F', title: 'CoMPASS FILTERED events', masks: [validMask(0), validMask(1)] });
    const cm = L.coinc.enabled ? coincMask() : null, nmk = [neutronMask(0), neutronMask(1)], files = [];
    for (const set of sets) {
      for (const chans of (perChannel ? [[0], [1]] : [[0, 1]])) {
        const idx = [], chs = [];
        for (let i = i0; i < i1; i++) for (const ch of chans) if (set.masks[ch][i]) { idx.push(i); chs.push(ch); }
        const m = idx.length;
        const Channel = new Uint16Array(m), Timestamp = new BigUint64Array(m), Board = new Uint16Array(m), Energy = new Uint16Array(m), EnergyShort = new Uint16Array(m), Flags = new Uint32Array(m);
        for (let k = 0; k < m; k++) {
          const i = idx[k], ch = chs[k], r = L.results[ch];
          Channel[k] = ch; Board[k] = f.det[i];
          const t0 = cfd && Number.isFinite(r.t0[i]) ? r.t0[i] : TRIGGER_SAMPLE;
          Timestamp[k] = BigInt(Math.round(Number(f.ts[i] - ts0) * tickPs + t0 * sampPs));
          Energy[k] = clampU16(Math.round(r.qlong[i] / scale)); EnergyShort[k] = clampU16(Math.round(r.qshort[i] / scale));
          let fl = 0; if (r.pileup[i]) fl |= 1; if (r.saturated[i]) fl |= 2; if (!r.valid[i]) fl |= 4; if (f.gap[i]) fl |= 8; if (cm && !cm[i]) fl |= 16; if (nmk[ch][i]) fl |= 64;
          Flags[k] = fl;
        }
        const branches = [{ name: 'Channel', kind: 'u16', data: Channel }, { name: 'Timestamp', kind: 'u64', data: Timestamp }, { name: 'Board', kind: 'u16', data: Board }, { name: 'Energy', kind: 'u16', data: Energy }, { name: 'EnergyShort', kind: 'u16', data: EnergyShort }, { name: 'Flags', kind: 'u32', data: Flags }];
        if (wave) { const S = new Int16Array(m * NS); for (let k = 0; k < m; k++) { const raw = chs[k] === 0 ? f.ch0 : f.ch1, row = idx[k] * NS, q = k * NS; for (let j = 0; j < NS; j++) S[q + j] = code(raw[row + j]); } branches.push({ name: 'Samples', kind: 'TArrayS', data: S, len: NS }); }
        const name = perChannel ? `Data${set.tag}_CH${chans[0]}@NOVO_${det}_${run}.root` : `Data${set.tag}_NOVO_${det}_${run}.root`;
        const parts = RootWriter.write({ fileName: name, tree: { name: set.tree, title: set.title }, branches });
        files.push({ name, folder: set.folder, tree: set.tree, entries: m, bytes: RootWriter.size(parts), parts });
      }
    }
    const tw = timewinStats(), pol = { 0: L.results[0].polarity, 1: L.results[1].polarity };
    const settings = {
      format: 'CoMPASS-style ROOT list mode (TTree Data_R / Data_F)', generator: 'NOVO-BE', created: new Date().toISOString(), run: L.name, meta: L.meta,
      files: files.map(x => ({ folder: x.folder, name: x.name, tree: x.tree, entries: x.entries, bytes: x.bytes })),
      frames: { total: f.n, written_range: [i0, i1], written: i1 - i0, time_window_s: L.twin.enabled ? [L.twin.t0_s ?? 0, L.twin.t1_s ?? tw.run_duration_s] : null, run_duration_s: tw.run_duration_s, lost_frames: headerIssues(f).lost_frames },
      channels: { 0: 'SiPM at end 0 of the scintillator bar', 1: 'SiPM at end 1 of the same bar', note: 'every frame is one trigger read out on both ends; Channel tells which end' },
      timestamp: { unit: 'ps', zero: 'first sample of the first frame of the run', timestamp_tick_ps: tickPs, sample_ps: sampPs, trigger_sample: TRIGGER_SAMPLE, cfd_fine_time: cfd, note: cfd ? 'frame time + CFD crossing time of the pulse (per channel); frames without a pulse use the trigger sample' : 'frame time + trigger sample' },
      energy: { Energy: 'Q_long / divisor', EnergyShort: 'Q_short / divisor', divisor: scale, q_unit: 'sum of baseline-subtracted 14-bit ADC codes over the gate (code·sample)', q_long_max: qmax, psd: '(Energy - EnergyShort) / Energy' },
      pulse: { polarity: pol, baseline_samples: p.baseline_samples, threshold_codes: p.threshold, cfd_fraction: p.cfd_fraction, pre_gate_samples: p.pre_gate, short_gate_samples: p.short_gate, long_gate_samples: p.long_gate, short_gate_ns: p.short_gate * p.sample_ns, long_gate_ns: p.long_gate * p.sample_ns, pre_gate_ns: p.pre_gate * p.sample_ns, gate_start: 'floor(t0) + 1 - pre_gate' },
      classifier: { mode: L.classifier.mode, psd_cut: p.psd_cut },
      filters_for_Data_F: { valid_pulse: true, exclude_pileup: L.excludePileup, coincidence: { ...L.coinc }, time_window: { ...L.twin } },
      flags: Object.fromEntries(Object.entries(FLAG_BITS).map(([k, v]) => ['0x' + (+k).toString(16), v])),
      samples: wave ? { branch: 'Samples', type: 'TArrayS', length: NS, unit: 'signed 14-bit ADC code', sample_ps: sampPs } : null,
    };
    const started = L.meta && L.meta.started_unix ? new Date(L.meta.started_unix * 1000) : null;
    const runInfo = [`id=${L.name}`, 'format=CoMPASS-style ROOT (NOVO-BE)', `time.start=${started ? started.toISOString() : ''}`, `time.stop=${L.meta && L.meta.stopped_unix ? new Date(L.meta.stopped_unix * 1000).toISOString() : ''}`, `time.real=${tw.run_duration_s.toFixed(3)}`, `time.window=${settings.frames.time_window_s ? settings.frames.time_window_s.join('-') : 'all'}`,
      'board.0.name=NOVO', `board.0.id=${det}`, `board.0.sampling_rate_MSps=${(1000 / p.sample_ns).toFixed(1)}`, 'board.0.adc_bits=14', 'board.0.channels=2', `frames.total=${f.n}`, `frames.written=${i1 - i0}`, `energy.divisor=${scale}`,
      ...files.map(x => `file.${x.folder}.${x.name}.entries=${x.entries}`)].join('\n') + '\n';
    return { files, settings, run_info: runInfo, energy_scale: scale, q_long_max: qmax };
  }

  // ---------------------------------------------------------------- loading files from the browser
  const BIN_RE = /^(.+?)_dma(\d+)\.bin$/i;
  async function addFiles(files) {
    const bins = files.filter(f => /\.bin$/i.test(f.name)), metas = files.filter(f => /\.json$/i.test(f.name));
    if (!bins.length) throw new Error('At least one .bin file is required');
    const prefixes = new Set(bins.map(f => (BIN_RE.exec(f.name) || [])[1]).filter(Boolean));
    let name = prefixes.size === 1 ? [...prefixes][0] : bins[0].name.replace(/\.bin$/i, '');
    let k = 1; const base = name; while (L.runs.has(name)) name = `${base} (${++k})`;
    const parts = [];
    for (let i = 0; i < bins.length; i++) parts.push(readBin(await bins[i].arrayBuffer(), bins[i].name, i));
    let meta = null; if (metas.length) { try { meta = JSON.parse(await metas[0].text()); } catch (_) { meta = null; } }
    L.runs.set(name, { frames: merge(parts), meta, bytes: parts.reduce((a, p) => a + p.bytes, 0) });
    return { run: name, files: files.map(f => f.name) };
  }
  function open(name) { const r = L.runs.get(name); if (!r) throw new Error('run not found: ' + name); L.frames = r.frames; L.meta = r.meta; L.name = name; L.twin = { enabled: false, t0_s: null, t1_s: null }; L.results = {}; L.processed = false; L.dirty = false; L.procRange = null; L.processMs = 0; return summary(); }

  // ================================================================ router
  const num = (q, k, d) => (q.has(k) && q.get(k) !== '' ? parseFloat(q.get(k)) : d);
  return async function localApi(path, body) {
    const u = new URL(path, 'http://local'); const q = u.searchParams; const P = u.pathname;
    try {
      if (P === '/api/runs') return { open: L.name, runs: [...L.runs.entries()].map(([name, r]) => ({ name, frames: r.frames.n, bytes: r.bytes, bins: r.frames.files, meta: r.meta })) };
      if (P === '/api/open') return open(body.name);
      if (P === '/api/process') { need(); return process(); }
      if (P === '/api/close') { if (L.name) L.runs.delete(L.name); L.frames = null; L.results = {}; L.name = null; L.meta = null; L.processed = false; return { open: null }; }
      if (P === '/api/summary') { need(); return summary(); }
      if (P === '/api/params') { if (body !== undefined) { const cur = { ...L.params }; for (const [k, v] of Object.entries(body)) if (k in cur) cur[k] = typeof cur[k] === 'string' ? String(v) : +v; const old = L.params; L.params = validated(cur); const skip = ['psd_cut', 'sample_ns', 'ts_ns']; const changed = Object.keys(L.params).some(k => !skip.includes(k) && old[k] !== L.params[k]); if (L.frames && changed && L.processed) L.dirty = true; } return { ...L.params }; }
      if (P === '/api/hist/psd2d') { needProc(); return psd2d(num(q, 'ch', 0), num(q, 'ne', 200), num(q, 'npsd', 160), num(q, 'elo', null), num(q, 'ehi', null), num(q, 'plo', null), num(q, 'phi', null)); }
      if (P === '/api/hist/psd1d') { needProc(); return psd1d(num(q, 'ch', 0), num(q, 'elo', 0), num(q, 'ehi', 1e12), num(q, 'nbins', 160), num(q, 'plo', null), num(q, 'phi', null)); }
      if (P === '/api/classifier') { const b = body || {}; if (['cut', 'gamma_only', 'neutron_only'].includes(b.mode)) L.classifier.mode = b.mode; return { ...L.classifier }; }
      if (P === '/api/hist/time') { need(); return timeHists(num(q, 'ch', 0)); }
      if (P.startsWith('/api/waveform/')) { need(); return waveform(parseInt(P.slice('/api/waveform/'.length), 10)); }
      if (P === '/api/next_valid') { need(); return { i: nextValid(num(q, 'i', 0), num(q, 'ch', 0), num(q, 'step', 1)) }; }
      if (P === '/api/pileup') { need(); L.excludePileup = !!(body && body.exclude); return pileupStats(); }
      if (P === '/api/timewin') { const b = body || {}; if ('enabled' in b) L.twin.enabled = !!b.enabled; for (const k of ['t0_s', 't1_s']) if (k in b) L.twin[k] = (b[k] === null || b[k] === '') ? null : +b[k]; if (L.twin.t0_s != null && L.twin.t1_s != null && L.twin.t1_s < L.twin.t0_s) [L.twin.t0_s, L.twin.t1_s] = [L.twin.t1_s, L.twin.t0_s]; if (L.frames && L.frames.n > 1) { const t = tsNs(), full = t[t.length - 1] / 1e9; if ((L.twin.t0_s == null || L.twin.t0_s <= 0) && (L.twin.t1_s == null || L.twin.t1_s >= full - 1e-6)) L.twin = { enabled: false, t0_s: null, t1_s: null }; } if (L.processed && L.procRange) { const [a, b2] = windowRange(); if (b2 > a && (a < L.procRange[0] || b2 > L.procRange[1])) L.dirty = true; } return { ...L.twin }; }
      if (P === '/api/coinc') { const b = body || {}; if ('enabled' in b) L.coinc.enabled = !!b.enabled; if (b.window_ns != null && Number.isFinite(+b.window_ns)) L.coinc.window_ns = Math.max(0, +b.window_ns); if (b.center_ns != null && Number.isFinite(+b.center_ns)) L.coinc.center_ns = +b.center_ns; return { ...L.coinc }; }
      if (P === '/api/export/compass') return exportCompass(body);
      if (P === '/api/upload') { const r = await addFiles(body.files); r.summary = open(r.run); return r; }
      throw new Error('unknown route: ' + P);
    } catch (e) { throw new Error(e.message || String(e)); }
  };
})();
