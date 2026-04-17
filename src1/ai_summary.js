// ai_summary.js - Unified AI summary generation (API or Local)
require('dotenv').config();
const https = require('https');

/**
 * Check if running in bootable/offline mode
 */
function isBootableMode() {
  return process.env.SEVE_BOOTABLE === '1' || process.env.SEVE_OFFLINE === '1';
}

/**
 * Main entry point - routes to API or local AI
 */
async function generateAISummary(systemMetrics, cpuInfo, healthAnalysis) {
  // ALWAYS use local AI for hackathon demo (network unreliable)
  console.log('[AI] Using local rule-based engine');
  const { generateLocalAISummary } = require('./local_ai');
  return await generateLocalAISummary(systemMetrics, cpuInfo, healthAnalysis);
  
  // Disabled for hackathon - uncomment for production with reliable network
  // if (isBootableMode()) {
  //   console.log('[AI] Bootable mode detected, using local AI');
  //   const { generateLocalAISummary } = require('./local_ai');
  //   return await generateLocalAISummary(systemMetrics, cpuInfo, healthAnalysis);
  // }
  // return await generateOpenRouterSummary(systemMetrics, cpuInfo, healthAnalysis);
}

/**
 * Call OpenRouter API for AI summary
 */
async function generateOpenRouterSummary(systemMetrics, cpuInfo, healthAnalysis) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey || apiKey.includes('xxxx')) {
    return {
      success: false,
      error: 'OpenRouter API key not configured'
    };
  }
  
  // Build context for AI
  const context = buildContext(systemMetrics, cpuInfo, healthAnalysis);
  
  const payload = JSON.stringify({
    model: 'openai/gpt-3.5-turbo', // Reliable, cheap ($0.0005/1K tokens)
    messages: [
      {
        role: 'system',
        content: 'You are a system health analyst. Provide concise, actionable insights about computer performance and health. Be direct and specific.'
      },
      {
        role: 'user',
        content: `Analyze this system and provide a brief summary (2-3 sentences) and top 3 recommendations:\n\n${context}`
      }
    ],
    max_tokens: 300,
    temperature: 0.7
  });
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://seve-desktop.app',
        'X-Title': 'SEVE Desktop Health Dashboard'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (response.error) {
            resolve({
              success: false,
              error: response.error.message || 'API error'
            });
            return;
          }
          
          const content = response.choices[0]?.message?.content;
          if (!content) {
            resolve({
              success: false,
              error: 'No content in response'
            });
            return;
          }
          
          resolve({
            success: true,
            summary: content.trim()
          });
        } catch (err) {
          resolve({
            success: false,
            error: `Parse error: ${err.message}`
          });
        }
      });
    });
    
    req.on('error', (err) => {
      resolve({
        success: false,
        error: `Request error: ${err.message}`
      });
    });
    
    req.write(payload);
    req.end();
  });
}

/**
 * Build context string for AI
 */
function buildContext(metrics, cpuInfo, analysis) {
  let context = '=== SYSTEM METRICS ===\n';
  context += `CPU Usage: ${metrics.cpu.usage}%\n`;
  context += `Memory: ${metrics.memory.usedPercent}% used (${(metrics.memory.used / (1024**3)).toFixed(1)} GB / ${(metrics.memory.total / (1024**3)).toFixed(1)} GB)\n`;
  context += `Disk Activity: ${metrics.disk.activeTime}%\n`;
  context += `Uptime: ${metrics.uptime.formatted}\n`;
  context += `Processes: ${metrics.processes}\n\n`;
  
  if (cpuInfo && cpuInfo.success) {
    context += '=== CPU INFORMATION ===\n';
    context += `Model: ${cpuInfo.cpu.name}\n`;
    if (cpuInfo.cpu.cores) context += `Cores/Threads: ${cpuInfo.cpu.cores}/${cpuInfo.cpu.threads}\n`;
    if (cpuInfo.cpu.base_frequency) context += `Base Frequency: ${cpuInfo.cpu.base_frequency} MHz\n`;
    if (cpuInfo.cpu.turbo_frequency) context += `Turbo Frequency: ${cpuInfo.cpu.turbo_frequency} MHz\n`;
    if (cpuInfo.cpu.tdp) context += `TDP: ${cpuInfo.cpu.tdp}W\n`;
    if (cpuInfo.cpu.max_temp) context += `Max Temperature: ${cpuInfo.cpu.max_temp}°C\n`;
    if (cpuInfo.cpu.launch_date) context += `Launch Date: ${cpuInfo.cpu.launch_date}\n`;
    if (cpuInfo.benchmark) context += `Benchmark Score: ${cpuInfo.benchmark.rating}\n`;
    context += '\n';
  }
  
  if (metrics.disk.drives && metrics.disk.drives.length > 0) {
    context += '=== DISK SPACE ===\n';
    metrics.disk.drives.forEach(drive => {
      context += `Drive ${drive.Name}: ${drive.UsedPercent.toFixed(1)}% used (${drive.FreeGB} GB free)\n`;
    });
    context += '\n';
  }
  
  if (analysis.issues && analysis.issues.length > 0) {
    context += '=== DETECTED ISSUES ===\n';
    analysis.issues.forEach((issue, idx) => {
      context += `${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.title}: ${issue.description}\n`;
    });
    context += '\n';
  }
  
  context += `=== HEALTH SCORE ===\n`;
  context += `Overall Score: ${analysis.score}/100 (${analysis.status})\n`;
  
  return context;
}

module.exports = {
  generateAISummary,
  isBootableMode
};
