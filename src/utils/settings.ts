import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { decryptCredentials, encryptCredentials } from './encryption';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

export interface AppSettings {
  terminalScrollback: number;
  terminalFontSize: number;
  globalSshKeyPath: string;
  globalSshKeyPassphrase?: string;
  globalUsername: string;
}

interface StoredAppSettings {
  terminalScrollback?: number;
  terminalFontSize?: number;
  globalSshKeyPath?: string;
  globalSshKeyPassphraseEncrypted?: string;
  globalUsername?: string;
}

function looksEncrypted(value: string): boolean {
  return /^[0-9a-f]{32}:[0-9a-f]+$/i.test(value);
}

export function getDefaultAppSettings(): AppSettings {
  return {
    terminalScrollback: 10000,
    terminalFontSize: 12,
    globalSshKeyPath: '',
    globalSshKeyPassphrase: '',
    globalUsername: '',
  };
}

export function loadAppSettings(): AppSettings {
  const defaults = getDefaultAppSettings();

  if (!fs.existsSync(SETTINGS_FILE)) {
    return defaults;
  }

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredAppSettings;

    const scrollback = Number(parsed.terminalScrollback);
    const safeScrollback = Number.isFinite(scrollback)
      ? Math.max(500, Math.min(200000, Math.round(scrollback)))
      : defaults.terminalScrollback;

    const fontSize = Number(parsed.terminalFontSize);
    const safeFontSize = Number.isFinite(fontSize)
      ? Math.max(8, Math.min(32, Math.round(fontSize)))
      : defaults.terminalFontSize;

    let decryptedPassphrase = defaults.globalSshKeyPassphrase;
    const encryptedPassphrase = typeof parsed.globalSshKeyPassphraseEncrypted === 'string'
      ? parsed.globalSshKeyPassphraseEncrypted
      : '';

    if (encryptedPassphrase && looksEncrypted(encryptedPassphrase)) {
      try {
        decryptedPassphrase = decryptCredentials(encryptedPassphrase);
      } catch {
        decryptedPassphrase = defaults.globalSshKeyPassphrase;
      }
    }

    return {
      terminalScrollback: safeScrollback,
      terminalFontSize: safeFontSize,
      globalSshKeyPath: typeof parsed.globalSshKeyPath === 'string' ? parsed.globalSshKeyPath : defaults.globalSshKeyPath,
      globalSshKeyPassphrase: decryptedPassphrase,
      globalUsername: typeof parsed.globalUsername === 'string' ? parsed.globalUsername.trim() : defaults.globalUsername,
    };
  } catch {
    return defaults;
  }
}

export function saveAppSettings(next: Partial<AppSettings>): AppSettings {
  const current = loadAppSettings();

  const nextPassphraseProvided = typeof next.globalSshKeyPassphrase === 'string';
  const normalizedNextPassphrase = nextPassphraseProvided
    ? next.globalSshKeyPassphrase || ''
    : current.globalSshKeyPassphrase || '';

  const merged: AppSettings = {
    terminalScrollback: typeof next.terminalScrollback === 'number'
      ? Math.max(500, Math.min(200000, Math.round(next.terminalScrollback)))
      : current.terminalScrollback,
    terminalFontSize: typeof next.terminalFontSize === 'number'
      ? Math.max(8, Math.min(32, Math.round(next.terminalFontSize)))
      : current.terminalFontSize,
    globalSshKeyPath: typeof next.globalSshKeyPath === 'string'
      ? next.globalSshKeyPath.trim()
      : current.globalSshKeyPath,
    globalSshKeyPassphrase: normalizedNextPassphrase,
    globalUsername: typeof next.globalUsername === 'string'
      ? next.globalUsername.trim()
      : current.globalUsername,
  };

  const stored: StoredAppSettings = {
    terminalScrollback: merged.terminalScrollback,
    terminalFontSize: merged.terminalFontSize,
    globalSshKeyPath: merged.globalSshKeyPath,
    globalUsername: merged.globalUsername,
  };

  if (merged.globalSshKeyPassphrase) {
    stored.globalSshKeyPassphraseEncrypted = encryptCredentials(merged.globalSshKeyPassphrase);
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2));
  return merged;
}
