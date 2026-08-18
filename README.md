# Brix-PC
Android版https://github.com/wswangzai/Brix
作者并非本人，如有侵权提issue删除。
一个基于 Electron 的 Minecraft（我的世界）启动器 / 模组管理器，适用于 Windows。

## 简介

Brix-PC 是 Brix 的 Windows 桌面版，采用 **Electron 主进程 + 本地 HTTP 后端 + H5 前端** 的混合架构。主进程负责窗口管理、IPC 桥接与深链协议，后端（Express）承载游戏启动、版本管理、模组管理等业务逻辑，前端由 HTML / CSS / JavaScript 实现。

## 目录结构

```
.
├── main.js                 # Electron 主进程入口（窗口/IPC/协议/更新）
├── main/                   # 主进程模块
│   ├── store.js            # 本地数据持久化（JSON）
│   ├── updater.js          # 更新系统（云 API 检查 + 下载执行）
│   ├── window-manager.js   # 无边框窗口管理
│   ├── protocol-handler.js # 深链协议（brix://）
│   ├── jar-parser.js       # JAR 解析
│   └── crash-log.js        # 崩溃日志
├── preload.cjs             # window.electronAPI 桥接（50+ IPC 通道）
├── server.js               # 本地后端入口（Express）
├── server/                 # 后端业务模块
│   ├── api/routes/         # /api/* REST 路由（40+ 端点）
│   ├── launch/             # 游戏启动管线（JVM 参数构造/进程管理）
│   ├── modloaders/         # 加载器安装（Fabric/Forge/NeoForge/OptiFine）
│   ├── modpack/            # 整合包导入（Modrinth/CurseForge）
│   ├── http-client/        # 下载引擎（断点续传/镜像）
│   ├── crash-analyzer/     # 崩溃日志分析
│   ├── java/               # Java 检测与下载
│   ├── versions/           # 版本清单/解析/合并
│   ├── network.js          # UPnP/WebSocket relay/mcPing
│   └── terracotta.js       # 陶瓦联机（P2P 组网）
├── index.html              # 渲染层主入口
├── js/                     # 前端业务（app/ 下 30+ 模块）
├── css/                    # 样式
├── plugins/                # 插件（modrinth、mod-dev-tools）
├── bbot/                   # BBot AI 助手组件
├── assets/ img/ fonts/     # 静态资源
└── package.json            # 依赖配置（name=Brix, license=BRIX-2.0）
```

## 技术栈

- **壳**：Electron（主进程 `main.js` + 预加载 `preload.cjs`）
- **后端**：Node.js + Express（本地 HTTP 服务）
- **前端**：原生 HTML / CSS / JavaScript + xterm.js + monaco-editor + Three.js（3D 皮肤预览）
- **存储**：JSON 文件（`main/store.js`），账户 token AES-256-CBC 加密落盘
- **依赖**：electron-updater、sharp、adm-zip、ws、msedge-tts

## 主要功能

- Minecraft 游戏启动与版本管理
- 模组浏览、安装、整合包导入（Modrinth 平台集成）
- 微软账号 OAuth 登录 + 外置登录 + 离线账号
- Java 运行时检测与管理
- 云同步、AI 模组翻译、TTS 语音、个性化、壁纸引擎
- 3D 皮肤预览、局域网联机（EasyTier + 陶瓦联机）

## 说明

- 应用入口：`main.js` → 创建 BrowserWindow → 加载 `index.html`
- 后端服务：`server.js` → Express 本地 HTTP（版本/启动/模组/账户等）
- 深链协议：`brix://`
- 本仓库代码仅供学习和参考，使用者请于24小时之内删除，禁止用于商业用途
