# 腾讯官方数据源（海克斯大乱斗）

客户端在 aramgg 数据（`data.dtodo.cn`）之上，直接叠加腾讯官方攻略站 101.qq.com 使用的统计数据，避免等待上游发布新的 `dataVersion`。每台客户端自己请求腾讯接口，不需要额外服务器。

代码位置：`src/main/services/tencent-data/`

- `tencent-parsers.ts`：纯解析，接口格式变化时先改这里并补 `tests/unit/tencent-data.test.ts`
- `tencent-overlay.ts`：把腾讯数据叠加到 aramgg 的 `augments.json`、`champions.json` 和英雄详情格式上
- `tencent-data-service.ts`：请求、本地缓存和定时刷新

## 接口

接口没有公开文档，是从 101.qq.com 前端脚本中整理出来的，无需登录，也不需要 Referer。

| 用途 | 地址 |
| --- | --- |
| 海克斯名称表（id、中文名、品质、图标、是否新增） | `https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json` |
| 海克斯胜率/选取率排行 | `https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2?augmentid_level=255` |
| 英雄胜率/选取率排行 | `https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2?dtstatdate=YYYYMMDD` |
| 单英雄海克斯推荐 | `https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_hero_rank?championid=<id>` |

英雄排行必须带 `dtstatdate`，与腾讯攻略站一致取北京时间前一天（当天数据仍在累计），取不到再退一天。

## 刷新策略

- 启动后台服务时取一次全局数据（名称表、海克斯排行、英雄排行），之后每 3 小时刷新。
- 单英雄推荐在打开英雄详情时按需请求，超过 3 小时的缓存会在后台刷新。
- 首次没有缓存时最多等待 8 秒（单英雄 4 秒），超时就先显示 aramgg 原始数据。
- 请求失败时保留上一份数据；解析出的条目明显过少（格式变化）时视为失败，不覆盖已有数据。
- 快照缓存在运行时数据目录的 `tencent-data/` 下，内容变化时会清空派生缓存，并让 OCR 名字库在下次识别前重新合并。

## 叠加规则

- 只作用于 `zh-CN`，其他语言保持 aramgg 原始数据。
- 已有海克斯：用腾讯的胜率、选取率和排名覆盖统计，等级按排名百分位换算（前 4% / 15% / 30% / 40%，与腾讯攻略站一致）。
- 腾讯有统计或标记为新增、但 aramgg 没有的海克斯会被追加，OCR 也因此能识别新卡。
- 单英雄推荐只有选取率和 S/A/B 等级，没有胜率；只保留 aramgg 由客户端上传战绩算出（带 `winRateSource`）的单英雄胜率，其余显示为空。
- 出装、加点等腾讯数据目前未接入，仍使用 aramgg 数据。

## 开关

设置环境变量 `ARAMGG_DISABLE_TENCENT_DATA=1` 可完全关闭腾讯数据源。vitest 和 OCR 夹具测试已默认关闭，测试不依赖线上数据。
