import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';

// Re-export ConnectionProfile from the shared types module so existing
// imports (`from '../utils/encryption'`) continue to work unchanged.
export type { ConnectionProfile } from '../shared/types';
import type { ConnectionProfile } from '../shared/types';

const ENCRYPTION_KEY_FILE = path.join(app.getPath('userData'), '.terX-key');
const CREDENTIALS_FILE = path.join(app.getPath('userData'), 'credentials.json');

// Raw key length when stored in the legacy (pre-safeStorage) format.
const RAW_KEY_LENGTH = 32;

let encryptionKey: Buffer;

/**
 * Reads or creates the AES-256 encryption key.
 *
 * On platforms where Electron's safeStorage is available (Windows DPAPI,
 * macOS Keychain, Linux Secret Service) the key is stored encrypted so
 * that only the current OS user can recover it.
 *
 * Legacy installs that still have a raw 32-byte key file are automatically
 * migrated to the encrypted format on first load.
 */
function getOrCreateEncryptionKey(): Buffer {
  const canUseSafeStorage = safeStorage.isEncryptionAvailable();

  if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
    const stored = fs.readFileSync(ENCRYPTION_KEY_FILE);

    // Try safeStorage-encrypted format first (new installs / migrated).
    if (canUseSafeStorage) {
      try {
        const decrypted = safeStorage.decryptString(stored);
        return Buffer.from(decrypted, 'hex');
      } catch {
        // Decryption failed — may be legacy raw key, handled below.
      }
    }

    // Legacy format: raw 32-byte key stored as-is.
    if (stored.length === RAW_KEY_LENGTH) {
      // Migrate to safeStorage-protected format when possible.
      if (canUseSafeStorage) {
        try {
          const encrypted = safeStorage.encryptString(stored.toString('hex'));
          fs.writeFileSync(ENCRYPTION_KEY_FILE, encrypted);
        } catch (error) {
          console.warn('Failed to migrate encryption key to safeStorage:', error);
        }
      }
      return stored;
    }

    // File exists but is neither valid safeStorage blob nor legacy key.
    // Generate a fresh key (existing credentials will become unreadable,
    // but this is an edge case — better than crashing).
    console.warn('Encryption key file is corrupted. Generating new key.');
  }

  // Generate a new 32-byte key.
  const key = crypto.randomBytes(RAW_KEY_LENGTH);

  if (canUseSafeStorage) {
    try {
      const encrypted = safeStorage.encryptString(key.toString('hex'));
      fs.writeFileSync(ENCRYPTION_KEY_FILE, encrypted);
    } catch (error) {
      // Fall back to raw storage if safeStorage write fails.
      console.warn('safeStorage encryption failed, falling back to raw key storage:', error);
      fs.writeFileSync(ENCRYPTION_KEY_FILE, key);
      try { fs.chmodSync(ENCRYPTION_KEY_FILE, 0o600); } catch { /* no-op on Windows */ }
    }
  } else {
    fs.writeFileSync(ENCRYPTION_KEY_FILE, key);
    try { fs.chmodSync(ENCRYPTION_KEY_FILE, 0o600); } catch { /* no-op on Windows */ }
  }

  return key;
}

export function initializeEncryption(): void {
  encryptionKey = getOrCreateEncryptionKey();
}

export function encryptCredentials(data: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

export function decryptCredentials(encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted credential format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);
  let decrypted = decipher.update(parts[1], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function encryptWithPassword(data: string, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `v1:${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}`;
}

export function decryptWithPassword(encryptedData: string, password: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid portable encrypted format');
  }
  const salt = Buffer.from(parts[1], 'hex');
  const iv = Buffer.from(parts[2], 'hex');
  const ciphertext = parts[3];
  
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function looksEncrypted(value: string): boolean {
  return /^[0-9a-f]{32}:[0-9a-f]+$/i.test(value);
}

export function saveConnection(connection: ConnectionProfile): void {
  let connections: ConnectionProfile[] = [];
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
      connections = JSON.parse(data);
    } catch {
      // File is corrupted — start fresh rather than crash
      connections = [];
    }
  }

  const encrypted = { ...connection };
  if (connection.password) {
    encrypted.password = encryptCredentials(connection.password);
  }

  const index = connections.findIndex((c) => c.id === connection.id);
  if (index >= 0) {
    connections[index] = encrypted;
  } else {
    connections.push(encrypted);
  }

  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(connections, null, 2));
}

export function saveConnections(connections: ConnectionProfile[]): void {
  const encryptedConnections = connections.map((connection) => {
    const encrypted = { ...connection };
    if (connection.password && !looksEncrypted(connection.password)) {
      encrypted.password = encryptCredentials(connection.password);
    }
    return encrypted;
  });

  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(encryptedConnections, null, 2));
}

export function loadConnections(): ConnectionProfile[] {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return [];
  }
  const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  const parsed = JSON.parse(data) as ConnectionProfile[];

  return parsed.map((connection) => {
    if (!connection.password || !looksEncrypted(connection.password)) {
      return connection;
    }

    try {
      return {
        ...connection,
        password: decryptCredentials(connection.password),
      };
    } catch {
      // Fall back to raw value if decryption fails so profile remains usable.
      return connection;
    }
  });
}

export function deleteConnection(id: string): void {
  if (!fs.existsSync(CREDENTIALS_FILE)) return;
  try {
    const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    let connections: ConnectionProfile[] = JSON.parse(data);
    connections = connections.filter((c) => c.id !== id);
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(connections, null, 2));
  } catch {
    // File corrupted — nothing to delete
  }
}
