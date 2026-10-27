'use strict';
// MIDI: controller input (pads, MIDI learn), clock sync in and out, sequencer
// note out, and Standard MIDI File export. Device settings are per machine,
// so they live in localStorage rather than in project files.

const MIDI_SETTINGS_KEY = 'pocket-sampler.midi';
const CLOCKS_PER_TICK = 24 / (TICKS_PER_BAR / 4); // MIDI clock is 24 per quarter
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Octave numbering where note 36 is C1 (Ableton, most drum-pad controllers).
function midiNoteName(n) {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
}

class MidiManager {
  constructor(engine, seq) {
    this.engine = engine;
    this.seq = seq;
    this.access = null;
    this.settings = {
      input: 'all', output: 'none', base: 36, channel: 9,
      clockIn: false, clockOut: false, notesOut: false, offsetMs: 0,
      mappings: {}, // "channel:cc" -> slider id, e.g. "0:21" -> "master.volume"
    };
    this.loadSettings();
    this.clock = { running: false, pendingStart: false, count: 0, times: [] };
    this.onNoteOn = null;
    this.onNoteOff = null;
    this.onCC = null;
    this.onActivity = null;
    this.onDevicesChange = null;
    this.onTransport = null;
    this.onTempo = null;
  }

  loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(MIDI_SETTINGS_KEY));
      if (saved) Object.assign(this.settings, saved);
    } catch (e) { /* storage unavailable: keep defaults */ }
  }

  saveSettings() {
    try { localStorage.setItem(MIDI_SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
  }

  async init() {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => {
      this.bindInputs();
      if (this.onDevicesChange) this.onDevicesChange();
    };
    this.bindInputs();
  }

  get inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  get outputs() { return this.access ? [...this.access.outputs.values()] : []; }

  get output() {
    if (!this.access || this.settings.output === 'none') return null;
    return this.access.outputs.get(this.settings.output) || null;
  }

  bindInputs() {
    for (const input of this.inputs) {
      const wanted = this.settings.input === 'all' || this.settings.input === input.id;
      if (wanted && !input.onmidimessage) input.onmidimessage = (e) => this.handleMessage(e.data, e.timeStamp);
      else if (!wanted && input.onmidimessage) {
        input.onmidimessage = null;
        input.close();
      }
    }
  }

  // Map a CC to a slider; a slider only ever has one CC.
  map(key, sliderId) {
    for (const k of Object.keys(this.settings.mappings)) {
      if (this.settings.mappings[k] === sliderId) delete this.settings.mappings[k];
    }
    this.settings.mappings[key] = sliderId;
    this.saveSettings();
  }

  unmap(key) {
    delete this.settings.mappings[key];
    this.saveSettings();
  }

  handleMessage(data, timeStamp) {
    const [status, d1, d2] = data;
    if (status >= 0xf8) {
      this.handleRealtime(status, timeStamp);
      return;
    }
    if (this.onActivity) this.onActivity();
    const type = status & 0xf0, ch = status & 0x0f;
    const pad = d1 - this.settings.base;
    const isPad = pad >= 0 && pad < PAD_COUNT;
    if (type === 0x90 && d2 > 0) {
      if (isPad && this.onNoteOn) this.onNoteOn(pad, d2 / 127);
    } else if (type === 0x80 || type === 0x90) {
      if (isPad && this.onNoteOff) this.onNoteOff(pad);
    } else if (type === 0xb0) {
      if (this.onCC) this.onCC(ch, d1, d2);
    }
  }

  handleRealtime(status, timeStamp) {
    if (!this.settings.clockIn) return;
    const c = this.clock;
    if (status === 0xfa || status === 0xfb) { // start / continue: begin on the next clock
      c.pendingStart = true;
      return;
    }
    if (status === 0xfc) {
      c.pendingStart = false;
      c.running = false;
      if (this.onTransport) this.onTransport('stop');
      return;
    }
    if (status !== 0xf8) return;

    const heard = this.perfToAudio(timeStamp) + this.settings.offsetMs / 1000;
    c.times.push(timeStamp);
    if (c.times.length > 49) c.times.shift();
    if (c.pendingStart) {
      c.pendingStart = false;
      c.running = true;
      c.count = 0;
      if (this.onTransport) this.onTransport('start', heard);
    } else if (c.running) c.count++;

    // Tempo from the average clock spacing over the last two beats.
    if (c.times.length >= 25 && c.count % 6 === 0 && this.onTempo) {
      const span = c.times[c.times.length - 1] - c.times[0];
      this.onTempo(60000 / ((span / (c.times.length - 1)) * 24));
    }
    if (c.running && c.count > 0 && c.count % 24 === 0) {
      this.seq.nudge((c.count / 24) * (TICKS_PER_BAR / 4), heard);
    }
  }

  // Convert between MIDI event timestamps (performance.now) and AudioContext
  // time, accounting for output latency.
  perfToAudio(ts) {
    const o = this.engine.ctx.getOutputTimestamp();
    if (!o.performanceTime) return this.engine.ctx.currentTime;
    return o.contextTime + (ts - o.performanceTime) / 1000;
  }

  audioToPerf(t) {
    const o = this.engine.ctx.getOutputTimestamp();
    if (!o.performanceTime) return performance.now();
    return o.performanceTime + (t - o.contextTime) * 1000;
  }

  sendNote(pad, time, vel, dur) {
    const out = this.output;
    if (!out || !this.settings.notesOut) return;
    const note = this.settings.base + pad;
    if (note > 127) return;
    const ch = this.settings.channel;
    const at = this.audioToPerf(time);
    out.send([0x90 | ch, note, Math.max(1, Math.round(vel * 127))], at);
    out.send([0x80 | ch, note, 0], at + Math.max(10, dur * 1000));
  }

  sendClockForTick(abs, time, spt) {
    const out = this.output;
    if (!out || !this.settings.clockOut) return;
    const first = Math.ceil(abs * CLOCKS_PER_TICK);
    const last = Math.ceil((abs + 1) * CLOCKS_PER_TICK);
    for (let n = first; n < last; n++) {
      out.send([0xf8], this.audioToPerf(time + (n / CLOCKS_PER_TICK - abs) * spt));
    }
  }

  sendStart(time) {
    const out = this.output;
    if (out && this.settings.clockOut) out.send([0xfa], this.audioToPerf(time));
  }

  sendStop() {
    const out = this.output;
    if (out && this.settings.clockOut) out.send([0xfc]);
  }
}

// Standard MIDI File (format 0) export of the current pattern.
const MidiFile = {
  PPQ: 96,

  encodePattern(seq, state, settings, loops, name) {
    const scale = this.PPQ / (TICKS_PER_BAR / 4);
    const spt = seq.secPerTick(), total = seq.totalTicks, ch = settings.channel;
    const events = [];
    for (let l = 0; l < loops; l++) {
      for (const n of seq.pattern.notes) {
        const note = settings.base + n.pad;
        if (state.pads[n.pad].mute || note > 127) continue;
        const start = Math.round((l * total + n.tick + seq.swingDelay(n.tick) / spt) * scale);
        const end = start + Math.max(1, Math.round(n.len * scale));
        events.push({ t: start, order: 1, data: [0x90 | ch, note, Math.max(1, Math.round(n.vel * 127))] });
        events.push({ t: end, order: 0, data: [0x80 | ch, note, 0] });
      }
    }
    // Note-offs go before note-ons at the same time so retriggers aren't cut.
    events.sort((a, b) => a.t - b.t || a.order - b.order);

    const track = [];
    let last = 0;
    const push = (t, bytes) => {
      track.push(...vlq(t - last), ...bytes);
      last = t;
    };
    const title = [...new TextEncoder().encode(name)].slice(0, 127);
    const us = Math.round(60e6 / state.bpm);
    push(0, [0xff, 0x03, title.length, ...title]);
    push(0, [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
    push(0, [0xff, 0x58, 0x04, 4, 2, 24, 8]);
    for (const e of events) push(e.t, e.data);
    push(Math.max(last, loops * total * scale), [0xff, 0x2f, 0x00]);

    const out = [
      ...ascii('MThd'), 0, 0, 0, 6, 0, 0, 0, 1, (this.PPQ >> 8) & 0xff, this.PPQ & 0xff,
      ...ascii('MTrk'), ...u32(track.length), ...track,
    ];
    return new Uint8Array(out);
  },
};

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function ascii(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
