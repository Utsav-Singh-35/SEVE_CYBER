const { contextBridge, ipcRenderer } = require('electron');
// Provide local jsPDF (installed via npm) to avoid CDN dependency in bootable environments
let jsPDFLocal = null;
try {
  // jspdf v3 UMD exports { jsPDF }
  const jspdf = require('jspdf');
  jsPDFLocal = jspdf && (jspdf.jsPDF || jspdf.default?.jsPDF) ? (jspdf.jsPDF || jspdf.default.jsPDF) : null;
} catch (e) {
  jsPDFLocal = null;
}

contextBridge.exposeInMainWorld('electronAPI', {
  scanDrives: () => ipcRenderer.invoke('scan-drives'),
  listDrives: () => ipcRenderer.invoke('list-drives'),
  scanDrive: (root) => ipcRenderer.invoke('scan-drive', root),
  showSaveDialog: () => ipcRenderer.invoke('show-save-dialog'),
  showSaveDialogPdf: () => ipcRenderer.invoke('show-save-dialog-pdf'),
  saveFile: (filePath, data) => ipcRenderer.invoke('save-file', filePath, data),
  previewFile: (filePath) => ipcRenderer.invoke('preview-file', filePath),
  deleteFiles: (paths) => ipcRenderer.invoke('delete-files', paths),
  wipeDrive: (args) => ipcRenderer.invoke('wipe-drive', args),
  wipeFile: (payload) => ipcRenderer.invoke('wipe-file', payload),
  searchFiles: (root, query) => ipcRenderer.invoke('search-files', { root, query }),
  locateFile: (filePath) => ipcRenderer.invoke('locate-file', filePath),
  generateSeveReport: (filePath, data) => ipcRenderer.invoke('generate-seve-report', { filePath, data }),
  getDriveInfo: (driveId) => ipcRenderer.invoke('get-drive-info', driveId),
  getSystemHealth: () => ipcRenderer.invoke('get-system-health'),
  generateAISummary: (payload) => ipcRenderer.invoke('generate-ai-summary', payload),
  aiChat: (message, options) => ipcRenderer.invoke('ai-chat', { message, options }),
  analyzeFileContent: (filePath, content, snippet) => ipcRenderer.invoke('analyze-file-content', { filePath, content, snippet }),
  generateFileRemarks: (files) => ipcRenderer.invoke('generate-file-remarks', { files }),
  resetChat: () => ipcRenderer.invoke('reset-chat'),
  scanBrowserPrivacy: () => ipcRenderer.invoke('scan-browser-privacy'),
  clearTrackingCookies: () => ipcRenderer.invoke('clear-tracking-cookies'),
  clearAllCookies: () => ipcRenderer.invoke('clear-all-cookies'),
  forensicScan: (drive, sectorStart, sectorCount) => ipcRenderer.invoke('forensic-scan', { drive, sectorStart, sectorCount }),
  forensicViewFile: (drive, sector, type) => ipcRenderer.invoke('forensic-view-file', { drive, sector, type }),
  forensicExportFile: (drive, sector, type, outputPath) => ipcRenderer.invoke('forensic-export-file', { drive, sector, type, outputPath }),
  forensicWipeSectors: (drive, sector, count, passes) => ipcRenderer.invoke('forensic-wipe-sectors', { drive, sector, count, passes }),
  onForensicProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('forensic-progress', listener);
    return () => ipcRenderer.removeListener('forensic-progress', listener);
  },
  startMalwareMonitor: (path) => ipcRenderer.invoke('start-malware-monitor', { path }),
  stopMalwareMonitor: () => ipcRenderer.invoke('stop-malware-monitor'),
  onMalwareAlert: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('malware-alert', listener);
    return () => ipcRenderer.removeListener('malware-alert', listener);
  },
  startNetworkMonitor: (duration) => ipcRenderer.invoke('start-network-monitor', { duration }),
  stopNetworkMonitor: () => ipcRenderer.invoke('stop-network-monitor'),
  onNetworkAlert: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('network-alert', listener);
    return () => ipcRenderer.removeListener('network-alert', listener);
  },
  onNetworkMonitorStopped: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('network-monitor-stopped', listener);
    return () => ipcRenderer.removeListener('network-monitor-stopped', listener);
  },
  startExfiltrationDetector: (duration) => ipcRenderer.invoke('start-exfiltration-detector', { duration }),
  stopExfiltrationDetector: () => ipcRenderer.invoke('stop-exfiltration-detector'),
  onExfiltrationAlert: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('exfiltration-alert', listener);
    return () => ipcRenderer.removeListener('exfiltration-alert', listener);
  },
  onExfiltrationDetectorStopped: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('exfiltration-detector-stopped', listener);
    return () => ipcRenderer.removeListener('exfiltration-detector-stopped', listener);
  },
  startAnomalyDetector: (baselineDuration, monitorDuration) => ipcRenderer.invoke('start-anomaly-detector', { baselineDuration, monitorDuration }),
  stopAnomalyDetector: () => ipcRenderer.invoke('stop-anomaly-detector'),
  onAnomalyAlert: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('anomaly-alert', listener);
    return () => ipcRenderer.removeListener('anomaly-alert', listener);
  },
  onAnomalyBaselineProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('anomaly-baseline-progress', listener);
    return () => ipcRenderer.removeListener('anomaly-baseline-progress', listener);
  },
  onAnomalyBaselineEstablished: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('anomaly-baseline-established', listener);
    return () => ipcRenderer.removeListener('anomaly-baseline-established', listener);
  },
  onAnomalyDetectorStopped: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('anomaly-detector-stopped', listener);
    return () => ipcRenderer.removeListener('anomaly-detector-stopped', listener);
  },
  onScanProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
  onWipeProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('wipe-progress', listener);
    return () => ipcRenderer.removeListener('wipe-progress', listener);
  }
});

// Expose libraries
contextBridge.exposeInMainWorld('libs', {
  jsPDF: jsPDFLocal || null
});
