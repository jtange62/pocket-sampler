'use strict';
// Project files (.psmp): JSON with every pad's audio stored as raw float32
// base64, so samples round-trip bit-exact with no re-decoding.

const Project = {
  serialize(state) {
    const pads = state.pads.map(({ buffer, ...params }) => ({
      ...params,
      sample: buffer ? encodeBuffer(buffer) : null,
    }));
    const patterns = state.patterns.map((p) => ({ bars: p.bars, notes: p.notes.map(({ skip, ...n }) => n) }));
    return JSON.stringify({
      app: 'pocket-sampler', version: 1,
      bpm: state.bpm, swing: state.swing, quantize: state.quantize, metronome: state.metronome,
      currentPattern: state.currentPattern, master: state.master, pads, patterns,
    });
  },

  // Loads into the existing state object, which the engine and sequencer hold on to.
  load(text, state) {
    const data = JSON.parse(text);
    if (data.app !== 'pocket-sampler') throw new Error('not a Pocket Sampler project');
    const fresh = createState();
    Object.assign(state, {
      bpm: data.bpm ?? fresh.bpm,
      swing: data.swing ?? fresh.swing,
      quantize: data.quantize ?? fresh.quantize,
      metronome: !!data.metronome,
      currentPattern: data.currentPattern ?? 0,
      master: { ...fresh.master, ...data.master },
      patterns: fresh.patterns.map((p, i) => (data.patterns && data.patterns[i]) || p),
      pads: fresh.pads.map((p, i) => {
        const saved = data.pads && data.pads[i];
        if (!saved) return p;
        const { sample, ...params } = saved;
        return { ...p, ...params, buffer: sample ? decodeBuffer(sample) : null };
      }),
    });
  },
};

function encodeBuffer(buf) {
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    channels.push(DSP.bytesToBase64(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
  }
  return { sampleRate: buf.sampleRate, channels };
}

function decodeBuffer({ sampleRate, channels }) {
  const data = channels.map((b64) => new Float32Array(DSP.base64ToBytes(b64).buffer));
  const buf = new AudioBuffer({ numberOfChannels: data.length, length: data[0].length, sampleRate });
  data.forEach((d, c) => buf.copyToChannel(d, c));
  return buf;
}
