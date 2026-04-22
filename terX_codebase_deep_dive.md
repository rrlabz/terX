# terX — Deep Codebase Analysis

## 1. What terX Is

**terX** is a cross-platform (Windows & macOS) open-source SSH manager developed by **Rahul R** built on **Electron 33 + React 18 + TypeScript**. It wraps your system's native SSH executable (`ssh.exe` on Windows, `/usr/bin/ssh` on macOS) with a modern dark-themed GUI, encrypted credential storage, and tabbed terminal sessions powered by `xterm.js` and `node-pty`.

---

## 2. Repository Layout

```
terX/
├── src/
│   ├── main/index.ts          # Electron main process (804 lines) — all IPC + window management
│   ├── preload/index.ts       # contextBridge IPC whitelist
│   ├── components/
│   │   ├── App.tsx            # Root React component (678 lines)
│   │   ├── ConnectionManager.tsx  # Left sidebar — host tree + drag-reorder + context menus
│   │   ├── TerminalTabs.tsx   # Tab bar + ghost tooltip + Terminal mountpoints
│   │   ├── Terminal.tsx       # xterm.js instance per tab
│   │   └── ConnectionForm.tsx # Add/Edit host form
│   ├── utils/
│   │   ├── encryption.ts      # AES-256-CBC + safeStorage (DPAPI) key management + CRUD
│   │   ├── ssh.ts             # node-pty SSH process lifecycle + shutdown
│   │   └── settings.ts        # App settings: load/save with encrypted passphrase
│   └── shared/
│       ├── types.ts           # Shared interfaces (ConnectionProfile, etc.)
│       ├── connection-utils.ts # Import normalizer + export projector
│       ├── terminal-utils.ts  # ANSI-strip for ghost preview text
│       └── __tests__/         # vitest unit tests for shared utils
├── settings.html              # Settings window HTML entry-point
├── import-export.html         # Import/Export window HTML entry-point
├── index.html                 # Main window HTML entry-point
└── vite.config.ts             # Vite + vitest config (3 HTML entry points → build/)
```

---

## 3. Process Architecture (Electron 3-Layer Model)

```
┌──────────────────────────────────────────────────────────────┐
│  MAIN PROCESS  (Node.js / Electron)                          │
│  src/main/index.ts                                           │
│  • BrowserWindow management (main, settings, import-export)  │
│  • All ipcMain.handle() — ~25 handlers                       │
│  • Graceful shutdown orchestration                           │
│  • Encryption init, file I/O                                 │
│  • registerSSHHandlers() → src/utils/ssh.ts                  │
└────────────┬─────────────────────────────────────────────────┘
             │  contextBridge (IPC whitelist enforced)
┌────────────▼─────────────────────────────────────────────────┐
│  PRELOAD SCRIPT  src/preload/index.ts                        │
│  • Exposes window.electron.ipcRenderer                       │
│  • 3 whitelists: invoke channels, send channels, event chs   │
│  • ipcRenderer.setMaxListeners(100) for many tabs            │
└────────────┬─────────────────────────────────────────────────┘
             │  window.electron (contextIsolation: true)
┌────────────▼─────────────────────────────────────────────────┐
│  RENDERER PROCESS  (React 18 / Vite)                         │
│  src/App.tsx → ConnectionManager + TerminalTabs → Terminal   │
│  settings.html / import-export.html (separate pages)         │
└──────────────────────────────────────────────────────────────┘
```

**Sandbox note**: `mainWindow` uses `sandbox: false` (required because the preload needs Node access for `ipcRenderer`). The `settingsWindow` and `importExportWindow` use `sandbox: true` (they only invoke IPC, no direct Node APIs needed in preload).

---

## 4. IPC Channel Reference

| Channel | Direction | Handler Location | Purpose |
|---|---|---|---|
| `connections:load` | invoke | main/index.ts | Load & decrypt all profiles |
| `connections:save` | invoke | main/index.ts | Save single profile (encrypted) |
| `connections:save-all` | invoke | main/index.ts | Overwrite all (for reorder/rename) |
| `connections:delete` | invoke | main/index.ts | Delete by ID |
| `connections:updated` | main→renderer | broadcast | Notifies all windows to re-fetch |
| `ssh:connect` | invoke | utils/ssh.ts | Spawn node-pty SSH process |
| `ssh:disconnect` | invoke | utils/ssh.ts | Graceful exit → serialized kill queue |
| `ssh:list-active` | invoke | utils/ssh.ts | Debug: list open tab IDs |
| `ssh:get-help-url` | invoke | utils/ssh.ts | Platform-specific OpenSSH install URL |
| `terminal:input` | send (one-way) | utils/ssh.ts | Keystrokes → pty.write() |
| `terminal:data` | main→renderer | utils/ssh.ts | pty output → xterm.write() |
| `terminal:closed` | main→renderer | utils/ssh.ts | SSH session ended |
| `terminal:reset` | main→renderer | utils/ssh.ts | Tab reconnect: clear xterm |
| `terminal:resize` | invoke | utils/ssh.ts | pty.resize() on window resize |
| `window:minimize/close/…` | invoke | main/index.ts | Custom titlebar controls |
| `window:self-*` | invoke | main/index.ts | Same but targets sender window |
| `window:maximized-state` | main→renderer | event | Sync maximize button icon |
| `window:open-settings` | invoke | main/index.ts | Open/focus settings window |
| `window:open-import-export` | invoke | main/index.ts | Open/focus import-export window |
| `settings:load` | invoke | main/index.ts | Returns sanitized settings (no passphrase) |
| `settings:save` | invoke | main/index.ts | Persist + broadcast update |
| `settings:pick-global-key` | invoke | main/index.ts | OS file picker for SSH key |
| `settings:export-connections` | invoke | main/index.ts | Encrypt+save JSON export file |
| `settings:import-connections` | invoke | main/index.ts | Read+decrypt+merge JSON import |
| `settings:updated` | main→renderer | event | Propagate settings change |
| `clipboard:write-text` | invoke | main/index.ts | Copy-on-select |
| `clipboard:read-text` | invoke | main/index.ts | Right-click paste |
| `app:shutdown-state` | main→renderer | event | Drive shutdown overlay UI |

---

## 5. Encryption System (`src/utils/encryption.ts`)

### Key Management
1. **On first run**: Generate 32 random bytes via `crypto.randomBytes(32)`.
2. **Storage**: If `safeStorage.isEncryptionAvailable()` (Windows DPAPI, macOS Keychain, Linux Secret Service) → store as `safeStorage.encryptString(key.toString('hex'))`.  Otherwise, store raw bytes (chmod 0600).
3. **Legacy migration**: Detects old raw-32-byte file and auto-migrates to safeStorage format on next load.
4. **Key storage path**: Found in the OS-specific user data directory (`%APPDATA%\terX\user-data\.terX-key` on Windows, and the macOS system directory `~/Library/Application Support/terX/user-data/.terX-key`).

### Credential Encryption
- **At-rest**: `AES-256-CBC` with a random 16-byte IV per operation.  Format: `"<iv_hex>:<ciphertext_hex>"`.
- **Detection**: `looksEncrypted()` uses regex `/^[0-9a-f]{32}:[0-9a-f]+$/i` — avoids double-encrypting already-encrypted values.
- **Export (no password)**: Uses the same DPAPI-protected app key → only decryptable on same machine.
- **Export (with transfer password)**: `PBKDF2(password, random_salt, 100000 iter, 32 bytes, sha256)` + AES-256-CBC. Format: `"v1:<salt_hex>:<iv_hex>:<ciphertext_hex>"` — portable across machines.

### CRUD
| Function | Behavior |
|---|---|
| `saveConnection(profile)` | Upsert single profile; encrypts password before write |
| `saveConnections(profiles[])` | Overwrite whole file; skips already-encrypted passwords |
| `loadConnections()` | Read file; auto-decrypt passwords; fallback to raw on error |
| `deleteConnection(id)` | Filter out by ID and rewrite |

---

## 6. SSH Process Lifecycle (`src/utils/ssh.ts`)

### Connection flow
1. `ssh:connect` handler receives `ConnectionProfile + tabId`.
2. Resolves SSH path: checks `C:\Windows\System32\OpenSSH\ssh.exe` on Windows first, falling back to `where ssh` or `which ssh` (macOS) via PATH lookup.
3. Builds SSH args: `ConnectTimeout=15`, `ServerAliveInterval=30`, `StrictHostKeyChecking=accept-new`, optional `-i <key>`, `-p <port>`, `user@host`.
4. Spawns `node-pty` → `pty.spawn(sshCommandPath, args, {name:'xterm-256color', cols:120, rows:30})`.
5. Registers `onData` handler: streams output to renderer via `terminal:data`. Also auto-handles password prompts (regex match on `"password:"`) and key passphrase prompts (regex on `"Enter passphrase"`).
6. Registers `onExit` → sends `terminal:closed` + removes from `activeConnections` Map.
7. Stores `{ id, process, connected }` in `activeConnections: Map<string, ActiveConnection>`.

### Disconnect (single tab)
- Queued via `disconnectQueue[]` to serialize teardown — prevents concurrent Win32 ConPTY crashes.
- For each: write `"exit\r"` → wait 300ms → push to `pendingKillQueue` (which yields 50ms between hard kills).

### Graceful App Shutdown
```
performGracefulAppShutdown()
  ├── Emit 'starting' shutdown-state to renderer (shows overlay)
  ├── await 80ms (yield for renderer to paint)
  ├── shutdownActiveConnectionsWithProgress() — batched (8 concurrent)
  │     ├── write 'exit\r' to all in batch
  │     ├── yield to event loop
  │     └── await stopConnectionAndWait() per connection
  │           ├── onExit listener → resolve()
  │           ├── 300ms grace → safeKillPty()
  │           └── 1200ms hard timeout → resolve()
  ├── clearTimeout(forcedExitTimer)  (12s force-exit watchdog)
  ├── Emit 'complete' shutdown-state
  ├── Destroy settingsWindow + importExportWindow
  └── mainWindow.close() → app.quit()
```

**Critical Win32 workaround**: `safeKillPty()` uses `process.kill(ptyProcess.pid)` instead of `ptyProcess.kill()` on Windows to avoid a native C++ assertion crash in ConPTY's teardown path.

---

## 7. React State Architecture (`src/App.tsx`)

### Key State
| State | Type | Purpose |
|---|---|---|
| `connections` | `ConnectionProfile[]` | All saved hosts (from main process) |
| `activeTabs` | `Map<string, ConnectionProfile>` | Open terminal tabs (tabId → profile) |
| `selectedTab` | `string | null` | Currently visible tab |
| `tabPreviewTextRef` | `Ref<Record<string,string>>` | ANSI-stripped text per tab (for tooltip) |
| `tabPreviewRawRef` | `Ref<Record<string,string>>` | Raw terminal output per tab (for mini-ghost) |
| `sidebarWidth` | `number` | Draggable sidebar pixel width |
| `shutdownOverlay` | `{visible, message}` | Full-screen "Closing..." overlay |
| `initTasksCompleted` | `{connections, settings, windowState}` | Launch splash gate |

### Performance Design
- Terminal data events are **written to refs**, not state — avoids React re-renders at high data rates.
- `getPreviewText(tabId)` and `getPreviewRaw(tabId)` are **stable `useCallback` getters** passed to `TerminalTabs`, so tooltip reads happen on-demand without prop-drilling reactive data.
- `activeConnectionIds` is `useMemo`-derived from `activeTabs` — passed to `ConnectionManager` for the green ▶ indicator.
- `ConnectionManager` is `React.memo`-wrapped.

---

## 8. Component Breakdown

### `ConnectionManager.tsx`
- Renders a **tree view**: Groups → Hosts (collapsible, drag-reorderable at both levels).
- Search filters across name/host/username/description. During search, drag-and-drop is disabled and groups are force-expanded.
- Context menus (clamped to viewport): Group → Rename / New Host In Group; Host → Delete Host.
- Details pane at the bottom shows selected host metadata with Connect + Edit buttons.
- Uses **local optimistic state** (`localConnections`) and syncs to main process via `connections:save-all`.

### `TerminalTabs.tsx`
- Horizontal scrolling tab bar with drag-and-drop reorder (mouse position determines before/after).
- **Ghost preview tooltip**: on hover (200ms delay) renders `MiniTerminalGhost` — a tiny read-only xterm instance showing the last 8KB of raw terminal output, plus a "last command" line extracted from ANSI-stripped text.
- Right-click context menu: Duplicate / Reconnect / Close.
- All `Terminal` instances are always mounted (hidden via `display:none`) — preserves xterm buffer when switching tabs.

### `Terminal.tsx`
- One `XTerm` instance per tab, initialized once (fontSize/scrollback changes update `options` in-place to avoid buffer clear).
- `FitAddon` + `ResizeObserver` + `requestAnimationFrame` debouncing for terminal resize.
- **Copy-on-select**: `onSelectionChange` auto-writes to clipboard via `clipboard:write-text`.
- **Right-click paste**: reads clipboard via `clipboard:read-text` and sends as `terminal:input`.

### `ConnectionForm.tsx`
- Add/edit host form with fields: name, host, port (default 22), username, password (masked), private key path, description, group.
- Validates required fields + port range.
- On submit, calls `connections:save` IPC.

---

## 9. Settings System

- **File**: `%APPDATA%\terX\user-data\settings.json`
- **Stored fields**: `terminalScrollback`, `terminalFontSize`, `globalSshKeyPath`, `globalUsername`, `globalSshKeyPassphraseEncrypted`.
- The passphrase is **never stored in plaintext** — always encrypted with the same AES-256-CBC key.
- The renderer receives a **sanitized view** (`hasGlobalSshKeyPassphrase: boolean` instead of the actual value) — the passphrase never crosses the IPC bridge.
- Bounds enforcement: scrollback clamped 500–200,000; font size clamped 8–32.

---

## 10. Build Pipeline

| Command | What it does |
|---|---|
| `npm start` | `concurrently` Vite dev server (port 3000) + Electron in dev mode |
| `npm run build` | `vite build` → `build/` + `tsc` → `dist/main/` + `dist/preload/` |
| `npm run build:setup` | Above + `electron-builder --win nsis` (Windows Installer) |
| `npm run build:portable`| Above + `electron-builder --win portable` (Windows Portable) |
| `npm run build:mac` | Above + package for macOS (`dmg`, `zip`) via `scripts/build-mac.js` |
| `npm test` | `vitest run` (unit tests in `src/shared/__tests__/`) |

**Key config decisions**:
- `npmRebuild: false` in electron-builder — avoids recompiling `node-pty` from source (uses prebuilt binaries).
- `asarUnpack: ["node_modules/node-pty/**"]` — node-pty's native `.node` addon must be outside the ASAR archive.
- Vite outputs to `build/` (React) while `tsc` outputs to `dist/` (main+preload). Both are packaged together.
- 3 HTML entry points in Vite: `index.html` (main), `settings.html`, `import-export.html`.

---

## 11. Data Flow Summary

```
User double-clicks host in ConnectionManager
  → App.handleConnect()
    → ipcRenderer.invoke('ssh:connect', profile, tabId)
      → Main: pty.spawn('ssh.exe', args)
        → pty.onData → ipcMain → 'terminal:data' → renderer
          → Terminal.tsx: xterm.write(data)
          → App: tabPreviewRawRef + tabPreviewTextRef (no re-render)
        → pty.onExit → 'terminal:closed' → Terminal.tsx writes "[Connection closed]"

User closes tab (×)
  → App.handleDisconnect(tabId)
    → setActiveTabs (remove tab immediately — optimistic)
    → ipcRenderer.invoke('ssh:disconnect', tabId) [fire-and-forget]
      → Main: disconnectQueue → processDisconnectQueue()
        → write 'exit\r' → 300ms → pendingKillQueue → drainKillQueue()
          → safeKillPty (with 50ms yield between kills)

User clicks window ×
  → App.handleCloseWindow()
    → show shutdown overlay
    → ipcRenderer.invoke('window:close')
      → Main: performGracefulAppShutdown()
        → shutdownActiveConnectionsWithProgress() (batched, progress events)
        → Emit 'app:shutdown-state' updates → renderer updates overlay message
        → Destroy child windows → mainWindow.close() → app.quit()
```

---

## 12. Known Design Decisions & Gotchas

| Area | Decision / Gotcha |
|---|---|
| **Win32 ConPTY crash** | On Windows, uses `process.kill(pid)` instead of `ptyProcess.kill()` to avoid native assertion in C++ teardown. macOS uses standard `ptyProcess.kill()`. |
| **Concurrent kill crash** | `pendingKillQueue` serializes kills with 50ms yields; `disconnectQueue` serializes tab closures |
| **preload `off()` unreliable** | Function identity not preserved through contextBridge — use cleanup fn returned by `on()` |
| **Terminal buffer preservation** | All tabs always mounted (`display:none`), not unmounted — preserves xterm scroll history |
| **fontSize/scrollback** | Updated via `term.options.*` in-place to avoid re-initializing xterm (which would clear the buffer) |
| **Terminal data as refs** | High-frequency `terminal:data` events write to `useRef`, not `useState`, to avoid React re-render storms |
| **safeStorage + sandbox** | Settings/import-export windows use `sandbox:true`; main window uses `sandbox:false` (preload needs Node for IPC) |
| **12s force-shutdown watchdog** | If graceful shutdown hangs (e.g. EDR blocking TerminateProcess), forces `app.exit(0)` |
| **80ms renderer yield** | Before starting kill loop, yields 80ms so the shutdown overlay paints before synchronous Win32 calls block |
| **DPAPI-bound export** | Non-password exports are encrypted with the DPAPI key and are **not portable** to other machines |
