// llm_client.js - Node.js client for Python LLM service
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class LLMClient {
  constructor() {
    this.process = null;
    this.ready = false;
    this.commandQueue = [];
    this.pendingCallbacks = new Map();
    this.commandId = 0;
  }

  /**
   * Start the Python LLM service
   */
  async start() {
    if (this.process) {
      return { success: true, message: 'Already started' };
    }

    return new Promise((resolve, reject) => {
      try {
        const scriptPath = path.join(__dirname, '..', 'llm_service.py');
        const pythonExe = process.env.PYTHON || 'python';

        console.log('[LLM Client] Starting Python service:', scriptPath);

        this.process = spawn(pythonExe, [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Set up readline for line-by-line JSON parsing
        const rl = readline.createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity
        });

        rl.on('line', (line) => {
          try {
            const response = JSON.parse(line);
            this.handleResponse(response);
          } catch (err) {
            console.error('[LLM Client] Failed to parse response:', line);
          }
        });

        this.process.stderr.on('data', (data) => {
          console.log('[LLM Service]', data.toString().trim());
        });

        this.process.on('error', (err) => {
          console.error('[LLM Client] Process error:', err);
          this.ready = false;
        });

        this.process.on('exit', (code) => {
          console.log('[LLM Client] Process exited with code:', code);
          this.ready = false;
          this.process = null;
        });

        // Give it a moment to start
        setTimeout(() => {
          this.ready = true;
          resolve({ success: true });
        }, 500);

      } catch (err) {
        reject({ success: false, error: err.message });
      }
    });
  }

  /**
   * Send command to Python service
   */
  async sendCommand(action, params = {}) {
    if (!this.ready || !this.process) {
      throw new Error('LLM service not ready');
    }

    return new Promise((resolve, reject) => {
      const id = this.commandId++;
      const command = { action, ...params, _id: id };

      console.log(`[LLM Client] Sending command ${id}:`, action);
      this.pendingCallbacks.set(id, { resolve, reject });

      const commandStr = JSON.stringify(command) + '\n';
      this.process.stdin.write(commandStr);

      // Timeout after 180 seconds (3 minutes for model loading)
      setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          console.error(`[LLM Client] Command ${id} timed out after 180s`);
          reject(new Error('Command timeout (180s) - model may be loading'));
        }
      }, 180000);
    });
  }

  /**
   * Handle response from Python service
   */
  handleResponse(response) {
    const id = response._id;
    console.log(`[LLM Client] Received response for command ${id}`);
    if (id !== undefined && this.pendingCallbacks.has(id)) {
      const { resolve } = this.pendingCallbacks.get(id);
      this.pendingCallbacks.delete(id);
      resolve(response);
    } else {
      console.warn(`[LLM Client] No pending callback for response ID ${id}`);
    }
  }

  /**
   * Load model
   */
  async loadModel(modelPath) {
    return await this.sendCommand('load', { model_path: modelPath });
  }

  /**
   * Generate text
   */
  async generate(prompt, options = {}) {
    return await this.sendCommand('generate', {
      prompt,
      max_tokens: options.maxTokens || 500,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9,
      top_k: options.topK || 40
    });
  }

  /**
   * Stop the service
   */
  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

// Singleton instance
let client = null;

function getClient() {
  if (!client) {
    client = new LLMClient();
  }
  return client;
}

module.exports = { LLMClient, getClient };
