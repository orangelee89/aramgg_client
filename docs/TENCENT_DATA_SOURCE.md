# 腾讯官方数据源（海克斯大乱斗）

客户端在 aramgg 数据（`data.dtodo.cn`）之上，叠加腾讯官方攻略站 101.qq.com 使用的统计数据，避免等待上游发布新的 `dataVersion`。数据优先从本仓库的 `tencent-data` 分支（GitHub Actions 每天从掌盟抓取）读取，读不到再直连掌盟。

代码位置：`src/main/services/tencent-data/`

- `tencent-parsers.ts`：纯解析，接口格式变化时先改这里并补 `tests/unit/tencent-data.test.ts`
- `tencent-overlay.ts`：把腾讯数据叠加到 aramgg 的 `augments.json`、`champions.json` 和英雄详情格式上
- `tencent-mirror-client.ts`：读取 GitHub 数据镜像的协议（manifest 比对哈希）
- `tencent-data-service.ts`：启动同步、本地缓存和直连掌盟回退
- `scripts/tencent-data/sync-tencent-data.mjs` 与 `.github/workflows/sync-tencent-data.yml`：每天抓取并发布镜像

## 接口

接口没有公开文档，是从 101.qq.com 前端脚本中整理出来的，无需登录。不带 Referer 偶尔会短暂返回 501，同步脚本按攻略站网页的方式带上 `Referer: https://101.qq.com/` 和浏览器 UA，并在重试时退避等待。

| 用途 | 地址 |
| --- | --- |
| 海克斯名称表（id、中文名、品质、图标、是否新增） | `https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json` |
| 海克斯胜率/选取率排行 | `https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2?augmentid_level=255` |
| 英雄胜率/选取率排行 | `https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2?dtstatdate=YYYYMMDD` |
| 单英雄海克斯推荐 | `https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_hero_rank?championid=<id>` |

英雄排行必须带 `dtstatdate`，与腾讯攻略站一致取北京时间前一天（当天数据仍在累计），取不到再退一天。

## 数据镜像（GitHub）

- 工作流 `.github/workflows/sync-tencent-data.yml` 每天 UTC 04:17（北京时间 12:17）运行，也可在 Actions 页面手动触发；脚本说明见 `scripts/tencent-data/README.md`。
- 产物在 `tencent-data` 分支：`manifest.json`、`global.json`、`champions/<id>.json`。该分支每次都是一个新的 orphan 提交并强制推送，只保留最新一份；数据没变化时不推送。
- 客户端读取 `https://raw.githubusercontent.com/orangelee89/aramgg_client/tencent-data/...`。仓库公开，朋友不需要 GitHub 账号。
- 内置地址写在 `tencent-data-service.ts` 的 `TENCENT_MIRROR_BASE_URL`，只能被本机环境变量 `ARAMGG_TENCENT_MIRROR_ORIGIN` 覆盖（设为空字符串即只直连掌盟），只接受 https 或本机 http，远端配置不能修改。
- raw.githubusercontent.com 有约 5 分钟 CDN 缓存：manifest 请求带时间戳参数绕过缓存；数据文件请求带内容哈希参数，内容变了 URL 就变。

## 马服（zh_MY）译名

本 fork 的用户在北美服用马来西亚简中（Riot `zh_MY`）客户端，海克斯译名和国服大面积不同（掌盟 237 个里 188 个不同，例如国服「命运之武器」在马服叫「命定武器」）。翻译在同步脚本发布镜像时就完成，镜像里的名字本身就是马服名，客户端不检测游戏语言：

- 译名来自 Riot 官方游戏数据的 CommunityDragon 镜像（`latest` 跟随正式服补丁）：`plugins/rcp-be-lol-game-data/global/zh_my/v1/` 下的 `cherry-augments.json`（海克斯，只取掌盟名称表里有的 id 和 `ARAM_` 前缀条目）、`champion-summary.json`（英雄）、`items.json`（装备）。
- `global.json` 的 `names` 里，`name_cn` 已换成马服名，原国服名保留在 `name_cn_tencent`；英雄、装备的马服名放在 `localizedNames.champions` / `localizedNames.items`。译名变化会让 global 哈希变化，客户端照常比对下载。
- 某个海克斯在 CDragon 里没有马服名时保留国服名，并在同步日志里列出（目前只有两个测试服海克斯）。CDragon 取不到或行数过少时沿用上一份已发布数据里的译名；连上一份也没有才退回国服名，同样打日志。
- 客户端直接把镜像名当展示名（海克斯、英雄、装备），描述和 tooltip 仍是国服文本（CDragon 的 cherry-augments 没有描述）。
- OCR 同时用展示名（马服名）和 `name_cn_tencent`（国服名）匹配；被替换下来的 aramgg 旧名也留作别名。`src/main/data/augment-ocr-aliases.zh-MY.json` 内置静态表保留作离线兜底。
- 镜像不可用、直连掌盟时拿到的是国服名，展示国服名，OCR 依赖内置别名表识别马服卡面。

## 刷新策略

- 每次启动只检查一次：先下载几 KB 的 `manifest.json`，全局哈希和本地相同就不下载；不同才下载 `global.json` 并替换本地。运行期间不再定时检查。
- 单英雄推荐在本次运行内首次打开该英雄详情时，用启动时拿到的 manifest 比对哈希，相同用本地，不同才下载替换；同一次运行内不会重复检查。
- 镜像不可用（网络不通、格式异常、manifest 里没有该英雄）时，本次启动直连掌盟一次；直连也失败就继续用本地数据。
- 本地完全没有数据时，首次加载最多等待 8 秒（单英雄 4 秒），超时先显示 aramgg 原始数据。
- 解析出的条目明显过少（格式变化）时视为失败，不覆盖已有数据。
- 快照缓存在运行时数据目录的 `tencent-data/` 下，内容变化时会清空派生缓存，并让 OCR 名字库在下次识别前重新合并。

## 叠加规则

- 只作用于 `zh-CN`，其他语言保持 aramgg 原始数据。
- 已有海克斯：用腾讯的胜率、选取率和排名覆盖统计，等级按排名百分位换算（前 4% / 15% / 30% / 40%，与腾讯攻略站一致）。
- 腾讯有统计或标记为新增、但 aramgg 没有的海克斯会被追加，OCR 也因此能识别新卡。
- 单英雄推荐只有选取率和 S/A/B 等级，没有胜率；只保留 aramgg 由客户端上传战绩算出（带 `winRateSource`）的单英雄胜率，其余显示为空。
- 出装、加点等腾讯数据目前未接入，仍使用 aramgg 数据。

## 开关

设置环境变量 `ARAMGG_DISABLE_TENCENT_DATA=1` 可完全关闭腾讯数据源。vitest 和 OCR 夹具测试已默认关闭，测试不依赖线上数据（镜像与脚本测试用本地假数据）。
