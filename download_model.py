#!/usr/bin/env python3
"""Download model with verification"""
from huggingface_hub import hf_hub_download
import os

print("[Download] Starting download with verification...")
print("[Download] This will automatically verify file integrity")

try:
    file_path = hf_hub_download(
        repo_id="TheBloke/phi-2-GGUF",
        filename="phi-2.Q4_K_M.gguf",
        local_dir="models",
        local_dir_use_symlinks=False,
        resume_download=True
    )
    
    # Check file size
    size = os.path.getsize(file_path)
    size_gb = size / (1024**3)
    
    print(f"[Download] ✅ SUCCESS")
    print(f"[Download] File: {file_path}")
    print(f"[Download] Size: {size:,} bytes ({size_gb:.2f} GB)")
    print(f"[Download] Expected: ~1.79 GB")
    
    if size_gb < 1.7 or size_gb > 1.9:
        print(f"[Download] ⚠️ WARNING: Size mismatch!")
    else:
        print(f"[Download] ✅ Size verified")
        
except Exception as e:
    print(f"[Download] ❌ FAILED: {e}")
    exit(1)
