import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  nativeAvailable: vi.fn(() => false),
  captureNativeScreenFrame: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: mocks.getSources,
  },
}))

vi.mock('../../src/main/modules/logger.ts', () => ({
  default: mocks.logger,
}))

vi.mock('../../src/main/native-capture.ts', () => ({
  isNativeCaptureAvailable: mocks.nativeAvailable,
  getNativeCaptureLoadError: vi.fn(() => null),
  captureNativeScreenFrame: mocks.captureNativeScreenFrame,
}))

const createNativeFrame = (width = 3840, height = 2160) => ({
  buffer: Buffer.alloc(width * height * 4),
  width,
  height,
  channels: 4 as const,
  monitorName: 'U32J59x',
  scaleFactor: 1.5,
  captureMs: 60,
})

const createThumbnail = (width = 1280, height = 720) => ({
  isEmpty: () => false,
  toPNG: () => Buffer.from('png'),
  getSize: () => ({ width, height }),
})

describe('captureScreenshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.nativeAvailable.mockReturnValue(false)
  })

  it('captures the native full-resolution frame for screen captures when available', async () => {
    mocks.nativeAvailable.mockReturnValue(true)
    mocks.captureNativeScreenFrame.mockResolvedValue(createNativeFrame(64, 32))

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot({
      preferScreen: true,
      thumbnailSize: { width: 1024, height: 576 },
      output: 'raw',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.captureSource).toBe('native')
    expect(result.captureMode).toBe('native-screen')
    expect(result.buffer).toBeNull()
    expect(result.image).toMatchObject({ width: 64, height: 32, channels: 4 })
    expect(result.image?.buffer.length).toBe(64 * 32 * 4)
    expect(mocks.getSources).not.toHaveBeenCalled()
  })

  it('falls back to desktopCapturer when native capture throws', async () => {
    mocks.nativeAvailable.mockReturnValue(true)
    mocks.captureNativeScreenFrame.mockRejectedValue(new Error('monitor lost'))
    mocks.getSources.mockResolvedValue([
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        thumbnail: createThumbnail(1024, 576),
      },
    ])

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot({
      preferScreen: true,
      thumbnailSize: { width: 1024, height: 576 },
      output: 'raw',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.captureSource).toBe('electron')
    expect(result.image).toBeNull()
    expect(Buffer.isBuffer(result.buffer)).toBe(true)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1024, height: 576 },
    })
  })

  it('does not use native capture for window-first captures', async () => {
    mocks.nativeAvailable.mockReturnValue(true)
    mocks.getSources.mockResolvedValue([
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        thumbnail: createThumbnail(),
      },
    ])

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot()

    expect(result.success).toBe(true)
    expect(mocks.captureNativeScreenFrame).not.toHaveBeenCalled()
    expect(mocks.getSources).toHaveBeenCalled()
  })

  it('prefers the LoL game window by default', async () => {
    mocks.getSources.mockResolvedValue([
      {
        id: 'window:1:0',
        name: 'League of Legends',
        thumbnail: createThumbnail(1600, 900),
      },
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        thumbnail: createThumbnail(),
      },
    ])

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot()

    expect(result.success).toBe(true)
    expect(result.captureMode).toBe('window')
    expect(result.hasLolWindow).toBe(true)
    expect(result.windowName).toBe('League of Legends')
    expect(result.width).toBe(1600)
    expect(result.height).toBe(900)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['window', 'screen'],
      thumbnailSize: { width: 1280, height: 720 },
    })
  })

  it('accepts a smaller thumbnail only when the caller requests it', async () => {
    mocks.getSources.mockResolvedValue([
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        thumbnail: createThumbnail(1024, 576),
      },
    ])

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot({
      preferScreen: true,
      thumbnailSize: { width: 1024, height: 576 },
    })

    expect(result.success).toBe(true)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1024, height: 576 },
    })
  })
})
