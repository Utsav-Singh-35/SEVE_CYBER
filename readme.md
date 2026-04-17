# SEVE Desktop - Secure Erasure & Verification Engine

Military-grade secure data erasure tool with AI-powered analysis. Works 100% offline.

## Features

- 🔒 **Secure Data Erasure** - DOD 5220.22-M standard wiping
- 🤖 **AI-Powered Analysis** - Local LLM for system health, chat, and performance insights
- 📊 **System Health Monitoring** - Real-time CPU, memory, disk metrics
- 🔍 **File Search & Analysis** - Deep file scanning with sensitive data detection
- 📄 **Verification Reports** - PDF certificates for compliance
- 💬 **AI Chat Assistant** - SEVE-specific guidance and troubleshooting
- 🚀 **100% Offline** - No internet required, all AI runs locally

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Download AI Model

**Option A: Automatic (Recommended)**
```bash
python download_model.py
```

**Option B: Manual**
```bash
python -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='TheBloke/phi-2-GGUF', filename='phi-2.Q4_K_M.gguf', local_dir='models', local_dir_use_symlinks=False)"
```

Then rename the file:
```bash
# Windows
ren models\phi-2.Q4_K_M.gguf phi-2-q4.gguf

# Linux/Mac
mv models/phi-2.Q4_K_M.gguf models/phi-2-q4.gguf
```

**Verify download (should be 1.79 GB):**
```bash
dir models\phi-2-q4.gguf
```

### 3. Install Python Dependencies

```bash
pip install -r requirements.txt
```

Required packages:
- `llama-cpp-python==0.3.2` - Local LLM inference
- `huggingface-hub` - Model downloads
- Other dependencies in requirements.txt

### 4. Run the Application

```bash
npm start
```

---

## AI Features

### 1. Chat Interface
- Navigate to **Chat** section in sidebar
- Ask questions about SEVE, security, or system health
- Click suggestion chips for common queries
- Response time: 10-30 seconds

### 2. Performance Analysis
- Navigate to **Performance** section
- Click **"Analyze Performance"**
- Get AI-powered bottleneck analysis and recommendations

### 3. Health Summary
- Go to **Health** dashboard
- Click **"Refresh Health"**
- AI analyzes system metrics and provides insights

### 4. File Analysis (API Ready)
- Sensitive data detection in files
- Risk level assessment
- Integration with file search coming soon

---

## Configuration

### Environment Variables (.env)

```env
SEVE_OFFLINE=1              # Force local AI (no API calls)
SEVE_SKIP_ELEVATION=1       # Skip admin elevation (dev only)
MONGODB_URI=your_uri        # Optional: MongoDB for CPU database
OPENROUTER_API_KEY=your_key # Optional: Fallback API (not used if SEVE_OFFLINE=1)
```

### AI Model Configuration

- **Model:** phi-2-q4.gguf (Microsoft Phi-2, 4-bit quantized)
- **Size:** 1.79 GB
- **Context:** 2048 tokens
- **Memory:** ~2.5 GB RAM required
- **Performance:** 10-30 seconds per response on modern CPU

---

## Testing

### Test AI Backend
```bash
node test_integration.js
```

### Test Chat Functionality
```bash
node test_chat.js
```

### Check Logs
```bash
type electron.log
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│         Electron Main Process           │
│  ├─ IPC Handlers                        │
│  ├─ local_ai_chat.js                    │
│  └─ llm_client.js                       │
│      └─ Spawns Python subprocess        │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│         Python Subprocess               │
│  llm_service.py                         │
│  ├─ Loads phi-2-q4.gguf                 │
│  ├─ JSON stdin/stdout communication     │
│  └─ llama-cpp-python inference          │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│         Renderer Process (UI)           │
│  ├─ ai_features.js (Chat, Performance)  │
│  ├─ ai_styles.css                       │
│  └─ index.html                          │
└─────────────────────────────────────────┘
```

---

## Troubleshooting

### Model Not Found
```bash
# Verify file exists and is correct size
dir models\phi-2-q4.gguf
# Should show: 1,789,239,136 bytes

# Re-download if needed
python download_model.py
```

### Chat Timeout
- First response takes longer (model loading)
- Subsequent responses are faster
- Check `electron.log` for errors

### Out of Memory
- Model requires ~2.5 GB RAM
- Close other applications
- Consider upgrading RAM if < 8 GB total

### Python Service Fails
```bash
# Test Python directly
python test_direct.py

# Verify llama-cpp-python
python -c "from llama_cpp import Llama; print('OK')"
```

---

## Development

### Project Structure
```
SEVE-SaaS/
├── src1/                    # Main application code
│   ├── main.js             # Electron main process
│   ├── preload.js          # IPC bridge
│   ├── llm_client.js       # Python subprocess client
│   ├── local_ai_chat.js    # Chat backend
│   ├── local_ai.js         # Health summary
│   └── renderer/           # UI code
│       ├── index.html
│       ├── script.js
│       ├── ai_features.js  # AI UI components
│       └── ai_styles.css
├── models/                  # AI models (not in git)
│   └── phi-2-q4.gguf       # Download separately
├── llm_service.py          # Python LLM service
├── drive_scanner.py        # Drive scanning
├── wipe_utils.py           # Secure deletion
└── report/                 # PDF report generation
```

### Build for Production
```bash
npm run build
```

---

## Performance Benchmarks

### Model Loading
- **First load:** 1-2 seconds
- **Memory usage:** ~2.5 GB RAM
- **Disk space:** 1.79 GB

### Inference Speed (CPU)
- **50 tokens:** ~5 seconds
- **100 tokens:** ~12 seconds
- **200 tokens:** ~20-30 seconds

### System Requirements
- **Minimum:** 4 GB RAM, 2013+ CPU (AVX2 support)
- **Recommended:** 8 GB RAM, modern multi-core CPU
- **Disk:** 5 GB free space (2 GB for model + overhead)

---

## Security

- ✅ **100% Offline** - No data leaves your machine
- ✅ **Local AI** - All inference runs on your hardware
- ✅ **DOD Standard** - Military-grade secure deletion
- ✅ **No Telemetry** - Zero tracking or analytics
- ✅ **Open Source** - Audit the code yourself

---

## License

[Your License Here]

---

## Support

For issues or questions:
1. Check `electron.log` for errors
2. Run test scripts to verify setup
3. See `models/README.md` for model download help
4. Review `AI_WORKING_STATUS.md` for feature status

---

**Built for hackathon demo - January 2026**
