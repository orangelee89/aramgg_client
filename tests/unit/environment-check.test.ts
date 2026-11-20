import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false, getAppPath: () => '' },
  screen: { getPrimaryDisplay: vi.fn(), getAllDisplays: vi.fn(() => []) },
}))
vi.mock('../../src/main/modules/logger.ts', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/main/modules/app-store.ts', () => ({ default: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../../src/main/image-analyzer.ts', () => ({ probeOcrEngine: vi.fn() }))
vi.mock('../../src/main/native-capture.ts', () => ({ captureNativeScreenFrame: vi.fn(), getNativeCaptureLoadError: vi.fn() }))
vi.mock('../../src/main/services/lcu/lcu-service.ts', () => ({ getLCUServiceInstance: vi.fn() }))

const {
  classifySystem,
  classifyOcrEngine,
  classifyDisplay,
  classifyMonitors,
  classifyLeagueClient,
  classifyGameLanguage,
  classifyGameDisplay,
  classifyPreferences,
} = await import('../../src/main/services/environment-check.ts')

const pick = (entry: { status: string; variant: string }) => `${entry.status}:${entry.variant}`

describe('environment check classifiers', () => {
  it('checks the operating system', () => {
    expect(pick(classifySystem('win32', 'x64', '10.0.26200'))).toBe('pass:ok')
    expect(pick(classifySystem('win32', 'ia32', '10.0.26200'))).toBe('fail:winArch')
    expect(pick(classifySystem('win32', 'x64', '10.0.17134'))).toBe('fail:winOld')
    expect(pick(classifySystem('win32', 'x64', '6.3.9600'))).toBe('fail:winOld')
    expect(pick(classifySystem('darwin', 'arm64', '24.1.0'))).toBe('pass:ok')
    expect(pick(classifySystem('darwin', 'arm64', '22.6.0'))).toBe('fail:macOld')
  })

  it('maps OCR engine failures to actionable causes', () => {
    expect(pick(classifyOcrEngine({ ready: true, modelsFound: true, error: null }, 'win32'))).toBe('pass:ok')
    expect(pick(classifyOcrEngine({ ready: false, modelsFound: false, error: 'model files are missing' }, 'win32'))).toBe('fail:missingModels')
    expect(pick(classifyOcrEngine({ ready: false, modelsFound: true, error: '\\\\?\\C:\\x\\onnxruntime_binding.node: The specified module could not be found.' }, 'win32'))).toBe('fail:missingRuntime')
    expect(pick(classifyOcrEngine({ ready: false, modelsFound: true, error: 'boom' }, 'win32'))).toBe('fail:loadFailed')
  })

  it('checks the primary display shape', () => {
    expect(pick(classifyDisplay(3840, 2160))).toBe('pass:ok')
    expect(pick(classifyDisplay(1920, 1080))).toBe('pass:ok')
    expect(pick(classifyDisplay(3440, 1440))).toBe('warn:aspect')
    expect(pick(classifyDisplay(2560, 1600))).toBe('warn:aspect')
    expect(pick(classifyDisplay(1024, 576))).toBe('warn:lowRes')
    expect(pick(classifyMonitors(1))).toBe('pass:single')
    expect(pick(classifyMonitors(2))).toBe('warn:multi')
  })

  it('explains why the League client is unreachable', () => {
    expect(pick(classifyLeagueClient({ connected: true, running: true, elevated: false }, 'win32'))).toBe('pass:connected')
    expect(pick(classifyLeagueClient({ connected: false, running: false, elevated: false }, 'win32'))).toBe('warn:notRunning')
    expect(pick(classifyLeagueClient({ connected: false, running: true, elevated: false }, 'win32'))).toBe('fail:privilege')
    expect(pick(classifyLeagueClient({ connected: false, running: true, elevated: true }, 'win32'))).toBe('fail:notConnected')
  })

  it('checks the game language against OCR-supported locales', () => {
    expect(pick(classifyGameLanguage(null))).toBe('skip:needClient')
    expect(pick(classifyGameLanguage('zh_CN'))).toBe('pass:ok')
    expect(pick(classifyGameLanguage('en_US'))).toBe('pass:ok')
    expect(pick(classifyGameLanguage('zh_TW'))).toBe('pass:ok')
    expect(pick(classifyGameLanguage('zh_MY'))).toBe('pass:ok')
    expect(pick(classifyGameLanguage('en_SG'))).toBe('pass:ok')
    expect(pick(classifyGameLanguage('ko_KR'))).toBe('fail:unsupported')
    expect(pick(classifyGameLanguage('vi_VN'))).toBe('fail:unsupported')
  })

  it('checks the game window mode', () => {
    const screenSize = { width: 2560, height: 1440 }
    expect(pick(classifyGameDisplay(null, screenSize))).toBe('skip:needClient')
    expect(pick(classifyGameDisplay({ WindowMode: 2, Width: 2560, Height: 1440 }, screenSize))).toBe('pass:borderless')
    expect(pick(classifyGameDisplay({ WindowMode: 0, Width: 2560, Height: 1440 }, screenSize))).toBe('warn:fullscreen')
    expect(pick(classifyGameDisplay({ WindowMode: 1, Width: 1600, Height: 900 }, screenSize))).toBe('warn:windowed')
    expect(pick(classifyGameDisplay({ WindowMode: 1, Width: 2560, Height: 1440 }, screenSize))).toBe('pass:windowedFull')
  })

  it('checks the related switches', () => {
    expect(pick(classifyPreferences({ autoScreenshot: true, topOverlay: true, sidePanel: false }))).toBe('pass:ok')
    expect(pick(classifyPreferences({ autoScreenshot: false, topOverlay: true, sidePanel: true }))).toBe('fail:autoScreenshotOff')
    expect(pick(classifyPreferences({ autoScreenshot: true, topOverlay: false, sidePanel: false }))).toBe('fail:overlaysOff')
  })
})
