'use strict';
// App-wide undo/redo by snapshot. Pad objects are copied shallowly: their
// AudioBuffers are never edited in place (edits make new buffers), so a
// snapshot only holds references to them.

const HISTORY_LIMIT = 50;
const HISTORY_COALESCE_MS = 1500;

class History {
  constructor(state) {
    this.state = state;
    this.undoStack = [];
    this.redoStack = [];
  }

  snapshot() {
    const s = this.state;
    return {
      pads: s.pads.map((p) => ({ ...p })),
      patterns: s.patterns.map((p) => ({ bars: p.bars, notes: p.notes.map(({ skip, ...n }) => n) })),
      master: { ...s.master },
      bpm: s.bpm,
      swing: s.swing,
    };
  }

  restore(snap) {
    Object.assign(this.state, {
      pads: snap.pads.map((p) => ({ ...p })),
      patterns: snap.patterns.map((p) => ({ bars: p.bars, notes: p.notes.map((n) => ({ ...n })) })),
      master: { ...snap.master },
      bpm: snap.bpm,
      swing: snap.swing,
    });
  }

  // Call before a change. Repeated pushes with the same key in quick
  // succession (a slider drag, a knob turn) collapse into one step.
  push(label, key = null) {
    const top = this.undoStack[this.undoStack.length - 1];
    const now = performance.now();
    if (key && top && top.key === key && now - top.time < HISTORY_COALESCE_MS) {
      top.time = now;
      return;
    }
    this.undoStack.push({ label, key, time: now, snap: this.snapshot() });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  // Returns the undone step's label, or null if there was nothing to undo.
  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, snap: this.snapshot() });
    this.restore(e.snap);
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, key: null, time: 0, snap: this.snapshot() });
    this.restore(e.snap);
    return e.label;
  }

  // Undo the last step without making it redoable (e.g. an accidental hit).
  discardLast() {
    const e = this.undoStack.pop();
    if (e) this.restore(e.snap);
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
