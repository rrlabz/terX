import { app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const GITHUB_REPO = 'rrlabz/terX';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface UpdateCheckResult {
  updateAvailable: boolean;
  latestVersion: string;
  downloadUrl?: string;
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(current: string, latest: string): boolean {
  const cur = parseVersion(current);
  const lat = parseVersion(latest);
  for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
    const c = cur[i] || 0;
    const l = lat[i] || 0;
    if (l > c) return true;
    if (c > l) return false;
  }
  return false;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const response = await fetch(GITHUB_API_URL, {
    headers: {
      'User-Agent': `terX/${app.getVersion()}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to check for updates: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  const latestTag = data.tag_name; // e.g., "v1.1.1"
  const currentVersion = app.getVersion();

  if (isNewerVersion(currentVersion, latestTag)) {
    const isMac = process.platform === 'darwin';
    const arch = process.arch; // e.g., 'x64' or 'arm64'
    const ext = isMac ? 'zip' : 'exe';
    const osStr = isMac ? 'macos' : 'win';
    
    // Construct expected asset name: terX-v1.1.1-macos-arm64.dmg
    const expectedAssetName = `terX-${latestTag}-${osStr}-${arch}.${ext}`;
    
    // Find the matching asset in the release
    const asset = data.assets.find((a: any) => a.name === expectedAssetName);
    
    if (asset) {
      return {
        updateAvailable: true,
        latestVersion: latestTag,
        downloadUrl: asset.browser_download_url
      };
    } else {
      // Fallback manually construct URL based on the user's expected format
      const fallbackUrl = `https://github.com/${GITHUB_REPO}/releases/download/${latestTag}/${expectedAssetName}`;
      return {
        updateAvailable: true,
        latestVersion: latestTag,
        downloadUrl: fallbackUrl
      };
    }
  }

  return { updateAvailable: false, latestVersion: currentVersion };
}

export async function downloadAndInstallUpdate(
  downloadUrl: string, 
  onProgress: (percent: number) => void
): Promise<void> {
  const response = await fetch(downloadUrl, {
    headers: {
      'User-Agent': `terX/${app.getVersion()}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download update: ${response.statusText}`);
  }

  const totalBytes = Number(response.headers.get('content-length')) || 0;
  let downloadedBytes = 0;

  const fileName = path.basename(new URL(downloadUrl).pathname);
  const tempPath = path.join(os.tmpdir(), fileName);
  
  const fileStream = fs.createWriteStream(tempPath);
  
  const webStream = response.body;
  if (!webStream) {
    throw new Error('No response body');
  }

  // Convert Web Stream to Node Stream for processing
  // Using any to bypass potential TS compiler mismatch for Web streams
  const nodeStream = Readable.fromWeb(webStream as any);
  
  // Throttle progress events to prevent IPC flooding
  let lastPercent = 0;
  nodeStream.on('data', (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0) {
      const percent = Math.round((downloadedBytes / totalBytes) * 100);
      if (percent > lastPercent) {
        lastPercent = percent;
        onProgress(percent);
      }
    }
  });

  await pipeline(nodeStream, fileStream);

  // 100% complete
  onProgress(100);

  if (!app.isPackaged) {
    throw new Error('Update installation is disabled in development mode.');
  }

  const { exec, spawn } = require('child_process');
  const isMac = process.platform === 'darwin';

  if (isMac) {
    // 1. Unzip the downloaded file
    const extractDir = path.join(os.tmpdir(), `terx_update_${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    
    await new Promise<void>((resolve, reject) => {
      exec(`unzip -o -q "${tempPath}" -d "${extractDir}"`, (error: any) => {
        if (error) reject(new Error(`Failed to extract update: ${error.message}`));
        else resolve();
      });
    });

    const currentAppPath = app.getPath('exe').split('.app/')[0] + '.app';
    const newAppPath = path.join(extractDir, 'terX.app');
    
    // 2. Create the update script
    const scriptPath = path.join(os.tmpdir(), 'terx_update.sh');
    const scriptContent = `#!/bin/bash
sleep 2

# Force kill if still running
killall terx 2>/dev/null || true

rm -rf "${currentAppPath}"
cp -R "${newAppPath}" "${currentAppPath}"
open "${currentAppPath}"

rm -rf "${extractDir}"
rm "${tempPath}"
rm "$0"
`;
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    
    // 3. Spawn the script detached
    const child = spawn(scriptPath, [], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

  } else {
    // Windows: spawn NSIS installer silently
    const child = spawn(tempPath, ['/S', '/force-run'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  }

  // Quit the application gracefully so the installer/script can overwrite the files
  setTimeout(() => {
    app.quit();
  }, 500);
}
