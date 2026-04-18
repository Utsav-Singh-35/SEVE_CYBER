#!/usr/bin/env python3
"""
Exfiltration Detector - Detects data exfiltration by correlating file access with network activity
"""
import sys
import json
import time
from collections import defaultdict

try:
    import psutil
except ImportError:
    print(json.dumps({
        'success': False,
        'error': 'psutil not installed. Run: pip install psutil'
    }))
    sys.exit(1)

class ExfiltrationDetector:
    def __init__(self):
        self.process_activity = defaultdict(lambda: {
            'read_bytes': 0,
            'write_bytes': 0,
            'connections': 0,
            'remote_ips': set(),
            'first_seen': time.time()
        })
        self.alerts = []
        
    def monitor_processes(self, duration=60):
        """Monitor processes for exfiltration patterns"""
        print(json.dumps({'status': 'monitoring', 'duration': duration}), flush=True)
        
        start_time = time.time()
        check_interval = 3
        
        while time.time() - start_time < duration:
            try:
                for proc in psutil.process_iter(['pid', 'name']):
                    try:
                        pid = proc.info['pid']
                        name = proc.info['name']
                        
                        # Get IO counters
                        try:
                            io = proc.io_counters()
                        except (psutil.AccessDenied, AttributeError):
                            continue
                        
                        # Get network connections
                        try:
                            conns = proc.connections(kind='inet')
                        except (psutil.AccessDenied, psutil.NoSuchProcess):
                            conns = []
                        
                        # Update activity tracking
                        activity = self.process_activity[pid]
                        activity['name'] = name
                        activity['read_bytes'] = io.read_bytes
                        activity['write_bytes'] = io.write_bytes
                        activity['connections'] = len(conns)
                        
                        for conn in conns:
                            if conn.raddr:
                                activity['remote_ips'].add(conn.raddr.ip)
                        
                        # Check for exfiltration pattern
                        self.check_exfiltration_pattern(pid, activity)
                        
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                
                time.sleep(check_interval)
                
            except Exception as e:
                print(json.dumps({'error': str(e)}), flush=True)
                time.sleep(check_interval)
        
        return {
            'success': True,
            'alerts': self.alerts,
            'total_alerts': len(self.alerts),
            'processes_monitored': len(self.process_activity)
        }
    
    def check_exfiltration_pattern(self, pid, activity):
        """Detect exfiltration: high read + active network connections"""
        # Threshold: >100MB read AND active connections
        read_mb = activity['read_bytes'] / (1024 * 1024)
        
        if read_mb > 100 and activity['connections'] > 0:
            elapsed = time.time() - activity['first_seen']
            
            # Only alert if this is sustained activity (>10 seconds)
            if elapsed > 10:
                alert = {
                    'type': 'potential_exfiltration',
                    'process': activity['name'],
                    'pid': pid,
                    'read_mb': round(read_mb, 2),
                    'connections': activity['connections'],
                    'remote_ips': list(activity['remote_ips']),
                    'duration': round(elapsed, 1),
                    'severity': 'critical' if read_mb > 500 else 'high',
                    'timestamp': time.time()
                }
                
                # Only alert once per process
                if not any(a['pid'] == pid for a in self.alerts):
                    self.alerts.append(alert)
                    print(json.dumps({'alert': alert}), flush=True)

def detect_exfiltration(duration=60):
    """Main detection function"""
    try:
        detector = ExfiltrationDetector()
        return detector.monitor_processes(duration)
    except Exception as e:
        return {
            'success': False,
            'error': f"Detection failed: {str(e)}"
        }

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Exfiltration detector')
    parser.add_argument('--duration', type=int, default=60, help='Monitoring duration in seconds')
    
    args = parser.parse_args()
    
    result = detect_exfiltration(args.duration)
    print(json.dumps(result, indent=2))
