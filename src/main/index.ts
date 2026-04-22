import { app, BrowserWindow, ipcMain, Menu, clipboard, dialog, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import isDev from 'electron-is-dev';
import {
  initializeEncryption,
  loadConnections,
  saveConnection,
  saveConnections,
  deleteConnection,
  ConnectionProfile,
  encryptCredentials,
  decryptCredentials,
  encryptWithPassword,
  decryptWithPassword,
} from '../utils/encryption';
import { registerSSHHandlers, shutdownActiveConnections, shutdownActiveConnectionsWithProgress } from '../utils/ssh';
import { AppSettings, getDefaultAppSettings, loadAppSettings, saveAppSettings } from '../utils/settings';
import { normalizeImportedConnection, projectConnectionForExport } from '../shared/connection-utils';
import type { ExportFieldSelection } from '../shared/types';

const isProduction = process.env.NODE_ENV === 'production' || !isDev;
let mainWindow: BrowserWindow | null;
let settingsWindow: BrowserWindow | null;
let importExportWindow: BrowserWindow | null;
let isAppQuitting = false;
let isShuttingDown = false;
const FORCE_SHUTDOWN_TIMEOUT_MS = 12000;

interface ShutdownStatePayload {
  status: 'starting' | 'progress' | 'complete';
  total: number;
  completed: number;
  remaining: number;
  percent: number;
  message: string;
}

function emitShutdownState(payload: ShutdownStatePayload): void {
  mainWindow?.webContents.send('app:shutdown-state', payload);
}

function broadcastConnectionsUpdated(): void {
  mainWindow?.webContents.send('connections:updated');
  importExportWindow?.webContents.send('connections:updated');
}

function buildShutdownMessage(progress: { total: number; completed: number; remaining: number }): string {
  if (progress.total <= 0) {
    return 'Please wait, we are closing SSH connections...';
  }

  return `Please wait, we are closing SSH connections (${progress.completed}/${progress.total})...`;
}

async function performGracefulAppShutdown(): Promise<void> {
  if (isAppQuitting || isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  const forcedExitTimer = setTimeout(() => {
    console.warn(`Graceful shutdown timed out after ${FORCE_SHUTDOWN_TIMEOUT_MS}ms. Forcing exit.`);
    isAppQuitting = true;
    shutdownActiveConnections();
    app.exit(0);
  }, FORCE_SHUTDOWN_TIMEOUT_MS);

  const startedAt = Date.now();
  emitShutdownState({
    status: 'starting',
    total: 0,
    completed: 0,
    remaining: 0,
    percent: 0,
    message: 'Please wait, we are closing SSH connections...',
  });

  // Give the renderer a frame to paint the shutdown overlay before we start
  // killing processes. Without this yield the IPC message is queued but the
  // event loop immediately starts blocking on synchronous Win32 kill() calls.
  await new Promise<void>((resolve) => setTimeout(resolve, 80));

  try {
    await shutdownActiveConnectionsWithProgress((progress) => {
      const percent = progress.total > 0
        ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
        : 100;

      emitShutdownState({
        status: 'progress',
        total: progress.total,
        completed: progress.completed,
        remaining: progress.remaining,
        percent,
        message: buildShutdownMessage(progress),
      });
    });
  } catch (error) {
    console.error('Graceful shutdown encountered an error:', error);
    shutdownActiveConnections();
  } finally {
    clearTimeout(forcedExitTimer);

    emitShutdownState({
      status: 'complete',
      total: 0,
      completed: 0,
      remaining: 0,
      percent: 100,
      message: 'SSH connections closed. Exiting...',
    });

    // Keep the progress message visible for at least one paint in fast shutdowns.
    const elapsed = Date.now() - startedAt;
    if (elapsed < 180) {
      await new Promise((resolve) => setTimeout(resolve, 180 - elapsed));
    }

    isAppQuitting = true;

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
      settingsWindow = null;
    }

    if (importExportWindow && !importExportWindow.isDestroyed()) {
      importExportWindow.destroy();
      importExportWindow = null;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      return;
    }

    app.quit();
  }
}

function ensureWritableAppPaths(): void {
  const appDirName = app.getName() || 'terX';
  const defaultBase = path.join(app.getPath('appData'), appDirName);
  const fallbackBase = path.join(app.getPath('temp'), appDirName);

  const chooseBasePath = (): string => {
    try {
      fs.mkdirSync(defaultBase, { recursive: true });
      fs.accessSync(defaultBase, fs.constants.W_OK);
      return defaultBase;
    } catch {
      fs.mkdirSync(fallbackBase, { recursive: true });
      return fallbackBase;
    }
  };

  try {
    const basePath = chooseBasePath();
    const userDataPath = path.join(basePath, 'user-data');
    const sessionDataPath = path.join(basePath, 'session-data');
    const cachePath = path.join(basePath, 'cache');

    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(sessionDataPath, { recursive: true });
    fs.mkdirSync(cachePath, { recursive: true });

    app.setPath('userData', userDataPath);
    app.setPath('sessionData', sessionDataPath);
    app.setPath('cache', cachePath);
    app.commandLine.appendSwitch('disk-cache-dir', cachePath);
  } catch (error) {
    console.warn('Failed to configure writable cache/user-data paths:', error);
  }
}

ensureWritableAppPaths();

function sanitizeSettingsForRenderer(settings: AppSettings): Omit<AppSettings, 'globalSshKeyPassphrase'> & { hasGlobalSshKeyPassphrase: boolean } {
  return {
    terminalScrollback: settings.terminalScrollback,
    terminalFontSize: settings.terminalFontSize,
    globalSshKeyPath: settings.globalSshKeyPath,
    globalUsername: settings.globalUsername,
    hasGlobalSshKeyPassphrase: Boolean(settings.globalSshKeyPassphrase),
  };
}

function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'app_icon.ico'),
    path.join(app.getAppPath(), 'app_icon.ico'),
    path.join(process.resourcesPath, 'app_icon.ico'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function showWindowSystemMenu(x?: number, y?: number): void {
  if (!mainWindow) {
    return;
  }

  showWindowSystemMenuForWindow(mainWindow, x, y);
}

function showWindowSystemMenuForWindow(targetWindow: BrowserWindow, x?: number, y?: number): void {
  const isMaximized = targetWindow.isMaximized();

  const menu = Menu.buildFromTemplate([
    {
      label: 'Restore',
      enabled: isMaximized,
      click: () => targetWindow.unmaximize(),
    },
    {
      label: 'Minimize',
      click: () => targetWindow.minimize(),
    },
    {
      label: 'Maximize',
      enabled: !isMaximized,
      click: () => targetWindow.maximize(),
    },
    { type: 'separator' },
    {
      label: 'Close',
      click: () => targetWindow.close(),
    },
  ]);

  menu.popup({
    window: targetWindow,
    x: typeof x === 'number' ? Math.max(0, Math.round(x)) : 8,
    y: typeof y === 'number' ? Math.max(0, Math.round(y)) : 34,
  });
}

function getRequestWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  return senderWindow || undefined;
}

function attachWindowStateEvents(targetWindow: BrowserWindow): void {
  targetWindow.on('maximize', () => {
    targetWindow.webContents.send('window:maximized-state', { maximized: true });
  });

  targetWindow.on('unmaximize', () => {
    targetWindow.webContents.send('window:maximized-state', { maximized: false });
  });

  targetWindow.webContents.on('before-input-event', (event, input) => {
    const isAltSpace = input.type === 'keyDown' && input.alt && input.key === ' ';
    if (isAltSpace) {
      showWindowSystemMenuForWindow(targetWindow);
      event.preventDefault();
    }
    
    // Allow developer hotkeys (Refresh, DevTools) since the app menu is hidden
    if (!isProduction && input.type === 'keyDown') {
      if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
        targetWindow.webContents.reload();
        event.preventDefault();
      } else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        targetWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
  });
}

function createWindow() {
  const appIconPath = resolveAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 460,
    frame: false,
    titleBarStyle: 'hidden',
    resizable: true,
    maximizable: true,
    minimizable: true,
    movable: true,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Must be false: preload uses contextBridge/ipcRenderer which require Node.js access
    },
  });

  const startUrl = isProduction
    ? `file://${path.join(__dirname, '../../build/index.html')}`
    : 'http://127.0.0.1:3000';

  mainWindow.loadURL(startUrl);

  if (process.platform === 'darwin' && appIconPath && app.dock) {
    app.dock.setIcon(appIconPath);
  }

  if (!isProduction) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (event) => {
    if (isAppQuitting || isShuttingDown) {
      return;
    }

    event.preventDefault();
    void performGracefulAppShutdown();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  attachWindowStateEvents(mainWindow);
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    if (!settingsWindow.isVisible()) {
      settingsWindow.show();
    }
    settingsWindow.focus();
    return;
  }

  const appIconPath = resolveAppIconPath();

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 520,
    minWidth: 460,
    minHeight: 400,
    frame: false,
    titleBarStyle: 'hidden',
    resizable: false,
    maximizable: false,
    minimizable: true,
    movable: true,
    show: false,
    autoHideMenuBar: true,
    title: 'Settings',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const settingsUrl = isProduction
    ? `file://${path.join(__dirname, '../../build/settings.html')}`
    : 'http://127.0.0.1:3000/settings.html';

  settingsWindow.loadURL(settingsUrl);
  attachWindowStateEvents(settingsWindow);

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
    settingsWindow?.focus();
  });

  settingsWindow.on('close', (event) => {
    if (!isAppQuitting) {
      event.preventDefault();
      settingsWindow?.hide();
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function openImportExportWindow(): void {
  if (importExportWindow && !importExportWindow.isDestroyed()) {
    if (importExportWindow.isMinimized()) {
      importExportWindow.restore();
    }
    if (!importExportWindow.isVisible()) {
      importExportWindow.show();
    }
    importExportWindow.focus();
    return;
  }

  const appIconPath = resolveAppIconPath();

  importExportWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 620,
    minHeight: 500,
    frame: false,
    titleBarStyle: 'hidden',
    resizable: true,
    maximizable: true,
    minimizable: true,
    movable: true,
    show: false,
    autoHideMenuBar: true,
    title: 'Import / Export Hosts',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const importExportUrl = isProduction
    ? `file://${path.join(__dirname, '../../build/import-export.html')}`
    : 'http://127.0.0.1:3000/import-export.html';

  importExportWindow.loadURL(importExportUrl);
  attachWindowStateEvents(importExportWindow);

  importExportWindow.once('ready-to-show', () => {
    importExportWindow?.show();
    importExportWindow?.focus();
  });

  importExportWindow.on('close', (event) => {
    if (!isAppQuitting) {
      event.preventDefault();
      importExportWindow?.hide();
    }
  });

  importExportWindow.on('closed', () => {
    importExportWindow = null;
  });
}



app.on('ready', () => {
  Menu.setApplicationMenu(null);
  initializeEncryption();
  createWindow();
  if (mainWindow) {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
    registerSSHHandlers(() => mainWindow);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isAppQuitting = true;
  shutdownActiveConnections();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
    registerSSHHandlers(() => mainWindow);
  }
});

// IPC Handlers for Connection Management
ipcMain.handle('connections:load', async () => {
  try {
    return loadConnections();
  } catch (error) {
    console.error('Failed to load connections:', error);
    return [];
  }
});

ipcMain.handle('connections:save', async (_event, connection: ConnectionProfile) => {
  try {
    saveConnection(connection);
    broadcastConnectionsUpdated();
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('connections:delete', async (_event, connectionId: string) => {
  try {
    deleteConnection(connectionId);
    broadcastConnectionsUpdated();
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('clipboard:write-text', async (_event, text: string) => {
  try {
    clipboard.writeText(text || '');
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('clipboard:read-text', async () => {
  try {
    return { success: true, text: clipboard.readText() };
  } catch (error) {
    return { success: false, error: (error as Error).message, text: '' };
  }
});

ipcMain.handle('connections:save-all', async (_event, connections: ConnectionProfile[]) => {
  try {
    saveConnections(connections);
    broadcastConnectionsUpdated();
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('window:minimize', async () => {
  mainWindow?.minimize();
  return { success: true };
});

ipcMain.handle('window:toggle-maximize', async () => {
  if (!mainWindow) {
    return { success: false, maximized: false, error: 'Main window not available' };
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }

  return { success: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle('window:is-maximized', async () => {
  return { success: true, maximized: Boolean(mainWindow?.isMaximized()) };
});

ipcMain.handle('window:close', async () => {
  if (process.platform === 'darwin') {
    mainWindow?.close();
    return { success: true };
  }

  void performGracefulAppShutdown();
  return { success: true, shuttingDown: true };
});

ipcMain.handle('window:show-system-menu', async (_event, position?: { x?: number; y?: number }) => {
  showWindowSystemMenu(position?.x, position?.y);
  return { success: true };
});

ipcMain.handle('window:self-minimize', async (event) => {
  const requesterWindow = getRequestWindow(event);
  requesterWindow?.minimize();
  return { success: true };
});

ipcMain.handle('window:self-toggle-maximize', async (event) => {
  const requesterWindow = getRequestWindow(event);
  if (!requesterWindow) {
    return { success: false, maximized: false, error: 'Requester window not available' };
  }

  if (requesterWindow.isMaximized()) {
    requesterWindow.unmaximize();
  } else {
    requesterWindow.maximize();
  }

  return { success: true, maximized: requesterWindow.isMaximized() };
});

ipcMain.handle('window:self-is-maximized', async (event) => {
  const requesterWindow = getRequestWindow(event);
  return { success: true, maximized: Boolean(requesterWindow?.isMaximized()) };
});

ipcMain.handle('window:self-close', async (event) => {
  const requesterWindow = getRequestWindow(event);
  requesterWindow?.close();
  return { success: true };
});

ipcMain.handle('window:self-show-system-menu', async (event, position?: { x?: number; y?: number }) => {
  const requesterWindow = getRequestWindow(event);
  if (!requesterWindow) {
    return { success: false, error: 'Requester window not available' };
  }

  showWindowSystemMenuForWindow(requesterWindow, position?.x, position?.y);
  return { success: true };
});

ipcMain.handle('window:open-settings', async () => {
  openSettingsWindow();
  return { success: true };
});

ipcMain.handle('window:open-import-export', async () => {
  openImportExportWindow();
  return { success: true };
});

ipcMain.handle('settings:load', async () => {
  const settings = loadAppSettings();
  return { success: true, settings: sanitizeSettingsForRenderer(settings) };
});

ipcMain.handle('settings:save', async (_event, next: Partial<AppSettings>) => {
  try {
    const saved = saveAppSettings(next || {});
    const sanitized = sanitizeSettingsForRenderer(saved);
    mainWindow?.webContents.send('settings:updated', sanitized);
    settingsWindow?.webContents.send('settings:updated', sanitized);
    return { success: true, settings: sanitized };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('settings:pick-global-key', async (event) => {
  const requesterWindow = BrowserWindow.fromWebContents(event.sender);
  const targetWindow = requesterWindow || settingsWindow || mainWindow || undefined;
  const openOptions = {
    title: 'Select Global SSH Private Key',
    properties: ['openFile' as const],
    filters: [
      { name: 'SSH Keys', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  };
  const result = targetWindow
    ? await dialog.showOpenDialog(targetWindow, openOptions)
    : await dialog.showOpenDialog(openOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return { success: true, canceled: true };
  }

  return { success: true, canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('settings:export-connections', async (event, payload: { connectionIds?: string[]; fields?: ExportFieldSelection; password?: string }) => {
  try {
    const connections = loadConnections();
    const selectedIds = Array.isArray(payload?.connectionIds)
      ? new Set(payload.connectionIds)
      : null;
    const selectedConnections = selectedIds === null
      ? connections
      : connections.filter((connection) => selectedIds.has(connection.id));

    const fields: ExportFieldSelection = {
      description: Boolean(payload?.fields?.description),
      password: Boolean(payload?.fields?.password),
      privateKeyPath: Boolean(payload?.fields?.privateKeyPath),
      username: Boolean(payload?.fields?.username),
    };

    const exportData = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        fields,
      },
      connections: selectedConnections.map((connection) => projectConnectionForExport(connection, fields)),
    };

    const requesterWindow = BrowserWindow.fromWebContents(event.sender);
    const targetWindow = requesterWindow || settingsWindow || mainWindow || undefined;
    const saveOptions = {
      title: 'Export Hosts',
      defaultPath: 'terX-hosts-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const saveResult = targetWindow
      ? await dialog.showSaveDialog(targetWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: true, canceled: true };
    }

    const jsonString = JSON.stringify(exportData, null, 2);
    let secureExport;
    
    if (payload.password) {
      secureExport = {
        terXPortableExport: true,
        data: encryptWithPassword(jsonString, payload.password)
      };
    } else {
      secureExport = {
        terXEncryptedExport: true,
        data: encryptCredentials(jsonString)
      };
    }
    
    fs.writeFileSync(saveResult.filePath, JSON.stringify(secureExport, null, 2), 'utf8');
    return { success: true, canceled: false, filePath: saveResult.filePath, count: selectedConnections.length };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('settings:import-connections', async (event, payload?: { password?: string; filePath?: string }) => {
  try {
    const requesterWindow = BrowserWindow.fromWebContents(event.sender);
    const targetWindow = requesterWindow || settingsWindow || mainWindow || undefined;
    const openOptions = {
      title: 'Import Hosts',
      properties: ['openFile' as const],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    let filePath = payload?.filePath;
    if (!filePath) {
      const openResult = targetWindow
        ? await dialog.showOpenDialog(targetWindow, openOptions)
        : await dialog.showOpenDialog(openOptions);

      if (openResult.canceled || openResult.filePaths.length === 0) {
        return { success: true, canceled: true };
      }
      filePath = openResult.filePaths[0];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsedRaw = JSON.parse(raw) as any;
    
    let parsed: unknown;
    if (parsedRaw && parsedRaw.terXPortableExport && typeof parsedRaw.data === 'string') {
      if (!payload?.password) {
        return { success: false, needsPassword: true, filePath };
      }
      try {
        const decryptedRaw = decryptWithPassword(parsedRaw.data, payload.password);
        parsed = JSON.parse(decryptedRaw);
      } catch (err) {
        return { success: false, error: 'Incorrect Transfer Password or corrupted file.' };
      }
    } else if (parsedRaw && parsedRaw.terXEncryptedExport && typeof parsedRaw.data === 'string') {
      try {
        const decryptedRaw = decryptCredentials(parsedRaw.data);
        parsed = JSON.parse(decryptedRaw);
      } catch (err) {
        return { success: false, error: 'Failed to decrypt import file. It may have been exported from another machine without a password.' };
      }
    } else {
      parsed = parsedRaw;
    }

    let importedList: Partial<ConnectionProfile>[] = [];
    if (Array.isArray(parsed)) {
      importedList = parsed as Partial<ConnectionProfile>[];
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { connections?: unknown[] }).connections)) {
      importedList = (parsed as { connections: Partial<ConnectionProfile>[] }).connections;
    } else {
      return { success: false, error: 'Invalid import format. Expected JSON array or object with connections array.' };
    }

    const normalizedImported = importedList.map((item, index) => normalizeImportedConnection(item, index));
    const existing = loadConnections();
    const mergedById = new Map<string, ConnectionProfile>();

    existing.forEach((connection) => mergedById.set(connection.id, connection));
    normalizedImported.forEach((connection) => mergedById.set(connection.id, connection));

    const merged = Array.from(mergedById.values());
    saveConnections(merged);
    broadcastConnectionsUpdated();

    return {
      success: true,
      canceled: false,
      filePath,
      importedCount: normalizedImported.length,
      totalCount: merged.length,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});
