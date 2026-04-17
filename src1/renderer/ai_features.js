// ai_features.js - AI-powered features for SEVE
// This module handles all AI integrations: chat, file analysis, performance insights, and file remarks

/**
 * 1. CHAT INTERFACE
 * Full conversational AI for system queries
 */
class SEVEChat {
    constructor() {
        this.messages = [];
        this.isProcessing = false;
    }

    async sendMessage(userMessage) {
        if (this.isProcessing) {
            return { success: false, error: 'Already processing a message' };
        }

        this.isProcessing = true;
        this.messages.push({ role: 'user', content: userMessage });

        try {
            const result = await window.electronAPI.aiChat(userMessage, {
                maxTokens: 200,  // Reduced from 500 for faster responses
                temperature: 0.7
            });

            if (result.success) {
                this.messages.push({ role: 'assistant', content: result.response });
            }

            this.isProcessing = false;
            return result;
        } catch (err) {
            this.isProcessing = false;
            return { success: false, error: err.message };
        }
    }

    clearHistory() {
        this.messages = [];
        return window.electronAPI.resetChat();
    }

    getHistory() {
        return this.messages;
    }
}

/**
 * 2. FILE REMARKS GENERATOR
 * Generates AI insights about search results
 */
async function generateFileRemarks(files) {
    if (!files || files.length === 0) {
        return { success: false, error: 'No files provided' };
    }

    try {
        const result = await window.electronAPI.generateFileRemarks(files);
        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * 3. PERFORMANCE ANALYSIS
 * AI-powered performance insights and recommendations
 */
async function analyzePerformance(metrics) {
    if (!metrics) {
        return { success: false, error: 'No metrics provided' };
    }

    try {
        // Build performance analysis prompt
        const prompt = buildPerformancePrompt(metrics);
        
        const result = await window.electronAPI.aiChat(prompt, {
            maxTokens: 400,
            temperature: 0.7
        });

        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function buildPerformancePrompt(metrics) {
    let prompt = 'Analyze this system performance data and provide:\n';
    prompt += '1. Top 3 performance bottlenecks\n';
    prompt += '2. Specific optimization recommendations\n';
    prompt += '3. Expected performance improvements\n\n';
    
    prompt += '=== METRICS ===\n';
    prompt += `CPU: ${metrics.cpu.usage}% (${metrics.cpu.cores} cores)\n`;
    prompt += `Memory: ${metrics.memory.usedPercent}% (${(metrics.memory.used / (1024**3)).toFixed(1)}GB / ${(metrics.memory.total / (1024**3)).toFixed(1)}GB)\n`;
    prompt += `Disk Activity: ${metrics.disk.activeTime}%\n`;
    prompt += `Processes: ${metrics.processes}\n`;
    prompt += `Uptime: ${metrics.uptime.formatted}\n\n`;
    
    if (metrics.disk.drives && metrics.disk.drives.length > 0) {
        prompt += '=== DISK SPACE ===\n';
        metrics.disk.drives.forEach(drive => {
            prompt += `${drive.Name}: ${drive.UsedPercent.toFixed(1)}% used (${drive.FreeGB}GB free)\n`;
        });
    }
    
    prompt += '\nProvide concise, actionable analysis:';
    return prompt;
}

/**
 * 4. FILE CONTENT ANALYSIS
 * Detects sensitive data in files (passwords, API keys, PII)
 */
async function analyzeFileContent(filePath, content, snippet) {
    if (!filePath) {
        return { success: false, error: 'No file path provided' };
    }

    try {
        const result = await window.electronAPI.analyzeFileContent(filePath, content, snippet);
        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * UI INTEGRATION HELPERS
 */

// Initialize chat UI
function initChatUI() {
    const chatSection = document.getElementById('chat');
    if (!chatSection) return;

    const chatHTML = `
        <div class="chat-container">
            <div class="chat-messages" id="chatMessages">
                <div class="chat-welcome">
                    <div class="chat-welcome-icon">
                        <i data-lucide="bot"></i>
                    </div>
                    <h3>SEVE AI Assistant</h3>
                    <p>Expert guidance on secure data erasure, system health monitoring, and file analysis. Ask me anything about SEVE features and data security.</p>
                    <div class="chat-suggestions">
                        <button class="suggestion-chip" data-prompt="How do I securely erase a drive with SEVE?">
                            <i data-lucide="shield-x"></i> Secure Erase Guide
                        </button>
                        <button class="suggestion-chip" data-prompt="What's my current system health status?">
                            <i data-lucide="heart-pulse"></i> System Health
                        </button>
                        <button class="suggestion-chip" data-prompt="How does SEVE detect sensitive data in files?">
                            <i data-lucide="scan-search"></i> File Analysis
                        </button>
                        <button class="suggestion-chip" data-prompt="What security standards does SEVE use?">
                            <i data-lucide="shield-check"></i> Security Standards
                        </button>
                    </div>
                </div>
            </div>
            <div class="chat-input-container">
                <textarea 
                    id="chatInput" 
                    class="chat-input" 
                    placeholder="Ask SEVE anything..."
                    rows="1"
                ></textarea>
                <button id="chatSendBtn" class="chat-send-btn">
                    <i data-lucide="send"></i>
                </button>
            </div>
        </div>
    `;

    // Replace placeholder content
    const placeholder = chatSection.querySelector('.placeholder-content');
    if (placeholder) {
        placeholder.remove();
    }

    chatSection.insertAdjacentHTML('beforeend', chatHTML);

    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // Set up event listeners
    setupChatListeners();
}

// Initialize performance UI
function initPerformanceUI() {
    const perfSection = document.getElementById('performance');
    if (!perfSection) return;

    const perfHTML = `
        <div class="performance-container">
            <div class="performance-actions">
                <button id="analyzePerformanceBtn" class="btn btn-primary">
                    <i data-lucide="zap"></i> Analyze Performance
                </button>
            </div>
            <div id="performanceInsights" class="performance-insights">
                <div class="insight-placeholder">
                    <i data-lucide="gauge"></i>
                    <p>Click "Analyze Performance" to get AI-powered optimization recommendations</p>
                </div>
            </div>
            <div class="performance-metrics-grid" id="performanceMetrics">
                <!-- Will be populated with detailed metrics -->
            </div>
        </div>
    `;

    // Replace placeholder content
    const placeholder = perfSection.querySelector('.placeholder-content');
    if (placeholder) {
        placeholder.remove();
    }

    perfSection.insertAdjacentHTML('beforeend', perfHTML);

    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // Set up event listeners
    setupPerformanceListeners();
}

// Chat event listeners
function setupChatListeners() {
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    const chatMessages = document.getElementById('chatMessages');

    if (!chatInput || !sendBtn || !chatMessages) return;

    const chat = new SEVEChat();

    // Auto-resize textarea
    chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // Send message
    async function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        console.log('[Chat UI] Sending message:', message);

        // Add user message to UI
        addMessageToUI('user', message);
        chatInput.value = '';
        chatInput.style.height = 'auto';

        // Show typing indicator
        const typingId = addTypingIndicator();

        try {
            console.log('[Chat UI] Calling electronAPI.aiChat...');
            const result = await chat.sendMessage(message);
            
            console.log('[Chat UI] Got result:', result);
            
            // Remove typing indicator
            removeTypingIndicator(typingId);

            if (result.success) {
                addMessageToUI('assistant', result.response);
            } else {
                addMessageToUI('error', `Error: ${result.error || 'Unknown error'}`);
            }
        } catch (err) {
            console.error('[Chat UI] Exception:', err);
            removeTypingIndicator(typingId);
            addMessageToUI('error', `Error: ${err.message}`);
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    
    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Suggestion chips
    document.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', function() {
            const prompt = this.getAttribute('data-prompt');
            chatInput.value = prompt;
            sendMessage();
        });
    });
}

// Performance event listeners
function setupPerformanceListeners() {
    const analyzeBtn = document.getElementById('analyzePerformanceBtn');
    if (!analyzeBtn) return;

    analyzeBtn.addEventListener('click', async function() {
        this.disabled = true;
        this.innerHTML = '<i data-lucide="loader-2"></i> Analyzing...';
        
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        try {
            // Get system health metrics
            const healthData = await window.electronAPI.getSystemHealth();
            
            if (!healthData.success) {
                throw new Error(healthData.error);
            }

            // Analyze with AI
            const analysis = await analyzePerformance(healthData.metrics);

            if (analysis.success) {
                displayPerformanceInsights(analysis.response, healthData.metrics);
            } else {
                throw new Error(analysis.error);
            }
        } catch (err) {
            displayPerformanceError(err.message);
        } finally {
            this.disabled = false;
            this.innerHTML = '<i data-lucide="zap"></i> Analyze Performance';
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
        }
    });
}

// UI helper functions
function addMessageToUI(role, content) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) {
        welcome.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}-message`;
    
    if (role === 'user') {
        messageDiv.innerHTML = `
            <div class="message-content">${escapeHtml(content)}</div>
            <div class="message-avatar">
                <i data-lucide="user"></i>
            </div>
        `;
    } else if (role === 'assistant') {
        messageDiv.innerHTML = `
            <div class="message-avatar">
                <i data-lucide="bot"></i>
            </div>
            <div class="message-content">${escapeHtml(content)}</div>
        `;
    } else if (role === 'error') {
        messageDiv.innerHTML = `
            <div class="message-avatar error">
                <i data-lucide="alert-circle"></i>
            </div>
            <div class="message-content">${escapeHtml(content)}</div>
        `;
    }

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

function addTypingIndicator() {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return null;

    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-message assistant-message typing';
    typingDiv.id = 'typing-indicator-' + Date.now();
    typingDiv.innerHTML = `
        <div class="message-avatar">
            <i data-lucide="bot"></i>
        </div>
        <div class="message-content">
            <div class="typing-dots">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;

    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    return typingDiv.id;
}

function removeTypingIndicator(id) {
    if (!id) return;
    const indicator = document.getElementById(id);
    if (indicator) {
        indicator.remove();
    }
}

function displayPerformanceInsights(insights, metrics) {
    const container = document.getElementById('performanceInsights');
    if (!container) return;

    container.innerHTML = `
        <div class="insights-card">
            <div class="insights-header">
                <i data-lucide="sparkles"></i>
                <h3>AI Performance Analysis</h3>
            </div>
            <div class="insights-content">
                ${escapeHtml(insights).replace(/\n/g, '<br>')}
            </div>
        </div>
    `;

    // Display detailed metrics
    displayPerformanceMetrics(metrics);

    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

function displayPerformanceMetrics(metrics) {
    const container = document.getElementById('performanceMetrics');
    if (!container) return;

    container.innerHTML = `
        <div class="metric-card">
            <h4>CPU Performance</h4>
            <div class="metric-value">${metrics.cpu.usage}%</div>
            <div class="metric-detail">${metrics.cpu.cores} cores @ ${metrics.cpu.speed} MHz</div>
        </div>
        <div class="metric-card">
            <h4>Memory Usage</h4>
            <div class="metric-value">${metrics.memory.usedPercent}%</div>
            <div class="metric-detail">${(metrics.memory.used / (1024**3)).toFixed(1)} / ${(metrics.memory.total / (1024**3)).toFixed(1)} GB</div>
        </div>
        <div class="metric-card">
            <h4>Disk Activity</h4>
            <div class="metric-value">${metrics.disk.activeTime}%</div>
            <div class="metric-detail">Active time</div>
        </div>
        <div class="metric-card">
            <h4>System Uptime</h4>
            <div class="metric-value">${metrics.uptime.formatted}</div>
            <div class="metric-detail">${metrics.processes} processes</div>
        </div>
    `;
}

function displayPerformanceError(error) {
    const container = document.getElementById('performanceInsights');
    if (!container) return;

    container.innerHTML = `
        <div class="insights-card error">
            <div class="insights-header">
                <i data-lucide="alert-circle"></i>
                <h3>Analysis Failed</h3>
            </div>
            <div class="insights-content">
                ${escapeHtml(error)}
            </div>
        </div>
    `;

    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize all AI features when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        initChatUI();
        initPerformanceUI();
    });
} else {
    initChatUI();
    initPerformanceUI();
}

// Export for use in other scripts
window.SEVEAIFeatures = {
    SEVEChat,
    generateFileRemarks,
    analyzePerformance,
    analyzeFileContent,
    initChatUI,
    initPerformanceUI
};
