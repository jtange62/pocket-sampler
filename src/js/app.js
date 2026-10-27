'use strict';
// UI wiring: pads, sample editor, sequencer grid, FX panel, transport and keyboard.

const PAD_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
const PAD_KEY_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
const ROW_HUES = [8, 38, 168, 262];
const PATTERN_NAMES = ['A', 'B', 'C', 'D'];

const $ = (sel) => document.querySelector(sel);

const state = createState();
const undoHistory = new History(state);
const engine = new Engine(state);
const seq = new Sequencer(engine, state);
const recorder = new SampleRecorder(engine);
const midi = new MidiManager(engine, seq);
const browser = new SampleBrowser(engine, {
  onLoad: (items) => loadLibraryItems(items, ui.selected),
  toast: (msg, isError) => toast(msg, isError),
});

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
  sliders: new Map(), // "pad.gain" / "master.volume" -> { label, row, setNorm }
  padDrag: null,
  learn: false,
  learnTarget: null,
  midiDotTimer: null,
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

// scope ("pad" or "master") namespaces each slider's id for MIDI learn.
function buildSliders(container, defs, scope, getTarget, defaults, onChange) {
  const rows = defs.map((d) => {
    const row = document.createElement('label');
    row.className = 'param';
    row.dataset.param = `${scope}.${d.key}`;
    row.innerHTML = `<span class="pname">${d.label}<span class="cc"></span></span><input type="range" min="${d.min}" max="${d.max}" step="${d.step ?? 1}"><span class="pval"></span>`;
    const input = row.querySelector('input');
    const out = row.querySelector('.pval');
    const read = () => {
      const s = parseFloat(input.value);
      return d.map ? d.map.from(s) : s;
    };
    // One undo step per drag or knob turn, per pad.
    const undoKey = () => `${row.dataset.param}:${scope === 'pad' ? ui.selected : ''}`;
    input.addEventListener('input', () => {
      undoHistory.push(`Change ${d.label.toLowerCase()}`, undoKey());
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
      undoHistory.push(`Reset ${d.label.toLowerCase()}`);
      getTarget()[d.key] = defaults[d.key];
      refresh();
      onChange(d.key);
    });
    let commitTimer = null;
    ui.sliders.set(row.dataset.param, {
      label: `${scope === 'pad' ? 'Selected pad' : 'Master'} · ${d.label}`,
      row,
      // Drive the slider from a controller (0–1), as if the user dragged it.
      setNorm(n) {
        input.value = String(+d.min + n * (d.max - d.min));
        input.dispatchEvent(new Event('input'));
        if (d.commit) {
          clearTimeout(commitTimer);
          commitTimer = setTimeout(() => onChange(d.key), 150);
        }
      },
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
    // Press plays immediately; moving past a small threshold turns it into a drag.
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || ui.padDrag) return;
      el.setPointerCapture(e.pointerId);
      const recorded = hitPad(i);
      ui.padDrag = { from: i, pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false, target: null, recorded };
    });
    el.addEventListener('pointermove', (e) => {
      const d = ui.padDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12) return;
        startPadDrag(e);
      }
      updatePadDrag(e);
    });
    el.addEventListener('pointerup', (e) => {
      const d = ui.padDrag;
      if (d && d.pointerId === e.pointerId) endPadDrag(e.ctrlKey);
      releasePad(i);
    });
    el.addEventListener('pointercancel', () => {
      if (ui.padDrag) ui.padDrag.target = null;
      endPadDrag(false);
      releasePad(i);
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      loadDrop(e.dataTransfer, i);
    });
    wrap.appendChild(el);
    ui.padEls.push(el);
  });
  new ResizeObserver(() => state.pads.forEach((_, i) => drawMini(i))).observe(wrap);
}

// Returns true if the hit was recorded into the pattern.
function hitPad(i, vel = 1) {
  engine.padDown(i, vel);
  flashPad(i);
  const recorded = !!(state.pads[i].buffer && seq.recordHit(i, vel));
  if (recorded) refreshGrid();
  if (ui.selected !== i) selectPad(i);
  return recorded;
}

function startPadDrag(e) {
  const d = ui.padDrag;
  d.active = true;
  releasePad(d.from);
  // The press that started the drag wasn't meant as a hit.
  if (d.recorded) {
    undoHistory.discardLast();
    refreshGrid();
  }
  const src = ui.padEls[d.from];
  const r = src.getBoundingClientRect();
  const p = state.pads[d.from];
  const ghost = document.createElement('div');
  ghost.className = p.buffer ? 'pad pad-ghost loaded' : 'pad pad-ghost';
  ghost.style.setProperty('--hue', padHue(d.from));
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  ghost.innerHTML = `<span class="num">${d.from + 1}</span><span class="name"></span>`;
  ghost.querySelector('.name').textContent = p.name;
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.offX = e.clientX - r.left;
  d.offY = e.clientY - r.top;
  src.classList.add('dragging');
}

function updatePadDrag(e) {
  const d = ui.padDrag;
  d.ghost.style.transform = `translate(${e.clientX - d.offX}px, ${e.clientY - d.offY}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const t = under ? ui.padEls.indexOf(under.closest('.pad')) : -1;
  d.target = t >= 0 && t !== d.from ? t : null;
  ui.padEls.forEach((el, k) => el.classList.toggle('drop', k === d.target));
}

function endPadDrag(copy) {
  const d = ui.padDrag;
  ui.padDrag = null;
  if (!d || !d.active) return;
  d.ghost.remove();
  ui.padEls.forEach((el) => el.classList.remove('dragging', 'drop'));
  if (d.target != null) movePad(d.from, d.target, copy);
}

// Swap two pads (sound, settings and their notes in every pattern), or copy one onto another.
function movePad(from, to, copy = false) {
  undoHistory.push(copy ? 'Copy pad' : 'Swap pads');
  const now = engine.ctx.currentTime;
  engine.mixer.cut(from, now);
  engine.mixer.cut(to, now);
  engine.held.delete(from);
  engine.held.delete(to);
  const pads = state.pads;
  if (copy) {
    pads[to] = { ...pads[from] };
    toast(`Copied pad ${from + 1} to pad ${to + 1}`);
  } else {
    [pads[from], pads[to]] = [pads[to], pads[from]];
    const swap = (n) => { if (n.pad === from) n.pad = to; else if (n.pad === to) n.pad = from; };
    for (const pat of state.patterns) pat.notes.forEach(swap);
    toast(`Swapped pads ${from + 1} and ${to + 1}`);
  }
  selectPad(to);
  refreshPads();
  refreshGrid();
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

// A source is { name, decode: () => Promise<AudioBuffer> }, from a dropped
// file or the library. Fills pads from `start` onward.
async function loadSources(sources, start) {
  if (!sources.length) return;
  undoHistory.push(sources.length === 1 ? 'Load sample' : 'Load samples');
  let i = start;
  for (const s of sources) {
    if (i >= PAD_COUNT) break;
    try {
      setPadBuffer(i, await s.decode(), s.name.replace(/\.[^.]+$/, ''));
      i++;
    } catch (err) {
      toast(`Couldn't read ${s.name} as audio`, true);
    }
  }
  if (i > start) toast(i - start === 1 ? `Loaded into pad ${start + 1}` : `Loaded ${i - start} samples into pads ${start + 1}–${i}`);
  refreshPads();
  refreshEditor();
  refreshGridHeads();
}

function fileSource(file) {
  return { name: file.name, decode: async () => engine.ctx.decodeAudioData(await file.arrayBuffer()) };
}

function loadFilesToPads(files, start) {
  return loadSources(files.map(fileSource), start);
}

// Library items are files or folders; a folder loads its samples as a kit.
async function loadLibraryItems(items, start) {
  const files = [];
  for (const it of items) {
    if (!it.dir) files.push(it);
    else {
      try {
        files.push(...(await window.native.library.list(it.path)).filter((k) => !k.dir));
      } catch (err) {
        toast(`Couldn't open ${it.name}: ${err.message}`, true);
      }
    }
  }
  if (!files.length) return toast('No samples in that folder.');
  return loadSources(files.map((f) => ({ name: f.name, decode: () => browser.getBuffer(f.path) })), start);
}

function loadDrop(dataTransfer, start) {
  const raw = dataTransfer.getData(SAMPLE_DRAG_TYPE);
  if (raw) return loadLibraryItems([JSON.parse(raw)], start);
  return loadFilesToPads([...dataTransfer.files], start);
}

function setBrowserOpen(open) {
  browser.prefs.open = open;
  browser.savePrefs();
  document.querySelector('main').classList.toggle('with-browser', open);
  $('#btnBrowser').classList.toggle('active', open);
  if (!open) browser.stopPreview();
}

// ---------- Sample editor ----------

function buildEditor() {
  ui.refreshPadParams = buildSliders($('#padParams'), PAD_PARAMS, 'pad', () => state.pads[ui.selected], defaultPad(), (key) => {
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
  wrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    wrap.classList.add('drop');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop');
    loadDrop(e.dataTransfer, ui.selected);
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
    undoHistory.push('Move markers', `markers:${ui.selected}`);
    overlay.setPointerCapture(e.pointerId);
    setMarker(f);
  });
  overlay.addEventListener('pointermove', (e) => { if (dragging) setMarker(frac(e)); });
  overlay.addEventListener('pointerup', () => { dragging = null; });

  const withSample = (label, fn) => () => {
    if (!state.pads[ui.selected].buffer) return toast('This pad is empty. Load or sample something first.');
    undoHistory.push(label);
    fn(state.pads[ui.selected]);
    refreshPads();
    refreshEditor();
  };
  $('#btnTrim').addEventListener('click', withSample('Trim', (p) => {
    p.buffer = DSP.region(p.buffer, p.start, p.end);
    p.start = 0;
    p.end = 1;
  }));
  $('#btnReverse').addEventListener('click', withSample('Reverse', (p) => {
    p.buffer = DSP.reverse(p.buffer);
    [p.start, p.end] = [1 - p.end, 1 - p.start];
  }));
  $('#btnNormalize').addEventListener('click', withSample('Normalize', (p) => { p.buffer = DSP.normalize(p.buffer); }));
  $('#btnClearPad').addEventListener('click', () => {
    undoHistory.push('Clear pad');
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
    if (!b || state.pads[ui.selected].mode === b.dataset.v) return;
    undoHistory.push('Change play mode');
    state.pads[ui.selected].mode = b.dataset.v;
    refreshEditor();
  });
  $('#btnLoop').addEventListener('click', () => {
    undoHistory.push('Toggle loop');
    const p = state.pads[ui.selected];
    p.loop = !p.loop;
    refreshEditor();
  });
  $('#choke').addEventListener('change', (e) => {
    undoHistory.push('Change choke group');
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

  undoHistory.push('Chop');
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
        undoHistory.push('Toggle mute');
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
        seq.pushUndo('Edit steps');
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
  $('#btnUndo').addEventListener('click', () => undo());
  $('#btnRedo').addEventListener('click', () => undo(true));
  seq.onEdit = (label) => undoHistory.push(label);
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

  seq.onNote = (pad, time, vel, dur) => {
    setTimeout(() => flashPad(pad), Math.max(0, (time - engine.ctx.currentTime) * 1000));
    midi.sendNote(pad, time, vel, dur);
  };
  seq.onTick = (abs, time, spt) => midi.sendClockForTick(abs, time, spt);
  seq.onPlay = (time) => midi.sendStart(time);
  seq.onStop = () => midi.sendStop();
  seq.onPatternChange = () => {
    refreshGrid();
    refreshTransport();
  };
}

function undo(redo = false) {
  const prevReverb = state.master.reverbSize;
  const label = redo ? undoHistory.redo() : undoHistory.undo();
  if (!label) return toast(redo ? 'Nothing to redo' : 'Nothing to undo');
  seq.clampTick();
  engine.mixer.applyMaster(true);
  if (state.master.reverbSize !== prevReverb) engine.mixer.setReverbSize(state.master.reverbSize);
  refreshAll();
  toast(`${redo ? 'Redo' : 'Undo'}: ${label}`);
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
  ui.refreshMasterParams = buildSliders($('#masterParams'), MASTER_PARAMS, 'master', () => state.master, createState().master, (key) => {
    if (key === 'reverbSize') engine.mixer.setReverbSize(state.master.reverbSize);
    else engine.mixer.applyMaster(true);
  });
  const div = $('#delayDiv');
  for (const k of Object.keys(DELAY_DIVISIONS)) div.add(new Option(k, k));
  div.addEventListener('change', () => {
    undoHistory.push('Change delay time');
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

  $('#btnExportMidi').addEventListener('click', async () => {
    if (!seq.pattern.notes.length) return toast('This pattern is empty. Add some notes first.');
    const label = `Pattern ${PATTERN_NAMES[state.currentPattern]}`;
    const bytes = MidiFile.encodePattern(seq, state, midi.settings, +$('#exportLoops').value, label);
    const name = `pattern-${PATTERN_NAMES[state.currentPattern]}-${state.bpm}bpm.mid`;
    await saveWithDialog({ title: 'Export MIDI', defaultPath: name, filters: [{ name: 'MIDI file', extensions: ['mid'] }] }, bytes);
  });
}

// ---------- MIDI ----------

function buildMidi() {
  const s = midi.settings;
  const save = () => midi.saveSettings();
  const inSel = $('#midiIn'), outSel = $('#midiOut'), chSel = $('#midiOutCh');
  for (let c = 0; c < 16; c++) chSel.add(new Option(String(c + 1), String(c)));

  inSel.addEventListener('change', () => { s.input = inSel.value; midi.bindInputs(); save(); });
  outSel.addEventListener('change', () => { s.output = outSel.value; save(); });
  chSel.addEventListener('change', () => { s.channel = +chSel.value; save(); });
  const base = $('#midiBase');
  base.addEventListener('change', () => {
    s.base = Math.max(0, Math.min(112, Math.round(+base.value) || 0));
    save();
    refreshMidi();
  });
  const offset = $('#midiOffset');
  offset.addEventListener('change', () => {
    s.offsetMs = Math.max(-250, Math.min(250, Math.round(+offset.value) || 0));
    save();
    refreshMidi();
  });
  for (const [id, key] of [['#midiClockIn', 'clockIn'], ['#midiClockOut', 'clockOut'], ['#midiNotesOut', 'notesOut']]) {
    $(id).addEventListener('change', (e) => { s[key] = e.target.checked; save(); });
  }

  $('#btnLearn').addEventListener('click', () => setLearn(!ui.learn));
  $('#btnClearMappings').addEventListener('click', () => {
    s.mappings = {};
    save();
    refreshMidiMappings();
  });
  $('#midiMappings').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    midi.unmap(b.dataset.key);
    refreshMidiMappings();
  });
  // In learn mode a click on a slider row picks it as the target instead of moving it.
  document.addEventListener('click', (e) => {
    if (!ui.learn) return;
    const row = e.target.closest('.param');
    if (!row) return;
    e.preventDefault();
    ui.learnTarget = row.dataset.param;
    document.querySelectorAll('.param.learn-target').forEach((r) => r.classList.remove('learn-target'));
    row.classList.add('learn-target');
  }, true);

  midi.onNoteOn = (pad, vel) => hitPad(pad, vel);
  midi.onNoteOff = (pad) => releasePad(pad);
  midi.onCC = handleCC;
  midi.onActivity = () => {
    const dot = $('#midiDot');
    dot.classList.add('on');
    clearTimeout(ui.midiDotTimer);
    ui.midiDotTimer = setTimeout(() => dot.classList.remove('on'), 90);
  };
  midi.onDevicesChange = refreshMidi;
  midi.onTransport = (cmd, time) => {
    if (seq.playing) seq.stop();
    if (cmd === 'start') seq.play(Math.max(time, engine.ctx.currentTime + 0.005));
    refreshTransport();
    refreshGrid();
  };
  midi.onTempo = (bpm) => {
    if (Math.abs(bpm - state.bpm) > 0.05) setBpm(bpm, true);
  };
}

function setLearn(on) {
  ui.learn = on;
  ui.learnTarget = null;
  document.body.classList.toggle('learning', on);
  $('#btnLearn').classList.toggle('active', on);
  document.querySelectorAll('.param.learn-target').forEach((r) => r.classList.remove('learn-target'));
  if (on) toast('MIDI learn: click a slider, then move a knob or fader. Press Esc or LEARN when done.');
}

function handleCC(ch, cc, value) {
  const key = `${ch}:${cc}`;
  if (ui.learn && ui.learnTarget) {
    midi.map(key, ui.learnTarget);
    refreshMidiMappings();
    toast(`CC ${cc} → ${ui.sliders.get(ui.learnTarget).label}`);
    return;
  }
  const slider = ui.sliders.get(midi.settings.mappings[key]);
  if (slider) slider.setNorm(value / 127);
}

function fillDeviceSelect(sel, ports, noneOption, current) {
  sel.innerHTML = '';
  sel.add(new Option(noneOption.label, noneOption.value));
  for (const p of ports) sel.add(new Option(p.name, p.id));
  if (current !== noneOption.value && !ports.some((p) => p.id === current)) {
    sel.add(new Option('(saved device not connected)', current));
  }
  sel.value = current;
}

function refreshMidi() {
  const s = midi.settings;
  fillDeviceSelect($('#midiIn'), midi.inputs, { label: 'All inputs', value: 'all' }, s.input);
  fillDeviceSelect($('#midiOut'), midi.outputs, { label: 'None', value: 'none' }, s.output);
  $('#midiOutCh').value = String(s.channel);
  if (document.activeElement !== $('#midiBase')) $('#midiBase').value = s.base;
  if (document.activeElement !== $('#midiOffset')) $('#midiOffset').value = s.offsetMs;
  $('#midiBaseHint').textContent = `Pads 1–16 respond to notes ${s.base}–${s.base + 15} (${midiNoteName(s.base)}–${midiNoteName(s.base + 15)}). 36 is the standard drum-pad layout.`;
  $('#midiClockIn').checked = s.clockIn;
  $('#midiClockOut').checked = s.clockOut;
  $('#midiNotesOut').checked = s.notesOut;
  const n = midi.inputs.length, m = midi.outputs.length;
  $('#midiStatus').textContent = !midi.access
    ? 'MIDI is unavailable.'
    : n + m === 0
      ? 'No MIDI devices found. Plug in a controller; it shows up here automatically.'
      : `${n} input${n === 1 ? '' : 's'}, ${m} output${m === 1 ? '' : 's'} connected. A device in use by another app (e.g. your DAW) can't be opened here at the same time.`;
  refreshMidiMappings();
}

function refreshMidiMappings() {
  for (const { row } of ui.sliders.values()) row.querySelector('.cc').textContent = '';
  const list = $('#midiMappings');
  list.innerHTML = '';
  const entries = Object.entries(midi.settings.mappings);
  for (const [key, id] of entries) {
    const slider = ui.sliders.get(id);
    if (!slider) continue;
    const [ch, cc] = key.split(':').map(Number);
    slider.row.querySelector('.cc').textContent = `CC${cc}`;
    const item = document.createElement('div');
    item.className = 'map';
    item.innerHTML = `<span>CC ${cc} · ch ${ch + 1}</span><span>${slider.label}</span><button data-key="${key}" title="Remove">×</button>`;
    list.appendChild(item);
  }
  if (!entries.length) list.innerHTML = '<span class="hint">No mappings yet.</span>';
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
    undoHistory.push('Change swing', 'swing');
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

// precise keeps two decimals, for tempos coming from an external MIDI clock.
function setBpm(v, precise = false) {
  const rounded = precise ? Math.round(v * 100) / 100 : Math.round(v);
  const bpm = Math.max(40, Math.min(250, rounded || state.bpm));
  // Tempo coming from MIDI clock isn't an edit, so it isn't undoable.
  if (!precise && bpm !== state.bpm) undoHistory.push('Change tempo', 'bpm');
  state.bpm = bpm;
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
    undoHistory.push('Record sample');
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
  undoHistory.clear();
  seq.queued = null;
  engine.mixer.applyMaster(true);
  engine.mixer.setReverbSize(state.master.reverbSize);
  ui.page = 0;
  refreshAll();
}

// ---------- Keyboard & frame loop ----------

function bindKeys() {
  const typing = (el) => el.tagName === 'INPUT' && ['number', 'text', 'search'].includes(el.type);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.code === 'KeyB') { e.preventDefault(); setBrowserOpen(!browser.prefs.open); return; }
    if (e.ctrlKey && e.code === 'KeyF') {
      e.preventDefault();
      setBrowserOpen(true);
      $('#bSearch').focus();
      $('#bSearch').select();
      return;
    }
    if (typing(e.target)) return;
    if (e.code === 'Escape' && ui.learn) { setLearn(false); return; }
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); undo(e.shiftKey); return; }
    if (e.ctrlKey && e.code === 'KeyY') { e.preventDefault(); undo(true); return; }
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
  browser.tick();
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
  buildMidi();
  bindKeys();
  $('#btnBrowser').addEventListener('click', () => setBrowserOpen(!browser.prefs.open));
  setBrowserOpen(browser.prefs.open);
  selectPad(0);
  refreshAll();
  requestAnimationFrame(frame);
  await browser.init();
  try {
    await midi.init();
  } catch (err) {
    console.warn('MIDI unavailable:', err);
  }
  refreshMidi();
}

main().catch((err) => {
  console.error(err);
  toast(`Startup failed: ${err.message}`, true);
});
