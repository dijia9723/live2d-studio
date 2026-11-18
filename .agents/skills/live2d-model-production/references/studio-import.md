# Live2D Studio 打包与验收

## 运行时包

ZIP 里只能有一个 `.model3.json`，可以位于子目录。所有引用以该清单所在目录为基准，保留目录和大小写，用 `/`；不要放绝对路径、链接或包外资源。例如：

```text
hero.zip
└── runtime/
    ├── hero.model3.json
    ├── hero.moc3
    ├── hero.2048/texture_00.png
    ├── hero.physics3.json
    ├── motions/idle.motion3.json
    └── expressions/smile.exp3.json
```

- 检查 `FileReferences.Moc`、`Textures` 和已配置的 `Physics`、`Pose`、`DisplayInfo`。动作注册在 `Motions` 的组列表里，原生表情注册在 `Expressions`，每项 `File` 必须存在；仅把文件放进 ZIP 不会注册。`Idle` 是常用待机组，不是导入必需；已有模型的空组名合法。改包时保留既有的动作组与顺序及表情 `Name`，避免改变 Studio 使用的稳定 ID（`[组名, 索引]`、原生表情名）。仅改显示名时用 Studio 的「动作命名」，不要改清单 ID。
- 用清单 `Groups` 配置 `EyeBlink` / `LipSync` 时，ID 必须是模型实际已绑定的参数；`ParamEyeLOpen`、`ParamEyeROpen` 和 `ParamMouthOpenY` 是常用做法，不必重命名正常工作的自定义参数。Studio 口型优先使用模型声明的 ID，未声明时回退到常见嘴部参数。逐一检查表情、动作会不会与眨眼或口型争用参数。
- 不把 PSD、`.cmo3`、`.can3` 或不使用的素材混入运行时包。上传请求有 100 MiB 上限（包括 multipart 开销，ZIP 留余量），压缩包最多 4000 项，解压后限 200 MiB。动作清单读取限 2 MiB。发布第三方模型前核查分发许可并保留归属与授权说明；不把内置样本当作通用可转售素材。

先清理独立导出目录，再从该目录的父目录打包。命令中的脚本路径替换为本 Skill 的实际路径：

```powershell
python -m zipfile -c hero.zip runtime
python '<skill-dir>/scripts/check_studio_zip.py' hero.zip
```

预检不解压落盘、不导入或修改文件。它检查归档大小、路径、清单、主要资源和 ZIP 完整性；不验证 `.moc3` 是否受目标 Cubism Core 支持，也不保证贴图、绑定、动作或表情能正确渲染。项目规则如有变动，以 `server/internal/modules/character/service.go`、`module.go`、`actions.go` 为准；可对照 `server/internal/modules/character/assets/mao_pro/runtime/mao_pro.model3.json` 与 Shizuku 样本。

## 舞台验收

1. 在「角色管理 → 导入 Live2D 模型」导入 ZIP，确认角色卡片和工作台均显示正确模型与纹理。导入会新增角色；不要把它当作覆盖现有角色的操作。
2. 按实际交付范围检查待机、动作、表情切换与复位、眨眼、朗读时嘴型、头身联动和物理；如果用于桌宠，再测桌宠视图。工作台的预设情绪不等于模型原生表情；智能体工具显示「已发送」也不等于播放成功。
3. 缺文件或白模先看清单相对路径、大小写及加载请求；有贴图但不动，核对动作/表情项与参数 ID；Cubism Viewer 可开但 Studio 不可开，检查 Core 对导出目标版本的支持，再用兼容设置重新导出，不靠改 `Version` 或扩展名解决。
