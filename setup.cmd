@echo off
setlocal
cd /d "%~dp0"
title 1.Stocks setup
echo ===== 1.Stocks setup =====
echo.
echo [Step 1] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 goto INSTALL_NODE
for /f "delims=" %%v in ('node -v') do echo Node.js found: %%v
echo.
echo [Step 2] Installing project tools (Wrangler) into this folder only...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo *** npm install FAILED. Leave this window open so Claude can read the error. ***
  pause
  exit /b 1
)
echo.
echo [Step 3] Version check
for /f "delims=" %%v in ('node -v') do echo node     %%v
for /f "delims=" %%v in ('npm -v') do echo npm      %%v
call npx wrangler --version
echo.
echo ===== Setup finished. Next: double-click start.cmd =====
pause
exit /b 0

:INSTALL_NODE
echo Node.js is not installed.
where winget >nul 2>nul
if errorlevel 1 (
  echo winget is not available on this PC.
  echo Please install Node.js LTS manually from https://nodejs.org then run setup.cmd again.
  pause
  exit /b 1
)
echo Installing Node.js LTS using winget (Microsoft's package manager).
echo You may be asked to accept the winget source agreement (type Y) and to allow an admin prompt (click Yes).
echo.
winget install --id OpenJS.NodeJS.LTS -e --source winget
echo.
echo If the install succeeded: CLOSE this window, then double-click setup.cmd again
echo (a new window is needed so Windows can find node).
pause
exit /b 0
