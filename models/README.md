# SEVE AI Models

This directory contains the AI models used by SEVE for offline inference.

## Required Model

**File:** `phi-2-q4.gguf`  
**Size:** 1.79 GB  
**Source:** TheBloke/phi-2-GGUF on Hugging Face

## Download Instructions

### Option 1: Automatic Download (Recommended)

Run the download script:

```bash
python download_model.py
```

This will download the model to `models/phi-2-q4.gguf`.

### Option 2: Manual Download

1. Go to: https://huggingface.co/TheBloke/phi-2-GGUF
2. Download: `phi-2.Q4_K_M.gguf`
3. Rename to: `phi-2-q4.gguf`
4. Place in this directory

### Option 3: Using Python

```python
from huggingface_hub import hf_hub_download

hf_hub_download(
    repo_id="TheBloke/phi-2-GGUF",
    filename="phi-2.Q4_K_M.gguf",
    local_dir="models",
    local_dir_use_symlinks=False
)
```

Then rename the file to `phi-2-q4.gguf`.

## Verification

After download, verify the file:

```bash
# Windows
dir phi-2-q4.gguf

# Should show: 1,789,239,136 bytes (1.79 GB)
```

## Why Not in Git?

This file is **1.79 GB** and would:
- Bloat the repository
- Make cloning extremely slow
- Exceed Git hosting limits (usually 100 MB max)

Instead, download it separately after cloning the repository.

## Model Details

- **Architecture:** Phi-2 (Microsoft)
- **Quantization:** Q4_K_M (4-bit)
- **Context:** 2048 tokens
- **Use Case:** Offline AI inference for SEVE features
- **Performance:** ~10-30 seconds per response on modern hardware

## Troubleshooting

**Model not found error:**
- Verify file exists: `models/phi-2-q4.gguf`
- Check file size: Should be exactly 1,789,239,136 bytes
- Re-download if corrupted

**Out of memory:**
- Model requires ~2.5 GB RAM
- Close other applications
- Consider upgrading RAM

**Slow inference:**
- Normal for CPU inference
- First response takes longer (model loading)
- Subsequent responses are faster
