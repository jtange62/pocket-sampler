'use strict';
// UI wiring: pads, sample editor, sequencer grid, FX panel, transport and keyboard.

const PAD_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
const PAD_KEY_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
const ROW_HUES = [8, 38, 168, 262];
const PATTERN_NAMES = ['A', 'B', 'C', 'D'];

const $ = (sel) => document.querySelector(sel);

const state = createState();
const engine = new Engine(state);
const seq = new Sequencer(engine, state);
const recorder = new SampleRecorder(engine);

const ui = {
  selected: 0,
  page: 0,
  follow: true,
  padEls: [],
  gridCells: [],
  gridHeads: [],
  playCol: -1,
  recTarget: 0,
  sampleCount: 0,
  meterLevel: 0,
  peakCache: new WeakMap(),
  refreshPadParams: null,
  refreshMasterParams: null,
};

const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtSec = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const fmtSigned = (unit) => (v) => `${v > 0 ? '+' : ''}${v} ${unit}`;
const logMap = (lo, hi) => ({
  from: (s) => lo * Math.pow(hi / lo, s / 1000),
  to: (v) => (1000 * Math.log(v / lo)) / Math.log(hi / lo),
});

const PAD_PARAMS = [
  { key: 'gain', label: 'Volume', min: 0, max: 1.5, step: 0.01, fmt: fmtPct },
  { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : `${Math.round(Math.abs(v) * 100)} ${v < 0 ? 'L' : 'R'}`) },
  { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, fmt: fmtSigned('st') },
  { key: 'fine', label: 'Fine tune', min: -100, max: 100, step: 1, fmt: fmtSigned('ct') },
  { key: 'cutoff', label: 'Filter', min: 0, max: 1000, map: logMap(20, 20000), fmt: (v) => (v > 19500 ? 'Open' : fmtHz(v)) },
  { key: 'resonance', label: 'Resonance', min: 0.1, max: 18, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'attack', label: 'Attack', min: 0, max: 1000, map: logMap(0.001, 1), fmt: fmtSec },
  { key: 'release', label: 'Release', min: 0, max: 1000, map: logMap(0.005, 3), fmt: fmtSec },
  { key: 'reverbSend', label: 'Reverb send', min: 0, max: 1, step: 0.01, fmt: fmtPct },
  { key: 'delaySend', label: 'Delay send', min: 0, max: 1, step: 0.01, fmt: fmtPct },
];

const MASTER_PARAMS = [
  { key: 'volume', label: 'Volume', min: 0, max: 1.2, step: 0.01, fmt: fmtPct },
  { key: 'filter', label: 'DJ filter', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.01 ? 'Off' : `${v < 0 ? 'LP' : 'HP'} ${Math.round(Math.abs(v) * 100)}%`) },
  { key: 'reverbSize', label: 'Reverb size', min: 0, max: 1000, map: logMap(0.3, 8), fmt: fmtSec, commit: true },
  { key: 'reverbLevel', label: 'Reverb level', min: 0, max: 1.5, step: 0.01, fmt: fmtPct },
  { key: 'delayFeedback', label: 'Delay feedback', min: 0, max: 0.9, step: 0.01, fmt: fmtPct },
  { key: 'delayLevel', label: 'Delay level', min: 0, max: 1.5, step: 0.01, fmt: fmtPct },
  { key: 'bits', label: 'Bit depth', min: 1, max: 16, step: 1, fmt: (v) => (v >= 16 ? 'Off' : `${v} bit`) },
  { key: 'downsample', label: 'Downsample', min: 1, max: 40, step: 1, fmt: (v) => (v <= 1 ? 'Off' : `÷${v}`) },
];

function padHue(i) {
  return ROW_HUES[Math.floor(i / 4)] + (i % 4) * 9;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

// ---------- Sliders ----------

function buildSliders(container, defs, getTarget, defaults, onChange) {
  const rows = defs.map((d) => {
    const row = document.createElement('label');
    row.className = 'param';
    row.innerHTML = `<span class="pname">${d.label}</span><input type="range" min="${d.min}" max="${d.max}" step="${d.step ?? 1}"><span class="pval"></span>`;
    const input = row.querySelector('input');
    const out = row.querySelector('.pval');
    const read = () => {
      const s = parseFloat(input.value);
      return d.map ? d.map.from(s) : s;
    };
    input.addEventListener('input', () => {
      const v = read();
      getTarget()[d.key] = v;
      out.textContent = d.fmt(v);
      if (!d.commit) onChange(d.key);
    });
    input.addEventListener('change', () => {
      if (d.commit) onChange(d.key);
      input.blur();
    });
    input.addEventListener('dblclick', () => {
      getTarget()[d.key] = defaults[d.key];
      refresh();
      onChange(d.key);
    });
    container.appendChild(row);
    return { d, input, out };
  });
  function refresh() {
    const t = getTarget();
    for (const { d, input, out } of rows) {
      const v = t[d.key];
      input.value = d.map ? d.map.to(v) : v;
      out.textContent = d.fmt(v);
    }
  }
  return refresh;
}

// ---------- Pads ----------

function buildPads() {
  const wrap = $('#pads');
  state.pads.forEach((_, i) => {
    const el = document.createElement('div');
    el.className = 'pad';
    el.style.setProperty('--hue', padHue(i));
    el.innerHTML = `<canvas class="mini"></canvas><span class="num">${i + 1}</span><span class="key">${PAD_KEY_LABELS[i]}</span><span class="name"></span>`;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      hitPad(i);
    });
    el.addEventListener('pointerup', () => releasePad(i));
    el.addEventListener('pointercancel', () => releasePad(i));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      loadFilesToPads([...e.dataTransfer.files], i);
    });
    wrap.appendChild(el);
    ui.padEls.push(el);
  });
  new ResizeObserver(() => state.pads.forEach((_, i) => drawMini(i))).observe(wrap);
}

function hitPad(i, vel = 1) {
  engine.padDown(i, vel);
  flashPad(i);
  if (state.pads[i].buffer && seq.recordHit(i, vel)) refreshGrid();
  if (ui.selected !== i) selectPad(i);
}

function releasePad(i) {
  engine.padUp(i);
  seq.recordRelease(i);
}

function flashPad(i) {
  const el = ui.padEls[i];
  el.classList.remove('hit');
  void el.offsetWidth; // restart the animation
  el.classList.add('hit');
}

function selectPad(i) {
  ui.selected = i;
  ui.padEls.forEach((el, k) => el.classList.toggle('selected', k === i));
  refreshEditor();
  refreshGridHeads();
}

function refreshPads() {
  state.pads.forEach((p, i) => {
    const el = ui.padEls[i];
    el.classList.toggle('loaded', !!p.buffer);
    el.querySelector('.name').textContent = p.name;
    drawMini(i);
  });
}

function drawMini(i) {
  const p = state.pads[i];
  const canvas = ui.padEls[i].querySelector('.mini');
  const { w, h } = fitCanvas(canvas);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!p.buffer) return;
  const a = Math.floor(p.start * p.buffer.length), b = Math.ceil(p.end * p.buffer.length);
  const pk = DSP.peaks(p.buffer, w, a, b);
  g.fillStyle = '#fff';
  for (let x = 0; x < w; x++) {
    const y0 = (1 - pk[2 * x + 1]) * h / 2, y1 = (1 - pk[2 * x]) * h / 2;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function setPadBuffer(i, buf, name) {
  const p = state.pads[i];
  p.buffer = buf;
  p.name = name;
  p.start = 0;
  p.end = 1;
}

async function loadFilesToPads(files, start) {
  let i = start;
  for (const f of files) {
    if (i >= PAD_COUNT) break;
    try {
      const buf = await engine.ctx.decodeAudioData(await f.arrayBuffer());
      setPadBuffer(i, buf, f.name.replace(/\.[^.]+$/, ''));
      i++;
    } catch (err) {
      toast(`Couldn't read ${f.name} as audio`, true);
    }
  }
  if (i > start) toast(i - start === 1 ? `Loaded into pad ${start + 1}` : `Loaded ${i - start} samples into pads ${start + 1}–${i}`);
  refreshPads();
  refreshEditor();
  refreshGridHeads();
}

// ---------- Sample editor ----------

function buildEditor() {
  ui.refreshPadParams = buildSliders($('#padParams'), PAD_PARAMS, () => state.pads[ui.selected], defaultPad(), (key) => {
    if (key === 'cutoff' || key === 'resonance') return;
    drawMini(ui.selected);
  });

  const fileInput = $('#fileInput');
  $('#btnLoad').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    loadFilesToPads([...fileInput.files], ui.selected);
    fileInput.value = '';
  });

  const wrap = $('#waveWrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drop'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop');
    loadFilesToPads([...e.dataTransfer.files], ui.selected);
  });
  new ResizeObserver(drawWave).observe(wrap);

  // Drag the start/end markers: grabs whichever marker is closer to the click.
  const overlay = $('#waveOverlay');
  let dragging = null;
  const frac = (e) => {
    const r = overlay.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const setMarker = (f) => {
    const p = state.pads[ui.selected];
    const minGap = 0.002;
    if (dragging === 'start') p.start = Math.min(f, p.end - minGap);
    else p.end = Math.max(f, p.start + minGap);
    p.start = Math.max(0, p.start);
    p.end = Math.min(1, p.end);
    drawWave();
    drawMini(ui.selected);
  };
  overlay.addEventListener('pointerdown', (e) => {
    const p = state.pads[ui.selected];
    if (!p.buffer || e.button !== 0) return;
    const f = frac(e);
    dragging = Math.abs(f - p.start) <= Math.abs(f - p.end) ? 'start' : 'end';
    overlay.setPointerCapture(e.pointerId);
    setMarker(f);
  });
  overlay.addEventListener('pointermove', (e) => { if (dragging) setMarker(frac(e)); });
  overlay.addEventListener('pointerup', () => { dragging = null; });

  const withSample = (fn) => () => {
    const p = state.pads[ui.selected];
    if (!p.buffer) return toast('This pad is empty. Load or sample something first.');
    fn(p);
    refreshPads();
    refreshEditor();
  };
  $('#btnTrim').addEventListener('click', withSample((p) => {
    p.buffer = DSP.region(p.buffer, p.start, p.end);
    p.start = 0;
    p.end = 1;
  }));
  $('#btnReverse').addEventListener('click', withSample((p) => {
    p.buffer = DSP.reverse(p.buffer);
    [p.start, p.end] = [1 - p.end, 1 - p.start];
  }));
  $('#btnNormalize').addEventListener('click', withSample((p) => { p.buffer = DSP.normalize(p.buffer); }));
  $('#btnClearPad').addEventListener('click', () => {
    Object.assign(state.pads[ui.selected], defaultPad());
    refreshPads();
    refreshEditor();
    refreshGridHeads();
  });
  $('#btnExportPad').addEventListener('click', async () => {
    const p = state.pads[ui.selected];
    if (!p.buffer) return toast('This pad is empty.');
    const wav = DSP.encodeWav(DSP.region(p.buffer, p.start, p.end));
    await saveWithDialog({ title: 'Export sample', defaultPath: `${p.name || `pad-${ui.selected + 1}`}.wav`, filters: [{ name: 'WAV audio', extensions: ['wav'] }] }, new Uint8Array(wav));
  });

  $('#btnChopEqual').addEventListener('click', () => chop('equal'));
  $('#btnChopTrans').addEventListener('click', () => chop('transients'));

  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.pads[ui.selected].mode = b.dataset.v;
    refreshEditor();
  });
  $('#btnLoop').addEventListener('click', () => {
    const p = state.pads[ui.selected];
    p.loop = !p.loop;
    refreshEditor();
  });
  $('#choke').addEventListener('change', (e) => {
    state.pads[ui.selected].choke = +e.target.value;
  });
}

function chop(mode) {
  const first = ui.selected;
  const p = state.pads[first];
  if (!p.buffer) return toast('This pad is empty. Load or sample something first.');
  const n = +$('#chopCount').value;
  const src = DSP.region(p.buffer, p.start, p.end);
  const points = mode === 'equal'
    ? Array.from({ length: n }, (_, k) => Math.round((k * src.length) / n))
    : DSP.detectOnsets(src, n);
  const count = Math.min(points.length, PAD_COUNT - first);
  const overwritten = state.pads.slice(first + 1, first + count).filter((q) => q.buffer).length;
  if (overwritten && !confirm(`Chopping will replace ${overwritten} loaded pad${overwritten > 1 ? 's' : ''}. Continue?`)) return;

  const base = p.name || `Pad ${first + 1}`;
  for (let k = 0; k < count; k++) {
    const end = k + 1 < points.length ? points[k + 1] : src.length;
    const target = state.pads[first + k];
    setPadBuffer(first + k, DSP.slice(src, points[k], end), `${base} ${k + 1}`);
    if (k > 0) Object.assign(target, { mode: p.mode, gain: p.gain });
  }
  refreshPads();
  refreshEditor();
  refreshGridHeads();
  const note = mode === 'transients' && points.length < n ? ` (found ${points.length} hits)` : '';
  toast(`Chopped into ${count} slices on pads ${first + 1}–${first + count}${note}`);
}

function refreshEditor() {
  const i = ui.selected, p = state.pads[i];
  $('#padLabel').textContent = `Pad ${i + 1}`;
  $('#padName').textContent = p.buffer ? `${p.name} · ${p.buffer.duration.toFixed(2)} s` : 'empty';
  ui.refreshPadParams();
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === p.mode));
  $('#btnLoop').classList.toggle('active', p.loop);
  $('#choke').value = String(p.choke);
  drawWave();
}

function getPeaks(buf, cols) {
  const hit = ui.peakCache.get(buf);
  if (hit && hit.cols === cols) return hit.data;
  const data = DSP.peaks(buf, cols);
  ui.peakCache.set(buf, { cols, data });
  return data;
}

function drawWave() {
  const canvas = $('#wave');
  const { w, h, dpr } = fitCanvas(canvas);
  fitCanvas($('#waveOverlay'));
  const g = canvas.getContext('2d');
  const p = state.pads[ui.selected];
  g.clearRect(0, 0, w, h);
  if (!p.buffer) {
    g.fillStyle = '#5c6170';
    g.font = `${13 * dpr}px Segoe UI, sans-serif`;
    g.textAlign = 'center';
    g.fillText('Drop a file here, click "Load file…", or hit ● SAMPLE', w / 2, h / 2);
    return;
  }
  const hue = padHue(ui.selected);
  const pk = getPeaks(p.buffer, w);
  const xs = p.start * w, xe = p.end * w;
  for (let x = 0; x < w; x++) {
    const inside = x >= xs && x <= xe;
    g.fillStyle = inside ? `hsl(${hue} 75% 62%)` : '#3a3e4a';
    const y0 = (1 - pk[2 * x + 1]) * h / 2, y1 = (1 - pk[2 * x]) * h / 2;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(0, h / 2, w, 1);
  for (const [x, label] of [[xs, 'S'], [xe, 'E']]) {
    g.fillStyle = '#fff';
    g.fillRect(Math.round(x) - dpr, 0, 2 * dpr, h);
    g.font = `bold ${11 * dpr}px Segoe UI, sans-serif`;
    g.textAlign = label === 'S' ? 'left' : 'right';
    g.fillText(label, label === 'S' ? x + 4 * dpr : x - 4 * dpr, 14 * dpr);
  }
}

// Playback cursor for the selected pad's most recent voice.
function drawWavePlayhead() {
  const canvas = $('#waveOverlay');
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const p = state.pads[ui.selected];
  const v = engine.mixer.last[ui.selected];
  const now = engine.ctx.currentTime;
  if (!p.buffer || !v || v.ended || v.src.buffer !== p.buffer || now < v.startTime || now > v.endTime) return;
  let pos = (now - v.startTime) * v.rate;
  if (v.loop) pos %= v.len;
  else if (pos > v.len) return;
  const x = ((v.offset + pos) / p.buffer.duration) * canvas.width;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(x, 0, Math.max(1, window.devicePixelRatio || 1), canvas.height);
}

// ---------- Sequencer ----------

function buildSequencer() {
  const grid = $('#grid');
  let paint = null;
  window.addEventListener('pointerup', () => { paint = null; });

  for (let r = 0; r < PAD_COUNT; r++) {
    const head = document.createElement('div');
    head.className = 'ghead';
    head.style.setProperty('--hue', padHue(r));
    head.innerHTML = `<span class="sw"></span><span>${r + 1}</span><span class="gname"></span><button class="mute" title="Mute this pad in the sequence">M</button>`;
    head.addEventListener('click', (e) => {
      if (e.target.classList.contains('mute')) {
        state.pads[r].mute = !state.pads[r].mute;
        refreshGridHeads();
      } else selectPad(r);
    });
    grid.appendChild(head);
    ui.gridHeads.push(head);

    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const cell = document.createElement('div');
      cell.className = s % 4 === 0 ? 'cell beat' : 'cell';
      cell.style.setProperty('--hue', padHue(r));
      cell.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const step = ui.page * STEPS_PER_BAR + s;
        seq.pushUndo();
        paint = !seq.hasStep(r, step);
        seq.setStep(r, step, paint);
        refreshGrid();
      });
      cell.addEventListener('pointerenter', (e) => {
        if (paint === null || !(e.buttons & 1)) return;
        seq.setStep(r, ui.page * STEPS_PER_BAR + s, paint);
        refreshGrid();
      });
      grid.appendChild(cell);
      ui.gridCells.push(cell);
    }
  }

  $('#bars').addEventListener('change', (e) => {
    seq.setBars(+e.target.value);
    refreshGrid();
    refreshTransport();
  });
  $('#quantize').addEventListener('change', (e) => { state.quantize = +e.target.value; });
  $('#pages').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.page = +b.dataset.page;
    ui.follow = false;
    refreshGrid();
  });
  $('#btnFollow').addEventListener('click', () => {
    ui.follow = !ui.follow;
    refreshGrid();
  });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnClearPadSeq').addEventListener('click', () => {
    seq.clearPad(ui.selected);
    refreshGrid();
    refreshTransport();
  });
  $('#btnClearPattern').addEventListener('click', () => {
    seq.clearPattern();
    refreshGrid();
    refreshTransport();
  });

  seq.onNote = (pad, time) => {
    setTimeout(() => flashPad(pad), Math.max(0, (time - engine.ctx.currentTime) * 1000));
  };
  seq.onPatternChange = () => {
    refreshGrid();
    refreshTransport();
  };
}

function undo() {
  if (seq.undo()) {
    refreshGrid();
    refreshTransport();
  }
}

function refreshGrid() {
  const pat = seq.pattern;
  ui.page = Math.min(ui.page, pat.bars - 1);
  const base = ui.page * STEPS_PER_BAR;
  const vel = new Map();
  for (const n of pat.notes) {
    const step = Math.floor(n.tick / TICKS_PER_STEP) - base;
    if (step < 0 || step >= STEPS_PER_BAR) continue;
    const k = n.pad * STEPS_PER_BAR + step;
    vel.set(k, Math.max(vel.get(k) || 0, n.vel));
  }
  ui.gridCells.forEach((cell, k) => {
    const v = vel.get(k);
    cell.classList.toggle('on', v !== undefined);
    cell.style.opacity = v !== undefined ? String(0.45 + 0.55 * v) : '';
  });

  const pages = $('#pages');
  pages.innerHTML = '';
  for (let b = 0; b < pat.bars; b++) {
    const btn = document.createElement('button');
    btn.dataset.page = b;
    btn.textContent = `Bar ${b + 1}`;
    btn.classList.toggle('active', b === ui.page);
    pages.appendChild(btn);
  }
  $('#btnFollow').classList.toggle('active', ui.follow);
  $('#bars').value = String(pat.bars);
  $('#quantize').value = String(state.quantize);
  refreshGridHeads();
}

function refreshGridHeads() {
  ui.gridHeads.forEach((h, i) => {
    h.classList.toggle('selected', i === ui.selected);
    h.querySelector('.mute').classList.toggle('active', state.pads[i].mute);
    h.querySelector('.gname').textContent = state.pads[i].name || '—';
  });
}

function drawGridPlayhead() {
  let col = -1;
  const t = seq.currentTickFloat();
  if (t != null) {
    const step = Math.floor(t / TICKS_PER_STEP);
    const pg = Math.floor(step / STEPS_PER_BAR);
    if (ui.follow && pg !== ui.page && pg < seq.pattern.bars) {
      ui.page = pg;
      refreshGrid();
    }
    if (pg === ui.page) col = step % STEPS_PER_BAR;
  }
  if (col === ui.playCol) return;
  for (let r = 0; r < PAD_COUNT; r++) {
    if (ui.playCol >= 0) ui.gridCells[r * STEPS_PER_BAR + ui.playCol].classList.remove('ph');
    if (col >= 0) ui.gridCells[r * STEPS_PER_BAR + col].classList.add('ph');
  }
  ui.playCol = col;
}

// ---------- FX & export ----------

function buildFx() {
  ui.refreshMasterParams = buildSliders($('#masterParams'), MASTER_PARAMS, () => state.master, createState().master, (key) => {
    if (key === 'reverbSize') engine.mixer.setReverbSize(state.master.reverbSize);
    else engine.mixer.applyMaster(true);
  });
  const div = $('#delayDiv');
  for (const k of Object.keys(DELAY_DIVISIONS)) div.add(new Option(k, k));
  div.addEventListener('change', () => {
    state.master.delayDiv = div.value;
    engine.mixer.applyMaster(true);
  });

  $('#btnExport').addEventListener('click', async (e) => {
    if (!seq.pattern.notes.length) return toast('This pattern is empty. Add some notes first.');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const buf = await seq.render(+$('#exportLoops').value, $('#exportTail').checked);
      const wav = DSP.encodeWav(buf);
      const name = `pattern-${PATTERN_NAMES[state.currentPattern]}-${state.bpm}bpm.wav`;
      await saveWithDialog({ title: 'Export pattern', defaultPath: name, filters: [{ name: 'WAV audio', extensions: ['wav'] }] }, new Uint8Array(wav));
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Export pattern as WAV…';
    }
  });
}

function refreshFx() {
  ui.refreshMasterParams();
  $('#delayDiv').value = state.master.delayDiv;
}

// ---------- Transport, sampling, project ----------

function buildTransport() {
  const pats = $('#patterns');
  PATTERN_NAMES.forEach((name, k) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', (e) => {
      if (e.shiftKey) {
        if (k === state.currentPattern) return;
        seq.copyPattern(state.currentPattern, k);
        toast(`Copied pattern ${PATTERN_NAMES[state.currentPattern]} to ${name}`);
      } else seq.selectPattern(k);
      refreshGrid();
      refreshTransport();
    });
    pats.appendChild(b);
  });

  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnRec').addEventListener('click', () => {
    seq.recording = !seq.recording;
    if (seq.recording && !seq.playing) seq.play();
    refreshTransport();
  });
  $('#btnMetro').addEventListener('click', () => {
    state.metronome = !state.metronome;
    refreshTransport();
  });

  const bpm = $('#bpm');
  bpm.addEventListener('change', () => setBpm(+bpm.value));
  bpm.addEventListener('keydown', (e) => { if (e.key === 'Enter') bpm.blur(); });
  const taps = [];
  $('#btnTap').addEventListener('click', () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) setBpm(Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))));
  });
  $('#swing').addEventListener('input', (e) => {
    state.swing = +e.target.value;
    refreshTransport();
  });

  $('#btnSample').addEventListener('click', toggleSampling);
  $('#btnNew').addEventListener('click', () => {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    seq.stop();
    Object.assign(state, createState());
    afterProjectLoad();
  });
  $('#btnOpen').addEventListener('click', openProject);
  $('#btnSave').addEventListener('click', saveProject);
}

function togglePlay() {
  if (seq.playing) seq.stop();
  else seq.play();
  refreshTransport();
  refreshGrid();
}

function setBpm(v) {
  state.bpm = Math.max(40, Math.min(250, Math.round(v) || state.bpm));
  engine.mixer.applyMaster(true);
  refreshTransport();
}

function refreshTransport() {
  $('#btnPlay').classList.toggle('active', seq.playing);
  $('#btnPlay').textContent = seq.playing ? '■' : '▶';
  $('#btnRec').classList.toggle('active', seq.recording);
  $('#btnMetro').classList.toggle('active', state.metronome);
  if (document.activeElement !== $('#bpm')) $('#bpm').value = state.bpm;
  $('#swing').value = state.swing;
  $('#swingVal').textContent = `${state.swing}%`;
  [...$('#patterns').children].forEach((b, k) => {
    b.classList.toggle('active', k === state.currentPattern);
    b.classList.toggle('queued', k === seq.queued);
    b.classList.toggle('has', state.patterns[k].notes.length > 0);
  });
}

async function toggleSampling() {
  const btn = $('#btnSample');
  if (recorder.recording) {
    btn.classList.remove('active');
    $('#sampleStatus').textContent = '';
    const buf = await recorder.stop();
    if (!buf) return toast('Nothing recorded. The input was silent.');
    ui.sampleCount++;
    setPadBuffer(ui.recTarget, buf, `Sample ${ui.sampleCount}`);
    refreshPads();
    if (ui.selected === ui.recTarget) refreshEditor();
    refreshGridHeads();
    toast(`Recorded ${buf.duration.toFixed(1)} s into pad ${ui.recTarget + 1}`);
    return;
  }
  ui.recTarget = ui.selected;
  try {
    await recorder.start($('#recSource').value);
    btn.classList.add('active');
  } catch (err) {
    console.error(err);
    toast(`Couldn't start sampling: ${err.message}`, true);
  }
}

async function saveWithDialog(options, data) {
  if (!window.native) return toast('Saving files needs the desktop app.', true);
  try {
    const path = await window.native.saveFile(options, data);
    if (path) toast(`Saved ${path}`);
    return path;
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
    return null;
  }
}

async function saveProject() {
  await saveWithDialog({ title: 'Save project', defaultPath: 'project.psmp', filters: [{ name: 'Pocket Sampler project', extensions: ['psmp'] }] }, Project.serialize(state));
}

async function openProject() {
  if (!window.native) return;
  const res = await window.native.openFile({ title: 'Open project', filters: [{ name: 'Pocket Sampler project', extensions: ['psmp'] }] });
  if (!res) return;
  try {
    seq.stop();
    Project.load(new TextDecoder().decode(res.data), state);
    afterProjectLoad();
    toast(`Opened ${res.name}`);
  } catch (err) {
    toast(`Couldn't open project: ${err.message}`, true);
  }
}

function afterProjectLoad() {
  seq.undoStack = [];
  seq.queued = null;
  engine.mixer.applyMaster(true);
  engine.mixer.setReverbSize(state.master.reverbSize);
  ui.page = 0;
  refreshAll();
}

// ---------- Keyboard & frame loop ----------

function bindKeys() {
  const typing = (el) => el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'text');
  window.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
    const i = PAD_KEYS.indexOf(e.code);
    if (i >= 0) {
      e.preventDefault();
      if (!e.repeat) hitPad(i);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') e.preventDefault();
    const i = PAD_KEYS.indexOf(e.code);
    if (i >= 0) releasePad(i);
  });
  // Stop buttons and selects keeping focus, so Space and the pad keys always reach us.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
  });
  document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') e.target.blur(); });
  document.addEventListener('pointerdown', () => engine.resume());
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

const meterData = new Float32Array(1024);
function drawMeter() {
  engine.analyser.getFloatTimeDomainData(meterData);
  let peak = 0;
  for (const v of meterData) peak = Math.max(peak, Math.abs(v));
  ui.meterLevel = Math.max(peak, ui.meterLevel * 0.9);
  const c = $('#meter'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const lvl = Math.min(1, ui.meterLevel);
  g.fillStyle = lvl > 0.97 ? '#ff4d5e' : lvl > 0.7 ? '#ffb347' : '#3fd18f';
  g.fillRect(0, 0, lvl * c.width, c.height);
}

function frame() {
  drawMeter();
  drawWavePlayhead();
  drawGridPlayhead();
  if (recorder.recording) $('#sampleStatus').textContent = `REC → pad ${ui.recTarget + 1} · ${recorder.elapsed.toFixed(1)} s`;
  requestAnimationFrame(frame);
}

function buildTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'edit') drawWave();
    });
  });
}

function refreshAll() {
  refreshPads();
  refreshEditor();
  refreshGrid();
  refreshFx();
  refreshTransport();
}

async function main() {
  await engine.init();
  buildPads();
  buildTabs();
  buildEditor();
  buildSequencer();
  buildFx();
  buildTransport();
  bindKeys();
  selectPad(0);
  refreshAll();
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  toast(`Startup failed: ${err.message}`, true);
});
