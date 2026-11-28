# Live2D Studio

基于 **Wails 3 + Go / Gin + Eino + React / TypeScript** 的桌面 AI 伙伴工作室，参考 `example/Open-LLM-VTuber` 重写。应用、构建和运行均不依赖 Python。

![工作台](docs/screenshots/workspace.jpg)

当前版本已实现可运行的核心流程：Live2D 展示、角色人设、带上下文的流式对话、Eino 工具调用、语音输入与朗读、图片输入、会话持久化，以及透明桌宠窗口。原项目的完整功能覆盖情况见 [实现说明](docs/实现说明.md)。

## 产品官网

[MIMIKU · Live2D 创作者委托平台](https://syhappy.top/)

[MIMIKU](https://syhappy.top/) 是我们的产品官网，也是一个面向 Live2D 创作的委托撮合平台：在这里可以浏览角色立绘、Live2D 模型与视觉设计作品，按风格、档期和预算筛选入驻的画师、模型师与视觉设计师，直接与作者沟通报价并完成委托交付。Live2D Studio 负责在本机预览、配置和驱动模型，官网则帮助你找到合适的创作者与定制服务。

## 在 Windows 上开始

需要 Go 1.26+、Node.js 22+、npm，以及 Windows WebView2 Runtime。本项目固定 Wails v3.1.0，普通构建不需要额外安装 Wails CLI。

在项目根目录运行：

```powershell
# 安装前端依赖、构建界面、生成 Windows 桌面程序
.\scripts\build.ps1

# 打开桌面程序
.\bin\Live2DStudio.exe
```

已经安装依赖时可使用 `.\scripts\build.ps1 -SkipInstall`。生成的程序已嵌入前端、Cubism Core 和两套样本模型；运行时无需 Node、Go 或外部静态资源 CDN。

首次启动后进入 **设置 → 语言模型**，填写服务地址、模型名称和密钥，点击“保存并测试连接”。本地兼容服务可以不填写密钥。例如 Ollama 使用 `http://localhost:11434/v1`，模型名填写本机已经安装的模型。

## 开发与测试

```powershell
# 一条命令启动桌面开发：Vite 热更新 + Wails 桌面窗口（需要 wails3 CLI）
wails3 dev

# 也可以在浏览器中打开 wails3 dev 输出的 Vite 地址（默认 http://localhost:9245）
.\scripts\dev.ps1

# 只用浏览器调试前端：先启动无窗口后端，再启动 Vite（5173）
go run -tags headless . -headless
cd frontend; npm run dev

# 构建独立的无窗口服务
.\scripts\build.ps1 -Target server
.\bin\studio-server.exe -headless
# 浏览器打开 http://127.0.0.1:12393

# 后端集成测试与静态检查
cd server
go test -tags headless ./...
go vet -tags headless ./...

# 前端类型检查与生产构建
cd ../frontend
npm run check
npm test
npm run build
```

前端构建输出到 `server/internal/webui/dist`，Go 使用 `go:embed` 打包。修改前端后，需要重新构建 Go 程序才能更新桌面版；开发时使用 Vite。

## 功能

| 功能 | 当前行为 |
| --- | --- |
| Live2D 舞台 | 内置 Mao / Shizuku；鼠标跟随、点击动作、表情、缩放和背景切换 |
| 舞台设置 | 与 AI 对话在右侧切换；角色、背景、特效三个分类，切换时保留对话与舞台状态 |
| 背景素材 | 本机图片 / GIF / MP4 / WebM 导入、预览、应用、删除；视频静音循环、暂停、背景压暗与适配 |
| 叠加特效 | 樱花、星光、萤火、光晕、飘雪，可组合及调强度；另支持图片 / 视频自定义叠加层与混合模式 |
| 角色管理 | ZIP 导入 Cubism 模型，编辑角色名、介绍与 System Prompt |
| 文字对话 | OpenAI Chat Completions 兼容接口，SSE 流式输出、Markdown、停止生成 |
| 智能体 | 可选 Eino ReAct，支持指定时区查时、角色表情、四则运算和记忆检索。工具执行状态随回复保存 |
| 角色记忆 | 按角色添加、编辑和删除偏好与事实，新会话可继续参考 |
| 会话记录 | Gorm + 纯 Go SQLite；自动标题、重命名、搜索、刷新恢复、删除、Markdown 导出 |
| 图片输入 | PNG / JPEG / WebP 附件，需连接支持视觉的模型 |
| 语音输入 | 系统 Web Speech 或兼容 `/audio/transcriptions` 的 API，识别后填入输入框 |
| 语音输出 | 系统朗读或兼容 `/audio/speech` 的 API，可打断；播放期间角色嘴型动画 |
| 桌面窗口 | Wails 3 主窗口、置顶、透明桌宠、拖动、桌宠内文字聊天 |

浏览器语音可用性取决于浏览器、WebView 和系统。API 语音模式会请求麦克风权限；权限由用户自行授予。嘴型当前使用播放状态驱动的动画，不是音素或音频能量级别的精确口型。

## 使用角色记忆与工具

点击角色卡片或工作台聊天标题旁的记忆入口，可以管理该角色的记忆。在自己发送的消息下点击 **存为记忆**，可以编辑预填内容，再确认保存。每个角色可保存 100 条，每条最多 300 字。新回复会参考最近更新的 8 条。

在 **设置 → 智能体** 打开 **启用智能体工具** 并保存后，角色还可以通过关键词检索较早的记忆、按时区查询时间、调节表情和计算四则运算。调用状态显示在助手消息旁，并随会话保存。

同一工作台窗口里，切换页面或会话会保留各自的未发送草稿。刷新后会重新打开上次选中的会话。会话中的当前输入会完整发送，近期历史会按文字和图片的传输大小择取，原始消息保存在本机。

## 使用舞台管理

在工作台切换到 **舞台设置**：

- **表情与动作**：切换情绪、播放或随机播放动作、设置模型原生表情，或重置角色视图。
- **背景**：点击或拖入素材；图片最大 15MB，视频最大 150MB。支持 PNG、JPEG、WebP、GIF、MP4、WebM，视频编码需被当前 WebView 支持。可调整铺满 / 完整显示、压暗程度，视频默认静音循环。
- **特效**：可同时开启多个氛围特效并调整强度，或导入自己的图片 / GIF / 视频作为叠加层。透明素材适合“正常”，黑底粒子视频适合“滤色”。素材与背景共用本机素材库。

画布从下到上依次为背景、Live2D 角色、氛围特效、自定义叠加层、操作控件。特效不拦截角色点击。背景选择与特效配置保存在当前客户端；素材文件保存在数据目录的 `scene-media/`。

切回 **AI 对话** 时，舞台效果继续运行，对话输入与正在生成的回复均保留。

## 项目结构

遵循 `docs/项目标准格式.md` 的前后端拆分和模块化组织。唯一程序入口为根目录 `main.go`（调用 `server/app`）；原生桌面与 headless 启动使用构建标签隔离，`wails3 dev` 读取根目录 `Taskfile.yml` 与 `build/config.yml`。

```text
main.go                    唯一入口，调用 server/app
go.mod                    根模块，通过 replace 引用 server 模块
Taskfile.yml              wails3 dev 的编译、Vite 与启动任务
build/config.yml          wails3 dev 的文件监视与执行配置
frontend/src/
  api/ assets/ components/ hooks/ layouts/ pages/ router/ store/ types/ utils/
server/
  app/                     启动装配、桌面与无窗口适配
  configs/                 YAML 模板与本地配置
  docs/                    OpenAPI 接口定义
  internal/
    bootstrap/ config/ middleware/ migrate/ model/
    modules/               agent、character、conversation、memory、sceneassets、settings、speech、desktop
    pkg/ router/ tests/ webui/
scripts/                   PowerShell 开发与构建脚本
```

桌面单用户场景使用 SQLite，不依赖 MySQL、Redis、租户或用户登录。`service` 直接操作 Gorm 模型，无 repository 层。

## 配置与数据

可复制 `server/configs/config.example.yaml` 为 `server/configs/config.yaml`。本地配置、数据库和密钥均已加入 Git 忽略规则。

- 默认监听 `127.0.0.1:12393`；`port: 0` 可使用随机空闲端口。
- 使用 `go run` 从源码运行时，数据默认为 `server/data/studio.db`；模型导入到 `server/data/models/`。
- 独立分发时，保留 `bin/configs/`，数据默认放在可执行文件旁的 `data/`。
- 打包程序优先读取可执行文件旁的 `configs/`，从不同工作目录启动使用同一份数据；显式 `-config` 可指定配置文件。
- YAML 作为初始值，界面设置保存到 SQLite。优先级：环境变量 > 已保存设置 > YAML > 默认值。
- 支持 `STUDIO_HOST`、`STUDIO_PORT`、`STUDIO_DATA_DIR`、`STUDIO_LLM_BASE_URL`、`STUDIO_LLM_API_KEY`、`STUDIO_LLM_MODEL`、`STUDIO_SPEECH_API_KEY`。
- 密钥仅保存在本地配置或数据库，接口不回传密钥。设置页留空保留原密钥，勾选“清除”可删除；本地文件采用操作系统账户权限保护，当前未接入系统凭据库。
- 本地 API 限制 Host、Origin，并要求写操作携带客户端标识。应用面向本机使用。

备份时先退出应用，再备份整个数据目录。使用云端模型时，当前输入、选定上下文、图片及参与回复的角色记忆会发送到配置的模型服务。

## Docker（浏览器版，可选）

```powershell
docker compose up --build -d
```

打开 `http://127.0.0.1:12393`。容器使用 `headless` 构建与 SQLite 卷，并仅将端口发布到宿主机回环地址。容器内的 `localhost` 指容器自身；连接宿主机模型可使用 Docker Desktop 的 `host.docker.internal`。桌宠和原生窗口控制仅桌面版可用。Docker 配置已提供，本轮未在 Docker 引擎中执行验证。

## 接口与测试覆盖

接口前缀 `/api/v1`，普通返回 `{ code, message, data }`，写操作带 `X-Studio-Client: 1`。详见 [OpenAPI](server/docs/openapi.yaml)。

后端集成测试运行真实 Gin / Gorm / Eino，模型服务使用本地 HTTP 测试服务器。覆盖流式回复、ReAct、GPT-5 参数适配、失败原因持久化、桌面流传输、配置路径、素材上传 / 删除 / 类型 / 大小及视频 Range。前端测试覆盖 SSE 分块解码、两种 Live2D 参数命名、实际模型动作和表情枚举。已额外使用本机保存的模型配置验证真实文本回复；麦克风与语音 API 需在对应环境验证。

“保存并测试连接”走与聊天相同的 Eino 流式链路。GPT-5 / o 系列自动适配生成参数；发生错误时，消息旁显示认证、参数、模型、限流、网络等脱敏原因，可直接重新发送。

## 第三方资源

参考项目、Live2D 样本模型与 Cubism Core 的来源及许可见 [第三方说明](THIRD_PARTY.md)。模型与 Cubism Core 的许可证独立于应用代码；分发时保留相应说明。
