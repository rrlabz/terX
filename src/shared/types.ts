/**
 * Shared type definitions used across main, preload, and renderer processes.
 * This file MUST NOT import from electron, node, or any process-specific module.
 */

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  description?: string;
  password?: string;
  privateKeyPath?: string;
  group?: string;
  tags?: string[];
}

export interface IpcResult {
  success: boolean;
  error?: string;
}

export interface ShutdownStatePayload {
  status?: 'starting' | 'progress' | 'complete';
  total?: number;
  completed?: number;
  remaining?: number;
  percent?: number;
  message?: string;
}

export interface SanitizedAppSettings {
  terminalScrollback: number;
  terminalFontSize: number;
  globalSshKeyPath: string;
  globalUsername: string;
  hasGlobalSshKeyPassphrase: boolean;
}

export interface ExportFieldSelection {
  description?: boolean;
  password?: boolean;
  privateKeyPath?: boolean;
  username?: boolean;
}
