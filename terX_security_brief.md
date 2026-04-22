# terX — Application & Security Brief

> **Document Purpose:** This note provides a comprehensive overview of the terX application, its architecture, and security implementation. It is intended for IT management, security reviewers, and team members who need to understand the tool before deployment or use.

---

## 1. What is terX?

terX is an internal desktop application that provides a centralized interface for managing SSH connections to remote servers. It replaces the workflow of manually opening terminals and typing `ssh user@host` commands by providing:

- A **saved connection library** organized into groups
- **Tabbed terminal sessions** — multiple SSH connections in a single window
- **Encrypted credential storage** — passwords are never stored in plain text
- **One-click connect** — double-click a host to open a session

### Who is it for?

Application Support and IT operations staff who regularly connect to multiple Linux/Unix servers for troubleshooting, monitoring, and administration tasks.

### What problem does it solve?

| Without terX | With terX |
|---|---|
| Open a new terminal window for each server | All servers accessible in one tabbed window |
| Type SSH commands manually every time | Double-click a saved host to connect instantly |
| Remember or look up credentials per server | Credentials stored securely and auto-filled |
| No visual organization of servers | Hosts organized into named groups |
| Credentials in plain-text notes or spreadsheets | Passwords encrypted with AES-256-CBC + DPAPI |

---

## 2. Architecture Overview

terX is built on **Electron 33** (Chromium + Node.js) with a strict process separation model:

```
┌──────────────────────────────────────────────────────┐
│                    terX                        │
│                                                      │
│  ┌──────────────┐    IPC Bridge    ┌───────────────┐ │
│  │   Renderer   │◄──────────────►│  Main Process  │ │
│  │  (React UI)  │  (contextBridge) │  (Node.js)     │ │
│  │              │                 │                 │ │
│  │ • Tab bar    │                 │ • File I/O      │ │
│  │ • Terminal   │                 │ • Encryption    │ │
│  │ • Sidebar    │                 │ • SSH spawning  │ │
│  └──────────────┘                 └───────┬─────────┘ │
│                                           │           │
│                                    ┌──────▼──────┐    │
│                                    │  node-pty   │    │
│                                    │  (native)   │    │
│                                    └──────┬──────┘    │
│                                           │           │
└───────────────────────────────────────────┼───────────┘
                                            │
                                    ┌───────▼───────┐
                                    │  Windows SSH  │
                                    │  (ssh.exe)    │
                                    └───────┬───────┘
                                            │
                                    ┌───────▼───────┐
                                    │ Remote Server │
                                    └───────────────┘
```

**Key point:** terX does **not** implement its own SSH protocol. It launches the operating system's native OpenSSH client (`ssh.exe`), which handles all cryptographic negotiation, key exchange, and data encryption over the wire.

### Build Architecture

The application uses a **two-pipeline build system**:

| Pipeline | Tool | Output | Purpose |
|---|---|---|---|
| Frontend | Vite 8 | `build/` | React UI + HTML windows |
| Main process | TypeScript compiler (`tsc`) | `dist/` | Electron main + preload scripts |
| Packaging | electron-builder 26 | `dist/*.exe` | Windows portable/installer |

---

## 3. Security Architecture

### 3.1 Credential Encryption (At Rest)

All saved passwords are encrypted before being written to disk.

| Property | Detail |
|----------|--------|
| **Algorithm** | AES-256-CBC (Advanced Encryption Standard, 256-bit key, CBC mode) |
| **Key size** | 256 bits (32 bytes), generated via Node.js `crypto.randomBytes()` |
| **IV (Initialization Vector)** | 128-bit random IV generated **per credential entry** |
| **Storage format** | `<hex IV>:<hex ciphertext>` — the IV is stored alongside the ciphertext (standard practice; the IV is not a secret) |
| **Key generation** | One-time generation on first launch; reused for all subsequent encrypt/decrypt operations |

**What this means:** Even if someone copies the `credentials.json` file, they cannot read any passwords without the encryption key.

### 3.2 Encryption Key Protection (DPAPI)

The 256-bit master encryption key is itself protected by the Windows operating system:

| Property | Detail |
|----------|--------|
| **Protection mechanism** | Windows DPAPI (Data Protection API) via Electron's `safeStorage` module |
| **Bound to** | The current Windows user account's login credentials |
| **Access scope** | Only the Windows user who created the key can decrypt it |
| **Other users** | Other accounts on the same machine **cannot** decrypt the key |
| **Domain scenarios** | In Active Directory environments, DPAPI keys are backed by the user's domain credentials |

**What this means:** The encryption key is useless to anyone who is not logged into the same Windows account. Even a local administrator on a different account cannot decrypt it without the original user's credentials.

### 3.3 Data Storage Locations

All application data resides in the user's local app data directory. No data is stored in shared or world-readable locations.

| File | Contents | Protection |
|------|----------|------------|
| `%APPDATA%\terX\user-data\credentials.json` | Host profiles with AES-encrypted passwords | User-only directory; passwords individually encrypted |
| `%APPDATA%\terX\user-data\.terX-key` | Master encryption key | DPAPI-encrypted blob; only current user can decrypt |
| `%APPDATA%\terX\user-data\settings.json` | App preferences (font size, scrollback) | No sensitive data |

> **Note:** The `user-data\` subdirectory is created and managed automatically by the application at startup. The application also sets its Electron `userData`, `sessionData`, and `cache` paths to this dedicated subdirectory, keeping all application data cleanly isolated.

### 3.4 Network Security

| Aspect | Implementation |
|--------|----------------|
| **SSH protocol** | Handled entirely by Windows OpenSSH (`ssh.exe`) — not a custom implementation |
| **Host key verification** | Uses the system's `~/.ssh/known_hosts` with `StrictHostKeyChecking=accept-new` — automatically accepts new hosts on first connect but **rejects key changes** |
| **Connect timeout** | 15-second timeout enforced via `-o ConnectTimeout=15` |
| **Keep-alive** | `ServerAliveInterval=30` / `ServerAliveCountMax=3` to detect dead connections |
| **SSH configuration** | Respects the user's `~/.ssh/config` for per-host settings |
| **Outbound connections** | terX makes **no outbound network requests** other than the SSH connections the user explicitly initiates |
| **Telemetry** | None — no analytics, crash reporting, or update checks |
| **Cloud sync** | None — all data is local-only |

### 3.5 Electron Security Model

The application follows Electron security best practices:

| Security Feature | Status | Detail |
|-----------------|--------|--------|
| **Context Isolation** | ✅ Enabled | Renderer JavaScript cannot access Node.js APIs directly |
| **Node Integration** | ❌ Disabled | The browser window has no direct access to the filesystem or OS |
| **Preload Sandbox** | ⚙️ `false` (required) | The preload script must access Node.js APIs (`contextBridge`, `ipcRenderer`) to function. Security is enforced by `contextIsolation: true` and the IPC channel whitelist instead. |
| **IPC Channel Whitelist** | ✅ Enforced | Every channel name is validated against an explicit allowlist in the preload before forwarding. Unrecognised channels throw an error. |
| **Remote Module** | ❌ Disabled | No remote code execution capability |
| **WebSecurity** | ✅ Enabled | Same-origin policy enforced |

**On the sandbox setting:** Electron's `sandbox: true` prevents the preload script from accessing any Node.js APIs — including `contextBridge` and `ipcRenderer` — making it incompatible with the `contextBridge` security pattern. The correct hardened model is `sandbox: false` + `contextIsolation: true`, which is what this application uses. The renderer process still has no access to Node.js; only the explicitly whitelisted IPC channels are exposed through the bridge.

**What this means:** Even if a malicious script were somehow injected into the UI, it could not read files from disk, execute system commands, or access the encryption key directly. All sensitive operations go through validated IPC handlers in the main process.

### 3.6 Input Deduplication

The `terminal:input` IPC handler includes a **15 ms burst deduplication guard**: if the exact same keystroke is received twice within 15 ms (a known Electron edge case in certain keyboard configurations), the duplicate is silently dropped. This prevents accidental double-input without affecting normal typing speed.

### 3.7 Export/Import Considerations

| Scenario | Security Note |
|----------|--------------| 
| **Exporting hosts** | The user can optionally include passwords in their JSON export. If they provide a **Transfer Password**, the entire export is encrypted using AES-256-CBC with a PBKDF2-derived key (Portable). If they DO NOT provide a password, the entire export is encrypted using the machine-bound DPAPI key. **There are never plain text passwords in an export file.** |
| **Importing hosts** | Imported passwords are **immediately encrypted** with the local DPAPI AES key upon import. The original import file can be deleted. |
| **Recommendation** | Always use a Transfer Password when exporting credentials if you intend to move them to another machine. DPAPI-bound exports cannot be imported on another computer or by another user account. |

---

## 4. Data Flow Summary

### Saving a Password

```
User enters password in UI
        │
        ▼
Renderer sends to Main process via IPC (contextBridge)
        │
        ▼
Main process generates random 128-bit IV
        │
        ▼
Main process encrypts password with AES-256-CBC (key + IV)
        │
        ▼
Encrypted string (iv:ciphertext) written to credentials.json
```

### Connecting to a Server

```
User double-clicks a host
        │
        ▼
Main process loads credentials.json
        │
        ▼
Main process decrypts password using AES key
        │
        ▼
Main process spawns node-pty → ssh.exe:
  ssh -o ConnectTimeout=15 -o ServerAliveInterval=30
      -o StrictHostKeyChecking=accept-new
      -p <port> user@host
        │
        ▼
Terminal output streamed back to UI via IPC (terminal:data)
        │
        ▼
If password prompt detected: password sent to SSH stdin (not stored in UI)
```

### Application Shutdown

```
User clicks close (✕)
        │
        ▼
Graceful shutdown begins; shutdown overlay shown immediately
        │
        ▼
For each open SSH session (in batches of 8):
  1. Send "exit" command to gracefully close SSH
  2. Wait up to 300ms for process to exit naturally
  3. Force-kill if still running (safeKillPty)
  4. Yield to OS event loop between each kill (prevents "Not Responding")
  5. 50ms serialization delay between kills (prevents Windows ConPTY crash)
        │
        ▼
12-second hard timeout ensures app always exits even if teardown hangs
        │
        ▼
Application exits cleanly
```

---

## 5. What terX Does NOT Do

| Concern | Answer |
|---------|--------|
| Store passwords in plain text | ❌ Never — always AES-256-CBC encrypted |
| Send credentials to the internet | ❌ No network requests except user-initiated SSH connections |
| Implement its own SSH protocol | ❌ Uses the OS-provided OpenSSH client |
| Store data in shared/temp directories | ❌ All data in user-specific `%APPDATA%\terX\user-data\` |
| Run with elevated privileges | ❌ Runs as the current user — no admin rights required |
| Bypass SSH host key verification | ❌ Uses standard OpenSSH known_hosts |
| Accept changed host keys silently | ❌ `StrictHostKeyChecking=accept-new` only accepts genuinely new hosts |
| Include analytics or telemetry | ❌ No tracking of any kind |
| Phone home or auto-update | ❌ Fully offline after installation |
| Require Visual Studio / build tools | ❌ Uses prebuilt `node-pty` binaries — no native compilation at build time |

---

## 6. Risk Assessment

| Risk | Mitigation | Residual Risk |
|------|-----------|---------------|
| Credential file stolen from disk | Passwords are AES-256 encrypted; key is DPAPI-protected | Low — attacker needs both the file AND the user's Windows session |
| Encryption key file stolen | Key is DPAPI-encrypted; unusable without the original Windows login | Low — DPAPI binding to user credentials |
| Memory inspection | Decrypted passwords exist in process memory only during active SSH sessions | Accepted — standard for all password-using applications |
| Exported JSON file with passwords | Passwords are encrypted using DPAPI (machine-bound) if no Transfer Password is used. | Low — an exported file cannot be decrypted on another machine without a Transfer Password |
| Compromised SSH connection | Handled by OpenSSH, not terX; uses industry-standard SSH protocol | Low — same risk as any SSH usage |
| SSH host key changed (MITM) | `StrictHostKeyChecking=accept-new` rejects changed keys; OpenSSH displays a warning | Low — same protection as manual SSH usage |
| Bulk tab close crashing app | Serialized kill queue with 50ms delays prevents Windows ConPTY assertion crashes | Resolved — no residual risk |

---

## 7. Frequently Asked Questions

**Q: Where are my passwords stored?**
A: In `%APPDATA%\terX\user-data\credentials.json`, encrypted with AES-256-CBC. They cannot be read without the encryption key.

**Q: What happens if I reinstall Windows?**
A: The DPAPI-protected encryption key is tied to your Windows user profile. If the profile is lost, saved passwords cannot be recovered. Re-enter them after reinstallation. Connection names, hosts, ports, and usernames (without passwords) can be exported first.

**Q: Can my IT admin read my saved passwords?**
A: No. The encryption key is protected by DPAPI, which binds it to your specific Windows login. Even an administrator on a different account cannot decrypt it without your credentials.

**Q: Does this tool send any data over the internet?**
A: No. The only network traffic is the SSH connections you explicitly initiate to your servers. There is no telemetry, analytics, update checking, or cloud sync.

**Q: Is this tool approved for use with production servers?**
A: terX uses the same `ssh.exe` that you would use manually in a terminal. The security of the connection itself is identical to running SSH from PowerShell or Command Prompt.

**Q: What happens if I export my hosts?**
A: You can choose which fields to include (e.g., passwords, keys). You will be prompted to enter a **Transfer Password**. This encrypts the entire export file with AES-256. If you choose to export without a password, the export is encrypted using your machine-bound key, meaning it can only be imported back into terX on your exact machine and user account.

**Q: Does this require Visual Studio or build tools to install?**
A: No. The application uses prebuilt native binaries for `node-pty`. No C++ compiler or Visual Studio installation is required on the end-user's machine.

---

*Document Version: 1.1 — April 2026*
*Application Version: 1.0.0*
*Electron Version: 33*
*Author: Rahul R, Application Support - IT*
