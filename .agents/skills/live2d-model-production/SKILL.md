---
name: live2d-model-production
description: 为本仓库 Live2D Studio 制作或修改可导入的 Live2D Cubism 角色模型。用于角色立绘拆件、分层 PSD、Cubism 绑定、动作与表情制作、运行时 ZIP 导出或模型导入排查；不用于一般的 Studio 功能开发或普通头像制作。
---

# Live2D 角色制作

先确认用户手头的素材和期望交付物，只从需要的阶段做起。优先复用用户提供的合法素材，保留原文件，在独立制作目录生成衍生文件；不修改内置样本或现有角色数据来绕过导入。

## 按素材选择起点

- **设定、参考图或单张立绘**：确定画幅（头像 / 半身 / 全身）、要动的部位和目标动作。需要生成新立绘时，用可用的图像工具制作清晰的中性姿态；整张 PNG 不能直接当成可绑定素材。按运动关系拆开前后发、脸和颈、左右眼和眉、嘴唇与内口、身体及需要动作的配件。补画转头、眨眼或张嘴时会露出的区域。保留拆件母版，另存 RGB / 8 位的导入 PSD；每个可动部件一层，左右明确、名称不重复，重叠处保留余量。
- **分层 PSD 或 Cubism 工程**：已有 `.cmo3` 从编辑工程继续；有 `.can3` 时检查动画目标模型。只有 PSD 时，先核对合成与拆件，再导入 Cubism Editor 创建模型。先做可验收的基础绑定（头部转动、眨眼、张合嘴，按需求增减），再做身体、物理、表情与动作。用 ArtMesh、变形器和参数关键形状建立绑定；检查同一部位的组合极值，例如转头加闭眼或张嘴，确认没有穿帮、裂缝或绘制顺序错误。
- **运行时目录或 ZIP**：直接读实际 `.model3.json`，从运行时检查和打包开始。不要根据贴图、文件名或动作 JSON 推断能还原可编辑工程。需要改网格、变形器或参数绑定时，找原始 `.cmo3`。

## 导出与交付

1. 在 Cubism Editor 检查纹理图集和参数配置，按目标运行时支持范围导出 `.moc3`、`.model3.json`、贴图及所需物理数据。按需导出 `.motion3.json`；用 Cubism Viewer 制作或检查 `.exp3.json`。没有可用 Editor、没有真实导出或缺少素材时，交付能实际完成的内容并指出下一步；不要伪造 `.moc3` 或把普通分层动画称为 Live2D 模型。
2. 读 [Studio 打包与验收](references/studio-import.md)，整理运行时资源、跑只读 ZIP 预检。若用户只需要素材或工程，不必打包或导入；若要求实际导入，使用 Studio 正常导入流程，不直接写数据库。
3. 分开报告 **素材就绪、已真实导出、ZIP 预检、舞台验证**。只声称完成了有文件或实际观察支持的阶段；交付可编辑源文件与运行时 ZIP 时分开存放。

参考官方 Cubism 手册：[拆件](https://docs.live2d.com/en/cubism-editor-manual/divide-the-material/)、[PSD 条件](https://docs.live2d.com/en/cubism-editor-manual/precautions-for-psd-data/)、[运行时导出](https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/)、[表情导出](https://docs.live2d.com/en/cubism-editor-manual/setting-and-exporting-facial-expressions/)。
