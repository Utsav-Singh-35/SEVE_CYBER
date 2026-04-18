#!/usr/bin/env python3
"""
Browser Privacy Analyzer - Scans browser cookies and storage for privacy risks
"""
import sqlite3
from pathlib import Path
import json
import sys
import os
import shutil

def get_chrome_cookies():
    """Extract cookies from Chrome database"""
    try:
        # Try multiple Chrome/Edge paths
        possible_paths = [
            Path.home() / 'AppData/Local/Google/Chrome/User Data/Default/Cookies',
            Path.home() / 'AppData/Local/Google/Chrome/User Data/Default/Network/Cookies',
            Path.home() / 'AppData/Local/Microsoft/Edge/User Data/Default/Cookies',
            Path.home() / 'AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies',
        ]
        
        cookie_path = None
        for p in possible_paths:
            if p.exists():
                cookie_path = p
                break
        
        if not cookie_path:
            raise FileNotFoundError("No browser cookie database found. Make sure Chrome or Edge is installed.")
        
        # Copy database to avoid lock issues
        temp_path = 'temp_cookies.db'
        try:
            shutil.copy2(cookie_path, temp_path)
        except PermissionError:
            raise PermissionError("Cannot access cookie database. Please close Chrome/Edge and try again.")
        
        conn = sqlite3.connect(temp_path)
        cursor = conn.cursor()
        
        # Check if cookies table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'")
        if not cursor.fetchone():
            raise ValueError("Invalid cookie database format")
        
        cursor.execute("""
            SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly
            FROM cookies
            LIMIT 1000
        """)
        
        cookies = []
        for row in cursor.fetchall():
            cookies.append({
                'domain': row[0] or '',
                'name': row[1] or '',
                'value': (row[2][:100] if row[2] else ''),  # Truncate value
                'path': row[3] or '/',
                'expires': row[4] or 0,
                'secure': bool(row[5]),
                'httponly': bool(row[6])
            })
        
        conn.close()
        
        # Cleanup
        try:
            os.remove(temp_path)
        except:
            pass
        
        return cookies
    
    except FileNotFoundError as e:
        raise e
    except PermissionError as e:
        raise e
    except Exception as e:
        raise Exception(f"Error reading cookies: {str(e)}")

TRACKING_PATTERNS = [
    '_ga', '_gid', '_gat', 'fbp', 'fr', '_fbp',
    'doubleclick', 'analytics', 'google-analytics',
    '__utm', '_gcl', 'IDE', 'test_cookie'
]

TRACKING_DOMAINS = [
    'doubleclick.net', 'google-analytics.com', 'googletagmanager.com',
    'facebook.com', 'facebook.net', 'connect.facebook.net',
    'ads.', 'adservice.', 'advertising.', 'tracker.'
]

def classify_cookie(cookie):
    """Classify cookie by privacy risk"""
    risk = 'low'
    reasons = []
    category = 'functional'
    
    domain = cookie['domain'].lower()
    name = cookie['name'].lower()
    value = cookie['value'].lower()
    
    # Check for tracking cookies
    is_tracking = False
    for pattern in TRACKING_PATTERNS:
        if pattern in name:
            is_tracking = True
            break
    
    for tracker_domain in TRACKING_DOMAINS:
        if tracker_domain in domain:
            is_tracking = True
            break
    
    if is_tracking:
        risk = 'high'
        reasons.append('Tracking/Analytics cookie')
        category = 'tracking'
    
    # Check for authentication/session cookies
    if any(keyword in name for keyword in ['token', 'session', 'auth', 'login', 'jwt']):
        risk = 'critical'
        reasons.append('Contains authentication data')
        category = 'authentication'
    
    # Check for long-lived cookies (>1 year)
    if cookie['expires'] > 0:
        # Convert Chrome timestamp to seconds
        expires_seconds = cookie['expires'] / 1000000
        import time
        if expires_seconds > time.time() + (365 * 24 * 60 * 60):
            if risk == 'low':
                risk = 'medium'
            reasons.append('Long-lived cookie (>1 year)')
    
    # Check for insecure cookies
    if not cookie['secure'] and risk != 'low':
        reasons.append('Not transmitted over HTTPS only')
    
    # Third-party cookie detection
    if domain.startswith('.'):
        reasons.append('Third-party cookie')
    
    return {
        **cookie,
        'risk': risk,
        'reasons': reasons,
        'category': category
    }

def scan_and_classify():
    """Scan browser and classify all cookies"""
    try:
        cookies = get_chrome_cookies()
        
        if not cookies:
            return {
                'success': True,
                'cookies': [],
                'stats': {
                    'total': 0,
                    'critical': 0,
                    'high': 0,
                    'medium': 0,
                    'low': 0,
                    'tracking': 0,
                    'authentication': 0
                },
                'message': 'No cookies found'
            }
        
        classified = [classify_cookie(c) for c in cookies]
        
        # Generate summary statistics
        stats = {
            'total': len(classified),
            'critical': len([c for c in classified if c['risk'] == 'critical']),
            'high': len([c for c in classified if c['risk'] == 'high']),
            'medium': len([c for c in classified if c['risk'] == 'medium']),
            'low': len([c for c in classified if c['risk'] == 'low']),
            'tracking': len([c for c in classified if c['category'] == 'tracking']),
            'authentication': len([c for c in classified if c['category'] == 'authentication'])
        }
        
        return {
            'success': True,
            'cookies': classified,
            'stats': stats
        }
    
    except FileNotFoundError as e:
        return {
            'success': False,
            'error': str(e),
            'cookies': [],
            'stats': {'total': 0, 'critical': 0, 'high': 0, 'medium': 0, 'low': 0, 'tracking': 0, 'authentication': 0}
        }
    except PermissionError as e:
        return {
            'success': False,
            'error': str(e),
            'cookies': [],
            'stats': {'total': 0, 'critical': 0, 'high': 0, 'medium': 0, 'low': 0, 'tracking': 0, 'authentication': 0}
        }
    except Exception as e:
        return {
            'success': False,
            'error': f"Unexpected error: {str(e)}",
            'cookies': [],
            'stats': {'total': 0, 'critical': 0, 'high': 0, 'medium': 0, 'low': 0, 'tracking': 0, 'authentication': 0}
        }

def clear_tracking_cookies():
    """Delete tracking cookies from browser database"""
    try:
        # Find cookie database
        possible_paths = [
            Path.home() / 'AppData/Local/Google/Chrome/User Data/Default/Cookies',
            Path.home() / 'AppData/Local/Google/Chrome/User Data/Default/Network/Cookies',
            Path.home() / 'AppData/Local/Microsoft/Edge/User Data/Default/Cookies',
            Path.home() / 'AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies',
        ]
        
        cookie_path = None
        for p in possible_paths:
            if p.exists():
                cookie_path = p
                break
        
        if not cookie_path:
            raise FileNotFoundError("No browser cookie database found.")
        
        # Direct database modification (browser MUST be closed)
        try:
            conn = sqlite3.connect(str(cookie_path))
        except sqlite3.OperationalError:
            raise PermissionError("Cannot access cookie database. Close Chrome/Edge and try again.")
        
        cursor = conn.cursor()
        
        # Count tracking cookies before deletion
        tracking_conditions = []
        for pattern in TRACKING_PATTERNS:
            tracking_conditions.append(f"name LIKE '%{pattern}%'")
        for domain in TRACKING_DOMAINS:
            tracking_conditions.append(f"host_key LIKE '%{domain}%'")
        
        where_clause = ' OR '.join(tracking_conditions)
        cursor.execute(f"SELECT COUNT(*) FROM cookies WHERE {where_clause}")
        count_before = cursor.fetchone()[0]
        
        # Delete tracking cookies
        cursor.execute(f"DELETE FROM cookies WHERE {where_clause}")
        deleted = cursor.rowcount
        
        conn.commit()
        conn.close()
        
        return {
            'success': True,
            'deleted': deleted,
            'message': f'Deleted {deleted} tracking cookies'
        }
    
    except FileNotFoundError as e:
        return {'success': False, 'error': str(e)}
    except PermissionError as e:
        return {'success': False, 'error': str(e)}
    except Exception as e:
        return {'success': False, 'error': f"Failed to clear cookies: {str(e)}"}

def clear_all_cookies():
    """Delete ALL cookies from browser database"""
    try:
        # Find cookie database
        possible_paths = [
            Path.home() / 'AppData/Local/Google/Chrome/User Data/Default/Cookies',
            Path.home() / 'AppData/Local/Google/Chrome/User Data/Default/Network/Cookies',
            Path.home() / 'AppData/Local/Microsoft/Edge/User Data/Default/Cookies',
            Path.home() / 'AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies',
        ]
        
        cookie_path = None
        for p in possible_paths:
            if p.exists():
                cookie_path = p
                break
        
        if not cookie_path:
            raise FileNotFoundError("No browser cookie database found.")
        
        # Direct database modification (browser MUST be closed)
        try:
            conn = sqlite3.connect(str(cookie_path))
        except sqlite3.OperationalError:
            raise PermissionError("Cannot access cookie database. Close Chrome/Edge and try again.")
        
        cursor = conn.cursor()
        
        # Count all cookies
        cursor.execute("SELECT COUNT(*) FROM cookies")
        total = cursor.fetchone()[0]
        
        # Delete ALL cookies
        cursor.execute("DELETE FROM cookies")
        deleted = cursor.rowcount
        
        conn.commit()
        conn.close()
        
        return {
            'success': True,
            'deleted': deleted,
            'total': total,
            'message': f'Deleted all {deleted} cookies'
        }
    
    except FileNotFoundError as e:
        return {'success': False, 'error': str(e)}
    except PermissionError as e:
        return {'success': False, 'error': str(e)}
    except Exception as e:
        return {'success': False, 'error': f"Failed to clear all cookies: {str(e)}"}

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--clear', action='store_true', help='Clear tracking cookies')
    parser.add_argument('--clear-all', action='store_true', help='Clear ALL cookies')
    args = parser.parse_args()
    
    if args.clear_all:
        result = clear_all_cookies()
    elif args.clear:
        result = clear_tracking_cookies()
    else:
        result = scan_and_classify()
    
    print(json.dumps(result, indent=2))
