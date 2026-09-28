import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRawFrame } from '../../src/main/native-capture.ts'
import { isTitleTextCompatibleWithNames } from '../../src/main/augment-title-matcher.ts'

describe('native capture raw frames', () => {
  it('recognizes RGBA raw frames and rejects png buffers', () => {
    expect(isRawFrame({ buffer: Buffer.alloc(16), width: 2, height: 2, channels: 4 })).toBe(true)
    expect(isRawFrame(Buffer.alloc(16))).toBe(false)
    expect(isRawFrame(null)).toBe(false)
    expect(isRawFrame({ buffer: 'nope', width: 2, height: 2, channels: 4 })).toBe(false)
  })
})

describe('title text compatibility', () => {
  it('accepts exact, fuzzy and partial reads of the same title', () => {
    expect(isTitleTextCompatibleWithNames('缩小引擎', ['缩小引擎'])).toBe(true)
    expect(isTitleTextCompatibleWithNames('缩小引擎 伤害', ['缩小引擎'])).toBe(true)
    expect(isTitleTextCompatibleWithNames('缩小引', ['缩小引擎'])).toBe(true)
    expect(isTitleTextCompatibleWithNames('缩小弓擎', ['缩小引擎'])).toBe(true)
    expect(isTitleTextCompatibleWithNames('巨像之勇氣', ['巨像之勇气', '巨像之勇氣'])).toBe(true)
  })

  it('rejects a clearly different title', () => {
    expect(isTitleTextCompatibleWithNames('收缩射线', ['缩小引擎'])).toBe(false)
    expect(isTitleTextCompatibleWithNames('火焰烙印', ['质变：棱彩阶', undefined, ''])).toBe(false)
    expect(isTitleTextCompatibleWithNames('', ['缩小引擎'])).toBe(false)
  })
})

describe('ocr input scaling and execution providers', () => {
  afterEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function loadAnalyzer() {
    vi.doMock('../../src/main/data-loader.ts', () => ({
      DEFAULT_DATA_LOCALE: 'zh-CN',
      SUPPORTED_DATA_LOCALES: [{ code: 'zh-CN' }],
      getDataLocale: () => 'zh-CN',
      loadAugmentBaseForOcrLocale: vi.fn(),
      tryNormalizeDataLocale: () => null,
    }))
    vi.doMock('../../src/main/services/lcu/process-auth-discovery.ts', () => ({
      discoverLcuAuthFromProcess: vi.fn(async () => [null, null]),
    }))
    return await import('../../src/main/image-analyzer.ts')
  }

  it('keeps 3x upscale for thumbnails and stops upscaling native 4K title strips', async () => {
    const { resolveTitleRegionScale } = await loadAnalyzer()
    const titleWidth = (width: number) => width * 0.168 * 0.96

    expect(resolveTitleRegionScale(titleWidth(1024))).toBe(3)
    expect(resolveTitleRegionScale(titleWidth(1280))).toBe(3)
    expect(resolveTitleRegionScale(titleWidth(1920))).toBeCloseTo(2.07, 1)
    expect(resolveTitleRegionScale(titleWidth(2560))).toBeCloseTo(1.55, 1)
    expect(resolveTitleRegionScale(titleWidth(3840))).toBeCloseTo(1.03, 1)
    expect(resolveTitleRegionScale(0)).toBe(3)
  })

  it('reads execution providers from the environment', async () => {
    const { resolveOcrExecutionProviders } = await loadAnalyzer()

    expect(resolveOcrExecutionProviders(undefined)).toEqual(['cpu'])
    expect(resolveOcrExecutionProviders('')).toEqual(['cpu'])
    expect(resolveOcrExecutionProviders('DML')).toEqual(['dml'])
    expect(resolveOcrExecutionProviders('dml, cpu')).toEqual(['dml', 'cpu'])
  })
})
