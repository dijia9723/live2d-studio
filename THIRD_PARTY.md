# 第三方资源与授权

项目自有代码的许可见 [LICENSE](LICENSE)。下列第三方资源适用各自的许可条款。

## Live2D 样本模型与运行时

Windows 发行版随附 Live2D Inc. 的 [Mao（Niziiro Mao）](https://www.live2d.com/en/learn/sample/niziiro-mao/) 和 [Shizuku](https://www.live2d.com/en/learn/sample/shizuku/) 两个样本的运行时文件。使用须遵守 [样本数据使用条款](https://www.live2d.com/en/learn/sample/model-terms/) 和 [免费素材许可协议](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)。Shizuku 的单独条款要求使用原有名称与设定。完整的随附授权文本见 `LICENSE-Live2D.md`（源码中位于 `frontend/public/live2d-models/`）。

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

Live2D Cubism Core（`frontend/public/lib/live2dcubismcore.min.js`）版权所有 © Live2D Inc.，适用 [Live2D 专有软件许可协议](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。

## OCR 与摄像头跟随

- PP-OCRv6 tiny、PaddleOCR、ONNX Runtime 和 OpenCV 的来源及许可证随前端 `ocr/` 资源提供。源码中位于 `frontend/public/ocr/`，Windows 发行包中位于 `licenses/ocr/`。
- 摄像头跟随使用 Google MediaPipe 的 Face Landmarker 和 Pose Landmarker Lite。模型地址和校验值见 `frontend/src/assets/tracking/README.md`，同一份说明随发行包提供。

## 参考项目

[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) 使用 MIT 许可证，版权为 Copyright (c) 2025 Yi-Ting Chiu。其 Live2D 样本模型适用各自的条款。

```text
MIT License

Copyright (c) 2025 Yi-Ting Chiu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
