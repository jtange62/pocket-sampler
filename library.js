// Sample library (main process): the folders the user added, directory
// listing, a lazily built search index, and file reads. The renderer can
// only read audio files inside those folders.
const fs = require('fs/promises');
const path = require('path');

const AUDIO_EXT = new Set(['.wav', '.aif', '.aiff', '.mp3', '.flac', '.ogg', '.m4a', '.opus', '.aac']);
const MAX_INDEX = 200000;
const MAX_RESULTS = 500;
const MAX_READ = 512 * 1024 * 1024;

const isAudio = (name) => AUDIO_EXT.has(path.extname(name).toLowerCase());
const isHidden = (name) => name.startsWith('.') || name.startsWith('$');
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

class Library {
  constructor(file, defaultRoot) {
    this.file = file;
    this.defaultRoot = defaultRoot;
    this.roots = [];
    this.indexes = new Map(); // root -> Promise<files[]>
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.roots = (data.roots || []).filter((r) => typeof r === 'string');
    } catch {
      this.roots = this.defaultRoot && (await exists(this.defaultRoot)) ? [this.defaultRoot] : [];
      await this.save();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ roots: this.roots }, null, 2));
  }

  rootList() {
    return this.roots.map((p) => ({ path: p, name: path.basename(p) || p }));
  }

  async addRoot(dir) {
    const p = path.resolve(dir);
    if (!this.roots.some((r) => path.relative(r, p) === '')) {
      this.roots.push(p);
      await this.save();
    }
    return this.rootList();
  }

  async removeRoot(dir) {
    this.roots = this.roots.filter((r) => path.relative(r, dir) !== '');
    this.indexes.delete(dir);
    await this.save();
    return this.rootList();
  }

  contains(p) {
    const target = path.resolve(p);
    return this.roots.some((root) => isInside(root, target));
  }

  async list(dir) {
    if (!this.contains(dir)) throw new Error('That folder is not in the library');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of entries) {
      if (isHidden(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push({ name: e.name, path: p, dir: true });
      else if (e.isFile() && isAudio(e.name)) files.push({ name: e.name, path: p, dir: false });
    }
    return [...dirs.sort(byName), ...files.sort(byName)];
  }

  async read(p) {
    if (!this.contains(p) || !isAudio(p)) throw new Error('Not a sample in the library');
    const { size } = await fs.stat(p);
    if (size > MAX_READ) throw new Error('That file is too large to load');
    return fs.readFile(p);
  }

  refresh() {
    this.indexes.clear();
  }

  index(root) {
    if (!this.indexes.has(root)) this.indexes.set(root, this.walk(root));
    return this.indexes.get(root);
  }

  async walk(root) {
    const files = [];
    const label = path.basename(root) || root;
    const stack = [root];
    while (stack.length && files.length < MAX_INDEX) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip it
      }
      for (const e of entries) {
        if (isHidden(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && isAudio(e.name)) {
          files.push({ name: e.name, path: p, sub: path.join(label, path.relative(root, dir)), lower: path.relative(root, p).toLowerCase() });
        }
      }
    }
    return files;
  }

  // Every word must appear somewhere in the file's path; name matches rank first.
  async search(query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const hits = [];
    for (const root of this.roots) {
      for (const f of await this.index(root)) {
        if (tokens.every((t) => f.lower.includes(t))) hits.push(f);
      }
    }
    const nameHit = (f) => (tokens.every((t) => f.name.toLowerCase().includes(t)) ? 1 : 0);
    hits.sort((a, b) => nameHit(b) - nameHit(a) || byName(a, b));
    return hits.slice(0, MAX_RESULTS).map(({ name, path: p, sub }) => ({ name, path: p, sub, dir: false }));
  }
}

module.exports = { Library };
