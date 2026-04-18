# SEVE.AI — Secure Erase & Verification Engine

> Military-grade data destruction, forensic analysis, and real-time threat detection — 100% offline with a built-in AI assistant.

---

## Overview

SEVE is a Windows desktop security suite built on Electron. It combines two autonomous engines under one interface:

- **SEVE Engine** — adaptive data erasure, forensic recovery, browser privacy, and six real-time threat monitors
- **KAYO Engine** — AI-powered web application vulnerability scanner

No cloud. No telemetry. No internet dependency. All AI inference runs on-device.

---

## Engines

### SEVE Engine

| Module | Description |
|---|---|
| 5-Level Erasure | Adaptive data destruction — single-pass to 35-pass Gutmann |
| Forensic Scanner | Raw disk sector analysis, file carving from unallocated space |
| Browser Privacy | Cookie scanning and clearing for Chrome and Edge |
| Malware Detection | Watchdog-based real-time monitoring for ransomware and self-replicating threats |
| Network Monitor | Outgoing TCP/UDP connection frequency analysis for data leak detection |
| Exfiltration Detection | Correlates high file I/O reads with active network connections per process |
| Anomaly Detection | 3-sigma statistical baseline analysis across CPU, memory, disk, and network |
| System Health | Real-time health score (0–100) with AI-powered optimization recommendations |
| PDF Certificates | Tamper-resistant erasure verification reports with signature area |
| AI Chat | Offline Phi-2 assistant with live scan context awareness |

### KAYO Engine

AI-powered web app security scanner. Simulates real traffic, detects vulnerabilities, and generates AI-driven fix recommendations. Accessible via Developer mode toggle in the UI.

---

## Erasure Levels

| Level | Name | Passes | Target | Standard |
|---|---|---|---|---|
| L1 | Quick Erase | 1 | Removable media (USB, SD) | — |
| L2 | Standard Erase | 3 | Internal non-OS drives | — |
| L3 | Safe Clear | Free space only | OS volumes | — |
| L4 | DOD Standard | 7 | High-security requirements | DOD 5220.22-M |
| L5 | Gutmann Method | 35 | Maximum security | Forensic-proof |

All erasure levels include a verification pass and generate a PDF certificate on completion.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              Electron Main Process            │
│  src1/main.js — IPC handlers                 │
│  src1/local_ai_chat.js — Chat backend        │
│  src1/llm_client.js — Python subprocess mgr  │
│  src1/system_health.js — Health metrics      │
└──────────────────┬───────────────────────────┘
                   │ JSON stdin/stdout
┌──────────────────▼───────────────────────────┐
│              Python Subprocess Layer          │
│  llm_service.py — llama.cpp inference        │
│  forensic_scanner.py — Raw disk + carving    │
│  browser_analyzer.py — SQLite cookie access  │
│  malware_detector.py — watchdog filesystem   │
│  network_monitor.py — psutil connections     │
│  exfiltration_detector.py — I/O correlation  │
│  anomaly_detector.py — statistical analysis  │
│  drive_scanner.py — drive enumeration        │
│  wipe_utils.py — secure deletion             │
└──────────────────┬───────────────────────────┘
                   │ contextBridge IPC
┌──────────────────▼───────────────────────────┐
│              Renderer Process                 │
│  index.html — all UI sections                │
│  script.js — frontend logic                  │
│  ai_features.js — AI chat & performance UI   │
└──────────────────────────────────────────────┘
```

The main process spawns Python scripts as child processes. Communication is JSON over stdin/stdout. The embedded Python 3.12 runtime (`python/`) ships with the app for fully portable operation — no system Python required.

---

## Project Structure

```
seve-ai/
├── src1/
│   ├── main.js                  # Electron main process + all IPC handlers
│   ├── preload.js               # contextBridge (renderer ↔ main)
│   ├── llm_client.js            # Python LLM subprocess client
│   ├── local_ai_chat.js         # Chat session + context management
│   ├── local_ai.js              # Health summary AI
│   ├── ai_summary.js            # AI summary generation
│   ├── system_health.js         # CPU / memory / disk metrics (Node os module)
│   ├── cpu_lookup.js            # CPU benchmark lookup (MongoDB)
│   └── renderer/
│       ├── index.html           # Full UI — all sections in one file
│       ├── script.js            # Frontend logic + navigation
│       ├── ai_features.js       # AI chat & performance UI components
│       ├── styles.css           # Main design system
│       ├── ai_styles.css        # AI chat styles
│       └── browser_privacy.css  # Privacy analyzer styles
├── python/                      # Embedded Python 3.12 runtime (portable)
├── models/
│   └── phi-2-q4.gguf            # Quantized Phi-2 model (~1.79 GB)
├── report/
│   └── generate_seve_report.py  # PDF certificate generation (ReportLab)
├── assets/                      # Icons, logos, hero media
├── llm_service.py               # Python LLM inference — JSON stdin/stdout protocol
├── drive_scanner.py             # Drive enumeration and scanning
├── wipe_utils.py                # Secure deletion (shred subprocess)
├── forensic_scanner.py          # Raw disk sector access + file carving (pywin32)
├── browser_analyzer.py          # Chrome/Edge cookie scanning and clearing
├── malware_detector.py          # Watchdog-based malware detection
├── network_monitor.py           # TCP/UDP connection frequency monitoring
├── exfiltration_detector.py     # File I/O + network connection correlation
└── anomaly_detector.py          # Statistical anomaly detection (3-sigma)
```

---

## AI System

| Property | Value |
|---|---|
| Model | Microsoft Phi-2 (Q4 quantized) |
| Format | GGUF |
| File | `models/phi-2-q4.gguf` |
| Size | ~1.79 GB |
| Context window | 1024 tokens |
| Inference engine | llama-cpp-python |
| Execution | CPU-only |
| RAM usage | ~2.5 GB |

The AI chat is context-aware. The main process maintains a `sessionContext` object that aggregates live scan results — health metrics, browser privacy stats, forensic findings, and all threat alerts. This context is injected into every prompt so the AI can reason about the current system state.

Streaming is supported — tokens are emitted one-by-one via the JSON protocol and rendered in real time in the UI.

---

## Forensic Scanner

- Direct raw disk I/O via Windows API (`\\.\C:`) using pywin32
- Scans unallocated space only — no interference with active filesystem
- Configurable sector range (100 – 100,000 sectors)
- File signature detection across 15+ formats:

| Format | Signature |
|---|---|
| JPEG | `FF D8 FF` |
| PNG | `89 50 4E 47` |
| PDF | `25 50 44 46` |
| ZIP / DOCX | `50 4B 03 04` |
| RAR | `52 61 72 21` |
| 7Z | `37 7A BC AF` |
| AVI | `52 49 46 46` |
| MKV | `1A 45 DF A3` |
| SQLite | `53 51 4C 69` |
| + JSON, XML, TXT, LOG, CSV | pattern-based |

Actions per recovered file: **View** (image preview / text / hex dump), **Export** (save to disk), **Wipe** (3-pass sector overwrite).

---

## Threat Detection Modules

### Malware Detection
Monitors file creation events using Python `watchdog`. Tracks creation rate per process and alerts when >50 files are created within 60 seconds — indicative of ransomware encryption or worm propagation.

### Network Monitor
Tracks active TCP/UDP connections via `psutil`. Monitors connection frequency per process and alerts on high-frequency patterns (>10 connections/second). Logs destination IPs and PIDs.

### Exfiltration Detection
Correlates file I/O counters with active network connections per process. Alerts when a process reads >100 MB while maintaining active outbound connections. Severity classified as Critical or High.

### Anomaly Detection
Establishes a statistical baseline over a configurable window (default 5 minutes) for CPU, memory, disk read/write, and network send/receive. Monitors in real time and alerts on deviations beyond 3 standard deviations from the mean.

---

## Browser Privacy Analyzer

- Direct SQLite access to Chrome and Edge `Cookies` database files
- Risk classification per cookie:

| Risk Level | Criteria |
|---|---|
| Critical | Auth tokens, session cookies, credentials |
| High | Google Analytics, Facebook Pixel, DoubleClick, tracking patterns |
| Medium | General cookies with moderate privacy impact |
| Low | Functional cookies |

- Two clearing modes: **Clear Tracking Only** (preserves auth) and **Clear All** (with confirmation dialog)
- Detects browser lock — warns if the browser is open during scan

---

## System Health Score

Composite score (0–100) calculated from four weighted metrics:

| Metric | Weight |
|---|---|
| CPU usage | 30% |
| Memory usage | 30% |
| Disk activity | 20% |
| Disk space | 20% |

Score feeds into the AI summary for actionable optimization recommendations.

---

## Performance

### Erasure Throughput
| Level | Speed |
|---|---|
| L1 (1 pass) | ~500 MB/s |
| L2 (3 pass) | ~200 MB/s |
| L4 (7 pass) | ~100 MB/s |
| L5 (35 pass) | ~50 MB/s |

### Forensic Scan
- ~10,000 sectors/second
- ~5 MB/s raw disk read rate
- Signature detection: <1ms per sector

### AI Inference (CPU)
| Tokens | Time |
|---|---|
| 50 | ~5s |
| 100 | ~12s |
| 200 | ~20–30s |

- First token latency: ~200ms
- Model load time: 1–2 seconds

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electron 38 |
| Frontend | Vanilla JS, HTML5, CSS3, Lucide Icons |
| Main process | Node.js |
| AI inference | Python 3.12 + llama-cpp-python 0.3.2 |
| AI model | Microsoft Phi-2 (GGUF Q4) |
| PDF generation | jsPDF / ReportLab |
| File monitoring | Python watchdog 6.0 |
| System metrics | Python psutil 7.2 |
| Raw disk access | pywin32 311 |
| Image processing | Pillow 10.4 |
| Database | MongoDB (optional, CPU lookup), SQLite (browser cookies) |

---

## Compliance

| Standard | Coverage |
|---|---|
| DOD 5220.22-M | Level 4 (7-pass) erasure |
| NIST SP 800-88 | Media sanitization guidelines |
| GDPR | Right to erasure support |
| HIPAA | Secure data destruction for healthcare |

---

## Security Design

- All processing is local — no data leaves the machine at any point
- Admin privilege enforcement via PowerShell elevation on launch
- Confirmation dialogs required for all destructive and irreversible operations
- Verification pass runs after every erasure operation
- Full audit log written to `electron.log` with timestamps
- Browser cookie clearing preserves authentication cookies when using tracking-only mode

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 x64 | Windows 11 x64 |
| RAM | 4 GB | 8 GB+ |
| Disk | 5 GB free | 10 GB free |
| CPU | 2013+ with AVX2 | Modern multi-core |

Admin privileges required for erasure, forensic scanning, and raw disk access.

---

## License

MIT — Copyright © 2025 ByteCode
