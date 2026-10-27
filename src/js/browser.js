'use strict';
// Sample library browser (left sidebar): folders added as places, a lazily
// loaded folder tree, search across every place, click-to-preview and drag
// onto pads. Previews go straight to the speakers, before any FX.

const BROWSER_PREFS_KEY = 'pocket-sampler.browser';
const SAMPLE_DRAG_TYPE = 'application/x-pocket-sampler-item';
const PREVIEW_CACHE_SIZE = 24;

class SampleBrowser {
  constructor(engine, { onLoad, toast }) {
    this.engine = engine;
    this.onLoad = onLoad; // (items) => load into the selected pad onward
    this.toast = toast;
    this.api = window.native && window.native.library;
    this.roots = [];
    this.children = new Map(); // folder path -> entries
    this.prefs = { open: true, autoPreview: true, volume: 0.7, expanded: [] };
    try {
      Object.assign(this.prefs, JSON.parse(localStorage.getItem(BROWSER_PREFS_KEY)) || {});
    } catch (e) { /* storage unavailable: keep defaults */ }
    this.expanded = new Set(this.prefs.expanded);
    this.rows = [];
    this.selPath = null;
    this.results = null; // search results, or null when showing the tree
    this.searchToken = 0;
    this.cache = new Map(); // path -> decoded AudioBuffer, most recent last
    this.preview = null; // the playing preview voice
    this.previewItem = null;
    this.previewPeaks = null;
    this.previewToken = 0;
    this.headDrawn = false;
    const q = (s) => document.querySelector(s);
    this.el = { list: q('#bList'), search: q('#bSearch'), name: q('#bPreviewName'), wave: q('#bWave'), auto: q('#bAuto'), vol: q('#bVol') };
  }

  async init() {
    this.bind();
    this.el.auto.classList.toggle('active', this.prefs.autoPreview);
    this.el.vol.value = this.prefs.volume;
    if (!this.api) {
      this.el.list.innerHTML = '<div class="bempty">The library needs the desktop app.</div>';
      return;
    }
    await this.loadRoots();
  }

  savePrefs() {
    this.prefs.expanded = [...this.expanded];
    try { localStorage.setItem(BROWSER_PREFS_KEY, JSON.stringify(this.prefs)); } catch (e) { /* ignore */ }
  }

  async loadRoots(roots = null) {
    this.roots = roots || (await this.api.roots());
    await Promise.all([...this.expanded].map((p) => this.fetchChildren(p)));
    this.render();
  }

  async fetchChildren(dir) {
    try {
      this.children.set(dir, await this.api.list(dir));
    } catch (e) {
      // Folder vanished or was removed from the library.
      this.children.delete(dir);
      this.expanded.delete(dir);
    }
  }

  flatten() {
    const rows = [];
    const walk = (entries, depth) => {
      for (const e of entries) {
        rows.push({ ...e, depth });
        if (!e.dir || !this.expanded.has(e.path)) continue;
        const kids = this.children.get(e.path);
        if (kids) walk(kids, depth + 1);
        else rows.push({ loading: true, depth: depth + 1 });
      }
    };
    walk(this.roots.map((r) => ({ name: r.name, path: r.path, dir: true, root: true })), 0);
    return rows;
  }

  render() {
    const list = this.el.list;
    this.rows = this.results || this.flatten();
    list.innerHTML = '';
    if (!this.results && !this.roots.length) {
      list.innerHTML = '<div class="bempty">Add a folder with your samples to browse it here.<br><button data-act="add">+ Add folder</button></div>';
      return;
    }
    if (this.results && !this.results.length) {
      const msg = document.createElement('div');
      msg.className = 'bempty';
      msg.textContent = `No samples match "${this.el.search.value.trim()}".`;
      list.appendChild(msg);
      return;
    }
    const frag = document.createDocumentFragment();
    this.rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.dataset.i = i;
      row.style.paddingLeft = `${6 + r.depth * 14}px`;
      if (r.loading) {
        row.className = 'brow loading';
        row.textContent = 'Loading…';
        frag.appendChild(row);
        return;
      }
      row.className = `brow${r.dir ? ' dir' : ''}${r.root ? ' root' : ''}${r.path === this.selPath ? ' sel' : ''}`;
      row.draggable = true;
      row.title = r.path;
      const caret = r.dir ? (this.expanded.has(r.path) ? '▾' : '▸') : '';
      row.innerHTML = `<span class="caret">${caret}</span><span class="bname"></span>`
        + (r.sub != null ? '<span class="bsub"></span>' : '')
        + (r.root ? '<button class="bremove" title="Remove from library (files are not deleted)">×</button>' : '');
      row.querySelector('.bname').textContent = r.dir ? r.name : r.name.replace(/\.[^.]+$/, '');
      if (r.sub != null) row.querySelector('.bsub').textContent = r.sub;
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  rowOf(e) {
    const el = e.target.closest('.brow');
    if (!el || el.classList.contains('loading')) return null;
    return this.rows[+el.dataset.i] || null;
  }

  bind() {
    const { list, search, auto, vol, wave } = this.el;
    list.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="add"]')) return this.addFolder();
      const r = this.rowOf(e);
      if (!r) return;
      if (e.target.classList.contains('bremove')) return this.removeRoot(r.path);
      this.select(r);
      if (r.dir) this.toggle(r);
    });
    list.addEventListener('dblclick', (e) => {
      const r = this.rowOf(e);
      if (r && !r.dir) this.load(r);
    });
    list.addEventListener('dragstart', (e) => {
      const r = this.rowOf(e);
      if (!r) return e.preventDefault();
      e.dataTransfer.setData(SAMPLE_DRAG_TYPE, JSON.stringify({ name: r.name, path: r.path, dir: !!r.dir }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    list.addEventListener('keydown', (e) => this.onKey(e));

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.search(search.value), 180);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && this.rows.length) {
        e.preventDefault();
        list.focus();
        this.select(this.rows.find((r) => !r.loading));
      } else if (e.key === 'Escape') {
        search.value = '';
        this.search('');
        search.blur();
      }
    });

    auto.addEventListener('click', () => {
      this.prefs.autoPreview = !this.prefs.autoPreview;
      auto.classList.toggle('active', this.prefs.autoPreview);
      if (!this.prefs.autoPreview) this.stopPreview();
      this.savePrefs();
    });
    vol.addEventListener('input', () => {
      this.prefs.volume = +vol.value;
      if (this.preview) this.preview.gain.gain.value = this.prefs.volume;
    });
    vol.addEventListener('change', () => { this.savePrefs(); vol.blur(); });
    // Click the preview waveform to play from that point.
    wave.addEventListener('pointerdown', (e) => {
      const buf = this.previewItem && this.previewItem.buffer;
      if (!buf) return;
      const r = wave.getBoundingClientRect();
      this.play(buf, ((e.clientX - r.left) / r.width) * buf.duration);
    });

    document.querySelector('#bAdd').addEventListener('click', () => this.addFolder());
    document.querySelector('#bRefresh').addEventListener('click', async () => {
      await this.api.refresh();
      this.children.clear();
      await this.loadRoots();
      if (this.results) this.search(search.value);
      this.toast('Library rescanned');
    });
  }

  onKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const i = this.rows.findIndex((r) => r.path === this.selPath && !r.loading);
    const r = this.rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let j = i < 0 ? 0 : i + step;
      while (this.rows[j] && this.rows[j].loading) j += step;
      if (this.rows[j]) this.select(this.rows[j]);
    } else if (!r) {
      // nothing selected
    } else if (e.key === 'ArrowRight') {
      if (r.dir && !this.expanded.has(r.path)) this.toggle(r);
    } else if (e.key === 'ArrowLeft') {
      if (r.dir && this.expanded.has(r.path)) this.toggle(r);
      else {
        for (let k = i - 1; k >= 0; k--) {
          if (this.rows[k].depth === r.depth - 1) { this.select(this.rows[k]); break; }
        }
      }
    } else if (e.key === 'Enter') {
      if (r.dir) this.toggle(r);
      else this.load(r);
    }
  }

  select(r) {
    if (!r) return;
    this.selPath = r.path;
    const list = this.el.list;
    list.querySelectorAll('.brow.sel').forEach((el) => el.classList.remove('sel'));
    const el = list.querySelector(`.brow[data-i="${this.rows.indexOf(r)}"]`);
    if (el) {
      el.classList.add('sel');
      el.scrollIntoView({ block: 'nearest' });
    }
    if (!r.dir) this.showPreview(r, this.prefs.autoPreview);
  }

  async toggle(r) {
    if (this.expanded.has(r.path)) this.expanded.delete(r.path);
    else {
      this.expanded.add(r.path);
      if (!this.children.has(r.path)) {
        this.render();
        await this.fetchChildren(r.path);
      }
    }
    this.savePrefs();
    this.render();
  }

  async search(query) {
    const token = ++this.searchToken;
    if (!query.trim()) {
      this.results = null;
      this.render();
      return;
    }
    this.el.list.innerHTML = '<div class="bempty">Searching…</div>';
    try {
      const res = await this.api.search(query);
      if (token !== this.searchToken) return;
      this.results = res.map((r) => ({ ...r, depth: 0 }));
      this.render();
    } catch (err) {
      this.toast(`Search failed: ${err.message}`, true);
    }
  }

  async addFolder() {
    if (!this.api) return;
    await this.loadRoots(await this.api.add());
    if (this.results) this.search(this.el.search.value);
  }

  async removeRoot(dir) {
    await this.loadRoots(await this.api.remove(dir));
    if (this.results) this.search(this.el.search.value);
  }

  load(r) {
    this.onLoad([{ name: r.name, path: r.path, dir: !!r.dir }]);
  }

  // Decoded samples are cached, so loading something just previewed is instant.
  async getBuffer(file) {
    if (this.cache.has(file)) {
      const hit = this.cache.get(file);
      this.cache.delete(file);
      this.cache.set(file, hit);
      return hit;
    }
    const bytes = await this.api.read(file);
    const buf = await this.engine.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    this.cache.set(file, buf);
    while (this.cache.size > PREVIEW_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
    return buf;
  }

  async showPreview(r, play) {
    this.stopPreview();
    const token = ++this.previewToken;
    this.previewItem = { path: r.path, buffer: null };
    this.previewPeaks = null;
    this.el.name.textContent = r.name;
    this.drawPreview();
    try {
      const buf = await this.getBuffer(r.path);
      if (token !== this.previewToken) return;
      this.previewItem.buffer = buf;
      this.el.name.textContent = `${r.name} · ${buf.duration.toFixed(2)} s`;
      this.drawPreview();
      if (play) this.play(buf, 0);
    } catch (err) {
      if (token === this.previewToken) this.el.name.textContent = `${r.name} · can't read this file`;
    }
  }

  play(buf, offset) {
    this.stopPreview();
    this.engine.resume();
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = this.prefs.volume;
    src.connect(gain).connect(ctx.destination);
    src.start(ctx.currentTime, Math.max(0, offset));
    const voice = { src, gain, buffer: buf, startedAt: ctx.currentTime - offset };
    src.onended = () => { if (this.preview === voice) this.preview = null; };
    this.preview = voice;
  }

  stopPreview() {
    if (!this.preview) return;
    try { this.preview.src.stop(); } catch (e) { /* already ended */ }
    this.preview = null;
  }

  // Called every animation frame; only redraws while a preview plays (and once after).
  tick() {
    if (this.preview || this.headDrawn) this.drawPreview();
  }

  drawPreview() {
    const c = this.el.wave;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    this.headDrawn = false;
    const buf = this.previewItem && this.previewItem.buffer;
    if (!buf) return;
    if (!this.previewPeaks || this.previewPeaks.w !== w) this.previewPeaks = { w, data: DSP.peaks(buf, w) };
    const pk = this.previewPeaks.data;
    g.fillStyle = '#7fa6e6';
    for (let x = 0; x < w; x++) {
      const y0 = (1 - pk[2 * x + 1]) * h / 2, y1 = (1 - pk[2 * x]) * h / 2;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    if (this.preview && this.preview.buffer === buf) {
      const pos = (this.engine.ctx.currentTime - this.preview.startedAt) / buf.duration;
      if (pos >= 0 && pos <= 1) {
        g.fillStyle = '#fff';
        g.fillRect(pos * w, 0, dpr, h);
        this.headDrawn = true;
      }
    }
  }
}
