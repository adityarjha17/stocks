@echo off
cd /d "%~dp0"
title 1.Stocks (running)
echo Checking the NSE company list used by search...
call node scripts\update-symbols.mjs
echo.
echo Starting the stock app...
echo When you see "Ready on http://localhost:8787", open that address.
echo To stop: press Ctrl+C in this window, or just close it.
echo.
call npm run dev
pause
