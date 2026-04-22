#!/usr/bin/env node
/**
 * build-mac.js
 * Auto-detects the host architecture and builds the macOS DMG + ZIP
 * for the same arch as the machine running the build.
 *
 *   Apple Silicon (arm64) → electron-builder --mac --arm64
 *   Intel Mac      (x64)  → electron-builder --mac --x64
 */

const { execSync } = require('child_process');

const hostArch = process.arch; // 'arm64' | 'x64'
const builderFlag = hostArch === 'arm64' ? '--arm64' : '--x64';

console.log(`\n→ Host architecture detected: ${hostArch}`);
console.log(`→ Building macOS package with: electron-builder --mac ${builderFlag}\n`);

execSync(`electron-builder --mac ${builderFlag}`, { stdio: 'inherit' });
