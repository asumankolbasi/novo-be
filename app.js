'use strict';
/* NOVO-BE — page logic. Opens raw DMA frames, lets the user pick a time window, set the
 * gates and the n/γ cut, and writes CoMPASS-style ROOT files. All work is done in the browser by
 * pipeline.js (decoding, pulse processing, histograms) and rootwriter.js (ROOT files). */

const $ = id => document.getElementById(id);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (v, d = 1) => (v == null || Number.isNaN(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const num = v => Number(v).toLocaleString('en-US');
const api = (path, body) => localApi(path, body);
const S = { summary: null, params: null, cur: 0, playing: null, tab: 'data', pending: null, waveRoles: [], lastFit: null, exported: null };
const NS = 1012;

let toastT = null;
function toast(msg, ms = 2800) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }
const hasRun = () => !!S.summary;

// ------------------------------------------------------------------ plotly helpers
const PCFG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'] };
function layout(extra) {
  const ax = () => ({ gridcolor: css('--grid'), zerolinecolor: css('--grid'), linecolor: css('--border'), tickfont: { family: css('--font-mono'), size: 11 } });
  const base = { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: css('--surface'), font: { family: css('--font-ui'), color: css('--fg'), size: 12 }, margin: { l: 60, r: 16, t: 30, b: 46 }, xaxis: ax(), yaxis: ax(), legend: { orientation: 'h', x: 0, y: 1.06, font: { size: 11 } }, hoverlabel: { font: { family: css('--font-mono'), size: 11 } } };
  const out = Object.assign(base, extra || {});
  for (const k of Object.keys(out)) if (/^[xy]axis\d*$/.test(k) && k !== 'xaxis' && k !== 'yaxis') out[k] = Object.assign(ax(), out[k]);
  if (extra && extra.xaxis) out.xaxis = Object.assign(ax(), extra.xaxis);
  if (extra && extra.yaxis) out.yaxis = Object.assign(ax(), extra.yaxis);
  return out;
}
const chColor = ch => css(ch === 0 ? '--ch0' : '--ch1');
const stepXY = (edges, counts) => ({ x: edges.slice(0, -1), y: counts });

// ------------------------------------------------------------------ files / runs
async function uploadFiles(fileList) {
  const files = [...fileList].filter(f => /\.(bin|json)$/i.test(f.name));
  if (!files.length) { toast('Select .bin or .json files'); return; }
  if (!files.some(f => /\.bin$/i.test(f.name))) { toast('At least one .bin file is required'); return; }
  const total = files.reduce((a, f) => a + f.size, 0), st = $('upStatus'), t0 = performance.now();
  st.textContent = `reading… ${(total / 1048576).toFixed(1)} MB`;
  try {
    const r = await api('/api/upload', { files });
    S.summary = r.summary; S.cur = 0; S.exported = null;
    await loadRuns(); afterSummary(); setTab('time');
    st.textContent = '';
    toast(`Opened: ${num(S.summary.frames)} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s · select the time window and press "Process window"`, 6000);
  } catch (e) { st.textContent = ''; toast('Loading failed: ' + e.message, 6000); }
}
async function loadRuns() {
  const r = await api('/api/runs'), sel = $('runSelect'); sel.innerHTML = '';
  $('runBar').hidden = r.runs.length < 2;
  for (const run of r.runs) { const o = document.createElement('option'); o.value = run.name; o.textContent = `${run.name}  (${num(run.frames)} frames, ${(run.bytes / 1048576).toFixed(1)} MB)`; if (S.summary && run.name === S.summary.name) o.selected = true; sel.appendChild(o); }
}
async function openRun() {
  const name = $('runSelect').value; if (!name) return;
  try { S.summary = await api('/api/open', { name }); } catch (e) { toast('Could not open: ' + e.message); return; }
  S.cur = 0; S.exported = null; afterSummary(); setTab('time');
}
async function closeRun() {
  if (!hasRun()) return;
  if (S.playing) togglePlay();
  await api('/api/close', {});
  S.summary = null; S.params = null; S.cur = 0; S.pending = null; S.lastFit = null; S.exported = null;
  for (const id of ['wavePlot', 'psd2dPlot', 'psd1dPlot', 'ratePlot', 'dtPlot']) { try { Plotly.purge(id); } catch (_) { /* not drawn */ } }
  for (const id of ['pFit', 'pCounts', 'dInfo']) $(id).innerHTML = '';
  $('wRes').tBodies[0].innerHTML = ''; $('xFiles').tBodies[0].innerHTML = ''; $('xFilesWrap').hidden = true; $('xOut').textContent = '';
  for (const id of ['xZip', 'xSettings', 'xInfo']) $(id).hidden = true;
  $('wSlider').max = 0; $('wSlider').value = 0; $('wNo').value = 0; $('wCount').textContent = '/ 0';
  renderChips(); $('btnClose').hidden = true; $('btnProcess').hidden = true;
  await loadRuns(); setTab('data'); toast('Closed');
}
async function processRun() {
  if (!hasRun()) return;
  if (S.processing) { toast('Processing is running'); return; }
  S.processing = true; $('btnProcess').disabled = true; $('tProcess').disabled = true;
  const st = $('upStatus'), t0 = performance.now(); st.textContent = 'processing…';
  await new Promise(r => setTimeout(r, 30));                       // let the status paint before the long synchronous job
  try { S.summary = await api('/api/process', {}); }
  catch (e) { toast('Processing failed: ' + e.message, 6000); st.textContent = ''; return; }
  finally { S.processing = false; $('btnProcess').disabled = false; $('tProcess').disabled = false; }
  S.pending = null; S.exported = null; afterSummary(); st.textContent = '';
  const pr = S.summary.proc_range;
  toast(`Processed ${num(pr ? pr.frames : S.summary.frames)} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
const processState = () => { const s = S.summary; return !s ? '' : !s.processed ? 'unprocessed' : s.dirty ? 'dirty' : 'ok'; };
function afterSummary() {
  const s = S.summary; S.params = s.params;
  renderChips(); fillParamForm(); renderInfo(); $('btnClose').hidden = false;
  const ps = processState(); $('btnProcess').hidden = false; $('btnProcess').textContent = ps === 'dirty' ? 'Process again' : 'Process'; $('btnProcess').classList.toggle('primary', ps !== 'ok');
  $('wSlider').max = s.frames - 1; $('wNo').max = s.frames - 1; $('wCount').textContent = '/ ' + (s.frames - 1);
  $('pCut').value = S.params.psd_cut;
  renderSteps(); refreshTab(S.tab);
}
function renderSteps() {
  const s = S.summary, order = ['data', 'time', 'wave', 'psd', 'save'];
  document.querySelectorAll('.step').forEach(el => {
    const k = el.dataset.tab, i = order.indexOf(k);
    el.classList.toggle('active', k === S.tab);
    el.classList.toggle('done', !!s && (i === 0 || (s.processed && !s.dirty && i <= 3) || (i === 4 && !!S.exported)));
  });
}
function renderChips() {
  const s = S.summary, c = $('chips'); c.innerHTML = '';
  if (!s) return;
  const chip = (txt, cls = '') => { const d = document.createElement('span'); d.className = 'chip ' + cls; d.textContent = txt; c.appendChild(d); };
  chip(`${num(s.frames)} frames`); chip(`${fmt(s.duration_s, 2)} s`);
  if (!s.processed) chip('not processed · pick the window on the Time tab and press "Process window"', 'warn');
  else if (s.dirty) chip('gates or window changed · process again', 'warn');
  if (s.processed && s.proc_range && s.proc_range.frames < s.frames) chip(`processed: ${num(s.proc_range.frames)} frames`);
  for (const ch of [0, 1]) { const x = s.channels[ch]; if (!x) continue; chip(`CH${ch} ${num(x.valid)} pulses · n ${num(x.neutrons)} / γ ${num(x.gammas)}`, 'ch' + ch); }
  if (s.timewin && s.timewin.enabled) chip(`window ${(s.timewin.t0_s ?? 0).toFixed(1)}–${(s.timewin.t1_s ?? s.timewin.run_duration_s).toFixed(1)} s`);
  if (s.header.lost_frames) chip(`${s.header.lost_frames} lost frames`, 'warn');
}
function renderInfo() {
  const s = S.summary; if (!s) { $('dInfo').innerHTML = ''; return; }
  const rows = [['Run', s.name], ['Files', s.files.join(', ')], ['Frames', num(s.frames)], ['Duration', fmt(s.duration_s, 3) + ' s'], ['Frame rate', fmt(s.frame_rate, 0) + ' frames/s'],
    ['Header', `lost frames ${s.header.lost_frames}, bad headers ${s.header.bad_magic}`], ['Data', `${(s.bytes / 1048576).toFixed(1)} MB · 14-bit ADC, 1.3 GS/s, 1012 samples per frame`]];
  if (s.meta) rows.push(['meta.json', `${s.meta.name || ''} · ${s.meta.started_unix ? new Date(s.meta.started_unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : ''} · ${s.meta.duration_s ? fmt(s.meta.duration_s, 2) + ' s' : ''}`]);
  $('dInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
function bindDrop() {
  let depth = 0; const veil = $('dropveil');
  document.addEventListener('dragenter', ev => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { depth++; veil.hidden = false; } });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
  document.addEventListener('dragover', ev => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); });
  document.addEventListener('drop', ev => { depth = 0; veil.hidden = true; if (ev.dataTransfer && ev.dataTransfer.files.length) { ev.preventDefault(); uploadFiles(ev.dataTransfer.files); } });
}

// ------------------------------------------------------------------ tabs
function setTab(name) {
  S.tab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  renderSteps(); refreshTab(name);
}
function refreshTab(name) {
  if (!hasRun()) { if (name !== 'data') toast('Load a run first'); return; }
  if (!S.summary.processed && (name === 'psd' || name === 'save')) { toast('Run not processed yet: pick the window on the Time tab and press "Process window"', 5000); return; }
  ({ data: renderInfo, time: refreshTime, wave: refreshWave, psd: refreshPsd, save: refreshSave })[name]();
}

// ------------------------------------------------------------------ time tab
async function refreshTime() {
  const ch = +$('tCh').value, t = await api(`/api/hist/time?ch=${ch}`), tw = t.timewin || {};
  $('tWin0').value = tw.t0_s == null ? 0 : tw.t0_s; $('tWin1').value = tw.t1_s == null ? Math.ceil((tw.run_duration_s || 0) * 100) / 100 : tw.t1_s;
  $('tWinInfo').textContent = tw.enabled ? `window: ${(tw.t0_s ?? 0).toFixed(1)}–${(tw.t1_s ?? tw.run_duration_s).toFixed(1)} s · ${num(tw.frames_inside)} / ${num(tw.frames_total)} frames` : `whole run selected (0–${(tw.run_duration_s || 0).toFixed(1)} s, ${num(tw.frames_total)} frames)`;
  const shapes = tw.enabled ? [{ type: 'rect', xref: 'x', yref: 'paper', x0: tw.t0_s ?? 0, x1: tw.t1_s ?? tw.run_duration_s, y0: 0, y1: 1, fillcolor: css('--accent'), opacity: 0.12, line: { width: 0 } }] : [];
  await Plotly.react('ratePlot', [
    { x: t.frame_rate.t, y: t.frame_rate.cps, type: 'scatter', mode: 'lines', line: { color: css('--muted'), width: 1, shape: 'hv' }, name: 'triggers (frames/s, whole run)' },
    { x: t.rate.t, y: t.rate.cps, type: 'scatter', mode: 'lines', line: { color: chColor(ch), width: 1.5, shape: 'hv' }, name: `CH${ch} valid pulses (cps)` },
  ], layout({ title: { text: 'Count rate · drag to select the time window', font: { size: 13 }, x: 0, xanchor: 'left' }, xaxis: { title: { text: 'time (s)' } }, yaxis: { title: { text: 'cps' }, rangemode: 'tozero' }, shapes, dragmode: 'select', selectdirection: 'h', margin: { l: 60, r: 16, t: 34, b: 46 } }), PCFG);
  const rp = $('ratePlot');
  if (!rp._selBound) { rp._selBound = true; rp.on('plotly_selected', ev => { if (ev && ev.range && ev.range.x) { const [a, b] = ev.range.x; $('tWin0').value = Math.max(0, a).toFixed(2); $('tWin1').value = b.toFixed(2); applyTimeWin(true); } }); }
  const d = t.dt;
  Plotly.react('dtPlot', d.edges.length ? [{ ...stepXY(d.edges, d.counts), type: 'scatter', mode: 'lines', line: { shape: 'hv', color: chColor(ch), width: 1.4 }, name: 'Δt' }] : [],
    layout({ title: { text: 'Interval between consecutive pulses', font: { size: 13 }, x: 0, xanchor: 'left' }, xaxis: { title: { text: 'Δt (ns)' }, type: 'log' }, yaxis: { title: { text: 'counts' } }, showlegend: false, margin: { l: 60, r: 16, t: 34, b: 46 } }), PCFG);
}
async function applyTimeWin(enabled) {
  const t0 = parseFloat($('tWin0').value), t1 = parseFloat($('tWin1').value);
  const body = { enabled: enabled && !(Number.isNaN(t0) && Number.isNaN(t1)), t0_s: Number.isNaN(t0) ? null : t0, t1_s: Number.isNaN(t1) ? null : t1 };
  await api('/api/timewin', body);
  S.summary = await api('/api/summary'); afterSummary();
  toast(body.enabled ? `Time window: ${body.t0_s ?? 0}–${body.t1_s ?? 'end'} s` : 'Time window off');
}

// ------------------------------------------------------------------ waveform tab
async function refreshWave() {
  const w = await api('/api/waveform/' + S.cur); S.lastWave = w;
  $('wSlider').value = w.i; $('wNo').value = w.i;
  const ns = $('wNs').checked, dx = ns ? S.params.sample_ns : 1, P = S.pending || S.params;
  const x = Array.from({ length: w.channels[0].samples.length }, (_, i) => i * dx), traces = [], ann = [];
  const { shapes, roles } = buildWaveShapes(w, P, dx);
  for (const ch of [0, 1]) {
    const c = w.channels[ch], ya = ch === 0 ? 'y' : 'y2', xa = ch === 0 ? 'x' : 'x2';
    traces.push({ x, y: c.samples, type: 'scatter', mode: 'lines', name: 'CH' + ch, line: { color: chColor(ch), width: 1.3 }, xaxis: xa, yaxis: ya, hovertemplate: 'sample %{x}<br>%{y} codes<extra>CH' + ch + '</extra>' });
    ann.push({ xref: xa + ' domain', yref: ya + ' domain', x: 1, y: 1, xanchor: 'right', yanchor: 'top', showarrow: false, align: 'right', font: { family: css('--font-mono'), size: 11, color: css('--fg') }, bgcolor: css('--surface'), opacity: 0.9,
      text: `CH${ch} · ${c.valid ? 'valid' : 'no pulse'}${c.pileup ? ' · pile-up' : ''}${c.saturated ? ' · saturated' : ''}<br>amplitude ${fmt(c.amp, 0)} · Q<sub>long</sub> ${fmt(c.qlong, 0)} · PSD ${c.psd == null ? '—' : c.psd.toFixed(3)}` });
  }
  const lay = layout({ xaxis: { domain: [0, 1], anchor: 'y', showticklabels: false }, yaxis: { domain: [0.54, 1], title: { text: 'CH0 (codes)' } }, xaxis2: { domain: [0, 1], anchor: 'y2', matches: 'x', title: { text: ns ? 'time (ns)' : 'sample' } }, yaxis2: { domain: [0, 0.46], title: { text: 'CH1 (codes)' } }, shapes, annotations: ann, showlegend: false, margin: { l: 60, r: 16, t: 10, b: 46 }, hovermode: 'x' });
  S.waveRoles = roles; S.waveDx = dx;
  await Plotly.react('wavePlot', traces, lay, { ...PCFG, edits: { shapePosition: true } });
  const wp = $('wavePlot'); if (!wp._relayoutBound) { wp._relayoutBound = true; wp.on('plotly_relayout', onWaveRelayout); }
  renderPending();
  $('wRes').tBodies[0].innerHTML = [0, 1].map(ch => {
    const c = w.channels[ch];
    const flags = [c.valid ? '<span class="flag ok">valid</span>' : '<span class="flag">none</span>', c.pileup ? '<span class="flag warn">pile-up</span>' : '', c.saturated ? '<span class="flag bad">saturated</span>' : '', c.valid && c.psd != null && S.summary.processed ? ((c.neutron != null ? c.neutron : c.psd > S.params.psd_cut) ? '<span class="flag n">n</span>' : '<span class="flag g">γ</span>') : ''].join(' ');
    return `<tr><td>CH${ch} <span class="muted small">#${w.i} · ${fmt(w.t_us / 1000, 3)} ms${w.gap ? ' · ' + w.gap + ' lost' : ''}</span></td><td>${fmt(c.baseline, 1)}</td><td>${fmt(c.noise, 2)}</td><td>${fmt(c.amp, 1)}</td><td>${c.t0 == null ? '—' : fmt(c.t0, 2)}</td><td>${fmt(c.qshort, 0)}</td><td>${fmt(c.qlong, 0)}</td><td>${c.psd == null ? '—' : c.psd.toFixed(3)}</td><td>${flags}</td></tr>`;
  }).join('');
}
function buildWaveShapes(w, P, dx) {
  const shapes = [], roles = [], n = w.channels[0].samples.length, xEnd = (n - 1) * dx;
  for (const ch of [0, 1]) {
    const c = w.channels[ch], ya = ch === 0 ? 'y' : 'y2', xa = ch === 0 ? 'x' : 'x2';
    shapes.push({ type: 'line', xref: xa, yref: ya, x0: 0, x1: xEnd, y0: c.baseline, y1: c.baseline, line: { color: css('--muted'), width: 1, dash: 'dot' } }); roles.push(null);
    if (!$('wGates').checked) continue;
    const sign = c.polarity === 'neg' ? -1 : 1, yThr = c.baseline + sign * P.threshold;
    shapes.push({ type: 'line', xref: xa, yref: ya, x0: 0, x1: xEnd, y0: yThr, y1: yThr, line: { color: css('--thr'), width: 1.2, dash: 'dash' }, editable: true }); roles.push({ role: 'thr', ch, baseline: c.baseline, sign });
    if (c.t0 == null) continue;
    const g0 = Math.min(NS, Math.max(0, Math.floor(c.t0) + 1 - P.pre_gate)), gs = Math.min(g0 + P.short_gate, NS), gl = Math.min(g0 + P.long_gate, NS);
    shapes.push({ type: 'rect', xref: xa, yref: ya + ' domain', x0: g0 * dx, x1: gl * dx, y0: 0, y1: 1, fillcolor: chColor(ch), opacity: 0.08, line: { width: 0 }, editable: true }); roles.push({ role: 'long', ch, t0: c.t0 });
    shapes.push({ type: 'rect', xref: xa, yref: ya + ' domain', x0: g0 * dx, x1: gs * dx, y0: 0, y1: 1, fillcolor: chColor(ch), opacity: 0.18, line: { width: 0 }, editable: true }); roles.push({ role: 'short', ch, t0: c.t0 });
    shapes.push({ type: 'line', xref: xa, yref: ya + ' domain', x0: c.t0 * dx, x1: c.t0 * dx, y0: 0, y1: 1, line: { color: css('--thr'), width: 1, dash: 'dash' } }); roles.push(null);
  }
  return { shapes, roles };
}
function onWaveRelayout(ev) {
  const touched = {};
  for (const [k, v] of Object.entries(ev || {})) { const m = /^shapes\[(\d+)\]\.(x0|x1|y0|y1)$/.exec(k); if (m) (touched[+m[1]] = touched[+m[1]] || {})[m[2]] = v; }
  const idxs = Object.keys(touched); if (!idxs.length) return;
  const P = { ...(S.pending || S.params) }, dx = S.waveDx || 1, wp = $('wavePlot');
  for (const i of idxs) {
    const role = S.waveRoles[i]; if (!role) continue;
    const sh = (wp.layout.shapes || [])[i] || {}, g = { ...sh, ...touched[i] };
    if (role.role === 'thr') P.threshold = Math.max(0, Math.round(role.sign * ((Number(g.y0) + Number(g.y1)) / 2 - role.baseline)));
    else {
      const x0 = Number(g.x0) / dx, x1 = Number(g.x1) / dx, g0 = Math.round(Math.min(x0, x1)), g1 = Math.round(Math.max(x0, x1));
      if (touched[i].x0 !== undefined) P.pre_gate = Math.min(100, Math.max(0, Math.floor(role.t0) + 1 - g0));
      const len = Math.max(1, g1 - (Math.floor(role.t0) + 1 - P.pre_gate));
      if (role.role === 'short') P.short_gate = Math.min(len, NS); else P.long_gate = Math.min(len, NS);
    }
  }
  if (P.long_gate < P.short_gate) { if (idxs.some(i => (S.waveRoles[i] || {}).role === 'short')) P.long_gate = P.short_gate; else P.short_gate = P.long_gate; }
  S.pending = P;
  if (S.lastWave) { const { shapes, roles } = buildWaveShapes(S.lastWave, P, dx); S.waveRoles = roles; Plotly.relayout(wp, { shapes }); renderPending(); } else refreshWave();
}
function renderPending() {
  const bar = $('wPending'); if (!S.pending || !S.params) { bar.hidden = true; return; }
  const diffs = [];
  for (const [k, lab] of [['pre_gate', 'pre-gate'], ['short_gate', 'short gate'], ['long_gate', 'long gate'], ['threshold', 'threshold']]) if (S.pending[k] !== S.params[k]) diffs.push(`${lab} ${S.params[k]} → ${S.pending[k]}`);
  if (!diffs.length) { S.pending = null; bar.hidden = true; return; }
  const ns = S.params.sample_ns;
  $('wPendingText').textContent = diffs.join(' · ') + `  (short ${(S.pending.short_gate * ns).toFixed(0)} ns, long ${(S.pending.long_gate * ns).toFixed(0)} ns)`;
  bar.hidden = false;
}
async function applyPending() {
  if (!S.pending) return;
  $('wApply').disabled = true; $('wPendingText').textContent = 'processing…';
  try { S.params = await api('/api/params', { pre_gate: S.pending.pre_gate, short_gate: S.pending.short_gate, long_gate: S.pending.long_gate, threshold: S.pending.threshold }); S.pending = null; fillParamForm(); await processRun(); }
  catch (e) { toast('Could not apply: ' + e.message, 5000); }
  finally { $('wApply').disabled = false; refreshWave(); }
}
function goTo(i) { if (!hasRun()) return; S.cur = Math.max(0, Math.min(S.summary.frames - 1, i | 0)); refreshWave(); }
async function goValid(step) { if (!hasRun()) return; const r = await api(`/api/next_valid?i=${S.cur}&ch=${$('wValidCh').value}&step=${step}`); if (r.i === S.cur) toast(step > 0 ? 'No valid pulse after this frame' : 'No valid pulse before this frame'); else goTo(r.i); }
function togglePlay() {
  if (S.playing) { clearInterval(S.playing); S.playing = null; $('wPlay').textContent = 'Play'; return; }
  if (!hasRun()) return; $('wPlay').textContent = 'Stop';
  S.playing = setInterval(() => { if (S.cur >= S.summary.frames - 1) togglePlay(); else goTo(S.cur + 1); }, 120);
}
function fillParamForm() { if (!S.params) return; const f = $('paramForm'); for (const [k, v] of Object.entries(S.params)) { const el = f.elements[k]; if (el) el.value = v; } }
async function submitParams(ev) {
  ev.preventDefault();
  const body = {}; for (const el of $('paramForm').elements) if (el.name) body[el.name] = el.type === 'number' ? parseFloat(el.value) : el.value;
  $('sOut').textContent = 'processing…';
  try { S.params = await api('/api/params', body); S.pending = null; await processRun(); fillParamForm(); $('sOut').textContent = S.summary.processed ? `processed in ${S.summary.process_ms.toFixed(0)} ms` : ''; refreshWave(); }
  catch (e) { $('sOut').textContent = 'error: ' + e.message; }
}

// ------------------------------------------------------------------ PSD tab
function psdRange() { const lo = parseFloat($('pPlo').value), hi = parseFloat($('pPhi').value); return [Number.isNaN(lo) ? null : lo, Number.isNaN(hi) ? null : hi]; }
async function refreshPsd() {
  const ch = +$('pCh').value, [plo, phi] = psdRange(), elo = parseFloat($('pElo').value), ehi = parseFloat($('pEhi').value);
  const pq = (plo == null ? '' : `&plo=${plo}`) + (phi == null ? '' : `&phi=${phi}`);
  const h2 = await api(`/api/hist/psd2d?ch=${ch}${pq}`);
  const zlog = $('pLogZ').checked, z = h2.z.map(row => row.map(v => v > 0 ? (zlog ? Math.log10(v + 1) : v) : null));
  const cut = S.params.psd_cut, xr = [h2.x[0], h2.x[h2.x.length - 1]], yr = [h2.y[0], h2.y[h2.y.length - 1]];
  const winLo = Number.isNaN(elo) ? xr[0] : elo, winHi = Number.isNaN(ehi) ? xr[1] : ehi;
  const cls = (S.summary && S.summary.classifier) || { mode: 'cut' }, single = ['gamma_only', 'neutron_only'].includes(cls.mode) ? cls.mode : null;
  $('pSrc').value = single || 'mixed';
  for (const id of ['pCut', 'pCutApply', 'pCutFromFit']) $(id).disabled = !!single;
  const shapes = [{ type: 'line', xref: 'x', yref: 'y', x0: xr[0], x1: xr[1], y0: cut, y1: cut, line: { color: css('--thr'), width: 1.5, dash: 'dash' }, editable: !single, visible: !single }];
  const winTrace = (!Number.isNaN(elo) || !Number.isNaN(ehi)) ? [{ x: [Math.max(winLo, xr[0]), Math.min(winHi, xr[1]), Math.min(winHi, xr[1]), Math.max(winLo, xr[0]), Math.max(winLo, xr[0])], y: [yr[0], yr[0], yr[1], yr[1], yr[0]], type: 'scatter', mode: 'lines', fill: 'toself', fillcolor: 'rgba(128,128,128,0.18)', line: { color: css('--fg'), width: 1.2, dash: 'dot' }, hoverinfo: 'skip', showlegend: false, name: 'energy window' }] : [];
  await Plotly.react('psd2dPlot', [
    { type: 'heatmap', x: h2.x, y: h2.y, z, customdata: h2.z, colorscale: 'Viridis', showscale: true, hoverongaps: false, colorbar: { title: { text: zlog ? 'log₁₀(N+1)' : 'N' }, thickness: 12, len: 0.8 }, hovertemplate: 'energy %{x:.0f}<br>PSD %{y:.3f}<br>N %{customdata}<extra></extra>' },
    ...winTrace,
    { x: [xr[0], xr[1]], y: [yr[0], yr[1]], type: 'scatter', mode: 'markers', marker: { opacity: 0 }, hoverinfo: 'skip', showlegend: false, selected: { marker: { opacity: 0 } }, unselected: { marker: { opacity: 0 } } }],
  layout({ title: { text: `${ch === 2 ? 'Both ends' : 'CH' + ch} · PSD – energy (${num(h2.n)} pulses) · red line = cut · drag horizontally for the energy window`, font: { size: 13 }, x: 0, xanchor: 'left' }, xaxis: { title: { text: `energy (${ch === 2 ? '√(Q0·Q1)' : 'Q long'}, channels)` }, range: xr, fixedrange: true }, yaxis: { title: { text: 'PSD = (Q_long − Q_short) / Q_long' }, range: yr, fixedrange: true }, shapes, dragmode: 'select', selectdirection: 'h', margin: { l: 60, r: 16, t: 34, b: 46 } }), { ...PCFG, edits: { shapePosition: true } });
  bindCutDrag('psd2dPlot', 'y');
  const hp = $('psd2dPlot');
  if (!hp._selBound) { hp._selBound = true; hp.on('plotly_selected', ev => { if (ev && ev.range && ev.range.x) { const [a, b] = ev.range.x; $('pElo').value = Math.round(Math.max(0, a)); $('pEhi').value = Math.round(b); refreshPsd(); } }); hp.on('plotly_deselect', () => { if ($('pElo').value !== '' || $('pEhi').value !== '') { $('pElo').value = ''; $('pEhi').value = ''; refreshPsd(); } }); }
  const h1 = await api(`/api/hist/psd1d?ch=${ch}&plo=${yr[0]}&phi=${yr[1]}&elo=${winLo}&ehi=${winHi}`);
  const traces = [{ ...stepXY(h1.edges, h1.counts), type: 'scatter', mode: 'lines', line: { shape: 'hv', color: chColor(ch), width: 1.4 }, name: 'PSD', hovertemplate: '%{x:.3f}: %{y}<extra></extra>' }];
  const f = h1.fit, band = h1.band, g = (p, x) => p.amp * Math.exp(-0.5 * ((x - p.mu) / p.sigma) ** 2);
  if (band) traces.push({ x: band.centers, y: band.curve, type: 'scatter', mode: 'lines', line: { color: css('--fg'), width: 1 }, name: `single Gaussian μ ${band.mu.toFixed(4)} σ ${band.sigma.toFixed(4)}`, hoverinfo: 'skip' });
  if (f) { traces.push({ x: f.centers, y: f.centers.map(x => g(f.gamma, x)), type: 'scatter', mode: 'lines', line: { color: css('--gamma'), width: 1, dash: 'dot' }, name: 'γ fit', hoverinfo: 'skip' }, { x: f.centers, y: f.centers.map(x => g(f.neutron, x)), type: 'scatter', mode: 'lines', line: { color: css('--neutron'), width: 1, dash: 'dot' }, name: 'n fit', hoverinfo: 'skip' }, { x: f.centers, y: f.curve, type: 'scatter', mode: 'lines', line: { color: css('--fg'), width: 1 }, name: 'sum', hoverinfo: 'skip' }); }
  Plotly.react('psd1dPlot', traces, layout({ title: { text: `PSD projection · energy ${fmt(winLo, 0)}–${fmt(winHi, 0)}`, font: { size: 13 }, x: 0, xanchor: 'left' }, xaxis: { title: { text: 'PSD' }, range: [h1.edges[0], h1.edges[h1.edges.length - 1]] }, yaxis: { title: { text: 'counts' } }, shapes: single ? [] : [{ type: 'line', xref: 'x', yref: 'paper', x0: cut, x1: cut, y0: 0, y1: 1, line: { color: css('--thr'), width: 1.5, dash: 'dash' }, editable: true }], margin: { l: 60, r: 16, t: 34, b: 46 } }), { ...PCFG, edits: { shapePosition: true } });
  bindCutDrag('psd1dPlot', 'x');
  S.lastFit = f;
  $('pFit').innerHTML = single ? [['Source', single === 'gamma_only' ? 'gamma only: every event is γ' : 'neutron only: every event is n'], ['Band (single Gaussian)', band ? `μ ${band.mu.toFixed(4)} · σ ${band.sigma.toFixed(4)} · FWHM ${band.fwhm.toFixed(4)}` : 'fit failed']].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    : f ? [['FoM', f.fom.toFixed(3) + (f.fom >= 1 ? ' <span class="flag ok">good separation</span>' : f.fom >= 0.7 ? ' <span class="flag warn">fair</span>' : ' <span class="flag bad">poor</span>')], ['γ peak', `μ ${f.gamma.mu.toFixed(4)} · FWHM ${f.gamma.fwhm.toFixed(4)}`], ['n peak', `μ ${f.neutron.mu.toFixed(4)} · FWHM ${f.neutron.fwhm.toFixed(4)}`], ['Fit crossing', ((f.gamma.mu * f.neutron.sigma + f.neutron.mu * f.gamma.sigma) / (f.gamma.sigma + f.neutron.sigma)).toFixed(4)]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
      : '<dt>Fit</dt><dd>not possible (too few pulses or a single peak)</dd>';
  const tot = h1.neutrons + h1.gammas;
  $('pCounts').innerHTML = [['Pulses in window', num(tot)], ['Neutrons (' + (single ? 'source setting' : 'PSD > ' + cut) + ')', `${num(h1.neutrons)} (${tot ? (100 * h1.neutrons / tot).toFixed(1) : 0} %)`], ['Gammas', `${num(h1.gammas)} (${tot ? (100 * h1.gammas / tot).toFixed(1) : 0} %)`], ['n/γ ratio', h1.gammas ? (h1.neutrons / h1.gammas).toFixed(3) : '—']].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
function bindCutDrag(id, axis) {
  const el = $(id); if (el._cutBound) return; el._cutBound = true;
  el.on('plotly_relayout', ev => { const k0 = `shapes[0].${axis}0`, k1 = `shapes[0].${axis}1`; if (!(k0 in ev) && !(k1 in ev)) return; const sh = el.layout.shapes[0]; applyCut(+(((k0 in ev ? ev[k0] : sh[axis + '0']) + (k1 in ev ? ev[k1] : sh[axis + '1'])) / 2).toFixed(4)); });
}
async function applyCut(v) {
  if (Number.isNaN(v)) return;
  S.params = await api('/api/params', { psd_cut: v }); S.summary = await api('/api/summary'); S.exported = null; renderChips(); $('pCut').value = v; refreshPsd();
}

// ------------------------------------------------------------------ save tab
function fillFilters() {
  const s = S.summary; if (!s) return;
  $('fPileup').checked = !!(s.pileup_filter && s.pileup_filter.exclude);
  if (s.coinc) { $('fCoinc').checked = !!s.coinc.enabled; $('fWindow').value = s.coinc.window_ns; $('fOut').textContent = s.processed ? `both ends valid ${num(s.coinc.both_valid)} · inside window ${num(s.coinc.inside)} · CH0 only ${num(s.coinc.ch0_only)} · CH1 only ${num(s.coinc.ch1_only)}` : ''; }
}
async function applyFilters() {
  await api('/api/pileup', { exclude: $('fPileup').checked });
  await api('/api/coinc', { enabled: $('fCoinc').checked, window_ns: parseFloat($('fWindow').value) || 0 });
  S.summary = await api('/api/summary'); S.exported = null; renderChips(); fillFilters(); toast('Filters updated');
}
function refreshSave() { fillFilters(); renderFiles(); }
const human = b => b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
function download(name, parts, type = 'application/octet-stream') {
  const blob = parts instanceof Blob ? parts : new Blob(parts, { type }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function buildExport() {
  if (!hasRun() || !S.summary.processed) { toast('Process the run first'); return; }
  if (S.summary.dirty) { toast('Gates or window changed: process again first', 5000); return; }
  const pr = S.summary.proc_range, nEv = (pr ? pr.frames : S.summary.frames) * 2;
  if ($('xWave').checked && nEv * 2100 > 1.5e9) { toast('With waveforms the files would exceed 1.5 GB: narrow the time window or leave Samples out', 7000); return; }
  $('xBuild').disabled = true; $('xOut').textContent = 'building…';
  await new Promise(r => setTimeout(r, 30));
  const t0 = performance.now();
  try {
    S.exported = await api('/api/export/compass', { per_channel: $('xPerCh').checked, filtered: $('xFiltered').checked, waveforms: $('xWave').checked, cfd: $('xCfd').checked, energy_scale: $('xScale').value === 'auto' ? null : +$('xScale').value });
  } catch (e) { $('xOut').textContent = ''; toast('Could not build: ' + e.message, 6000); $('xBuild').disabled = false; return; }
  $('xBuild').disabled = false;
  const tot = S.exported.files.reduce((a, f) => a + f.bytes, 0);
  $('xOut').textContent = `${S.exported.files.length} files, ${human(tot)}, ${((performance.now() - t0) / 1000).toFixed(1)} s · energy divisor ${S.exported.energy_scale} (largest Q_long ${fmt(S.exported.q_long_max, 0)})`;
  renderFiles(); renderSteps();
  toast('ROOT files ready: download them one by one or as a ZIP');
}
function renderFiles() {
  const x = S.exported, tb = $('xFiles').tBodies[0];
  $('xFilesWrap').hidden = !x; for (const id of ['xZip', 'xSettings', 'xInfo']) $(id).hidden = !x;
  if (!x) { tb.innerHTML = ''; return; }
  tb.innerHTML = x.files.map((f, i) => `<tr><td>${f.folder}</td><td class="mono">${f.name}</td><td>${f.tree}</td><td>${num(f.entries)}</td><td>${human(f.bytes)}</td><td><button class="btn" data-dl="${i}" type="button">Download</button></td></tr>`).join('');
}
function downloadZip() {
  const x = S.exported; if (!x) return;
  const run = (S.summary.name || 'run').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const entries = x.files.map(f => ({ name: `${run}/${f.folder}/${f.name}`, parts: f.parts }));
  entries.push({ name: `${run}/settings.json`, parts: JSON.stringify(x.settings, null, 2) }, { name: `${run}/run.info`, parts: x.run_info });
  download(`${run}_compass.zip`, ZipStore.build(entries), 'application/zip');
}

// ------------------------------------------------------------------ wiring
function init() {
  document.querySelectorAll('.tab, .step').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  for (const id of ['upInput', 'upInput2']) $(id).addEventListener('change', ev => { uploadFiles(ev.target.files); ev.target.value = ''; });
  bindDrop();
  $('btnOpen').addEventListener('click', openRun); $('btnClose').addEventListener('click', closeRun);
  $('btnProcess').addEventListener('click', processRun); $('tProcess').addEventListener('click', processRun);
  // time
  $('tCh').addEventListener('change', refreshTime); $('tRefresh').addEventListener('click', refreshTime);
  $('tWinApply').addEventListener('click', () => applyTimeWin(true)); $('tWinClear').addEventListener('click', () => { $('tWin0').value = ''; $('tWin1').value = ''; applyTimeWin(false); });
  for (const id of ['tWin0', 'tWin1']) $(id).addEventListener('keydown', ev => { if (ev.key === 'Enter') applyTimeWin(true); });
  // waveform
  $('wFirst').addEventListener('click', () => goTo(0)); $('wLast').addEventListener('click', () => goTo(1e9));
  $('wPrev').addEventListener('click', () => goTo(S.cur - 1)); $('wNext').addEventListener('click', () => goTo(S.cur + 1));
  $('wSlider').addEventListener('input', ev => goTo(+ev.target.value)); $('wNo').addEventListener('change', ev => goTo(+ev.target.value));
  $('wPrevValid').addEventListener('click', () => goValid(-1)); $('wNextValid').addEventListener('click', () => goValid(1));
  $('wPlay').addEventListener('click', togglePlay);
  for (const id of ['wGates', 'wNs']) $(id).addEventListener('change', refreshWave);
  $('wApply').addEventListener('click', applyPending); $('wDiscard').addEventListener('click', () => { S.pending = null; refreshWave(); });
  $('paramForm').addEventListener('submit', submitParams);
  // psd
  for (const id of ['pCh', 'pLogZ']) $(id).addEventListener('change', refreshPsd);
  $('pRefresh').addEventListener('click', refreshPsd);
  for (const id of ['pElo', 'pEhi', 'pPlo', 'pPhi']) { $(id).addEventListener('keydown', ev => { if (ev.key === 'Enter') refreshPsd(); }); $(id).addEventListener('change', refreshPsd); }
  $('pEClear').addEventListener('click', () => { $('pElo').value = ''; $('pEhi').value = ''; refreshPsd(); });
  $('pCutApply').addEventListener('click', () => applyCut(parseFloat($('pCut').value)));
  $('pCut').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); applyCut(parseFloat($('pCut').value)); } });
  $('pCutFromFit').addEventListener('click', () => { const f = S.lastFit; if (!f) { toast('A fit is needed first'); return; } applyCut(+((f.gamma.mu * f.neutron.sigma + f.neutron.mu * f.gamma.sigma) / (f.gamma.sigma + f.neutron.sigma)).toFixed(4)); });
  $('pSrc').addEventListener('change', async () => { await api('/api/classifier', { mode: $('pSrc').value === 'mixed' ? 'cut' : $('pSrc').value }); S.summary = await api('/api/summary'); S.exported = null; renderChips(); refreshPsd(); });
  // save
  $('fApply').addEventListener('click', applyFilters);
  $('xBuild').addEventListener('click', buildExport);
  $('xZip').addEventListener('click', downloadZip);
  $('xSettings').addEventListener('click', () => S.exported && download('settings.json', [JSON.stringify(S.exported.settings, null, 2)], 'application/json'));
  $('xInfo').addEventListener('click', () => S.exported && download('run.info', [S.exported.run_info], 'text/plain'));
  $('xFiles').addEventListener('click', ev => { const b = ev.target.closest('[data-dl]'); if (!b || !S.exported) return; const f = S.exported.files[+b.dataset.dl]; download(f.name, f.parts); });
  for (const id of ['xPerCh', 'xFiltered', 'xWave', 'xCfd', 'xScale']) $(id).addEventListener('change', () => { S.exported = null; renderFiles(); $('xOut').textContent = ''; renderSteps(); });
  // keyboard on the waveform tab
  document.addEventListener('keydown', ev => {
    if (ev.target.matches('input, select, textarea') || S.tab !== 'wave') return;
    if (ev.key === 'ArrowRight') { ev.shiftKey ? goValid(1) : goTo(S.cur + 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowLeft') { ev.shiftKey ? goValid(-1) : goTo(S.cur - 1); ev.preventDefault(); }
    else if (ev.key === 'Home') { goTo(0); ev.preventDefault(); } else if (ev.key === 'End') { goTo(1e9); ev.preventDefault(); }
    else if (ev.key === ' ') { togglePlay(); ev.preventDefault(); }
  });
  const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => refreshTab(S.tab));
  renderSteps();
}
init();
