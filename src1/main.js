function getPythonExecutablePath() {
  // Prefer embedded python in resources/python/python.exe
  try {
    const candidate = app.isPackaged
      ? path.join(process.resourcesPath, 'python', 'python.exe')
      : path.join(__dirname, '..', 'python', 'python.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch (_) {}
  // Fallback to system python in PATH
  return process.env.PYTHON || 'python';
}

// Load environment variables from .env file
require('dotenv').config();

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { getSystemHealth } = require('./system_health');
const { generateAISummary } = require('./ai_summary');
const { sendMessage, analyzeFileContent, generateFileRemarks, resetChat } = require('./local_ai_chat');

// Set up file logging
const logFile = path.join(__dirname, '..', 'electron.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(' ')}\n`;
  logStream.write(message);
  originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ERROR: ${args.join(' ')}\n`;
  logStream.write(message);
  originalConsoleError.apply(console, args);
};

console.log('[SEVE] Electron starting...');
console.log('[SEVE] Log file:', logFile);

let mainWindow;

async function checkIsElevated() {
  return await new Promise((resolve) => {
    try {
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ]);
      let out = '';
      ps.stdout.on('data', d => out += d.toString());
      ps.on('close', () => {
        resolve(/True/i.test(out));
      });
      ps.on('error', () => resolve(false));
    } catch (_) { resolve(false); }
  });
}

function hasArg(name) {
  return process.argv.some(a => a === name || a.startsWith(name + '='));
}

async function ensureElevated() {
  if (process.env.SEVE_SKIP_ELEVATION === '1') {
    console.log('[SEVE] Skipping elevation (SEVE_SKIP_ELEVATION=1)');
    return true; // developer override
  }
  if (process.env.SEVE_ELEVATED === '1' || hasArg('--seve-elevated')) return true;
  const elevated = await checkIsElevated();
  if (elevated) return true;
  try {
    const isDev = !app.isPackaged;
    const exe = process.execPath; // electron.exe (dev) or SEVE Desktop.exe (prod)
    const args = [];
    if (isDev) {
      // Pass app folder path and original args (minus first which is electron)
      const rest = process.argv.slice(1).map(a => a.replace(/"/g, '""'));
      if (rest.length === 0) {
        rest.push(path.join(__dirname, '..'));
      }
      args.push(...rest);
    } else {
      // In production, no args required
    }
    // Add elevation marker to prevent loops
    args.push('--seve-elevated=1');
    const cmd = [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath "${exe}" -ArgumentList '${args.join(' ')}' -Verb RunAs -WindowStyle Normal -WorkingDirectory "${path.dirname(exe)}" -PassThru | Out-Null`
    ];
    spawn('powershell', cmd, { env: { ...process.env, SEVE_ELEVATED: '1' } });
    app.quit();
    return false;
  } catch (e) {
    return false;
  }
}

function createWindow() {
  const isDev = !app.isPackaged;
  
  // Log environment for debugging
  console.log('[SEVE] Environment check:');
  console.log('[SEVE] SEVE_OFFLINE:', process.env.SEVE_OFFLINE);
  console.log('[SEVE] NODE_ENV:', process.env.NODE_ENV);
  console.log('[SEVE] isDev:', isDev);
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, '../assets/SEVE-logo.png'),
    title: 'SEVE Desktop',
    autoHideMenuBar: true,
    fullscreen: isDev ? false : true,
    kiosk: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  // Maximize window in development mode
  if (isDev) {
    mainWindow.maximize();
  }

// IPC handler for system health monitoring
ipcMain.handle('get-system-health', async () => {
  try {
    return await getSystemHealth();
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handler for AI summary generation
ipcMain.handle('generate-ai-summary', async (_evt, { metrics, cpuInfo, analysis }) => {
  try {
    return await generateAISummary(metrics, cpuInfo, analysis);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handler for chat messages
ipcMain.handle('ai-chat', async (_evt, { message, options }) => {
  try {
    console.log('[Main] ai-chat called with message:', message);
    const result = await sendMessage(message, options);
    console.log('[Main] ai-chat result:', result);
    return result;
  } catch (err) {
    console.error('[Main] ai-chat error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for browser privacy scan
ipcMain.handle('scan-browser-privacy', async () => {
  try {
    console.log('[Main] scan-browser-privacy called');
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'browser_analyzer.py');
    const proc = spawn(pythonExe, [scriptPath]);  // Removed --mock flag
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errorOutput += d.toString());
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] browser_analyzer error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'Scanner failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] browser_analyzer success:', result.stats);
          resolve(result);
        } catch (e) {
          console.error('[Main] browser_analyzer parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] scan-browser-privacy error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for clearing tracking cookies
ipcMain.handle('clear-tracking-cookies', async () => {
  try {
    console.log('[Main] clear-tracking-cookies called');
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'browser_analyzer.py');
    const proc = spawn(pythonExe, [scriptPath, '--clear']);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errorOutput += d.toString());
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] clear-tracking-cookies error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'Clear failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] clear-tracking-cookies success:', result.deleted, 'cookies deleted');
          resolve(result);
        } catch (e) {
          console.error('[Main] clear-tracking-cookies parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] clear-tracking-cookies error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for clearing ALL cookies
ipcMain.handle('clear-all-cookies', async () => {
  try {
    console.log('[Main] clear-all-cookies called');
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'browser_analyzer.py');
    const proc = spawn(pythonExe, [scriptPath, '--clear-all']);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errorOutput += d.toString());
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] clear-all-cookies error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'Clear failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] clear-all-cookies success:', result.deleted, 'cookies deleted');
          resolve(result);
        } catch (e) {
          console.error('[Main] clear-all-cookies parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] clear-all-cookies error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for forensic scan
ipcMain.handle('forensic-scan', async (_evt, { drive, sectorStart, sectorCount }) => {
  try {
    console.log('[Main] forensic-scan called for drive', drive);
    // Use system Python for pywin32 scripts (embedded Python can't load pywin32 DLLs)
    const pythonExe = process.env.PYTHON || 'python';
    const scriptPath = path.join(__dirname, '..', 'forensic_scanner.py');
    const args = [scriptPath, '--drive', drive, '--start', String(sectorStart), '--count', String(sectorCount)];
    const proc = spawn(pythonExe, args);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => {
      const msg = d.toString();
      errorOutput += msg;
      // Forward progress to renderer
      if (msg.includes('Progress:')) {
        mainWindow.webContents.send('forensic-progress', { message: msg.trim() });
      }
    });
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] forensic_scanner error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'Forensic scan failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] forensic_scanner success:', result.files_found, 'files found');
          resolve(result);
        } catch (e) {
          console.error('[Main] forensic_scanner parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] forensic-scan error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for viewing forensic file
ipcMain.handle('forensic-view-file', async (_evt, { drive, sector, type }) => {
  try {
    console.log('[Main] forensic-view-file called:', { drive, sector, type });
    const pythonExe = process.env.PYTHON || 'python';
    const scriptPath = path.join(__dirname, '..', 'forensic_scanner.py');
    const args = [scriptPath, '--view', '--drive', drive, '--sector', String(sector), '--type', type];
    const proc = spawn(pythonExe, args);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errorOutput += d.toString());
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] forensic-view-file error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'View failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] forensic-view-file success');
          resolve(result);
        } catch (e) {
          console.error('[Main] forensic-view-file parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] forensic-view-file error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for exporting forensic file
ipcMain.handle('forensic-export-file', async (_evt, { drive, sector, type, outputPath }) => {
  try {
    console.log('[Main] forensic-export-file called:', { drive, sector, type, outputPath });
    const pythonExe = process.env.PYTHON || 'python';
    const scriptPath = path.join(__dirname, '..', 'forensic_scanner.py');
    const args = [scriptPath, '--export', outputPath, '--drive', drive, '--sector', String(sector), '--type', type];
    const proc = spawn(pythonExe, args);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errorOutput += d.toString());
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] forensic-export-file error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'Export failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] forensic-export-file success:', result.size, 'bytes');
          resolve(result);
        } catch (e) {
          console.error('[Main] forensic-export-file parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] forensic-export-file error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler for wiping forensic file sectors
ipcMain.handle('forensic-wipe-sectors', async (_evt, { drive, sector, count, passes }) => {
  try {
    console.log('[Main] forensic-wipe-sectors called:', { drive, sector, count, passes });
    const pythonExe = process.env.PYTHON || 'python';
    const scriptPath = path.join(__dirname, '..', 'forensic_scanner.py');
    const args = [scriptPath, '--wipe', '--drive', drive, '--sector', String(sector), '--count', String(count), '--passes', String(passes || 3)];
    const proc = spawn(pythonExe, args);
    
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => {
      const msg = d.toString();
      errorOutput += msg;
      // Forward progress to renderer
      if (msg.includes('Progress:')) {
        mainWindow.webContents.send('forensic-wipe-progress', { message: msg.trim() });
      }
    });
    
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[Main] forensic-wipe-sectors error:', errorOutput);
          resolve({ success: false, error: errorOutput || 'Wipe failed' });
          return;
        }
        
        try {
          const result = JSON.parse(output);
          console.log('[Main] forensic-wipe-sectors success:', result.sectors_wiped, 'sectors wiped');
          resolve(result);
        } catch (e) {
          console.error('[Main] forensic-wipe-sectors parse error:', e);
          resolve({ success: false, error: 'Failed to parse results' });
        }
      });
    });
  } catch (err) {
    console.error('[Main] forensic-wipe-sectors error:', err);
    return { success: false, error: err.message };
  }
});

// Malware monitor process
let malwareMonitor = null;

// IPC handler to start malware monitoring
ipcMain.handle('start-malware-monitor', async (_evt, { path: monitorPath }) => {
  try {
    if (malwareMonitor) {
      return { success: false, error: 'Monitor already running' };
    }
    
    console.log('[Main] start-malware-monitor for path:', monitorPath);
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'malware_detector.py');
    const args = [scriptPath, '--path', monitorPath];
    
    malwareMonitor = spawn(pythonExe, args);
    
    malwareMonitor.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.alert) {
              mainWindow.webContents.send('malware-alert', data.alert);
            } else if (data.status) {
              console.log('[Main] Malware monitor:', data.status);
            }
          } catch (e) {
            // Ignore non-JSON lines
          }
        }
      });
    });
    
    malwareMonitor.stderr.on('data', d => {
      console.error('[Main] Malware monitor stderr:', d.toString());
    });
    
    malwareMonitor.on('close', (code) => {
      console.log('[Main] Malware monitor stopped with code:', code);
      malwareMonitor = null;
    });
    
    return { success: true };
  } catch (err) {
    console.error('[Main] start-malware-monitor error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler to stop malware monitoring
ipcMain.handle('stop-malware-monitor', async () => {
  if (malwareMonitor) {
    malwareMonitor.kill();
    malwareMonitor = null;
    return { success: true };
  }
  return { success: false, error: 'No monitor running' };
});

// Network monitor process
let networkMonitor = null;

// IPC handler to start network monitoring
ipcMain.handle('start-network-monitor', async (_evt, { duration }) => {
  try {
    if (networkMonitor) {
      return { success: false, error: 'Monitor already running' };
    }
    
    console.log('[Main] start-network-monitor for duration:', duration);
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'network_monitor.py');
    const args = [scriptPath, '--duration', String(duration || 60)];
    
    networkMonitor = spawn(pythonExe, args);
    
    networkMonitor.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.alert) {
              mainWindow.webContents.send('network-alert', data.alert);
            } else if (data.status) {
              console.log('[Main] Network monitor:', data.status);
            }
          } catch (e) {
            // Ignore non-JSON lines
          }
        }
      });
    });
    
    networkMonitor.stderr.on('data', d => {
      console.error('[Main] Network monitor stderr:', d.toString());
    });
    
    networkMonitor.on('close', (code) => {
      console.log('[Main] Network monitor stopped with code:', code);
      mainWindow.webContents.send('network-monitor-stopped', { code });
      networkMonitor = null;
    });
    
    return { success: true };
  } catch (err) {
    console.error('[Main] start-network-monitor error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler to stop network monitoring
ipcMain.handle('stop-network-monitor', async () => {
  if (networkMonitor) {
    networkMonitor.kill();
    networkMonitor = null;
    return { success: true };
  }
  return { success: false, error: 'No monitor running' };
});

// Exfiltration detector process
let exfiltrationDetector = null;

// IPC handler to start exfiltration detection
ipcMain.handle('start-exfiltration-detector', async (_evt, { duration }) => {
  try {
    if (exfiltrationDetector) {
      return { success: false, error: 'Detector already running' };
    }
    
    console.log('[Main] start-exfiltration-detector for duration:', duration);
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'exfiltration_detector.py');
    const args = [scriptPath, '--duration', String(duration || 60)];
    
    exfiltrationDetector = spawn(pythonExe, args);
    
    exfiltrationDetector.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.alert) {
              mainWindow.webContents.send('exfiltration-alert', data.alert);
            } else if (data.status) {
              console.log('[Main] Exfiltration detector:', data.status);
            }
          } catch (e) {
            // Ignore non-JSON lines
          }
        }
      });
    });
    
    exfiltrationDetector.stderr.on('data', d => {
      console.error('[Main] Exfiltration detector stderr:', d.toString());
    });
    
    exfiltrationDetector.on('close', (code) => {
      console.log('[Main] Exfiltration detector stopped with code:', code);
      mainWindow.webContents.send('exfiltration-detector-stopped', { code });
      exfiltrationDetector = null;
    });
    
    return { success: true };
  } catch (err) {
    console.error('[Main] start-exfiltration-detector error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler to stop exfiltration detection
ipcMain.handle('stop-exfiltration-detector', async () => {
  if (exfiltrationDetector) {
    exfiltrationDetector.kill();
    exfiltrationDetector = null;
    return { success: true };
  }
  return { success: false, error: 'No detector running' };
});

// Anomaly detector process
let anomalyDetector = null;

// IPC handler to start anomaly detection
ipcMain.handle('start-anomaly-detector', async (_evt, { baselineDuration, monitorDuration }) => {
  try {
    if (anomalyDetector) {
      return { success: false, error: 'Detector already running' };
    }
    
    console.log('[Main] start-anomaly-detector');
    const pythonExe = getPythonExecutablePath();
    const scriptPath = path.join(__dirname, '..', 'anomaly_detector.py');
    const args = [
      scriptPath,
      '--baseline', String(baselineDuration || 30),
      '--monitor', String(monitorDuration || 60)
    ];
    
    anomalyDetector = spawn(pythonExe, args);
    
    anomalyDetector.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.alert) {
              mainWindow.webContents.send('anomaly-alert', data.alert);
            } else if (data.baseline_progress) {
              mainWindow.webContents.send('anomaly-baseline-progress', { progress: data.baseline_progress });
            } else if (data.baseline_established) {
              mainWindow.webContents.send('anomaly-baseline-established', {});
            } else if (data.status) {
              console.log('[Main] Anomaly detector:', data.status);
            }
          } catch (e) {
            // Ignore non-JSON lines
          }
        }
      });
    });
    
    anomalyDetector.stderr.on('data', d => {
      console.error('[Main] Anomaly detector stderr:', d.toString());
    });
    
    anomalyDetector.on('close', (code) => {
      console.log('[Main] Anomaly detector stopped with code:', code);
      mainWindow.webContents.send('anomaly-detector-stopped', { code });
      anomalyDetector = null;
    });
    
    return { success: true };
  } catch (err) {
    console.error('[Main] start-anomaly-detector error:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler to stop anomaly detection
ipcMain.handle('stop-anomaly-detector', async () => {
  if (anomalyDetector) {
    anomalyDetector.kill();
    anomalyDetector = null;
    return { success: true };
  }
  return { success: false, error: 'No detector running' };
});

// IPC handler for file content analysis
ipcMain.handle('analyze-file-content', async (_evt, { filePath, content, snippet }) => {
  try {
    return await analyzeFileContent(filePath, content, snippet);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handler for file remarks generation
ipcMain.handle('generate-file-remarks', async (_evt, { files }) => {
  try {
    return await generateFileRemarks(files);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handler to reset chat
ipcMain.handle('reset-chat', async () => {
  try {
    return resetChat();
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handler to locate physical info for a single file
ipcMain.handle('locate-file', async (_evt, filePath) => {
  try {
    const pythonPath = getPythonScriptPath();
    const workingDir = getWorkingDirectory();
    if (!fs.existsSync(pythonPath)) {
      return { success: false, error: `Python script not found at: ${pythonPath}` };
    }
    const args = [pythonPath, '--locate', filePath];
    const pythonExe = getPythonExecutablePath();
    const proc = spawn(pythonExe, args, {
      cwd: workingDir,
      env: getPythonEnv()
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    return await new Promise((resolve) => {
      proc.on('close', code => {
        if (code !== 0) {
          resolve({ success: false, error: stderr || 'Locate failed' });
          return;
        }
        try {
          const parsed = JSON.parse((stdout || '{}').trim());
          resolve(parsed);
        } catch (e) {
          resolve({ success: false, error: 'Locate JSON parse failed' });
        }
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});
  
  // Set icon after window creation (with error handling)
  if (process.platform === 'win32') {
    try {
      mainWindow.setIcon(path.join(__dirname, '../assets/SEVE-logo.png'));
    } catch (error) {
      console.log('Failed to set ICO icon, trying PNG fallback');
      try {
        mainWindow.setIcon(path.join(__dirname, '../assets/SEVE-logo.png'));
      } catch (fallbackError) {
        console.log('Icon setting failed:', fallbackError.message);
      }
    }
  }

  // Load vanilla HTML/CSS/JS app
  const htmlPath = path.join(__dirname, 'renderer/index.html');
  mainWindow.loadFile(htmlPath);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(async () => {
  const ok = await ensureElevated();
  if (ok) createWindow();
});

// IPC handler for searching files on a drive
ipcMain.handle('search-files', async (_evt, { root, query }) => {
  try {
    const pythonPath = getPythonScriptPath();
    const workingDir = getWorkingDirectory();
    if (!fs.existsSync(pythonPath)) {
      return { success: false, error: `Python script not found at: ${pythonPath}` };
    }
    const args = [pythonPath, '--search', root, query || ''];
    console.log('[SEVE] search-files spawn', { args, cwd: workingDir });
    const pythonExe = getPythonExecutablePath();
    const proc = spawn(pythonExe, args, {
      cwd: workingDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    return await new Promise((resolve) => {
      proc.on('close', code => {
        try {
          // Write debug artifacts
          fs.writeFileSync(path.join(workingDir, 'results.json'), stdout || '');
          fs.writeFileSync(path.join(workingDir, 'search.log'), `code=${code}\n${stderr || ''}`);
        } catch (e) { /* ignore */ }
        if (code !== 0) {
          resolve({ success: false, error: stderr || 'Search failed' });
          return;
        }
        try {
          const parsed = JSON.parse((stdout || '{}').trim());
          const results = parsed.results || [];
          console.log('[SEVE] search-files parsed', { count: results.length });
          resolve({ success: true, results });
        } catch (e) {
          resolve({ success: false, error: 'Search JSON parse failed' });
        }
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC: get drive info (MediaType/BusType/DriveType) for removable detection
ipcMain.handle('get-drive-info', async (_evt, driveId) => {
  return new Promise((resolve, reject) => {
    const wipeScriptPath = getWipeScriptPath();
    const workingDir = getWorkingDirectory();
    if (!fs.existsSync(wipeScriptPath)) {
      return resolve({ success: false, error: `Wipe script not found at: ${wipeScriptPath}` });
    }
    const args = [wipeScriptPath, '--get-drive-info', driveId];
    const pythonExe = getPythonExecutablePath();
    const proc = spawn(pythonExe, args, { cwd: workingDir, env: getPythonEnv() });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => resolve({ success: false, error: err.message }));
    proc.on('close', code => {
      if (code !== 0) {
        return resolve({ success: false, error: stderr || `get-drive-info failed (${code})` });
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        resolve({ success: false, error: 'Parse error', details: stdout });
      }
    });
  });
});

// Function to get Python script path for both dev and production
function getPythonScriptPath() {
  const isDev = !app.isPackaged;
  
  if (isDev) {
    // Development: script is in project root
    return path.join(__dirname, '../drive_scanner.py');
  } else {
    // Production: script is in extraResources
    return path.join(process.resourcesPath, 'drive_scanner.py');
  }
}

// Function to get working directory for both dev and production
function getWorkingDirectory() {
  const isDev = !app.isPackaged;
  
  if (isDev) {
    // Development: use project root
    return path.join(__dirname, '..');
  } else {
    // Production: use resources directory
    return process.resourcesPath;
  }
}

function getWipeScriptPath() {
  const isDev = !app.isPackaged;
  if (isDev) {
    // When running from source, the script sits beside this file
    return path.join(__dirname, 'wipe_utils.py');
  }
  // In production we copy wipe_utils.py to resources/ via extraResources
  return path.join(process.resourcesPath, 'wipe_utils.py');
}

function getReportScriptPath() {
  const isDev = !app.isPackaged;
  if (isDev) {
    return path.join(__dirname, '..', 'report', 'generate_seve_report.py');
  }
  return path.join(process.resourcesPath, 'report', 'generate_seve_report.py');
}

// Build a consistent Python environment for all spawns, ensuring our bundled site-packages are found
function getPythonEnv() {
  const base = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  try {
    const isDev = !app.isPackaged;
    const root = isDev ? path.join(__dirname, '..') : process.resourcesPath;
    const site = path.join(root, 'python', 'Lib', 'site-packages');
    // Prepend PYTHONPATH with our bundled site-packages
    base.PYTHONPATH = base.PYTHONPATH ? `${site}${path.delimiter}${base.PYTHONPATH}` : site;
  } catch (_) { /* ignore */ }
  return base;
}

// --- Helpers: lightweight runner (kept for future diagnostics, no auto-install) ---
function runPython(pythonExe, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(pythonExe, args, options);
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', d => stdout += d.toString());
    proc.stderr?.on('data', d => stderr += d.toString());
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: (stderr || e.message) }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Helper to spawn the Python scanner with args and stream progress
function runScanner(pythonArgs = []) {
  return new Promise((resolve, reject) => {
    const pythonPath = getPythonScriptPath();
    const workingDir = getWorkingDirectory();

    // Delete old JSON file to prevent stale data
    try {
      const oldJsonPath = path.join(workingDir, 'drive_info.json');
      if (fs.existsSync(oldJsonPath)) {
        fs.unlinkSync(oldJsonPath);
      }
    } catch (err) {
      console.log('Could not delete old JSON file:', err.message);
    }
    
    console.log('Environment:', app.isPackaged ? 'Production' : 'Development');
    console.log('Python script path:', pythonPath);
    console.log('Working directory:', workingDir);
    
    // Check if Python script exists
    if (!fs.existsSync(pythonPath)) {
      reject({ success: false, error: `Python script not found at: ${pythonPath}` });
      return;
    }
    
    const args = [pythonPath, '--electron', ...pythonArgs];
    const pythonExe = getPythonExecutablePath();
    const pythonProcess = spawn(pythonExe, args, {
      cwd: workingDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    let output = '';
    let error = '';
    
    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.log('Python output:', text);
      // Parse progress markers and forward to renderer
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^::progress::(\d{1,3})::(.*)$/);
        if (match && mainWindow) {
          const percent = Math.min(100, Math.max(0, parseInt(match[1], 10)));
          const message = match[2];
          mainWindow.webContents.send('scan-progress', { percent, message });
        }
      }
    });
    
    pythonProcess.stderr.on('data', (data) => {
      error += data.toString();
      console.log('Python error:', data.toString());
    });
    
    pythonProcess.on('error', (err) => {
      console.log('Process error:', err);
      reject({ success: false, error: `Failed to start Python: ${err.message}` });
    });
    
    pythonProcess.on('close', (code) => {
      console.log('Python process closed with code:', code);
      if (code === 0) {
        // Wait a moment for file to be fully written
        setTimeout(() => {
          try {
            const jsonPath = path.join(workingDir, 'drive_info.json');
            console.log('Looking for JSON at:', jsonPath);
            
            if (fs.existsSync(jsonPath)) {
              const jsonContent = fs.readFileSync(jsonPath, 'utf8');
              console.log('JSON file size:', jsonContent.length, 'bytes');
              const driveData = JSON.parse(jsonContent);
              console.log('Successfully parsed JSON with', driveData.drives?.length || 0, 'drives');
              resolve({ success: true, data: driveData, output });
            } else {
              console.log('JSON file not found at:', jsonPath);
              reject({ success: false, error: 'drive_info.json not created' });
            }
          } catch (err) {
            console.log('JSON parsing error:', err.message);
            reject({ success: false, error: 'Failed to read drive data', details: err.message });
          }
        }, 100);
      } else {
        reject({ success: false, error: error || 'Python process failed', code, output });
      }
    });
  });
}

// IPC handlers for drive scanning
ipcMain.handle('scan-drives', async () => {
  // Backward-compatible: full system scan (all drives)
  return runScanner([]);
});

ipcMain.handle('list-drives', async () => {
  return new Promise((resolve, reject) => {
    const pythonPath = getPythonScriptPath();
    const workingDir = getWorkingDirectory();
    if (!fs.existsSync(pythonPath)) {
      reject({ success: false, error: `Python script not found at: ${pythonPath}` });
      return;
    }
    const pythonExe = getPythonExecutablePath();
    const proc = spawn(pythonExe, [pythonPath, '--list-drives'], { cwd: workingDir, env: getPythonEnv() });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => reject({ success: false, error: err.message }));
    proc.on('close', code => {
      if (code !== 0) {
        reject({ success: false, error: stderr || 'Failed to list drives' });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ success: true, drives: parsed.drives || [] });
      } catch (e) {
        resolve({ success: true, drives: stdout.trim().split(/\s+/).filter(Boolean) });
      }
    });
  });
});

ipcMain.handle('scan-drive', async (event, roots) => {
  if (!roots || (Array.isArray(roots) && roots.length === 0)) {
    return { success: false, error: 'No drive specified' };
  }
  const args = ['--scan'];
  if (Array.isArray(roots)) args.push(...roots);
  else args.push(roots);
  return runScanner(args);
});

ipcMain.handle('show-save-dialog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'seve-report.json',
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

ipcMain.handle('show-save-dialog-pdf', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'SEVE_Drive_Analysis_Report.pdf',
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

ipcMain.handle('save-file', async (event, filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC: generate SEVE PDF report via Python script in /report
ipcMain.handle('generate-seve-report', async (_evt, { filePath, data }) => {
  try {
    const scriptPath = getReportScriptPath();
    const workingDir = getWorkingDirectory();
    if (!fs.existsSync(scriptPath)) {
      return { success: false, error: `Report script not found at: ${scriptPath}` };
    }

    const pythonExe = getPythonExecutablePath();

    const args = [scriptPath, '--output', String(filePath)];
    const coverCandidate = path.join(path.dirname(scriptPath), 'bg.png');
    if (fs.existsSync(coverCandidate)) {
      args.push('--cover', coverCandidate);
    }
    // Write input data to temp JSON
    let tempJsonPath = null;
    try {
      const ifaces = os.networkInterfaces();
      let primaryIPv4 = '';
      try {
        for (const k of Object.keys(ifaces)) {
          for (const ni of ifaces[k] || []) {
            if (ni && ni.family === 'IPv4' && !ni.internal) { primaryIPv4 = ni.address; break; }
          }
          if (primaryIPv4) break;
        }
      } catch (_) {}
      const sysInfo = {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        version: (os.version ? os.version() : ''),
        arch: os.arch(),
        user: (()=>{ try { return os.userInfo().username; } catch(_) { return ''; } })(),
        ip: primaryIPv4
      };
      const enriched = { ...(data || {}), system_info: sysInfo };
      tempJsonPath = path.join(workingDir, 'seve_report_input.json');
      fs.writeFileSync(tempJsonPath, JSON.stringify(enriched, null, 2), 'utf8');
      args.push('--input', tempJsonPath);
    } catch (_) { tempJsonPath = null; }

    console.log('[SEVE] generate-seve-report using pythonExe=', pythonExe, ' scriptPath=', scriptPath, ' cwd=', workingDir);

    const attempt = async () => {
      return await new Promise((resolve) => {
        const proc = spawn(pythonExe, args, { cwd: workingDir, env: getPythonEnv() });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('error', err => resolve({ ok: false, stdout, stderr: err.message }));
        proc.on('close', code => resolve({ ok: code === 0, code, stdout, stderr }));
      });
    };

    let result = await attempt();

    try { if (tempJsonPath && fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath); } catch (_) {}
    if (!result.ok) {
      return { success: false, error: result.stderr || `Report generation failed (${result.code})` };
    }
    return { success: true, stdout: result.stdout };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: overwrite a single file securely
ipcMain.handle('wipe-file', async (_evt, { path: filePath, passes = 1, pattern = 'zeros' }) => {
  try {
    const wipeScriptPath = getWipeScriptPath();
    const workingDir = getWorkingDirectory();
    if (!fs.existsSync(wipeScriptPath)) {
      return { success: false, error: `Wipe script not found at: ${wipeScriptPath}` };
    }
    const args = [wipeScriptPath, '--wipe-file', '--path', String(filePath), '--passes', String(passes), '--pattern', String(pattern)];
    const pythonExe = getPythonExecutablePath();
    const proc = spawn(pythonExe, args, { cwd: workingDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      // Forward progress markers
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^::progress::(\d{1,3})::(.*)$/);
        if (m && mainWindow) {
          const percent = Math.min(100, Math.max(0, parseInt(m[1], 10)));
          const message = m[2];
          mainWindow.webContents.send('wipe-progress', { percent, message });
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    return await new Promise((resolve) => {
      proc.on('close', (code) => {
        try {
          const jsonText = stdout.trim().split(/\r?\n/).filter(l => !l.startsWith('::progress::')).join('\n');
          const parsed = JSON.parse(jsonText || '{}');
          if (code === 0 && parsed && parsed.success) {
            resolve(parsed);
          } else {
            resolve({ success: false, error: parsed?.error || stderr || `wipe-file failed (${code})` });
          }
        } catch (e) {
          resolve({ success: false, error: 'wipe-file parse failed', details: stdout || stderr });
        }
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Preview a file (text-safe). Reads up to 64KB, detects binary heuristically.
ipcMain.handle('preview-file', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { success: false, error: 'Path is not a file' };
    }
    const fd = fs.openSync(filePath, 'r');
    const maxBytes = 64 * 1024; // 64KB
    const toRead = Math.min(maxBytes, stats.size);
    const buffer = Buffer.alloc(toRead);
    fs.readSync(fd, buffer, 0, toRead, 0);
    fs.closeSync(fd);

    // Heuristic for binary: presence of many non-text bytes or nulls
    const nullCount = buffer.includes(0) ? 1 : 0;
    let nonPrintable = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c === 9 || c === 10 || c === 13) continue; // \t, \n, \r
      if (c < 32 || c > 126) nonPrintable++;
      if (nonPrintable > 200) break;
    }
    const isBinary = nullCount > 0 || nonPrintable > buffer.length * 0.1;
    const preview = isBinary ? undefined : buffer.toString('utf8');
    return {
      success: true,
      isBinary,
      size: stats.size,
      snippet: isBinary ? buffer.toString('hex').slice(0, 4096) : preview.slice(0, 65536)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Delete selected files. Returns per-file result and a deletion report.
ipcMain.handle('delete-files', async (event, files) => {
  if (!Array.isArray(files)) {
    return { success: false, error: 'Invalid payload' };
  }
  const results = [];
  const startedAt = new Date().toISOString();
  for (const filePath of files) {
    try {
      if (!fs.existsSync(filePath)) {
        results.push({ path: filePath, name: path.basename(filePath), size: 0, success: false, error: 'Not found' });
        continue;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        results.push({ path: filePath, name: path.basename(filePath), size: stat.size || 0, success: false, error: 'Not a file' });
        continue;
      }
      const preSize = stat.size || 0;
      fs.unlinkSync(filePath);
      results.push({ path: filePath, name: path.basename(filePath), size: preSize, success: true });
    } catch (e) {
      results.push({ path: filePath, name: path.basename(filePath), size: 0, success: false, error: e.message });
    }
  }
  const summary = {
    operation: 'delete_selected',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    total: files.length,
    deleted: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    items: results
  };
  return { success: true, report: summary };
});

// IPC handler for wiping a drive
ipcMain.handle('wipe-drive', async (event, { driveId, level, pattern }) => {
  return new Promise((resolve, reject) => {
    const wipeScriptPath = getWipeScriptPath();
    const workingDir = getWorkingDirectory();

    if (!fs.existsSync(wipeScriptPath)) {
      return reject({ success: false, error: `Wipe script not found at: ${wipeScriptPath}` });
    }

    // Use unified CLI: wipe_utils.py --wipe --level <N> --drive <X:\> [--pattern zeros|random]
    const args = [wipeScriptPath, '--wipe', '--level', String(level), '--drive', driveId];
    if (pattern) args.push('--pattern', String(pattern));
    
    // IMPORTANT: Spawning with shell=true and running as admin is a security risk if not handled carefully.
    // For a real app, a more secure method (e.g., a helper executable with a manifest) is needed.
    // Here, we assume the app is run with admin rights for this to work.
    const pythonExe = getPythonExecutablePath();
    const wipeProcess = spawn(pythonExe, args, {
      cwd: workingDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      // shell: true // May be needed for admin rights propagation
    });

    let output = '';
    let error = '';

    wipeProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // forward ::progress:: markers to renderer
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^::progress::(\d{1,3})::(.*)$/);
        if (match && mainWindow) {
          const percent = Math.min(100, Math.max(0, parseInt(match[1], 10)));
          const message = match[2];
          mainWindow.webContents.send('wipe-progress', { percent, message });
        }
      }
    });

    wipeProcess.stderr.on('data', (data) => {
      error += data.toString();
    });

    wipeProcess.on('error', (err) => {
      reject({ success: false, error: `Failed to start wipe process: ${err.message}` });
    });

    wipeProcess.on('close', (code) => {
      // Write logs for post-mortem
      try {
        fs.writeFileSync(path.join(workingDir, 'wipe_stdout.log'), output || '');
        fs.writeFileSync(path.join(workingDir, 'wipe_stderr.log'), error || '');
      } catch (_) {}
      if (code === 0) {
        try {
          // Remove progress lines before parsing JSON, similar to wipe-file handler
          const cleaned = (output || '').trim()
            .split(/\r?\n/)
            .filter(l => !l.startsWith('::progress::'))
            .join('\n')
            .trim();

          // Some tools may print diagnostic text before the final JSON.
          // Try direct parse first; if it fails, extract the last JSON object starting at the last '{'.
          let parsed;
          try {
            parsed = JSON.parse(cleaned);
          } catch (_) {
            const lastBrace = cleaned.lastIndexOf('{');
            if (lastBrace >= 0) {
              const tail = cleaned.slice(lastBrace).trim();
              parsed = JSON.parse(tail);
            } else {
              throw new Error('No JSON found');
            }
          }
          resolve(parsed);
        } catch (e) {
          reject({ success: false, error: 'Failed to parse wipe result JSON.', details: output });
        }
      } else {
        reject({ success: false, error: `Wipe process failed with code ${code}.`, details: (error || output || '') });
      }
    });
  });
});
