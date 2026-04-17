# SEVE Setup (PowerShell)
# Vendors Python packages into python\Lib\site-packages for the embedded interpreter.
# Safer with spaces in paths; adds clear diagnostics.

param(
    [switch]$Force,
    [string]$PythonCmd,
    [string[]]$PythonArgs
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg){ Write-Host "[ERROR] $msg" -ForegroundColor Red }

# 1) Paths
$root   = (Resolve-Path "$PSScriptRoot\..\").Path
$embedded = Join-Path $root 'python\python.exe'
$target  = Join-Path $root 'python\Lib\site-packages'

Write-Info "Project root : $root"
Write-Info "Embedded exe : $embedded"
Write-Info "Target folder: $target"

if (-not (Test-Path -LiteralPath $embedded)) {
    Write-Err "Embedded Python not found at: $embedded"
    Write-Host "Place your embedded Python there (contains python.exe) and re-run."
    exit 1
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

# 2) Detect versions
$embeddedVer = & $embedded -V 2>&1
$embeddedMM = (& $embedded -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
Write-Info "Embedded version: $embeddedVer (MM=$embeddedMM)"

# 3) Pick a system python
$pyCmd = $null
$pyArgs = @()
if ($PSBoundParameters.ContainsKey('PythonCmd')) {
    $pyCmd = $PythonCmd
    if ($PSBoundParameters.ContainsKey('PythonArgs')) { $pyArgs = $PythonArgs } else { $pyArgs = @() }
} else {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $pyCmd = 'py'
        $pyArgs = @('-3')
        # probe; if version probe fails, fall back to 'python'
        try { $null = (& $pyCmd @pyArgs -c "print('ok')") } catch {
            if (Get-Command python -ErrorAction SilentlyContinue) {
                $pyCmd = 'python'; $pyArgs = @()
            }
        }
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $pyCmd = 'python'
        $pyArgs = @()
    } else {
        Write-Err "No system Python found (python/py). Install Python 3.x and re-run."
        exit 1
    }
}

$sysMM = ''
try { $sysMM = (& $pyCmd @pyArgs -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim() } catch { $sysMM = '' }
Write-Info "System Python cmd : $pyCmd $($pyArgs -join ' ') (MM=$sysMM)"

if ($sysMM -ne $embeddedMM -and -not $Force) {
    Write-Warn "System Python $sysMM does not match embedded $embeddedMM."
    Write-Warn "Pillow wheels are CPython-version specific."
    Write-Warn "Recommended: match versions (either change embedded to $sysMM, or install a system Python $embeddedMM)."
    Write-Warn "Re-run with -Force to continue using $pyCmd anyway (may fail to import on embedded)."
    exit 2
}

# 4) Ensure pip
try { & $pyCmd @pyArgs -m ensurepip --upgrade | Out-Host } catch { Write-Warn "ensurepip failed or not needed" }
try { & $pyCmd @pyArgs -m pip install --upgrade pip setuptools wheel | Out-Host } catch { Write-Warn "pip upgrade failed; continuing" }

# 5) Install packages into target
Write-Info "Installing reportlab and pillow into $target"
& $pyCmd @pyArgs -m pip install --only-binary=:all: --target "$target" reportlab pillow | Out-Host

# 6) Verify using embedded python with PYTHONPATH
$env:PYTHONPATH = $target
try {
    & $embedded -c "import reportlab, PIL, PIL.Image; import sys; print('OK ReportLab', reportlab.__version__)" | Out-Host
    Write-Host "[SUCCESS] Vendored packages are ready in: $target" -ForegroundColor Green
    exit 0
} catch {
    Write-Err "Verification failed: $($_.Exception.Message)"
    Write-Host "sys.path check:" -ForegroundColor Yellow
    & $embedded -c "import sys, os; print(os.environ.get('PYTHONPATH')); print('\n'.join(sys.path))" | Out-Host
    exit 3
}
