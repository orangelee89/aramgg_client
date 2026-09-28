/**
 * 本地 fork 构建标识。
 *
 * fork 与上游共用版本号和更新源，上游发布新版本时 electron-updater 会把官方安装包
 * 下载下来并在退出时安装，直接覆盖 fork 的改动。因此 fork 构建只保留"有新版本"的提示，
 * 不走自动下载/安装；同步上游要手动合并后重新 `npm run pack`。
 */
export const IS_FORK_BUILD = true
export const FORK_LABEL = '4K-fork'
export const FORK_UPDATE_NOTICE = 'fork 构建不自动更新：上游有新版本时请合并源码后重新打包'
