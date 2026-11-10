#!/bin/bash
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "请先安装 ffmpeg。Mac 可执行：brew install ffmpeg"
  read -r -p "按回车关闭"
  exit 1
fi
npm run vlog
read -r -p "按回车关闭"
