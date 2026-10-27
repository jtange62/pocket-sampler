# Pocket Sampler

A 16-pad sampler and pattern sequencer for Windows, in the spirit of Koala Sampler.
Built with Electron and the Web Audio API.

## Run

```powershell
npm install
npm start
```

`npm run smoke` runs a headless self-test (render, export, project round-trip) and quits.
Set `SMOKE_SHOT=path\to\shot.png` (and optionally `SMOKE_TAB=seq|fx`) to also save a screenshot.

## Build a Windows app

```powershell
npm run dist
```

Outputs in `dist/`:

- `PocketSampler-Setup-<version>.exe`: installer (choose folder, desktop + Start menu shortcuts, uninstaller)
- `PocketSampler-Portable-<version>.exe`: single exe, no install
- `win-unpacked/`: the unpacked app, handy for quick testing

The builds are unsigned, so Windows SmartScreen shows "Windows protected your PC" on first run
(More info → Run anyway). The icon comes from `build/icon.ico`; regenerate it with `npm run icon`
(needs Python + Pillow). Bump `version` in `package.json` before each release.

## Using it

**Pads**: click or use the keys `1–4 / Q–R / A–F / Z–V`. Drag audio files onto a pad; dropping
several files fills consecutive pads. Drag a pad onto another to swap them (their notes in every
pattern move too, so the beat sounds the same); hold Ctrl when dropping to copy instead.

**Library** (☰ or `Ctrl+B`): a browser for your sample folders. Your Music folder is added by
default; **+ Folder** adds more (they're remembered). Expand folders, or search every folder at once
(`Ctrl+F`). Selecting a sample previews it (toggle **Auto-preview**; click the waveform to play from a
point). Double-click or `Enter` loads into the selected pad; drag a sample onto any pad, or drag a
whole folder to load it as a kit across consecutive pads. Arrow keys navigate (←/→ collapse/expand).
The app can only read audio files inside the folders you've added.

**Sampling**: pick a source in the top bar, select a pad, press **● SAMPLE**, press again to stop.

- *Mic / line in*: any Windows input device (leading/trailing silence is trimmed).
- *System audio*: whatever Windows is playing (WASAPI loopback).
- *Resample master*: records the app's own output, FX included. Great for bouncing a beat onto one pad.

**Sample tab**: drag the S/E markers to set the region. Trim, reverse, normalize, export.
Chop the region into equal slices or by detected transients; slices land on consecutive pads.
Per pad: one-shot/gate, loop, choke group, volume, pan, pitch, filter, envelope, reverb/delay sends.

**Sequence tab**: 16-step grid per bar, 1–8 bars, four patterns (A–D). Press **●** to record live:
pad hits while playing are quantized into the pattern. Shift+click a pattern letter to copy the
current pattern there. Changing patterns while playing switches at the end of the loop.
`Space` plays/stops, `Ctrl+Z` undoes pattern edits.

**FX & Export tab**: master DJ filter, reverb, tempo-synced delay, bitcrusher, and a limiter.
Export renders the current pattern to a 16-bit WAV offline, exactly as it sounds live.

**MIDI tab**:

- *Controllers*: any USB MIDI controller plays the pads with velocity. Pads 1–16 respond to notes
  36–51 by default (standard drum-pad layout); change "Pad 1 note" to shift the range.
- *MIDI learn*: press **LEARN** in the top bar, click a slider, move a knob or fader. Mapped sliders
  show a `CC` badge. Pad sliders follow whichever pad is selected. Mappings are saved on this PC.
- *Clock sync*: "Follow incoming MIDI clock" takes tempo and start/stop from a DAW or drum machine
  and phase-locks to it; use "Offset" to fine-tune if it sounds early or late. "Send MIDI clock"
  makes other gear follow this app. "Send sequencer notes" plays the patterns out to a synth or DAW.
  For a DAW on the same PC, create a virtual port with [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html).
- *Export as MIDI* (FX & Export tab) writes the pattern as a `.mid` file to drag into a DAW.

Windows only lets one app open a MIDI device at a time, so close it in your DAW to use it here.

**Projects**: `Save` / `Open` write `.psmp` files containing every sample and setting.

## Layout

- `main.js`, `preload.js`: Electron window, file dialogs, system-audio capture
- `library.js`: sample library folders, listing, search index, sandboxed file reads (main process)
- `src/js/browser.js`: library browser sidebar and previews
- `src/js/dsp.js`: worklets (bitcrusher, recorder), buffer edits, transient detection, WAV encoding
- `src/js/engine.js`: state, master FX bus and voice playback (shared by live and offline render)
- `src/js/sequencer.js`: lookahead clock, live recording, step editing, offline render
- `src/js/recorder.js`: sampling from mic / loopback / master
- `src/js/project.js`: project save/load
- `src/js/midi.js`: MIDI input, learn, clock sync in/out, note out, `.mid` export
- `src/js/app.js`: UI
