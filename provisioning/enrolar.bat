@echo off
rem Doble clic para enrolar TV Box. La configuración está en config.txt.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enrolar.ps1"
echo.
pause
