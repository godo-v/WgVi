// Electron main process: opens the WagVitals window and bridges Web Bluetooth
// device selection, which Electron leaves to the app (browsers show their
// own chooser; Electron fires 'select-bluetooth-device' instead).

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

// Web Bluetooth on Linux (BlueZ) is still behind Chromium's experimental flag.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-experimental-web-platform-features');
}

let selectDevice = null; // pending Chromium callback while the picker is open

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: 'WagVitals',
    icon: path.join(__dirname, '..', 'app', 'icon.png'),
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Fired repeatedly while scanning, each time with the updated device list.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    selectDevice = callback;
    win.webContents.send(
      'bluetooth:devices',
      devices.map((d) => ({ id: d.deviceId, name: d.deviceName })),
    );
  });

  // Pairing prompts on Windows/Linux. The collar uses "Just Works" pairing
  // (or none); anything needing a PIN is declined in this prototype.
  win.webContents.session.setBluetoothPairingHandler((details, callback) => {
    callback({ confirmed: details.pairingKind === 'confirm' });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
}

// Renderer picked a device ('' = cancelled).
ipcMain.on('bluetooth:select', (_event, deviceId) => {
  if (!selectDevice) return;
  selectDevice(typeof deviceId === 'string' ? deviceId : '');
  selectDevice = null;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
