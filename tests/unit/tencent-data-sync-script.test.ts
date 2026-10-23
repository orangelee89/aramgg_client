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
import { HERO_IDS, createFakeTencent, fakeTencentResponse, type FakeTencent } from './helpers/tencent-fixtures.ts'

describe('sync-tencent-data script', () => {
  let outDir: string
  let tencent: FakeTencent

  const fetchImpl = async (url: string) => fakeTencentResponse(tencent, String(url)) || new Response('nope', { status: 404 })
  const run = (now: number) => syncTencentData({ outDir, fetchImpl, now, log: () => {} })

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

  it('uses the previous Beijing day for hero stats', () => {
    expect(getStatDate(Date.UTC(2026, 9, 22, 4, 17), 1)).toBe('20261021')
    expect(getStatDate(Date.UTC(2026, 9, 22, 20, 0), 1)).toBe('20261022')
  })
})
