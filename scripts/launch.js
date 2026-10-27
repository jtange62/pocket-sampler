// Starts Electron with ELECTRON_RUN_AS_NODE cleared. Terminals spawned from
// VS Code extensions inherit it, which makes Electron run as plain Node.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env })
  .on('exit', (code) => process.exit(code ?? 0));
