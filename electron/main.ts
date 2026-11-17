import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, session, shell, webContents, type MenuItemConstructorOptions, type Rectangle, type WebContents } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../server/serve';
import { pickFolder, type ShowFolderDialog } from './folder';

/**
 * Sable desktop shell. Runs the production server (UI + bridge) in this process on a localhost
 * port and shows it in one hardened window. Bundled to dist-electron/main.cjs by
 * scripts/build-electron.mjs; started with `electron .` from the project root, or packaged by
 * electron-builder (`pnpm desktop:dist`, configured in package.json → build).
 *
 * Development flags (verification only):
 *   --screenshot=<file.png>  wait until the app has rendered, capture the window, quit. The window
 *                            is placed far off-screen and kept out of the taskbar, so it never shows
 *   --eval=<js>              run a snippet in the page before the capture
 *   --wait=<ms>              delay between render (and eval) and capture
 *
 * Environment (verification only):
 *   SABLE_USER_DATA=<dir>    the window's own profile and single-instance lock, so a second copy can
 *                            run beside an installed Sable without being sent to it
 *   SABLE_WINDOW_SHOT=1      with --screenshot, also grab the real window (native buttons included)
 *                            to <file>-window.png when the system allows it
 *   SABLE_DIALOG_STUB=<dir>  with --screenshot, the folder dialog answers <dir> without showing
 */

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/** Preferred port: a stable origin keeps the page's local storage and zoom between runs. */
const PREFERRED_PORT = 47_317;
const BG = '#070708';
/** The panel browser's own persistent session: its cookies and storage never mix with the app's. */
const BROWSER_PARTITION = 'persist:sable-browser';

const flag = (name: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};
const screenshotFile = flag('screenshot');
const evalSnippet = flag('eval');
const captureWait = Number(flag('wait') ?? (evalSnippet ? 3000 : 1200));
/**
 * SABLE_PERF=1 (verification only): a measuring run. The page gets its debug helpers
 * (window.sable, frame stats), the window opens without taking focus, and it keeps drawing
 * when covered, so frame timings are real even on a machine someone is using.
 */
const perfRun = process.env.SABLE_PERF === '1';

// Everything Sable keeps lives under SABLE_HOME when it is set (verification runs use a temp folder).
app.setName('Sable');
// The user-data folder also keys the single-instance lock, so it is set before the lock is requested.
app.setPath(
  'userData',
  process.env.SABLE_USER_DATA
    ? path.resolve(process.env.SABLE_USER_DATA)
    : process.env.SABLE_HOME
      ? path.join(process.env.SABLE_HOME, 'desktop')
      : path.join(app.getPath('appData'), 'Sable'),
);
app.enableSandbox();
// The same id as electron-builder's appId, so the taskbar groups the window with the pinned
// shortcut and notifications carry the app's name and icon.
if (isWin) app.setAppUserModelId('io.github.leonxlnx.sable');

/**
 * macOS: an app opened from Finder or the Dock gets launchd's bare PATH (/usr/bin:/bin:...), not the
 * one the user's shell sets up, so `codex`, `git` from Homebrew, node and the like would not be
 * found. Ask the user's login shell for its PATH once, before the server starts, and put it first.
 */
function adoptShellPath() {
  const sh = process.env.SHELL || '/bin/zsh';
  const mark = '__SABLE_PATH__';
  let shellPath = '';
  try {
    const out = execFileSync(sh, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 6000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' },
    });
    shellPath = out.split(mark)[1] ?? '';
  } catch {
    /* a slow or broken shell profile: fall back to the usual places below */
  }
  const home = os.homedir();
  const usual = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.bun/bin'), path.join(home, '.npm-global/bin')];
  const parts = [...shellPath.split(':'), ...(process.env.PATH ?? '').split(':'), ...usual].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}
if (isMac && !process.env.SABLE_KEEP_PATH) adoptShellPath();

// The Agent SDK starts the Claude Code binary that ships with the app (an extra resource when
// packaged, the staged copy in dist-resources/ when run from the project); see build-electron.mjs.
if (!process.env.SABLE_CLAUDE_BIN) {
  const exe = isWin ? 'claude.exe' : 'claude';
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'claude', exe) : path.join(app.getAppPath(), 'dist-resources', 'claude', exe);
  if (existsSync(bin)) process.env.SABLE_CLAUDE_BIN = bin;
}
if (screenshotFile || perfRun) {
  // Keep rendering when the window is covered or the display is off, so the capture is never blank.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

let server: RunningServer | undefined;
let win: BrowserWindow | undefined;
let appOrigin = '';

/* ── window state ── */

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1360, height: 860 };
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    if (!(s.width >= 900 && s.height >= 600)) return fallback;
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      // Drop the position when it no longer lands on a connected display.
      const b: Rectangle = { x: s.x, y: s.y, width: s.width, height: s.height };
      const area = screen.getDisplayMatching(b).workArea;
      const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 8 && b.y < area.y + area.height - 80;
      if (!visible) return { width: Math.min(s.width, area.width), height: Math.min(s.height, area.height), maximized: s.maximized };
    }
    return s;
  } catch {
    return fallback;
  }
}

/**
 * With a hidden title bar on Windows (at fractional scale factors) a new window comes out a few
 * pixels larger than requested, so a saved size would creep every run. Measured once per window
 * and subtracted when saving.
 */
let sizeDrift = { width: 0, height: 0 };

function measureDrift(w: BrowserWindow, requested: WindowState) {
  const b = w.getNormalBounds();
  sizeDrift = { width: b.width - requested.width, height: b.height - requested.height };
  if (Math.abs(sizeDrift.width) > 16 || Math.abs(sizeDrift.height) > 16) sizeDrift = { width: 0, height: 0 }; // clamped by a small display
}

function saveWindowState(w: BrowserWindow) {
  try {
    const normal = w.getNormalBounds();
    const state: WindowState = {
      x: normal.x,
      y: normal.y,
      width: normal.width - sizeDrift.width,
      height: normal.height - sizeDrift.height,
      maximized: w.isMaximized(),
    };
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    /* not worth failing a close over */
  }
}

/* ── security ── */

function openOutside(target: string) {
  try {
    const u = new URL(target);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.href);
  } catch {
    /* not a URL: ignore */
  }
}

const isAppUrl = (target: string) => {
  try {
    return new URL(target).origin === appOrigin;
  } catch {
    return false;
  }
};

/** What the panel browser may show: web pages, never the app itself, files or internal pages. */
const isViewable = (target: string) => {
  if (target === 'about:blank') return true;
  try {
    const u = new URL(target);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== appOrigin;
  } catch {
    return false;
  }
};

/** Calls from the app's own page in the main window; anything else (guests, other frames) is refused. */
const fromApp = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => isAppUrl(e.senderFrame?.url ?? '') && e.sender === win?.webContents;

/** What the page's own window controls show: maximised (restore icon), focused (full strength), full screen (hidden). */
const windowState = (w: BrowserWindow) => ({ maximized: w.isMaximized(), focused: w.isFocused(), fullScreen: w.isFullScreen() });

/** Window calls from the page: the native folder dialog and the window controls (Windows, Linux). */
function windowCalls() {
  const stub = screenshotFile ? process.env.SABLE_DIALOG_STUB : undefined;
  ipcMain.handle('sable:pick-folder', async (e, suggested: unknown) => {
    if (!fromApp(e) || !win) throw new Error('Not allowed');
    const owner = win;
    const show: ShowFolderDialog = stub
      ? async (opts) => {
          console.log(`[pick-folder] stubbed dialog, starting in ${opts.defaultPath ?? '(default)'}`);
          return { canceled: false, filePaths: [stub] };
        }
      : (opts) => dialog.showOpenDialog(owner, opts);
    return pickFolder(show, suggested);
  });

  // The page draws minimise, maximise / restore and close itself (macOS keeps its traffic lights).
  ipcMain.on('sable:window', (e, command: unknown) => {
    if (isMac || !fromApp(e) || !win) return;
    if (command === 'minimize') win.minimize();
    else if (command === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (command === 'close') win.close();
  });
  ipcMain.handle('sable:window-state', (e) => {
    if (!fromApp(e) || !win) throw new Error('Not allowed');
    return windowState(win);
  });
}

/** Keeps the page's window controls in step with the window: restore icon while maximised, dimmed while unfocused. */
function reportWindowState(w: BrowserWindow) {
  if (isMac) return;
  const push = () => {
    if (!w.isDestroyed()) w.webContents.send('sable:window-state', windowState(w));
  };
  for (const ev of ['maximize', 'unmaximize', 'restore', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) w.on(ev as 'focus', push);
}

/** Pages inside the panel browser (<webview> guests): web navigation only, popups stay in the view. */
function guardGuest(contents: WebContents) {
  const guard = (e: { url: string; preventDefault(): void }) => {
    if (!isViewable(e.url)) e.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (e) => e.preventDefault());
  // Keys typed in the page go to the guest, not the app: Ctrl+F there opens the panel's find bar.
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt || input.shift || input.key.toLowerCase() !== 'f') return;
    const host = contents.hostWebContents;
    if (!host || host !== win?.webContents) return;
    e.preventDefault();
    host.send('sable:browser-event', { type: 'find', id: contents.id });
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isViewable(url) && url !== 'about:blank') void contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
}

function hardenBrowser() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Local files never load in the panel browser, whoever asks.
  ses.protocol.handle('file', () => new Response('Files do not open in the panel browser.', { status: 403, headers: { 'content-type': 'text/plain' } }));
  ses.on('will-download', (e, item) => {
    e.preventDefault();
    if (win && !win.isDestroyed()) win.webContents.send('sable:browser-event', { type: 'download-blocked', name: item.getFilename() });
  });

  ipcMain.handle('sable:browser-capture', async (e, id: unknown, forAgent: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    const guest = webContents.fromId(Number(id));
    if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== e.sender) throw new Error('That page is gone');
    const image = await guest.capturePage();
    const { width, height } = image.getSize();
    const side = Math.max(width, height);
    // For the agent: at most 1568 px on the long side (what models look at in full) and JPEG, so it stays small.
    const max = forAgent === true ? 1568 : 2000;
    const fit = side > max ? image.resize(width >= height ? { width: max } : { height: max }) : image;
    if (forAgent === true) return `data:image/jpeg;base64,${fit.toJPEG(80).toString('base64')}`;
    return fit.toDataURL();
  });

  // Failed requests of panel pages, for the agent's browser_read: the address without its query, the
  // method, and the status or the network error. Never headers or bodies.
  const reportNet = (d: { webContentsId?: number; url: string; method: string; statusCode?: number; error?: string }) => {
    if (!win || win.isDestroyed() || typeof d.webContentsId !== 'number') return;
    let url = d.url;
    try {
      const u = new URL(d.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      url = u.origin + u.pathname;
    } catch {
      return;
    }
    win.webContents.send('sable:browser-event', { type: 'net', id: d.webContentsId, url: url.slice(0, 300), method: d.method, status: d.statusCode, error: d.error?.slice(0, 80) });
  };
  ses.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) reportNet({ webContentsId: d.webContentsId, url: d.url, method: d.method, statusCode: d.statusCode });
  });
  ses.webRequest.onErrorOccurred((d) => {
    // An aborted request (a navigation away, a cancelled fetch) is not a failure worth reporting.
    if (d.error === 'net::ERR_ABORTED') return;
    reportNet({ webContentsId: d.webContentsId, url: d.url, method: d.method, error: d.error });
  });
  ipcMain.handle('sable:browser-clear', async (e) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  });
}

function harden() {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      guardGuest(contents);
      return;
    }
    const guard = (e: { url: string; preventDefault(): void }) => {
      if (isAppUrl(e.url)) return;
      e.preventDefault();
      openOutside(e.url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    // Only the app's own page may embed the panel browser, and only locked down: no Node, no preload,
    // sandboxed, isolated, in its own partition, starting on a web page.
    contents.on('will-attach-webview', (e, prefs, params) => {
      if (!isAppUrl(contents.getURL()) || (params.src && !isViewable(params.src))) {
        e.preventDefault();
        return;
      }
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.nodeIntegrationInWorker = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      prefs.allowRunningInsecureContent = false;
      prefs.experimentalFeatures = false;
      prefs.webviewTag = false;
      prefs.partition = BROWSER_PARTITION;
      // allowpopups only lets window.open reach guardGuest's handler, which never opens a window.
      delete params.preload;
      params.partition = BROWSER_PARTITION;
    });
    contents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: 'deny' };
    });
  });

  // The page only loads its own code; agent output may show images (data, blob, https) and nothing else.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${appOrigin.replace(/^http/, 'ws')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    // The panel browser is a <webview>; its pages run in a separate guest and are not framed by the app.
    // The only frame the app embeds is its own widget page (generative UI), sandboxed without same-origin.
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  // The widget page runs code an agent wrote: no network of any kind, inline code only, and it can
  // frame nothing but its own srcdoc child, which inherits this policy.
  const widgetCsp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
  ].join('; ');
  const isWidgetPage = (url: string): boolean => {
    try {
      return new URL(url).pathname === '/widget-frame.html';
    } catch {
      return false;
    }
  };
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${appOrigin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [isWidgetPage(details.url) ? widgetCsp : csp] } });
  });

  const allowed = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && isAppUrl(details.requestingUrl));
  });
  // Electron passes the origin here as a URL with a trailing slash ("http://127.0.0.1:47317/"): compare origins.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && isAppUrl(requestingOrigin));
  hardenBrowser();
  windowCalls();
}

/* ── menu and shortcuts ── */

function installMenu() {
  if (!isMac) {
    // No menu bar on Windows and Linux: Chromium handles the edit shortcuts itself, and the
    // view shortcuts are handled per window (see viewShortcuts) so nothing swallows the app's own keys.
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function viewShortcuts(w: BrowserWindow) {
  if (isMac) return; // the View menu carries them
  const wc = w.webContents;
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    let handled = true;
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) wc.toggleDevTools();
    else if (input.key === 'F5' || (mod && !input.shift && !input.alt && key === 'r')) wc.reload();
    else if (mod && !input.alt && key === '0') wc.setZoomLevel(0);
    else if (mod && !input.alt && (key === '=' || key === '+')) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
    else if (mod && !input.alt && key === '-') wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    else handled = false;
    if (handled) e.preventDefault();
  });
}

/** A small native context menu: edit actions in fields, copy for selected text. */
function contextMenu(w: BrowserWindow) {
  w.webContents.on('context-menu', (_e, params) => {
    const f = params.editFlags;
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo', enabled: f.canUndo },
          { role: 'redo', enabled: f.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: f.canCut },
          { role: 'copy', enabled: f.canCopy },
          { role: 'paste', enabled: f.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: f.canSelectAll },
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy' }]
        : [];
    if (params.linkURL && !isAppUrl(params.linkURL)) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Open link in browser', click: () => openOutside(params.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
  });
}

/* ── window ── */

/** Where a --screenshot window lives: far outside every display, so the run never appears on screen. */
const OFF_SCREEN = -32_000;

function createWindow(url: string) {
  // A screenshot run neither reads nor writes the saved window state: fixed size, off-screen.
  const state: WindowState = screenshotFile ? { x: OFF_SCREEN, y: OFF_SCREEN, width: 1360, height: 860 } : loadWindowState();
  const w = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    skipTaskbar: !!screenshotFile,
    title: 'Sable',
    // The packaged executable carries the icon too; this covers `electron .` and Linux.
    icon: isMac ? undefined : path.join(__dirname, isWin ? 'icon.ico' : 'icon.png'),
    backgroundColor: BG,
    // Windows and Linux: no native caption buttons; the page draws its own (WindowControls in App.tsx).
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 23 } } : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The panel's Browser tab; every guest is locked down in harden() (will-attach-webview).
      webviewTag: true,
      backgroundThrottling: !screenshotFile,
      additionalArguments: [`--sable-version=${app.getVersion()}`, ...(evalSnippet || perfRun ? ['--sable-debug'] : [])],
    },
  });

  w.once('ready-to-show', () => {
    if (screenshotFile) {
      // Shown (so it paints) but off-screen and out of the taskbar; the bounds are set again in case
      // the system moved the window back onto a display when it was created.
      w.setBounds({ x: OFF_SCREEN, y: OFF_SCREEN, width: state.width, height: state.height });
      w.showInactive();
      return;
    }
    if (state.maximized) w.maximize();
    if (perfRun) w.showInactive();
    else w.show();
  });
  if (!screenshotFile) {
    measureDrift(w, state);
    w.on('close', () => saveWindowState(w));
  }
  w.on('closed', () => (win = undefined));

  reportWindowState(w);
  viewShortcuts(w);
  contextMenu(w);
  if (screenshotFile) {
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[page ${e.level}] ${e.message}`);
    });
    w.webContents.on('render-process-gone', (_e, d) => console.log(`[page] renderer gone: ${d.reason}`));
  }

  void w.loadURL(url);
  return w;
}

/* ── verification capture ── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function capture(w: BrowserWindow, file: string) {
  const wc = w.webContents;
  // The home screen, a session, or the first-run welcome (.onb) on a fresh profile.
  const rendered = "!document.querySelector('.logo-intro') && !!document.querySelector('.home, .session, .onb')";
  const deadline = Date.now() + 30_000;
  while (!(await wc.executeJavaScript(rendered).catch(() => false))) {
    if (Date.now() > deadline) {
      const seen = await wc.executeJavaScript("location.href + ' :: ' + (document.body?.innerText ?? '').split(/[\\n\\t ]+/).join(' ').slice(0, 300)").catch(() => '?');
      throw new Error(`The app did not render within 30 s (${seen})`);
    }
    await sleep(200);
  }
  if (evalSnippet) {
    const result = await wc.executeJavaScript(evalSnippet, true);
    if (result !== undefined) console.log('[eval]', typeof result === 'string' ? result : JSON.stringify(result));
  }
  await sleep(captureWait);
  const image = await wc.capturePage();
  const out = path.resolve(file);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, image.toPNG());
  const size = image.getSize();
  console.log(`[screenshot] ${out} (${size.width}x${size.height})`);
  if (process.env.SABLE_WINDOW_SHOT) await captureWindow(w, out.replace(/\.png$/i, '') + '-window.png');
}

/**
 * The real window as the system composes it, native caption buttons included (capturePage only has
 * the page). May come back empty when the display is off or capture is not permitted.
 */
async function captureWindow(w: BrowserWindow, file: string) {
  try {
    const { width, height } = w.getContentBounds();
    const scale = screen.getDisplayMatching(w.getBounds()).scaleFactor;
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
    const own = sources.find((s) => s.id === w.getMediaSourceId());
    if (!own || own.thumbnail.isEmpty()) {
      console.log('[window-shot] the system returned no image for this window');
      return;
    }
    writeFileSync(file, own.thumbnail.toPNG());
    const s = own.thumbnail.getSize();
    console.log(`[window-shot] ${file} (${s.width}x${s.height})`);
  } catch (err) {
    console.log('[window-shot] failed:', (err as Error)?.message ?? err);
  }
}

/* ── lifecycle ── */

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  if (win && !win.isDestroyed() && !screenshotFile) saveWindowState(win);
  // Dispose the bridge (agent child processes exit) before the process goes; never hang on it.
  void Promise.race([server.close(), sleep(3000)]).finally(() => app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0));
});
app.on('window-all-closed', () => app.quit());
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    installMenu();
    try {
      server = await startServer({ root: path.join(app.getAppPath(), 'dist'), port: PREFERRED_PORT, fallbackToFreePort: true });
    } catch (err) {
      dialog.showErrorBox('Sable could not start', String((err as Error)?.message ?? err));
      app.quit();
      return;
    }
    appOrigin = new URL(server.url).origin;
    harden();
    win = createWindow(server.url);

    if (screenshotFile) {
      capture(win, screenshotFile)
        .catch((err) => {
          console.error('[screenshot] failed:', err);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
    }
  });
}
