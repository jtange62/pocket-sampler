'use strict';
// DSP helpers: AudioWorklet processors, non-destructive buffer edits,
// transient detection, waveform peaks and WAV/base64 encoding.

const DSP = (() => {
  const WORKLETS = `
class CrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'reduce', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.phase = [0, 0]; this.held = [0, 0]; }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    const bits = parameters.bits[0], reduce = parameters.reduce[0];
    const bypass = bits >= 16 && reduce <= 1;
    const levels = Math.pow(2, bits - 1);
    for (let ch = 0; ch < output.length; ch++) {
      const out = output[ch];
      const inp = input.length ? (input[ch] || input[0]) : null;
      if (!inp) { out.fill(0); continue; }
      if (bypass) { out.set(inp); continue; }
      let phase = this.phase[ch], held = this.held[ch];
      for (let i = 0; i < out.length; i++) {
        phase += 1;
        if (phase >= reduce) { phase -= reduce; held = Math.round(inp[i] * levels) / levels; }
        out[i] = held;
      }
      this.phase[ch] = phase; this.held[ch] = held;
    }
    return true;
  }
}
registerProcessor('crusher', CrusherProcessor);

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.size = 8192;
    this.reset();
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.reset(); this.on = true; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  reset() { this.l = new Float32Array(this.size); this.r = new Float32Array(this.size); this.n = 0; }
  flush() {
    if (this.n) {
      const l = this.l.slice(0, this.n), r = this.r.slice(0, this.n);
      this.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    }
    this.reset();
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
      const a = inp[0], b = inp[1] || inp[0];
      for (let i = 0; i < a.length; i++) {
        this.l[this.n] = a[i];
        this.r[this.n] = b[i];
        if (++this.n === this.size) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);
`;
  const workletURL = URL.createObjectURL(new Blob([WORKLETS], { type: 'application/javascript' }));

  function loadWorklets(ctx) {
    return ctx.audioWorklet.addModule(workletURL);
  }

  function makeBuffer(channels, length, sampleRate) {
    return new AudioBuffer({ numberOfChannels: channels, length: Math.max(1, length), sampleRate });
  }

  function channels(buf) {
    return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  }

  function makeImpulse(ctx, seconds, decay = 3) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  // Frames [a, b) as a new buffer.
  function slice(buf, a, b) {
    a = Math.max(0, Math.min(buf.length, a));
    b = Math.max(a + 1, Math.min(buf.length, b));
    const out = makeBuffer(buf.numberOfChannels, b - a, buf.sampleRate);
    channels(buf).forEach((d, c) => out.copyToChannel(d.subarray(a, b), c));
    return out;
  }

  // Region given as fractions of the buffer length.
  function region(buf, startFrac = 0, endFrac = 1) {
    return slice(buf, Math.floor(startFrac * buf.length), Math.ceil(endFrac * buf.length));
  }

  function reverse(buf) {
    const out = makeBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    channels(buf).forEach((d, c) => out.copyToChannel(d.slice().reverse(), c));
    return out;
  }

  function peakOf(buf) {
    let peak = 0;
    for (const d of channels(buf)) for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  function normalize(buf, target = 0.98) {
    const peak = peakOf(buf);
    if (peak < 1e-6) return buf;
    const gain = target / peak;
    const out = makeBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    channels(buf).forEach((d, c) => out.copyToChannel(d.map((v) => v * gain), c));
    return out;
  }

  // Cut leading/trailing silence from a recording. Returns null if it's all silence.
  function trimSilence(buf, thresholdDb = -50) {
    const thr = Math.pow(10, thresholdDb / 20);
    const chans = channels(buf);
    const loud = (i) => chans.some((d) => Math.abs(d[i]) > thr);
    let first = 0;
    while (first < buf.length && !loud(first)) first++;
    if (first === buf.length) return null;
    let last = buf.length - 1;
    while (last > first && !loud(last)) last--;
    const pre = Math.round(0.005 * buf.sampleRate), post = Math.round(0.08 * buf.sampleRate);
    return slice(buf, first - pre, last + post);
  }

  // Frame positions where hits start. Always includes 0; at most maxSlices entries.
  function detectOnsets(buf, maxSlices) {
    const hop = 512, win = 1024, sr = buf.sampleRate;
    const chans = channels(buf);
    const mono = new Float32Array(buf.length);
    for (const d of chans) for (let i = 0; i < d.length; i++) mono[i] += d[i] / chans.length;

    const frames = Math.floor((mono.length - win) / hop) + 1;
    if (frames < 3) return [0];
    const db = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let i = f * hop, e = i + win; i < e; i++) s += mono[i] * mono[i];
      db[f] = 10 * Math.log10(s / win + 1e-12);
    }
    const flux = new Float32Array(frames);
    for (let f = 1; f < frames; f++) flux[f] = db[f] > -45 ? Math.max(0, db[f] - db[f - 1]) : 0;

    const minGap = Math.round((0.08 * sr) / hop);
    const candidates = [];
    for (let f = 1; f < frames; f++) {
      if (flux[f] < 3) continue;
      let isPeak = true;
      for (let k = Math.max(1, f - 3); k <= Math.min(frames - 1, f + 3); k++) {
        if (flux[k] > flux[f]) { isPeak = false; break; }
      }
      if (isPeak) candidates.push({ f, strength: flux[f] });
    }
    candidates.sort((a, b) => b.strength - a.strength);
    const picked = [];
    for (const c of candidates) {
      if (c.f < minGap) continue; // too close to the start, which is always a slice
      if (picked.some((p) => Math.abs(p - c.f) < minGap)) continue;
      picked.push(c.f);
      if (picked.length >= maxSlices - 1) break;
    }

    // Refine each onset to the first sample that reaches 30% of the local peak.
    const backoff = Math.round(0.002 * sr);
    const points = picked.map((f) => {
      const a = f * hop, b = Math.min(mono.length, a + win);
      let peak = 0;
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(mono[i]));
      let i = a;
      while (i < b && Math.abs(mono[i]) < peak * 0.3) i++;
      return Math.max(0, i - backoff);
    });
    return [0, ...points].sort((a, b) => a - b);
  }

  // Min/max pairs per pixel column over frames [a, b).
  function peaks(buf, cols, a = 0, b = buf.length) {
    const out = new Float32Array(cols * 2);
    const chans = channels(buf);
    const span = (b - a) / cols;
    for (let x = 0; x < cols; x++) {
      const s = Math.floor(a + x * span);
      const e = Math.min(b, Math.max(s + 1, Math.floor(a + (x + 1) * span)));
      let lo = 0, hi = 0;
      for (const d of chans) for (let i = s; i < e; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[2 * x] = lo;
      out[2 * x + 1] = hi;
    }
    return out;
  }

  // 16-bit PCM WAV.
  function encodeWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const blockAlign = ch * 2, dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * blockAlign, true); v.setUint16(32, blockAlign, true);
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, dataSize, true);
    const chans = channels(buf);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return ab;
  }

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  return {
    loadWorklets, makeImpulse, slice, region, reverse, normalize, peakOf, trimSilence,
    detectOnsets, peaks, encodeWav, bytesToBase64, base64ToBytes,
  };
})();
