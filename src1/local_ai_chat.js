// local_ai_chat.js - General purpose chat interface for local AI
const path = require('path');
const { getClient } = require('./llm_client');

let client = null;

/**
 * Initialize chat session
 */
async function initChatSession() {
  if (client) return { success: true };
  
  try {
    client = getClient();
    await client.start();
    
    const modelPath = path.join(__dirname, '..', 'models', 'phi-2-q4.gguf');
    const loadResult = await client.loadModel(modelPath);
    
    if (!loadResult.success) {
      return { success: false, error: loadResult.error };
    }
    
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send message to AI and get response
 */
async function sendMessage(message, options = {}) {
  if (!client) {
    const init = await initChatSession();
    if (!init.success) {
      return { success: false, error: init.error };
    }
  }
  
  try {
    const startTime = Date.now();
    
    // Format prompt with SEVE context
    const formattedPrompt = `You are SEVE AI Assistant - an expert in the SEVE (Secure Erasure & Verification Engine) system.

SEVE is a secure data erasure tool that:
- Scans drives and detects files
- Performs military-grade secure deletion (DOD 5220.22-M standard)
- Generates verification reports and certificates
- Monitors system health (CPU, memory, disk)
- Analyzes files for sensitive data
- Works 100% offline for maximum security

Your role:
- Help users understand SEVE features
- Guide secure erasure procedures
- Explain system health metrics
- Assist with file analysis
- Answer technical questions about data security

User: ${message}

Assistant:`;
    
    const result = await client.generate(formattedPrompt, {
      maxTokens: options.maxTokens || 200,
      temperature: options.temperature || 0.7
    });
    
    const inferenceTime = Date.now() - startTime;
    
    if (!result.success) {
      return { success: false, error: result.error };
    }
    
    return {
      success: true,
      response: result.response,
      inference_time_ms: inferenceTime
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Analyze file content for sensitive data
 */
async function analyzeFileContent(filePath, content, snippet) {
  const prompt = `Analyze this file for sensitive data (passwords, API keys, personal info, etc.):

File: ${filePath}
Content preview:
${snippet || content.substring(0, 1000)}

Identify:
1. Sensitive data found (be specific)
2. Risk level (low/medium/high/critical)
3. Recommendation

Be concise and direct.`;

  return await sendMessage(prompt, { maxTokens: 300 });
}

/**
 * Generate remarks for search results
 */
async function generateFileRemarks(files) {
  if (!files || files.length === 0) {
    return { success: false, error: 'No files provided' };
  }
  
  const fileList = files.slice(0, 10).map(f => `- ${f.name} (${f.size} bytes)`).join('\n');
  
  const prompt = `Analyze these files and provide brief remarks about what might be worth reviewing:

${fileList}

Provide 2-3 sentence summary of what these files suggest about the system.`;

  return await sendMessage(prompt, { maxTokens: 200 });
}

/**
 * Reset chat session (clear history)
 */
function resetChat() {
  // llama-node doesn't maintain session state, so nothing to reset
  return { success: true };
}

module.exports = {
  initChatSession,
  sendMessage,
  analyzeFileContent,
  generateFileRemarks,
  resetChat
};
