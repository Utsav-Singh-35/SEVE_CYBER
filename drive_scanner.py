# -*- coding: utf-8 -*-
import argparse
import ctypes
import json
import os
import sys
import time
import shutil
import heapq
import subprocess
from pathlib import Path

# Drive types (Windows)
DRIVE_UNKNOWN = 0
DRIVE_NO_ROOT_DIR = 1
DRIVE_REMOVABLE = 2
DRIVE_FIXED = 3
DRIVE_REMOTE = 4
DRIVE_CDROM = 5
DRIVE_RAMDISK = 6

CATEGORY_MAP = {
    "Documents": {".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".txt",".rtf",".odt",".csv",".tsv"},
    "Media": {".jpg",".jpeg",".png",".gif",".bmp",".mp4",".mkv",".avi",".mov",".mp3",".wav",".flac"},
    "Archives": {".zip",".rar",".7z",".tar",".gz",".bz2",".xz"},
    "Executables": {".exe",".msi",".bat",".cmd",".ps1"},
}
CATEGORY_KEYS = list(CATEGORY_MAP.keys())

SENSITIVE_PATTERNS = ("password","passwd","creds","credential","secret","bank","account","aadhar","aadhaar","pan","upi","card")

# Caches to avoid repeated expensive calls
_CLUSTER_SIZE_CACHE = {}
_SECTOR_SIZE_CACHE = {}

def get_cluster_size(root):
    """Return bytes per cluster for a volume like 'E:\\'. Uses 'fsutil fsinfo ntfsinfo'."""
    try:
        vol = root.rstrip('\\')
        if vol in _CLUSTER_SIZE_CACHE:
            return _CLUSTER_SIZE_CACHE[vol]
        # First try a non-elevated-friendly way via PowerShell Get-Volume
        try:
            drive_letter = vol.rstrip(':')
            ps = f"(Get-Volume -DriveLetter {drive_letter}).AllocationUnitSize"
            psres = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], capture_output=True, text=True, timeout=5)
            val = (psres.stdout or "").strip()
            if val:
                sz = int(val)
                if sz > 0:
                    _CLUSTER_SIZE_CACHE[vol] = sz
                    return sz
        except Exception:
            pass
        # Second try: CIM Win32_Volume (more widely available than Get-Volume)
        try:
            ps = f"(Get-CimInstance -ClassName Win32_Volume -Filter \"DriveLetter='{vol}'\").AllocationUnitSize"
            psres = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], capture_output=True, text=True, timeout=5)
            val = (psres.stdout or "").strip()
            if val:
                sz = int(val)
                if sz > 0:
                    _CLUSTER_SIZE_CACHE[vol] = sz
                    return sz
        except Exception:
            pass
        # Fallback to fsutil (may require elevation)
        proc = subprocess.run(["cmd", "/c", f"fsutil fsinfo ntfsinfo {vol}"], capture_output=True, text=True)
        out = proc.stdout or ""
        import re
        m = re.search(r"Bytes Per Cluster\s*:\s*(\d+)", out)
        if m:
            sz = int(m.group(1))
            _CLUSTER_SIZE_CACHE[vol] = sz
            return sz
        # FAT/exFAT volumes: different command output
        proc_fat = subprocess.run(["cmd", "/c", f"fsutil fsinfo fat {vol}"], capture_output=True, text=True)
        out_fat = proc_fat.stdout or ""
        m2 = re.search(r"Bytes Per Cluster\s*:\s*(\d+)", out_fat)
        if m2:
            sz = int(m2.group(1))
            if sz > 0:
                _CLUSTER_SIZE_CACHE[vol] = sz
                return sz
    except Exception:
        pass
    # Safe default for many NTFS volumes; ensures offsets are computed even if exact value unavailable
    try:
        _CLUSTER_SIZE_CACHE[root.rstrip('\\')] = 4096
    except Exception:
        pass
    return 4096

def get_sector_size(root):
    """Return logical Bytes Per Sector for a volume like 'E:\\'."""
    try:
        vol = root.rstrip('\\')
        if vol in _SECTOR_SIZE_CACHE:
            return _SECTOR_SIZE_CACHE[vol]
        # Try fsutil first (works without admin typically)
        proc = subprocess.run(["cmd", "/c", f"fsutil fsinfo ntfsinfo {vol}"], capture_output=True, text=True)
        out = proc.stdout or ""
        import re
        m = re.search(r"Bytes Per Sector\s*:\s*(\d+)", out)
        if m:
            sz = int(m.group(1))
            if sz > 0:
                _SECTOR_SIZE_CACHE[vol] = sz
                return sz
        # Fallback: PowerShell (Get-Volume does not expose sector; assume 512 as conservative default)
    except Exception:
        pass
    return 512

def get_file_first_extent(path):
    """Return (lcn_start, clusters) using PowerShell + CSV, with robust fallbacks."""
    try:
        # Prefer PowerShell CSV (matches your manual test)
        ps = "fsutil file queryextents \"{0}\" csv" .format(path)
        proc_csv = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, text=True, timeout=5
        )
        out_csv = (proc_csv.stdout or "")
        err_csv = (proc_csv.stderr or "")
        
        # Check for errors
        if proc_csv.returncode != 0 or "error" in err_csv.lower():
            # Return None to indicate failure
            return None, None
            
        import re
        def to_int(s):
            try: return int(s, 0)
            except Exception: return int(s)

        # Normalize lines (strip BOM/whitespace)
        out_csv = out_csv.replace('\ufeff', '')
        lines = [ln.strip() for ln in out_csv.splitlines() if ln.strip()]
        for ln in lines:
            if "," in ln and not ln.lower().startswith("vcn,clusters"):
                parts = [p.strip() for p in ln.split(',')]
                if len(parts) >= 3:
                    vcn_val = to_int(parts[0])
                    clusters = to_int(parts[1])
                    lcn = to_int(parts[2])
                    # Validate that we got reasonable values
                    if lcn >= 0 and clusters >= 0:
                        return lcn, clusters

        # Fallback: CMD non-CSV (some builds print usable lines)
        proc = subprocess.run(["cmd", "/c", f"fsutil file queryextents \"{path}\""],
                              capture_output=True, text=True)
        out = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
        
        # Check for errors in output
        if "error" in out.lower() or proc.returncode != 0:
            return None, None
            
        lcn_m = re.search(r"Starting\s+Lcn\s*:\s*(0x[0-9A-Fa-f]+|\d+)", out)
        vcn_start_m = re.search(r"Starting\s+Vcn\s*:\s*(0x[0-9A-Fa-f]+|\d+)", out)
        vcn_next_m = re.search(r"Next\s+Vcn\s*:\s*(0x[0-9A-Fa-f]+|\d+)", out)
        def to_int2(s):
            try: return int(s, 0)
            except Exception: return int(s)
        if lcn_m and vcn_start_m and vcn_next_m:
            lcn = to_int2(lcn_m.group(1))
            vcn_start = to_int2(vcn_start_m.group(1))
            vcn_next = to_int2(vcn_next_m.group(1))
            clusters = max(0, vcn_next - vcn_start)
            if lcn >= 0 and clusters >= 0:
                return lcn, clusters
        vc = re.search(r"VCN\s*:\s*(0x[0-9A-Fa-f]+|\d+)\s+Clusters\s*:\s*(0x[0-9A-Fa-f]+|\d+)\s+LCN\s*:\s*(0x[0-9A-Fa-f]+|\d+)", out)
        if vc:
            vcn_val = to_int2(vc.group(1))
            clusters = to_int2(vc.group(2))
            lcn = to_int2(vc.group(3))
            if lcn >= 0 and clusters >= 0:
                return lcn, clusters
        nums = re.findall(r"(0x[0-9A-Fa-f]+|\d+)", out)
        if len(nums) >= 2:
            lcn = to_int2(nums[0])
            clusters = to_int2(nums[1])
            if lcn >= 0 and clusters >= 0:
                return lcn, clusters
    except Exception:
        pass
    return None, None

def human_readable_bytes(n):
    units = ['B','KB','MB','GB','TB','PB']
    size = float(n)
    idx = 0
    while size >= 1024 and idx < len(units)-1:
        size /= 1024.0
        idx += 1
    return f"{size:.2f} {units[idx]}"

def list_windows_drives(include_fixed=True, include_removable=True):
    drives = []
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_unicode_buffer(254)
    length = kernel32.GetLogicalDriveStringsW(ctypes.sizeof(buf), buf)
    drive_strings = buf[:length]
    for d in drive_strings.split('\x00'):
        if not d:
            continue
        dtype = kernel32.GetDriveTypeW(ctypes.c_wchar_p(d))
        if include_fixed and dtype == DRIVE_FIXED:
            drives.append(d)
        elif include_removable and dtype == DRIVE_REMOVABLE:
            drives.append(d)
    return drives

def ps_get_disk_info_for_drive(root):
    # Map logical drive (e.g., C:) -> Win32_DiskDrive with Model/InterfaceType/MediaType
    # MediaType is often empty; we infer NVMe/SSD from model/interface
    drive_letter = root.rstrip("\\")
    ps = f"""
$ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='{drive_letter}'"
if (-not $ld) {{ $null | ConvertTo-Json; exit }}
$part = $ld | Get-CimAssociatedInstance -Association Win32_LogicalDiskToPartition
$disk = $part | Get-CimAssociatedInstance -Association Win32_DiskDriveToDiskPartition | Select-Object -First 1 Model, InterfaceType, MediaType, Size
$disk | ConvertTo-Json -Depth 2
"""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0 and r.stdout.strip():
            j = json.loads(r.stdout)
            if isinstance(j, dict):
                return {
                    "model": (j.get("Model") or "").strip() or "Windows Drive",
                    "interface": (j.get("InterfaceType") or "").strip(),
                    "media_type_raw": (j.get("MediaType") or "").strip(),
                    "size": int(j.get("Size") or 0)
                }
    except Exception:
        pass
    return {"model": "Windows Drive", "interface": "", "media_type_raw": "", "size": 0}

def infer_media_type(model, interface, media_type_raw):
    # Normalize to HDD/SSD/NVMe if possible
    m = (model or "").upper()
    i = (interface or "").upper()
    raw = (media_type_raw or "").upper()

    if "NVME" in m or "NVME" in i:
        return "NVMe"
    if "SSD" in m or "SSD" in raw:
        return "SSD"
    if "SCSI" in i or "ATA" in i or "SATA" in i:
        # could be HDD or SSD; if no hints say HDD
        return "HDD"
    # fallback to HDD
    return "HDD"

def categorize_extension(ext):
    e = (ext or "").lower()
    for cat, exts in CATEGORY_MAP.items():
        if e in exts:
            return cat
    return "Other"

def safe_scandir(path):
    try:
        return os.scandir(path)
    except Exception:
        return []

def analyze_filesystem(root, time_budget_sec=8, top_n=8, min_large_bytes=100*1024*1024, progress_callback=None):
    start = time.time()
    total_files = 0
    total_dirs = 0
    skipped_errors = 0
    categories = {k: {"count": 0, "size": 0} for k in CATEGORY_KEYS}
    categories["Other"] = {"count": 0, "size": 0}

    # largest files via min-heap
    largest = []
    sensitive = []
    
    last_progress_time = start
    progress_interval = 0.5  # Emit progress every 0.5 seconds

    # We bound traversal by time budget to keep UI responsive
    def walk(path):
        nonlocal total_files, total_dirs, skipped_errors, largest, sensitive, last_progress_time
        if time.time() - start > time_budget_sec:
            return
        
        # Emit progress periodically
        current_time = time.time()
        if progress_callback and (current_time - last_progress_time) >= progress_interval:
            elapsed = current_time - start
            progress_pct = min(90, (elapsed / time_budget_sec) * 90)  # Cap at 90% during scan
            progress_callback(progress_pct, f"Scanned {total_files} files, {total_dirs} directories...")
            last_progress_time = current_time
        
        # dirs and files
        for entry in safe_scandir(path):
            try:
                if entry.is_dir(follow_symlinks=False):
                    total_dirs += 1
                    # prune system/protected dirs to reduce noise
                    name = entry.name.lower()  # no pruning
                    walk(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    total_files += 1
                    try:
                        size = entry.stat().st_size
                    except Exception:
                        size = 0
                    ext = Path(entry.name).suffix.lower()
                    cat = categorize_extension(ext)
                    categories.setdefault(cat, {"count": 0, "size": 0})
                    categories[cat]["count"] += 1
                    categories[cat]["size"] += size

                    # largest files
                    if size >= min_large_bytes:
                        item = (size, entry.path, entry.name)
                        if len(largest) < top_n:
                            heapq.heappush(largest, item)
                        else:
                            if item[0] > largest[0][0]:
                                heapq.heapreplace(largest, item)

                    # sensitive names
                    low = entry.name.lower()
                    if any(p in low for p in SENSITIVE_PATTERNS):
                        sensitive.append({
                            "type": "SensitiveName",
                            "name": entry.name,
                            "path": entry.path,
                            "readable_path": entry.path,
                            "size": size
                        })
                # else: ignore links, etc.
            except Exception:
                skipped_errors += 1

    walk(root)

    # produce UI-friendly lists
    largest_sorted = sorted(largest, key=lambda x: x[0], reverse=True)
    largest_out = [{
        "name": name,
        "path": path,
        "readable_path": path,
        "size": size
    } for size, path, name in largest_sorted]

    return {
        "total_files": total_files,
        "total_directories": total_dirs,
        "skipped_errors": skipped_errors,
        "categories": categories,
        "largest_files": largest_out,
        "sensitive_files": sensitive[:10]
    }

def emit_progress(percent, message):
    print(f"::progress::{percent}::{message}", flush=True)

def scan_drive_root(root, progress_callback=None):
    # Disk usage
    try:
        total, used, free = shutil.disk_usage(root)
    except Exception:
        total, used, free = 0, 0, 0
    usage_pct = (used / total * 100.0) if total > 0 else 0.0

    # Get physical disk info
    dinfo = ps_get_disk_info_for_drive(root)
    model = dinfo.get("model") or "Windows Drive"
    media_type = infer_media_type(model, dinfo.get("interface",""), dinfo.get("media_type_raw",""))

    # Analyze FS with a short budget for responsiveness
    fs_t0 = time.time()
    analysis = analyze_filesystem(root, time_budget_sec=60, progress_callback=progress_callback)
    fs_dt = time.time() - fs_t0

    drive_info = {
        "drive": root,
        "model": model,
        "filesystem": "NTFS/FAT/exFAT",
        "total_space_bytes": int(total),
        "used_space_bytes": int(used),
        "free_space_bytes": int(free),
        "total_space_human": human_readable_bytes(total),
        "used_space_human": human_readable_bytes(used),
        "free_space_human": human_readable_bytes(free),
        "usage_percentage": round(usage_pct, 1),
        "scan_mode": "Filesystem",
        "count_accuracy": "Partial" if analysis["skipped_errors"] > 0 else "Exact",
        "scan_duration_seconds": round(fs_dt, 1),
        "media_type": media_type,
        "file_analysis": analysis
    }
    return drive_info

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--electron", action="store_true")
    parser.add_argument("--list-drives", action="store_true")
    parser.add_argument("--scan", nargs="*")
    parser.add_argument("--search", nargs=2, metavar=("ROOT", "QUERY"))
    args = parser.parse_args()

    # Mode: search (returns JSON to stdout)
    if args.search:
        root, query = args.search
        start = time.time()
        q = (query or "").lower().strip()
        max_results = 500
        time_budget_sec = 20
        results = []
        cluster_size = get_cluster_size(root)
        sector_size = get_sector_size(root)

        def _safe_scandir(p):
            try:
                return os.scandir(p)
            except Exception:
                return []

        def walk(p):
            nonlocal results
            if time.time() - start > time_budget_sec or len(results) >= max_results:
                return
            for entry in _safe_scandir(p):
                try:
                    name_low = entry.name.lower()
                    path_low = entry.path.lower()
                    try:
                        from pathlib import Path as _P
                        ext = _P(entry.name).suffix.lower().lstrip('.')
                    except Exception:
                        ext = ''

                    # Match if query appears in name or full path, or equals extension (with/without dot)
                    if (q in name_low) or (q in path_low) or (q == ext) or ('.'+ext == q):
                        size = 0
                        try:
                            if entry.is_file(follow_symlinks=False):
                                size = entry.stat().st_size
                        except Exception:
                            size = 0
                        # Optional physical location (NTFS only); include partial info even without cluster size
                        phys = None
                        lcn, clusters = get_file_first_extent(entry.path)
                        if lcn is not None and clusters is not None:
                            calc_clusters = int(clusters)
                            # If clusters came back as 0 but we know size and cluster_size, approximate
                            if calc_clusters == 0 and cluster_size and size > 0:
                                import math
                                calc_clusters = max(1, math.ceil(size / float(cluster_size)))
                            phys = {
                                "ok": True,
                                "lcn_start": int(lcn),
                                "clusters": calc_clusters
                            }
                            if cluster_size:
                                try:
                                    offset = int(lcn) * int(cluster_size)
                                    # compute sector number if we have sector size
                                    sector_num = None
                                    try:
                                        if sector_size and sector_size > 0:
                                            sector_num = int(offset // int(sector_size))
                                    except Exception:
                                        sector_num = None
                                    phys.update({
                                        "cluster_size": int(cluster_size),
                                        "offset_bytes": int(offset),
                                        "sector_size": int(sector_size) if sector_size else None,
                                        "sector_number": int(sector_num) if sector_num is not None else None
                                    })
                                except Exception:
                                    pass

                        results.append({
                            "name": entry.name,
                            "path": entry.path,
                            "readable_path": entry.path,
                            "is_dir": entry.is_dir(follow_symlinks=False),
                            "size": size,
                            "physical_location": phys
                        })
                        if len(results) >= max_results:
                            return
                    if entry.is_dir(follow_symlinks=False):
                        walk(entry.path)
                    if len(results) >= max_results:
                        return
                except Exception:
                    pass

        if root:
            walk(root)
        print(json.dumps({"results": results}), flush=True)
        # Debug: also print a concise line to stderr for terminal visibility
        try:
            for r in results[:20]:
                phys = r.get("physical_location") or {}
                lcn = phys.get("lcn_start")
                cl = phys.get("clusters")
                off = phys.get("offset_bytes")
                csz = phys.get("cluster_size")
                sn = phys.get("sector_number")
                ssz = phys.get("sector_size")
                sys.stderr.write(f"[SEARCH] {r.get('name')} | LCN={lcn} Clusters={cl} Offset={off} ClusterSize={csz} Sector={sn} SectorSize={ssz}\n")
        except Exception:
            pass
        sys.exit(0)

    if args.list_drives:
        try:
            drives = list_windows_drives(include_fixed=True, include_removable=True)
            print(json.dumps({"drives": drives}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"drives": [], "error": str(e)}), ensure_ascii=False)
            sys.exit(1)
        sys.exit(0)

    if args.scan is not None:
        roots = args.scan if len(args.scan or []) > 0 else list_windows_drives()
        if not roots:
            emit_progress(0, "No drives found to scan")
            print("{}", flush=True)
            sys.exit(1)

        emit_progress(5, "Initializing scan...")
        drives_out = []
        per_drive_pct = 90 / max(1, len(roots))
        current_pct = 5
        t0 = time.time()
        
        for idx, root in enumerate(roots):
            drive_start_pct = current_pct
            drive_end_pct = 5 + per_drive_pct * (idx + 1)
            
            # Progress callback for this drive
            def drive_progress(sub_pct, msg):
                # Map sub_pct (0-90) to this drive's range
                actual_pct = drive_start_pct + (sub_pct / 90.0) * (drive_end_pct - drive_start_pct)
                emit_progress(int(actual_pct), f"{root}: {msg}")
            
            emit_progress(int(drive_start_pct), f"Starting scan of {root}...")
            d0 = time.time()
            info = scan_drive_root(root, progress_callback=drive_progress)
            # ensure each drive is at least counted as some time
            info["scan_duration_seconds"] = max(info.get("scan_duration_seconds", 0.0), round(time.time() - d0, 1))
            drives_out.append(info)
            current_pct = drive_end_pct

        emit_progress(95, "Finalizing report...")
        out = {
            "scanner_version": "2.2 Windows Enhanced",
            "total_drives": len(drives_out),
            "drives": drives_out,
            "user_remarks": {},
            "deletion_report": None,
            "total_scan_seconds": round(time.time() - t0, 1),
        }
        try:
            with open("drive_info.json", "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

        emit_progress(100, "Scan complete")
        sys.exit(0)

    parser.print_help()
    sys.exit(1)

if __name__ == "__main__":
    main()


def search_drive(root, query, max_results=200, time_budget_sec=12):
    import time
    start = time.time()
    q = (query or "").lower().strip()
    matches = []
    if not q:
        return {"results": []}
    def walk(path):
        nonlocal matches
        if time.time() - start > time_budget_sec:
            return
        for entry in safe_scandir(path):
            try:
                name_low = entry.name.lower()
                if q in name_low:
                    try:
                        size = entry.stat().st_size if entry.is_file(follow_symlinks=False) else 0
                    except Exception:
                        size = 0
                    matches.append({
                        "name": entry.name,
                        "path": entry.path,
                        "readable_path": entry.path,
                        "is_dir": entry.is_dir(follow_symlinks=False),
                        "size": size
                    })
                    if len(matches) >= max_results:
                        return
                if entry.is_dir(follow_symlinks=False):
                    walk(entry.path)
                if len(matches) >= max_results:
                    return
            except Exception:
                pass
    walk(root)
    return {"results": matches}

## legacy CLI search handler removed; handled inside main()


