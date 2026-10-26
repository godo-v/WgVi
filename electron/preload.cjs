// Exposes the minimum the page needs from Electron: the Bluetooth device list
// and a way to pick one. Everything else runs as a normal web page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wagvitalsDesktop', {
  platform: process.platform,
  onBluetoothDevices(callback) {
    const handler = (_event, devices) => callback(devices);
    ipcRenderer.on('bluetooth:devices', handler);
    return () => ipcRenderer.removeListener('bluetooth:devices', handler);
  },
  selectBluetoothDevice(deviceId) {
    ipcRenderer.send('bluetooth:select', deviceId);
  },
});
