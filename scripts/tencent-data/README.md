# 掌盟数据同步脚本

`sync-tencent-data.mjs` 从掌盟（101.qq.com 背后的接口）抓取海克斯大乱斗数据，并用 Riot 官方 zh_MY（马来西亚简中）译名替换展示名，写成客户端镜像使用的静态文件。零依赖，Node 18+ 即可运行。

```bash
node scripts/tencent-data/sync-tencent-data.mjs --out <目录>
```

由 `.github/workflows/sync-tencent-data.yml` 每天北京时间 12:17 运行一次（也可在 Actions 页面手动触发），产物推到本仓库的 `tencent-data` 分支。该分支每次都是一个全新的 orphan 提交并强制推送，始终只保留最新一份，仓库不会越来越大；数据没变化时不推送。

## 输出

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | `{schemaVersion, updatedAt, global:{hash, fetchedAt}, champions:{id: hash}}` |
| `global.json` | `{schemaVersion, hash, fetchedAt, names, rune, hero, localizedNames}`：`names` 是掌盟名称表，`name_cn` 已换成马服名、国服名放在 `name_cn_tencent`；`localizedNames` 是英雄 / 装备的马服名；`rune`、`hero` 为掌盟原文 |
| `champions/<id>.json` | `{schemaVersion, hash, fetchedAt, payload}`，掌盟原文 |

`hash` 是不含 `fetchedAt` 的内容 SHA-256 前 16 位。内容没变的文件不会改写（保留旧的 `fetchedAt`）。

## 失败处理

- 名称表、海克斯排行、英雄排行任一格式异常（`code` 不为 0、行数不足）：整体失败退出，不写任何文件。
- 单个英雄请求失败（每个重试 2 次）：保留上一份文件；成功率低于一半时视为整体失败。
- 英雄排行取北京时间前一天，取不到再试前两天。
- 马服译名来自 CommunityDragon（`zh_my` 的 `cherry-augments.json`、`champion-summary.json`、`items.json`）。取不到时沿用上一份已发布的译名，连上一份也没有才退回国服名；没有马服名的海克斯保留国服名。这些情况都会打日志，但不会让整个同步失败。
- 请求带 `Referer: https://101.qq.com/` 和浏览器 UA；失败时按 1 秒、3 秒退避重试。
