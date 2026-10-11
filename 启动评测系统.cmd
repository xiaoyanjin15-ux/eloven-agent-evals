@echo off
cd /d "%~dp0"
title Agent Evals
where node >nul 2>nul || (
  echo Node.js 24 or later is required. Download it from https://nodejs.org/
  pause
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo Node.js 24 or later is required. Current major version: %NODE_MAJOR%
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies for the first run...
  call npm ci || goto :error
)
echo Starting Agent Evals at http://127.0.0.1:8000/
echo Keep this window open while using Playwright.
echo.
call npm run dev
if errorlevel 1 goto :error
echo.
echo Agent Evals stopped. Press any key to close.
pause >nul
exit /b 0

:error
echo.
echo Agent Evals failed to start. Review the error above.
pause
exit /b 1
