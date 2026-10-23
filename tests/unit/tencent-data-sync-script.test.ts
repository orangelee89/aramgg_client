import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentHash, getStatDate, syncTencentData } from '../../scripts/tencent-data/sync-tencent-data.mjs'
import {
  parseChampionAugments,
  parseHeroRank,
  parseKiwiAugments,
  unwrapOdpPayload,
} from '../../src/main/services/tencent-data/tencent-parsers.ts'
import {
  HERO_IDS,
  ZH_MY_MISSING_ID,
  ZH_MY_WEAPON_NAME,
  createFakeTencent,
  fakeTencentResponse,
  type FakeTencent,
} from './helpers/tencent-fixtures.ts'

describe('sync-tencent-data script', () => {
  let outDir: string
  let tencent: FakeTencent

  const fetchImpl = async (url: string) => fakeTencentResponse(tencent, String(url)) || new Response('nope', { status: 404 })
  let logs: string[]
  const run = (now: number) =>
    syncTencentData({ outDir, fetchImpl, now, log: (line: string) => logs.push(line), retryDelayMs: 0 })

  async function snapshotFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    for (const name of ['manifest.json', 'global.json']) {
      files[name] = await readFile(path.join(outDir, name), 'utf-8')
    }
    for (const name of await readdir(path.join(outDir, 'champions'))) {
      files[`champions/${name}`] = await readFile(path.join(outDir, 'champions', name), 'utf-8')
    }
    return files
  }

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), 'tencent-sync-'))
    tencent = createFakeTencent()
    logs = []
  })

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  it('writes global, champion and manifest files the client can parse', async () => {
    const result = await run(Date.UTC(2026, 9, 22, 4, 17))
    expect(result.heroCount).toBe(HERO_IDS.length)

    const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf-8'))
    expect(manifest.global.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(Object.keys(manifest.champions)).toHaveLength(HERO_IDS.length)

    const global = JSON.parse(await readFile(path.join(outDir, 'global.json'), 'utf-8'))
    expect(global.hash).toBe(manifest.global.hash)
    expect(parseKiwiAugments(global.names).length).toBeGreaterThanOrEqual(50)
    expect(parseHeroRank(unwrapOdpPayload(global.hero))).toHaveLength(HERO_IDS.length)

    const champion = JSON.parse(await readFile(path.join(outDir, 'champions', '1.json'), 'utf-8'))
    expect(champion.hash).toBe(manifest.champions['1'])
    expect(champion.hash).toBe(contentHash(JSON.stringify(champion.payload)))
    expect(parseChampionAugments(unwrapOdpPayload(champion.payload))).toHaveLength(3)
  })

  it('leaves every file untouched when nothing changed', async () => {
    await run(Date.UTC(2026, 9, 22, 4, 17))
    const before = await snapshotFiles()
    const result = await run(Date.UTC(2026, 9, 23, 4, 17))
    expect(result.changedFiles).toBe(0)
    expect(await snapshotFiles()).toEqual(before)
  })

  it('rewrites only the changed champion and the manifest', async () => {
    await run(Date.UTC(2026, 9, 22, 4, 17))
    const before = await snapshotFiles()
    tencent.championPick['20'] = 0.4
    const result = await run(Date.UTC(2026, 9, 23, 4, 17))
    expect(result.changedFiles).toBe(2)

    const after = await snapshotFiles()
    const changed = Object.keys(after).filter((name) => after[name] !== before[name]).sort()
    expect(changed).toEqual(['champions/20.json', 'manifest.json'])
  })

  it('keeps the previous champion file when one request fails', async () => {
    await run(Date.UTC(2026, 9, 22, 4, 17))
    const before = await snapshotFiles()
    tencent.failChampions.add('7')
    const result = await run(Date.UTC(2026, 9, 23, 4, 17))
    expect(result.changedFiles).toBe(0)
    expect(await snapshotFiles()).toEqual(before)
  })

  it('fails without writing anything when Tencent data is malformed', async () => {
    await run(Date.UTC(2026, 9, 22, 4, 17))
    await writeFile(path.join(outDir, 'marker'), 'x')
    const before = await snapshotFiles()
    tencent.brokenRune = true
    await expect(run(Date.UTC(2026, 9, 23, 4, 17))).rejects.toThrow('海克斯排行格式异常')
    expect(await snapshotFiles()).toEqual(before)

    tencent.brokenRune = false
    HERO_IDS.forEach((id) => tencent.failChampions.add(id))
    await expect(run(Date.UTC(2026, 9, 23, 4, 17))).rejects.toThrow('成功率过低')
    expect(await snapshotFiles()).toEqual(before)
  })

  it('writes zh_MY names into global.json and keeps the Tencent name for OCR', async () => {
    const result = await run(Date.UTC(2026, 9, 22, 4, 17))
    const global = JSON.parse(await readFile(path.join(outDir, 'global.json'), 'utf-8'))

    const weapon = global.names.find((entry: any) => entry.augmentID === 1001)
    expect(weapon.name_cn).toBe(ZH_MY_WEAPON_NAME)
    expect(weapon.name_cn_tencent).toBe('命运之武器')
    const parsed = parseKiwiAugments(global.names).find((meta) => meta.id === '1001')
    expect(parsed?.name).toBe(ZH_MY_WEAPON_NAME)
    expect(parsed?.aliasNames).toEqual(['命运之武器'])

    const missing = global.names.find((entry: any) => entry.augmentID === ZH_MY_MISSING_ID)
    expect(missing.name_cn).toBe(`海克斯${ZH_MY_MISSING_ID - 1001}`)
    expect(missing.name_cn_tencent).toBeUndefined()
    expect(logs.some((line) => line.includes('没有马服译名') && line.includes(String(ZH_MY_MISSING_ID)))).toBe(true)

    expect(global.localizedNames.locale).toBe('zh-MY')
    expect(global.localizedNames.champions['1']).toBe('马服英雄1')
    expect(global.localizedNames.champions['-1']).toBeUndefined()
    expect(global.localizedNames.items['3089']).toBe('马服装备89')
    // 掌盟名称表里的 59 个 + 60 个 ARAM_ 前缀额外条目；斗魂竞技场专属的被过滤。
    expect(result.localizedCounts).toMatchObject({ augments: 119, champions: 120, items: 120, missing: 1 })
  })

  it('keeps the previous translations when CommunityDragon is down', async () => {
    await run(Date.UTC(2026, 9, 22, 4, 17))
    const before = await snapshotFiles()
    tencent.cdragonDown = true
    const result = await run(Date.UTC(2026, 9, 23, 4, 17))
    expect(result.changedFiles).toBe(0)
    expect(await snapshotFiles()).toEqual(before)
    expect(logs.some((line) => line.includes('沿用上一份译名'))).toBe(true)
  })

  it('falls back to Tencent names when there is no previous translation', async () => {
    tencent.cdragonDown = true
    await run(Date.UTC(2026, 9, 22, 4, 17))
    const global = JSON.parse(await readFile(path.join(outDir, 'global.json'), 'utf-8'))
    expect(global.names.find((entry: any) => entry.augmentID === 1001).name_cn).toBe('命运之武器')
    expect(global.localizedNames.champions).toEqual({})
    expect(logs.some((line) => line.includes('退回国服名'))).toBe(true)
  })

  it('uses the previous Beijing day for hero stats', () => {
    expect(getStatDate(Date.UTC(2026, 9, 22, 4, 17), 1)).toBe('20261021')
    expect(getStatDate(Date.UTC(2026, 9, 22, 20, 0), 1)).toBe('20261022')
  })
})
