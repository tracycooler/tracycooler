@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本：https://nodejs.org
  pause
  exit /b 1
)
where ffprobe >nul 2>nul
if errorlevel 1 (
  echo 请先安装 ffmpeg，并确认 ffprobe 可以在命令行运行。
  pause
  exit /b 1
)
if not exist node_modules\.bin\agent-sdk.cmd (
  call npm install
)
call npm run draft
pause
