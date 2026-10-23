import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncTencentData } from '../../scripts/tencent-data/sync-tencent-data.mjs'
import {
  fetchMirrorManifest,
  resolveMirrorBaseUrl,
  syncChampionFromMirror,
  syncGlobalFromMirror,
  type MirrorManifest,
  type RawRequest,
} from '../../src/main/services/tencent-data/tencent-mirror-client.ts'
import { createFakeTencent, fakeTencentResponse, type FakeTencent } from './helpers/tencent-fixtures.ts'

const MIRROR = 'https://raw.example.test/orangelee89/aramgg_client/tencent-data'

describe('resolveMirrorBaseUrl', () => {
  it('accepts https (with path) and local http only', () => {
    expect(resolveMirrorBaseUrl('https://raw.githubusercontent.com/orangelee89/aramgg_client/tencent-data/')).toBe(
      'https://raw.githubusercontent.com/orangelee89/aramgg_client/tencent-data'
    )
    expect(resolveMirrorBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(resolveMirrorBaseUrl('http://localhost:8787/data')).toBe('http://localhost:8787/data')
    expect(resolveMirrorBaseUrl('http://example.com')).toBe('')
    expect(resolveMirrorBaseUrl('https://user:pass@example.com')).toBe('')
    expect(resolveMirrorBaseUrl('https://example.com/data?x=1')).toBe('')
    expect(resolveMirrorBaseUrl('ftp://example.com')).toBe('')
    expect(resolveMirrorBaseUrl('not a url')).toBe('')
    expect(resolveMirrorBaseUrl('')).toBe('')
  })
})

describe('mirror sync protocol', () => {
  const manifest: MirrorManifest = {
    updatedAt: '2026-10-22T04:17:00.000Z',
    global: { hash: 'aaaaaaaaaaaaaaaa', fetchedAt: '2026-10-22T04:17:00.000Z' },
    champions: { '1': 'bbbbbbbbbbbbbbbb' },
  }

  it('busts the CDN cache for the manifest', async () => {
    const request = vi.fn<RawRequest>(async () => ({ status: 200, text: JSON.stringify({ schemaVersion: 1, ...manifest }) }))
    const parsed = await fetchMirrorManifest(MIRROR, request, 1234)
    expect(request).toHaveBeenCalledWith(`${MIRROR}/manifest.json?t=1234`)
    expect(parsed).toEqual(manifest)
  })

  it('does not download when the manifest hash matches', async () => {
    const request = vi.fn<RawRequest>()
    expect(await syncGlobalFromMirror(MIRROR, 'aaaaaaaaaaaaaaaa', manifest, request)).toEqual({
      status: 'unchanged',
      hash: 'aaaaaaaaaaaaaaaa',
    })
    expect(await syncChampionFromMirror(MIRROR, '1', 'bbbbbbbbbbbbbbbb', manifest, request)).toEqual({
      status: 'unchanged',
      hash: 'bbbbbbbbbbbbbbbb',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('downloads by hash-keyed URL when the hash differs', async () => {
    const body = JSON.stringify({ schemaVersion: 1, hash: 'aaaaaaaaaaaaaaaa', fetchedAt: 't', names: [], rune: {}, hero: {} })
    const request = vi.fn<RawRequest>(async () => ({ status: 200, text: body }))
    const result = await syncGlobalFromMirror(MIRROR, 'old', manifest, request)
    expect(request).toHaveBeenCalledWith(`${MIRROR}/global.json?h=aaaaaaaaaaaaaaaa`)
    expect(result.status).toBe('updated')
  })

  it('reports champions missing from the manifest without downloading', async () => {
    const request = vi.fn<RawRequest>()
    expect(await syncChampionFromMirror(MIRROR, '99', null, manifest, request)).toEqual({ status: 'missing' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('tencent-data-service startup sync', () => {
  let tencent: FakeTencent
  let mirrorDir: string
  let dataDir: string
  let mirrorCalls: string[]
  let mirrorDown: boolean
  const savedEnv = { ...process.env }

  const tencentFetch = async (url: string) => fakeTencentResponse(tencent, url) || new Response('nope', { status: 404 })

  async function publish(now: number) {
    await syncTencentData({ outDir: mirrorDir, fetchImpl: tencentFetch, now, log: () => {}, retryDelayMs: 0 })
    tencent.calls = []
  }

  async function launch() {
    vi.resetModules()
    return import('../../src/main/services/tencent-data/tencent-data-service.ts')
  }

  beforeEach(async () => {
    tencent = createFakeTencent()
    mirrorDir = await mkdtemp(path.join(os.tmpdir(), 'tencent-mirror-'))
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'tencent-local-'))
    mirrorCalls = []
    mirrorDown = false
    process.env.ARAMGG_DISABLE_TENCENT_DATA = '0'
    process.env.ARAMGG_TENCENT_MIRROR_ORIGIN = MIRROR
    process.env.ARAMGG_TENCENT_DATA_DIR = dataDir

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      if (url.startsWith(MIRROR)) {
        const relative = new URL(url).pathname.slice(new URL(MIRROR).pathname.length)
        mirrorCalls.push(relative)
        if (mirrorDown) {
          throw new Error('mirror down')
        }

        try {
          return new Response(await readFile(path.join(mirrorDir, relative), 'utf-8'))
        } catch {
          return new Response('404', { status: 404 })
        }
      }

      return tencentFetch(url)
    }))

    await publish(Date.UTC(2026, 9, 22, 4, 17))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    process.env = { ...savedEnv }
    await rm(mirrorDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('downloads on first launch and only checks the manifest on the next launch', async () => {
    let service = await launch()
    const updates = vi.fn()
    service.onTencentDataUpdated(updates)
    const first = await service.syncTencentDataOnStartup()
    expect(first?.mirrorHash).toMatch(/^[0-9a-f]{16}$/)
    expect(first?.augments.find((augment) => augment.id === '1001')).toMatchObject({ name: '命定武器', aliasNames: ['命运之武器'] })
    expect(first?.localizedNames?.champions['1']).toBe('马服英雄1')
    expect(mirrorCalls).toEqual(['/manifest.json', '/global.json'])
    expect(tencent.calls).toEqual([])
    expect(updates).toHaveBeenCalledTimes(1)

    mirrorCalls = []
    service = await launch()
    const second = await service.syncTencentDataOnStartup()
    expect(mirrorCalls).toEqual(['/manifest.json'])
    expect(second?.mirrorHash).toBe(first?.mirrorHash)

    mirrorCalls = []
    expect(await service.syncTencentDataOnStartup()).toBe(second)
    expect(mirrorCalls).toEqual([])
  })

  it('replaces local data when the published hash changes', async () => {
    let service = await launch()
    await service.syncTencentDataOnStartup()

    tencent.winRate = 0.6
    await publish(Date.UTC(2026, 9, 23, 4, 17))
    mirrorCalls = []
    service = await launch()
    const updated = await service.syncTencentDataOnStartup()
    expect(mirrorCalls).toEqual(['/manifest.json', '/global.json'])
    expect(updated?.augmentStats[0].winRate).toBe(0.6)
  })

  it('checks each champion once per launch and skips unchanged ones', async () => {
    let service = await launch()
    await service.syncTencentDataOnStartup()
    mirrorCalls = []
    const champion = await service.getTencentChampionSnapshot(1)
    expect(champion?.augments).toHaveLength(3)
    expect(mirrorCalls).toEqual(['/champions/1.json'])

    mirrorCalls = []
    await service.getTencentChampionSnapshot(1)
    expect(mirrorCalls).toEqual([])

    service = await launch()
    await service.syncTencentDataOnStartup()
    mirrorCalls = []
    expect((await service.getTencentChampionSnapshot(1))?.augments).toHaveLength(3)
    expect(mirrorCalls).toEqual([])

    tencent.championPick['1'] = 0.4
    await publish(Date.UTC(2026, 9, 23, 4, 17))
    service = await launch()
    await service.syncTencentDataOnStartup()
    mirrorCalls = []
    const changed = await service.getTencentChampionSnapshot(1)
    expect(mirrorCalls).toEqual(['/champions/1.json'])
    expect(changed?.augments[0].pickRate).toBe(0.4)
  })

  it('falls back to Tencent directly when the mirror is unreachable', async () => {
    mirrorDown = true
    const service = await launch()
    const snapshot = await service.syncTencentDataOnStartup()
    expect(snapshot?.mirrorHash).toBeUndefined()
    expect(tencent.calls.some((url) => url.includes('fuwen_aram_rune_rank_v2'))).toBe(true)

    const champion = await service.getTencentChampionSnapshot(2)
    expect(champion?.augments).toHaveLength(3)
    expect(tencent.calls.some((url) => url.includes('championid=2'))).toBe(true)
  })

  it('ignores a non-https mirror and goes direct', async () => {
    process.env.ARAMGG_TENCENT_MIRROR_ORIGIN = 'http://example.com'
    const service = await launch()
    expect(service.getTencentMirrorBaseUrl()).toBe('')
    const snapshot = await service.syncTencentDataOnStartup()
    expect(snapshot?.augmentStats.length).toBeGreaterThanOrEqual(50)
    expect(mirrorCalls).toEqual([])
  })
})
