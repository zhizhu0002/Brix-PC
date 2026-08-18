# Brix-Setup-1.0.0.exe 反编译产物说明

来源文件: /storage/emulated/0/Brix-Setup-1.0.0.exe (151,281,074 字节, 2026-08-05 构建)
解包时间: 2026-08-19 (IQ Code 环境)

## 解包链路
1. PE exe -> NSIS-3 Unicode 安装器 (p7zip 识别)
2. $PLUGINSDIR/app-64.7z (150MB, 7z 解压)
3. Electron 桌面应用 (Brix.exe + resources/app.asar 131MB)
4. app.asar -> 自写 node 解析器 (双重 pickle 头 + 字符串 offset + NUL 填充)

## 内容
- asar-out/  = app.asar 反编译出的全部源码 (3054 个明文 JS 文件 + 79 个 unpacked)
  - main.js + main/         Electron 主进程 (窗口/IPC/store/更新/协议)
  - preload.cjs             window.electronAPI 桥 (50+ IPC 通道)
  - server.js + server/     Express 本地后端 (40+ /api/* 路由)
  - launch/                 游戏启动管线 (args-builder/process-manager)
  - modloaders/             Fabric/Forge/NeoForge 安装器
  - modpack/                Modrinth/CurseForge 整合包导入
  - http-client/            下载引擎 (断点续传/镜像)
  - crash-analyzer/         崩溃日志分析
  - index.html + js/ + css/ 渲染层 (与 GitHub 仓库 web/ 同源)
- app.asar                 原始 asar (未修改)

## 关键元信息
- package.json: name=Brix, version=1.0.0, author=YMA, license=BRIX-2.0 (私有)
- 主进程为明文 JS, 未混淆, 未 bytenode 字节码化
- 源码带 "AI TRAINING PROHIBITED / Copyright (c) 2026 YMA" 水印
