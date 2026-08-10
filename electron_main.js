import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Disable SUID Sandbox and GPU per OS Memory Guard Protocol
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('renderer-process-limit', '2');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let serverProcess = null;
let mainWindow = null;

function startBackendServer() {
  // If server is already running externally, skip fork
  fetch('http://localhost:3099/api/status')
    .then(() => console.log('[Electron Backend] Server already active on port 3099'))
    .catch(() => {
      const serverPath = path.join(__dirname, 'server.js');
      serverProcess = fork(serverPath, [], {
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=768' }
      });
      serverProcess.on('exit', (code) => console.log(`[Electron Backend] Exited with code ${code}`));
    });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    title: 'Vibe GPT Studio - Native Ubuntu App',
    backgroundColor: '#0B0F17',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Load Vite web application on port 5173
  mainWindow.loadURL('http://localhost:5173').catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'client', 'dist', 'index.html'));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startBackendServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
