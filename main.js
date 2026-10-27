const { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const SMOKE = process.argv.includes('--smoke');

// Let the AudioContext start without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Exercises the engine end to end without a human: load a synthetic sample,
// sequence it, render offline, round-trip a project and run the live clock.
const SMOKE_TEST = `(async () => {
  const sr = engine.ctx.sampleRate;
  const buf = new AudioBuffer({ numberOfChannels: 1, length: sr / 2, sampleRate: sr });
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / sr * 2 * Math.PI * 220) * Math.exp(-i / sr * 8);
  setPadBuffer(0, buf, 'smoke');
  for (let s = 0; s < 16; s += 4) seq.setStep(0, s, true);
  seq.setStep(5, 2, true);
  refreshAll();
  const out = await seq.render(1, true);
  let peak = 0;
  for (let c = 0; c < out.numberOfChannels; c++) for (const v of out.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const wav = DSP.encodeWav(out);
  movePad(0, 3);
  const swap = { name: state.pads[3].name, notesFollowed: seq.pattern.notes.filter((x) => x.pad === 3).length, emptied: !state.pads[0].buffer };
  movePad(3, 0);
  movePad(0, 7, true);
  swap.copied = state.pads[7].name === 'smoke' && !!state.pads[0].buffer;
  Object.assign(state.pads[7], defaultPad());
  refreshAll();
  const onsets = DSP.detectOnsets(out, 8);
  hitPad(0); releasePad(0);
  seq.play();
  await new Promise((r) => setTimeout(r, 700));
  const tickWhilePlaying = seq.currentTickFloat();
  seq.stop();

  // MIDI: a pad note, a learned CC, a .mid export and following a 120 BPM clock.
  engine.mixer.last[0] = null;
  midi.handleMessage([0x90, midi.settings.base, 100], performance.now());
  midi.handleMessage([0x80, midi.settings.base, 0], performance.now());
  const midiPadHit = !!engine.mixer.last[0];
  const savedMappings = midi.settings.mappings;
  midi.settings.mappings = { '0:7': 'master.volume' };
  midi.handleMessage([0xb0, 7, 127], performance.now());
  const ccVolume = state.master.volume;
  midi.settings.mappings = savedMappings;
  const mid = MidiFile.encodePattern(seq, state, midi.settings, 2, 'smoke');
  const midHeader = String.fromCharCode(...mid.slice(0, 4)) + String.fromCharCode(...mid.slice(14, 18));

  midi.settings.clockIn = true;
  const interval = 60000 / 120 / 24, t0 = performance.now() + 20;
  midi.handleMessage([0xfa], t0 - 5);
  let n = 0;
  await new Promise((done) => {
    const pump = () => {
      while (t0 + n * interval <= performance.now()) midi.handleMessage([0xf8], t0 + n++ * interval);
      if (n < 24 * 8) setTimeout(pump, 2); else done();
    };
    pump();
  });
  const beat = Math.floor((n - 1) / 24);
  const scheduled = seq.history.find((h) => h.abs === beat * 16);
  const expected = midi.perfToAudio(t0 + beat * 24 * interval);
  const clockSync = { bpm: state.bpm, playing: seq.playing, phaseErrorMs: scheduled ? Math.round((scheduled.time - expected) * 1000 * 10) / 10 : null };
  midi.handleMessage([0xfc], performance.now());
  midi.settings.clockIn = false;
  clockSync.stoppedByClock = !seq.playing;
  const json = Project.serialize(state);
  Project.load(json, state);
  refreshAll();
  return { renderedSeconds: out.duration, peak, wavBytes: wav.byteLength, onsets: onsets.length,
    projectBytes: json.length, padRestored: !!state.pads[0].buffer, notes: seq.pattern.notes.length,
    tickWhilePlaying, ctxState: engine.ctx.state,
    midiAccess: !!midi.access, midiPadHit, ccVolume, midHeader, midBytes: mid.length, clockSync, swap };
})()`;

function createWindow() {
  const win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#121318',
    title: 'Pocket Sampler',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the sequencer clock running when the window is in the background.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (SMOKE) {
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const result = await win.webContents.executeJavaScript(SMOKE_TEST);
        console.log('SMOKE OK', JSON.stringify(result));

        // Drag pad 1 onto pad 2 with real mouse events.
        const [a, b] = await win.webContents.executeJavaScript(`ui.padEls.slice(0, 2).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })`);
        const send = (type, p) => win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
        send('mouseDown', a);
        for (let k = 1; k <= 10; k++) {
          send('mouseMove', { x: Math.round(a.x + ((b.x - a.x) * k) / 10), y: a.y });
          await new Promise((r) => setTimeout(r, 16));
        }
        send('mouseUp', b);
        await new Promise((r) => setTimeout(r, 100));
        const dragged = await win.webContents.executeJavaScript(`({ pad2: state.pads[1].name, pad1Empty: !state.pads[0].buffer,
          ghostGone: !document.querySelector('.pad-ghost'), selected: ui.selected })`);
        console.log('SMOKE DRAG', JSON.stringify(dragged));
        if (process.env.SMOKE_SHOT) {
          if (process.env.SMOKE_TAB) {
            await win.webContents.executeJavaScript(`document.querySelector('[data-tab="${process.env.SMOKE_TAB}"]').click()`);
            await new Promise((r) => setTimeout(r, 300));
          }
          const img = await win.webContents.capturePage();
          await fs.writeFile(process.env.SMOKE_SHOT, img.toPNG());
        }
      } catch (err) {
        console.log('SMOKE FAIL', err && err.stack ? err.stack : err);
      }
      app.quit();
    });
  }
}

ipcMain.handle('save-file', async (event, { title, defaultPath, filters }, data) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title, defaultPath, filters });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, typeof data === 'string' ? data : Buffer.from(data));
  return filePath;
});

ipcMain.handle('open-file', async (event, { title, filters }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title, filters, properties: ['openFile'] });
  if (canceled || !filePaths.length) return null;
  const data = await fs.readFile(filePaths[0]);
  return { path: filePaths[0], name: path.basename(filePaths[0]), data };
});

app.whenReady().then(() => {
  // "System audio" sampling: capture the primary screen with Windows loopback audio.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  }, { useSystemPicker: false });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
