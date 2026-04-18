import subprocess

# NOTE: These functions are extremely dangerous and will destroy data.
# They should only be called after explicit user confirmation.

def run_wipe_command(command, device):
    """A helper function to run a subprocess command and stream its output."""
    try:
        # Using Popen to allow for future progress streaming
        process = subprocess.Popen(
            command + [device],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        # For now, we wait for completion. In the TUI, we can monitor this.
        stdout, stderr = process.communicate()
        
        if process.returncode == 0:
            return {"success": True, "message": f"Wipe command completed on {device}."}
        else:
            return {"success": False, "error": stderr or "An unknown error occurred."}
            
    except FileNotFoundError:
        return {"success": False, "error": f"Command not found: {command[0]}. Is it installed?"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def wipe_zero_fill(device):
    """Performs a single-pass zero-fill wipe on a device using shred."""
    # -n 0: overwrite with zeros. -v: verbose. -z: add a final overwrite with zeros.
    command = ["shred", "-n", "0", "-v", "-z"]
    return run_wipe_command(command, device)

def wipe_secure(device, passes=3):
    """Performs a multi-pass secure wipe with random data using shred."""
    # -n: number of random passes. -v: verbose.
    command = ["shred", "-n", str(passes), "-v"]
    return run_wipe_command(command, device)
