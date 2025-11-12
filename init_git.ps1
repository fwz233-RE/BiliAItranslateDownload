$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectPath = "C:\Users\123\Desktop\插件\音频保存"
Set-Location $projectPath

Write-Host "初始化 Git 仓库..."
git init

Write-Host "添加所有文件..."
git add .

Write-Host "提交更改..."
git commit -m "Initial commit: 音频保存插件"

Write-Host "设置主分支..."
git branch -M main

Write-Host "添加远程仓库..."
git remote add origin https://github.com/fwz233-RE/BiliAItranslateDownload.git

Write-Host "推送到远程仓库..."
git push -u origin main

Write-Host "完成！"

