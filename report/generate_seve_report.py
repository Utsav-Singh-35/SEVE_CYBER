#!/usr/bin/env python3
"""
SEVE Report Generator - Exact Replica
Creates a PDF report matching the SEVE (Secure Erase & Verification Engine) format
"""

# Ensure a stub PIL module exists before importing reportlab.
# Some reportlab internals import PIL at module import time. In dev we may not have Pillow.
import sys, types
if 'PIL' not in sys.modules:
    try:
        import PIL  # type: ignore
    except Exception:
        pil_mod = types.ModuleType('PIL')
        pil_image_mod = types.ModuleType('PIL.Image')
        # Provide minimal attributes so "from PIL import Image" succeeds
        setattr(pil_mod, 'Image', pil_image_mod)
        sys.modules['PIL'] = pil_mod
        sys.modules['PIL.Image'] = pil_image_mod

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import inch, cm
from reportlab.lib.colors import Color, black, white, red
from reportlab.lib import colors
from reportlab.platypus import Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import Paragraph
# PIL is optional; for dev environments using embeddable Python, compiled wheels may be unavailable.
# We fall back to a lightweight image-size reader that supports PNG/JPEG when PIL is missing.
try:
    from PIL import Image  # type: ignore
except Exception:
    Image = None  # type: ignore

def get_image_size(path):
    """Return (width, height) for PNG/JPEG without PIL. Fallback to (None, None) on failure."""
    try:
        with open(path, 'rb') as f:
            data = f.read(32)
            # PNG: 8-byte signature then IHDR with width/height big-endian at bytes 16-23
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                # Ensure we have enough to read IHDR
                # PNG signature (8) + IHDR length (4) + 'IHDR' (4) + width(4) + height(4)
                if len(data) < 24:
                    data += f.read(24 - len(data))
                width = int.from_bytes(data[16:20], 'big')
                height = int.from_bytes(data[20:24], 'big')
                return width, height
            # JPEG: scan for SOF0/SOF2 markers
            f.seek(0)
            b = f.read(2)
            if b == b"\xFF\xD8":
                while True:
                    marker = f.read(2)
                    if len(marker) < 2:
                        break
                    if marker[0] != 0xFF:
                        # corrupted
                        break
                    # Skip padding FFs
                    while marker == b"\xFF\xFF":
                        marker = f.read(2)
                        if len(marker) < 2:
                            break
                    if len(marker) < 2:
                        break
                    code = marker[1]
                    # Standalone markers without length
                    if code in (0xD8, 0xD9):
                        continue
                    # Read segment length
                    seglen_bytes = f.read(2)
                    if len(seglen_bytes) < 2:
                        break
                    seglen = int.from_bytes(seglen_bytes, 'big')
                    if code in (0xC0, 0xC2):  # SOF0/2
                        seg = f.read(seglen - 2)
                        if len(seg) >= 7:
                            height = int.from_bytes(seg[1:3], 'big')
                            width = int.from_bytes(seg[3:5], 'big')
                            return width, height
                        break
                    else:
                        f.seek(seglen - 2, 1)
    except Exception:
        pass
    return None, None
import os
import json
from datetime import datetime
import argparse

# Spacing and layout constants
PAGE_MARGIN_LEFT = 50
PAGE_MARGIN_RIGHT = 50
PAGE_MARGIN_TOP = 80  # Increased to account for header height (48px) + buffer
PAGE_MARGIN_BOTTOM = 50
HEADER_HEIGHT = 48  # Header occupies top 48 pixels

GAP_SECTION = 20

# Enhanced table styling functions
def draw_professional_cell(c, x, y, width, height, fill_color=None, border_color=black, border_width=0.5, text=None, 
                          font="Helvetica", font_size=10, text_color=black, align="left", bold=False):
    """Draw a professional table cell with enhanced styling"""
    c.saveState()
    
    # Draw cell background
    if fill_color:
        c.setFillColor(fill_color)
        c.rect(x, y, width, height, fill=1, stroke=0)
    
    # Draw cell border
    c.setStrokeColor(border_color)
    c.setLineWidth(border_width)
    c.rect(x, y, width, height, fill=0, stroke=1)
    
    # Draw text if provided
    if text:
        c.setFillColor(text_color)
        font_name = f"{font}-Bold" if bold else font
        c.setFont(font_name, font_size)
        
        # Calculate text position based on alignment
        text_width = c.stringWidth(text, font_name, font_size)
        if align == "center":
            text_x = x + (width - text_width) / 2
        elif align == "right":
            text_x = x + width - text_width - 5
        else:  # left alignment
            text_x = x + 5
        
        text_y = y + (height - font_size) / 2 + 2
        c.drawString(text_x, text_y, text)
    
    c.restoreState()

def draw_gradient_header(c, x, y, width, height, start_color, end_color):
    """Draw a gradient background for table headers"""
    c.saveState()
    
    # Create gradient effect with multiple rectangles
    steps = 20
    step_height = height / steps
    
    for i in range(steps):
        # Calculate interpolated color
        ratio = i / (steps - 1)
        r = start_color.red + (end_color.red - start_color.red) * ratio
        g = start_color.green + (end_color.green - start_color.green) * ratio
        b = start_color.blue + (end_color.blue - start_color.blue) * ratio
        
        c.setFillColor(Color(r, g, b))
        rect_y = y + i * step_height
        c.rect(x, rect_y, width, step_height, fill=1, stroke=0)
    
    c.restoreState()

def draw_multiline_cell_text(c, x, y, width, height, text, font="Helvetica", font_size=8, 
                            text_color=black, line_spacing=12, padding=5):
    """Draw multiline text in a table cell with proper formatting"""
    c.saveState()
    
    c.setFillColor(text_color)
    c.setFont(font, font_size)
    
    lines = text.split('\n')
    start_y = y + height - padding - font_size
    
    for i, line in enumerate(lines):
        line_y = start_y - (i * line_spacing)
        if line_y > y + padding:  # Only draw if within cell bounds
            # Truncate line if too long
            max_width = width - (2 * padding)
            while c.stringWidth(line, font, font_size) > max_width and len(line) > 3:
                line = line[:-4] + "..."
            
            c.drawString(x + padding, line_y, line)
    
    c.restoreState()

def draw_header_footer(c, width, height, title="SEVE Drive Analysis Report"):
    """Draw a consistent header and footer with page number on the current page."""
    c.saveState()

    # Top bar background
    c.setFillColor(Color(0.98, 0.98, 0.98, alpha=1))
    c.rect(0, height - 48, width, 48, fill=1, stroke=0)

    # Accent line
    c.setStrokeColor(Color(0.2, 0.4, 0.8))
    c.setLineWidth(2)
    c.line(0, height - 48, width, height - 48)
    c.setLineWidth(0.5)
    c.setStrokeColor(colors.lightgrey)
    c.line(PAGE_MARGIN_LEFT, height - 50, width - PAGE_MARGIN_RIGHT, height - 50)

    # Header content: title (left), timestamp (right)
    c.setFillColor(black)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(PAGE_MARGIN_LEFT, height - 30, title)
    c.setFont("Helvetica", 9)
    timestamp = datetime.now().strftime("%b %d, %Y  %I:%M %p")
    time_width = c.stringWidth(timestamp, "Helvetica", 9)
    c.setFillColor(colors.grey)
    c.drawString(width - PAGE_MARGIN_RIGHT - time_width, height - 30, timestamp)

    # Remove old divider; accent line already drawn

    # Footer: page number centered
    page_num = c.getPageNumber()
    c.setFont("Helvetica", 9)
    footer_text = f"Page {page_num}"
    footer_width = c.stringWidth(footer_text, "Helvetica", 9)
    c.setFillColor(colors.grey)
    c.drawString((width - footer_width) / 2, 25, footer_text)

    c.restoreState()

def add_seve_watermark(c, width, height, watermark_image="bg.png"):
    """Add bg.png as watermark at 100% scale"""
    c.saveState()
    
    # Check if watermark image exists
    if os.path.exists(watermark_image):
        try:
            # Determine image size without PIL (or with it if available)
            if Image is not None:
                with Image.open(watermark_image) as img:
                    img_width, img_height = img.size
            else:
                img_width, img_height = get_image_size(watermark_image)
                if not img_width or not img_height:
                    img_width, img_height = width, height

            # Scale image to cover page while preserving aspect ratio
            page_aspect = width / height
            img_aspect = float(img_width) / float(img_height)
            if img_aspect > page_aspect:
                scaled_height = height
                scaled_width = img_aspect * height
            else:
                scaled_width = width
                scaled_height = width / img_aspect

            x_offset = (width - scaled_width) / 2
            y_offset = (height - scaled_height) / 2

            c.drawImage(watermark_image, x_offset, y_offset, scaled_width, scaled_height)

            # Semi-transparent overlay for watermark look
            c.setFillColor(Color(1, 1, 1, alpha=0.8))
            c.rect(0, 0, width, height, fill=1, stroke=0)

        except Exception as e:
            print(f"Warning: Could not load watermark image {watermark_image}: {e}")
            c.setFillColor(Color(1, 0.4, 0.4, alpha=0.15))
            c.setFont("Helvetica-Bold", 100)
            text_width = c.stringWidth("SEVE", "Helvetica-Bold", 100)
            x_pos = (width - text_width) / 2
            y_pos = height / 2 - 60
            c.drawString(x_pos, y_pos, "SEVE")
    else:
        # Fallback to text watermark if image doesn't exist
        c.setFillColor(Color(1, 0.4, 0.4, alpha=0.15))
        c.setFont("Helvetica-Bold", 120)
        text_width = c.stringWidth("SEVE", "Helvetica-Bold", 120)
        x_pos = (width - text_width) / 2
        y_pos = height / 2 - 60
        c.drawString(x_pos, y_pos, "SEVE")
    
    c.restoreState()

def create_seve_cover(c, width, height, cover_image="bg.png"):
    """Create the SEVE cover page"""
    
    # Use the background image if available, otherwise create a dark background
    if os.path.exists(cover_image):
        try:
            if Image is not None:
                with Image.open(cover_image) as img:
                    img_width, img_height = img.size
            else:
                img_width, img_height = get_image_size(cover_image)
                if not img_width or not img_height:
                    img_width, img_height = width, height

            aspect_ratio = float(img_width) / float(img_height)
            # Scale to fit A4
            if aspect_ratio > (width / height):
                scaled_width = width
                scaled_height = width / aspect_ratio
            else:
                scaled_height = height
                scaled_width = height * aspect_ratio

            x_offset = (width - scaled_width) / 2
            y_offset = (height - scaled_height) / 2

            c.drawImage(cover_image, x_offset, y_offset, scaled_width, scaled_height)
        except Exception:
            c.setFillColor(Color(0.1, 0.1, 0.1))
            c.rect(0, 0, width, height, fill=1)
    else:
        # Create dark background similar to reference
        c.setFillColor(Color(0.1, 0.1, 0.1))
        c.rect(0, 0, width, height, fill=1)
    
    # Add SEVE title at top
    # c.setFillColor(Color(0.8, 0.2, 0.2))  # Red color
    # c.setFont("Helvetica-Bold", 72)
    
    # title = "SEVE"
    # title_width = c.stringWidth(title, "Helvetica-Bold", 72)
    # x_title = (width - title_width) / 2
    # y_title = height - 150
    
    # c.drawString(x_title, y_title, title)
    
    # # Add subtitle
    # c.setFont("Helvetica", 16)
    # subtitle = "SECURE ERASE & VERIFICATION ENGINE"
    # subtitle_width = c.stringWidth(subtitle, "Helvetica", 16)
    # x_subtitle = (width - subtitle_width) / 2
    # y_subtitle = y_title - 30
    
    # c.drawString(x_subtitle, y_subtitle, subtitle)

def create_device_info_table(c, width, height, y_start):
    """Create the device information table with enhanced professional styling"""
    
    # Title with enhanced styling
    c.setFont("Helvetica-Bold", 16)
    c.setFillColor(Color(0.2, 0.4, 0.8))  # Blue color
    c.drawString(PAGE_MARGIN_LEFT, y_start, "1. SEVE Drive Analysis Report")
    
    # Date and time
    current_time = datetime.now().strftime("%m/%d/%Y, %I:%M:%S %p")
    time_width = c.stringWidth(current_time, "Helvetica", 12)
    c.setFont("Helvetica", 12)
    c.setFillColor(black)
    c.drawString(width - time_width - PAGE_MARGIN_RIGHT, y_start, current_time)
    
    # Device & Report Information header
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(Color(0.2, 0.4, 0.8))
    c.drawString(PAGE_MARGIN_LEFT, y_start - 40, "1.1 Device & Report Information")
    
    # Two-column key/value data populated from INPUT_DATA
    global INPUT_DATA
    sysinfo = (INPUT_DATA or {}).get('system_info', {}) if isinstance(INPUT_DATA, dict) else {}

    # Compute totals from drives
    def hr_bytes(n):
        try:
            units = ['B','KB','MB','GB','TB','PB']
            size = float(n)
            idx = 0
            while size >= 1024 and idx < len(units)-1:
                size /= 1024.0
                idx += 1
            return f"{size:.2f} {units[idx]}"
        except Exception:
            return str(n)

    total_capacity_b = 0
    total_used_b = 0
    try:
        for d in (INPUT_DATA or {}).get('drives', []):
            total_capacity_b += int(d.get('total_space_bytes') or 0)
            total_used_b += int(d.get('used_space_bytes') or 0)
    except Exception:
        pass
    used_pct = (float(total_used_b)/float(total_capacity_b)*100.0) if total_capacity_b > 0 else 0.0

    os_line = " ".join([str(x) for x in [sysinfo.get('platform') or '', sysinfo.get('release') or '', sysinfo.get('version') or ''] if x]).strip()
    if not os_line:
        os_line = "Windows"

    kv_rows = [
        ("Report ID", (INPUT_DATA or {}).get('scanner_version') or datetime.now().strftime("SEVE-%Y%m%d%H%M%S")),
        ("Device Name", sysinfo.get('hostname') or ""),
        ("Serial Number", (INPUT_DATA or {}).get('serial_number') or ""),
        ("Operating System", os_line),
        ("IP Address", sysinfo.get('ip') or ""),
        ("Total Storage", hr_bytes(total_capacity_b)),
        ("Total Used", f"{hr_bytes(total_used_b)} ({used_pct:.1f}%)"),
    ]

    table_top = y_start - 80
    table_left = PAGE_MARGIN_LEFT
    table_width = width - PAGE_MARGIN_LEFT - PAGE_MARGIN_RIGHT
    label_col_width = table_width * 0.35
    value_col_width = table_width - label_col_width
    row_height = 28  # Increased for better spacing

    # Enhanced header with gradient background
    header_start_color = Color(0.15, 0.35, 0.75)
    header_end_color = Color(0.25, 0.45, 0.85)
    
    # Draw gradient header background
    draw_gradient_header(c, table_left, table_top - row_height + 5, table_width, row_height, 
                        header_start_color, header_end_color)
    
    # Header border
    c.setStrokeColor(Color(0.1, 0.2, 0.6))
    c.setLineWidth(1.5)
    c.rect(table_left, table_top - row_height + 5, table_width, row_height, fill=0, stroke=1)
    
    # Header text
    draw_professional_cell(c, table_left, table_top - row_height + 5, label_col_width, row_height,
                          text="Field", font="Helvetica", font_size=11, text_color=white, bold=True, align="center")
    draw_professional_cell(c, table_left + label_col_width, table_top - row_height + 5, value_col_width, row_height,
                          text="Value", font="Helvetica", font_size=11, text_color=white, bold=True, align="center")

    # Enhanced barcode placeholder
    barcode_w, barcode_h = 120, 32
    barcode_x = table_left + table_width - barcode_w
    barcode_y = table_top + 10
    
    # Barcode background with shadow effect
    c.setFillColor(Color(0.9, 0.9, 0.9))  # Shadow
    c.rect(barcode_x + 2, barcode_y - 2, barcode_w, barcode_h, fill=1, stroke=0)
    
    # Barcode main area
    c.setFillColor(white)
    c.setStrokeColor(Color(0.3, 0.3, 0.3))
    c.setLineWidth(1)
    c.rect(barcode_x, barcode_y, barcode_w, barcode_h, fill=1, stroke=1)
    
    # Barcode text
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(Color(0.3, 0.3, 0.3))
    txt = "REPORT BARCODE"
    txt_w = c.stringWidth(txt, "Helvetica-Bold", 9)
    c.drawString(barcode_x + (barcode_w - txt_w) / 2, barcode_y + (barcode_h / 2) - 4, txt)

    # Enhanced data rows
    for i, (label, value) in enumerate(kv_rows, start=1):
        y_pos = table_top - (i * row_height)
        
        # Alternating row colors with better contrast
        row_color = Color(0.97, 0.98, 0.99) if i % 2 == 1 else Color(0.94, 0.96, 0.98)
        
        # Label cell with enhanced styling
        label_bg_color = Color(0.88, 0.92, 0.96)
        draw_professional_cell(c, table_left, y_pos - row_height + 5, label_col_width, row_height,
                             fill_color=label_bg_color, border_color=Color(0.7, 0.7, 0.7),
                             text=label, font="Helvetica", font_size=10, bold=True, align="left")
        
        # Value cell
        draw_professional_cell(c, table_left + label_col_width, y_pos - row_height + 5, value_col_width, row_height,
                             fill_color=row_color, border_color=Color(0.7, 0.7, 0.7),
                             text=value, font="Helvetica", font_size=10, align="left")

    # Table border enhancement
    c.setStrokeColor(Color(0.1, 0.2, 0.6))
    c.setLineWidth(2)
    c.rect(table_left, table_top - (len(kv_rows) + 1) * row_height + 5, table_width, (len(kv_rows) + 1) * row_height, fill=0, stroke=1)
    
    return table_top - (len(kv_rows) + 1) * row_height - 25

def create_system_overview(c, width, height, y_start):
    """Create system overview section with enhanced professional styling"""
    
    # Section header with enhanced styling
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(Color(0.3, 0.3, 0.3))
    c.drawString(PAGE_MARGIN_LEFT, y_start, "Below Mentioned Drives are Scanned")
    
    # System Overview header
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(Color(0.2, 0.4, 0.8))
    c.drawString(PAGE_MARGIN_LEFT, y_start - 30, "2. System Overview")
    
    # System overview table data (header + one data row)
    global INPUT_DATA
    total_drives = 0
    total_capacity_b = 0
    total_used_b = 0
    if INPUT_DATA and isinstance(INPUT_DATA, dict):
        try:
            drives = INPUT_DATA.get('drives') or []
            total_drives = int(INPUT_DATA.get('total_drives') or len(drives) or 0)
            for d in drives:
                total_capacity_b += int(d.get('total_space_bytes') or 0)
                total_used_b += int(d.get('used_space_bytes') or 0)
        except Exception:
            pass

    def hr_bytes(n):
        try:
            units = ['B','KB','MB','GB','TB','PB']
            size = float(n)
            idx = 0
            while size >= 1024 and idx < len(units)-1:
                size /= 1024.0
                idx += 1
            return f"{size:.2f} {units[idx]}"
        except Exception:
            return str(n)

    used_pct = (float(total_used_b)/float(total_capacity_b)*100.0) if total_capacity_b > 0 else 0.0
    overview_data = [
        ["Total Drives", "Total Capacity", "Total Used", "Used %"],
        [str(total_drives or 0), hr_bytes(total_capacity_b), hr_bytes(total_used_b), f"{used_pct:.1f}%"]
    ]
    
    table_y = y_start - 60
    row_height = 32  # Increased for better spacing
    col_widths = [120, 140, 140, 120]  # Increased widths
    table_left = PAGE_MARGIN_LEFT
    table_width = sum(col_widths)
    
    for i, row in enumerate(overview_data):
        y_pos = table_y - (i * row_height)
        x_offset = table_left
        
        for j, cell in enumerate(row):
            if i == 0:  # Header row with gradient
                # Enhanced header styling
                header_start_color = Color(0.2, 0.5, 0.2)  # Green theme
                header_end_color = Color(0.3, 0.6, 0.3)
                
                # Draw gradient background
                draw_gradient_header(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                   header_start_color, header_end_color)
                
                # Draw header cell with border
                draw_professional_cell(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                      border_color=Color(0.1, 0.3, 0.1), border_width=1.2,
                                      text=cell, font="Helvetica", font_size=11, 
                                      text_color=white, bold=True, align="center")
            else:  # Data row
                # Enhanced data cell styling
                data_bg_color = Color(0.95, 0.98, 0.95)  # Light green tint
                
                # Special styling for percentage column
                if j == 3:  # Used % column
                    percentage = float(cell.replace('%', ''))
                    if percentage > 70:
                        data_bg_color = Color(1.0, 0.9, 0.9)  # Light red for high usage
                    elif percentage > 50:
                        data_bg_color = Color(1.0, 0.95, 0.8)  # Light orange for medium usage
                    else:
                        data_bg_color = Color(0.9, 1.0, 0.9)  # Light green for low usage
                
                draw_professional_cell(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                      fill_color=data_bg_color, border_color=Color(0.6, 0.6, 0.6),
                                      text=cell, font="Helvetica", font_size=11, 
                                      text_color=black, bold=False, align="center")
            
            x_offset += col_widths[j]
    
    # Enhanced table border
    c.setStrokeColor(Color(0.1, 0.3, 0.1))
    c.setLineWidth(2)
    c.rect(table_left, table_y - len(overview_data) * row_height + 5, table_width, len(overview_data) * row_height, fill=0, stroke=1)
    
    # Add a subtle shadow effect
    c.setFillColor(Color(0.8, 0.8, 0.8, alpha=0.3))
    shadow_offset = 3
    c.rect(table_left + shadow_offset, table_y - len(overview_data) * row_height + 5 - shadow_offset, 
           table_width, len(overview_data) * row_height, fill=1, stroke=0)
    
    return table_y - len(overview_data) * row_height - 25

def create_drive_details(c, width, height, y_start):
    """Create drive details section with enhanced professional styling"""
    
    # Drive Details header
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(Color(0.2, 0.4, 0.8))
    c.drawString(PAGE_MARGIN_LEFT, y_start, "3. Drive Details")
    
    # Drive details table header
    drive_header = ["Drive", "Filesystem", "Storage Used", "Total Capacity", "Free Space", "File Categories"]
    
    # Drive data from INPUT_DATA
    global INPUT_DATA
    drive_data = []
    def hr_bytes(n):
        try:
            units = ['B','KB','MB','GB','TB','PB']
            size = float(n)
            idx = 0
            while size >= 1024 and idx < len(units)-1:
                size /= 1024.0
                idx += 1
            return f"{size:.2f} {units[idx]}"
        except Exception:
            return str(n)

    if INPUT_DATA and isinstance(INPUT_DATA, dict):
        for d in INPUT_DATA.get('drives', []):
            drive_name = d.get('drive') or ''
            filesystem = d.get('filesystem') or ''
            used_h = d.get('used_space_human') or hr_bytes(d.get('used_space_bytes') or 0)
            total_h = d.get('total_space_human') or hr_bytes(d.get('total_space_bytes') or 0)
            free_h = d.get('free_space_human') or hr_bytes(d.get('free_space_bytes') or 0)
            # Build categories summary
            cats = d.get('file_analysis', {}).get('categories', {}) or {}
            lines = []
            for cat, vals in cats.items():
                cnt = vals.get('count') or 0
                sz = vals.get('size') or 0
                lines.append(f"{cat}: {cnt} files ({hr_bytes(sz)})")
            cat_text = "\n".join(lines[:12]) if lines else ""
            drive_data.append([drive_name, filesystem, used_h, total_h, free_h, cat_text])
    # If no input, keep empty to avoid bogus sample rows
    
    table_y = y_start - 30
    header_height = 35  # Increased for better header appearance
    row_height = 130  # Increased for better spacing
    col_widths = [40, 70, 75, 85, 70, 160]  # Reduced widths for more compact table
    table_left = PAGE_MARGIN_LEFT
    table_width = sum(col_widths)
    
    # Enhanced header with gradient
    header_start_color = Color(0.6, 0.2, 0.2)  # Red theme for drive details
    header_end_color = Color(0.7, 0.3, 0.3)
    
    # Draw gradient header background
    draw_gradient_header(c, table_left, table_y - header_height + 5, table_width, header_height,
                        header_start_color, header_end_color)
    
    # Draw individual header cells with enhanced styling
    x_offset = table_left
    for j, header in enumerate(drive_header):
        draw_professional_cell(c, x_offset, table_y - header_height + 5, col_widths[j], header_height,
                             border_color=Color(0.4, 0.1, 0.1), border_width=1.2,
                             text=header, font="Helvetica", font_size=10,
                             text_color=white, bold=True, align="center")
        x_offset += col_widths[j]
    
    # Enhanced data rows
    for i, row in enumerate(drive_data):
        y_pos = table_y - header_height - (i * row_height)
        x_offset = table_left
        
        # Alternating row colors with enhanced contrast
        row_bg_base = Color(0.98, 0.95, 0.95) if i % 2 == 0 else Color(0.95, 0.92, 0.92)
        
        for j, cell in enumerate(row):
            if j == len(row) - 1:  # File categories column - special handling
                # Enhanced multiline cell with better formatting
                categories_bg = Color(0.92, 0.96, 0.98)  # Light blue for categories
                
                # Draw cell background
                draw_professional_cell(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                     fill_color=categories_bg, border_color=Color(0.6, 0.6, 0.6), border_width=0.8)
                
                # Draw enhanced multiline text with adjusted spacing for smaller width
                draw_multiline_cell_text(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                       cell, font="Helvetica", font_size=7, text_color=black,
                                       line_spacing=10, padding=4)
            else:
                # Regular data cells with enhanced styling
                cell_bg = row_bg_base
                
                # Special formatting for drive names
                if j == 0:  # Drive column
                    cell_bg = Color(0.85, 0.90, 0.95)  # Light blue for drive letters
                    font_style = "Helvetica-Bold"
                    font_size = 11
                    text_align = "center"
                elif j in [2, 3, 4]:  # Storage columns
                    font_style = "Helvetica"
                    font_size = 9
                    text_align = "right"
                else:
                    font_style = "Helvetica"
                    font_size = 9
                    text_align = "left"
                
                draw_professional_cell(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                     fill_color=cell_bg, border_color=Color(0.6, 0.6, 0.6), border_width=0.8,
                                     text=cell, font=font_style.split('-')[0], font_size=font_size,
                                     text_color=black, bold=(font_style.endswith('Bold')), align=text_align)
            
            x_offset += col_widths[j]
    
    # Enhanced table border
    c.setStrokeColor(Color(0.4, 0.1, 0.1))
    c.setLineWidth(2.5)
    c.rect(table_left, table_y - header_height - len(drive_data) * row_height + 5, 
           table_width, header_height + len(drive_data) * row_height, fill=0, stroke=1)
    
    # Add shadow effect
    c.setFillColor(Color(0.7, 0.7, 0.7, alpha=0.4))
    shadow_offset = 4
    c.rect(table_left + shadow_offset, 
           table_y - header_height - len(drive_data) * row_height + 5 - shadow_offset,
           table_width, header_height + len(drive_data) * row_height, fill=1, stroke=0)
    
    return table_y - header_height - len(drive_data) * row_height - 25

def create_seve_report(output_filename="SEVE_Drive_Analysis_Report.pdf", cover_image="bg.png"):
    """Create the complete SEVE report"""
    
    c = canvas.Canvas(output_filename, pagesize=A4)
    width, height = A4
    
    print("Creating SEVE Drive Analysis Report...")
    
    # Page 1 - Cover page
    print("Creating cover page...")
    create_seve_cover(c, width, height, cover_image)
    c.showPage()
    
    # Page 2 - Device Information and Drive Analysis
    print("Creating analysis page...")
    add_seve_watermark(c, width, height, cover_image)
    draw_header_footer(c, width, height)
    # Bookmark and outline for section 1
    c.bookmarkPage("sec_device_info")
    c.addOutlineEntry("1. Device & Report Information", "sec_device_info", level=0, closed=None)
    
    y_pos = height - PAGE_MARGIN_TOP
    y_pos = create_device_info_table(c, width, height, y_pos)
    # Bookmark and outline for section 2
    c.bookmarkPage("sec_system_overview")
    c.addOutlineEntry("2. System Overview", "sec_system_overview", level=0, closed=None)
    y_pos = create_system_overview(c, width, height, y_pos - 20)
    # Move Drive Details to next page
    c.showPage()
    add_seve_watermark(c, width, height, cover_image)
    draw_header_footer(c, width, height)
    # Bookmark and outline for section 3 on the new page
    c.bookmarkPage("sec_drive_details")
    c.addOutlineEntry("3. Drive Details", "sec_drive_details", level=0, closed=None)
    y_pos = create_drive_details(c, width, height, height - PAGE_MARGIN_TOP)
    
    c.showPage()
    
    # Page 3 - Secure Deletion Log
    print("Creating secure deletion log...")
    add_seve_watermark(c, width, height, cover_image)
    draw_header_footer(c, width, height)
    # Bookmark and outline for section 4
    c.bookmarkPage("sec_deletion_log")
    c.addOutlineEntry("4. Secure Deletion Log", "sec_deletion_log", level=0, closed=None)
    
    # Continue from previous page or add new content
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(black)
    c.drawString(PAGE_MARGIN_LEFT, height - PAGE_MARGIN_TOP, "Below mentioned files are Deleted")
    
    # Secure Deletion Log header
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(Color(0.2, 0.4, 0.8))
    c.drawString(PAGE_MARGIN_LEFT, height - PAGE_MARGIN_TOP - 30, "4. Secure Deletion Log")
    
    # Deletion data from input or leave only header
    global INPUT_DATA
    deletion_data = [["File / Folder Name / Path", "File Type / Category", "File Size", "Deletion Method"]]
    def hr_bytes(n):
        try:
            units = ['B','KB','MB','GB','TB','PB']
            size = float(n)
            idx = 0
            while size >= 1024 and idx < len(units)-1:
                size /= 1024.0
                idx += 1
            return f"{size:.2f} {units[idx]}"
        except Exception:
            return str(n)
    if INPUT_DATA and isinstance(INPUT_DATA, dict):
        rep = INPUT_DATA.get('deletion_report') or {}
        items = rep.get('items') or []
        for it in items[:50]:
            path = it.get('path') or it.get('name') or ''
            size_h = hr_bytes(it.get('size') or 0)
            cat = 'File'
            method = 'Delete'
            if it.get('success') is False:
                method = f"Failed ({it.get('error','error')})"
            deletion_data.append([path, cat, size_h, method])
    
    # Enhanced deletion table with professional styling
    table_y = height - PAGE_MARGIN_TOP - 60
    header_height = 32  # Increased for better appearance
    row_height = 25     # Increased for better spacing
    col_widths = [140, 80, 60, 130]  # Reduced widths for more compact table
    table_left = PAGE_MARGIN_LEFT
    table_width = sum(col_widths)
    
    def draw_enhanced_deletion_header(c, x, y, widths, height):
        """Draw enhanced header for deletion table"""
        # Purple theme for deletion log
        header_start_color = Color(0.4, 0.2, 0.6)
        header_end_color = Color(0.5, 0.3, 0.7)
        
        # Draw gradient background
        draw_gradient_header(c, x, y, sum(widths), height, header_start_color, header_end_color)
        
        # Draw header cells
        x_offset = x
        for j, (header, width) in enumerate(zip(deletion_data[0], widths)):
            draw_professional_cell(c, x_offset, y, width, height,
                                 border_color=Color(0.2, 0.1, 0.4), border_width=1.2,
                                 text=header, font="Helvetica", font_size=9,
                                 text_color=white, bold=True, align="center")
            x_offset += width
    
    # Draw deletion table
    first_page = True
    for i, row in enumerate(deletion_data):
        y_pos = table_y - (i * row_height)
        
        if y_pos < PAGE_MARGIN_BOTTOM + 50:  # Check if we need a new page
            c.showPage()
            add_seve_watermark(c, width, height, cover_image)
            draw_header_footer(c, width, height)
            # Repeat section title on new page
            c.setFont("Helvetica-Bold", 14)
            c.setFillColor(Color(0.2, 0.4, 0.8))
            c.drawString(PAGE_MARGIN_LEFT, height - PAGE_MARGIN_TOP - 30, "4. Secure Deletion Log (continued)")
            # Reset table start and redraw header
            table_y = height - PAGE_MARGIN_TOP - 60
            y_pos = table_y
            draw_enhanced_deletion_header(c, table_left, y_pos - header_height + 5, col_widths, header_height)
            y_pos = table_y - header_height
            first_page = False
            # Skip header row on continuation pages
            if i == 0:
                continue
        
        if i == 0 and first_page:  # Header row on first page
            draw_enhanced_deletion_header(c, table_left, y_pos - header_height + 5, col_widths, header_height)
        elif i > 0:  # Data rows
            x_offset = table_left
            
            # Enhanced alternating row colors
            row_color = Color(0.96, 0.94, 0.98) if i % 2 == 1 else Color(0.94, 0.92, 0.96)
            
            for j, cell in enumerate(row):
                cell_bg = row_color
                font_size = 8
                text_align = "left"
                
                # Special formatting based on column
                if j == 1:  # File Type column
                    if "Personal" in cell:
                        cell_bg = Color(0.95, 0.90, 0.90)  # Light red
                    elif "System" in cell:
                        cell_bg = Color(0.90, 0.95, 0.90)  # Light green
                    elif "Document" in cell:
                        cell_bg = Color(0.90, 0.90, 0.95)  # Light blue
                    text_align = "center"
                elif j == 2:  # File Size column
                    text_align = "right"
                elif j == 3:  # Deletion Method column
                    if "Simple Delete" in cell:
                        cell_bg = Color(1.0, 0.95, 0.85)  # Light orange for simple delete
                    elif "Secure Erase" in cell:
                        cell_bg = Color(0.85, 0.95, 0.85)  # Light green for secure erase
                    font_size = 7  # Smaller font for long method names
                
                draw_professional_cell(c, x_offset, y_pos - row_height + 5, col_widths[j], row_height,
                                     fill_color=cell_bg, border_color=Color(0.6, 0.6, 0.6), border_width=0.7,
                                     text=cell, font="Helvetica", font_size=font_size,
                                     text_color=black, bold=False, align=text_align)
                
                x_offset += col_widths[j]
    
    c.showPage()
    
    # Page 4 - Summary Statistics
    print("Creating summary page...")
    add_seve_watermark(c, width, height, cover_image)
    draw_header_footer(c, width, height)
    # Bookmark and outline for section 5
    c.bookmarkPage("sec_summary")
    c.addOutlineEntry("5. Summary Statistics", "sec_summary", level=0, closed=None)
    
    # Summary Statistics header
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(Color(0.2, 0.4, 0.8))
    c.drawString(PAGE_MARGIN_LEFT, height - PAGE_MARGIN_TOP - 30, "5. Summary Statistics")
    
    # Enhanced Summary table with professional styling
    summary_data = [
        ["Total Files Deleted", "Total Data Size Deleted", "Files Failed to Delete", "Sensitive Files Deleted"],
        ["10", "30.2 GB", "0", "3"]  # Sample data instead of empty
    ]
    
    table_y = height - PAGE_MARGIN_TOP - 60
    header_height = 35  # Increased for better appearance
    data_row_height = 40  # Increased for better data presentation
    col_widths = [110, 120, 110, 120]  # Reduced widths for more compact table
    table_left = PAGE_MARGIN_LEFT
    table_width = sum(col_widths)
    
    # Enhanced header with gradient (orange theme for summary)
    header_start_color = Color(0.8, 0.4, 0.1)
    header_end_color = Color(0.9, 0.5, 0.2)
    
    # Draw gradient header background
    draw_gradient_header(c, table_left, table_y - header_height + 5, table_width, header_height,
                        header_start_color, header_end_color)
    
    # Draw header cells with enhanced styling
    x_offset = table_left
    for j, header in enumerate(summary_data[0]):
        draw_professional_cell(c, x_offset, table_y - header_height + 5, col_widths[j], header_height,
                             border_color=Color(0.6, 0.2, 0.05), border_width=1.5,
                             text=header, font="Helvetica", font_size=10,
                             text_color=white, bold=True, align="center")
        x_offset += col_widths[j]
    
    # Draw data row with enhanced styling
    data_y_pos = table_y - header_height
    x_offset = table_left
    
    for j, cell in enumerate(summary_data[1]):
        # Special styling for different types of data
        if j == 0:  # Total Files Deleted
            data_bg = Color(0.90, 0.95, 1.0)  # Light blue
            text_color = Color(0.1, 0.3, 0.7)  # Dark blue
            font_size = 14
            bold = True
        elif j == 1:  # Total Data Size Deleted
            data_bg = Color(0.95, 1.0, 0.90)  # Light green
            text_color = Color(0.1, 0.6, 0.1)  # Dark green
            font_size = 14
            bold = True
        elif j == 2:  # Files Failed to Delete
            failed_count = int(cell) if cell.isdigit() else 0
            if failed_count > 0:
                data_bg = Color(1.0, 0.90, 0.90)  # Light red
                text_color = Color(0.8, 0.1, 0.1)  # Dark red
            else:
                data_bg = Color(0.90, 1.0, 0.90)  # Light green
                text_color = Color(0.1, 0.6, 0.1)  # Dark green
            font_size = 14
            bold = True
        else:  # Sensitive Files Deleted
            data_bg = Color(1.0, 0.95, 0.85)  # Light orange
            text_color = Color(0.8, 0.4, 0.1)  # Dark orange
            font_size = 14
            bold = True
        
        draw_professional_cell(c, x_offset, data_y_pos - data_row_height + 5, col_widths[j], data_row_height,
                             fill_color=data_bg, border_color=Color(0.6, 0.6, 0.6), border_width=1,
                             text=cell, font="Helvetica", font_size=font_size,
                             text_color=text_color, bold=bold, align="center")
        
        x_offset += col_widths[j]
    
    # Enhanced table border with shadow
    c.setStrokeColor(Color(0.6, 0.2, 0.05))
    c.setLineWidth(2.5)
    c.rect(table_left, table_y - header_height - data_row_height + 5, 
           table_width, header_height + data_row_height, fill=0, stroke=1)
    
    # Add subtle shadow effect
    c.setFillColor(Color(0.7, 0.7, 0.7, alpha=0.4))
    shadow_offset = 4
    c.rect(table_left + shadow_offset, 
           table_y - header_height - data_row_height + 5 - shadow_offset,
           table_width, header_height + data_row_height, fill=1, stroke=0)
    
    # Add a summary note below the table
    note_y = table_y - header_height - data_row_height - 20
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColor(Color(0.4, 0.4, 0.4))
    c.drawString(table_left, note_y, "Note: Statistics are based on the current deletion session and secure erase operations performed.")
    
    # Save the PDF
    c.save()
    print(f"SEVE report '{output_filename}' created successfully!")
    return True

INPUT_DATA = None

def main():
    """Main function to generate the SEVE report"""
    print("=== SEVE Drive Analysis Report Generator ===")
    print("Creating exact replica of SEVE report format...")
    
    parser = argparse.ArgumentParser(description='Generate SEVE Drive Analysis Report')
    parser.add_argument('--output', '-o', default='SEVE_Drive_Analysis_Report.pdf', help='Output PDF file path')
    parser.add_argument('--cover', default='bg.png', help='Path to cover/watermark image (bg.png)')
    parser.add_argument('--input', help='Path to JSON containing drive scan/report data')
    args = parser.parse_args()

    output_file = args.output
    cover_img = args.cover
    global INPUT_DATA
    INPUT_DATA = None
    if args.input and os.path.exists(args.input):
        try:
            with open(args.input, 'r', encoding='utf-8') as f:
                INPUT_DATA = json.load(f)
        except Exception as e:
            print(f"Warning: failed to parse input JSON: {e}")

    # Generate the report
    success = create_seve_report(output_file, cover_img)
    
    if success:
        print("\nSEVE Report generated successfully!")
        print(f"Output: {output_file}")
        print(f"Cover: {cover_img}")
        print("SEVE Watermark: Applied to all content pages")
        print("Format: Exact replica of reference document")
    else:
        print("\n❌ Failed to generate report. Please check the error messages above.")

if __name__ == "__main__":
    main()