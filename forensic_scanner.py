#!/usr/bin/env python3
"""
Forensic Scanner - Scans raw disk sectors for deleted files
"""
import sys
import json
import argparse

try:
    import win32file
    import win32con
except ImportError:
    print(json.dumps({
        'success': False,
        'error': 'pywin32 not installed. Run: pip install pywin32'
    }))
    sys.exit(1)

# File signatures with footers for carving
FILE_SIGNATURES = {
    # Images
    'JPEG': {'header': b'\xFF\xD8\xFF', 'footer': b'\xFF\xD9', 'max_size': 10*1024*1024},
    'PNG': {'header': b'\x89\x50\x4E\x47\x0D\x0A\x1A\x0A', 'footer': b'\x49\x45\x4E\x44\xAE\x42\x60\x82', 'max_size': 10*1024*1024},
    'GIF': {'header': b'\x47\x49\x46\x38', 'footer': b'\x00\x3B', 'max_size': 5*1024*1024},
    'BMP': {'header': b'\x42\x4D', 'footer': None, 'max_size': 50*1024*1024},
    
    # Documents
    'PDF': {'header': b'\x25\x50\x44\x46', 'footer': b'\x25\x25\x45\x4F\x46', 'max_size': 100*1024*1024},
    'DOC': {'header': b'\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1', 'footer': None, 'max_size': 50*1024*1024},
    'DOCX': {'header': b'\x50\x4B\x03\x04\x14\x00\x06\x00', 'footer': b'\x50\x4B\x05\x06', 'max_size': 50*1024*1024},
    'XLS': {'header': b'\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1', 'footer': None, 'max_size': 50*1024*1024},
    
    # Archives
    'ZIP': {'header': b'\x50\x4B\x03\x04', 'footer': b'\x50\x4B\x05\x06', 'max_size': 500*1024*1024},
    'RAR': {'header': b'\x52\x61\x72\x21\x1A\x07', 'footer': b'\xC4\x3D\x7B\x00\x40\x07\x00', 'max_size': 500*1024*1024},
    '7Z': {'header': b'\x37\x7A\xBC\xAF\x27\x1C', 'footer': None, 'max_size': 500*1024*1024},
    
    # Media
    'MP3': {'header': b'\xFF\xFB', 'footer': None, 'max_size': 50*1024*1024},
    'MP4': {'header': b'\x00\x00\x00\x18\x66\x74\x79\x70', 'footer': None, 'max_size': 500*1024*1024},
    'AVI': {'header': b'\x52\x49\x46\x46', 'footer': None, 'max_size': 500*1024*1024},
    'MKV': {'header': b'\x1A\x45\xDF\xA3', 'footer': None, 'max_size': 500*1024*1024},
    
    # Data
    'SQLITE': {'header': b'\x53\x51\x4C\x69\x74\x65\x20\x66\x6F\x72\x6D\x61\x74\x20\x33', 'footer': None, 'max_size': 100*1024*1024},
    'JSON': {'header': b'\x7B', 'footer': b'\x7D', 'max_size': 10*1024*1024},
    'XML': {'header': b'\x3C\x3F\x78\x6D\x6C', 'footer': b'\x3E', 'max_size': 10*1024*1024},
    
    # Executables
    'EXE': {'header': b'\x4D\x5A', 'footer': None, 'max_size': 100*1024*1024},
    
    # Text (no signature - detected by content analysis)
    'TXT': {'header': None, 'footer': None, 'max_size': 10*1024*1024},
    'LOG': {'header': None, 'footer': None, 'max_size': 10*1024*1024},
    'CSV': {'header': None, 'footer': None, 'max_size': 10*1024*1024},
}

def carve_file(drive_letter, start_sector, file_type):
    """Extract complete file from raw sectors using file carving"""
    try:
        sig = FILE_SIGNATURES.get(file_type)
        if not sig:
            raise ValueError(f"Unknown file type: {file_type}")
        
        # Read initial chunk
        chunk_size = 1024 * 1024  # 1MB chunks
        max_size = sig['max_size']
        footer = sig['footer']
        
        carved_data = bytearray()
        current_sector = start_sector
        
        while len(carved_data) < max_size:
            # Read chunk
            sectors_to_read = chunk_size // 512
            try:
                chunk = read_raw_sectors(drive_letter, current_sector, sectors_to_read)
            except:
                break
            
            carved_data.extend(chunk)
            current_sector += sectors_to_read
            
            # Check for footer
            if footer:
                footer_pos = carved_data.find(footer)
                if footer_pos != -1:
                    # Found footer, truncate and return
                    carved_data = carved_data[:footer_pos + len(footer)]
                    break
            
            # Stop if we've read enough
            if len(carved_data) >= max_size:
                carved_data = carved_data[:max_size]
                break
        
        return bytes(carved_data)
    
    except Exception as e:
        raise Exception(f"File carving failed: {str(e)}")

def view_file(drive, sector, file_type):
    """Extract and return file content for viewing"""
    try:
        data = carve_file(drive, sector, file_type)
        
        # For text-based files, decode to string
        if file_type in ['TXT', 'LOG', 'CSV', 'JSON', 'XML']:
            try:
                content = data.decode('utf-8', errors='ignore')
                return {
                    'success': True,
                    'type': 'text',
                    'content': content[:100000],  # Limit to 100KB for display
                    'size': len(data)
                }
            except:
                pass
        
        # For binary files, return base64 for images or hex for others
        import base64
        if file_type in ['JPEG', 'PNG', 'GIF', 'BMP']:
            return {
                'success': True,
                'type': 'image',
                'content': base64.b64encode(data).decode('ascii'),
                'size': len(data),
                'mime': f'image/{file_type.lower()}'
            }
        
        # For other files, return hex dump
        hex_dump = data[:4096].hex()  # First 4KB
        return {
            'success': True,
            'type': 'binary',
            'content': hex_dump,
            'size': len(data)
        }
    
    except Exception as e:
        return {
            'success': False,
            'error': f"Failed to view file: {str(e)}"
        }

def export_file(drive, sector, file_type, output_path):
    """Extract and save file to disk"""
    try:
        data = carve_file(drive, sector, file_type)
        
        with open(output_path, 'wb') as f:
            f.write(data)
        
        return {
            'success': True,
            'path': output_path,
            'size': len(data),
            'message': f'File exported successfully ({len(data)} bytes)'
        }
    
    except Exception as e:
        return {
            'success': False,
            'error': f"Export failed: {str(e)}"
        }

def wipe_file_sectors(drive, start_sector, sector_count, passes=3):
    """Permanently wipe sectors by overwriting with zeros"""
    try:
        # Validate inputs
        if not drive or len(drive) != 1 or not drive.isalpha():
            raise ValueError(f"Invalid drive letter: {drive}")
        
        if sector_count <= 0 or sector_count > 100000:
            raise ValueError(f"Invalid sector count: {sector_count}")
        
        drive_path = f'\\\\.\\{drive.upper()}:'
        
        # Open drive for writing
        try:
            handle = win32file.CreateFile(
                drive_path,
                win32con.GENERIC_WRITE,
                win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE,
                None,
                win32con.OPEN_EXISTING,
                0,
                None
            )
        except Exception as e:
            if 'Access is denied' in str(e):
                raise PermissionError(f"Access denied to drive {drive}:. Run as Administrator.")
            else:
                raise Exception(f"Failed to open drive {drive}:: {str(e)}")
        
        try:
            # Seek to start sector
            win32file.SetFilePointer(handle, start_sector * 512, win32file.FILE_BEGIN)
            
            # Overwrite with zeros (multiple passes)
            zero_data = b'\x00' * (sector_count * 512)
            
            for pass_num in range(passes):
                win32file.SetFilePointer(handle, start_sector * 512, win32file.FILE_BEGIN)
                win32file.WriteFile(handle, zero_data)
                win32file.FlushFileBuffers(handle)
                
                progress = int((pass_num + 1) / passes * 100)
                print(f"Progress: {progress}% - Pass {pass_num + 1}/{passes}", file=sys.stderr, flush=True)
            
            return {
                'success': True,
                'sectors_wiped': sector_count,
                'passes': passes,
                'message': f'Successfully wiped {sector_count} sectors with {passes} passes'
            }
        
        finally:
            win32file.CloseHandle(handle)
    
    except PermissionError as e:
        return {'success': False, 'error': str(e)}
    except Exception as e:
        return {'success': False, 'error': f"Wipe failed: {str(e)}"}

def read_raw_sectors(drive_letter, start_sector, count):
    """Read raw disk sectors"""
    try:
        # Validate drive letter
        if not drive_letter or len(drive_letter) != 1 or not drive_letter.isalpha():
            raise ValueError(f"Invalid drive letter: {drive_letter}")
        
        drive_path = f'\\\\.\\{drive_letter.upper()}:'
        
        try:
            handle = win32file.CreateFile(
                drive_path,
                win32con.GENERIC_READ,
                win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE,
                None,
                win32con.OPEN_EXISTING,
                0,
                None
            )
        except Exception as e:
            if 'Access is denied' in str(e):
                raise PermissionError(f"Access denied to drive {drive_letter}:. Run as Administrator.")
            elif 'The system cannot find the file specified' in str(e):
                raise FileNotFoundError(f"Drive {drive_letter}: not found or not accessible.")
            else:
                raise Exception(f"Failed to open drive {drive_letter}:: {str(e)}")
        
        try:
            # Seek to start sector
            win32file.SetFilePointer(handle, start_sector * 512, win32file.FILE_BEGIN)
            
            # Read sectors
            data = win32file.ReadFile(handle, count * 512)[1]
            
            return data
        finally:
            win32file.CloseHandle(handle)
    
    except PermissionError as e:
        raise e
    except FileNotFoundError as e:
        raise e
    except Exception as e:
        raise Exception(f"Error reading sectors: {str(e)}")

def find_signatures(data, start_sector):
    """Find file signatures in raw data"""
    found = []
    
    for ftype, sig_info in FILE_SIGNATURES.items():
        # Skip text files (no signature)
        if sig_info['header'] is None:
            continue
        
        sig = sig_info['header']
        offset = 0
        while True:
            offset = data.find(sig, offset)
            if offset == -1:
                break
            
            # Calculate actual sector and offset
            sector = start_sector + (offset // 512)
            sector_offset = offset % 512
            
            found.append({
                'type': ftype,
                'sector': sector,
                'offset': sector_offset,
                'absolute_offset': offset
            })
            
            offset += 1
    
    return found

def scan_unallocated(drive, sector_start, sector_count):
    """Scan unallocated space for deleted files"""
    try:
        print(f"Progress: 0% - Starting scan of drive {drive}:", file=sys.stderr, flush=True)
        
        data = read_raw_sectors(drive, sector_start, sector_count)
        
        print(f"Progress: 50% - Analyzing {len(data)} bytes", file=sys.stderr, flush=True)
        
        findings = find_signatures(data, sector_start)
        
        print(f"Progress: 100% - Scan complete", file=sys.stderr, flush=True)
        
        # Generate summary
        summary = {}
        for finding in findings:
            ftype = finding['type']
            summary[ftype] = summary.get(ftype, 0) + 1
        
        return {
            'success': True,
            'drive': drive,
            'sectors_scanned': sector_count,
            'bytes_scanned': len(data),
            'files_found': len(findings),
            'findings': findings,
            'summary': summary
        }
    
    except PermissionError as e:
        return {
            'success': False,
            'error': str(e)
        }
    except FileNotFoundError as e:
        return {
            'success': False,
            'error': str(e)
        }
    except Exception as e:
        return {
            'success': False,
            'error': f"Scan failed: {str(e)}"
        }

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Forensic disk scanner')
    parser.add_argument('--drive', help='Drive letter (e.g., C)')
    parser.add_argument('--start', type=int, default=1000, help='Starting sector')
    parser.add_argument('--count', type=int, default=10000, help='Number of sectors to scan')
    parser.add_argument('--view', action='store_true', help='View file content')
    parser.add_argument('--export', help='Export file to path')
    parser.add_argument('--wipe', action='store_true', help='Wipe sectors')
    parser.add_argument('--type', help='File type for view/export/wipe')
    parser.add_argument('--sector', type=int, help='Sector number for view/export/wipe')
    parser.add_argument('--passes', type=int, default=3, help='Wipe passes')
    
    args = parser.parse_args()
    
    if args.view:
        if not all([args.drive, args.sector, args.type]):
            print(json.dumps({'success': False, 'error': 'Missing required arguments for view'}))
        else:
            result = view_file(args.drive, args.sector, args.type)
            print(json.dumps(result, indent=2))
    
    elif args.export:
        if not all([args.drive, args.sector, args.type]):
            print(json.dumps({'success': False, 'error': 'Missing required arguments for export'}))
        else:
            result = export_file(args.drive, args.sector, args.type, args.export)
            print(json.dumps(result, indent=2))
    
    elif args.wipe:
        if not all([args.drive, args.sector, args.count]):
            print(json.dumps({'success': False, 'error': 'Missing required arguments for wipe'}))
        else:
            result = wipe_file_sectors(args.drive, args.sector, args.count, args.passes)
            print(json.dumps(result, indent=2))
    
    else:
        # Default: scan
        if not args.drive:
            print(json.dumps({'success': False, 'error': 'Drive letter required'}))
        else:
            result = scan_unallocated(args.drive, args.start, args.count)
            print(json.dumps(result, indent=2))
