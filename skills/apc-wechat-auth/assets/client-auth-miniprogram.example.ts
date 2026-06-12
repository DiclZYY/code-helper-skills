/**
 * admin-pro-core 微信小程序 device + user 鉴权 — 精简示例
 *
 * 完整实现见 APC 项目 wxapp/miniprogram/apis/apis.ts
 * Layer1 协议见 references/device-authorize.md
 * 微信登录见 references/wxapp-auth-stack.md
 */

import { md5 } from '@/utils/libs/md5' // 或等价 md5 实现

const authKey = 'authorization_code'
const AUTH_TYPE = 'authorization_code'
const DEVICE_AUTH_ERRORS = [2001, 2002, 2003]
const USER_AUTH_ERRORS = [1102, 1103]
const LOCAL_AUTH_TTL_MS = 86400000 * 7 // 宜与服务端 expire 对齐并略短

type GlobalData = {
  appkey: string
  appsecret: string
  baseUrl: string
  showGlobalLoading?: boolean
}

function getConfig(): GlobalData & { apiBase: string } {
  const g = getApp().globalData as GlobalData
  return { ...g, apiBase: `${g.baseUrl}/wxapp` }
}

type AuthCodeStorage = { time: number; code: string }

function isAuthCodeExpired(stored: AuthCodeStorage): boolean {
  return stored.time + LOCAL_AUTH_TTL_MS - Date.now() <= 0
}

/** Layer1：换取或读取缓存 auth_code */
export function fetchAuthCode(): Promise<string> {
  const { apiBase, appkey, appsecret } = getConfig()
  const cached = wx.getStorageSync(authKey) as AuthCodeStorage | ''

  if (cached !== '' && cached?.code && !isAuthCodeExpired(cached)) {
    return Promise.resolve(cached.code)
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiBase}/auth/authorize`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      data: {
        appkey,
        appsecret,
        type: AUTH_TYPE,
      },
      success(res) {
        if (res.statusCode !== 200) {
          reject(res.data)
          return
        }
        const data = res.data as { code: number; result?: { auth_code: string } }
        if (data.code === 0 && data.result?.auth_code) {
          wx.setStorageSync(authKey, {
            time: Date.now(),
            code: data.result.auth_code,
          })
          resolve(data.result.auth_code)
          return
        }
        reject(data)
      },
      fail: reject,
    })
  })
}

/** Layer1：构建签名头；Layer2 可选 Auth-Token */
export function buildSignedRequestHeaders(
  authCode: string,
  timeMs: number,
  userToken?: string | null
): Record<string, string> {
  const { appkey } = getConfig()
  const header: Record<string, string> = {
    'Auth-Code': authCode,
    Signature: md5(`${appkey}-${authCode}-${timeMs}`),
    Accept: 'application/json',
  }
  if (userToken) {
    header['Auth-Token'] = userToken
  }
  return header
}

/** device 鉴权失败：清缓存并重试一次 */
export function checkDeviceAuth<T extends { code?: number }>(
  res: T,
  retry: () => Promise<T>
): Promise<T> | T {
  if (res?.code != null && DEVICE_AUTH_ERRORS.includes(res.code)) {
    wx.removeStorageSync(authKey)
    return retry()
  }
  return res
}

/** 用户 token 失效：与 device 错误分开处理 */
export function checkUserToken(res: { code?: number; message?: string }): typeof res {
  if (res?.code != null && USER_AUTH_ERRORS.includes(res.code)) {
    // clearUserInfo(); showLogoutPanel(); — 接入项目 auth 工具
    return Promise.reject(new Error(res.message ?? '登录已失效')) as never
  }
  return res
}

/**
 * 典型 request 流水线（伪代码，对接 wx.request）
 *
 * const _time = Date.now()
 * const code = await fetchAuthCode()
 * const header = buildSignedRequestHeaders(code, _time, getUserToken())
 * const url = `${apiBase}/path?_time=${_time}`
 * let data = await wxRequest({ url, header, ... })
 * data = await checkDeviceAuth(data, () => request(...))  // 200x 重试
 * checkUserToken(data)  // 1102/1103
 */

/** 下载场景：GET + query _time + 相同 Header */
export async function signedDownloadUrl(
  path: string,
  query?: Record<string, unknown>
): Promise<{ url: string; header: Record<string, string> }> {
  const { apiBase } = getConfig()
  const timeMs = Date.now()
  const authCode = await fetchAuthCode()
  const qs = { ...query, _time: timeMs }
  const queryString = Object.keys(qs)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(qs[k as keyof typeof qs]))}`)
    .join('&')
  const relative = path.startsWith('/') ? path : `/${path}`
  return {
    url: `${apiBase}${relative}?${queryString}`,
    header: buildSignedRequestHeaders(authCode, timeMs, /* userToken */ undefined),
  }
}
