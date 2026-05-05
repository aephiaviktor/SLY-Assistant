@echo off
setlocal
cd /d %~dp0
rem Stability flags for problematic GPU/network-service crashes
start "" /b electron.exe . --disable-gpu --disable-software-rasterizer
endlocal
