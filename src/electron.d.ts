/**
 * Global type augmentation for the Electron preload bridge.
 *
 * The `window.electron` object is injected by the Electron preload script
 * and exposes a safe subset of IPC methods to the renderer process.
 * Declaring it here (in a standalone `.d.ts` file) makes the type visible
 * to every file in the project, eliminating the need for per-file
 * `declare global` blocks.
 */

interface ElectronAPI {
  platform?: string;
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => Promise<any>;
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => (() => void);
    off: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
    once: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
    removeAllListeners: (channel: string) => void;
  };
}

interface Window {
  electron?: ElectronAPI;
}
