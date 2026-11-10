#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 22 或更新版本：https://nodejs.org"
  read -r -p "按回车关闭"
  exit 1
fi
if ! command -v ffprobe >/dev/null 2>&1; then
  echo "请先安装 ffmpeg。Mac 可执行：brew install ffmpeg"
  read -r -p "按回车关闭"
  exit 1
fi
if [ ! -x node_modules/.bin/agent-sdk ]; then
  npm install
fi
npm run draft
read -r -p "按回车关闭"
