# 本地 fork：原生 4K 抓帧 + OCR 链路改造

分支：`fork/4k-native-capture`（仅本地，不回推上游）。

## 背景

- 上游 0.2.17 用 Electron `desktopCapturer` 截整屏并缩到 1024×576（门控 640×360）。在 3840×2160 的屏幕上：
  - 一张缩略图要 720～1175 ms（日志 `avgCapture`），比 0.5 s 的目标间隔还慢，大量帧被跳过；
  - 画面只剩原图 27%，卡片标题十几像素高，OCR 把 "收缩射线" 读成 "缩小引擎"，大多数帧只认出 2/3 张卡；
  - 认不出的卡位保留旧结果，刷新海克斯后浮窗显示不更新（16×8 标题指纹分不开两个四字标题）。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/main/native-capture.ts` | 新增。用 `node-screenshots`（xcap）按显示器物理分辨率抓帧，返回 RGBA 原始像素。实测 4K 整帧 55～70 ms，`toRaw` 17 ms。模块加载失败或 `ARAMGG_DISABLE_NATIVE_CAPTURE=1` 时返回 null。 |
| `src/main/screenshot.ts` | `captureScreenshot` 在 `preferScreen` 时优先走原生抓帧，支持 `output: 'raw' \| 'png'`；原生连续失败 3 次后本会话回退 `desktopCapturer`。返回值新增 `image`（raw 帧）、`captureSource`。 |
| `src/main/image-analyzer.ts` | 分析器直接接受 raw 帧（跳过 PNG 编解码）；标题条放大倍数按目标宽度 640 px 自适应（≤1280 宽仍是 3×，4K 约 1×）；`ARAMGG_OCR_EXECUTION_PROVIDER=dml` 可让 ONNX Runtime 走 DirectML。 |
| `src/main/auto-screenshot-service.ts` | 请求 raw 输出，门控/完整 OCR 共用同一帧；部分识别截图落盘时再编码 PNG；日志和统计新增 `captureSource`、`frameSize`。 |
| `src/main/augment-partial-merge.ts`、`augment-title-matcher.ts` | 卡位上 OCR 文字明显是另一个名字、且指纹有轻微变化（≥4 位）时视为卡位已刷新，清空该槽等待重新识别；文字只是同名的一部分或模糊命中时保留。 |
| `package.json` | 依赖 `node-screenshots@0.2.8`；`asarUnpack` 加入其原生包。 |

## 实测数据（U32J59x 3840×2160，150% 缩放）

- 抓帧：Node 与 Electron 主进程内均为 3840×2160，55～70 ms/帧。
- OCR 夹具（`npm run test:augment-ocr`）：新增 `3840x2160-raw` 变体，三卡样本 579 ms 全对，门控 41～47 ms。
- DirectML：会话可建立、结果一致，但首帧要约 2.8 s 编译内核，之后 224～418 ms，对比 CPU 245～507 ms 优势不大，因此默认仍为 CPU。

## 第二个根因：Riot zh_MY 译名与站点 zh-CN 数据不一致

本机 Riot 客户端语言是 `zh_MY`（马来西亚简中），`/riotclient/region-locale` 返回 `zh_MY`。
对照 Community Dragon `zh_my/v1/cherry-augments.json`，站点 16.19.1 数据里的 211 个海克斯有 **170 个** 译名不同
（"此路不通"=国服"不动如山"，"广域武器"="更万用的瞄准镜"，"收缩射线"="缩小射线"，"火焰烙印"="火上浇油"，
"无尽毁灭风暴"="无尽大杀四方"……）。4K 抓帧后 OCR 已能逐字读对标题，但名字库里没有这些字，`matchedCount=0`。

- `src/main/data/augment-ocr-aliases.zh-MY.json`：按 augment id 内置 zh_MY 名字（cdragon 16.19），另附本机客户端实际显示过的变体。
- `image-analyzer.ts` 在默认语言名字库加载后并入这份别名（`mergeBundledOcrAliases`），只补 `ocrNames`，展示名和稀有度仍用站点数据。
- 匹配到后 `name` 为屏幕上的 zh_MY 名字，`displayName` 为站点 zh-CN 名字，胜率按 id 查询不受影响。

刷新 cdragon 名字表：拉取 `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_my/v1/cherry-augments.json`，
按站点 `augments.json` 的 id 取 `nameTRA` 重新生成该 JSON。

## 开关

- `ARAMGG_DISABLE_NATIVE_CAPTURE=1`：关闭原生抓帧，恢复上游行为。
- `ARAMGG_OCR_EXECUTION_PROVIDER=dml`：OCR 走 GPU（可选）。

## 验证命令

```bash
npm run test:unit
npm run type-check
npm run lint
npm run test:augment-ocr
npm run pack
```

## 发布（Windows + macOS）

- `.github/workflows/build-release.yml`：推送 `fork-*` 标签（如 `fork-v0.2.17-1`）或在 Actions 页面手动触发，
  GitHub 的 Windows / macOS 机器分别打包并挂到同名 Release：
  - `aramgg_client-Setup-<版本>-win-x64-4K-fork.exe`
  - `aramgg_client-<版本>-mac-arm64.dmg/.zip`（Apple 芯片）、`-mac-x64`（Intel）
- 下载页：https://github.com/orangelee89/aramgg_client/releases/latest

## macOS 版本

- 未签名，首次运行需右键"打开"。
- 抓屏需在"系统设置 → 隐私与安全性 → 屏幕录制"里授权。
- 客户端凭据：`ps -axo pid=,command=` 查找 `LeagueClientUx` 进程命令行；找不到时读
  `/Applications/League of Legends.app/Contents/LoL/lockfile`。
- 浮窗在 macOS 上设置 `visibleOnFullScreen`，以便覆盖全屏游戏；游戏内实际表现需在真机验证。
- 打包配置注意：平台文件集（`mac.files`）只能写正向规则；只写排除项会被 electron-builder 当作"包含全部文件"，把整个仓库打进 asar。
