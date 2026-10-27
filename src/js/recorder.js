'use strict';
// Samples audio into an AudioBuffer from the mic/line in, Windows system
// audio (loopback), or the app's own master output (resampling).

class SampleRecorder {
  constructor(engine) {
    this.engine = engine;
    this.recording = false;
    this.startedAt = 0;
    this.source = null;
    this.stream = null;
    this.streamNode = null;
  }

  get elapsed() {
    return this.recording ? this.engine.ctx.currentTime - this.startedAt : 0;
  }

  async start(source) {
    if (this.recording) return;
    const ctx = this.engine.ctx;
    this.engine.resume();

    let input;
    if (source === 'master') {
      input = this.engine.mixer.output;
    } else {
      this.stream = source === 'system'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      const tracks = this.stream.getAudioTracks();
      if (!tracks.length) {
        this.releaseStream();
        throw new Error('the selected source has no audio');
      }
      this.streamNode = ctx.createMediaStreamSource(new MediaStream(tracks));
      input = this.streamNode;
    }

    this.node = new AudioWorkletNode(ctx, 'recorder', {
      outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
    });
    this.chunks = [];
    this.node.port.onmessage = (e) => {
      if (e.data.done) { if (this.finish) this.finish(); } else this.chunks.push(e.data);
    };
    // The worklet has to be pulled by the graph to run; route it to a muted sink.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(ctx.destination);
    input.connect(this.node);
    this.input = input;
    this.node.port.postMessage('start');
    this.source = source;
    this.recording = true;
    this.startedAt = ctx.currentTime;
  }

  // Resolves to the recorded buffer, or null if nothing audible was captured.
  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    await new Promise((resolve) => {
      this.finish = resolve;
      setTimeout(resolve, 1500);
      this.node.port.postMessage('stop');
    });
    this.finish = null;
    this.input.disconnect(this.node);
    this.node.disconnect();
    this.sink.disconnect();
    if (this.streamNode) this.streamNode.disconnect();
    this.releaseStream();

    const length = this.chunks.reduce((n, c) => n + c.l.length, 0);
    if (!length) return null;
    const buf = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: this.engine.ctx.sampleRate });
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let o = 0;
    for (const c of this.chunks) {
      L.set(c.l, o);
      R.set(c.r, o);
      o += c.l.length;
    }
    this.chunks = [];
    return DSP.trimSilence(buf, this.source === 'master' ? -80 : -50);
  }

  releaseStream() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamNode = null;
  }
}
