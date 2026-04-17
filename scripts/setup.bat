@echo off
setlocal ENABLEEXTENSIONS ENABLEDELAYEDEXPANSION
title SEVE Setup - Vendor Python Dependencies

echo === SEVE Setup: Vendor Python packages into python\Lib\site-packages ===

REM Resolve project root (absolute) and target site-packages
set ROOT=%~dp0..
for %%I in ("%ROOT%") do set ROOT=%%~fI
set TARGET=%ROOT%\python\Lib\site-packages

echo Project root : "%ROOT%"
echo Target folder: "%TARGET%"

if not exist "%ROOT%\python" (
  echo [ERROR] Embedded python folder not found at "%ROOT%\python".
  echo Place your embedded/copy of Python there ^(containing python.exe^), then re-run this script.
  exit /b 1
)

if not exist "%TARGET%" (
  echo Creating target site-packages...
  mkdir "%TARGET%" || (echo [ERROR] Failed to create "%TARGET%" & exit /b 1)
)

REM Pick a system Python to perform the installation into the target folder
set "PY_CMD="
where py >nul 2>nul && set "PY_CMD=py -3"
if not defined PY_CMD (
  where python >nul 2>nul && set "PY_CMD=python"
)
if not defined PY_CMD (
  echo [ERROR] Could not find a system Python (py launcher or python) in PATH.
  echo Install Python 3.x from https://python.org and re-run.
  exit /b 1
)

echo Using system Python: %PY_CMD%

REM Ensure pip is available and up-to-date (ignore failures but continue)
%PY_CMD% -m ensurepip --upgrade  >nul 2>nul
%PY_CMD% -m pip install --upgrade pip setuptools wheel
if errorlevel 1 (
  echo [WARN] pip upgrade may have failed. Continuing...
)

echo.
echo Installing wheels into "%TARGET%" ...
REM Prefer wheels; versions can be adjusted if needed
%PY_CMD% -m pip install --only-binary=:all: --target "%TARGET%" reportlab pillow
if errorlevel 1 (
  echo [ERROR] Failed to install required packages (reportlab, pillow) into "%TARGET%".
  echo        Ensure internet connectivity or pre-download wheels and try again.
  exit /b 1
)

echo.
echo Verifying vendored packages using embedded python with PYTHONPATH...
set "PYTHONPATH=%TARGET%"
"%ROOT%\python\python.exe" -c "import sys; print('PYTHONPATH OK:', r'%PYTHONPATH%'); import reportlab, PIL, PIL.Image; print('ReportLab', reportlab.__version__)" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Verification failed. Embedded python could not import vendored packages.
  echo         Check that architecture ^(x86/x64^) matches, and that site-packages is correct.
  exit /b 1
)

echo.
echo [SUCCESS] Vendored packages are ready at:
echo          %TARGET%
echo You can now package the app: npm run dist
exit /b 0
