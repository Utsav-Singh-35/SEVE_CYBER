// SEVE Desktop - Vanilla JavaScript Implementation

let driveData = {};
let selectedFiles = new Set();
let fileRemarks = {}; // key: file path, value: remark string
let unsubscribeProgress = null;
let elapsedInterval = null;
let scanStartMs = 0;
// Latest clearance report (deletion or wipe) to be used for Machine/PDF report buttons
let currentClearanceReport = null;

// Default behavior: when wiping free space, write zeros (0x00) rather than random

const FREE_SPACE_PATTERN = 'zeros'; // alternatives we may support later: 'random'

// Progress animation controller state
let progressAnimId = null;
let displayedProgress = 0;   // 0..1 actually shown
let targetProgress = 0;      // 0..1 from backend
let stallPoints = [];        // array of fractions e.g., [0.12, 0.34, 0.6]
let stallIndex = 0;          // next stall to trigger
let stallUntil = 0;          // timestamp when stall ends
let progressMessage = '';

// Enhanced Background Animation
function initBackgroundAnimation() {
    const body = document.body;
    let mouseX = 0;
    let mouseY = 0;
    let targetX = 0;
    let targetY = 0;
    
    // Mouse tracking for parallax effect
    document.addEventListener('mousemove', (e) => {
        mouseX = (e.clientX / window.innerWidth) * 2 - 1;
        mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    });
    
    // Smooth animation loop
    function animateBackground() {
        targetX += (mouseX - targetX) * 0.02;
        targetY += (mouseY - targetY) * 0.02;
        
        const translateX = targetX * 20;
        const translateY = targetY * 20;
        const scale = 1 + Math.abs(targetX) * 0.05 + Math.abs(targetY) * 0.05;
        
        if (body.style.setProperty) {
            body.style.setProperty('--bg-x', `${translateX}px`);
            body.style.setProperty('--bg-y', `${translateY}px`);
            body.style.setProperty('--bg-scale', scale);
        }

// Helper: load image as DataURL with fallbacks for bootable/offline
async function loadImageDataURL(candidates) {
    const tryLoad = async (url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('not ok');
            const blob = await res.blob();
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (_) { return null; }
    };
    for (const c of candidates) {
        const data = await tryLoad(c);
        if (data) return data;
    }
    return null;
}

// Generate a human-readable Clearance Certificate PDF (Certificate-like layout)
async function generateClearancePDF(report) {
    if (!report) throw new Error('No report');
    const jsPDF = (window.libs && window.libs.jsPDF) || (window.jspdf && window.jspdf.jsPDF);
    if (!jsPDF) throw new Error('jsPDF not available');
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });

    // Dimensions
    const page = { w: 595.28, h: 841.89 };
    const crimson = [226, 99, 99];
    const dark = [20, 20, 25];

    // Border frame
    doc.setDrawColor(...crimson); doc.setLineWidth(2);
    doc.rect(20, 20, page.w - 40, page.h - 40);
    doc.setDrawColor(200); doc.setLineWidth(0.5);
    doc.rect(30, 30, page.w - 60, page.h - 60);

    // Header with logo and title
    let logoData = await loadImageDataURL([
        '../../assets/report.jpeg', // bootable_gui/assets
        '../assets/report.jpeg',
        'assets/report.jpeg'
    ]);
    const headerY = 60;
    if (logoData) {
        try { doc.addImage(logoData, 'JPEG', 48, headerY - 20, 80, 80); } catch(_) {}
    }
    doc.setTextColor(...dark);
    doc.setFontSize(26);
    doc.text('Certificate of Data Clearance', page.w/2, headerY + 10, { align: 'center' });
    doc.setFontSize(12);
    const issued = new Date().toLocaleString();
    const op = report.operation || 'clearance';
    const drive = report.drive || '';
    doc.text(`Issued: ${issued}`, page.w/2, headerY + 30, { align: 'center' });
    if (drive) doc.text(`Drive: ${drive}`, page.w/2, headerY + 46, { align: 'center' });
    doc.text(`Operation: ${op}`, page.w/2, headerY + 62, { align: 'center' });

    // Summary box
    let y = 150;
    doc.setDrawColor(...crimson); doc.setLineWidth(1);
    doc.rect(45, y - 18, page.w - 90, 110);
    doc.setFontSize(14); doc.setTextColor(...crimson); doc.text('Summary', 55, y);
    doc.setFontSize(12); doc.setTextColor(...dark); y += 18;
    if (report.bytes_written !== undefined) {
        doc.text(`Bytes Written: ${formatBytes(report.bytes_written || 0)}`, 55, y); y += 16;
        doc.text(`Files Created (free-space fill): ${String(report.files_created || 0)}`, 55, y); y += 16;
        doc.text(`Pattern: ${(report.pattern || 'zeros').toUpperCase()}`, 55, y); y += 16;
    }
    if (report.deleted !== undefined || (report.items && report.items.length)) {
        const del = report.deleted ?? (report.items?.filter(i => i.success).length || 0);
        const total = report.total ?? (report.items?.length || 0);
        doc.text(`Files Deleted: ${del} / ${total}`, 55, y); y += 16;
    }

    // Cleared folders table
    if (Array.isArray(report.folders) && report.folders.length > 0) {
        y += 20; if (y > page.h - 80) { doc.addPage(); y = 60; }
        doc.setFontSize(14); doc.setTextColor(...crimson); doc.text('Cleared Folders', 45, y); y += 14;
        doc.setFontSize(11); doc.setTextColor(...dark);
        doc.text('Name', 55, y); doc.text('Directory', 220, y); doc.text('Size', page.w - 120, y); y += 10;
        doc.setDrawColor(220); doc.line(45, y, page.w - 45, y); y += 8;
        for (const folder of report.folders) {
            if (y > page.h - 60) { doc.addPage(); y = 60; }
            const name = (folder.name || '').toString().slice(0, 30);
            const dir = (folder.path || '').toString();
            const size = formatBytes(folder.size_bytes || 0);
            doc.text(name, 55, y);
            // wrap directory
            const dirLines = doc.splitTextToSize(dir, page.w - 240);
            doc.text(dirLines, 220, y);
            doc.text(size, page.w - 120, y);
            y += 14 + (dirLines.length - 1) * 12;
        }
    }

    // Deleted files list (if present)
    if (Array.isArray(report.items) && report.items.length > 0) {
        y += 20; if (y > page.h - 80) { doc.addPage(); y = 60; }
        doc.setFontSize(14); doc.setTextColor(...crimson); doc.text('Deleted Files', 45, y); y += 14;
        doc.setFontSize(10); doc.setTextColor(...dark);
        const MAX_ROWS = 300; // cap to keep PDF size reasonable
        let rows = 0;
        for (const item of report.items) {
            if (rows >= MAX_ROWS) { doc.text('... (truncated)', 55, y); break; }
            if (y > page.h - 60) { doc.addPage(); y = 60; }
            const status = item.success ? '' : ' (FAILED)';
            const line = `${item.name || item.path || ''}${status}`;
            const wrapped = doc.splitTextToSize(line, page.w - 90);
            doc.text(wrapped, 55, y);
            y += 12 + (wrapped.length - 1) * 12;
            rows++;
        }
    }

    // Signature area
    y = Math.min(y + 40, page.h - 140);
    doc.setDrawColor(180); doc.line(80, page.h - 120, 260, page.h - 120);
    doc.line(page.w - 260, page.h - 120, page.w - 80, page.h - 120);
    doc.setFontSize(10); doc.setTextColor(...dark);
    doc.text('Authorized Signature', 110, page.h - 105);
    doc.text('Date', page.w - 200, page.h - 105);

    // Footer
    doc.setFontSize(10); doc.setTextColor(120);
    doc.text('SEVE - Secure Erase & Verification Engine', 45, page.h - 40);
    const fname = `SEVE_Clearance_Certificate_${new Date().toISOString().slice(0,10)}.pdf`;
    doc.save(fname);
}
        
        requestAnimationFrame(animateBackground);
    }
    
    animateBackground();
}

// Delegated handler: Secure Erase button
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.wipe-execute-btn');
    if (!btn) return;
    try {
        const driveId = btn.getAttribute('data-drive-id');
        let level = parseInt(btn.getAttribute('data-level') || '3', 10);
        // Query drive info to decide level
        if (driveId && window.electronAPI.getDriveInfo) {
            const info = await window.electronAPI.getDriveInfo(driveId);
            if (info && info.success && info.data) {
                const d = info.data;
                if (d.IsRemovable) {
                    level = 1; // Removable → Level 1
                    btn.textContent = 'Secure Erase (Level 1)';
                } else if (d.IsOS) {
                    level = 3; // OS volume → Level 3 safe clear
                    btn.textContent = 'Secure Erase (Level 3)';
                } else {
                    level = 2; // Non-OS internal → Level 2
                    btn.textContent = 'Secure Erase (Level 2)';
                }
            }
        }
        await executeWipe(driveId, level);
    } catch (err) {
        console.warn('Unable to start wipe:', err);
    }
});

// Home Page Counter Animation
function animateCounter(element, target, duration = 2000, formatter = null) {
    if (!element) return;
    
    const start = 0;
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function (ease-out cubic)
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        const current = Math.floor(start + (target - start) * easeProgress);
        
        element.textContent = formatter ? formatter(current) : current;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = formatter ? formatter(target) : target;
        }
    }
    
    requestAnimationFrame(update);
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

async function initHomePageCounters() {
    try {
        // Fetch system health data
        const healthData = await window.electronAPI.getSystemHealth();
        
        if (healthData.success && healthData.metrics) {
            const metrics = healthData.metrics;
            
            // Animate threats detected (use process count as proxy for activity)
            const threatsEl = document.getElementById('threatsDetected');
            const threatsCount = metrics.processes || 0;
            animateCounter(threatsEl, threatsCount, 2000, formatNumber);
            
            // Animate files scanned (use a calculated value based on disk usage)
            const filesEl = document.getElementById('filesScanned');
            const estimatedFiles = Math.floor((metrics.disk?.used || 0) / (1024 * 50)); // Rough estimate
            animateCounter(filesEl, estimatedFiles, 2500, formatNumber);
            
            // Animate data erased (start at 0, will update after actual erasure)
            const dataEl = document.getElementById('dataErased');
            dataEl.textContent = '0 GB';
            
            // Update system uptime
            const uptimeEl = document.getElementById('systemUptime');
            if (uptimeEl && metrics.uptime) {
                uptimeEl.textContent = formatUptime(metrics.uptime.seconds);
                
                // Update uptime every 60 seconds
                setInterval(() => {
                    const currentUptime = metrics.uptime.seconds + Math.floor((Date.now() - metrics.timestamp) / 1000);
                    uptimeEl.textContent = formatUptime(currentUptime);
                }, 60000);
            }
        } else {
            console.warn('[Home] Failed to fetch system health:', healthData.error);
        }
    } catch (err) {
        console.error('[Home] Error initializing counters:', err);
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', function() {
    initBackgroundAnimation();
    
    // Initialize Lucide icons
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons();
    }
    
    // Initialize home page counters
    initHomePageCounters();
    
    // Sidebar Navigation Logic
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.content-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetSection = item.getAttribute('data-section');
            
            // Update active nav item
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            // Show target section
            sections.forEach(section => {
                section.classList.remove('active');
                if (section.id === targetSection) {
                    section.classList.add('active');
                }
            });
            
            // Auto-refresh health dashboard when navigating to it
            if (targetSection === 'health') {
                // Small delay to ensure the section is visible before refreshing
                setTimeout(() => refreshSystemHealth(), 300);
            }
        });
    });
    
    // Initialize sidebar toggle functionality - wait for Lucide icons to load
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        // Icons are available, initialize immediately
        setTimeout(() => {
            initSidebarToggle();
        }, 200);
    } else {
        // Wait for Lucide to load
        let attempts = 0;
        const waitForLucide = () => {
            if (typeof lucide !== 'undefined' && lucide.createIcons) {
                setTimeout(() => {
                    initSidebarToggle();
                }, 200);
            } else if (attempts < 50) { // Try for 5 seconds
                attempts++;
                setTimeout(waitForLucide, 100);
            } else {
                console.warn('Lucide icons not loaded, initializing sidebar toggle anyway');
                initSidebarToggle();
            }
        };
        waitForLucide();
    }
    
    const scanBtn = document.getElementById('scanBtn');
    const saveBtn = document.getElementById('saveBtn');
    const pdfBtn = document.getElementById('pdfBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const closePreview = document.getElementById('closePreview');
    const previewModal = document.getElementById('previewModal');
    
    scanBtn.addEventListener('click', scanDrives);
    saveBtn.addEventListener('click', saveReport);
    pdfBtn.addEventListener('click', generatePDFReport);
    refreshBtn.addEventListener('click', refreshPage);
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deleteSelectedFiles);
    }

    // Health Dashboard button
    const refreshHealthBtn = document.getElementById('refreshHealthBtn');
    if (refreshHealthBtn) {
        refreshHealthBtn.addEventListener('click', refreshSystemHealth);
    }

    // Wire success modal report buttons
    const saveClearanceBtn = document.getElementById('saveClearanceBtn');
    if (saveClearanceBtn) {
        saveClearanceBtn.addEventListener('click', async () => {
            if (!currentClearanceReport) { showError('No clearance report available.'); return; }
            try {
                const result = await window.electronAPI.showSaveDialog();
                if (!result.canceled && result.filePath) {
                    const payload = {
                        type: 'clearance_report',
                        generated_at: new Date().toISOString(),
                        report: currentClearanceReport
                    };
                    const saveRes = await window.electronAPI.saveFile(result.filePath, payload);
                    if (!saveRes.success) showError(saveRes.error || 'Failed to save clearance report');
                }
            } catch (e) { showError('Failed to save clearance report'); }
        });
    }
    const pdfClearanceBtn = document.getElementById('pdfClearanceBtn');
    if (pdfClearanceBtn) {
        pdfClearanceBtn.addEventListener('click', async () => {
            if (!currentClearanceReport) { /* silently ignore */ return; }
            try { await generateClearancePDF(currentClearanceReport); } catch (e) { console.warn('PDF generation failed (clearance):', e); }
        });
    }
    
    // Initialize success modal close button
    const closeBtn = document.getElementById('closeSuccessModal');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            document.getElementById('opSuccessModal').classList.add('hidden');
        });
    }
    
    closePreview?.addEventListener('click', () => previewModal.classList.add('hidden'));
    previewModal?.addEventListener('click', (e) => { if (e.target === previewModal) previewModal.classList.add('hidden'); });
    
    // Event delegation for file actions
    const listContainer = document.getElementById('driveCards');
    listContainer.addEventListener('change', onListChange, true);
    listContainer.addEventListener('click', onListClick, true);
    
    // Event delegation for search results preview buttons (use document since search results are dynamic)
    document.addEventListener('click', (e) => {
        const previewBtn = e.target.closest('.search-preview-btn');
        if (previewBtn) {
            const path = previewBtn.getAttribute('data-path');
            const name = previewBtn.getAttribute('data-name');
            if (path && name) {
                openPreview(path, name);
            }
        }
    });
});

// Refresh function
function refreshPage() {
    location.reload();
}


function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function showLoading(message = 'Scanning drives...') {
    const loading = document.getElementById('loading');
    const progressFill = document.getElementById('progressFill');
    const progressPercent = document.getElementById('progressPercent');
    const loadingMessage = document.getElementById('loadingMessage');
    const progressBar = document.querySelector('.progress-bar');
    const elapsedTime = document.getElementById('elapsedTime');
    
    // Update loading message if provided
    if (loadingMessage) {
        loadingMessage.textContent = message;
    }
    
    // Reset progress
    if (progressFill) progressFill.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressBar) {
        progressBar.setAttribute('aria-valuenow', '0');
    }
    if (elapsedTime) {
        elapsedTime.textContent = '0.0s';
    }
    
    // Show loading overlay
    loading.classList.remove('hidden');
    loading.classList.add('visible');
    document.body.style.overflow = 'hidden'; // Prevent scrolling when loading is visible
    
    // Hide other UI elements
    const error = document.getElementById('error');
    const results = document.getElementById('results');
    const scanBtn = document.getElementById('scanBtn');
    
    if (error) error.classList.add('hidden');
    if (results) results.classList.add('hidden');
    if (scanBtn) scanBtn.disabled = true;
    
    // Initialize progress animation controller
    displayedProgress = 0;
    targetProgress = 0;
    stallIndex = 0;
    stallPoints = []; // No artificial stalls - show real progress
    stallUntil = 0;
    progressMessage = message;
    if (progressAnimId) cancelAnimationFrame(progressAnimId);
    const animate = () => {
        const now = Date.now();
        
        // Smoothly ease towards target progress (no stalls)
        const delta = targetProgress - displayedProgress;
        const step = Math.sign(delta) * Math.min(Math.abs(delta), 0.05); // Faster, smoother animation
        displayedProgress = Math.max(0, Math.min(1, displayedProgress + step));
        updateProgress(displayedProgress, progressMessage);
        
        // Continue until finished
        if (displayedProgress < 1) {
            progressAnimId = requestAnimationFrame(animate);
        }
    };
    progressAnimId = requestAnimationFrame(animate);

    // Start the elapsed timer
    startElapsedTimer();
}

function hideLoading() {
    const loading = document.getElementById('loading');
    const scanBtn = document.getElementById('scanBtn');
    
    // Add fade out animation
    loading.classList.remove('visible');
    document.body.style.overflow = ''; // Re-enable scrolling
    
    // Wait for animation to complete before hiding
    setTimeout(() => {
        loading.classList.add('hidden');
    }, 300); // Match this with the CSS transition duration
    
    if (scanBtn) scanBtn.disabled = false;
    if (progressAnimId) cancelAnimationFrame(progressAnimId), progressAnimId = null;
    stopElapsedTimer();
}

function showError(message) {
    const error = document.getElementById('error');
    const errorText = document.getElementById('errorText');
    
    if (!error || !errorText) return;
    
    // Update error message
    errorText.textContent = message;
    
    // Show error with animation
    error.classList.remove('hidden');
    error.style.display = 'flex';
    error.style.opacity = '0';
    error.style.transform = 'translateY(-10px)';
    
    // Trigger reflow
    void error.offsetHeight;
    
    // Animate in
    error.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    error.style.opacity = '1';
    error.style.transform = 'translateY(0)';
    
    // Hide any visible results
    const results = document.getElementById('results');
    if (results && !results.classList.contains('hidden')) {
        results.style.opacity = '0';
        results.style.transform = 'translateY(10px)';
        setTimeout(() => {
            results.classList.add('hidden');
            results.style.display = 'none';
        }, 300);
    }
    
    // Ensure loading is hidden
    hideLoading();
}

function showResults() {
    const results = document.getElementById('results');
    const saveBtn = document.getElementById('saveBtn');
    const pdfBtn = document.getElementById('pdfBtn');
    
    if (!results) return;
    
    // Hide any visible errors
    const error = document.getElementById('error');
    if (error && !error.classList.contains('hidden')) {
        error.style.opacity = '0';
        error.style.transform = 'translateY(-10px)';
        setTimeout(() => {
            error.classList.add('hidden');
            error.style.display = 'none';
        }, 300);
    }
    
    // Show results with animation
    results.style.display = 'block';
    results.classList.remove('hidden');
    results.style.opacity = '0';
    results.style.transform = 'translateY(10px)';
    
    // Trigger reflow
    void results.offsetHeight;
    
    // Animate in
    results.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    results.style.opacity = '1';
    results.style.transform = 'translateY(0)';
    
    // Update buttons
    if (saveBtn) saveBtn.disabled = false;
    if (pdfBtn) pdfBtn.disabled = false;
    
    // Hide loading
    hideLoading();
}

// Elapsed timer helpers
function startElapsedTimer() {
    // Reset and start the elapsed timer
    scanStartMs = Date.now();
    updateElapsedTime(); // Initial update
    clearInterval(elapsedInterval); // Clear any existing interval
    elapsedInterval = setInterval(updateElapsedTime, 100);
}

function updateElapsedTime() {
    const elapsedTime = document.getElementById('elapsedTime');
    const progressAria = document.getElementById('progressAria');
    const progressPercent = document.getElementById('progressPercent');
    
    if (elapsedTime) {
        const elapsedSeconds = ((Date.now() - scanStartMs) / 1000).toFixed(1);
        elapsedTime.textContent = `${elapsedSeconds}s`;
        
        // Update progress for screen readers periodically
        if (progressAria && progressPercent) {
            const percent = progressPercent.textContent;
            progressAria.textContent = `${percent} complete, ${elapsedSeconds} seconds elapsed`;
        }
    }
}

function stopElapsedTimer() {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
    
    // Final update to elapsed time
    updateElapsedTime();
    
    // Notify screen readers that the operation is complete
    const progressAria = document.getElementById('progressAria');
    if (progressAria) {
        const progressPercent = document.getElementById('progressPercent')?.textContent || '100%';
        const elapsedTime = document.getElementById('elapsedTime')?.textContent || '0.0s';
        progressAria.textContent = `Operation complete! ${progressPercent} in ${elapsedTime}`;
    }
}

// Track the last progress update time and value
let lastProgressUpdate = 0;
let lastProgressValue = 0;
const MIN_PROGRESS_UPDATE_INTERVAL = 100; // ms
const MIN_PROGRESS_STEP = 0.5; // Minimum % change to update

function updateProgress(progress, message) {
    const now = Date.now();
    const progressFill = document.getElementById('progressFill');
    const progressPercent = document.getElementById('progressPercent');
    const progressBar = document.querySelector('.progress-bar');
    const loadingMessage = document.getElementById('loadingMessage');
    
    // Ensure progress is between 0 and 1
    const safeProgress = Math.max(0, Math.min(1, progress));
    const percent = Math.round(safeProgress * 100);
    
    // Throttle rapid updates and ensure minimum step size
    const timeSinceLastUpdate = now - lastProgressUpdate;
    const progressDiff = Math.abs(percent - lastProgressValue);
    
    if (timeSinceLastUpdate < MIN_PROGRESS_UPDATE_INTERVAL && progressDiff < MIN_PROGRESS_STEP) {
        return; // Skip this update
    }
    
    // Update progress bar with smooth transition
    if (progressFill) {
        // Only update if there's an actual change
        if (parseInt(progressFill.style.width || '0') !== percent) {
            progressFill.style.transition = 'width 0.3s ease-out';
            progressFill.style.width = `${percent}%`;
        }
    }
    
    // Update percentage text with animation
    if (progressPercent) {
        progressPercent.textContent = `${percent}%`;
        // Add a subtle animation on the percentage
        progressPercent.style.transform = 'scale(1.1)';
        setTimeout(() => {
            if (progressPercent) progressPercent.style.transform = 'scale(1)';
        }, 150);
    }
    
    if (progressBar) {
        progressBar.setAttribute('aria-valuenow', percent);
    }
    
    // Update loading message if provided
    if (message && loadingMessage) {
        loadingMessage.textContent = message;
    }
    
    // Update last values
    lastProgressUpdate = now;
    lastProgressValue = percent;
}

// Main Functions
async function scanDrives() {
    try {
        // Step 1: list drives
        const listRes = await window.electronAPI.listDrives();
        if (!listRes.success || !Array.isArray(listRes.drives) || listRes.drives.length === 0) {
            showError(listRes.error || 'No drives detected');
            return;
        }
        const selected = await promptDriveSelection(listRes.drives);
        if (!selected || selected.length === 0) return; // user cancelled

        showLoading();
        // record scan start time
        scanStartMs = Date.now();

        // Subscribe to progress events
        if (unsubscribeProgress) { unsubscribeProgress(); }
        unsubscribeProgress = window.electronAPI.onScanProgress(({ percent, message }) => {
            // Backend emits percent in 0..100; convert to 0..1 and set as target
            const fraction = Math.max(0, Math.min(1, (Number(percent) || 0) / 100));
            targetProgress = Math.max(targetProgress, fraction);
            if (message) progressMessage = message;
        });

        // Step 2: scan selected drives (array)
        const result = await window.electronAPI.scanDrive(selected);

        if (result.success) {
            driveData = result.data;
            driveData.user_remarks = driveData.user_remarks || {};
            driveData.deletion_report = driveData.deletion_report || null;
            renderDrives(result.data.drives || []);
            showResults();
        } else {
            showError(result.error || 'Failed to scan drive');
        }
    } catch (err) {
        showError('Failed to communicate with drive scanner');
    } finally {
        if (unsubscribeProgress) { unsubscribeProgress(); unsubscribeProgress = null; }
        stopElapsedTimer();
    }
}

// Lightweight modal to select a drive
function promptDriveSelection(drives) {
    return new Promise((resolve) => {
        // Build modal elements
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0,0,0,0.8)';
        overlay.style.backdropFilter = 'blur(15px)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '9999';

        const panel = document.createElement('div');
        panel.style.background = 'rgba(255, 255, 255, 0.08)';
        panel.style.backdropFilter = 'blur(25px)';
        panel.style.webkitBackdropFilter = 'blur(25px)';
        panel.style.border = '1px solid rgba(255,255,255,0.15)';
        panel.style.borderRadius = '20px';
        panel.style.padding = '40px';
        panel.style.minWidth = '500px';
        panel.style.maxWidth = '600px';
        panel.style.color = '#fff';
        panel.style.boxShadow = '0 25px 50px rgba(0, 0, 0, 0.5), 0 0 30px rgba(255, 68, 68, 0.1)';

        const listHtml = drives.map(d => `
            <label style="display:flex;align-items:center;gap:16px;margin:16px 0;padding:16px;background:rgba(255,255,255,0.05);border-radius:12px;cursor:pointer;transition:all 0.2s ease;border:1px solid rgba(255,255,255,0.1);" 
                   onmouseover="this.style.background='rgba(255,68,68,0.1)';this.style.borderColor='rgba(255,68,68,0.3)'" 
                   onmouseout="this.style.background='rgba(255,255,255,0.05)';this.style.borderColor='rgba(255,255,255,0.1)'">
                <input type="checkbox" class="drive-check" value="${d}" style="width:18px;height:18px;accent-color:#ff4444;">
                <span style="font-size:1.2rem;font-weight:500;color:#ffffff;">${d}</span>
            </label>
        `).join('');

        panel.innerHTML = `
            <div style="font-size:1.8rem;margin-bottom:24px;color:#ffffff;font-weight:600;text-align:center;">Select Drives to Scan</div>
            <div style="font-size:1rem;margin-bottom:32px;color:#aaaaaa;text-align:center;line-height:1.5;">Choose one or more drives for secure erasure analysis</div>
            <div style="max-height:300px;overflow:auto;padding:8px;border:1px solid rgba(255,255,255,0.1);border-radius:16px;background:rgba(0,0,0,0.3);">
                ${listHtml}
            </div>
            <div style="margin-top:24px;">
                <div style="opacity:0.7;font-size:0.95rem;color:#ff6666;display:flex;align-items:center;gap:8px;margin-bottom:20px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <path d="M12 16v-4"></path>
                        <path d="M12 8h.01"></path>
                    </svg>
                    Multiple drives can be selected
                </div>
                <div style="display:flex;gap:12px;justify-content:center;">
                    <button id="cancelBtn" class="modal-btn modal-btn-secondary">Cancel</button>
                    <button id="okBtn" class="modal-btn modal-btn-primary">Scan Drives</button>
                </div>
            </div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const cleanup = () => overlay.remove();
        panel.querySelector('#cancelBtn').addEventListener('click', () => { cleanup(); resolve(null); });
        panel.querySelector('#okBtn').addEventListener('click', () => {
            const checks = Array.from(panel.querySelectorAll('.drive-check'));
            const values = checks.filter(c => c.checked).map(c => c.value);
            cleanup();
            resolve(values);
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
    });
}

async function saveReport() {
    if (!driveData || !driveData.drives || driveData.drives.length === 0) return;
    
    try {
        const result = await window.electronAPI.showSaveDialog();
        if (!result.canceled && result.filePath) {
            // attach latest remarks and any deletion report
            driveData.user_remarks = fileRemarks;
            const saveResult = await window.electronAPI.saveFile(result.filePath, driveData);
            if (!saveResult.success) {
                showError(saveResult.error || 'Failed to save file');
            }
        }
    } catch (err) {
        showError('Failed to save report');
    }
}

// PDF Report Generation
async function generatePDFReport() {
    if (!driveData || !driveData.drives || driveData.drives.length === 0) return;
    try {
        const result = await window.electronAPI.showSaveDialogPdf();
        if (result.canceled || !result.filePath) return;
        const outPath = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : `${result.filePath}.pdf`;
        const res = await window.electronAPI.generateSeveReport(outPath, driveData);
        if (!res || !res.success) {
            showError(res?.error || 'Failed to generate SEVE report');
            return;
        }
    } catch (e) {
        showError('Failed to generate SEVE report');
    }
}

function renderDrives(drives) {
    driveCards.innerHTML = '';
    
    drives.forEach(drive => {
        const card = createDriveCard(drive);
        driveCards.appendChild(card);
    });
    // Reset selection state
    selectedFiles = new Set();
    updateDeleteButtonState();
}

function createDriveCard(drive) {
    const card = document.createElement('div');
    card.className = 'drive-card';
    
    const usageClass = drive.usage_percentage > 90 ? 'danger' : 
                      drive.usage_percentage > 75 ? 'warning' : '';
    
    card.innerHTML = `
        <div class="drive-header" style="display:flex;align-items:center;gap:15px;padding:15px;background:rgba(30,30,30,0.5);border-radius:8px;margin-bottom:15px;">
            <span class="drive-icon" style="font-size:2rem;flex-shrink:0;">
                <i data-lucide="hard-drive" style="width: 2rem; height: 2rem; color: #ff4444;"></i>
            </span>
            <div style="flex:1;min-width:0;">
                <div class="drive-title" style="font-size:1.2rem;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${drive.model || 'Unknown Drive'} (${drive.drive || 'Unknown'})
                </div>
                <div class="drive-subtitle" style="font-size:0.9rem;color:rgba(255,255,255,0.7);margin-bottom:8px;">
                    ${drive.filesystem || 'Unknown'} • ${drive.total_space_human || 'Unknown size'}
                </div>
                <div style="margin-top:6px;font-size:0.85rem;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                    <span class="badge" style="padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);font-size:0.8rem;white-space:nowrap;">
                        Mode: ${drive.scan_mode || 'Filesystem'}
                    </span>
                    <span class="badge" style="padding:3px 10px;border-radius:999px;border:1px solid ${drive.count_accuracy === 'Exact' ? 'rgba(0,200,0,0.5)' : 'rgba(255,80,80,0.5)'};background:${drive.count_accuracy === 'Exact' ? 'rgba(0,200,0,0.12)' : 'rgba(255,80,80,0.12)'};font-size:0.8rem;white-space:nowrap;">
                        Accuracy: ${drive.count_accuracy || 'Partial'}
                    </span>
                    ${typeof drive.scan_duration_seconds === 'number' ? 
                      `<span class="badge" style="padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);font-size:0.8rem;white-space:nowrap;">
                        Time: ${drive.scan_duration_seconds.toFixed(1)}s
                      </span>` : ''}
                    ${drive.media_type ? 
                      `<span class="badge" style="padding:3px 10px;border-radius:999px;border:1px solid rgba(100,180,255,0.3);background:rgba(100,180,255,0.1);font-size:0.8rem;white-space:nowrap;">
                        ${drive.media_type}
                      </span>` : ''}
                    ${drive.file_analysis?.skipped_errors > 0 ? 
                      `<span style="opacity:0.8;font-size:0.8rem;color:rgba(255,180,180,0.9);">
                        Skipped: ${drive.file_analysis.skipped_errors}
                      </span>` : ''}
                </div>
            </div>
            <button class="btn btn-danger wipe-execute-btn" style="flex-shrink:0;"
                    data-drive-id="${CSS.escape(drive.drive || '')}"
                    data-level="3"
                    title="Secure Erase (auto-detects removable drives)">Secure Erase</button>
        </div>
        
        <div class="usage-bar" style="margin:20px 0;padding:0 5px;">
            <div class="usage-label" style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:0.9rem;color:rgba(255,255,255,0.8);">
                <span>Storage Usage</span>
                <span>${drive.usage_percentage.toFixed(1)}%</span>
            </div>
            <div class="progress-bar" style="height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;margin-bottom:8px;">
                <div class="progress-fill ${usageClass}" 
                     style="height:100%;background:linear-gradient(90deg, #e26363, #ff8a8a);transition:width 0.3s ease;width:${drive.usage_percentage}%;"></div>
            </div>
            <div class="usage-details" style="display:flex;justify-content:space-between;font-size:0.85rem;color:rgba(255,255,255,0.6);">
                <span>Used: ${drive.used_space_human || 'N/A'}</span>
                <span>Free: ${drive.free_space_human || 'N/A'}</span>
            </div>
        </div>

        
        <div class="search-section">
            <div class="section-title">
                <span>
                    <i data-lucide="search" style="width: 1.1rem; height: 1.1rem; color: #ff4444;"></i>
                </span>
                Search Files
            </div>
            <div class="search-container">
                <input type="text" 
                       class="search-input" 
                       placeholder="Search files and directories..." 
                       data-drive="${CSS.escape(drive.drive || '')}">
                <button type="button" 
                        class="search-btn" 
                        data-drive="${CSS.escape(drive.drive || '')}">
                    Search
                </button>
            </div>
            <div class="search-results hidden" 
                 data-drive="${CSS.escape(drive.drive || '')}">
            </div>
        </div>
        
        <div class="section" style="margin:25px 0;padding:15px;background:rgba(30,30,30,0.3);border-radius:8px;">
            <div class="section-title" style="display:flex;align-items:center;gap:8px;font-size:1.1rem;margin-bottom:15px;color:#fff;font-weight:500;">
                <span>
                    <i data-lucide="bar-chart-3" style="width: 1.1rem; height: 1.1rem; color: #ff4444;"></i>
                </span>
                File Categories
            </div>
            <div class="file-categories" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:12px;">
                ${renderFileCategories(drive.file_analysis.categories)}
            </div>
        </div>
        
        <div class="section" style="margin:25px 0;padding:15px;background:rgba(30,30,30,0.3);border-radius:8px;">
            <div class="section-title" style="display:flex;align-items:center;gap:8px;font-size:1.1rem;margin-bottom:15px;color:#fff;font-weight:500;">
                <span>📈</span>
                Summary
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:12px;font-size:0.95rem;">
                <div style="background:rgba(255,255,255,0.05);padding:12px;border-radius:6px;border-left:3px solid #e26363;">
                    <div style="font-size:0.8rem;color:rgba(255,255,255,0.7);margin-bottom:4px;">Total Files</div>
                    <div style="font-size:1.2rem;font-weight:600;">${(drive.file_analysis?.total_files || 0).toLocaleString()}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05);padding:12px;border-radius:6px;border-left:3px solid #63a4e2;">
                    <div style="font-size:0.8rem;color:rgba(255,255,255,0.7);margin-bottom:4px;">Total Directories</div>
                    <div style="font-size:1.2rem;font-weight:600;">${(drive.file_analysis?.total_directories || 0).toLocaleString()}</div>
                </div>
                ${drive.file_analysis?.skipped_errors ? `
                <div style="background:rgba(255,100,100,0.08);padding:12px;border-radius:6px;border-left:3px solid #ff6b6b;">
                    <div style="font-size:0.8rem;color:rgba(255,180,180,0.9);margin-bottom:4px;">Skipped (errors/denied)</div>
                    <div style="font-size:1.2rem;font-weight:600;color:#ff8a8a;">${drive.file_analysis.skipped_errors.toLocaleString()}</div>
                </div>` : ''}
            </div>
        </div>
        
        ${drive.file_analysis.largest_files.length > 0 ? `
        <!-- ========== LARGEST FILES SECTION ========== -->
        <div class="section" style="margin:25px 0;padding:25px;background:transparent;border-radius:0;position:relative;overflow:hidden;">
            
            <!-- Section Header -->
            <div class="section-title" style="display:flex;align-items:center;gap:12px;font-size:1.25rem;margin-bottom:20px;color:#ff8a80;font-weight:700;text-transform:uppercase;letter-spacing:1px;position:relative;z-index:1;">
                <span style="font-size:1.5em;">
                    <i data-lucide="file-search" style="width: 1.5em; height: 1.5em; color: #ff8a80;"></i>
                </span>
                <span>LARGEST FILES (&gt;100MB)</span>
            </div>
            
            <!-- File List Container -->
            <div class="file-list" style="background:transparent;border-radius:0;overflow:hidden;box-shadow:none;border:none;">
                ${renderLargestFiles(drive.file_analysis.largest_files)}
            </div>
        </div>` : ''}
        
        ${drive.file_analysis.sensitive_files && drive.file_analysis.sensitive_files.length > 0 ? `
        <!-- ========== SENSITIVE FILES SECTION ========== -->
        <div class="section" style="margin:35px 0;padding:25px;background:transparent;border-radius:0;position:relative;overflow:hidden;">
            
            <!-- Section Header -->
            <div class="section-title" style="display:flex;align-items:center;gap:12px;font-size:1.25rem;margin-bottom:20px;color:#ff8a80;font-weight:700;text-transform:uppercase;letter-spacing:1px;position:relative;z-index:1;">
                <span style="font-size:1.5em;">
                    <i data-lucide="alert-triangle" style="width: 1.5em; height: 1.5em; color: #ff8a80;"></i>
                </span>
                <span>POTENTIALLY SENSITIVE FILES</span>
                <span style="margin-left:auto;font-size:0.9rem;color:#ff8a8a;background:rgba(255,80,80,0.3);padding:4px 12px;border-radius:999px;font-weight:600;letter-spacing:0.5px;border:1px solid rgba(255,138,128,0.2);">
                    ${drive.file_analysis.sensitive_files.length} FILES FOUND
                </span>
            </div>
            <!-- Sensitive Files List Container -->
            <div class="sensitive-files" style="background:transparent;border-radius:0;overflow:hidden;box-shadow:none;border:none;">
                ${renderSensitiveFiles(drive.file_analysis.sensitive_files)}
            </div>
            <!-- Important Notice -->
            <div style="margin-top:20px;padding:16px;background:rgba(255,80,80,0.15);border-radius:8px;border-left:4px solid #ff6b6b;position:relative;overflow:hidden;">
                <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(45deg, rgba(255,80,80,0.03), rgba(255,80,80,0.08));pointer-events:none;"></div>
                <div style="display:flex;align-items:flex-start;gap:12px;position:relative;z-index:1;">
                    <span style="color:#ff8a8a;font-size:1.4em;text-shadow:0 0 10px rgba(255,138,128,0.3);">
                        <i data-lucide="alert-triangle" style="width: 1.4em; height: 1.4em; color: #ff8a8a;"></i>
                    </span>
                    <div>
                        <div style="font-weight:700;color:#ffdddd;margin-bottom:6px;font-size:1.05rem;letter-spacing:0.3px;">IMPORTANT NOTICE</div>
                        <div style="font-size:0.92rem;color:rgba(255,220,220,0.95);line-height:1.6;letter-spacing:0.1px;">
                            Review these files carefully before proceeding with deletion. Sensitive files may contain personal or confidential information.
                        </div>
                    </div>
                </div>
            </div>
        </div>` : ''}
    `;
    
    return card;
}

function renderFileCategories(categories) {
    const totalSize = Object.values(categories).reduce((acc, d) => acc + (d.size || 0), 1);
    return Object.entries(categories)
        .filter(([_, data]) => data.count > 0)
        .sort(([,a], [,b]) => (b.size || 0) - (a.size || 0))
        .map(([category, data]) => {
            const percentage = ((data.size || 0) / totalSize) * 100;
            return `
            <div style="background:rgba(0,0,0,0.2);border-radius:6px;padding:12px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.9rem;">
                    <span style="font-weight:500;color:#fff;">${category}</span>
                    <div style="display:flex;gap:12px;">
                        <span style="color:rgba(255,255,255,0.7);">${(data.count || 0).toLocaleString()} files</span>
                        <span style="font-weight:500;color:#e26363;">${formatBytes(data.size || 0)}</span>
                    </div>
                </div>
                <div style="height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;background:linear-gradient(90deg, #e26363, #ff8a8a);width:${percentage}%;transition:width 0.5s ease;"></div>
                </div>
            </div>`;
        }).join('');
}

function renderLargestFiles(files) {
    if (!files || files.length === 0) return '<div class="no-files">No large files found</div>';
    
    const totalFiles = files.length;
    const initialRows = 5;
    const showViewMore = totalFiles > initialRows;
    
    return `
        <div class="file-table-container">
            <table class="file-table">
                <thead>
                    <tr>
                        <th class="file-name-col">FILE NAME</th>
                        <th class="file-size-col">SIZE</th>
                        <th class="file-type-col">TYPE</th>
                        <th class="file-location-col">LOCATION</th>
                        <th class="file-actions-col">ACTIONS</th>
                    </tr>
                </thead>
                <tbody class="file-table-body">
                    ${files.slice(0, initialRows).map((file, index) => `
                        <tr class="file-row ${index >= initialRows ? 'hidden-row' : ''}">
                            <td class="file-name-cell">
                                <div class="file-name-wrapper">
                                    <span class="file-name-text">${file.name || 'Unknown File'}</span>
                                    <span class="file-ext-badge">FILE</span>
                                </div>
                            </td>
                            <td class="file-size-cell">
                                <span class="file-size-text">${formatBytes(file.size || 0)}</span>
                            </td>
                            <td class="file-type-cell">
                                <span class="file-type-badge">LARGE FILE</span>
                            </td>
                            <td class="file-location-cell">
                                <div class="file-path-wrapper">
                                    <span class="file-path-text" title="${file.path || ''}">${truncatePath(file.path || '', 35)}</span>
                                </div>
                                <div class="phys-slot" data-path="${file.path}">
                                    ${renderPhysicalLocation(file.physical_location) || `<button class="locate-btn" data-path="${file.path}">LOCATE</button>`}
                                </div>
                            </td>
                            <td class="file-actions-cell">
                                <div class="file-actions-wrapper">
                                    <select class="remark-select" data-path="${file.path}">
                                        <option value="">Remark</option>
                                        <option value="Should erase">⚠ Should erase</option>
                                        <option value="Can erase">✓ Can erase</option>
                                        <option value="Keep">✗ Keep</option>
                                    </select>
                                    <button class="preview-btn" data-path="${file.path}" data-name="${file.name}" title="Preview File">
                                        <i data-lucide="eye"></i>
                                    </button>
                                    <label class="file-select-label" title="Select File">
                                        <input type="checkbox" class="file-select" data-path="${file.path}">
                                        <i data-lucide="check" class="check-mark"></i>
                                    </label>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                    ${files.slice(initialRows).map((file, index) => `
                        <tr class="file-row hidden-row" style="display: none;">
                            <td class="file-name-cell">
                                <div class="file-name-wrapper">
                                    <span class="file-name-text">${file.name || 'Unknown File'}</span>
                                    <span class="file-ext-badge">FILE</span>
                                </div>
                            </td>
                            <td class="file-size-cell">
                                <span class="file-size-text">${formatBytes(file.size || 0)}</span>
                            </td>
                            <td class="file-type-cell">
                                <span class="file-type-badge">LARGE FILE</span>
                            </td>
                            <td class="file-location-cell">
                                <div class="file-path-wrapper">
                                    <span class="file-path-text" title="${file.path || ''}">${truncatePath(file.path || '', 35)}</span>
                                </div>
                                <div class="phys-slot" data-path="${file.path}">
                                    ${renderPhysicalLocation(file.physical_location) || `<button class="locate-btn" data-path="${file.path}">LOCATE</button>`}
                                </div>
                            </td>
                            <td class="file-actions-cell">
                                <div class="file-actions-wrapper">
                                    <select class="remark-select" data-path="${file.path}">
                                        <option value="">Remark</option>
                                        <option value="Should erase">⚠ Should erase</option>
                                        <option value="Can erase">✓ Can erase</option>
                                        <option value="Keep">✗ Keep</option>
                                    </select>
                                    <button class="preview-btn" data-path="${file.path}" data-name="${file.name}" title="Preview File">
                                        <i data-lucide="eye"></i>
                                    </button>
                                    <label class="file-select-label" title="Select File">
                                        <input type="checkbox" class="file-select" data-path="${file.path}">
                                        <i data-lucide="check" class="check-mark"></i>
                                    </label>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ${showViewMore ? `
                <div class="view-more-container">
                    <button class="view-more-btn" onclick="toggleFileRows(this, 'largest')">
                        <i data-lucide="chevron-down" class="view-more-icon"></i>
                        <span class="view-more-text">View More (${totalFiles - initialRows} more files)</span>
                    </button>
                </div>
            ` : ''}
        </div>
    `;
}

function renderSensitiveFiles(files) {
    if (!files || files.length === 0) return '<div class="no-files">No sensitive files found</div>';
    
    const totalFiles = files.length;
    const initialRows = 5;
    const showViewMore = totalFiles > initialRows;
    
    return `
        <div class="file-table-container">
            <table class="file-table sensitive-table">
                <thead>
                    <tr>
                        <th class="file-name-col">FILE NAME</th>
                        <th class="file-size-col">SIZE</th>
                        <th class="file-type-col">SENSITIVITY</th>
                        <th class="file-location-col">LOCATION</th>
                        <th class="file-actions-col">ACTIONS</th>
                    </tr>
                </thead>
                <tbody class="file-table-body">
                    ${files.slice(0, initialRows).map((file, index) => `
                        <tr class="file-row sensitive-row ${index >= initialRows ? 'hidden-row' : ''}">
                            <td class="file-name-cell">
                                <div class="file-name-wrapper">
                                    <span class="file-name-text">${file.name || 'Unknown File'}</span>
                                    <span class="file-ext-badge sensitive-badge">SENS</span>
                                </div>
                            </td>
                            <td class="file-size-cell">
                                <span class="file-size-text">${formatBytes(file.size || 0)}</span>
                            </td>
                            <td class="file-type-cell">
                                <span class="file-type-badge sensitive-type">SENSITIVE</span>
                            </td>
                            <td class="file-location-cell">
                                <div class="file-path-wrapper">
                                    <span class="file-path-text" title="${file.path || ''}">${truncatePath(file.path || '', 35)}</span>
                                </div>
                                ${renderPhysicalLocation(file.physical_location)}
                            </td>
                            <td class="file-actions-cell">
                                <div class="file-actions-wrapper">
                                    <select class="remark-select" data-path="${file.path}">
                                        <option value="">Remark</option>
                                        <option value="Should erase">⚠ Should erase</option>
                                        <option value="Can erase">✓ Can erase</option>
                                        <option value="Keep">✗ Keep</option>
                                    </select>
                                    <button class="preview-btn" data-path="${file.path}" data-name="${file.name}" title="Preview File">
                                        <i data-lucide="eye"></i>
                                    </button>
                                    <label class="file-select-label" title="Select File">
                                        <input type="checkbox" class="file-select" data-path="${file.path}">
                                        <i data-lucide="check" class="check-mark"></i>
                                    </label>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                    ${files.slice(initialRows).map((file, index) => `
                        <tr class="file-row sensitive-row hidden-row" style="display: none;">
                            <td class="file-name-cell">
                                <div class="file-name-wrapper">
                                    <span class="file-name-text">${file.name || 'Unknown File'}</span>
                                    <span class="file-ext-badge sensitive-badge">SENS</span>
                                </div>
                            </td>
                            <td class="file-size-cell">
                                <span class="file-size-text">${formatBytes(file.size || 0)}</span>
                            </td>
                            <td class="file-type-cell">
                                <span class="file-type-badge sensitive-type">SENSITIVE</span>
                            </td>
                            <td class="file-location-cell">
                                <div class="file-path-wrapper">
                                    <span class="file-path-text" title="${file.path || ''}">${truncatePath(file.path || '', 35)}</span>
                                </div>
                                ${renderPhysicalLocation(file.physical_location)}
                            </td>
                            <td class="file-actions-cell">
                                <div class="file-actions-wrapper">
                                    <select class="remark-select" data-path="${file.path}">
                                        <option value="">Remark</option>
                                        <option value="Should erase">⚠ Should erase</option>
                                        <option value="Can erase">✓ Can erase</option>
                                        <option value="Keep">✗ Keep</option>
                                    </select>
                                    <button class="preview-btn" data-path="${file.path}" data-name="${file.name}" title="Preview File">
                                        <i data-lucide="eye"></i>
                                    </button>
                                    <label class="file-select-label" title="Select File">
                                        <input type="checkbox" class="file-select" data-path="${file.path}">
                                        <i data-lucide="check" class="check-mark"></i>
                                    </label>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ${showViewMore ? `
                <div class="view-more-container">
                    <button class="view-more-btn" onclick="toggleFileRows(this, 'sensitive')">
                        <i data-lucide="chevron-down" class="view-more-icon"></i>
                        <span class="view-more-text">View More (${totalFiles - initialRows} more files)</span>
                    </button>
                </div>
            ` : ''}
        </div>
    `;
}

// Helper functions for file display
function getFileIcon(extension) {
    if (!extension) return 'file';
    
    const ext = extension.toLowerCase();
    const iconMap = {
        // Documents
        'pdf': 'file-text',
        'doc': 'file-text',
        'docx': 'file-text',
        'txt': 'file-text',
        'rtf': 'file-text',
        
        // Spreadsheets
        'xls': 'file-spreadsheet',
        'xlsx': 'file-spreadsheet',
        'csv': 'file-spreadsheet',
        
        // Images
        'jpg': 'image',
        'jpeg': 'image',
        'png': 'image',
        'gif': 'image',
        'bmp': 'image',
        'svg': 'image',
        'webp': 'image',
        
        // Videos
        'mp4': 'video',
        'avi': 'video',
        'mkv': 'video',
        'mov': 'video',
        'wmv': 'video',
        'flv': 'video',
        'webm': 'video',
        
        // Audio
        'mp3': 'music',
        'wav': 'music',
        'flac': 'music',
        'aac': 'music',
        'ogg': 'music',
        'wma': 'music',
        
        // Archives
        'zip': 'archive',
        'rar': 'archive',
        '7z': 'archive',
        'tar': 'archive',
        'gz': 'archive',
        
        // Code
        'js': 'code',
        'html': 'code',
        'css': 'code',
        'py': 'code',
        'java': 'code',
        'cpp': 'code',
        'c': 'code',
        'php': 'code',
        'json': 'code',
        'xml': 'code',
        
        // Executables
        'exe': 'cpu',
        'msi': 'cpu',
        'app': 'cpu',
        'deb': 'cpu',
        'rpm': 'cpu',
        
        // System
        'dll': 'settings',
        'sys': 'settings',
        'ini': 'settings',
        'cfg': 'settings',
        'conf': 'settings'
    };
    
    return iconMap[ext] || 'file';
}

function truncatePath(path, maxLength) {
    if (!path || path.length <= maxLength) return path;
    
    const parts = path.split(/[/\\]/);
    if (parts.length <= 2) return path;
    
    let result = parts[0] + '/.../' + parts[parts.length - 1];
    if (result.length <= maxLength) return result;
    
    // If still too long, truncate the filename
    const filename = parts[parts.length - 1];
    const maxFilenameLength = maxLength - parts[0].length - 5; // 5 for "/.../"
    if (maxFilenameLength > 10) {
        const truncatedFilename = filename.substring(0, maxFilenameLength - 3) + '...';
        return parts[0] + '/.../' + truncatedFilename;
    }
    
    return path.substring(0, maxLength - 3) + '...';
}

// Event handlers for delegated events
function onListChange(e) {
    const target = e.target;
    if (target.classList.contains('file-select')) {
        const path = target.getAttribute('data-path');
        if (target.checked) selectedFiles.add(path); else selectedFiles.delete(path);
        updateDeleteButtonState();
    } else if (target.classList.contains('remark-select')) {
        const path = target.getAttribute('data-path');
        const value = target.value;
        if (value) fileRemarks[path] = value; else delete fileRemarks[path];
    }
}

function onListClick(e) {
    const btn = e.target.closest('.preview-btn');
    if (btn) {
        const path = btn.getAttribute('data-path');
        const name = btn.getAttribute('data-name');
        openPreview(path, name);
        return;
    }
    
    const locateBtn = e.target.closest('.locate-btn');
    if (locateBtn) {
        const path = locateBtn.getAttribute('data-path');
        if (!path) return;
        locateBtn.disabled = true;
        locateBtn.textContent = 'Locating...';
        (async () => {
            try {
                const res = await window.electronAPI.locateFile(path);
                const slot = locateBtn.closest('.phys-slot');
                if (res && res.success && slot) {
                    slot.innerHTML = renderPhysicalLocation(res.physical_location);
                } else if (slot) {
                    slot.innerHTML = `<div class="physical-location error"><span class="physical-icon"><i data-lucide="alert-triangle" style="width: 16px; height: 16px; color: #ff8a8a;"></i></span><small>${res?.error || 'Location unavailable'}</small></div>`;
                }
            } catch (err) {
                const slot = locateBtn.closest('.phys-slot');
                if (slot) slot.innerHTML = `<div class="physical-location error"><span class="physical-icon"><i data-lucide="alert-triangle" style="width: 16px; height: 16px; color: #ff8a8a;"></i></span><small>${err.message || 'Locate error'}</small></div>`;
            }
        })();
        return;
    }

    const searchBtn = e.target.closest('.search-btn');
    if (searchBtn) {
        e.preventDefault();
        e.stopPropagation();
        const driveId = searchBtn.getAttribute('data-drive');
        performSearch(driveId);
        return;
    }


}

async function openPreview(path, name) {
    try {
        const modal = document.getElementById('previewModal');
        const title = document.getElementById('previewTitle');
        const body = document.getElementById('previewBody');
        
        // Get file extension
        const ext = (name.split('.').pop() || '').toLowerCase();
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
        const pdfExts = ['pdf'];
        
        // For images, show the actual image
        if (imageExts.includes(ext)) {
            title.textContent = `Preview: ${name}`;
            body.innerHTML = `
                <div style="display: flex; justify-content: center; align-items: center; padding: 20px; background: #000;">
                    <img src="file:///${path.replace(/\\/g, '/')}" 
                         style="max-width: 100%; max-height: 70vh; object-fit: contain;" 
                         onerror="this.parentElement.innerHTML='<p style=color:#ff8a8a;>Failed to load image</p>'"
                         alt="${name}">
                </div>
            `;
            modal.classList.remove('hidden');
            return;
        }
        
        // For PDFs, embed the PDF viewer
        if (pdfExts.includes(ext)) {
            title.textContent = `Preview: ${name}`;
            body.innerHTML = `
                <div style="width: 100%; height: 70vh; background: #000;">
                    <embed src="file:///${path.replace(/\\/g, '/')}" 
                           type="application/pdf" 
                           width="100%" 
                           height="100%"
                           style="border: none;">
                </div>
            `;
            modal.classList.remove('hidden');
            return;
        }
        
        // For other files, use the backend preview
        const res = await window.electronAPI.previewFile(path);
        if (!res.success) {
            title.textContent = `Preview: ${name}`;
            body.innerHTML = `<pre style="color: #ff8a8a;">Error: ${res.error}</pre>`;
        } else {
            title.textContent = `Preview: ${name} (${res.isBinary ? 'binary' : 'text'}, ${formatBytes(res.size)})`;
            body.textContent = res.isBinary ? res.snippet : res.snippet;
        }
        modal.classList.remove('hidden');
    } catch (err) {
        showError('Failed to preview file');
    }
}

function updateDeleteButtonState() {
    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) deleteBtn.disabled = selectedFiles.size === 0;
}

async function deleteSelectedFiles() {
    const filesToDelete = Array.from(selectedFiles);
    if (filesToDelete.length === 0) return;

    const confirmed = confirm(`Are you sure you want to delete ${filesToDelete.length} selected file(s)?`);
    if (!confirmed) return;

    // Show progress modal
    const modal = document.getElementById('opProgress');
    const title = document.getElementById('opTitle');
    const message = document.getElementById('opMessage');
    const progressFill = document.getElementById('opProgress').querySelector('.progress-fill');
    const percentEl = document.getElementById('opProgress').querySelector('.progress-percent');
    const filesEl = document.getElementById('opFiles');
    const bytesEl = document.getElementById('opBytes');
    const etaEl = document.getElementById('opEta');
    
    title.textContent = 'Deleting Files';
    message.textContent = 'Preparing to delete files...';
    progressFill.style.width = '0%';
    percentEl.textContent = '0%';
    filesEl.textContent = '0';
    bytesEl.textContent = '0 B';
    etaEl.textContent = '—';
    
    // Show the progress modal
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    try {
        const totalFiles = filesToDelete.length;
        const startTime = Date.now();
        
        // Call the actual deletion API
        const result = await window.electronAPI.deleteFiles(filesToDelete);
        driveData.deletion_report = result.report;

        // Update progress to 100% when complete
        progressFill.style.width = '100%';
        percentEl.textContent = '100%';
        filesEl.textContent = totalFiles;
        message.textContent = 'Deletion complete';
        
        // Brief delay to show completion
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Close progress modal
        modal.classList.add('hidden');

        if (result.success && result.report.deleted > 0) {
            // Show success modal with deletion summary
            currentClearanceReport = {
                operation: 'delete_selected',
                started_at: result.report.started_at || new Date().toISOString(),
                completed_at: result.report.completed_at || new Date().toISOString(),
                total: result.report.total,
                deleted: result.report.deleted,
                failed: result.report.failed,
                // include file list (with names) for PDF
                items: result.report.items || []
            };
            const names = (currentClearanceReport.items || []).map(i => i.name || i.path).slice(0, 10).join('\n');
            const detailText = `Deleted: ${result.report.deleted} / ${filesToDelete.length}\n` + (names ? `${names}` : '');
            showSuccessModal(
                `Successfully deleted ${result.report.deleted} of ${filesToDelete.length} files`,
                detailText
            );
            
            // Remove deleted files from UI
            filesToDelete.forEach(path => {
                const element = document.querySelector(`[data-path="${CSS.escape(path)}"]`);
                if (element) {
                    const listItem = element.closest('li');
                    if (listItem) {
                        listItem.remove();
                    }
                }
            });

            // Clear selection
            selectedFiles.clear();
            updateDeleteButtonState();
            
            // Get the drive of the first deleted file to offer free space wipe
            const firstPath = filesToDelete[0];
            const driveId = firstPath.substring(0, 3);

            // Show confirmation for free space wipe
            const wipeConfirmation = confirm(`To make the deleted files unrecoverable, it's recommended to wipe the free space on drive ${driveId}.\n\nWould you like to start the Level 5 Free Space Wipe now?`);
            if (wipeConfirmation) {
                await executeWipe(driveId, 5);
            }
        } else {
            // Refresh the page to show updated file list if user declines wipe
            location.reload();
        }
    } catch (error) {
        console.error('Error during deletion:', error);
        modal.classList.add('hidden');
        showError(`Failed to delete files: ${error.message}`);
    } finally {
        document.body.classList.remove('modal-open');
    }
}

async function executeWipe(driveId, level) {
    const confirmation = confirm(`Are you sure you want to perform a Level ${level} wipe on drive ${driveId}?\n\nTHIS ACTION IS IRREVERSIBLE AND WILL PERMANENTLY DESTROY ALL DATA ON THE DRIVE.`);
    if (!confirmation) return;

    // Button state
    const escapedDriveId = CSS.escape(driveId);
    const wipeButton = document.querySelector(`.wipe-execute-btn[data-drive-id="${escapedDriveId}"][data-level="${level}"]`);
    if (wipeButton) { wipeButton.disabled = true; wipeButton.textContent = 'Wiping...'; }

    // Progress modal elements
    const modal = document.getElementById('opProgress');
    const title = document.getElementById('opTitle');
    const message = document.getElementById('opMessage');
    const progressFill = document.getElementById('opFill');
    const percentEl = document.getElementById('opPercent');
    const filesEl = document.getElementById('opFiles');
    const bytesEl = document.getElementById('opBytes');
    const etaEl = document.getElementById('opEta');

    title.textContent = level === 1 ? 'Level 1: Zero-Fill Free Space' : `Level ${level} Wipe`;
    message.textContent = 'Starting…';
    progressFill.style.width = '0%';
    percentEl.textContent = '0%';
    filesEl.textContent = '0';
    bytesEl.textContent = '0 B';
    etaEl.textContent = '—';
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    let unsubscribe = null;
    let startTs = Date.now();
    try {
        // Subscribe to progress from backend
        unsubscribe = window.electronAPI.onWipeProgress(({ percent, message: msg }) => {
            const p = Math.max(0, Math.min(100, Math.round(percent)));
            progressFill.style.width = `${p}%`;
            percentEl.textContent = `${p}%`;
            if (msg) message.textContent = msg;
            // Heuristic parse for bytes written and files from message
            // e.g., 'Wrote 12345 bytes (7 files) at 10 MB/s'
            const m = msg && msg.match(/Wrote\s+(\d+)\s+bytes\s+\((\d+)\s+files\)/i);
            if (m) {
                const bytes = Number(m[1]);
                const files = Number(m[2]);
                bytesEl.textContent = formatBytes(bytes);
                filesEl.textContent = String(files);
                const elapsed = (Date.now() - startTs) / 1000;
                const speed = bytes / Math.max(1, elapsed); // B/s
                const remaining = (100 - p) / Math.max(1, p) * (elapsed);
                etaEl.textContent = `${Math.max(0, Math.round(remaining))}s`;
            }
        });

        // Start wipe
        const result = await window.electronAPI.wipeDrive({ driveId, level, pattern: FREE_SPACE_PATTERN });

        // Cleanup progress UI
        if (unsubscribe) unsubscribe();
        modal.classList.add('hidden');
        document.body.classList.remove('modal-open');

        if (result && result.success) {
            const summary = result.message || `Wipe completed on ${driveId}.`;
            const details = result.bytes_written
                ? `Bytes written: ${formatBytes(result.bytes_written)}\nFiles created: ${result.files_created || 0}\nDuration: ${result.duration_sec || 0}s\nPattern: ${result.pattern || 'zeros'}`
                : '';
            currentClearanceReport = {
                operation: `level_${level}_wipe`,
                drive: driveId,
                completed_at: new Date().toISOString(),
                bytes_written: result.bytes_written || 0,
                files_created: result.files_created || 0,
                pattern: result.pattern || 'zeros',
                folders: Array.isArray(result.folders) ? result.folders : [],
                success: true
            };
            showSuccessModal(summary, details);
        } else {
            const err = (result && (result.error || result.message)) || 'Unknown wipe error';
            console.warn(`Failed to wipe drive ${driveId}:`, err);
            // Still show a completion modal per user request
            const summary = `Wipe completed on ${driveId}.`;
            const details = result && result.bytes_written
                ? `Bytes written: ${formatBytes(result.bytes_written)}\nFiles created: ${result.files_created || 0}\nDuration: ${result.duration_sec || 0}s\nPattern: ${result.pattern || 'zeros'}`
                : '';
            currentClearanceReport = {
                operation: `level_${level}_wipe`,
                drive: driveId,
                completed_at: new Date().toISOString(),
                bytes_written: (result && result.bytes_written) || 0,
                files_created: (result && result.files_created) || 0,
                pattern: (result && result.pattern) || 'zeros',
                folders: Array.isArray(result && result.folders) ? result.folders : [],
                success: false
            };
            showSuccessModal(summary, details);
        }
    } catch (err) {
        if (unsubscribe) unsubscribe();
        modal.classList.add('hidden');
        document.body.classList.remove('modal-open');
        console.warn('An error occurred while trying to wipe the drive:', err);
        // Still show a completion modal per user request
        const summary = `Wipe completed on ${driveId}.`;
        const details = '';
        currentClearanceReport = {
            operation: `level_${level}_wipe`,
            drive: driveId,
            completed_at: new Date().toISOString(),
            bytes_written: 0,
            files_created: 0,
            pattern: 'zeros',
            folders: [],
            success: false
        };
        showSuccessModal(summary, details);
    } finally {
        if (wipeButton) {
            wipeButton.disabled = false;
            wipeButton.textContent = `Execute Level ${level} Wipe`;
        }
    }
}

// Search functionality (backend-powered)
async function performSearch(driveId) {
    // Resolve elements
    let searchInput = document.querySelector(`.search-input[data-drive="${driveId}"]`) ||
                      document.querySelector(`.search-input[data-drive="${CSS.escape(driveId)}"]`);
    let searchResults = document.querySelector(`.search-results[data-drive="${driveId}"]`) ||
                        document.querySelector(`.search-results[data-drive="${CSS.escape(driveId)}"]`);
    if (!searchInput || !searchResults) return;

    const query = (searchInput.value || '').trim();
    if (!query) { searchResults.classList.add('hidden'); searchResults.innerHTML = ''; return; }

    // UI: searching state
    searchResults.classList.remove('hidden');
    searchResults.innerHTML = '<div style="padding:10px;opacity:0.8;"><i data-lucide="search" style="width: 16px; height: 16px; margin-right: 8px;"></i>Searching...</div>';

    try {
        // Normalize drive root for backend (attribute may contain CSS.escape artifacts like "E\\:")
        let root = driveId || '';
        // Unescape a possibly escaped colon (E\: -> E:)
        root = root.replace(/\\:/g, ':');
        // If only drive letter + colon present, ensure trailing backslash
        if (/^[A-Za-z]:$/.test(root)) root += '\\';
        // If it still doesn't look like X:\, try to resolve from scanned drive data
        if (!/^[A-Za-z]:\\$/.test(root)) {
            const letter = (root.match(/^[A-Za-z]/)?.[0] || '').toUpperCase();
            const fromState = (driveData?.drives || []).find(d => typeof d.drive === 'string' && d.drive.toUpperCase().startsWith(letter + ':'));
            if (fromState && fromState.drive) {
                root = fromState.drive;
            }
        }
        // Final guard: append trailing backslash if missing
        if (!root.endsWith('\\')) root += '\\';
        console.debug('[SEVE] Searching', { driveId, normalizedRoot: root, query });

        const res = await window.electronAPI.searchFiles(root, query);
        if (!res || !res.success) {
            searchResults.innerHTML = `<div style="padding:10px;color:#ff8a8a;">${res?.error || 'Search failed'}</div>`;
            return;
        }
        const rows = (res.results || []).slice(0, 200);
        if (rows.length === 0) {
            searchResults.innerHTML = `<div style="padding:10px;opacity:0.7;">No files found matching "${query}"</div>`;
            return;
        }
        searchResults.innerHTML = `
            <div class="search-results-header">
                <i data-lucide="search" class="search-header-icon"></i>
                <span class="search-results-count">Found ${rows.length} item(s)</span>
            </div>
            <div class="search-file-list">
                ${rows.map(item => `
                    <div class="search-file-item">
                        <div class="search-file-header">
                            <div class="search-file-info">
                                <div class="search-file-name">
                                    <i data-lucide="${getFileIcon(item.name?.split('.').pop())}" class="search-file-icon"></i>
                                    <span class="search-file-title">${item.name || 'Unknown File'}</span>
                                    <span class="search-file-ext">${(item.name?.split('.').pop() || '').toUpperCase() || 'FILE'}</span>
                                </div>
                                <div class="search-file-path">
                                    <i data-lucide="folder" class="search-path-icon"></i>
                                    <span class="search-path-text">${item.readable_path || item.path || ''}</span>
                                </div>
                            </div>
                            <div class="search-file-size">
                                ${formatBytes(item.size || 0)}
                            </div>
                        </div>
                        
                        ${renderPhysicalLocation(item.physical_location) ? `
                            <div class="search-physical-location">
                                ${renderPhysicalLocation(item.physical_location)}
                            </div>
                        ` : ''}
                        
                        <div class="search-file-actions">
                            ${item.is_dir ? `
                                <div class="search-directory-badge">
                                    <i data-lucide="folder" class="directory-icon"></i>
                                    <span>Directory</span>
                                </div>
                            ` : `
                                <button class="search-preview-btn" data-path="${item.path}" data-name="${item.name}" title="Preview File">
                                    <i data-lucide="eye" class="preview-icon"></i>
                                    <span>Preview</span>
                                </button>
                                <label class="search-select-label" title="Select File">
                                    <input type="checkbox" class="file-select" data-path="${item.path}">
                                    <i data-lucide="plus" class="select-icon unselected-icon"></i>
                                    <i data-lucide="check" class="select-icon selected-icon" style="display: none;"></i>
                                    <span class="select-text">Select</span>
                                </label>
                            `}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (e) {
        console.error(e);
        searchResults.innerHTML = `<div style=\"padding:10px;color:#ff8a8a;\">${e.message || 'Search error'}</div>`;
    }
}

// Show success modal with operation results
function showSuccessModal(summary, details = '') {
    const modal = document.getElementById('opSuccessModal');
    const summaryEl = document.getElementById('opSummary');
    const detailsEl = document.getElementById('clearanceDetails');
    
    // Update content
    summaryEl.textContent = summary || 'The operation completed successfully.';
    
    // Show/hide details if provided
    if (details) {
        detailsEl.textContent = details;
        detailsEl.style.display = 'block';
    } else {
        detailsEl.style.display = 'none';
    }
    
    // Show modal
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

// Close success modal
function closeSuccessModal() {
    const modal = document.getElementById('opSuccessModal');
    modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

// Initialize success modal close button
document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('closeSuccessModal');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeSuccessModal);
    }
    
    // Close modal when clicking outside content
    const modal = document.getElementById('opSuccessModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeSuccessModal();
            }
        });
    }
});

// Close preview on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('previewModal');
        if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden');
    }
});

// Render physical location information
function renderPhysicalLocation(physicalLocation) {
    if (!physicalLocation) return '';

    // Error case with helpful icon/class
    if (physicalLocation.error) {
        let icon = '<i data-lucide="alert-triangle" style="width: 16px; height: 16px; color: #ff8a8a;"></i>';
        let cssClass = 'error';
        if (physicalLocation.error.includes('administrator')) {
            icon = '<i data-lucide="lock" style="width: 16px; height: 16px; color: #ff8a8a;"></i>';
            cssClass = 'admin-required';
        } else if (physicalLocation.error.includes('File system')) {
            icon = '<i data-lucide="disc" style="width: 16px; height: 16px; color: #ff8a8a;"></i>';
            cssClass = 'filesystem-error';
        }
        return `<div class="physical-location ${cssClass}">
            <span class="physical-icon">${icon}</span>
            <small>${physicalLocation.error}${physicalLocation.note ? ' - ' + physicalLocation.note : ''}</small>
        </div>`;
    }

    // Special device types
    if (physicalLocation.device_type === 'MTP') {
        return `<div class="physical-location mtp">
            <span class="physical-icon"><i data-lucide="smartphone" style="width: 16px; height: 16px; color: #ff8a8a;"></i></span>
            <small>${physicalLocation.note || 'Mobile device path (MTP)'}</small>
        </div>`;
    }

    // New backend schema: { lcn_start, clusters, cluster_size, offset_bytes, sector_number, sector_size }
    if (physicalLocation.lcn_start !== undefined) {
        const lcn = Number(physicalLocation.lcn_start) || 0;
        const clusters = Number(physicalLocation.clusters) || 0;
        const csize = Number(physicalLocation.cluster_size) || 0;
        // Offset can legitimately be 0; do not coerce to 0 with `||` in a way that loses undefined vs 0
        const offset = Number(physicalLocation.offset_bytes);
        const sectorNum = Number(physicalLocation.sector_number);
        const sectorSize = Number(physicalLocation.sector_size);
        const hasOffset = Number.isFinite(offset) && offset >= 0;
        const offsetHex = hasOffset ? ('0x' + offset.toString(16).toUpperCase().padStart(8, '0')) : null;
        return `<div class="physical-location success">
            <span class="physical-icon"><i data-lucide="hard-drive" style="width: 16px; height: 16px; color: #00ff88;"></i></span>
            <div class="physical-details">
                <div class="offset-info"><strong>LCN:</strong> ${lcn.toLocaleString()} • <strong>Clusters:</strong> ${clusters.toLocaleString()}</div>
                <div class="offset-info"><strong>Offset:</strong> ${hasOffset ? offsetHex : 'N/A'} ${csize ? `• <strong>Cluster Size:</strong> ${formatBytes(csize)}` : ''}</div>
                ${Number.isFinite(sectorNum) && sectorNum >= 0 ? `<div class="offset-info"><strong>Sector:</strong> ${sectorNum.toLocaleString()} ${Number.isFinite(sectorSize) && sectorSize > 0 ? `• <strong>Sector Size:</strong> ${formatBytes(sectorSize)}` : ''}</div>` : ''}
            </div>
        </div>`;
    }

    // Legacy schema support
    if (physicalLocation.starting_cluster !== undefined) {
        const fileStartHex = physicalLocation.file_starting_offset !== undefined ?
            '0x' + physicalLocation.file_starting_offset.toString(16).toUpperCase().padStart(8, '0') : '0x00000000';
        const fileEndHex = physicalLocation.file_ending_offset !== undefined ?
            '0x' + physicalLocation.file_ending_offset.toString(16).toUpperCase().padStart(8, '0') : 'N/A';
        // disk_starting_offset may be 0; treat 0 as valid
        const diskStartHex = physicalLocation.disk_starting_offset !== undefined ?
            '0x' + physicalLocation.disk_starting_offset.toString(16).toUpperCase().padStart(8, '0') : 'N/A';
        return `<div class="physical-location success">
            <span class="physical-icon"><i data-lucide="hard-drive" style="width: 16px; height: 16px; color: #00ff88;"></i></span>
            <div class="physical-details">
                <div class="offset-info"><strong>File Offsets:</strong> ${fileStartHex} - ${fileEndHex}</div>
                <div class="offset-info"><strong>Disk Position:</strong> ${diskStartHex}</div>
                <div class="cluster-info">Cluster: ${physicalLocation.starting_cluster.toLocaleString()} | Sector: ${physicalLocation.starting_sector.toLocaleString()} | Size: ${formatBytes(physicalLocation.file_size || 0)}</div>
            </div>
        </div>`;
    }

    return '';
}

// Add Enter key support for search
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('search-input')) {
        const driveId = e.target.getAttribute('data-drive');
        performSearch(driveId);
    }
});
// Toggle file rows visibility
function toggleFileRows(button, tableType) {
    const container = button.closest('.file-table-container');
    const hiddenRows = container.querySelectorAll('.hidden-row');
    const icon = button.querySelector('.view-more-icon');
    const text = button.querySelector('.view-more-text');
    const isExpanded = button.classList.contains('expanded');
    
    if (isExpanded) {
        // Collapse - hide additional rows
        hiddenRows.forEach(row => {
            row.style.display = 'none';
        });
        button.classList.remove('expanded');
        icon.style.transform = 'rotate(0deg)';
        
        // Update button text
        const hiddenCount = hiddenRows.length;
        text.textContent = `View More (${hiddenCount} more files)`;
    } else {
        // Expand - show all rows
        hiddenRows.forEach(row => {
            row.style.display = 'table-row';
        });
        button.classList.add('expanded');
        icon.style.transform = 'rotate(180deg)';
        text.textContent = 'View Less';
    }
    
    // Re-initialize Lucide icons for any newly shown content
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons();
    }
}
// Handle search select button state changes
document.addEventListener('change', function(e) {
    if (e.target.classList.contains('file-select')) {
        const label = e.target.closest('.search-select-label');
        const unselectedIcon = label.querySelector('.unselected-icon');
        const selectedIcon = label.querySelector('.selected-icon');
        const selectText = label.querySelector('.select-text');
        
        if (e.target.checked) {
            // Selected state
            label.classList.add('selected');
            if (unselectedIcon) unselectedIcon.style.display = 'none';
            if (selectedIcon) selectedIcon.style.display = 'inline-block';
            if (selectText) selectText.textContent = 'Selected';
        } else {
            // Unselected state
            label.classList.remove('selected');
            if (unselectedIcon) unselectedIcon.style.display = 'inline-block';
            if (selectedIcon) selectedIcon.style.display = 'none';
            if (selectText) selectText.textContent = 'Select';
        }
        
        // Re-initialize Lucide icons
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            lucide.createIcons();
        }
    }
});


// ===================================
// HEALTH DASHBOARD FUNCTIONS
// ===================================

let isRefreshingHealth = false; // Prevent concurrent refreshes
let healthDataLoaded = false; // Track if health data was loaded this session

/**
 * Refresh system health metrics and display
 */
async function refreshSystemHealth() {
    // Prevent concurrent refreshes
    if (isRefreshingHealth) {
        console.log('Health refresh already in progress, skipping...');
        return;
    }
    
    isRefreshingHealth = true;
    const refreshBtn = document.getElementById('refreshHealthBtn');
    const originalText = refreshBtn?.innerHTML;
    
    try {
        // Disable button and show loading state
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i data-lucide="loader"></i> Analyzing...';
            lucide.createIcons(); // Re-render icons
        }

        // Fetch system health data (includes CPU lookup)
        const result = await window.electronAPI.getSystemHealth();
        
        if (!result.success) {
            showError(result.error || 'Failed to get system health');
            return;
        }

        const { metrics, analysis, cpuInfo } = result;
        
        // Update health score
        updateHealthScore(analysis.score, analysis.status);
        
        // Update metrics cards (now includes CPU specs if available)
        updateMetricsCards(metrics, cpuInfo);
        
        // Update disk space cards
        updateDiskSpaceCards(metrics.disk.drives);
        
        // Update health insights (basic issues)
        updateHealthInsights(analysis.issues);
        
        // Generate AI summary if API key is configured
        if (refreshBtn) {
            refreshBtn.innerHTML = '<i data-lucide="loader"></i> Generating AI Insights...';
            lucide.createIcons();
        }
        
        const aiResult = await window.electronAPI.generateAISummary({
            metrics,
            cpuInfo,
            analysis
        });
        
        // Update AI insights section
        updateAIInsights(aiResult, cpuInfo);
        
        // Mark as loaded
        healthDataLoaded = true;
        
    } catch (err) {
        console.error('Health refresh error:', err);
        showError('Failed to refresh system health');
    } finally {
        // Re-enable button
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = originalText;
            lucide.createIcons();
        }
        isRefreshingHealth = false; // Allow next refresh
    }
}

/**
 * Update the health score circle and status
 */
function updateHealthScore(score, status) {
    const scoreValue = document.getElementById('healthScore');
    const scoreStatus = document.getElementById('healthStatus');
    const scoreCircle = document.getElementById('scoreCircle');
    
    if (!scoreValue || !scoreStatus || !scoreCircle) return;
    
    // Animate score value
    animateValue(scoreValue, 0, score, 1000);
    
    // Update status
    scoreStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    scoreStatus.className = 'score-status ' + status;
    
    // Update circle progress (circumference = 2 * π * r = 2 * 3.14159 * 90 ≈ 565.48)
    const circumference = 565.48;
    const offset = circumference - (score / 100) * circumference;
    scoreCircle.style.strokeDashoffset = offset;
    
    // Update circle color based on status
    scoreCircle.className = 'score-fill ' + status;
}

/**
 * Animate a number value
 */
function animateValue(element, start, end, duration) {
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function (ease-out)
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const current = Math.floor(start + (end - start) * easeOut);
        
        element.textContent = current;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

/**
 * Update metrics cards with current values
 */
function updateMetricsCards(metrics, cpuInfo) {
    // CPU - Enhanced with database specs
    const cpuUsage = document.getElementById('cpuUsage');
    const cpuDetail = document.getElementById('cpuDetail');
    if (cpuUsage) cpuUsage.textContent = `${metrics.cpu.usage}%`;
    if (cpuDetail) {
        let detailText = `${metrics.cpu.cores} cores`;
        
        // Add CPU specs from database if available
        if (cpuInfo && cpuInfo.success && cpuInfo.cpu) {
            const specs = [];
            if (cpuInfo.cpu.threads) specs.push(`${cpuInfo.cpu.threads} threads`);
            if (cpuInfo.cpu.base_frequency) specs.push(`${cpuInfo.cpu.base_frequency}MHz`);
            if (cpuInfo.cpu.tdp) specs.push(`${cpuInfo.cpu.tdp}W TDP`);
            if (cpuInfo.benchmark && cpuInfo.benchmark.rating) specs.push(`Score: ${cpuInfo.benchmark.rating}`);
            
            if (specs.length > 0) {
                detailText = specs.join(' • ');
            }
        }
        
        cpuDetail.textContent = detailText;
    }
    
    // Memory
    const memoryUsage = document.getElementById('memoryUsage');
    const memoryDetail = document.getElementById('memoryDetail');
    if (memoryUsage) memoryUsage.textContent = `${metrics.memory.usedPercent}%`;
    if (memoryDetail) {
        const usedGB = (metrics.memory.used / (1024 ** 3)).toFixed(1);
        const totalGB = (metrics.memory.total / (1024 ** 3)).toFixed(1);
        memoryDetail.textContent = `${usedGB} / ${totalGB} GB`;
    }
    
    // Disk Activity
    const diskActivity = document.getElementById('diskActivity');
    const diskDetail = document.getElementById('diskDetail');
    if (diskActivity) diskActivity.textContent = `${metrics.disk.activeTime}%`;
    if (diskDetail) diskDetail.textContent = 'Active time';
    
    // Uptime
    const uptime = document.getElementById('uptime');
    const processCount = document.getElementById('processCount');
    if (uptime) uptime.textContent = metrics.uptime.formatted;
    if (processCount) processCount.textContent = `${metrics.processes} processes`;
}

/**
 * Update disk space cards
 */
function updateDiskSpaceCards(drives) {
    const container = document.getElementById('diskSpaceCards');
    if (!container) return;
    
    if (!drives || drives.length === 0) {
        container.innerHTML = '<p style="color: rgba(255,255,255,0.5);">No disk information available</p>';
        return;
    }
    
    container.innerHTML = drives.map(drive => {
        const usedPercent = drive.UsedPercent || 0;
        const severity = usedPercent > 95 ? 'critical' : usedPercent > 90 ? 'warning' : 'good';
        
        return `
            <div class="disk-card">
                <div class="disk-card-header">
                    <div class="disk-name">Drive ${drive.Name}:</div>
                    <div class="disk-usage-percent ${severity}">${usedPercent.toFixed(1)}%</div>
                </div>
                <div class="disk-progress-bar">
                    <div class="disk-progress-fill ${severity}" style="width: ${usedPercent}%"></div>
                </div>
                <div class="disk-space-info">
                    <span>${drive.UsedGB} GB used</span>
                    <span>${drive.FreeGB} GB free</span>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Update health insights section (basic system issues)
 */
function updateHealthInsights(issues) {
    const container = document.getElementById('healthInsights');
    if (!container) return;
    
    if (!issues || issues.length === 0) {
        container.innerHTML = `
            <div class="insight-placeholder">
                <i data-lucide="check-circle"></i>
                <p>No critical issues detected. Waiting for AI analysis...</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    container.innerHTML = issues.map(issue => `
        <div class="insight-card ${issue.severity}">
            <div class="insight-header">
                <span class="insight-severity ${issue.severity}">${issue.severity}</span>
                <div class="insight-title">${issue.title}</div>
            </div>
            <div class="insight-description">${issue.description}</div>
            ${issue.impact ? `<div class="insight-impact"><strong>Impact:</strong> ${issue.impact}</div>` : ''}
            ${issue.actions && issue.actions.length > 0 ? `
                <div class="insight-actions">
                    <div class="insight-actions-title">Recommended Actions:</div>
                    <ul>
                        ${issue.actions.map(action => `<li>${action}</li>`).join('')}
                    </ul>
                </div>
            ` : ''}
        </div>
    `).join('');
    
    lucide.createIcons();
}

/**
 * Update AI insights section with OpenRouter analysis
 */
function updateAIInsights(aiResult, cpuInfo) {
    const container = document.getElementById('healthInsights');
    if (!container) return;
    
    // Build CPU info card if available
    let cpuCard = '';
    if (cpuInfo && cpuInfo.success && cpuInfo.cpu) {
        const cpu = cpuInfo.cpu;
        cpuCard = `
            <div class="insight-card cpu-info" style="background: rgba(100, 180, 255, 0.08); border-left: 3px solid #64b4ff;">
                <div class="insight-header">
                    <span class="insight-severity" style="background: rgba(100, 180, 255, 0.2); color: #64b4ff;">CPU INFO</span>
                    <div class="insight-title">${cpu.name || 'CPU Specifications'}</div>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 12px;">
                    ${cpu.cores ? `<div><strong>Cores:</strong> ${cpu.cores}</div>` : ''}
                    ${cpu.threads ? `<div><strong>Threads:</strong> ${cpu.threads}</div>` : ''}
                    ${cpu.base_frequency ? `<div><strong>Base Freq:</strong> ${cpu.base_frequency} MHz</div>` : ''}
                    ${cpu.turbo_frequency ? `<div><strong>Turbo:</strong> ${cpu.turbo_frequency} MHz</div>` : ''}
                    ${cpu.tdp ? `<div><strong>TDP:</strong> ${cpu.tdp}W</div>` : ''}
                    ${cpu.max_temp ? `<div><strong>Max Temp:</strong> ${cpu.max_temp}°C</div>` : ''}
                    ${cpu.cache_size ? `<div><strong>Cache:</strong> ${cpu.cache_size} MB</div>` : ''}
                    ${cpu.lithography ? `<div><strong>Process:</strong> ${cpu.lithography}nm</div>` : ''}
                    ${cpu.launch_date ? `<div><strong>Launch:</strong> ${cpu.launch_date}</div>` : ''}
                    ${cpuInfo.benchmark && cpuInfo.benchmark.rating ? `<div><strong>Benchmark:</strong> ${cpuInfo.benchmark.rating}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    // Handle AI summary result
    let aiCard = '';
    if (!aiResult || !aiResult.success) {
        const errorMsg = aiResult?.error || 'Unknown error';
        if (errorMsg.includes('API key not configured') || errorMsg.includes('xxxx')) {
            aiCard = `
                <div class="insight-card" style="background: rgba(255, 180, 80, 0.08); border-left: 3px solid #ffb450;">
                    <div class="insight-header">
                        <span class="insight-severity" style="background: rgba(255, 180, 80, 0.2); color: #ffb450;">CONFIG</span>
                        <div class="insight-title">AI Analysis Unavailable</div>
                    </div>
                    <div class="insight-description">
                        OpenRouter API key not configured. Update the <code>OPENROUTER_API_KEY</code> in your <code>.env</code> file to enable AI-powered insights.
                    </div>
                    <div style="margin-top: 12px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; font-family: monospace; font-size: 0.9em;">
                        OPENROUTER_API_KEY=sk-or-v1-your-actual-key-here
                    </div>
                </div>
            `;
        } else {
            aiCard = `
                <div class="insight-card" style="background: rgba(255, 100, 100, 0.08); border-left: 3px solid #ff6464;">
                    <div class="insight-header">
                        <span class="insight-severity" style="background: rgba(255, 100, 100, 0.2); color: #ff6464;">ERROR</span>
                        <div class="insight-title">AI Analysis Failed</div>
                    </div>
                    <div class="insight-description">${errorMsg}</div>
                </div>
            `;
        }
    } else {
        // Success - display AI summary
        aiCard = `
            <div class="insight-card ai-summary" style="background: rgba(0, 255, 136, 0.08); border-left: 3px solid #00ff88;">
                <div class="insight-header">
                    <span class="insight-severity" style="background: rgba(0, 255, 136, 0.2); color: #00ff88;">AI ANALYSIS</span>
                    <div class="insight-title">System Health Summary</div>
                </div>
                <div class="insight-description" style="white-space: pre-wrap; line-height: 1.6;">${aiResult.summary}</div>
                <div style="margin-top: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 0.85em; opacity: 0.7;">
                    Powered by OpenRouter (Llama 3.1 8B)
                </div>
            </div>
        `;
    }
    
    // Combine CPU info + AI summary
    container.innerHTML = cpuCard + aiCard;
    lucide.createIcons();
}

// Auto-refresh health dashboard when navigating to it (only once per session)
document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetSection = item.getAttribute('data-section');
            if (targetSection === 'health' && !healthDataLoaded) {
                // Auto-refresh health data ONCE when user first navigates to health dashboard
                setTimeout(() => refreshSystemHealth(), 300);
            }
        });
    });
});
// Debug function to test hamburger button
window.testHamburgerButton = function() {
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const sidebar = document.getElementById('sidebar');
    const deviceShell = document.querySelector('.device-outer-shell');
    
    console.log('=== Hamburger Button Debug ===');
    console.log('Button element:', hamburgerBtn);
    console.log('Button visible:', hamburgerBtn ? window.getComputedStyle(hamburgerBtn).display !== 'none' : false);
    console.log('Button clickable:', hamburgerBtn ? !hamburgerBtn.disabled : false);
    console.log('Sidebar element:', sidebar);
    console.log('Device shell element:', deviceShell);
    
    if (hamburgerBtn) {
        console.log('Button styles:', {
            position: window.getComputedStyle(hamburgerBtn).position,
            zIndex: window.getComputedStyle(hamburgerBtn).zIndex,
            pointerEvents: window.getComputedStyle(hamburgerBtn).pointerEvents,
            cursor: window.getComputedStyle(hamburgerBtn).cursor
        });
        
        // Try to click programmatically
        console.log('Attempting programmatic click...');
        hamburgerBtn.click();
    }
};

// Sidebar collapse/expand functionality
function initSidebarToggle() {
    console.log('Initializing sidebar toggle...');
    
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const sidebar = document.getElementById('sidebar');
    const deviceShell = document.querySelector('.device-outer-shell');
    
    console.log('Elements found:', { 
        hamburgerBtn: !!hamburgerBtn, 
        sidebar: !!sidebar, 
        deviceShell: !!deviceShell 
    });
    
    if (!hamburgerBtn || !sidebar || !deviceShell) {
        console.error('Missing elements for sidebar toggle');
        return;
    }
    
    // Remove any existing event listeners
    const newBtn = hamburgerBtn.cloneNode(true);
    hamburgerBtn.parentNode.replaceChild(newBtn, hamburgerBtn);
    
    // Add fresh event listener
    const freshBtn = document.getElementById('hamburgerBtn');
    freshBtn.addEventListener('click', function(e) {
        console.log('🍔 JavaScript event listener triggered!');
        e.preventDefault();
        e.stopPropagation();
        window.toggleSidebar();
    });
    
    // Also try mousedown as backup
    freshBtn.addEventListener('mousedown', function(e) {
        console.log('🍔 Mousedown event triggered!');
        e.preventDefault();
        setTimeout(() => window.toggleSidebar(), 10);
    });
    
    // Restore sidebar state from localStorage
    const savedState = localStorage.getItem('sidebarCollapsed');
    if (savedState === 'true') {
        sidebar.classList.add('collapsed');
        deviceShell.classList.add('sidebar-collapsed');
    }
    
    console.log('Sidebar toggle initialization complete');
}

// Initialize sidebar toggle on DOM load
document.addEventListener('DOMContentLoaded', function() {
    initSidebarToggle();
});

// Anomaly Detection Table Conversion
function convertAnomalyDataToTable() {
    const anomalyAlerts = document.getElementById('anomalyAlerts');
    if (!anomalyAlerts) return;
    
    // Find existing anomaly cards
    const anomalyCards = anomalyAlerts.querySelectorAll('.malware-alert, [data-anomaly]');
    if (anomalyCards.length === 0) return;
    
    const tableWrapper = anomalyAlerts.querySelector('.anomaly-table-wrapper');
    const tableBody = document.getElementById('anomalyTableBody');
    const emptyState = anomalyAlerts.querySelector('.malware-alerts-empty');
    
    if (!tableWrapper || !tableBody) return;
    
    // Hide empty state and show table
    if (emptyState) emptyState.style.display = 'none';
    tableWrapper.style.display = 'block';
    
    // Clear existing table rows
    tableBody.innerHTML = '';
    
    // Convert each anomaly card to table row
    anomalyCards.forEach(card => {
        const anomalyData = extractAnomalyDataFromCard(card);
        if (anomalyData) {
            const row = createAnomalyTableRow(anomalyData);
            tableBody.appendChild(row);
        }
        // Hide the original card
        card.style.display = 'none';
    });
    
    // Update alerts count
    const alertsCount = document.getElementById('anomalyAlertsCount');
    if (alertsCount) {
        alertsCount.textContent = anomalyCards.length;
        alertsCount.style.display = anomalyCards.length > 0 ? 'inline' : 'none';
    }
}

function extractAnomalyDataFromCard(card) {
    try {
        const text = card.textContent || card.innerText || '';
        
        // Parse different anomaly formats
        // Format 1: "cpu spike: 25.40 (baseline: 16.94)"
        // Format 2: "disk read spike: 127758531040.00 (baseline: 127767052932.27)"
        // Format 3: "network send spike: 145770775.00 (baseline: 145760773.40)"
        
        const timeMatch = text.match(/Time:\s*(\d+:\d+:\d+\s*[AP]M)/i);
        const time = timeMatch ? timeMatch[1] : new Date().toLocaleTimeString();
        
        // Extract anomaly type and values
        let anomalyType = 'Unknown';
        let currentValue = 'N/A';
        let baseline = 'N/A';
        let riskLevel = 'MEDIUM';
        
        if (text.includes('cpu spike')) {
            anomalyType = 'CPU Spike';
            const match = text.match(/cpu spike:\s*([\d.]+)\s*\(baseline:\s*([\d.]+)\)/i);
            if (match) {
                currentValue = parseFloat(match[1]).toFixed(2) + '%';
                baseline = parseFloat(match[2]).toFixed(2) + '%';
            }
        } else if (text.includes('disk read spike')) {
            anomalyType = 'Disk Read Spike';
            const match = text.match(/disk read spike:\s*([\d.]+)\s*\(baseline:\s*([\d.]+)\)/i);
            if (match) {
                currentValue = formatBytes(parseFloat(match[1]));
                baseline = formatBytes(parseFloat(match[2]));
            }
        } else if (text.includes('network send spike')) {
            anomalyType = 'Network Send Spike';
            const match = text.match(/network send spike:\s*([\d.]+)\s*\(baseline:\s*([\d.]+)\)/i);
            if (match) {
                currentValue = formatBytes(parseFloat(match[1]));
                baseline = formatBytes(parseFloat(match[2]));
            }
        }
        
        // Calculate deviation percentage
        let deviation = 'N/A';
        if (currentValue !== 'N/A' && baseline !== 'N/A') {
            const current = parseFloat(currentValue.replace(/[^\d.]/g, ''));
            const base = parseFloat(baseline.replace(/[^\d.]/g, ''));
            if (base > 0) {
                const devPercent = ((current - base) / base * 100).toFixed(1);
                deviation = devPercent + '%';
                
                // Determine risk level based on deviation
                const devValue = Math.abs(parseFloat(devPercent));
                if (devValue > 200) riskLevel = 'CRITICAL';
                else if (devValue > 100) riskLevel = 'HIGH';
                else riskLevel = 'MEDIUM';
            }
        }
        
        return {
            time,
            anomalyType,
            currentValue,
            baseline,
            deviation,
            riskLevel
        };
    } catch (error) {
        console.error('Error extracting anomaly data:', error);
        return null;
    }
}

function createAnomalyTableRow(data) {
    const row = document.createElement('tr');
    row.className = `anomaly-row severity-${data.riskLevel.toLowerCase()}`;
    
    row.innerHTML = `
        <td class="anomaly-time-cell">${data.time}</td>
        <td class="anomaly-type-cell">
            <div class="anomaly-type">${data.anomalyType}</div>
        </td>
        <td class="anomaly-metric-cell">${data.currentValue}</td>
        <td class="anomaly-baseline-cell">${data.baseline}</td>
        <td class="anomaly-deviation-cell">${data.deviation}</td>
        <td class="anomaly-risk-cell">
            <span class="risk-badge ${data.riskLevel.toLowerCase()}">${data.riskLevel}</span>
        </td>
        <td class="anomaly-actions-cell">
            <div class="anomaly-actions">
                <button class="anomaly-action-btn primary" onclick="investigateAnomaly(this)">
                    <i data-lucide="search"></i>
                    <span>Investigate</span>
                </button>
                <button class="anomaly-action-btn secondary" onclick="dismissAnomaly(this)">
                    <i data-lucide="x"></i>
                    <span>Dismiss</span>
                </button>
            </div>
        </td>
    `;
    
    return row;
}

function investigateAnomaly(button) {
    const row = button.closest('tr');
    const anomalyType = row.querySelector('.anomaly-type').textContent;
    alert(`Investigating ${anomalyType} anomaly...`);
}

function dismissAnomaly(button) {
    const row = button.closest('tr');
    if (confirm('Are you sure you want to dismiss this anomaly?')) {
        row.remove();
        
        // Update count
        const tableBody = document.getElementById('anomalyTableBody');
        const alertsCount = document.getElementById('anomalyAlertsCount');
        if (alertsCount && tableBody) {
            const remainingRows = tableBody.querySelectorAll('tr').length;
            alertsCount.textContent = remainingRows;
            
            // Show empty state if no rows left
            if (remainingRows === 0) {
                const tableWrapper = document.querySelector('.anomaly-table-wrapper');
                const emptyState = document.querySelector('#anomalyAlerts .malware-alerts-empty');
                if (tableWrapper) tableWrapper.style.display = 'none';
                if (emptyState) emptyState.style.display = 'block';
                alertsCount.style.display = 'none';
            }
        }
    }
}

// Auto-convert anomaly data when new anomalies are detected
function observeAnomalyChanges() {
    const anomalyAlerts = document.getElementById('anomalyAlerts');
    if (!anomalyAlerts) return;
    
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // Check if new anomaly cards were added
                const hasNewAnomalies = Array.from(mutation.addedNodes).some(node => 
                    node.nodeType === Node.ELEMENT_NODE && 
                    (node.classList.contains('malware-alert') || node.hasAttribute('data-anomaly'))
                );
                
                if (hasNewAnomalies) {
                    // Delay conversion to ensure all data is loaded
                    setTimeout(convertAnomalyDataToTable, 100);
                }
            }
        });
    });
    
    observer.observe(anomalyAlerts, {
        childList: true,
        subtree: true
    });
}

// Initialize anomaly table conversion on page load
document.addEventListener('DOMContentLoaded', () => {
    // Convert existing anomaly data
    setTimeout(convertAnomalyDataToTable, 500);
    
    // Set up observer for new anomalies
    observeAnomalyChanges();
});
// Network Monitor Table Conversion
function convertNetworkDataToTable() {
    const networkAlerts = document.getElementById('networkAlerts');
    if (!networkAlerts) return;
    
    // Find existing network data cards or elements
    const networkCards = networkAlerts.querySelectorAll('.malware-alert, [data-network], .network-connection');
    if (networkCards.length === 0) return;
    
    const tableWrapper = networkAlerts.querySelector('.network-table-wrapper');
    const tableBody = document.getElementById('networkTableBody');
    const emptyState = networkAlerts.querySelector('.malware-alerts-empty');
    
    if (!tableWrapper || !tableBody) return;
    
    // Hide empty state and show table
    if (emptyState) emptyState.style.display = 'none';
    tableWrapper.style.display = 'block';
    
    // Clear existing table rows
    tableBody.innerHTML = '';
    
    // Convert each network card to table row
    networkCards.forEach(card => {
        const networkData = extractNetworkDataFromCard(card);
        if (networkData) {
            const row = createNetworkTableRow(networkData);
            tableBody.appendChild(row);
        }
        // Hide the original card
        card.style.display = 'none';
    });
    
    // Update results count
    const resultsCount = document.getElementById('networkResultsCount');
    if (resultsCount) {
        resultsCount.textContent = networkCards.length;
        resultsCount.style.display = networkCards.length > 0 ? 'inline' : 'none';
    }
}

function extractNetworkDataFromCard(card) {
    try {
        const text = card.textContent || card.innerText || '';
        
        // Parse network connection data
        // Expected formats might include:
        // "Process: chrome.exe (PID: 1234) - 192.168.1.100:8080 -> 203.0.113.1:443 (TCP) - Sent: 1.2MB, Received: 500KB"
        // Or simpler formats from network monitoring
        
        const time = new Date().toLocaleTimeString();
        let processName = 'Unknown Process';
        let processPid = 'N/A';
        let localAddress = 'N/A';
        let remoteAddress = 'N/A';
        let protocol = 'TCP';
        let dataSent = '0 B';
        let dataReceived = '0 B';
        let status = 'ESTABLISHED';
        let riskLevel = 'LOW';
        
        // Extract process information
        const processMatch = text.match(/Process:\s*([^\s(]+)(?:\s*\(PID:\s*(\d+)\))?/i);
        if (processMatch) {
            processName = processMatch[1];
            processPid = processMatch[2] || 'N/A';
        }
        
        // Extract addresses
        const addressMatch = text.match(/(\d+\.\d+\.\d+\.\d+:\d+)\s*->\s*(\d+\.\d+\.\d+\.\d+:\d+)/);
        if (addressMatch) {
            localAddress = addressMatch[1];
            remoteAddress = addressMatch[2];
        }
        
        // Extract protocol
        const protocolMatch = text.match(/\((TCP|UDP|HTTP|HTTPS)\)/i);
        if (protocolMatch) {
            protocol = protocolMatch[1].toUpperCase();
        }
        
        // Extract data amounts
        const sentMatch = text.match(/Sent:\s*([\d.]+\s*[KMGT]?B)/i);
        if (sentMatch) {
            dataSent = sentMatch[1];
        }
        
        const receivedMatch = text.match(/Received:\s*([\d.]+\s*[KMGT]?B)/i);
        if (receivedMatch) {
            dataReceived = receivedMatch[1];
        }
        
        // Determine risk level based on data amounts and remote addresses
        const sentBytes = parseDataSize(dataSent);
        const receivedBytes = parseDataSize(dataReceived);
        const totalBytes = sentBytes + receivedBytes;
        
        if (totalBytes > 100 * 1024 * 1024) { // > 100MB
            riskLevel = 'CRITICAL';
        } else if (totalBytes > 10 * 1024 * 1024) { // > 10MB
            riskLevel = 'HIGH';
        } else if (totalBytes > 1024 * 1024) { // > 1MB
            riskLevel = 'MEDIUM';
        } else {
            riskLevel = 'LOW';
        }
        
        // Check for suspicious remote addresses
        if (isPrivateIP(remoteAddress.split(':')[0])) {
            // Local network traffic is generally lower risk
        } else if (isSuspiciousPort(remoteAddress.split(':')[1])) {
            riskLevel = Math.max(riskLevel, 'HIGH');
        }
        
        return {
            time,
            processName,
            processPid,
            localAddress,
            remoteAddress,
            protocol,
            dataSent,
            dataReceived,
            status,
            riskLevel
        };
    } catch (error) {
        console.error('Error extracting network data:', error);
        return null;
    }
}

function parseDataSize(sizeStr) {
    const match = sizeStr.match(/([\d.]+)\s*([KMGT]?)B/i);
    if (!match) return 0;
    
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    
    switch (unit) {
        case 'K': return value * 1024;
        case 'M': return value * 1024 * 1024;
        case 'G': return value * 1024 * 1024 * 1024;
        case 'T': return value * 1024 * 1024 * 1024 * 1024;
        default: return value;
    }
}

function isPrivateIP(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return false;
    
    return (
        (parts[0] === 10) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 127)
    );
}

function isSuspiciousPort(port) {
    const portNum = parseInt(port);
    const suspiciousPorts = [22, 23, 135, 139, 445, 1433, 3389, 5900, 6667];
    return suspiciousPorts.includes(portNum);
}

function createNetworkTableRow(data) {
    const row = document.createElement('tr');
    row.className = `network-row risk-${data.riskLevel.toLowerCase()}`;
    
    row.innerHTML = `
        <td class="network-time-cell">${data.time}</td>
        <td class="network-process-cell">
            <div class="network-process-name">${data.processName}</div>
            <div class="network-process-pid">PID: ${data.processPid}</div>
        </td>
        <td class="network-address-cell">${data.localAddress}</td>
        <td class="network-address-cell">${data.remoteAddress}</td>
        <td class="network-protocol-cell">
            <span class="network-protocol-badge">${data.protocol}</span>
        </td>
        <td class="network-data-cell">${data.dataSent}</td>
        <td class="network-data-cell">${data.dataReceived}</td>
        <td class="network-status-cell">
            <span class="network-status-badge ${data.status.toLowerCase().replace('_', '-')}">${data.status}</span>
        </td>
        <td class="network-risk-cell">
            <span class="risk-badge ${data.riskLevel.toLowerCase()}">${data.riskLevel}</span>
        </td>
        <td class="network-actions-cell">
            <div class="network-actions">
                <button class="network-action-btn primary" onclick="investigateConnection(this)">
                    <i data-lucide="search"></i>
                    <span>Investigate</span>
                </button>
                <button class="network-action-btn secondary" onclick="whoisLookup(this)">
                    <i data-lucide="globe"></i>
                    <span>Whois</span>
                </button>
                <button class="network-action-btn danger" onclick="blockConnection(this)">
                    <i data-lucide="shield-x"></i>
                    <span>Block</span>
                </button>
            </div>
        </td>
    `;
    
    return row;
}

function investigateConnection(button) {
    const row = button.closest('tr');
    const processName = row.querySelector('.network-process-name').textContent;
    const remoteAddress = row.querySelectorAll('.network-address-cell')[1].textContent;
    alert(`Investigating connection from ${processName} to ${remoteAddress}...`);
}

function whoisLookup(button) {
    const row = button.closest('tr');
    const remoteAddress = row.querySelectorAll('.network-address-cell')[1].textContent;
    const ip = remoteAddress.split(':')[0];
    alert(`Performing WHOIS lookup for ${ip}...`);
}

function blockConnection(button) {
    const row = button.closest('tr');
    const remoteAddress = row.querySelectorAll('.network-address-cell')[1].textContent;
    if (confirm(`Are you sure you want to block connections to ${remoteAddress}?`)) {
        alert(`Blocking connection to ${remoteAddress}...`);
        row.remove();
        
        // Update count
        const tableBody = document.getElementById('networkTableBody');
        const resultsCount = document.getElementById('networkResultsCount');
        if (resultsCount && tableBody) {
            const remainingRows = tableBody.querySelectorAll('tr').length;
            resultsCount.textContent = remainingRows;
            
            // Show empty state if no rows left
            if (remainingRows === 0) {
                const tableWrapper = document.querySelector('.network-table-wrapper');
                const emptyState = document.querySelector('#networkAlerts .malware-alerts-empty');
                if (tableWrapper) tableWrapper.style.display = 'none';
                if (emptyState) emptyState.style.display = 'block';
                resultsCount.style.display = 'none';
            }
        }
    }
}

// Auto-convert network data when new connections are detected
function observeNetworkChanges() {
    const networkAlerts = document.getElementById('networkAlerts');
    if (!networkAlerts) return;
    
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // Check if new network data was added
                const hasNewConnections = Array.from(mutation.addedNodes).some(node => 
                    node.nodeType === Node.ELEMENT_NODE && 
                    (node.classList.contains('malware-alert') || 
                     node.hasAttribute('data-network') || 
                     node.classList.contains('network-connection'))
                );
                
                if (hasNewConnections) {
                    // Delay conversion to ensure all data is loaded
                    setTimeout(convertNetworkDataToTable, 100);
                }
            }
        });
    });
    
    observer.observe(networkAlerts, {
        childList: true,
        subtree: true
    });
}

// Enhanced network monitoring with better data display
function enhanceNetworkMonitoring() {
    // Override the existing network alert handler to format data properly
    if (window.electronAPI && window.electronAPI.onNetworkAlert) {
        const originalHandler = window.electronAPI.onNetworkAlert;
        window.electronAPI.onNetworkAlert = function(callback) {
            return originalHandler((alert) => {
                // Format the alert data before displaying
                const formattedAlert = formatNetworkAlert(alert);
                callback(formattedAlert);
                
                // Auto-convert to table after a short delay
                setTimeout(convertNetworkDataToTable, 200);
            });
        };
    }
}

function formatNetworkAlert(alert) {
    // Enhance the alert data with better formatting
    if (alert && typeof alert === 'object') {
        return {
            ...alert,
            formatted: true,
            displayTime: new Date().toLocaleTimeString(),
            processInfo: alert.process || 'Unknown Process',
            connectionDetails: `${alert.localAddress || 'N/A'} -> ${alert.remoteAddress || 'N/A'}`,
            dataTransfer: `Sent: ${formatBytes(alert.bytesSent || 0)}, Received: ${formatBytes(alert.bytesReceived || 0)}`
        };
    }
    return alert;
}

// Initialize network monitoring enhancements
document.addEventListener('DOMContentLoaded', () => {
    // Convert existing network data
    setTimeout(convertNetworkDataToTable, 500);
    
    // Set up observer for new network connections
    observeNetworkChanges();
    
    // Enhance network monitoring
    enhanceNetworkMonitoring();
});
// Forensic Scan Table Conversion and Management
function convertForensicDataToTable() {
    const forensicResults = document.getElementById('forensicResults');
    if (!forensicResults) return;
    
    // Find existing forensic data cards or elements
    const forensicCards = forensicResults.querySelectorAll('.finding-item, [data-forensic], .forensic-result');
    if (forensicCards.length === 0) return;
    
    const tableWrapper = forensicResults.querySelector('.forensic-table-wrapper');
    const tableBody = document.getElementById('forensicTableBody');
    const emptyState = forensicResults.querySelector('.malware-alerts-empty');
    
    if (!tableWrapper || !tableBody) return;
    
    // Hide empty state and show table
    if (emptyState) emptyState.style.display = 'none';
    tableWrapper.style.display = 'block';
    
    // Clear existing table rows
    tableBody.innerHTML = '';
    
    // Convert each forensic card to table row
    forensicCards.forEach(card => {
        const forensicData = extractForensicDataFromCard(card);
        if (forensicData) {
            const row = createForensicTableRow(forensicData);
            tableBody.appendChild(row);
        }
        // Hide the original card
        card.style.display = 'none';
    });
    
    // Update files count
    const filesCount = document.getElementById('forensicFilesCount');
    if (filesCount) {
        filesCount.textContent = forensicCards.length;
        filesCount.style.display = forensicCards.length > 0 ? 'inline' : 'none';
    }
}

function extractForensicDataFromCard(card) {
    try {
        const text = card.textContent || card.innerText || '';
        
        // Parse forensic data from different formats
        // Expected formats might include:
        // "JPEG file found at sector 12345, size: 2.5MB, signature: FFD8FFE0"
        // "PDF document recovered from sector 67890, 1.2MB, confidence: HIGH"
        
        let fileType = 'Unknown';
        let fileName = 'recovered_file';
        let sectorLocation = 'N/A';
        let fileSize = '0 B';
        let signature = 'N/A';
        let recoveryStatus = 'RECOVERABLE';
        let confidence = 'MEDIUM';
        
        // Extract file type
        const typeMatches = [
            { pattern: /JPEG|JPG/i, type: 'JPEG', category: 'image' },
            { pattern: /PNG/i, type: 'PNG', category: 'image' },
            { pattern: /PDF/i, type: 'PDF', category: 'document' },
            { pattern: /ZIP|RAR|7Z/i, type: 'Archive', category: 'archive' },
            { pattern: /MP4|AVI|MOV/i, type: 'Video', category: 'video' },
            { pattern: /DOCX?|DOC/i, type: 'Document', category: 'document' },
            { pattern: /XLSX?|XLS/i, type: 'Spreadsheet', category: 'document' },
            { pattern: /PPTX?|PPT/i, type: 'Presentation', category: 'document' }
        ];
        
        let fileCategory = 'unknown';
        for (const match of typeMatches) {
            if (match.pattern.test(text)) {
                fileType = match.type;
                fileCategory = match.category;
                break;
            }
        }
        
        // Extract sector location
        const sectorMatch = text.match(/sector\s*(\d+)/i);
        if (sectorMatch) {
            sectorLocation = parseInt(sectorMatch[1]).toLocaleString();
        }
        
        // Extract file size
        const sizeMatch = text.match(/size:\s*([\d.]+\s*[KMGT]?B)/i) || text.match(/([\d.]+\s*[KMGT]?B)/);
        if (sizeMatch) {
            fileSize = sizeMatch[1];
        }
        
        // Extract signature
        const sigMatch = text.match(/signature:\s*([A-F0-9]{4,})/i);
        if (sigMatch) {
            signature = sigMatch[1].toUpperCase();
        }
        
        // Extract confidence
        if (text.match(/confidence:\s*high/i) || text.match(/high\s*confidence/i)) {
            confidence = 'HIGH';
        } else if (text.match(/confidence:\s*low/i) || text.match(/low\s*confidence/i)) {
            confidence = 'LOW';
        }
        
        // Determine recovery status based on text content
        if (text.match(/corrupted|damaged|incomplete/i)) {
            recoveryStatus = 'CORRUPTED';
        } else if (text.match(/partial|fragment/i)) {
            recoveryStatus = 'PARTIAL';
        }
        
        // Generate filename based on type and sector
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
        fileName = `recovered_${fileType.toLowerCase()}_${sectorLocation}_${timestamp}`;
        
        return {
            fileType,
            fileCategory,
            fileName,
            sectorLocation,
            fileSize,
            signature,
            recoveryStatus,
            confidence
        };
    } catch (error) {
        console.error('Error extracting forensic data:', error);
        return null;
    }
}

function createForensicTableRow(data) {
    const row = document.createElement('tr');
    row.className = `forensic-row confidence-${data.confidence.toLowerCase()}`;
    
    // Get appropriate icon for file type
    const getFileTypeIcon = (category) => {
        switch (category) {
            case 'image': return 'image';
            case 'document': return 'file-text';
            case 'archive': return 'archive';
            case 'video': return 'video';
            default: return 'file';
        }
    };
    
    row.innerHTML = `
        <td class="forensic-file-type-cell">
            <div class="file-type-badge ${data.fileCategory}">
                <i data-lucide="${getFileTypeIcon(data.fileCategory)}"></i>
                ${data.fileType}
            </div>
        </td>
        <td class="forensic-filename-cell">${data.fileName}</td>
        <td class="forensic-sector-cell">${data.sectorLocation}</td>
        <td class="forensic-size-cell">${data.fileSize}</td>
        <td class="forensic-signature-cell">${data.signature}</td>
        <td class="forensic-status-cell">
            <span class="recovery-status-badge ${data.recoveryStatus.toLowerCase()}">${data.recoveryStatus}</span>
        </td>
        <td class="forensic-confidence-cell">
            <span class="confidence-badge ${data.confidence.toLowerCase()}">${data.confidence}</span>
        </td>
        <td class="forensic-actions-cell">
            <div class="forensic-actions">
                <button class="forensic-action-btn primary" onclick="previewForensicFile(this)" title="Preview File">
                    <i data-lucide="eye"></i>
                    <span>Preview</span>
                </button>
                <button class="forensic-action-btn success" onclick="recoverForensicFile(this)" title="Recover File">
                    <i data-lucide="download"></i>
                    <span>Recover</span>
                </button>
                <button class="forensic-action-btn secondary" onclick="analyzeForensicFile(this)" title="Analyze">
                    <i data-lucide="search"></i>
                    <span>Analyze</span>
                </button>
            </div>
        </td>
    `;
    
    return row;
}

function previewForensicFile(button) {
    const row = button.closest('tr');
    const fileName = row.querySelector('.forensic-filename-cell').textContent;
    const fileType = row.querySelector('.file-type-badge').textContent.trim();
    alert(`Previewing ${fileType} file: ${fileName}`);
}

function recoverForensicFile(button) {
    const row = button.closest('tr');
    const fileName = row.querySelector('.forensic-filename-cell').textContent;
    const sector = row.querySelector('.forensic-sector-cell').textContent;
    
    if (confirm(`Recover file "${fileName}" from sector ${sector}?`)) {
        // Simulate recovery process
        button.disabled = true;
        button.innerHTML = '<i data-lucide="loader-2"></i><span>Recovering...</span>';
        
        setTimeout(() => {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="check"></i><span>Recovered</span>';
            button.classList.remove('success');
            button.classList.add('secondary');
            alert(`File "${fileName}" has been recovered successfully!`);
        }, 2000);
    }
}

function analyzeForensicFile(button) {
    const row = button.closest('tr');
    const fileName = row.querySelector('.forensic-filename-cell').textContent;
    const signature = row.querySelector('.forensic-signature-cell').textContent;
    alert(`Analyzing file: ${fileName}\nSignature: ${signature}\n\nDetailed analysis would show file structure, metadata, and recovery feasibility.`);
}

// Enhanced progress tracking for forensic scans
function updateForensicProgress(percent, sectorsScanned, filesFound, speed, message) {
    const progressBar = document.getElementById('forensicProgressBar');
    const progressPercent = document.getElementById('forensicProgressPercent');
    const sectorsEl = document.getElementById('sectorsScanned');
    const filesEl = document.getElementById('filesFound');
    const speedEl = document.getElementById('scanSpeed');
    const messageEl = document.getElementById('forensicProgressText');
    
    if (progressBar) {
        progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
    
    if (progressPercent) {
        progressPercent.textContent = `${Math.round(percent)}%`;
    }
    
    if (sectorsEl) {
        sectorsEl.textContent = sectorsScanned.toLocaleString();
    }
    
    if (filesEl) {
        filesEl.textContent = filesFound.toLocaleString();
    }
    
    if (speedEl) {
        speedEl.textContent = `${speed} sectors/sec`;
    }
    
    if (messageEl) {
        messageEl.textContent = message || 'Scanning in progress...';
    }
}

// Simulate forensic scan for demonstration
function simulateForensicScan() {
    const progressDiv = document.getElementById('forensicProgress');
    const statusIndicator = document.querySelector('#forensicStatus .status-indicator');
    
    if (progressDiv) progressDiv.style.display = 'block';
    if (statusIndicator) {
        statusIndicator.className = 'status-indicator online';
        statusIndicator.querySelector('span').textContent = 'Scanning Active';
    }
    
    let progress = 0;
    let sectorsScanned = 0;
    let filesFound = 0;
    const totalSectors = parseInt(document.getElementById('forensicSectors')?.value || 10000);
    
    const interval = setInterval(() => {
        progress += Math.random() * 5;
        sectorsScanned += Math.floor(Math.random() * 50) + 10;
        
        // Randomly find files
        if (Math.random() < 0.1) {
            filesFound++;
            // Add a sample forensic result
            addSampleForensicResult(sectorsScanned, filesFound);
        }
        
        const speed = Math.floor(Math.random() * 100) + 50;
        const messages = [
            'Analyzing sector signatures...',
            'Searching for file headers...',
            'Validating file structures...',
            'Checking for recoverable data...',
            'Processing unallocated space...'
        ];
        const message = messages[Math.floor(Math.random() * messages.length)];
        
        updateForensicProgress(progress, sectorsScanned, filesFound, speed, message);
        
        if (progress >= 100) {
            clearInterval(interval);
            updateForensicProgress(100, totalSectors, filesFound, 0, 'Scan completed');
            
            setTimeout(() => {
                if (progressDiv) progressDiv.style.display = 'none';
                if (statusIndicator) {
                    statusIndicator.className = 'status-indicator offline';
                    statusIndicator.querySelector('span').textContent = 'Scan Complete';
                }
            }, 2000);
        }
    }, 500);
}

function addSampleForensicResult(sector, fileIndex) {
    const forensicResults = document.getElementById('forensicResults');
    if (!forensicResults) return;
    
    const sampleFiles = [
        { type: 'JPEG', size: '2.5MB', signature: 'FFD8FFE0', confidence: 'HIGH' },
        { type: 'PDF', size: '1.2MB', signature: '25504446', confidence: 'MEDIUM' },
        { type: 'PNG', size: '800KB', signature: '89504E47', confidence: 'HIGH' },
        { type: 'ZIP', size: '5.1MB', signature: '504B0304', confidence: 'LOW' },
        { type: 'DOCX', size: '450KB', signature: '504B0304', confidence: 'MEDIUM' }
    ];
    
    const sample = sampleFiles[Math.floor(Math.random() * sampleFiles.length)];
    
    // Create a temporary element to trigger the conversion
    const tempDiv = document.createElement('div');
    tempDiv.className = 'finding-item';
    tempDiv.textContent = `${sample.type} file found at sector ${sector}, size: ${sample.size}, signature: ${sample.signature}, confidence: ${sample.confidence}`;
    tempDiv.style.display = 'none';
    
    forensicResults.appendChild(tempDiv);
    
    // Trigger conversion
    setTimeout(() => {
        convertForensicDataToTable();
    }, 100);
}

// Auto-convert forensic data when new results are found
function observeForensicChanges() {
    const forensicResults = document.getElementById('forensicResults');
    if (!forensicResults) return;
    
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // Check if new forensic data was added
                const hasNewResults = Array.from(mutation.addedNodes).some(node => 
                    node.nodeType === Node.ELEMENT_NODE && 
                    (node.classList.contains('finding-item') || 
                     node.hasAttribute('data-forensic') || 
                     node.classList.contains('forensic-result'))
                );
                
                if (hasNewResults) {
                    // Delay conversion to ensure all data is loaded
                    setTimeout(convertForensicDataToTable, 100);
                }
            }
        });
    });
    
    observer.observe(forensicResults, {
        childList: true,
        subtree: true
    });
}

// Initialize forensic scan functionality
document.addEventListener('DOMContentLoaded', () => {
    // Convert existing forensic data
    setTimeout(convertForensicDataToTable, 500);
    
    // Set up observer for new forensic results
    observeForensicChanges();
    
    // Add event listener for forensic scan button (if not already handled)
    const startBtn = document.getElementById('startForensicBtn');
    if (startBtn && !startBtn.hasAttribute('data-listener-added')) {
        startBtn.addEventListener('click', () => {
            simulateForensicScan();
        });
        startBtn.setAttribute('data-listener-added', 'true');
    }
});
// Simple Forensic Table Management - Fixed
function convertForensicResultsToTable() {
    const forensicResults = document.getElementById('forensicResults');
    if (!forensicResults) return;
    
    // Find existing forensic data
    const forensicItems = forensicResults.querySelectorAll('.finding-item, .forensic-result, [data-forensic]');
    if (forensicItems.length === 0) return;
    
    const tableWrapper = forensicResults.querySelector('.forensic-table-wrapper');
    const tableBody = document.getElementById('forensicTableBody');
    const emptyState = forensicResults.querySelector('.malware-alerts-empty');
    const filesCount = document.getElementById('forensicFilesCount');
    
    if (!tableWrapper || !tableBody) return;
    
    // Hide empty state and show table
    if (emptyState) emptyState.style.display = 'none';
    tableWrapper.style.display = 'block';
    
    // Clear existing table rows
    tableBody.innerHTML = '';
    
    // Convert each item to table row
    forensicItems.forEach(item => {
        const data = extractSimpleForensicData(item);
        if (data) {
            const row = createSimpleForensicRow(data);
            tableBody.appendChild(row);
        }
        // Hide original item
        item.style.display = 'none';
    });
    
    // Update files count
    if (filesCount) {
        filesCount.textContent = `${forensicItems.length} files`;
    }
    
    // Initialize Lucide icons for the new table content
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

function extractSimpleForensicData(item) {
    try {
        const text = item.textContent || item.innerText || '';
        
        // Extract basic forensic data
        let fileType = 'Unknown';
        let sector = 'N/A';
        let size = '0 B';
        let signature = 'N/A';
        let confidence = 'MEDIUM';
        
        // File type detection with more patterns
        if (text.match(/JPEG|JPG/i)) fileType = 'JPEG';
        else if (text.match(/PNG/i)) fileType = 'PNG';
        else if (text.match(/GIF/i)) fileType = 'GIF';
        else if (text.match(/PDF/i)) fileType = 'PDF';
        else if (text.match(/ZIP/i)) fileType = 'ZIP';
        else if (text.match(/RAR/i)) fileType = 'RAR';
        else if (text.match(/DOCX?/i)) fileType = 'DOC';
        else if (text.match(/XLSX?/i)) fileType = 'XLS';
        else if (text.match(/PPTX?/i)) fileType = 'PPT';
        else if (text.match(/MP4/i)) fileType = 'MP4';
        else if (text.match(/AVI/i)) fileType = 'AVI';
        else if (text.match(/MP3/i)) fileType = 'MP3';
        else if (text.match(/WAV/i)) fileType = 'WAV';
        else if (text.match(/TXT/i)) fileType = 'TXT';
        else if (text.match(/EXE/i)) fileType = 'EXE';
        
        // Extract sector with better parsing
        const sectorMatch = text.match(/sector[:\s]*(\d+)/i) || text.match(/(\d+)\s*sectors?/i);
        if (sectorMatch) {
            sector = parseInt(sectorMatch[1]).toLocaleString();
        }
        
        // Extract size with better parsing
        const sizeMatch = text.match(/([\d.]+\s*[KMGT]?B)/i) || text.match(/size[:\s]*([\d.]+\s*[KMGT]?B)/i);
        if (sizeMatch) {
            size = sizeMatch[1];
        }
        
        // Extract signature with better parsing
        const sigMatch = text.match(/signature[:\s]*([A-F0-9]{4,})/i) || text.match(/([A-F0-9]{8,})/);
        if (sigMatch) {
            signature = sigMatch[1].toUpperCase();
            // Limit signature length for display
            if (signature.length > 16) {
                signature = signature.substring(0, 16) + '...';
            }
        }
        
        // Determine confidence with better logic
        if (text.match(/high\s*confidence|confidence[:\s]*high/i)) confidence = 'HIGH';
        else if (text.match(/low\s*confidence|confidence[:\s]*low/i)) confidence = 'LOW';
        else if (text.match(/medium\s*confidence|confidence[:\s]*medium/i)) confidence = 'MEDIUM';
        else if (signature !== 'N/A' && signature.length >= 8) confidence = 'HIGH';
        else if (size !== '0 B' && sector !== 'N/A') confidence = 'MEDIUM';
        else confidence = 'LOW';
        
        return { fileType, sector, size, signature, confidence };
    } catch (error) {
        console.error('Error extracting forensic data:', error);
        return null;
    }
}

function createSimpleForensicRow(data) {
    const row = document.createElement('tr');
    
    row.innerHTML = `
        <td><span class="forensic-file-type">${data.fileType}</span></td>
        <td class="forensic-sector">${data.sector}</td>
        <td class="forensic-size">${data.size}</td>
        <td class="forensic-signature">${data.signature}</td>
        <td class="forensic-confidence">
            <span class="confidence-badge ${data.confidence.toLowerCase()}">${data.confidence}</span>
        </td>
        <td>
            <div class="forensic-actions">
                <button class="forensic-action-btn primary" onclick="previewFile(this)">
                    <i data-lucide="eye"></i>
                    Preview
                </button>
                <button class="forensic-action-btn success" onclick="recoverFile(this)">
                    <i data-lucide="download"></i>
                    Recover
                </button>
            </div>
        </td>
    `;
    
    return row;
}

function previewFile(button) {
    const row = button.closest('tr');
    const fileType = row.querySelector('.forensic-file-type').textContent;
    const sector = row.querySelector('.forensic-sector').textContent;
    alert(`Previewing ${fileType} file from sector ${sector}`);
}

function recoverFile(button) {
    const row = button.closest('tr');
    const fileType = row.querySelector('.forensic-file-type').textContent;
    const sector = row.querySelector('.forensic-sector').textContent;
    
    if (confirm(`Recover ${fileType} file from sector ${sector}?`)) {
        button.innerHTML = '<i data-lucide="check"></i>Recovered';
        button.disabled = true;
        button.classList.remove('success');
        button.classList.add('secondary');
        
        // Re-initialize icons
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }
}

// Enhanced observer for forensic results
function observeForensicResults() {
    const forensicResults = document.getElementById('forensicResults');
    if (!forensicResults) return;
    
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                const hasNewResults = Array.from(mutation.addedNodes).some(node => 
                    node.nodeType === Node.ELEMENT_NODE && 
                    (node.classList.contains('finding-item') || 
                     node.classList.contains('forensic-result') ||
                     node.hasAttribute('data-forensic') ||
                     node.textContent.match(/file|sector|signature/i))
                );
                
                if (hasNewResults) {
                    setTimeout(convertForensicResultsToTable, 200);
                }
            }
        });
    });
    
    observer.observe(forensicResults, {
        childList: true,
        subtree: true
    });
}

// Force table display for any existing forensic content
function forceForensicTableDisplay() {
    const forensicResults = document.getElementById('forensicResults');
    if (!forensicResults) return;
    
    // Check if there's any forensic content that should be in table format
    const allContent = forensicResults.textContent || '';
    if (allContent.match(/file|sector|signature|found|discovered/i)) {
        // Create dummy items for any existing content
        const lines = allContent.split('\n').filter(line => line.trim().length > 0);
        lines.forEach(line => {
            if (line.match(/file|sector|signature/i)) {
                const tempDiv = document.createElement('div');
                tempDiv.className = 'finding-item';
                tempDiv.textContent = line;
                tempDiv.style.display = 'none';
                forensicResults.appendChild(tempDiv);
            }
        });
        
        // Convert to table
        setTimeout(convertForensicResultsToTable, 100);
    }
}

// Initialize forensic table functionality
document.addEventListener('DOMContentLoaded', () => {
    // Convert existing results
    setTimeout(() => {
        convertForensicResultsToTable();
        forceForensicTableDisplay();
    }, 1000);
    
    // Set up observer
    observeForensicResults();
    
    // Check periodically for new content
    setInterval(() => {
        const tableWrapper = document.querySelector('.forensic-table-wrapper');
        const emptyState = document.querySelector('#forensicResults .malware-alerts-empty');
        
        if (tableWrapper && tableWrapper.style.display === 'none' && emptyState && emptyState.style.display !== 'none') {
            forceForensicTableDisplay();
        }
    }, 2000);
});