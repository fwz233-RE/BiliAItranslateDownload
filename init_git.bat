@echo off
chcp 65001 >nul
cd /d "%~dp0"
git init
git add .
git commit -m "Initial commit: 音频保存插件"
git branch -M main
git remote add origin https://github.com/fwz233-RE/BiliAItranslateDownload.git
git push -u origin main

