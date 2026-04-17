// local_ai.js - Local AI inference using Python llama.cpp service
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getClient } = require('./llm_client');

let modelLoaded = false;
let client = null;

/**
 * Check if system meets minimum requirements for local AI
 */
function checkSystemRequirements() {
  const totalRAM = os.totalmem() / (1024 ** 3); // GB
  const cpuModel = os.cpus()[0]?.model || '';
  
  // Check RAM
  if (totalRAM < 4) {
    return {
      supported: false,
      reason: `Insufficient RAM: ${totalRAM.toFixed(1)}GB (minimum 4GB required)`
    };
  }
  
  // Check CPU (basic check - AVX2 detection requires native code)
  const cpuYear = extractCPUYear(cpuModel);
  if (cpuYear && cpuYear < 2013) {
    return {
      supported: false,
      reason: `CPU too old: ${cpuModel} (2013+ required for AVX2)`
    };
  }
  
  return {
    supported: true,
    ram: totalRAM,
    cpu: cpuModel,
    recommendedModel: totalRAM >= 8 ? 'llama-3.2-3b' : 'phi-2'
  };
}

/**
 * Extract approximate CPU year from model string (heuristic)
 */
function extractCPUYear(cpuModel) {
  // Intel: i3-4xxx = 4th gen = 2013, i7-9xxx = 9th gen = 2018
  const intelMatch = cpuModel.match(/i[3579]-(\d)(\d{3})/);
  if (intelMatch) {
    const gen = parseInt(intelMatch[1]);
    return 2010 + gen; // Rough approximation
  }
  
  // AMD: Ryzen 5 3600 = 3rd gen = 2019
  const amdMatch = cpuModel.match(/Ryzen.*?(\d)\d{3}/);
  if (amdMatch) {
    const gen = parseInt(amdMatch[1]);
    return 2017 + gen;
  }
  
  return null; // Unknown, assume modern
}

/**
 * Initialize local AI model (lazy load)
 */
async function initLocalAI() {
  if (modelLoaded && client) return { success: true };
  
  try {
    // Check system requirements first
    const sysCheck = checkSystemRequirements();
    if (!sysCheck.supported) {
      console.warn('[Local AI] System requirements not met:', sysCheck.reason);
      return { success: false, error: sysCheck.reason, fallback: true };
    }
    
    console.log('[Local AI] System check passed:', sysCheck);
    
    const modelPath = path.join(__dirname, '..', 'models', 'phi-2-q4.gguf');
    
    if (!fs.existsSync(modelPath)) {
      console.warn('[Local AI] Model not found:', modelPath);
      return { success: false, error: 'Model file not found', fallback: true };
    }
    
    console.log('[Local AI] Starting Python LLM service...');
    const startTime = Date.now();
    
    client = getClient();
    await client.start();
    
    console.log('[Local AI] Loading model:', modelPath);
    const loadResult = await client.loadModel(modelPath);
    
    if (!loadResult.success) {
      console.error('[Local AI] Failed to load model:', loadResult.error);
      return { success: false, error: loadResult.error, fallback: true };
    }
    
    const loadTime = Date.now() - startTime;
    console.log(`[Local AI] Model loaded in ${loadTime}ms`);
    
    modelLoaded = true;
    return { success: true, modelPath, loadTime };
  } catch (err) {
    console.error('[Local AI] Initialization failed:', err);
    return { success: false, error: err.message, fallback: true };
  }
}

/**
 * Get model path based on environment and recommended model
 */
function getModelPath(recommendedModel) {
  const { app } = require('electron');
  
  // Bootable mode: models on USB drive
  if (process.env.SEVE_BOOTABLE === '1') {
    const usbRoot = process.env.SEVE_USB_ROOT || 'D:\\';
    return path.join(usbRoot, 'seve', 'ai-models', `${recommendedModel}-q4.gguf`);
  }
  
  // Development/testing: models in userData
  return path.join(app.getPath('userData'), 'models', `${recommendedModel}-q4.gguf`);
}

/**
 * Generate AI summary using local model
 */
async function generateLocalAISummary(metrics, cpuInfo, analysis) {
  // Initialize if not already done
  const initResult = await initLocalAI();
  if (!initResult.success) {
    console.log('[Local AI] Falling back to rule-based');
    const summary = generateRuleBasedSummary(metrics, cpuInfo, analysis);
    return {
      success: true,
      summary: summary,
      model: 'seve-rule-engine-v1',
      inference_time_ms: 0,
      mode: 'fallback'
    };
  }
  
  try {
    const startTime = Date.now();
    
    // Build prompt
    const prompt = buildHealthPrompt(metrics, cpuInfo, analysis);
    
    // Run inference via Python service
    const result = await client.generate(prompt, {
      maxTokens: 200,
      temperature: 0.7
    });
    
    const inferenceTime = Date.now() - startTime;
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    return {
      success: true,
      summary: result.response,
      model: 'phi-2-q4',
      inference_time_ms: inferenceTime,
      mode: 'local-llm'
    };
  } catch (err) {
    console.error('[Local AI] Inference failed:', err);
    // Fallback to rule-based
    const summary = generateRuleBasedSummary(metrics, cpuInfo, analysis);
    return {
      success: true,
      summary: summary,
      model: 'seve-rule-engine-v1',
      inference_time_ms: 0,
      mode: 'fallback'
    };
  }
}

/**
 * Build prompt for health analysis
 */
function buildHealthPrompt(metrics, cpuInfo, analysis) {
  let prompt = 'Analyze this computer system and provide a brief health summary with top 3 recommendations:\n\n';
  prompt += `CPU Usage: ${metrics.cpu.usage}%\n`;
  prompt += `Memory: ${metrics.memory.usedPercent}% used\n`;
  prompt += `Disk Activity: ${metrics.disk.activeTime}%\n`;
  
  if (cpuInfo && cpuInfo.success) {
    prompt += `CPU: ${cpuInfo.cpu.name} (${cpuInfo.cpu.launch_date})\n`;
  }
  
  if (analysis.issues && analysis.issues.length > 0) {
    prompt += `\nIssues detected: ${analysis.issues.length}\n`;
  }
  
  prompt += `\nHealth Score: ${analysis.score}/100\n\n`;
  prompt += 'Provide a concise summary (2-3 sentences) and top 3 actionable recommendations:';
  
  return prompt;
}

/**
 * Rule-based fallback (instant, no AI required)
 */
function generateRuleBasedSummary(metrics, cpuInfo, analysis) {
  const recommendations = [];
  
  // CPU analysis
  if (metrics.cpu.usage > 90) {
    recommendations.push('⚠️ HIGH CPU USAGE: Check Task Manager for resource-intensive processes. Consider closing unnecessary applications.');
  } else if (metrics.cpu.usage > 70) {
    recommendations.push('⚡ ELEVATED CPU: System is under moderate load. Monitor for sustained high usage.');
  }
  
  // Memory analysis
  if (metrics.memory.usedPercent > 90) {
    recommendations.push('🔴 CRITICAL MEMORY: Only ' + metrics.memory.freePercent + '% RAM available. Close applications immediately or system will slow down significantly.');
  } else if (metrics.memory.usedPercent > 80) {
    recommendations.push('⚠️ HIGH MEMORY USAGE: Consider closing unused applications. Upgrade RAM if this is persistent.');
  }
  
  // Disk analysis
  if (metrics.disk.activeTime > 95) {
    recommendations.push('💾 DISK BOTTLENECK: Disk is ' + metrics.disk.activeTime + '% active. This is your primary performance bottleneck. Consider SSD upgrade.');
  }
  
  // Disk space analysis
  if (metrics.disk.drives && metrics.disk.drives.length > 0) {
    metrics.disk.drives.forEach(drive => {
      if (drive.UsedPercent > 95) {
        recommendations.push(`🔴 CRITICAL SPACE (${drive.Name}:): Only ${drive.FreeGB}GB free. System instability likely. Run SEVE scan to free space.`);
      } else if (drive.UsedPercent > 90) {
        recommendations.push(`⚠️ LOW SPACE (${drive.Name}:): ${drive.FreeGB}GB free. Clean up files soon.`);
      }
    });
  }
  
  // CPU specs insight
  if (cpuInfo && cpuInfo.success && cpuInfo.cpu) {
    const cpu = cpuInfo.cpu;
    if (cpu.launch_date) {
      const year = parseInt(cpu.launch_date);
      const age = new Date().getFullYear() - year;
      if (age > 7) {
        recommendations.push(`💻 CPU AGE: Your ${cpu.name} is ${age} years old. Consider upgrade for better performance.`);
      }
    }
  }
  
  // Health score summary
  let summary = '';
  if (analysis.score >= 80) {
    summary = '✅ SYSTEM HEALTHY: Your system is running well with no critical issues detected.';
  } else if (analysis.score >= 60) {
    summary = '⚡ SYSTEM FAIR: Some performance issues detected. Review recommendations below.';
  } else if (analysis.score >= 40) {
    summary = '⚠️ SYSTEM POOR: Multiple issues affecting performance. Immediate action recommended.';
  } else {
    summary = '🔴 SYSTEM CRITICAL: Severe issues detected. System may be unstable.';
  }
  
  if (recommendations.length === 0) {
    return summary + '\n\nNo specific recommendations at this time. System is operating normally.';
  }
  
  return summary + '\n\nTOP RECOMMENDATIONS:\n\n' + recommendations.slice(0, 3).map((r, i) => `${i + 1}. ${r}`).join('\n\n');
}

module.exports = {
  initLocalAI,
  generateLocalAISummary,
  checkSystemRequirements,
  generateRuleBasedSummary
};
