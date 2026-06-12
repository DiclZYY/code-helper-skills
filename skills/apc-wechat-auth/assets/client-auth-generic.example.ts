/**
 * admin-pro-core device.authorize — 框架无关客户端示例
 *
 * 从 APC 小程序 apis.ts 提炼，适用于 H5 / Cordova / React Native / 任意 fetch 环境。
 * 不依赖微信 API。复制后替换 CONFIG 并接入你的 HTTP 层。
 *
 * 协议详见 references/device-authorize.md
 */

import { createHash } from 'crypto' // Node；浏览器可用 spark-md5 或 Web Crypto

// --- 配置 ---

export type DeviceAuthConfig = {
  baseUrl: string
  modulePrefix: string // 如 '/wxapp' 或 '/mobile'
  appkey: string
  appsecret: string
  /** 本地 auth_code 缓存 TTL（毫秒），应小于服务端 expire */
  authCodeLocalTtlMs?: number
}

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000

type AuthCodeCache = { code: string; fetchedAt: number }

const AUTH_STORAGE_KEY = 'authorization_code'

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

function apiRoot(config: DeviceAuthConfig): string {
  return `${config.baseUrl.replace(/\/$/, '')}${config.modulePrefix}`
}

// --- auth_code 换取与缓存 ---

export async function fetchAuthCode(
  config: DeviceAuthConfig,
  storage: {
    get: (key: string) => AuthCodeCache | null
    set: (key: string, value: AuthCodeCache) => void
    remove: (key: string) => void
  }
): Promise<string> {
  const ttl = config.authCodeLocalTtlMs ?? DEFAULT_TTL
  const cached = storage.get(AUTH_STORAGE_KEY)
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.code
  }

  const res = await fetch(`${apiRoot(config)}/auth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      type: 'authorization_code',
      appkey: config.appkey,
      appsecret: config.appsecret,
    }),
  })

  const data = (await res.json()) as {
    code: number
    result?: { auth_code: string; expire: number }
    message?: string
  }

  if (data.code !== 0 || !data.result?.auth_code) {
    throw new Error(data.message ?? `authorize failed: ${data.code}`)
  }

  storage.set(AUTH_STORAGE_KEY, {
    code: data.result.auth_code,
    fetchedAt: Date.now(),
  })
  return data.result.auth_code
}

// --- 签名头 ---

export function buildSignedHeaders(
  config: DeviceAuthConfig,
  authCode: string,
  timeMs: number,
  userToken?: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'Auth-Code': authCode,
    Signature: md5(`${config.appkey}-${authCode}-${timeMs}`),
    Accept: 'application/json',
  }
  if (userToken) {
    headers['Auth-Token'] = userToken
  }
  return headers
}

function appendTime(url: string, timeMs: number): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_time=${timeMs}`
}

// --- 带 device 鉴权的 fetch 包装 ---

export type DeviceFetchOptions = RequestInit & {
  config: DeviceAuthConfig
  storage: Parameters<typeof fetchAuthCode>[1]
  userToken?: string | null
  /** 收到 2001–2003 时是否自动清缓存重试一次 */
  retryOnAuthError?: boolean
}

const DEVICE_AUTH_ERRORS = new Set([2001, 2002, 2003])

export async function deviceAuthorizedFetch(
  path: string,
  options: DeviceFetchOptions
): Promise<Response> {
  const {
    config,
    storage,
    userToken,
    retryOnAuthError = true,
    ...init
  } = options

  const doRequest = async (forceRefresh: boolean): Promise<Response> => {
    if (forceRefresh) storage.remove(AUTH_STORAGE_KEY)
    const authCode = await fetchAuthCode(config, storage)
    const timeMs = Date.now()
    const url = appendTime(`${apiRoot(config)}${path.startsWith('/') ? path : `/${path}`}`, timeMs)
    const headers = {
      ...buildSignedHeaders(config, authCode, timeMs, userToken),
      ...(init.headers as Record<string, string> | undefined),
    }
    return fetch(url, { ...init, headers })
  }

  let res = await doRequest(false)

  if (retryOnAuthError && res.headers.get('content-type')?.includes('application/json')) {
    const clone = res.clone()
    try {
      const body = (await clone.json()) as { code?: number }
      if (body.code != null && DEVICE_AUTH_ERRORS.has(body.code)) {
        res = await doRequest(true)
      }
    } catch {
      /* 非 JSON 响应，直接返回 */
    }
  }

  return res
}

// --- 使用示例 ---
//
// const config = {
//   baseUrl: 'https://oa.example.com/control',
//   modulePrefix: '/mobile',
//   appkey: 'xxx',
//   appsecret: 'yyy',
// }
//
// const storage = {
//   get: (k) => JSON.parse(localStorage.getItem(k) ?? 'null'),
//   set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
//   remove: (k) => localStorage.removeItem(k),
// }
//
// const res = await deviceAuthorizedFetch('/some/api', {
//   config,
//   storage,
//   userToken: getToken(),
//   method: 'GET',
// })
