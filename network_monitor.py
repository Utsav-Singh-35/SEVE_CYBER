#!/usr/bin/env python3
"""
Network Monitor - Detects data leaks by monitoring outgoing network traffic
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

class NetworkMonitor:
    def __init__(self):
        self.baseline = {}
        self.alerts = []
        self.process_cache = {}
        
    def get_process_name(self, pid):
        """Get process name with caching"""
        if pid in self.process_cache:
            return self.process_cache[pid]
        try:
            proc = psutil.Process(pid)
            name = proc.name()
            self.process_cache[pid] = name
            return name
        except:
            return 'unknown'
    
    def monitor_connections(self, duration=60):
        """Monitor network connections for suspicious activity"""
        print(json.dumps({'status': 'monitoring', 'duration': duration}), flush=True)
        
        start_time = time.time()
        check_interval = 2  # Check every 2 seconds
        
        while time.time() - start_time < duration:
            try:
                try:
                    connections = psutil.net_connections(kind='inet')
                except psutil.AccessDenied:
                    print(json.dumps({
                        'error': 'Access denied. Run as Administrator to monitor network connections.'
                    }), flush=True)
                    break
                
                for conn in connections:
                    try:
                        if conn.status == 'ESTABLISHED' and conn.raddr:
                            key = f"{conn.pid}_{conn.raddr.ip}_{conn.raddr.port}"
                            
                            if key not in self.baseline:
                                self.baseline[key] = {
                                    'pid': conn.pid,
                                    'process': self.get_process_name(conn.pid),
                                    'remote_ip': conn.raddr.ip,
                                    'remote_port': conn.raddr.port,
                                    'first_seen': time.time(),
                                    'bytes_sent': 0,
                                    'connections': 0
                                }
                            
                            self.baseline[key]['connections'] += 1
                            
                            # Check for suspicious patterns
                            self.check_suspicious_connection(self.baseline[key])
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
            'connections_monitored': len(self.baseline)
        }
    
    def check_suspicious_connection(self, conn_data):
        """Check if connection shows signs of data leak"""
        # Alert on high-frequency connections to external IPs
        if conn_data['connections'] > 100:
            elapsed = time.time() - conn_data['first_seen']
            rate = conn_data['connections'] / elapsed if elapsed > 0 else 0
            
            if rate > 10:  # More than 10 connections per second
                alert = {
                    'type': 'high_frequency_connection',
                    'process': conn_data['process'],
                    'pid': conn_data['pid'],
                    'destination': f"{conn_data['remote_ip']}:{conn_data['remote_port']}",
                    'rate': rate,
                    'connections': conn_data['connections'],
                    'severity': 'high' if rate > 50 else 'medium',
                    'timestamp': time.time()
                }
                
                # Only alert once per connection
                if not any(a['type'] == alert['type'] and a['pid'] == alert['pid'] and a['destination'] == alert['destination'] for a in self.alerts):
                    self.alerts.append(alert)
                    print(json.dumps({'alert': alert}), flush=True)

def monitor_network_traffic(duration=60):
    """Main monitoring function"""
    try:
        monitor = NetworkMonitor()
        return monitor.monitor_connections(duration)
    except Exception as e:
        return {
            'success': False,
            'error': f"Monitoring failed: {str(e)}"
        }

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Network traffic monitor')
    parser.add_argument('--duration', type=int, default=60, help='Monitoring duration in seconds')
    
    args = parser.parse_args()
    
    result = monitor_network_traffic(args.duration)
    print(json.dumps(result, indent=2))
