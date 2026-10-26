# DogSC · Windows 适配版

> **原创作者：神烦老狗（[@laogou717](https://github.com/laogou717)）· 原仓库：[laogou717/dogsc](https://github.com/laogou717/dogsc)**
>
> DogSC 由原作者设计、开发并以 MIT License 开源。本目录是在原版基础上做的 Windows 适配：产品形态、界面布局、功能定义，以及 `src/core/` 里移植的算法和默认参数都来自原版。它不是原作者的官方发布，使用中的问题请在本仓库反馈，不要提到原仓库。

DogSC 原版是 macOS 原生应用（Swift + AppKit / ScreenCaptureKit / AVFoundation）。这个目录是它的 Windows 适配：外壳换成 Electron，采集和编码换成 ffmpeg 与 WebCodecs，`RecorderCore` 里的核心算法（自动缩放规划、缩放插值与视口、光标弹簧平滑、自动跟随镜头、画布与摄像头布局、导出码率策略）按原版公式和默认参数逐项移植到 `src/core/`。

录制 → 剪辑 → 运镜 → 导出 这条主线可以完整走通。

![悬浮录制条](docs/images/recorder.png)

![编辑器：预览、运镜设置与时间线](docs/images/editor.png)

<sub>截图素材是自测用的色卡，不含个人录制内容。</sub>

## 怎么用

**已打包版**：从 [Releases](https://github.com/ZQYuan525/dogsc/releases) 下载 `DogSC-win32-x64.zip`，解压后双击 `DogSC.exe`。整个 `DogSC-win32-x64` 文件夹可以挪到任意位置。

**从源码运行**：双击 `start.bat`，或在本目录（`windows/`）执行：

```bash
npm install
npm start
npm run package   # 打包到 dist/DogSC-win32-x64/
```

如果 `npm install` 之后启动时报找不到 Electron，执行一次 `node node_modules/electron/install.js` 补下载。

需要：Windows 10 2004 及以上（建议 Windows 11）、Node.js 20+、PATH 里有 ffmpeg 6.0 以上完整版（`winget install Gyan.FFmpeg`）。

项目保存在 `视频\DogSC\` 下，每个项目是一个 `.dogscproject` 文件夹（`project.json` + `media/`）。

## 已经适配的功能

| 原版功能 | Windows 版做法 |
| --- | --- |
| 屏幕 / 区域录制 | ffmpeg `ddagrab`（Desktop Duplication），恒定 60 帧，不录系统光标 |
| 窗口录制 | 把所选窗口切到前台，按它的可见边界采集（见下方「与原版的差异」） |
| 摄像头、麦克风、系统声音 | 各自单独成轨；摄像头与麦克风同文件录制保证口型同步；系统声音走 WASAPI 回环 |
| 录制条 / 备忘录不入画 | `WDA_EXCLUDEFROMCAPTURE`，本软件的辅助窗口不进入自己的录制画面 |
| 悬浮备忘录 | 可拖动、调字号和背景不透明度，文稿自动保存在本机 |
| 录制标记 | 录制条上的标记按钮或 `Ctrl+Alt+M`，随项目保存，不进成片 |
| 自动缩放与自动跟随 | 按点击分组生成缩放段，连续操作时保持并跟随指针，停下后回落 |
| 手动缩放 | 时间线双击或按 `Z` 添加；可调倍率、焦点、缓动、进入 / 退出时长 |
| 时间线剪辑 | 分割、拖边裁短 / 恢复、删除、变速（0.5×–4×）、缩略图、撤销 / 重做 |
| 光标 | 读取 Windows 自带光标贴图重新合成；大小、平滑、静止隐藏、四种点击反馈、时间校准 |
| 摄像头排版 | 形状、大小、圆角、位置、镜像、描边、阴影、屏幕放大时让位 |
| 画面设计 | 比例、留白、素材位置与缩放、圆角、描边、阴影；背景支持五种图案、Windows 壁纸、自选图片、纯色 |
| 导出 | MP4（H.264 + AAC）与 M4A；原始 / 1080p / 1440p / 4K，30 / 60 FPS；显示阶段、已用与预计剩余时间，可取消 |

## 与原版的差异

- **窗口录制是按窗口边界做的区域采集。** 录制过程中窗口需要留在原位、不被别的窗口盖住。原因：ffmpeg 的窗口采集滤镜（`gfxcapture`）只在窗口内容变化时出帧，窗口静止时停止命令会卡住并丢掉已录内容，实测不可用。
- **光标外观是 Windows 的。** 默认"跟随录制"会按当时的光标形状在箭头、手型、文本光标之间切换。
- **剪切不做镜头接续。** 缩放、光标都以素材时间保存，剪掉一段后两侧的镜头状态各算各的；原版在剪切点做的缩放 / 光标过渡衔接没有移植。
- **项目包与 macOS 版不互通。** 字段命名对齐了原版，但素材编码和时间线结构不同。

## 还没有移植的部分

屏幕 3D（倾斜 / 透视 / 聚焦虚化）、开场动效、摄像头运动轨、贴图与画面柔化片段、裁切、样机外框（窗口 / 浏览器 / 设备）、场景预设、动态背景与视频背景、效果的复制粘贴、波形显示、片段拖动重排、英文界面、应用内更新。这些在原版里各自是独立模块，可以在现有的 `core/scene.js` + `editor/render.js` 上逐个加。

## 已知限制

- 采集端的 RGB→YUV 转换在 CPU 上做（为了颜色准确，统一按 BT.709 转换并写入码流标记）。1080p 60 帧在本机实测为 52–58 帧 / 秒，机器忙时会有个别帧重复；4K 屏幕的负载会更高，建议先试录一段。
- 多显示器按"主屏在前、其余从左到右"对应 ffmpeg 的输出序号，只在单显示器上实测过。
- 麦克风或摄像头打不开时，录制条会直接写出原因。最常见的是 Windows 隐私设置：**设置 → 隐私和安全性 → 麦克风（或摄像头）→ 允许桌面应用访问**。

## 验证

```bash
npm run selftest  # 端到端自测，约 1 分钟
```

`selftest` 会在本机真实跑一遍：录整屏 / 窗口 / 区域 → 整理成项目 → 导出三次（原始分辨率、剪切加变速后的 1080p60、仅音频）→ 把成片解码回来核对颜色和时长，再用合成信号把"摄像头 + 麦克风 + 系统声音"的附加轨路径走一遍。期间只会弹出一个色卡窗口，不操作桌面上的其他东西，也不打开真实的麦克风和摄像头。结果写在 `%TEMP%\dogsc-selftest\report.json`。

## 目录

```
src/core/       移植自 RecorderCore 的纯算法（Node 与渲染进程共用）
src/main/       主进程：窗口、ffmpeg 采集与混流、指针记录、项目整理
src/renderer/   录制条、区域 / 窗口选择、备忘录、项目库、编辑器
assets/         打包用的应用图标（由 Resources/AppIconMaster.png 生成）
```

界面字体与应用图标直接使用上级目录的 `Resources/`。

## 关于本目录的来源

本目录的源码是从 Windows 适配版安装包（`0.1.2-win.1`）的 `app.asar` 里还原出来的，`src/` 与安装包内容逐字节一致。安装包里没有附带核心算法回归测试（`test/`）和原打包脚本（`scripts/`），所以这里没有 `npm test`；`package.json` 里的 `start`、`selftest`、`package` 脚本和 `start.bat` 是重新补的，已在本机验证自测与打包通过。

## 许可与署名

- 原版 DogSC：Copyright (c) 2026 神烦老狗，[MIT License](../LICENSE)。
- `windows/` 目录下的适配代码同样以 MIT License 发布；再分发时请保留上面的原作者版权声明。
- 随附字体（阿里巴巴普惠体）采用其自身的许可，见 [`Resources/Fonts/`](../Resources/Fonts/README.md)。
