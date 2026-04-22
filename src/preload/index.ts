import { contextBridge, ipcRenderer } from 'electron';

const validInvokeChannels = new Set([
  'connections:load',
  'connections:save',
  'connections:delete',
  'connections:save-all',
  'clipboard:write-text',
  'clipboard:read-text',
  'ssh:connect',
  'ssh:disconnect',
  'ssh:list-active',
  'ssh:get-help-url',
  'terminal:resize',
  'window:minimize',
  'window:toggle-maximize',
  'window:is-maximized',
  'window:close',
  'window:show-system-menu',
  'window:self-minimize',
  'window:self-toggle-maximize',
  'window:self-is-maximized',
  'window:self-close',
  'window:self-show-system-menu',
  'window:open-settings',
  'window:open-import-export',
  'settings:load',
  'settings:save',
  'settings:pick-global-key',
  'settings:export-connections',
  'settings:import-connections',
]);

const validSendChannels = new Set([
  'terminal:input',
]);

const validEventChannels = new Set([
  'connections:updated',
  'terminal:data',
  'terminal:closed',
  'terminal:reset',
  'window:maximized-state',
  'settings:updated',
  'app:shutdown-state',
]);

function assertAllowedChannel(channel: string, allowedChannels: Set<string>): void {
  if (!allowedChannels.has(channel)) {
    throw new Error(`Blocked IPC channel: ${channel}`);
  }
}

// Increase max listeners to prevent warnings when many terminal tabs are open simultaneously
ipcRenderer.setMaxListeners(100);

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      assertAllowedChannel(channel, validInvokeChannels);
      return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => {
      assertAllowedChannel(channel, validEventChannels);
      const subscription = (event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(event, ...args);
      ipcRenderer.on(channel, subscription);
      return () => {
        ipcRenderer.off(channel, subscription);
      };
    },
    off: (channel: string, listener: (event: any, ...args: any[]) => void) => {
      // NOTE: This off() method is unreliable through contextBridge because function identity is not preserved.
      // Callers should use the cleanup function returned by on() instead.
      assertAllowedChannel(channel, validEventChannels);
      return ipcRenderer.off(channel, listener);
    },
    once: (channel: string, listener: (event: any, ...args: any[]) => void) => {
      assertAllowedChannel(channel, validEventChannels);
      const subscription = (event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(event, ...args);
      ipcRenderer.once(channel, subscription);
    },
    send: (channel: string, ...args: unknown[]) => {
      assertAllowedChannel(channel, validSendChannels);
      return ipcRenderer.send(channel, ...args);
    },
    removeAllListeners: (channel: string) => {
      assertAllowedChannel(channel, validEventChannels);
      return ipcRenderer.removeAllListeners(channel);
    },
  },
});
