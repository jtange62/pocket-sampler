'use strict';
// Pattern sequencer: lookahead clock, live recording with quantize,
// step editing, undo and offline rendering.
// Notes live on a tick grid: 4 ticks per 16th step, 64 ticks per bar.

const TICKS_PER_STEP = 4;
const STEPS_PER_BAR = 16;
const TICKS_PER_BAR = TICKS_PER_STEP * STEPS_PER_BAR;
const LOOKAHEAD = 0.12;

class Sequencer {
  constructor(engine, state) {
    this.engine = engine;
    this.state = state;
    this.playing = false;
    this.recording = false;
    this.tick = 0;
    this.absTick = 0; // ticks since play, never wraps (MIDI clock sync)
    this.nextTime = 0;
    this.history = [];
    this.queued = null;
    this.undoStack = [];
    this.recHeld = new Map();
    this.timer = null;
    this.onNote = null;
    this.onTick = null;
    this.onPlay = null;
    this.onStop = null;
    this.onPatternChange = null;
  }

  get pattern() { return this.state.patterns[this.state.currentPattern]; }
  get totalTicks() { return this.pattern.bars * TICKS_PER_BAR; }

  secPerTick() {
    return 60 / this.state.bpm / (TICKS_PER_BAR / 4);
  }

  // MPC-style swing: 50% is straight, 66% is a triplet feel; shifts odd 16ths.
  swingDelay(tick) {
    if (Math.floor(tick / TICKS_PER_STEP) % 2 === 0) return 0;
    return (this.state.swing / 100 - 0.5) * 2 * this.secPerTick() * TICKS_PER_STEP;
  }

  play(startTime = null) {
    if (this.playing) return;
    this.engine.resume();
    this.playing = true;
    this.tick = 0;
    this.absTick = 0;
    this.history = [];
    this.nextTime = startTime ?? this.engine.ctx.currentTime + 0.06;
    if (this.onPlay) this.onPlay(this.nextTime);
    this.pump();
    this.timer = setInterval(() => this.pump(), 20);
  }

  stop() {
    if (!this.playing) return;
    clearInterval(this.timer);
    this.playing = false;
    this.recording = false;
    this.recHeld.clear();
    if (this.queued != null) {
      this.state.currentPattern = this.queued;
      this.queued = null;
      if (this.onPatternChange) this.onPatternChange();
    }
    for (const n of this.pattern.notes) delete n.skip;
    this.engine.stopAll();
    if (this.onStop) this.onStop();
  }

  pump() {
    const horizon = this.engine.ctx.currentTime + LOOKAHEAD;
    while (this.nextTime < horizon) {
      if (this.tick === 0 && this.queued != null) {
        this.state.currentPattern = this.queued;
        this.queued = null;
        if (this.onPatternChange) this.onPatternChange();
      }
      const spt = this.secPerTick();
      this.scheduleTick(this.tick, this.nextTime);
      this.history.push({ tick: this.tick, abs: this.absTick, time: this.nextTime });
      if (this.history.length > 256) this.history.shift();
      if (this.onTick) this.onTick(this.absTick, this.nextTime, spt);
      this.nextTime += spt;
      this.tick = (this.tick + 1) % this.totalTicks;
      this.absTick++;
    }
  }

  // Phase-lock to an external MIDI clock: compare when tick `abs` was scheduled
  // with when the master says it happened, and pull the clock part way back.
  nudge(abs, heardTime) {
    if (!this.playing) return;
    if (abs >= this.absTick) {
      // We're behind the master: skip ahead silently instead of bursting notes.
      while (this.absTick < abs) {
        this.absTick++;
        this.tick = (this.tick + 1) % this.totalTicks;
      }
      this.nextTime = heardTime;
      return;
    }
    const e = this.history.find((h) => h.abs === abs);
    if (!e) return;
    const err = e.time - heardTime;
    this.nextTime -= Math.abs(err) > 0.25 ? err : err * 0.5;
    this.nextTime = Math.max(this.nextTime, this.engine.ctx.currentTime);
  }

  scheduleTick(tick, time) {
    const spt = this.secPerTick();
    for (const n of this.pattern.notes) {
      if (n.tick !== tick) continue;
      if (n.skip) { delete n.skip; continue; }
      if (this.state.pads[n.pad].mute) continue;
      const t = time + this.swingDelay(tick);
      this.engine.mixer.playPad(n.pad, t, n.vel, n.len * spt);
      if (this.onNote) this.onNote(n.pad, t, n.vel, n.len * spt);
    }
    if (this.state.metronome && tick % (TICKS_PER_BAR / 4) === 0) this.engine.click(time, tick % TICKS_PER_BAR === 0);
  }

  // Fractional tick position of what's audible right now, or null.
  currentTickFloat() {
    if (!this.playing) return null;
    const now = this.engine.ctx.currentTime;
    for (let k = this.history.length - 1; k >= 0; k--) {
      const e = this.history[k];
      if (e.time <= now) return (e.tick + (now - e.time) / this.secPerTick()) % this.totalTicks;
    }
    return null;
  }

  recordHit(pad, vel = 1) {
    if (!this.playing || !this.recording) return null;
    const total = this.totalTicks;
    const pos = this.currentTickFloat() ?? 0;
    const q = this.state.quantize;
    const target = (Math.round(pos / q) * q) % total;
    this.pushUndo();
    const pat = this.pattern;
    pat.notes = pat.notes.filter((n) => !(n.pad === pad && n.tick === target));
    const note = { pad, tick: target, vel, len: TICKS_PER_STEP };
    // The hit was already heard live. If quantize moved it forward onto a tick
    // the clock hasn't scheduled yet, skip that one playback to avoid a double hit.
    const now = Math.floor(pos);
    const fwd = (target - now + total) % total;
    const cursorFwd = (this.tick - now + total) % total;
    if (fwd > 0 && fwd < total / 2 && fwd >= cursorFwd) note.skip = true;
    pat.notes.push(note);
    this.recHeld.set(pad, { note, startPos: pos });
    return note;
  }

  recordRelease(pad) {
    const held = this.recHeld.get(pad);
    if (!held) return;
    this.recHeld.delete(pad);
    const pos = this.currentTickFloat();
    if (pos == null) return;
    const len = (pos - held.startPos + this.totalTicks) % this.totalTicks;
    held.note.len = Math.max(1, Math.round(len));
  }

  hasStep(pad, step) {
    const a = step * TICKS_PER_STEP;
    return this.pattern.notes.some((n) => n.pad === pad && n.tick >= a && n.tick < a + TICKS_PER_STEP);
  }

  setStep(pad, step, on) {
    const a = step * TICKS_PER_STEP, pat = this.pattern;
    pat.notes = pat.notes.filter((n) => !(n.pad === pad && n.tick >= a && n.tick < a + TICKS_PER_STEP));
    if (on) pat.notes.push({ pad, tick: a, vel: 1, len: TICKS_PER_STEP });
  }

  pushUndo(index = this.state.currentPattern) {
    const p = this.state.patterns[index];
    this.undoStack.push({ index, bars: p.bars, notes: p.notes.map(({ skip, ...n }) => ({ ...n })) });
    if (this.undoStack.length > 64) this.undoStack.shift();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    const p = this.state.patterns[s.index];
    p.bars = s.bars;
    p.notes = s.notes;
    this.tick %= this.totalTicks;
    return true;
  }

  clearPattern() {
    this.pushUndo();
    this.pattern.notes = [];
  }

  clearPad(pad) {
    this.pushUndo();
    this.pattern.notes = this.pattern.notes.filter((n) => n.pad !== pad);
  }

  // Growing a pattern repeats its content; shrinking drops notes past the end.
  setBars(bars) {
    const pat = this.pattern;
    if (bars === pat.bars) return;
    this.pushUndo();
    const oldTicks = pat.bars * TICKS_PER_BAR, newTicks = bars * TICKS_PER_BAR;
    if (bars > pat.bars) {
      const copies = [];
      for (let off = oldTicks; off < newTicks; off += oldTicks) {
        for (const { skip, ...n } of pat.notes) if (n.tick + off < newTicks) copies.push({ ...n, tick: n.tick + off });
      }
      pat.notes.push(...copies);
    } else {
      pat.notes = pat.notes.filter((n) => n.tick < newTicks);
    }
    pat.bars = bars;
    this.tick %= this.totalTicks;
  }

  // While playing, switching waits for the end of the current loop.
  selectPattern(k) {
    if (this.playing && k !== this.state.currentPattern) this.queued = this.queued === k ? null : k;
    else {
      this.queued = null;
      this.state.currentPattern = k;
    }
  }

  copyPattern(from, to) {
    this.pushUndo(to);
    const src = this.state.patterns[from];
    this.state.patterns[to] = { bars: src.bars, notes: src.notes.map(({ skip, ...n }) => ({ ...n })) };
  }

  async render(loops, withTail) {
    const sr = this.engine.ctx.sampleRate;
    const spt = this.secPerTick(), total = this.totalTicks;
    const loopDur = total * spt;
    const length = Math.ceil((loopDur * loops + (withTail ? 3 : 0)) * sr);
    const ctx = new OfflineAudioContext(2, length, sr);
    await DSP.loadWorklets(ctx);
    const mixer = new Mixer(ctx, this.state);
    mixer.output.connect(ctx.destination);
    const notes = [...this.pattern.notes].sort((a, b) => a.tick - b.tick);
    for (let l = 0; l < loops; l++) {
      for (const n of notes) {
        if (this.state.pads[n.pad].mute) continue;
        const t = (l * total + n.tick) * spt + this.swingDelay(n.tick);
        mixer.playPad(n.pad, t, n.vel, n.len * spt);
      }
    }
    return ctx.startRendering();
  }
}
