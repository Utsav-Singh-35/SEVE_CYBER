#!/usr/bin/env python3
"""
Anomaly Detector - Establishes baseline and detects traffic anomalies
"""
import sys
import json
import time

try:
    import psutil
    import statistics
except ImportError:
    print(json.dumps({
        'success': False,
        'error': 'psutil not installed. Run: pip install psutil'
    }))
    sys.exit(1)

class AnomalyDetector:
    def __init__(self):
        self.baseline = None
        self.alerts = []
        
    def establish_baseline(self, duration_seconds=30):
        """Establish baseline for normal system behavior"""
        print(json.dumps({'status': 'establishing_baseline', 'duration': duration_seconds}), flush=True)
        
        samples = []
        sample_interval = 2
        num_samples = max(1, duration_seconds // sample_interval)
        
        for i in range(num_samples):
            try:
                # Collect metrics
                cpu_percent = psutil.cpu_percent(interval=1)
                mem = psutil.virtual_memory()
                
                try:
                    disk_io = psutil.disk_io_counters()
                    disk_read = disk_io.read_bytes if disk_io else 0
                    disk_write = disk_io.write_bytes if disk_io else 0
                except:
                    disk_read = 0
                    disk_write = 0
                
                try:
                    net_io = psutil.net_io_counters()
                    net_sent = net_io.bytes_sent if net_io else 0
                    net_recv = net_io.bytes_recv if net_io else 0
                except:
                    net_sent = 0
                    net_recv = 0
                
                sample = {
                    'cpu': cpu_percent,
                    'memory': mem.percent,
                    'disk_read': disk_read,
                    'disk_write': disk_write,
                    'net_sent': net_sent,
                    'net_recv': net_recv,
                    'timestamp': time.time()
                }
                
                samples.append(sample)
                
                # Progress update
                progress = int((i + 1) / num_samples * 100)
                print(json.dumps({'baseline_progress': progress}), flush=True)
                
            except Exception as e:
                print(json.dumps({'error': str(e)}), flush=True)
        
        # Calculate statistics
        if len(samples) < 2:
            return None
        
        self.baseline = {
            'cpu_mean': statistics.mean([s['cpu'] for s in samples]),
            'cpu_std': statistics.stdev([s['cpu'] for s in samples]) if len(samples) > 1 else 1,
            'memory_mean': statistics.mean([s['memory'] for s in samples]),
            'memory_std': statistics.stdev([s['memory'] for s in samples]) if len(samples) > 1 else 1,
            'disk_read_mean': statistics.mean([s['disk_read'] for s in samples]),
            'disk_read_std': statistics.stdev([s['disk_read'] for s in samples]) if len(samples) > 1 else 1,
            'disk_write_mean': statistics.mean([s['disk_write'] for s in samples]),
            'disk_write_std': statistics.stdev([s['disk_write'] for s in samples]) if len(samples) > 1 else 1,
            'net_sent_mean': statistics.mean([s['net_sent'] for s in samples]),
            'net_sent_std': statistics.stdev([s['net_sent'] for s in samples]) if len(samples) > 1 else 1,
            'net_recv_mean': statistics.mean([s['net_recv'] for s in samples]),
            'net_recv_std': statistics.stdev([s['net_recv'] for s in samples]) if len(samples) > 1 else 1,
            'samples': len(samples)
        }
        
        print(json.dumps({'baseline_established': True, 'samples': len(samples)}), flush=True)
        return self.baseline
    
    def detect_anomalies(self, duration_seconds=60):
        """Monitor for anomalies based on baseline"""
        if not self.baseline:
            return {'success': False, 'error': 'No baseline established'}
        
        print(json.dumps({'status': 'monitoring_anomalies', 'duration': duration_seconds}), flush=True)
        
        start_time = time.time()
        check_interval = 3
        
        while time.time() - start_time < duration_seconds:
            try:
                # Collect current metrics
                cpu_percent = psutil.cpu_percent(interval=1)
                mem = psutil.virtual_memory()
                
                try:
                    disk_io = psutil.disk_io_counters()
                    disk_read = disk_io.read_bytes if disk_io else 0
                    disk_write = disk_io.write_bytes if disk_io else 0
                except:
                    disk_read = 0
                    disk_write = 0
                
                try:
                    net_io = psutil.net_io_counters()
                    net_sent = net_io.bytes_sent if net_io else 0
                    net_recv = net_io.bytes_recv if net_io else 0
                except:
                    net_sent = 0
                    net_recv = 0
                
                # Check for anomalies (3 standard deviations)
                anomalies = []
                
                if cpu_percent > self.baseline['cpu_mean'] + 3 * self.baseline['cpu_std']:
                    anomalies.append({
                        'type': 'cpu_spike',
                        'value': cpu_percent,
                        'baseline': self.baseline['cpu_mean'],
                        'threshold': self.baseline['cpu_mean'] + 3 * self.baseline['cpu_std']
                    })
                
                if mem.percent > self.baseline['memory_mean'] + 3 * self.baseline['memory_std']:
                    anomalies.append({
                        'type': 'memory_spike',
                        'value': mem.percent,
                        'baseline': self.baseline['memory_mean'],
                        'threshold': self.baseline['memory_mean'] + 3 * self.baseline['memory_std']
                    })
                
                if disk_read > self.baseline['disk_read_mean'] + 3 * self.baseline['disk_read_std']:
                    anomalies.append({
                        'type': 'disk_read_spike',
                        'value': disk_read,
                        'baseline': self.baseline['disk_read_mean'],
                        'threshold': self.baseline['disk_read_mean'] + 3 * self.baseline['disk_read_std']
                    })
                
                if net_sent > self.baseline['net_sent_mean'] + 3 * self.baseline['net_sent_std']:
                    anomalies.append({
                        'type': 'network_send_spike',
                        'value': net_sent,
                        'baseline': self.baseline['net_sent_mean'],
                        'threshold': self.baseline['net_sent_mean'] + 3 * self.baseline['net_sent_std']
                    })
                
                # Alert on anomalies
                if anomalies:
                    alert = {
                        'timestamp': time.time(),
                        'anomalies': anomalies,
                        'severity': 'high' if len(anomalies) > 2 else 'medium'
                    }
                    self.alerts.append(alert)
                    print(json.dumps({'alert': alert}), flush=True)
                
                time.sleep(check_interval)
                
            except Exception as e:
                print(json.dumps({'error': str(e)}), flush=True)
                time.sleep(check_interval)
        
        return {
            'success': True,
            'baseline': self.baseline,
            'alerts': self.alerts,
            'total_alerts': len(self.alerts)
        }
    
    def run_full_analysis(self, baseline_duration=30, monitor_duration=60):
        """Run complete baseline + monitoring cycle"""
        try:
            # Establish baseline
            baseline = self.establish_baseline(baseline_duration)
            if not baseline:
                return {'success': False, 'error': 'Failed to establish baseline'}
            
            # Monitor for anomalies
            return self.detect_anomalies(monitor_duration)
        except Exception as e:
            return {
                'success': False,
                'error': f"Analysis failed: {str(e)}"
            }

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Traffic anomaly detector')
    parser.add_argument('--baseline', type=int, default=30, help='Baseline duration in seconds')
    parser.add_argument('--monitor', type=int, default=60, help='Monitoring duration in seconds')
    
    args = parser.parse_args()
    
    detector = AnomalyDetector()
    result = detector.run_full_analysis(args.baseline, args.monitor)
    print(json.dumps(result, indent=2))
