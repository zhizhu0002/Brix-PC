/**
 * @file server/http-client/network-manager.js
 * @description 统一网络管理器 - 网络状态监测、镜像优先级、请求重试、错误诊断
 *   替代原有分散的网络逻辑，提供统一的网络请求入口
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const ctx = require('../context');

/* ==========================================================================
 * 网络状态管理
 * ========================================================================== */

const networkState = {
  isOnline: true,
  lastCheckTime: 0,
  checkInterval: 30000, // 30秒检测一次
  mirrorStats: new Map(), // 镜像源统计：{ url: { success, fail, avgSpeed, lastCheck } }
  activeRequests: 0,
  // 三层超时梯度：L2单次请求20秒 × 3次重试 + 指数退避(1+2+4=7秒) ≈ 67秒上限
  // 前端L3总超时45秒，覆盖后端1-2轮完整重试
  maxRetries: 3,
  defaultTimeout: 20000,   // L2: 单次请求超时（原60秒过长，导致前端先超时）
  fastTimeout: 8000,       // L1: 连接建立超时（用于快速失败切换镜像）
  retryBaseDelay: 1000     // 指数退避基准：1s, 2s, 4s
};

/* 镜像源优先级配置（全部使用国内镜像源） */
const MIRROR_PRIORITY = {
  MODRINTH: [
    'https://mod.mcimirror.top/modrinth/v2',
    'https://api.modrinth.com/v2'
  ],
  CURSEFORGE: [
    'https://mod.mcimirror.top/curseforge/v1',
    'https://api.curseforge.com/v1'
  ],
  MOJANG: [
    'https://bmclapi2.bangbang93.com/'
  ],
  VERSION_MANIFEST: [
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
  ]
};

/* ==========================================================================
 * 网络状态检测
 * ========================================================================== */

/**
 * 检测网络连接状态
 * @returns {Promise<boolean>} 网络是否可用
 */
async function checkNetworkStatus() {
  const now = Date.now();
  if (now - networkState.lastCheckTime < networkState.checkInterval) {
    return networkState.isOnline;
  }
  networkState.lastCheckTime = now;

  return new Promise((resolve) => {
    const req = https.get('https://www.baidu.com', { timeout: 5000 }, (res) => {
      networkState.isOnline = res.statusCode === 200;
      res.destroy();
      resolve(networkState.isOnline);
    });
    req.on('timeout', () => { req.destroy(); networkState.isOnline = false; resolve(false); });
    req.on('error', () => { networkState.isOnline = false; resolve(false); });
  });
}

/**
 * 获取网络状态
 * @returns {Object} 网络状态信息
 */
function getNetworkInfo() {
  return {
    isOnline: networkState.isOnline,
    lastCheck: networkState.lastCheckTime,
    activeRequests: networkState.activeRequests,
    mirrorStats: Array.from(networkState.mirrorStats.entries()).map(([url, stat]) => ({
      url, ...stat
    }))
  };
}

/* ==========================================================================
 * 镜像源管理
 * ========================================================================== */

/**
 * 根据原始URL获取镜像URL列表（按优先级排序）
 * @param {string} url - 原始URL
 * @returns {string[]} 镜像URL列表
 */
function getMirrorUrls(url) {
  if (!url) return [];

  const mirrors = [];

  // Modrinth API 镜像 - 处理官方API和MCI镜像两种URL
  if (url.startsWith('https://api.modrinth.com/v2') || url.startsWith('https://mod.mcimirror.top/modrinth/v2')) {
    MIRROR_PRIORITY.MODRINTH.forEach(mirror => {
      // 将URL中的任何已知前缀替换为镜像地址
      let mirrored = url;
      if (url.startsWith('https://api.modrinth.com/v2')) {
        mirrored = url.replace('https://api.modrinth.com/v2', mirror);
      } else if (url.startsWith('https://mod.mcimirror.top/modrinth/v2')) {
        mirrored = url.replace('https://mod.mcimirror.top/modrinth/v2', mirror);
      }
      if (!mirrors.includes(mirrored)) mirrors.push(mirrored);
    });
  }
  // CurseForge API 镜像 - 处理官方API和MCI镜像两种URL
  else if (url.startsWith('https://api.curseforge.com/v1') || url.startsWith('https://mod.mcimirror.top/curseforge/v1')) {
    MIRROR_PRIORITY.CURSEFORGE.forEach(mirror => {
      let mirrored = url;
      if (url.startsWith('https://api.curseforge.com/v1')) {
        mirrored = url.replace('https://api.curseforge.com/v1', mirror);
      } else if (url.startsWith('https://mod.mcimirror.top/curseforge/v1')) {
        mirrored = url.replace('https://mod.mcimirror.top/curseforge/v1', mirror);
      }
      if (!mirrors.includes(mirrored)) mirrors.push(mirrored);
    });
  }
  // Mojang 官方源镜像
  else if (url.startsWith('https://piston-data.mojang.com/') ||
           url.startsWith('https://piston-meta.mojang.com/') ||
           url.startsWith('https://launchermeta.mojang.com/') ||
           url.startsWith('https://libraries.minecraft.net/') ||
           url.startsWith('https://resources.download.minecraft.net/')) {
    // BMCLAPI 镜像替换
    for (const [original, mirror] of Object.entries(ctx.mirrors.BMCLAPI_MIRROR)) {
      if (url.startsWith(original)) {
        const mirrored = url.replace(original, mirror);
        if (!mirrors.includes(mirrored)) mirrors.push(mirrored);
        break;
      }
    }
    if (!mirrors.includes(url)) mirrors.push(url);
  }
  // 其他URL直接使用
  else {
    mirrors.push(url);
  }

  return mirrors;
}

/**
 * 记录镜像源请求结果
 * @param {string} url - 镜像URL
 * @param {boolean} success - 是否成功
 * @param {number} responseTime - 响应时间（毫秒）
 */
function recordMirrorResult(url, success, responseTime) {
  if (!networkState.mirrorStats.has(url)) {
    networkState.mirrorStats.set(url, { success: 0, fail: 0, avgSpeed: 0, lastCheck: 0 });
  }
  const stat = networkState.mirrorStats.get(url);
  if (success) {
    stat.success++;
    stat.avgSpeed = stat.avgSpeed === 0 ? responseTime : (stat.avgSpeed * 0.7 + responseTime * 0.3);
  } else {
    stat.fail++;
  }
  stat.lastCheck = Date.now();
}

/* ==========================================================================
 * 统一请求函数
 * ========================================================================== */

/**
 * 单次HTTP请求（内部使用）
 * @param {string} url - 请求URL
 * @param {Object} headers - 请求头
 * @param {number} timeout - 超时毫秒
 * @returns {Promise<Object>} 解析后的JSON
 */
function _singleRequest(url, headers, timeout) {
  const mod = url.startsWith('https') ? https : http;
  const agent = url.startsWith('https') ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
  const reqHeaders = { ...headers, 'Accept-Encoding': 'gzip, deflate, br' };

  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: reqHeaders, agent, timeout }, (res) => {
      // 重定向处理
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        _singleRequest(redirectUrl, headers, timeout).then(resolve).catch(reject);
        return;
      }

      // 非200状态码
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      // 解压处理
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      let data = '';
      let dataLen = 0;
      stream.on('data', (chunk) => { data += chunk; dataLen += chunk.length; });
      stream.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // 检测错误响应体（部分镜像用200包装错误）
          if (parsed && typeof parsed === 'object' && parsed.error &&
              !parsed.hits && !Array.isArray(parsed) && !parsed.id) {
            reject(new Error(`API错误: ${parsed.error}${parsed.description ? ' - ' + String(parsed.description).substring(0, 100) : ''}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON解析失败: ${e.message}`));
        }
      });
      stream.on('error', (e) => reject(e));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时(${timeout}ms)`)); });
    req.on('error', (e) => reject(e));
  });
}

/**
 * 统一JSON请求 - 多镜像竞速 + 重试 + 错误处理
 * @param {string} url - 原始URL
 * @param {Object} [options={}] - 选项：{ headers, timeout, retries, cacheTTL }
 * @returns {Promise<Object>} 解析后的JSON
 */
async function fetchJSON(url, options = {}) {
  const {
    headers = { 'User-Agent': 'Brix/2.0', 'Connection': 'keep-alive' },
    timeout = networkState.defaultTimeout,
    retries = networkState.maxRetries,
    cacheTTL = 0
  } = options;

  // 缓存检查
  if (cacheTTL > 0) {
    const cached = ctx.caches._apiCache.get(url);
    if (cached && Date.now() - cached.ts < cacheTTL) {
      return cached.data;
    }
  }

  // 检查网络状态
  if (!networkState.isOnline) {
    await checkNetworkStatus();
    if (!networkState.isOnline) {
      throw new Error('网络连接不可用，请检查网络设置');
    }
  }

  const mirrorUrls = getMirrorUrls(url);
  if (mirrorUrls.length === 0) {
    throw new Error('没有可用的请求URL');
  }

  const errors = [];
  networkState.activeRequests++;

  // 多镜像竞速
  const racePromises = mirrorUrls.map(async (mirrorUrl) => {
    const startTime = Date.now();
    try {
      const result = await _singleRequest(mirrorUrl, headers, timeout);
      const elapsed = Date.now() - startTime;
      recordMirrorResult(mirrorUrl, true, elapsed);
      return result;
    } catch (e) {
      const elapsed = Date.now() - startTime;
      recordMirrorResult(mirrorUrl, false, elapsed);
      errors.push({ url: mirrorUrl, error: e.message });
      throw e;
    }
  });

  try {
    const result = await Promise.any(racePromises);

    // 缓存成功结果（不缓存错误响应）
    if (cacheTTL > 0 && result && !(result.error && !result.hits && !Array.isArray(result) && !result.id)) {
      ctx.caches._apiCache.set(url, { data: result, ts: Date.now() });
      // 缓存清理
      if (ctx.caches._apiCache.size > 2000) {
        const now = Date.now();
        for (const [k, v] of ctx.caches._apiCache) {
          if (now - v.ts > cacheTTL * 2) ctx.caches._apiCache.delete(k);
        }
      }
    }

    networkState.activeRequests--;
    return result;
  } catch (e) {
    networkState.activeRequests--;

    // 重试逻辑：指数退避（1s, 2s, 4s）
    if (retries > 0) {
      const attempt = networkState.maxRetries - retries; // 当前是第几次重试（0基）
      const delay = networkState.retryBaseDelay * Math.pow(2, attempt);
      console.warn(`[NetworkManager] 请求失败，${delay}ms后重试（剩余${retries}次）: ${url.substring(0, 60)}`);
      await new Promise(r => setTimeout(r, delay));
      return fetchJSON(url, { ...options, retries: retries - 1 });
    }

    // 所有重试失败，返回用户友好错误
    const errorDetail = errors.map(e => `${e.url.substring(0, 40)}: ${e.error}`).join('; ');
    throw new Error(`资源获取失败: ${errorDetail}`);
  }
}

/**
 * 带缓存的JSON请求
 * @param {string} url - 请求URL
 * @param {number} cacheTTL - 缓存有效期（毫秒）
 * @param {Object} [options={}] - 其他选项
 * @returns {Promise<Object>} 解析后的JSON
 */
function cachedFetchJSON(url, cacheTTL, options = {}) {
  return fetchJSON(url, { ...options, cacheTTL });
}

/* ==========================================================================
 * 错误诊断
 * ========================================================================== */

/**
 * 诊断网络错误并提供用户友好提示
 * @param {Error} error - 原始错误
 * @returns {Object} { message, suggestion, isNetworkError }
 */
function diagnoseError(error) {
  const msg = error.message || '';
  
  // 超时错误
  if (msg.includes('超时') || msg.includes('timeout')) {
    return {
      message: '请求超时，服务器响应时间过长',
      suggestion: '请检查网络连接或稍后重试，国内用户建议使用镜像源',
      isNetworkError: true
    };
  }
  
  // API错误响应
  if (msg.includes('API错误') || msg.includes('internal_error')) {
    return {
      message: '资源服务暂时不可用',
      suggestion: '服务器内部错误，请稍后重试',
      isNetworkError: false
    };
  }
  
  // 连接错误
  if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) {
    return {
      message: '网络连接被重置',
      suggestion: '请检查网络连接或尝试切换镜像源',
      isNetworkError: true
    };
  }
  
  // DNS错误
  if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
    return {
      message: '无法解析服务器地址',
      suggestion: '请检查DNS设置或网络连接',
      isNetworkError: true
    };
  }
  
  // 所有镜像源失败
  if (msg.includes('所有镜像源') || msg.includes('资源获取失败')) {
    return {
      message: '所有数据源均不可用',
      suggestion: '请检查网络连接后重试',
      isNetworkError: true
    };
  }
  
  // 通用错误
  return {
    message: msg,
    suggestion: '请稍后重试',
    isNetworkError: false
  };
}

/* ==========================================================================
 * 模块导出
 * ========================================================================== */

module.exports = {
  // 网络状态
  checkNetworkStatus,
  getNetworkInfo,
  networkState,
  
  // 镜像管理
  getMirrorUrls,
  recordMirrorResult,
  
  // 请求函数
  fetchJSON,
  cachedFetchJSON,
  
  // 错误诊断
  diagnoseError,
  
  // 配置
  MIRROR_PRIORITY
};
