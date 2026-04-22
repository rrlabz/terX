import { execSync } from 'child_process';
import { ipcMain, BrowserWindow } from 'electron';
import { ConnectionProfile } from './encryption';
import { loadAppSettings } from './settings';
import fs from 'fs';
import * as pty from 'node-pty';

function safeKillPty(ptyProcess: pty.IPty) {
  try {
    if (global.process.platform === 'win32') {
      // Workaround for node-pty "remove_pty_baton" assertion failure on Windows.
      // Calling ptyProcess.kill() while the process is exiting causes a native C++ crash.
      process.kill(ptyProcess.pid);
    } else {
      ptyProcess.kill();
    }
  } catch (error) {
    // Ignore errors like ESRCH if process is already dead
  }
}

interface ActiveConnection {
  id: string;
  process: pty.IPty;
  connected: boolean;
  lastInput?: string;
  lastInputAt?: number;
}

export interface ShutdownConnectionsProgress {
  total: number;
  completed: number;
  remaining: number;
}

const activeConnections = new Map<string, ActiveConnection>();
const SHUTDOWN_WAIT_TIMEOUT_MS = 1200;
const GRACEFUL_EXIT_DELAY_MS = 300;
const SHUTDOWN_CONCURRENCY = 8;
let isConnectionShutdownInProgress = false;

// Queue for deferred process kills.  When many tabs are closed at once, each
// schedules a force-kill after the graceful exit delay.  Without a queue, all
// those kill() calls fire simultaneously and block the main thread (Win32
// TerminateProcess is synchronous).  The queue serializes them with event-loop
// yields so IPC handlers (like ssh:connect) remain responsive.
//
// Each entry tracks whether the process already exited (via the graceful 'exit'
// command).  Calling kill() on an already-exited ConPTY process triggers a
// native C++ assertion crash, so we must skip it.
interface PendingKill {
  process: pty.IPty;
  exited: boolean;
}

const pendingKillQueue: PendingKill[] = [];
let isProcessingKillQueue = false;

async function drainKillQueue(): Promise<void> {
  if (isProcessingKillQueue) return;
  isProcessingKillQueue = true;

  while (pendingKillQueue.length > 0) {
    const item = pendingKillQueue.shift()!;
    if (!item.exited) {
      safeKillPty(item.process);
      // Wait 50ms after a hard kill to let Windows ConPTY handles stabilize.
      // Rapid concurrent kills are known to crash the Node process on Windows.
      await new Promise(resolve => setTimeout(resolve, 50));
    } else {
      // Yield after each item so the event loop can process pending IPC calls.
      await yieldToEventLoop();
    }
  }

  isProcessingKillQueue = false;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function getLiveMainWindow(getMainWindow: () => BrowserWindow | null): BrowserWindow | null {
  const target = getMainWindow();
  if (!target || target.isDestroyed()) {
    return null;
  }
  return target;
}

function sendToMainWindow(getMainWindow: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const target = getLiveMainWindow(getMainWindow);
  if (!target) {
    return;
  }

  target.webContents.send(channel, payload);
}

function commandExists(command: string): boolean {
  try {
    if (global.process.platform === 'win32') {
      execSync(`where ${command}`, { stdio: 'ignore' });
    } else {
      execSync(`which ${command}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function getCommandPath(command: string): string {
  try {
    const lookupCommand = global.process.platform === 'win32' ? `where ${command}` : `which ${command}`;
    const output = execSync(lookupCommand, { stdio: 'pipe', encoding: 'utf-8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    return output || command;
  } catch {
    return command; // Return command name if we can't find full path
  }
}

function resolveNativeSSHPath(): string {
  if (global.process.platform === 'win32') {
    const windowsNativeSSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
    if (fs.existsSync(windowsNativeSSH)) {
      return windowsNativeSSH;
    }
  }

  return getCommandPath('ssh');
}

function findConnectionKeyByTabId(tabId: string): string | undefined {
  return Array.from(activeConnections.keys()).find((key) => key === tabId);
}

function isCurrentProcessForKey(key: string, processRef: pty.IPty): boolean {
  const current = activeConnections.get(key);
  return Boolean(current && current.process === processRef);
}

export function registerSSHHandlers(getMainWindow: () => BrowserWindow | null): void {
  // Guard against accidental duplicate IPC registration in dev/reload flows.
  ipcMain.removeHandler('ssh:connect');
  ipcMain.removeHandler('terminal:resize');
  ipcMain.removeHandler('ssh:disconnect');
  ipcMain.removeHandler('ssh:list-active');
  ipcMain.removeHandler('ssh:get-help-url');
  ipcMain.removeAllListeners('terminal:input');

  ipcMain.handle('ssh:connect', async (_event, connection: ConnectionProfile, tabId: string) => {
    try {
      const key = tabId;

      // Reconnect support: if a process already exists for this tab, stop it first.
      const existing = activeConnections.get(key);
      if (existing) {
        sendToMainWindow(getMainWindow, 'terminal:reset', { tabId });
        safeKillPty(existing.process);
        activeConnections.delete(key);
      }

      const sshCommandPath = resolveNativeSSHPath();

      if (!sshCommandPath || (!fs.existsSync(sshCommandPath) && !commandExists('ssh'))) {
        return {
          success: false,
          error: 'OpenSSH (ssh) was not found in PATH. Please install/enable OpenSSH.',
          installUrl: true,
        };
      }

      // Build native OpenSSH command and force TTY for interactive shells.
      const args: string[] = [
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'BatchMode=no',
        '-o', 'StrictHostKeyChecking=accept-new',
      ];

      const appSettings = loadAppSettings();
      const hostHasNoAuth = !connection.privateKeyPath && !connection.password;
      const effectivePrivateKeyPath = connection.privateKeyPath || (hostHasNoAuth ? appSettings.globalSshKeyPath : '');
      const effectiveUsername = (connection.username || '').trim() || (appSettings.globalUsername || '').trim();

      if (!effectiveUsername) {
        return {
          success: false,
          error: 'Username is required. Set a host username or configure a global username in Settings.',
        };
      }

      if (effectivePrivateKeyPath) {
        args.push('-i', effectivePrivateKeyPath);
      }

      args.push('-p', connection.port.toString());
      args.push(`${effectiveUsername}@${connection.host}`);

      // Always use native OpenSSH for consistent behavior across macOS and Windows.
      const command = sshCommandPath;
      const commandPath = sshCommandPath;
      console.log(`SSH: Using command "${commandPath}" with args: ${args.join(' ')}`);

      let sshPty: pty.IPty;
      try {
        sshPty = pty.spawn(commandPath, args, {
          name: process.env.TERM || 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: process.env.TERM || 'xterm-256color',
          },
        });
      } catch (spawnError) {
        console.error('Failed to spawn process:', spawnError);
        return {
          success: false,
          error: `Failed to spawn SSH process: ${(spawnError as Error).message}`,
        };
      }

      // Send immediate status so user sees progress in the terminal tab.
      sendToMainWindow(getMainWindow, 'terminal:data', {
        tabId,
        data: `[SSH] Starting native OpenSSH: ${commandPath}\n`,
      });

      let passwordAttempted = false;
      let keyPassphraseAttempted = false;
      const globalKeyPassphrase = appSettings.globalSshKeyPassphrase || '';

      sshPty.onData((data: string) => {
        if (!isCurrentProcessForKey(key, sshPty)) {
          return;
        }

        if (isConnectionShutdownInProgress) {
          return;
        }

        sendToMainWindow(getMainWindow, 'terminal:data', { tabId, data });

        if (!keyPassphraseAttempted && globalKeyPassphrase) {
          const isPassphrasePrompt = /enter\s+passphrase\s+for\s+key|passphrase\s+for\s+key/i.test(data);
          if (isPassphrasePrompt) {
            keyPassphraseAttempted = true;
            sshPty.write(`${globalKeyPassphrase}\r`);
            return;
          }
        }

        if (!passwordAttempted && connection.password) {
          const isPasswordPrompt = /password\s*:/i.test(data);
          if (isPasswordPrompt) {
            passwordAttempted = true;
            sshPty.write(`${connection.password}\r`);
          }
        }
      });

      sshPty.onExit(({ exitCode }) => {
        if (!isCurrentProcessForKey(key, sshPty)) {
          return;
        }

        if (!isConnectionShutdownInProgress) {
          sendToMainWindow(getMainWindow, 'terminal:closed', { tabId, code: exitCode });
        }
        activeConnections.delete(key);
      });

      activeConnections.set(key, {
        id: key,
        process: sshPty,
        connected: true,
        lastInput: undefined,
        lastInputAt: 0,
      });

      return { success: true, connectionKey: key, command };
    } catch (error) {
      const errorMsg = (error as Error).message;
      if (errorMsg.includes('ENOENT')) {
        return {
          success: false,
          error: 'OpenSSH (ssh) was not found. Please install/enable OpenSSH to use this feature.',
          installUrl: true,
        };
      }
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.on('terminal:input', (_event, { tabId, input }) => {
    if (isConnectionShutdownInProgress) {
      return;
    }

    const key = findConnectionKeyByTabId(tabId);
    if (key) {
      const conn = activeConnections.get(key);
      if (conn) {
        try {
          const now = Date.now();
          const isDuplicateBurst = conn.lastInput === input && now - (conn.lastInputAt || 0) < 15;
          if (isDuplicateBurst) {
            return;
          }

          conn.lastInput = input;
          conn.lastInputAt = now;
          conn.process.write(input);
        } catch (error) {
          console.error('Failed to write to stdin:', error);
        }
      }
    }
  });

  ipcMain.handle('terminal:resize', async (_event, { tabId, cols, rows }) => {
    const key = findConnectionKeyByTabId(tabId);
    if (!key) {
      return { success: false, error: 'Connection not found for tab resize' };
    }

    const conn = activeConnections.get(key);
    if (!conn) {
      return { success: false, error: 'Active connection not found' };
    }

    try {
      const safeCols = Math.max(1, Number(cols) || 120);
      const safeRows = Math.max(1, Number(rows) || 30);
      conn.process.resize(safeCols, safeRows);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Queue for serialized tab closures to prevent Windows ConPTY subsystem crashes
  // when closing many tabs concurrently.
  const disconnectQueue: string[] = [];
  let isProcessingDisconnects = false;

  const processDisconnectQueue = async () => {
    if (isProcessingDisconnects) return;
    isProcessingDisconnects = true;

    while (disconnectQueue.length > 0) {
      const connectionKey = disconnectQueue.shift()!;
      const resolvedKey = activeConnections.has(connectionKey)
        ? connectionKey
        : findConnectionKeyByTabId(connectionKey);
      
      const conn = resolvedKey ? activeConnections.get(resolvedKey) : undefined;
      if (conn && resolvedKey) {
        activeConnections.delete(resolvedKey);

        try {
          conn.process.write('exit\r');
        } catch {}

        const pending: PendingKill = { process: conn.process, exited: false };
        const exitSub = conn.process.onExit(() => {
          pending.exited = true;
          exitSub.dispose();
        });

        setTimeout(() => {
          pendingKillQueue.push(pending);
          void drainKillQueue();
        }, GRACEFUL_EXIT_DELAY_MS);

        // Yield and wait briefly before tearing down the next connection
        // to prevent ConPTY concurrent teardown crash on Windows.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    isProcessingDisconnects = false;
  };

  ipcMain.handle('ssh:disconnect', async (_event, connectionKey: string) => {
    try {
      disconnectQueue.push(connectionKey);
      void processDisconnectQueue();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('ssh:list-active', async () => {
    return Array.from(activeConnections.keys());
  });

  ipcMain.handle('ssh:get-help-url', async () => {
    const isMac = global.process.platform === 'darwin';
    if (isMac) {
      return 'https://support.apple.com/guide/terminal/open-or-quit-terminal-trml113/mac';
    } else if (global.process.platform === 'win32') {
      return 'https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse';
    } else {
      return 'https://www.openssh.com/';
    }
  });
}

export function shutdownActiveConnections(): void {
  isConnectionShutdownInProgress = true;

  activeConnections.forEach((conn) => {
    safeKillPty(conn.process);
  });

  activeConnections.clear();
}



function stopConnectionAndWait(key: string, conn: ActiveConnection): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(gracefulTimer);
      exitDisposable.dispose();
      activeConnections.delete(key);
      resolve();
    };

    const exitDisposable = conn.process.onExit(() => {
      finish();
    });

    const timeoutHandle = setTimeout(() => {
      finish();
    }, SHUTDOWN_WAIT_TIMEOUT_MS);

    // Attempt a graceful close first by sending 'exit' to the SSH session.
    // This lets OpenSSH close cleanly, which is much faster than a forced kill
    // and avoids blocking the main thread on slow Win32 TerminateProcess calls
    // (especially on machines with EDR/antivirus hooking process teardown).
    try {
      conn.process.write('exit\r');
    } catch {
      // Process may already be dead or stdin closed — that's fine.
    }

    // After a short grace period, force-kill if the process hasn't exited yet.
    // We check `settled` because if onExit already fired, the process is gone
    // and calling kill() on a dead ConPTY triggers a native assertion crash.
    const gracefulTimer = setTimeout(() => {
      if (settled) return;
      safeKillPty(conn.process);
      // Ensure we finish even if safeKillPty swallowed an error and no onExit fires
      setTimeout(finish, 50);
    }, GRACEFUL_EXIT_DELAY_MS);
  });
}

export async function shutdownActiveConnectionsWithProgress(
  onProgress?: (progress: ShutdownConnectionsProgress) => void
): Promise<void> {
  isConnectionShutdownInProgress = true;

  try {
    const entries = Array.from(activeConnections.entries());
    const total = entries.length;

    let completed = 0;
    onProgress?.({ total, completed, remaining: total });

    if (total === 0) {
      return;
    }

    for (let start = 0; start < entries.length; start += SHUTDOWN_CONCURRENCY) {
      const batch = entries.slice(start, start + SHUTDOWN_CONCURRENCY);

      // Send graceful 'exit' to every connection in the batch first,
      // then yield so the event loop can process OS messages and keep
      // the window responsive (prevents Windows "Not Responding").
      for (const [, conn] of batch) {
        try {
          conn.process.write('exit\r');
        } catch {
          // Ignore — process may already be gone.
        }
      }

      await yieldToEventLoop();

      await Promise.all(batch.map(async ([key, conn]) => {
        await stopConnectionAndWait(key, conn);
        completed += 1;
        onProgress?.({
          total,
          completed,
          remaining: Math.max(0, total - completed),
        });

        // Yield after each individual connection so the event loop stays
        // responsive even within a batch. This is critical on Windows where
        // node-pty kill() is a synchronous Win32 call that can block.
        await yieldToEventLoop();
      }));
    }

    activeConnections.clear();
  } finally {
    isConnectionShutdownInProgress = false;
  }
}
