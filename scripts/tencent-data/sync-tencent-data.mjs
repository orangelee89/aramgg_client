#!/usr/bin/env node
// 从掌盟（101.qq.com 背后的接口）抓取海克斯大乱斗数据，写成客户端镜像使用的静态文件。
// 由 .github/workflows/sync-tencent-data.yml 每天运行一次，产物推到 tencent-data 分支。
//
// 用法：node scripts/tencent-data/sync-tencent-data.mjs --out <目录>
//
// 输出：
//   global.json            {schemaVersion, hash, fetchedAt, names, rune, hero}（掌盟原文）
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
const MIN_CHAMPION_SUCCESS_RATIO = 0.5

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

async function fetchText(fetchImpl, url) {
  let lastError
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return stripBom(await response.text()).trim()
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
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

function globalBody(hash, fetchedAt, names, rune, hero) {
  return `{"schemaVersion":${SCHEMA_VERSION},"hash":${JSON.stringify(hash)},"fetchedAt":${JSON.stringify(fetchedAt)},"names":${names},"rune":${rune},"hero":${hero}}\n`
}

function championBody(hash, fetchedAt, payload) {
  return `{"schemaVersion":${SCHEMA_VERSION},"hash":${JSON.stringify(hash)},"fetchedAt":${JSON.stringify(fetchedAt)},"payload":${payload}}\n`
}

export async function syncTencentData({ outDir, fetchImpl = fetch, now = Date.now(), log = console.log }) {
  const fetchedAt = new Date(now).toISOString()

  const [names, rune] = await Promise.all([fetchText(fetchImpl, NAMES_URL), fetchText(fetchImpl, RUNE_URL)])
  if (!validateNames(names)) throw new Error('海克斯名称表格式异常')
  if (!validateRune(rune)) throw new Error('海克斯排行格式异常')

  let hero = null
  let heroIds = []
  for (const daysAgo of [1, 2]) {
    const text = await fetchText(fetchImpl, `${ODP_ORIGIN}/fuwen_aram_hero_rank_v2?dtstatdate=${getStatDate(now, daysAgo)}`)
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
      const text = await fetchText(fetchImpl, `${ODP_ORIGIN}/fuwen_hero_rank?championid=${id}`)
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
  const globalHash = contentHash(`${names}\n${rune}\n${hero}`)
  const globalPath = path.join(outDir, 'global.json')
  const previousGlobal = await readJson(globalPath)
  let globalFetchedAt = fetchedAt
  if (previousGlobal?.hash === globalHash) {
    globalFetchedAt = previousGlobal.fetchedAt
  } else {
    await writeIfChanged(globalPath, globalBody(globalHash, fetchedAt, names, rune, hero), null)
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

  log(`英雄 ${heroIds.length} 个，单英雄成功 ${successCount} 个，改动文件 ${changedFiles} 个`)
  return { changedFiles, heroCount: heroIds.length, championSuccess: successCount, globalHash }
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
