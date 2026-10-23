// 数据镜像（GitHub 仓库 tencent-data 分支，经 raw.githubusercontent.com 提供）的客户端协议：
// 先拿几 KB 的 manifest.json 比对内容哈希，哈希相同就不下载；不同才下载对应文件。
// raw 有约 5 分钟 CDN 缓存，manifest 带时间戳参数绕过缓存，数据文件带哈希参数（内容变了 URL 就变）。

export type RawResponse = { status: number; text: string }
export type RawRequest = (url: string) => Promise<RawResponse>

export type MirrorManifest = {
  updatedAt: string
  global: { hash: string; fetchedAt: string } | null
  champions: Record<string, string>
}

export type MirrorGlobalResult =
  | { status: 'unchanged'; hash: string }
  | {
      status: 'updated'
      hash: string
      sourceFetchedAt: string
      names: any
      rune: any
      hero: any
      localizedNames: { champions: Record<string, string>; items: Record<string, string> } | null
    }

export type MirrorChampionResult =
  | { status: 'unchanged'; hash: string }
  | { status: 'updated'; hash: string; sourceFetchedAt: string; payload: any }
  | { status: 'missing' }

const MIRROR_SCHEMA_VERSION = 1
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// 只接受内置常量或本机环境变量给出的 https 地址（开发时允许本机 http），远端配置不能扩展它。
export function resolveMirrorBaseUrl(value: string | null | undefined): string {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  try {
    const url = new URL(text)
    if (url.username || url.password || url.search || url.hash) {
      return ''
    }

    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    }
  } catch {
    return ''
  }

  return ''
}

function parseBody(response: RawResponse, what: string): any {
  let body: any
  try {
    body = JSON.parse(response.text)
  } catch {
    throw new Error(`mirror ${what} returned invalid JSON`)
  }

  if (!body || body.schemaVersion !== MIRROR_SCHEMA_VERSION) {
    throw new Error(`mirror ${what} has unsupported schema`)
  }

  return body
}

function parseNameMap(value: any): Record<string, string> {
  const map: Record<string, string> = {}
  if (value && typeof value === 'object') {
    for (const [id, name] of Object.entries(value)) {
      if (/^\d+$/.test(id) && typeof name === 'string' && name.trim()) {
        map[id] = name.trim()
      }
    }
  }

  return map
}

export function parseLocalizedNames(value: any) {
  if (!value || typeof value !== 'object') {
    return null
  }

  return { champions: parseNameMap(value.champions), items: parseNameMap(value.items) }
}

export async function fetchMirrorManifest(
  baseUrl: string,
  request: RawRequest,
  now: number = Date.now()
): Promise<MirrorManifest> {
  const response = await request(`${baseUrl}/manifest.json?t=${now}`)
  if (response.status !== 200) {
    throw new Error(`mirror manifest HTTP ${response.status}`)
  }

  const body = parseBody(response, 'manifest')
  const champions: Record<string, string> = {}
  if (body.champions && typeof body.champions === 'object') {
    for (const [id, hash] of Object.entries(body.champions)) {
      if (/^\d+$/.test(id) && typeof hash === 'string' && /^[0-9a-f]{8,64}$/.test(hash)) {
        champions[id] = hash
      }
    }
  }

  const globalHash = body.global?.hash
  const global =
    typeof globalHash === 'string' && /^[0-9a-f]{8,64}$/.test(globalHash)
      ? { hash: globalHash, fetchedAt: String(body.global.fetchedAt || '') }
      : null
  return { updatedAt: String(body.updatedAt || ''), global, champions }
}

export async function syncGlobalFromMirror(
  baseUrl: string,
  localHash: string | null,
  manifest: MirrorManifest,
  request: RawRequest
): Promise<MirrorGlobalResult> {
  if (!manifest.global) {
    throw new Error('mirror global data is not ready')
  }

  const remoteHash = manifest.global.hash
  if (localHash === remoteHash) {
    return { status: 'unchanged', hash: remoteHash }
  }

  const response = await request(`${baseUrl}/global.json?h=${remoteHash}`)
  if (response.status !== 200) {
    throw new Error(`mirror global HTTP ${response.status}`)
  }

  const body = parseBody(response, 'global')
  return {
    status: 'updated',
    hash: typeof body.hash === 'string' && body.hash ? body.hash : remoteHash,
    sourceFetchedAt: String(body.fetchedAt || manifest.global.fetchedAt || ''),
    names: body.names,
    rune: body.rune,
    hero: body.hero,
    localizedNames: parseLocalizedNames(body.localizedNames),
  }
}

export async function syncChampionFromMirror(
  baseUrl: string,
  championId: string,
  localHash: string | null,
  manifest: MirrorManifest,
  request: RawRequest
): Promise<MirrorChampionResult> {
  const remoteHash = manifest.champions[championId]
  if (!remoteHash) {
    return { status: 'missing' }
  }

  if (localHash === remoteHash) {
    return { status: 'unchanged', hash: remoteHash }
  }

  const response = await request(`${baseUrl}/champions/${encodeURIComponent(championId)}.json?h=${remoteHash}`)
  if (response.status === 404) {
    return { status: 'missing' }
  }

  if (response.status !== 200) {
    throw new Error(`mirror champion ${championId} HTTP ${response.status}`)
  }

  const body = parseBody(response, `champion ${championId}`)
  return {
    status: 'updated',
    hash: typeof body.hash === 'string' && body.hash ? body.hash : remoteHash,
    sourceFetchedAt: String(body.fetchedAt || ''),
    payload: body.payload,
  }
}
