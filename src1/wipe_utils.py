import subprocess
import os
import json
import sys
import time

CREATE_NO_WINDOW = 0x08000000

def ps_json(cmd: str):
    try:
        result = subprocess.run(['powershell', '-Command', cmd], capture_output=True, text=True, check=True, creationflags=CREATE_NO_WINDOW)
        txt = (result.stdout or '').strip()
        if not txt:
            return {"success": False, "error": "Empty PowerShell output"}
        return {"success": True, "data": json.loads(txt)}
    except subprocess.CalledProcessError as e:
        return {"success": False, "error": f"PowerShell error: {e.stderr}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def has_powershell() -> bool:
    try:
        r = subprocess.run(['powershell', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
                           capture_output=True, text=True, creationflags=CREATE_NO_WINDOW, timeout=3)
        return r.returncode == 0
    except Exception:
        return False

def get_disk_info(drive_letter: str):
    """Return disk info for a drive letter: Number, MediaType, BusType, DriveType, IsRemovable."""
    dl = drive_letter.replace(':', '').replace('\\', '')
    # Query partition->disk plus volume info
    cmd_disk = f"Get-Partition -DriveLetter {dl} | Get-Disk | Select-Object Number, MediaType, BusType | ConvertTo-Json"
    cmd_vol = f"Get-Volume -DriveLetter {dl} | Select-Object DriveType, FileSystemLabel, FileSystem | ConvertTo-Json"
    d = ps_json(cmd_disk)
    v = ps_json(cmd_vol)
    if not d.get('success'):
        return d
    data = d['data']
    if isinstance(data, list):
        data = data[0] if data else {}
    info = {
        'Number': data.get('Number'),
        'MediaType': data.get('MediaType') or 'Unknown',
        'BusType': data.get('BusType') or 'Unknown',
        'DriveType': None,
        'IsRemovable': False,
    }
    if v.get('success'):
        vd = v['data']
        if isinstance(vd, list):
            vd = vd[0] if vd else {}
        info['DriveType'] = vd.get('DriveType')
        # DriveType: Removable, Fixed, Network, CD-ROM, etc.
        info['IsRemovable'] = (str(vd.get('DriveType') or '').lower() == 'removable')
    # Heuristic: mark OS drive (C:) to guard Level 2 policy
    info['IsOS'] = (dl.upper() == 'C')
    return {"success": True, "data": info}

def emit_progress(percent: int, message: str):
    percent = max(0, min(100, int(percent)))
    sys.stdout.write(f"::progress::{percent}::{message}\n")
    sys.stdout.flush()

def _enumerate_all_folders_with_sizes(root: str):
    """Enumerate ALL folders under root with cumulative sizes using bottom-up aggregation."""
    sizes = {}
    folders = []
    try:
        # Bottom-up walk so children sizes are available before parents
        for dirpath, dirnames, filenames in os.walk(root, topdown=False):
            # Sum files in this directory
            total = 0
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                try:
                    total += os.path.getsize(fp)
                except Exception:
                    pass
            # Add sizes of subdirs
            for dn in dirnames:
                child = os.path.join(dirpath, dn)
                total += sizes.get(child, 0)
            sizes[dirpath] = total
            # Skip adding the drive root itself as a folder entry
            if dirpath.rstrip('\\/').lower() != root.rstrip('\\/').lower():
                folders.append({
                    'name': os.path.basename(dirpath.rstrip('\\/')) or dirpath,
                    'path': dirpath,
                    'size_bytes': int(total)
                })
    except Exception:
        pass
    # Sort by path for reproducibility or by size desc if preferred
    folders.sort(key=lambda x: x.get('path',''))
    return folders

EXCLUDED_DIR_NAMES = set(['System Volume Information', '$Recycle.Bin', 'Recovery', 'FOUND.000'])

def _should_exclude_dir(path: str) -> bool:
    base = os.path.basename(path.rstrip('\\/'))
    return base in EXCLUDED_DIR_NAMES

def enumerate_all_files(root: str):
    """Yield tuples (path, size) for all files under root, excluding known system dirs."""
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        # filter excluded dirs in-place
        dirnames[:] = [d for d in dirnames if not _should_exclude_dir(os.path.join(dirpath, d))]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                sz = os.path.getsize(fp)
            except Exception:
                sz = 0
            yield (fp, sz)

def delete_all_files(root: str):
    """Delete all files (excluding system dirs). Returns (items, counts)."""
    items = []
    total = 0
    deleted = 0
    failed = 0
    # First gather list for stable progress
    file_list = list(enumerate_all_files(root))
    n = len(file_list)
    last_pct = -1
    for idx, (fp, sz) in enumerate(file_list, 1):
        total += 1
        try:
            os.remove(fp)
            items.append({"path": fp, "name": os.path.basename(fp), "size": int(sz), "success": True})
            deleted += 1
        except Exception as e:
            items.append({"path": fp, "name": os.path.basename(fp), "size": int(sz), "success": False, "error": str(e)})
            failed += 1
        # coarse progress at 5..20% range reserved for deletion
        pct = 5 + int(idx / max(1, n) * 15)
        if pct != last_pct:
            emit_progress(pct, f"Deleting files {idx}/{n}")
            last_pct = pct
    # Remove empty directories bottom-up (best-effort)
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        if _should_exclude_dir(dirpath):
            continue
        try:
            if not os.listdir(dirpath):
                os.rmdir(dirpath)
        except Exception:
            pass
    return items, {"total": total, "deleted": deleted, "failed": failed}

# ===== Level 3 (OS drive) helpers =====
SAFE_USER_SUBDIRS = [
    'Downloads', 'Documents', 'Desktop', 'Pictures', 'Videos', 'Music'
]

OPTIONAL_CACHE_SUBDIRS = [
    os.path.join('AppData', 'Local', 'Temp'),
    os.path.join('AppData', 'Local', 'Microsoft', 'Windows', 'INetCache'),
    os.path.join('AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
    os.path.join('AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
    os.path.join('AppData', 'Local', 'Mozilla', 'Firefox', 'Profiles'),
]

def list_level3_targets(os_root: str):
    targets = []
    users_root = os.path.join(os_root, 'Users')
    try:
        for user in os.listdir(users_root):
            upath = os.path.join(users_root, user)
            if not os.path.isdir(upath):
                continue
            # Standard libraries
            for sub in SAFE_USER_SUBDIRS:
                p = os.path.join(upath, sub)
                if os.path.isdir(p):
                    targets.append(p)
            # Optional caches
            for sub in OPTIONAL_CACHE_SUBDIRS:
                p = os.path.join(upath, sub)
                if os.path.isdir(p):
                    targets.append(p)
    except Exception:
        pass
    # System temp (best-effort)
    sys_temp = os.path.join(os_root, 'Windows', 'Temp')
    if os.path.isdir(sys_temp):
        targets.append(sys_temp)
    # Recycle Bin contents under $Recycle.Bin\<SID>\*
    rb_root = os.path.join(os_root, '$Recycle.Bin')
    try:
        for sid in os.listdir(rb_root):
            sp = os.path.join(rb_root, sid)
            if os.path.isdir(sp):
                targets.append(sp)
    except Exception:
        pass
    # Deduplicate while preserving order
    seen = set()
    uniq = []
    for t in targets:
        if t not in seen:
            uniq.append(t)
            seen.add(t)
    return uniq

def delete_in_targets(targets: list):
    items = []
    totals = {"total": 0, "deleted": 0, "failed": 0}
    if not targets:
        return items, totals
    n_targets = len(targets)
    for i, t in enumerate(targets, 1):
        # Enumerate files in this target and delete
        file_list = list(enumerate_all_files(t))
        m = len(file_list)
        for j, (fp, sz) in enumerate(file_list, 1):
            totals["total"] += 1
            try:
                os.remove(fp)
                items.append({"path": fp, "name": os.path.basename(fp), "size": int(sz), "success": True})
                totals["deleted"] += 1
            except Exception as e:
                items.append({"path": fp, "name": os.path.basename(fp), "size": int(sz), "success": False, "error": str(e)})
                totals["failed"] += 1
            # progress across 5..35% for Level 3 deletions
            pct = 5 + int(((i-1) + (j/max(1,m))) / max(1, n_targets) * 30)
            emit_progress(min(35, pct), f"Clearing {i}/{n_targets}: {os.path.basename(t) or t}")
        # Try remove empty directories in this target
        for dirpath, dirnames, filenames in os.walk(t, topdown=False):
            try:
                if not os.listdir(dirpath):
                    os.rmdir(dirpath)
            except Exception:
                pass
    return items, totals

def free_space_zero_fill(drive_root: str, pattern: str = 'zeros'):
    """Fill free space with zeros (or random) using Python only. Returns summary JSON with folder listing."""
    # Normalize the incoming drive identifier into a canonical form like 'E:\\'
    raw = str(drive_root or '').strip().replace('/', '\\')
    drive_letter = None
    if len(raw) >= 2 and raw[1] == ':' and raw[0].isalpha():
        drive_letter = raw[0].upper()
    elif len(raw) >= 1 and raw[0].isalpha():
        # Accept plain 'E' as input
        drive_letter = raw[0].upper()
    if not drive_letter:
        return {"success": False, "error": f"Invalid drive root: {drive_root}"}
    root = f"{drive_letter}:\\"
    if not os.path.exists(root):
        return {"success": False, "error": f"Drive not accessible: {root}"}

    temp_dir = os.path.join(root, 'SEVE_FREEWIPE')
    try:
        os.makedirs(temp_dir, exist_ok=True)
    except Exception as e:
        return {"success": False, "error": f"Cannot create temp dir: {e}"}

    # Approximate free space using os.statvfs on posix; on Windows use ps
    total_written = 0
    files_created = 0
    start = time.time()
    block_size = 16 * 1024 * 1024  # 16 MB
    zero_block = b'\x00' * block_size

    # Try to query free space via PowerShell (works on Windows/Tiny11)
    approx_free = None
    try:
        ps = ps_json(f"(Get-Volume -Path '{root}').SizeRemaining | ConvertTo-Json")
        if ps.get('success') and isinstance(ps.get('data'), (int, float)):
            approx_free = int(ps['data'])
    except Exception:
        pass

    # Pre-wipe: enumerate ALL folders for reporting
    folders = _enumerate_all_folders_with_sizes(root)

    try:
        emit_progress(1, 'Initializing free-space wipe...')
        idx = 0
        while True:
            idx += 1
            file_path = os.path.join(temp_dir, f'chunk_{idx:06d}.tmp')
            try:
                with open(file_path, 'wb', buffering=0) as f:
                    written_this_file = 0
                    # Write large blocks until disk is full
                    while True:
                        try:
                            if pattern == 'random':
                                buf = os.urandom(block_size)
                            else:
                                buf = zero_block
                            f.write(buf)
                            written_this_file += len(buf)
                            total_written += len(buf)
                            files_created = idx
                            # Progress
                            if approx_free:
                                pct = min(99, int((total_written / max(1, approx_free)) * 100))
                            else:
                                # Fallback progress by time/file count
                                pct = min(99, 5 + int((idx % 20) * 4))
                            elapsed = max(0.001, time.time() - start)
                            speed = total_written / elapsed
                            msg = f'Wrote {total_written} bytes ({files_created} files) at {int(speed/1_000_000)} MB/s'
                            emit_progress(pct, msg)
                        except OSError as oe:
                            # Disk likely full; break this file
                            break
                # If file has 0 size due to immediate full, stop
                if written_this_file == 0:
                    os.remove(file_path)
                    break
            except OSError:
                # Cannot create file: assume full
                break
        emit_progress(99, 'Finalizing and cleaning up...')
    finally:
        # Cleanup: delete all created files and directory
        try:
            for name in os.listdir(temp_dir):
                try:
                    os.remove(os.path.join(temp_dir, name))
                except Exception:
                    pass
            os.rmdir(temp_dir)
        except Exception:
            pass

    # Verification (sampled): not reopening free space directly; we trust the write operations
    emit_progress(100, 'Free-space wipe complete')
    return {
        "success": True,
        "message": f"Zero-fill complete on {root}",
        "bytes_written": total_written,
        "files_created": files_created,
        "duration_sec": round(time.time() - start, 2),
        "pattern": pattern,
        "folders": folders,
    }

# ===== Single-file overwrite (Windows/Python, no external tools) =====
def overwrite_file(file_path: str, passes: int = 1, pattern: str = 'zeros'):
    try:
        if not os.path.exists(file_path):
            return {"success": False, "error": f"File not found: {file_path}"}
        if not os.path.isfile(file_path):
            return {"success": False, "error": f"Not a file: {file_path}"}
        size = os.path.getsize(file_path)
        if size <= 0:
            return {"success": True, "message": "File size is 0, nothing to overwrite.", "bytes_written": 0, "passes": 0}
        block = 8 * 1024 * 1024  # 8MB blocks
        emit_progress(1, f"Preparing overwrite: {os.path.basename(file_path)} ({size} bytes)")
        total_written = 0
        with open(file_path, 'r+b', buffering=0) as f:
            for p in range(1, max(1, int(passes)) + 1):
                pos = 0
                start_pass = time.time()
                while pos < size:
                    to_write = min(block, size - pos)
                    if pattern == 'random':
                        buf = os.urandom(to_write)
                    else:
                        buf = b'\x00' * to_write
                    f.seek(pos)
                    f.write(buf)
                    pos += to_write
                    total_written += to_write
                    # Progress per pass mapped into 5..95%
                    overall = 5 + int(((p - 1) + (pos / size)) / max(1, passes) * 90)
                    emit_progress(min(95, overall), f"Pass {p}/{passes}: {int(pos/1024/1024)} MB of {int(size/1024/1024)} MB")
                f.flush()
                try:
                    os.fsync(f.fileno())
                except Exception:
                    pass
        emit_progress(99, "Finalizing overwrite...")
        # Optional: truncate and restore size to touch MFT timestamps minimally (kept off)
        emit_progress(100, "Overwrite complete")
        return {"success": True, "message": "File overwritten successfully.", "bytes_written": total_written, "passes": passes, "pattern": pattern, "size": size}
    except PermissionError as e:
        return {"success": False, "error": f"Permission denied: {e}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def attempt_secure_erase(info: dict):
    """Best-effort placeholder for secure erase. Returns NotSupported for USB bridges."""
    bus = (info.get('BusType') or '').lower()
    if bus in ('usb', 'ieee1394', 'sd'):  # typically block ATA/NVMe sanitize
        return {"success": False, "error": "Secure Erase not supported via USB bridge", "code": "NotSupported"}
    media = (info.get('MediaType') or '').lower()
    # Here we would call vendor/NVMe sanitize. Not available in Tiny11 baseline.
    return {"success": False, "error": "Secure Erase tooling not available", "code": "NotAvailable"}

def format_volume(drive: str, fs: str = 'NTFS', label: str = 'SEVE_WIPED'):
    """Quick format a volume via PowerShell Format-Volume. Requires admin."""
    try:
        if not has_powershell():
            return {"success": False, "error": "PowerShell not available (Tiny11/bootable). Skipping format."}
        dl = drive.replace(':', '').replace('\\','')
        cmd = (
            f"Format-Volume -DriveLetter {dl} -FileSystem {fs} -NewFileSystemLabel '{label}' -Confirm:$false -Force | ConvertTo-Json"
        )
        emit_progress(2, f'Formatting {drive} to {fs}...')
        r = subprocess.run(['powershell', '-Command', cmd], capture_output=True, text=True, check=True, creationflags=CREATE_NO_WINDOW)
        return {"success": True, "data": (r.stdout or '').strip()}
    except subprocess.CalledProcessError as e:
        return {"success": False, "error": f"Format-Volume failed: {e.stderr or e.stdout}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def wipe_dispatch(level: int, drive: str, pattern: str = 'zeros'):
    info_res = get_disk_info(drive)
    if not info_res.get('success'):
        return info_res
    info = info_res['data']
    is_removable = info.get('IsRemovable', False)
    media_type = (info.get('MediaType') or '').lower()
    is_os = bool(info.get('IsOS'))

    # Level 1 policy:
    # - If removable (external), prefer secure erase when possible.
    # - Fallback to free-space zero-fill when secure erase is not available.
    # - For HDDs, Level 1 can be quick format + zero free-space; we implement the zero-fill part here.

    if level == 1 and is_removable:
        sec = attempt_secure_erase(info)
        if sec.get('success'):
            return sec
        # Fallback to zero-fill
        return free_space_zero_fill(drive, pattern='zeros')

    # Default behavior for Level 1 on non-removable or when not supported: zero-fill free space
    if level == 1:
        return free_space_zero_fill(drive, pattern=pattern or 'zeros')

    # Level 2 policy (Non-OS internal volumes D:, E:, F: ...):
    # - If HDD: quick format the volume, then zero-fill free space.
    # - If SSD: attempt secure erase; if unavailable/frozen, fall back to zero-fill.
    if level == 2:
        if is_os:
            return {"success": False, "error": "Level 2 is not allowed on OS volume"}
        # Treat non-removable as internal
        if 'hdd' in media_type or ('ssd' not in media_type):
            # TRUE CLEARING: pre-enumerate all files for report
            items = list(enumerate_all_files(drive))
            items_serialized = [{"path": p, "name": os.path.basename(p), "size": int(sz)} for (p, sz) in items]
            # Try to format if PowerShell exists; else delete files one-by-one
            if has_powershell():
                fmt = format_volume(drive, fs='NTFS', label='SEVE_WIPED')
                note = None
                if not fmt.get('success'):
                    note = f"Format skipped: {fmt.get('error','unknown')}"
                    emit_progress(3, f"{note}")
                    # fall back to file deletions for true clearing
                    del_items, del_counts = delete_all_files(drive)
                    items_serialized = del_items
                res = free_space_zero_fill(drive, pattern='zeros')
                # attach file report
                if isinstance(res, dict):
                    res['items'] = items_serialized
              
                    res['deleted'] = sum(1 for it in items_serialized if it.get('success', True))
                    res['failed'] = sum(1 for it in items_serialized if not it.get('success', True))
                    res['total'] = len(items_serialized)
                return res
            else:
                # No PowerShell (Tiny11/bootable): delete all files, then zero-fill
                del_items, del_counts = delete_all_files(drive)
                res = free_space_zero_fill(drive, pattern='zeros')
                if isinstance(res, dict):
                    res['items'] = del_items
                    res.update(del_counts)
                return res
        else:
            # SSD path
            sec = attempt_secure_erase(info)
            if sec.get('success'):
                return sec
            # Fallback: TRUE CLEARING for SSD when secure erase is unavailable
            # 1) Delete all files (best-effort, excluding system dirs)
            del_items, del_counts = delete_all_files(drive)
            # 2) Zero-fill free space
            fallback = free_space_zero_fill(drive, pattern='zeros')
            if isinstance(fallback, dict):
                fallback['items'] = del_items
                fallback.update(del_counts)
            return fallback

    # Level 5: free-space wipe explicitly
    if level == 5:
        return free_space_zero_fill(drive, pattern=pattern or 'zeros')

    # Level 3: OS drive safe clearing (C:) without breaking Windows
    if level == 3:
        if not is_os:
            # If not OS, default to Level 2 policy for safety
            return {"success": False, "error": "Level 3 is intended for OS drive only"}
        # Build targets and delete
        targets = list_level3_targets(drive)
        emit_progress(5, 'Enumerating OS data targets...')
        del_items, del_counts = delete_in_targets(targets)
        # Folders snapshot before zero-fill
        folders = _enumerate_all_folders_with_sizes(drive)
        # Zero-fill free space
        res = free_space_zero_fill(drive, pattern='zeros')
        if isinstance(res, dict):
            res['items'] = del_items
            res.update(del_counts)
            # Keep folders snapshot in result (already added by free_space_zero_fill)
            if 'folders' not in res:
                res['folders'] = folders
            res['operation'] = 'level_3_os_clear'
        return res

    return {"success": False, "error": f"Wipe level {level} not implemented"}

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description='SEVE Wipe Utility')
    parser.add_argument('--wipe', action='store_true', help='Run wipe flow')
    parser.add_argument('--level', type=int, help='Wipe level (1,5,...)')
    parser.add_argument('--drive', type=str, help='Drive root like E:\\')
    parser.add_argument('--pattern', type=str, default='zeros', help='zeros|random (for free-space)')
    parser.add_argument('--wipe-file', action='store_true', help='Overwrite a single file')
    parser.add_argument('--path', type=str, help='Path to file to overwrite')
    parser.add_argument('--passes', type=int, default=1, help='Number of overwrite passes')
    parser.add_argument('--get-drive-info', metavar='DRIVE', help='Get media and bus info for a drive')
    args = parser.parse_args()

    if args.wipe_file:
        if not args.path:
            print(json.dumps({"success": False, "error": "Missing --path"}))
            sys.exit(1)
        res = overwrite_file(args.path, passes=(args.passes or 1), pattern=(args.pattern or 'zeros'))
        print(json.dumps(res))
        sys.exit(0 if res.get('success') else 1)

    if args.get_drive_info:
        out = get_disk_info(args.get_drive_info)
        print(json.dumps(out))
        sys.exit(0)

    if args.wipe:
        if not args.level or not args.drive:
            print(json.dumps({"success": False, "error": "Missing --level or --drive"}))
            sys.exit(1)
        res = wipe_dispatch(args.level, args.drive, args.pattern)
        print(json.dumps(res))
        sys.exit(0 if res.get('success') else 1)

    print(json.dumps({"success": False, "error": "No action specified"}))
    sys.exit(1)
