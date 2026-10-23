// 从掌盟（101.qq.com 背后的接口）抓取海克斯大乱斗数据，写成客户端镜像使用的静态文件。
// 由 .github/workflows/sync-tencent-data.yml 每天运行一次，产物推到 tencent-data 分支。
//
// 用法：node scripts/tencent-data/sync-tencent-data.mjs --out <目录>
//
// 输出：
//   global.json            {schemaVersion, hash, fetchedAt, names, rune, hero, localizedNames}
//                          names 是掌盟海克斯名称表，name_cn 已换成 Riot zh_MY（马来西亚简中）译名，
//                          原国服名保留在 name_cn_tencent；localizedNames 是英雄 / 装备的 zh_MY 名。
//                          rune、hero 为掌盟原文。
//   champions/<id>.json    {schemaVersion, hash, fetchedAt, payload}
//   manifest.json          {schemaVersion, updatedAt, global:{hash, fetchedAt}, champions:{id: hash}}
// hash 是不含 fetchedAt 的内容 SHA-256 前 16 位；内容没变的文件不改写，git 就没有 diff。

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCHEMA_VERSION = 1
const ODP_ORIGIN = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy'
const NAMES_URL = 'https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json'
const RUNE_URL = `${ODP_ORIGIN}/fuwen_aram_rune_rank_v2?augmentid_level=255`
const MIN_ROWS = 50
const CONCURRENCY = 6
const RETRIES = 2
const TIMEOUT_MS = 20_000
const RETRY_BASE_DELAY_MS = 1_000
// 掌盟偶尔对不带来源页的请求短暂返回 501，按攻略站网页的方式带上来源页和浏览器 UA。
const REQUEST_HEADERS = {
  accept: 'application/json',
  referer: 'https://101.qq.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}
const MIN_CHAMPION_SUCCESS_RATIO = 0.5

// Riot 官方游戏数据（CommunityDragon 镜像，latest 跟随正式服补丁）里的马来西亚简中译名。
const LOCALIZED_LOCALE = 'zh-MY'
const CDRAGON_ZH_MY = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_my/v1'
const CDRAGON_AUGMENTS_URL = `${CDRAGON_ZH_MY}/cherry-augments.json`
const CDRAGON_CHAMPIONS_URL = `${CDRAGON_ZH_MY}/champion-summary.json`
const CDRAGON_ITEMS_URL = `${CDRAGON_ZH_MY}/items.json`
const MIN_LOCALIZED_AUGMENTS = 100
const MIN_LOCALIZED_CHAMPIONS = 100
const MIN_LOCALIZED_ITEMS = 100

export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function getStatDate(now, daysAgo) {
  const beijing = new Date(now + 8 * 3600_000 - daysAgo * 86400_000)
  return `${beijing.getUTCFullYear()}${String(beijing.getUTCMonth() + 1).padStart(2, '0')}${String(beijing.getUTCDate()).padStart(2, '0')}`
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function unwrapOdp(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }

  if (payload?.code !== 0 || !payload?.data?._fieldValues) {
    return null
  }

  for (const value of Object.values(payload.data._fieldValues)) {
    if (typeof value !== 'string') continue
    try {
      const inner = JSON.parse(value)
      if (inner && typeof inner === 'object') return inner
    } catch {
      // 继续看下一个字段
    }
  }

  return null
}

export function validateNames(text) {
  try {
    const list = JSON.parse(text)
    return Array.isArray(list) && list.filter((item) => item?.augmentID && item?.name_cn).length >= MIN_ROWS
  } catch {
    return false
  }
}

export function validateRune(text) {
  const inner = unwrapOdp(text)
  return typeof inner?.augmentlist === 'string' && inner.augmentlist.split('#').filter(Boolean).length >= MIN_ROWS
}

export function extractHeroIds(text) {
  const inner = unwrapOdp(text)
  if (typeof inner?.listcollect !== 'string') return []
  const ids = new Set()
  for (const chunk of inner.listcollect.split('#')) {
    const id = chunk.split('_')[0]
    if (/^\d+$/.test(id)) ids.add(id)
  }

  return [...ids].sort((left, right) => Number(left) - Number(right))
}

export function validateChampion(text) {
  const inner = unwrapOdp(text)
  return Boolean(inner && (inner.augment_json_irank || inner.augment_json))
}

function nameMap(list, { minRows, keep = () => true }) {
  if (!Array.isArray(list)) return null
  const map = {}
  for (const entry of list) {
    const id = Number(entry?.id)
    const name = String(entry?.nameTRA ?? entry?.name ?? '').trim()
    if (Number.isInteger(id) && id > 0 && name && keep(entry)) {
      map[String(id)] = name
    }
  }

  return Object.keys(map).length >= minRows ? map : null
}

// cherry-augments 里混着斗魂竞技场的强化；只留掌盟名称表里出现的 id 和 ARAM_ 前缀的大乱斗强化。
export function extractLocalizedAugments(cherryText, kiwiIds) {
  try {
    return nameMap(JSON.parse(cherryText), {
      minRows: MIN_LOCALIZED_AUGMENTS,
      keep: (entry) => kiwiIds.has(String(entry.id)) || String(entry.augmentNameId || '').startsWith('ARAM_'),
    })
  } catch {
    return null
  }
}

export function extractLocalizedNames(text, minRows) {
  try {
    return nameMap(JSON.parse(text), { minRows })
  } catch {
    return null
  }
}

// 上一份已发布数据里的译名，CDragon 取不到时沿用。
export function previousLocalized(previousGlobal) {
  const augments = {}
  for (const entry of Array.isArray(previousGlobal?.names) ? previousGlobal.names : []) {
    if (entry?.augmentID && entry?.name_cn_tencent && entry?.name_cn) {
      augments[String(entry.augmentID)] = entry.name_cn
    }
  }

  const localized = previousGlobal?.localizedNames
  const nonEmpty = (value) => (value && typeof value === 'object' && Object.keys(value).length > 0 ? value : null)
  return {
    augments: nonEmpty(augments),
    champions: nonEmpty(localized?.champions),
    items: nonEmpty(localized?.items),
  }
}

// 把名称表的 name_cn 换成译名，原国服名放进 name_cn_tencent；没有译名的保留国服名。
export function translateNames(namesText, augmentNames) {
  const list = JSON.parse(namesText)
  const missing = []
  const translated = list.map((entry) => {
    const id = String(entry?.augmentID ?? '')
    const tencentName = entry?.name_cn
    const localizedName = augmentNames?.[id]
    if (!localizedName) {
      missing.push(`${id} ${tencentName}`)
      return entry
    }

    return { ...entry, name_cn: localizedName, name_cn_tencent: tencentName }
  })

  return { text: JSON.stringify(translated), missing }
}

async function fetchOptional(fetchImpl, url, log, retryDelayMs) {
  try {
    return await fetchText(fetchImpl, url, retryDelayMs)
  } catch (error) {
    log(`[zh-MY] 获取失败：${error.message}`)
    return null
  }
}

export async function buildLocalized({ fetchImpl, names, previousGlobal, log, retryDelayMs }) {
  const kiwiIds = new Set(JSON.parse(names).map((entry) => String(entry?.augmentID ?? '')))
  const [cherryText, championsText, itemsText] = await Promise.all([
    fetchOptional(fetchImpl, CDRAGON_AUGMENTS_URL, log, retryDelayMs),
    fetchOptional(fetchImpl, CDRAGON_CHAMPIONS_URL, log, retryDelayMs),
    fetchOptional(fetchImpl, CDRAGON_ITEMS_URL, log, retryDelayMs),
  ])
  const previous = previousLocalized(previousGlobal)
  const pick = (fresh, fallback, label) => {
    if (fresh) return fresh
    if (fallback) {
      log(`[zh-MY] ${label} 本次取不到或行数过少，沿用上一份译名`)
      return fallback
    }

    log(`[zh-MY] ${label} 本次取不到且没有上一份译名，退回国服名`)
    return null
  }

  const augments = pick(cherryText && extractLocalizedAugments(cherryText, kiwiIds), previous.augments, '海克斯')
  const champions = pick(
    championsText && extractLocalizedNames(championsText, MIN_LOCALIZED_CHAMPIONS),
    previous.champions,
    '英雄'
  )
  const items = pick(itemsText && extractLocalizedNames(itemsText, MIN_LOCALIZED_ITEMS), previous.items, '装备')

  const { text, missing } = translateNames(names, augments)
  if (missing.length > 0) {
    log(`[zh-MY] ${missing.length} 个海克斯没有马服译名，保留国服名：${missing.join('，')}`)
  }

  const localizedNames = { locale: LOCALIZED_LOCALE, source: CDRAGON_ZH_MY, champions: champions || {}, items: items || {} }
  return {
    names: text,
    localizedNames: JSON.stringify(localizedNames),
    counts: {
      augments: augments ? Object.keys(augments).length : 0,
      champions: Object.keys(localizedNames.champions).length,
      items: Object.keys(localizedNames.items).length,
      missing: missing.length,
    },
  }
}

async function fetchText(fetchImpl, url, retryDelayMs = RETRY_BASE_DELAY_MS) {
  let lastError
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { headers: REQUEST_HEADERS, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return stripBom(await response.text()).trim()
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }

    if (attempt < RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 3 ** attempt))
    }
  }

  throw new Error(`${url}: ${lastError?.message || lastError}`)
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await worker(items[index])
      }
    })
  )
  return results
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {
    return null
  }
}

async function writeIfChanged(filePath, content, previousText) {
  if (previousText === content) return false
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp`
  await writeFile(temp, content, 'utf-8')
  await rename(temp, filePath)
  return true
}

async function readText(filePath) {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

function globalBody(hash, fetchedAt, names, rune, hero, localizedNames) {
  return `{"schemaVersion":${SCHEMA_VERSION},"hash":${JSON.stringify(hash)},"fetchedAt":${JSON.stringify(fetchedAt)},"names":${names},"rune":${rune},"hero":${hero},"localizedNames":${localizedNames}}\n`
}

function championBody(hash, fetchedAt, payload) {
  return `{"schemaVersion":${SCHEMA_VERSION},"hash":${JSON.stringify(hash)},"fetchedAt":${JSON.stringify(fetchedAt)},"payload":${payload}}\n`
}

export async function syncTencentData({
  outDir,
  fetchImpl = fetch,
  now = Date.now(),
  log = console.log,
  retryDelayMs = RETRY_BASE_DELAY_MS,
}) {
  const fetchedAt = new Date(now).toISOString()

  const [tencentNames, rune] = await Promise.all([
    fetchText(fetchImpl, NAMES_URL, retryDelayMs),
    fetchText(fetchImpl, RUNE_URL, retryDelayMs),
  ])
  if (!validateNames(tencentNames)) throw new Error('海克斯名称表格式异常')
  if (!validateRune(rune)) throw new Error('海克斯排行格式异常')

  let hero = null
  let heroIds = []
  for (const daysAgo of [1, 2]) {
    const text = await fetchText(
      fetchImpl,
      `${ODP_ORIGIN}/fuwen_aram_hero_rank_v2?dtstatdate=${getStatDate(now, daysAgo)}`,
      retryDelayMs
    )
    const ids = extractHeroIds(text)
    if (ids.length >= MIN_ROWS) {
      hero = text
      heroIds = ids
      break
    }
  }
  if (!hero) throw new Error('英雄排行格式异常或行数不足')

  const championTexts = await mapLimited(heroIds, CONCURRENCY, async (id) => {
    try {
      const text = await fetchText(fetchImpl, `${ODP_ORIGIN}/fuwen_hero_rank?championid=${id}`, retryDelayMs)
      return validateChampion(text) ? text : null
    } catch {
      return null
    }
  })
  const successCount = championTexts.filter(Boolean).length
  if (successCount < heroIds.length * MIN_CHAMPION_SUCCESS_RATIO) {
    throw new Error(`单英雄数据成功率过低（${successCount}/${heroIds.length}），不更新`)
  }

  let changedFiles = 0
  const globalPath = path.join(outDir, 'global.json')
  const previousGlobal = await readJson(globalPath)
  const localized = await buildLocalized({ fetchImpl, names: tencentNames, previousGlobal, log, retryDelayMs })
  const { names, localizedNames } = localized
  const globalHash = contentHash(`${names}\n${rune}\n${hero}\n${localizedNames}`)
  let globalFetchedAt = fetchedAt
  if (previousGlobal?.hash === globalHash) {
    globalFetchedAt = previousGlobal.fetchedAt
  } else {
    await writeIfChanged(globalPath, globalBody(globalHash, fetchedAt, names, rune, hero, localizedNames), null)
    changedFiles += 1
  }

  const champions = {}
  const championDir = path.join(outDir, 'champions')
  for (let index = 0; index < heroIds.length; index += 1) {
    const id = heroIds[index]
    const filePath = path.join(championDir, `${id}.json`)
    const previous = await readJson(filePath)
    const text = championTexts[index]
    if (!text) {
      if (previous?.hash) champions[id] = previous.hash
      continue
    }

    const hash = contentHash(text)
    champions[id] = hash
    if (previous?.hash !== hash) {
      await writeIfChanged(filePath, championBody(hash, fetchedAt, text), null)
      changedFiles += 1
    }
  }

  const keep = new Set(heroIds.map((id) => `${id}.json`))
  for (const file of await readdir(championDir).catch(() => [])) {
    if (!keep.has(file)) {
      await rm(path.join(championDir, file), { force: true })
      changedFiles += 1
    }
  }

  const manifestPath = path.join(outDir, 'manifest.json')
  const previousManifest = await readJson(manifestPath)
  const manifestCore = { global: { hash: globalHash, fetchedAt: globalFetchedAt }, champions }
  const previousCore = previousManifest
    ? { global: previousManifest.global, champions: previousManifest.champions }
    : null
  if (JSON.stringify(previousCore) !== JSON.stringify(manifestCore)) {
    const manifest = { schemaVersion: SCHEMA_VERSION, updatedAt: fetchedAt, ...manifestCore }
    await writeIfChanged(manifestPath, `${JSON.stringify(manifest)}\n`, await readText(manifestPath))
    changedFiles += 1
  }

  const { counts } = localized
  log(
    `英雄 ${heroIds.length} 个，单英雄成功 ${successCount} 个，改动文件 ${changedFiles} 个；` +
      `zh-MY 译名：海克斯 ${counts.augments}、英雄 ${counts.champions}、装备 ${counts.items}，无译名海克斯 ${counts.missing}`
  )
  return { changedFiles, heroCount: heroIds.length, championSuccess: successCount, globalHash, localizedCounts: counts }
}

function parseArgs(argv) {
  const index = argv.indexOf('--out')
  return { outDir: index >= 0 ? argv[index + 1] : '' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outDir } = parseArgs(process.argv.slice(2))
  if (!outDir) {
    console.error('用法：node scripts/tencent-data/sync-tencent-data.mjs --out <目录>')
    process.exit(2)
  }

  syncTencentData({ outDir: path.resolve(outDir) }).catch((error) => {
    console.error(`同步失败，未更新任何文件：${error.message}`)
    process.exit(1)
  })
}
