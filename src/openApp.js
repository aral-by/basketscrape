// Opens the panel like a desktop app: Edge or Chrome in "--app" mode (own window, no tabs or
// address bar). Falls back to the default browser.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

function appBrowsers() {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
    return rel.flatMap((r) => roots.map((root) => path.join(root, r)));
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

function openApp(url) {
  const exe = appBrowsers().find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (exe) {
    const child = spawn(exe, [`--app=${url}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' });
    child.on('error', () => openDefault(url));
    child.unref();
    return;
  }
  openDefault(url);
}

function openDefault(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

module.exports = { openApp };
