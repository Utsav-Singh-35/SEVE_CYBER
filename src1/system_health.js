// system_health.js - System health monitoring for Windows
const os = require('os');
const { execSync } = require('child_process');
const { getCPUInfo } = require('./cpu_lookup');

/**
 * Get CPU usage percentage (averaged over 1 second)
 */
async function getCPUUsage() {
  return new Promise((resolve) => {
    const startMeasure = cpuAverage();
    setTimeout(() => {
      const endMeasure = cpuAverage();
      const idleDiff = endMeasure.idle - startMeasure.idle;
      const totalDiff = endMeasure.total - startMeasure.total;
      const percentageCPU = 100 - Math.floor(100 * idleDiff / totalDiff);
      resolve(percentageCPU);
    }, 1000);
  });
}

function cpuAverage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
}

/**
 * Get memory metrics
 */
function getMemoryMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    free,
    used,
    usedPercent: Math.round((used / total) * 100),
    freePercent: Math.round((free / total) * 100)
  };
}

/**
 * Get disk metrics (Windows-specific via PowerShell)
 */
function getDiskMetrics() {
  try {
    // Get disk space for all drives
    const diskSpaceCmd = `powershell "Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null} | Select-Object Name,@{Name='UsedGB';Expression={[math]::Round($_.Used/1GB,2)}},@{Name='FreeGB';Expression={[math]::Round($_.Free/1GB,2)}},@{Name='TotalGB';Expression={[math]::Round(($_.Used+$_.Free)/1GB,2)}},@{Name='UsedPercent';Expression={[math]::Round(($_.Used/($_.Used+$_.Free))*100,1)}} | ConvertTo-Json"`;
    const diskSpaceOutput = execSync(diskSpaceCmd, { encoding: 'utf8', timeout: 5000 });
    let diskSpace = JSON.parse(diskSpaceOutput);
    if (!Array.isArray(diskSpace)) diskSpace = [diskSpace];

    // Get disk I/O performance (% Disk Time) - with fallback
    let diskActiveTime = 0;
    try {
      const diskIOCmd = `powershell "Get-Counter '\\PhysicalDisk(_Total)\\% Disk Time' | Select-Object -ExpandProperty CounterSamples | Select-Object -ExpandProperty CookedValue"`;
      const diskIOOutput = execSync(diskIOCmd, { encoding: 'utf8', timeout: 5000 });
      diskActiveTime = Math.min(100, Math.max(0, parseFloat(diskIOOutput.trim())));
    } catch (ioErr) {
      console.warn('Failed to get disk I/O metrics, using 0:', ioErr.message);
      diskActiveTime = 0; // Fallback to 0 if counter fails
    }

    return {
      drives: diskSpace,
      activeTime: Math.round(diskActiveTime)
    };
  } catch (err) {
    console.error('Failed to get disk metrics:', err.message);
    // Return empty data instead of crashing
    return { drives: [], activeTime: 0 };
  }
}

/**
 * Get system uptime
 */
function getUptimeMetrics() {
  const uptimeSeconds = os.uptime();
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  return {
    seconds: uptimeSeconds,
    formatted: `${days}d ${hours}h ${minutes}m`
  };
}

/**
 * Get process count (Windows-specific)
 */
function getProcessCount() {
  try {
    const cmd = `powershell "(Get-Process).Count"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 3000 });
    return parseInt(output.trim(), 10) || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Analyze system health and generate insights
 * 
 * NOTE: Health score is a SIMPLIFIED metric for visual representation.
 * It uses arbitrary thresholds based on common performance guidelines.
 * This is NOT a scientific measurement - it's for user-friendly display.
 * 
 * Scoring penalties (arbitrary but consistent):
 * - CPU >90%: -20 points (high load)
 * - CPU >70%: -10 points (elevated load)
 * - Memory >90%: -25 points (critical - causes paging)
 * - Memory >80%: -15 points (high usage)
 * - Disk >95% full: -30 points (critical - system instability)
 * - Disk >90% full: -15 points (low space warning)
 * - Disk >80% full: -5 points (monitor)
 * - Disk I/O >95%: -20 points (bottleneck)
 * - Disk I/O >80%: -10 points (high activity)
 */
function analyzeHealth(metrics) {
  const issues = [];
  let healthScore = 100; // Start at perfect health

  // CPU Analysis
  if (metrics.cpu.usage > 90) {
    issues.push({
      severity: 'high',
      category: 'cpu',
      title: 'High CPU Usage',
      description: `CPU usage is at ${metrics.cpu.usage}%`,
      impact: 'System may be slow or unresponsive',
      actions: [
        'Check Task Manager for high-CPU processes',
        'Close unnecessary applications',
        'Check for malware or background tasks'
      ]
    });
    healthScore -= 20;
  } else if (metrics.cpu.usage > 70) {
    issues.push({
      severity: 'medium',
      category: 'cpu',
      title: 'Elevated CPU Usage',
      description: `CPU usage is at ${metrics.cpu.usage}%`,
      impact: 'System performance may be affected',
      actions: ['Monitor for sustained high usage', 'Close unused applications']
    });
    healthScore -= 10;
  }

  // Memory Analysis
  if (metrics.memory.usedPercent > 90) {
    issues.push({
      severity: 'critical',
      category: 'memory',
      title: 'Critical Memory Pressure',
      description: `Only ${metrics.memory.freePercent}% RAM available`,
      impact: 'System is paging to disk, severe slowdown expected',
      actions: [
        'Close unused applications immediately',
        'Restart system to free memory',
        'Check for memory leaks',
        'Consider RAM upgrade'
      ]
    });
    healthScore -= 25;
  } else if (metrics.memory.usedPercent > 80) {
    issues.push({
      severity: 'high',
      category: 'memory',
      title: 'High Memory Usage',
      description: `${metrics.memory.usedPercent}% RAM in use`,
      impact: 'System may start paging to disk',
      actions: ['Close unused applications', 'Check for memory-intensive processes']
    });
    healthScore -= 15;
  }

  // Disk Space Analysis
  for (const drive of metrics.disk.drives) {
    if (drive.UsedPercent > 95) {
      issues.push({
        severity: 'critical',
        category: 'disk',
        title: `Drive ${drive.Name}: Critical Space`,
        description: `Only ${drive.FreeGB} GB free (${100 - drive.UsedPercent}%)`,
        impact: 'System instability, potential data loss, cannot create temp files',
        actions: [
          'Run SEVE scan to find large unused files',
          'Delete temporary files',
          'Move data to another drive',
          'Uninstall unused programs'
        ]
      });
      healthScore -= 30;
    } else if (drive.UsedPercent > 90) {
      issues.push({
        severity: 'high',
        category: 'disk',
        title: `Drive ${drive.Name}: Low Space`,
        description: `Only ${drive.FreeGB} GB free (${100 - drive.UsedPercent}%)`,
        impact: 'System slowdown, limited space for updates',
        actions: ['Run SEVE scan', 'Clean up temporary files', 'Review large files']
      });
      healthScore -= 15;
    } else if (drive.UsedPercent > 80) {
      issues.push({
        severity: 'medium',
        category: 'disk',
        title: `Drive ${drive.Name}: Space Warning`,
        description: `${drive.FreeGB} GB free (${100 - drive.UsedPercent}%)`,
        impact: 'May need cleanup soon',
        actions: ['Monitor disk usage', 'Plan cleanup']
      });
      healthScore -= 5;
    }
  }

  // Disk I/O Analysis
  if (metrics.disk.activeTime > 95) {
    issues.push({
      severity: 'high',
      category: 'disk',
      title: 'Disk Bottleneck',
      description: `Disk is ${metrics.disk.activeTime}% active`,
      impact: 'Disk is the primary performance bottleneck',
      actions: [
        'Check for disk-intensive processes',
        'Consider SSD upgrade if using HDD',
        'Check disk health with SMART data',
        'Disable Windows Search indexing temporarily'
      ]
    });
    healthScore -= 20;
  } else if (metrics.disk.activeTime > 80) {
    issues.push({
      severity: 'medium',
      category: 'disk',
      title: 'High Disk Activity',
      description: `Disk is ${metrics.disk.activeTime}% active`,
      impact: 'Disk may be slowing system',
      actions: ['Monitor disk activity', 'Check for background processes']
    });
    healthScore -= 10;
  }

  // Ensure health score stays in 0-100 range
  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    score: healthScore,
    issues,
    status: healthScore >= 80 ? 'good' : healthScore >= 60 ? 'fair' : healthScore >= 40 ? 'poor' : 'critical'
  };
}

/**
 * Get comprehensive system health metrics
 */
async function getSystemHealth() {
  try {
    // Platform check - warn if not Windows
    if (os.type() !== 'Windows_NT') {
      console.warn('System health monitoring is optimized for Windows. Some metrics may be unavailable.');
    }

    const cpuUsage = await getCPUUsage();
    const memory = getMemoryMetrics();
    const disk = getDiskMetrics();
    const uptime = getUptimeMetrics();
    const processCount = getProcessCount();

    const metrics = {
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown'
      },
      memory,
      disk,
      uptime,
      processes: processCount,
      platform: {
        type: os.type(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname()
      }
    };

    // Lookup CPU specs from MongoDB
    let cpuInfo = null;
    try {
      const cpuModel = metrics.cpu.model;
      console.log('[System Health] Looking up CPU:', cpuModel);
      cpuInfo = await getCPUInfo(cpuModel);
      if (cpuInfo.success) {
        console.log('[System Health] CPU found in database:', cpuInfo.cpu.name);
        metrics.cpu.specs = cpuInfo.cpu;
        metrics.cpu.benchmark = cpuInfo.benchmark;
      } else {
        console.log('[System Health] CPU not found in database');
      }
    } catch (err) {
      console.warn('[System Health] CPU lookup failed:', err.message);
    }

    const analysis = analyzeHealth(metrics);

    return {
      success: true,
      metrics,
      analysis,
      cpuInfo // Include CPU info for AI summary
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  getSystemHealth,
  getCPUUsage,
  getMemoryMetrics,
  getDiskMetrics,
  getUptimeMetrics,
  analyzeHealth
};
