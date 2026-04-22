#!/usr/bin/env node
/**
 * postinstall.js
 *
 * npm strips execute permissions from binaries in prebuilt native modules.
 * On macOS, node-pty's `spawn-helper` must be executable for pty.spawn() to
 * work.  This script re-applies the execute bit after every `npm install`.
 */

const fs = require('fs');
const path = require('path');

const helpers = [
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64',   'spawn-helper'),
];

let fixed = 0;
for (const helperPath of helpers) {
  if (fs.existsSync(helperPath)) {
    try {
      fs.chmodSync(helperPath, 0o755);
      console.log(`[postinstall] chmod +x ${helperPath}`);
      fixed++;
    } catch (err) {
      console.warn(`[postinstall] Could not chmod ${helperPath}:`, err.message);
    }
  }
}

if (fixed === 0) {
  console.log('[postinstall] No spawn-helper binaries found (may not be macOS or may not need patching).');
}
