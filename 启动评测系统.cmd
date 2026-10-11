@echo off
cd /d "%~dp0"
title Agent Evals
echo Starting Agent Evals at http://127.0.0.1:8000/
echo Keep this window open while using Playwright.
echo.
call npm run dev
echo.
echo Agent Evals stopped. Press any key to close.
pause >nul
