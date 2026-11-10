@echo off
cd /d "%~dp0"
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo 请先安装 ffmpeg，并确认它可以在命令行运行。
  pause
  exit /b 1
)
call npm run vlog
pause
