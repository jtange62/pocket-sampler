'use strict';
// Audio engine: app state, the master FX bus (Mixer) and voice playback.
// A Mixer can be built on the live AudioContext or on an OfflineAudioContext
// for WAV export, so both paths sound identical.

const PAD_COUNT = 16;

const DELAY_DIVISIONS = { '1/2': 2, '1/4': 1, '1/4t': 2 / 3, '1/8d': 0.75, '1/8': 0.5, '1/8t': 1 / 3, '1/16': 0.25 };

function defaultPad() {
  return {
    name: '', buffer: null, start: 0, end: 1,
    gain: 0.8, pan: 0, pitch: 0, fine: 0,
    cutoff: 20000, resonance: 0.7, attack: 0.002, release: 0.08,
    reverbSend: 0, delaySend: 0,
    mode: 'oneshot', loop: false, choke: 0, mute: false,
  };
}

function createState() {
  return {
    bpm: 90, swing: 50, quantize: 4, metronome: false, currentPattern: 0,
    pads: Array.from({ length: PAD_COUNT }, defaultPad),
    patterns: Array.from({ length: 4 }, () => ({ bars: 1, notes: [] })),
    master: {
      volume: 0.8, filter: 0,
      reverbSize: 2.5, reverbLevel: 0.8,
      delayDiv: '1/8d', delayFeedback: 0.35, delayLevel: 0.7,
      bits: 16, downsample: 1,
    },
  };
}

class Mixer {
  constructor(ctx, state) {
    this.ctx = ctx;
    this.state = state;
    this.voices = Array.from({ length: PAD_COUNT }, () => new Set());
    this.last = new Array(PAD_COUNT).fill(null);

    this.input = ctx.createGain();
    this.reverbIn = ctx.createGain();
    this.reverbReturn = ctx.createGain();
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.delayFb = ctx.createGain();
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 4500;
    this.delayReturn = ctx.createGain();
    this.crusher = new AudioWorkletNode(ctx, 'crusher', { outputChannelCount: [2] });
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.out = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;

    this.reverbReturn.connect(this.input);
    this.delayIn.connect(this.delay);
    this.delay.connect(this.delayTone).connect(this.delayFb).connect(this.delay);
    this.delay.connect(this.delayReturn).connect(this.input);
    this.input.connect(this.crusher).connect(this.lp).connect(this.hp).connect(this.out).connect(this.limiter);
    this.output = this.limiter;

    this.reverb = null;
    this.setReverbSize(state.master.reverbSize);
    this.applyMaster(false);
  }

  delayTime() {
    const beats = DELAY_DIVISIONS[this.state.master.delayDiv] ?? 0.75;
    return Math.min(3.9, (beats * 60) / this.state.bpm);
  }

  applyMaster(smooth = true) {
    const m = this.state.master, now = this.ctx.currentTime;
    const set = (param, v) => (smooth ? param.setTargetAtTime(v, now, 0.015) : (param.value = v));
    const f = m.filter;
    set(this.out.gain, m.volume);
    set(this.lp.frequency, f < 0 ? 20000 * Math.pow(0.005, -f) : 20000); // down to 100 Hz
    set(this.hp.frequency, f > 0 ? 20 * Math.pow(400, f) : 20); // up to 8 kHz
    set(this.lp.Q, f < 0 ? 0.7 - f * 4 : 0.7);
    set(this.hp.Q, f > 0 ? 0.7 + f * 4 : 0.7);
    set(this.reverbReturn.gain, m.reverbLevel);
    set(this.delay.delayTime, this.delayTime());
    set(this.delayFb.gain, m.delayFeedback);
    set(this.delayReturn.gain, m.delayLevel);
    this.crusher.parameters.get('bits').value = m.bits;
    this.crusher.parameters.get('reduce').value = m.downsample;
  }

  // Swap in a fresh convolver so a resize never glitches the old tail mid-update.
  setReverbSize(seconds) {
    const conv = this.ctx.createConvolver();
    conv.buffer = DSP.makeImpulse(this.ctx, seconds);
    this.reverbIn.connect(conv);
    conv.connect(this.reverbReturn);
    if (this.reverb) {
      this.reverbIn.disconnect(this.reverb);
      this.reverb.disconnect();
    }
    this.reverb = conv;
  }

  // gateDur only applies to pads in gate mode (sequencer note length).
  playPad(i, when = this.ctx.currentTime, vel = 1, gateDur = null) {
    const p = this.state.pads[i];
    if (!p.buffer) return null;
    const ctx = this.ctx;

    // Pads are monophonic; choke groups cut each other (e.g. open/closed hats).
    this.cut(i, when);
    if (p.choke) this.state.pads.forEach((q, j) => { if (j !== i && q.choke === p.choke) this.cut(j, when); });

    const dur = p.buffer.duration;
    const offset = p.start * dur;
    const len = Math.max(0.005, (p.end - p.start) * dur);
    const rate = Math.pow(2, (p.pitch + p.fine / 100) / 12);

    const src = ctx.createBufferSource();
    src.buffer = p.buffer;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    filter.Q.value = p.resonance;
    const env = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = p.pan;
    src.connect(filter).connect(env).connect(pan).connect(this.input);
    if (p.reverbSend > 0) {
      const send = ctx.createGain();
      send.gain.value = p.reverbSend;
      pan.connect(send).connect(this.reverbIn);
    }
    if (p.delaySend > 0) {
      const send = ctx.createGain();
      send.gain.value = p.delaySend;
      pan.connect(send).connect(this.delayIn);
    }

    const level = vel * p.gain;
    const atk = Math.max(0.001, p.attack);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + atk);

    let endTime = Infinity;
    if (p.loop) {
      src.loop = true;
      src.loopStart = offset;
      src.loopEnd = offset + len;
      src.start(when, offset);
    } else {
      src.start(when, offset, len);
      endTime = when + len / rate;
      // Short fade at the natural end so cut samples don't click.
      const fadeStart = Math.max(when + atk, endTime - 0.004);
      if (fadeStart < endTime) {
        env.gain.setValueAtTime(level, fadeStart);
        env.gain.linearRampToValueAtTime(0, endTime);
      }
    }

    const voice = { pad: i, src, env, startTime: when, offset, len, rate, loop: p.loop, endTime, releaseAt: Infinity, ended: false };
    src.onended = () => {
      voice.ended = true;
      this.voices[i].delete(voice);
    };
    this.voices[i].add(voice);
    this.last[i] = voice;

    if (p.mode === 'gate' && gateDur != null) this.releaseVoice(voice, when + Math.max(gateDur, atk));
    return voice;
  }

  // Fade a voice out from time t. Can pull an already scheduled release earlier.
  releaseVoice(v, t, rel = null) {
    t = Math.max(t, v.startTime);
    if (t >= v.releaseAt || t >= v.endTime) return;
    v.releaseAt = t;
    const r = rel ?? Math.max(0.005, this.state.pads[v.pad].release);
    v.env.gain.cancelAndHoldAtTime(t);
    v.env.gain.linearRampToValueAtTime(0, t + r);
    const stopAt = t + r + 0.01;
    if (stopAt < v.endTime) {
      try { v.src.stop(stopAt); } catch (e) { /* already stopped */ }
      v.endTime = stopAt;
    }
  }

  cut(i, t) {
    for (const v of this.voices[i]) this.releaseVoice(v, t, 0.004);
  }

  cutAll(t) {
    for (let i = 0; i < PAD_COUNT; i++) this.cut(i, t);
  }
}

class Engine {
  constructor(state) {
    this.state = state;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.held = new Map();
  }

  async init() {
    await DSP.loadWorklets(this.ctx);
    this.mixer = new Mixer(this.ctx, this.state);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.mixer.output.connect(this.analyser);
    this.mixer.output.connect(this.ctx.destination);
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  padDown(i, vel = 1) {
    this.resume();
    const p = this.state.pads[i];
    const now = this.ctx.currentTime;
    // A looping one-shot pad toggles: a second press stops it.
    if (p.loop && p.mode === 'oneshot') {
      const v = this.mixer.last[i];
      if (v && !v.ended && v.releaseAt === Infinity) {
        this.mixer.releaseVoice(v, now);
        return null;
      }
    }
    const v = this.mixer.playPad(i, now, vel);
    if (v) this.held.set(i, v);
    return v;
  }

  padUp(i) {
    const v = this.held.get(i);
    this.held.delete(i);
    if (v && this.state.pads[i].mode === 'gate') this.mixer.releaseVoice(v, this.ctx.currentTime);
  }

  stopAll() {
    this.mixer.cutAll(this.ctx.currentTime);
  }

  // Metronome goes straight to the speakers so it's never sampled or exported.
  click(time, accent) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.35, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    o.connect(g).connect(this.ctx.destination);
    o.start(time);
    o.stop(time + 0.06);
  }
}
