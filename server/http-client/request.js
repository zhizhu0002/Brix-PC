/**
 * @file server/http-client/request.js - 基础 HTTP 请求
 * @description GET/POST/PUT 请求、重定向、429 限流、gzip/br/deflate 解压、镜像回退、TTL 缓存、竞速请求。
 *   通过 ctx (../context) 访问共享状态，依赖 ./mirror 的镜像熔断逻辑。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const ctx = require('../context');
const { _isMirrorAvailable, _mirrorFailed, _mirrorSuccess } = require('./mirror');

/* ==========================================================================
 * 请求去重机制 - 避免并发请求同一URL导致429限流
 * ========================================================================== */

/** 正在进行的请求Map（URL -> Promise），用于请求去重 */
const _pendingRequests = new Map();

/** 429限流镜像冷却记录（mirrorUrl -> 冷却到期时间戳） */
const _rateLimitedMirrors = new Map();

/** 镜像冷却时间（30秒） */
const MIRROR_COOLDOWN_MS = 30000;

/**
 * 检查镜像是否处于429冷却期
 * @param {string} mirrorUrl - 镜像URL
 * @returns {boolean} 是否在冷却期
 */
function _isMirrorCoolingDown(mirrorUrl) {
  const cooldownUntil = _rateLimitedMirrors.get(mirrorUrl);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return true;
  }
  // 冷却期已过，清理记录
  if (cooldownUntil) {
    _rateLimitedMirrors.delete(mirrorUrl);
  }
  return false;
}

/**
 * 标记镜像被429限流，设置冷却期
 * @param {string} mirrorUrl - 镜像URL
 */
function _markMirrorRateLimited(mirrorUrl) {
  _rateLimitedMirrors.set(mirrorUrl, Date.now() + MIRROR_COOLDOWN_MS);
  console.warn(`[Request] 镜像被429限流，冷却${MIRROR_COOLDOWN_MS / 1000}秒: ${mirrorUrl.substring(0, 50)}...`);
}

/**
 * 获取去重请求键（URL + 关键参数）
 * @param {string} url - 请求URL
 * @returns {string} 去重键
 */
function _getDedupKey(url) {
  // 移除查询参数中的时间戳等动态参数
  return url.replace(/[?&]_=\d+/g, '').replace(/[?&]t=\d+/g, '');
}

/**
 * 用指定协议（http/https）发起 GET 请求，返回响应流
 * @param {string} targetUrl - 目标 URL
 * @param {object} [options={}] - 原生 http.get 选项
 * @returns {Promise<import('http').IncomingMessage>}
 */
function fetchWithProtocol(targetUrl, options = {}) {
  const mod = targetUrl.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(targetUrl, options, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 单次请求：处理重定向、429 限流、gzip/br/deflate 解压
 * @param {string} url - 请求 URL
 * @param {object} headers - 请求头
 * @param {number} timeout - 超时毫秒
 * @param {number} [retries=0] - 当前重试层级（用于 429）
 * @returns {Promise<object>} 解析后的 JSON
 */
function _fetchOnce(url, headers, timeout, retries = 0) {
  const mod = url.startsWith('https') ? https : http;
  const agent = url.startsWith('https') ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
  const reqHeaders = { ...headers, 'Accept-Encoding': 'gzip, deflate, br' };
  return new Promise((resolve, reject) => {
    let streamClosed = false;
    const cleanup = () => { streamClosed = true; };

    const req = mod.get(url, { headers: reqHeaders, agent, timeout }, (res) => {
      if (streamClosed) { res.destroy(); return; }

      res.on('close', cleanup);

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (streamClosed) { res.destroy(); return; }
        req.destroy();
        return _fetchOnce(res.headers.location, headers, timeout, retries).then(resolve).catch(reject);
      }
      if (res.statusCode === 429) {
        if (streamClosed) { res.destroy(); return; }
        res.destroy();
        // 标记该镜像被429限流，设置30秒冷却期
        _markMirrorRateLimited(url);
        // 429直接reject，不在此层重试，由fetchJSON的竞速机制切换到其他镜像
        reject(new Error(`HTTP 429 限流，镜像已冷却30秒`));
        return;
      }
      if (res.statusCode !== 200) { if (!streamClosed) { res.destroy(); reject(new Error(`HTTP ${res.statusCode}`)); } return; }

      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      let data = '';
      stream.on('data', (chunk) => { if (!streamClosed) { data += chunk; } });
      stream.on('end', () => {
        if (streamClosed) return;
        try {
          const parsed = JSON.parse(data);
          /* 检查 API 错误响应：部分镜像会用 HTTP 200 包装错误体 */
          if (parsed && typeof parsed === 'object' && parsed.error && !parsed.hits && !Array.isArray(parsed) && !parsed.id) {
            reject(new Error(`API错误: ${parsed.error}${parsed.description ? ' - ' + parsed.description.substring(0, 100) : ''}`));
            return;
          }
          resolve(parsed);
        }
        catch (e) { reject(new Error(`JSON解析失败: ${e.message}`)); }
      });
      stream.on('error', (e) => { if (!streamClosed) { reject(e); } });
    });
    
    req.on('timeout', () => { if (!streamClosed) { cleanup(); req.destroy(); reject(new Error(`请求超时 (${timeout}ms)`)); } });
    req.on('error', (e) => { if (!streamClosed) { cleanup(); reject(e); } });
  });
}

/**
 * 生成指定 URL 的所有可用镜像 URL 列表
 * @param {string} urlStr - 原始 URL
 * @returns {string[]} 镜像 URL 列表（含原始 URL）
 */
function _generateMirrorUrls(urlStr) {
  const urls = [];
  let mirrored = false;

  if (urlStr.startsWith(ctx.urls.MODRINTH_API)) {
    ctx.mirrors.MODRINTH_MIRRORS.forEach(mirror => {
      urls.push(urlStr.replace(ctx.urls.MODRINTH_API, mirror));
    });
    mirrored = urls.length > 0;
  } else if (urlStr.startsWith(ctx.urls.CURSEFORGE_API)) {
    ctx.mirrors.CURSEFORGE_MIRRORS.forEach(mirror => {
      urls.push(urlStr.replace(ctx.urls.CURSEFORGE_API, mirror));
    });
    mirrored = urls.length > 0;
  } else if (urlStr.startsWith(ctx.urls.MOJANG_API) ||
             urlStr.startsWith('https://piston-data.mojang.com/') ||
             urlStr.startsWith('https://piston-meta.mojang.com/') ||
             urlStr.startsWith('https://resources.download.minecraft.net/') ||
             urlStr.startsWith('https://launchermeta.mojang.com/') ||
             urlStr.startsWith('https://meta.fabricmc.net/') ||
             urlStr.startsWith('https://maven.minecraftforge.net/') ||
             urlStr.startsWith('https://maven.neoforged.net/')) {
    // 海外URL → 国内镜像替换
    for (const [original, mirror] of Object.entries(ctx.mirrors.BMCLAPI_MIRROR)) {
      if (urlStr.startsWith(original)) {
        urls.push(urlStr.replace(original, mirror));
        mirrored = true;
        break;
      }
    }
    for (const [original, mirror] of Object.entries(ctx.mirrors.MCBBS_MIRROR)) {
      if (urlStr.startsWith(original)) {
        const mirroredUrl = urlStr.replace(original, mirror);
        if (!urls.includes(mirroredUrl)) urls.push(mirroredUrl);
        mirrored = true;
        break;
      }
    }
    for (const [original, mirror] of Object.entries(ctx.mirrors.MCAPI_MIRROR)) {
      if (urlStr.startsWith(original)) {
        const mirroredUrl = urlStr.replace(original, mirror);
        if (!urls.includes(mirroredUrl)) urls.push(mirroredUrl);
        mirrored = true;
        break;
      }
    }
  }

  // 如果没有找到镜像映射，或URL本身就是国内镜像，直接使用原始URL
  if (!mirrored && urls.length === 0) {
    urls.push(urlStr);
  }

  return [...new Set(urls)];
}

/**
 * 带多镜像竞态的 JSON 请求：并发请求所有可用镜像，返回最快响应
 * @param {string} urlStr - 请求 URL
 * @param {object|number} [retriesOrHeaders=3] - 自定义 headers 或重试次数
 * @param {number} timeoutMs - 总超时
 * @returns {Promise<object>} 解析后的 JSON
 */
async function fetchJSON(urlStr, retriesOrHeaders = 3, timeoutMs) {
  let extraHeaders = {};
  if (typeof retriesOrHeaders === 'object' && retriesOrHeaders !== null) {
    extraHeaders = retriesOrHeaders;
  }
  const reqTimeout = typeof timeoutMs === 'number' ? timeoutMs : 20000;

  const headers = { 'User-Agent': 'Brix/2.0', 'Connection': 'keep-alive', ...extraHeaders };

  const allMirrorUrls = _generateMirrorUrls(urlStr);

  // 过滤掉处于429冷却期的镜像
  const mirrorUrls = allMirrorUrls.filter(url => !_isMirrorCoolingDown(url));

  // 如果所有镜像都在冷却期，强制使用原始URL（不使用镜像）
  const finalUrls = mirrorUrls.length > 0 ? mirrorUrls : [urlStr];

  if (finalUrls.length === 0) {
    throw new Error('没有可用的镜像源（所有镜像均在冷却期）');
  }

  const errors = [];

  const racePromises = finalUrls.map((mirrorUrl) => {
    return _fetchOnce(mirrorUrl, headers, reqTimeout).then((result) => {
      console.debug(`[fetchJSON] 成功从 ${mirrorUrl.substring(0, 60)} 获取数据`);
      if (mirrorUrl !== urlStr) _mirrorSuccess();
      return result;
    }).catch((e) => {
      errors.push({ url: mirrorUrl, error: e.message });
      if (mirrorUrl !== urlStr) _mirrorFailed();
      throw e;
    });
  });

  try {
    return await Promise.any(racePromises);
  } catch (e) {
    if (errors.length === 0) {
      errors.push({ url: urlStr, error: e.message });
    }

    console.error(`[fetchJSON] 所有镜像源均失败 (${urlStr.substring(0, 60)}):`);
    errors.forEach((err) => {
      console.error(`  - ${err.url.substring(0, 60)}: ${err.error}`);
    });

    throw new Error(`资源获取失败，所有镜像源均无法访问。错误详情: ${errors.map(e => e.error).join('; ')}`);
  }
}

/**
 * 带 TTL 缓存的 fetchJSON，相同 URL 在 TTL 内返回缓存结果
 * @param {string} urlStr - 请求 URL
 * @param {number} cacheTTL - 缓存有效期（毫秒）
 * @param {object|number} retriesOrHeaders - 重试次数或自定义 headers
 * @param {number} timeoutMs - 请求超时
 * @returns {Promise<object>} 解析后的 JSON
 */
function cachedFetchJSON(urlStr, cacheTTL, retriesOrHeaders, timeoutMs) {
  const cached = ctx.caches._apiCache.get(urlStr);
  if (cached && Date.now() - cached.ts < cacheTTL) return Promise.resolve(cached.data);

  // 请求去重：同一URL的并发请求共享同一个Promise，避免触发429限流
  const dedupKey = _getDedupKey(urlStr);
  if (_pendingRequests.has(dedupKey)) {
    return _pendingRequests.get(dedupKey);
  }

  const requestPromise = fetchJSON(urlStr, retriesOrHeaders, timeoutMs).then((data) => {
    /* 不缓存包含 error 字段的错误响应 */
    if (data && typeof data === 'object' && data.error && !data.hits && !Array.isArray(data) && !data.id) {
      return data;
    }
    ctx.caches._apiCache.set(urlStr, { data, ts: Date.now() });
    if (ctx.caches._apiCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of ctx.caches._apiCache) {
        if (now - v.ts > cacheTTL * 2) ctx.caches._apiCache.delete(k);
      }
    }
    return data;
  }).finally(() => {
    // 请求完成后清理去重记录
    _pendingRequests.delete(dedupKey);
  });

  // 存入去重Map，后续相同URL的请求将复用此Promise
  _pendingRequests.set(dedupKey, requestPromise);
  return requestPromise;
}

/**
 * 拉取纯文本响应（不解析 JSON）
 * @param {string} urlStr - 请求 URL
 * @returns {Promise<string>} 文本内容
 */
function fetchText(urlStr) {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https') ? https : http;
    const req = mod.get(urlStr, { headers: { 'User-Agent': 'Brix/1.0' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

/**
 * 多任务竞速：任一任务成功即返回，全部失败时抛 AggregateError
 * @param {Array<{fetchFn: () => Promise, label: string}>} tasks - 任务数组
 * @param {number} [timeout=15000] - 单任务超时
 * @returns {Promise<any>} 第一个成功的结果
 */
async function fetchWithRacing(tasks, timeout = 15000) {
  return Promise.any(tasks.map(async ({ fetchFn, label }) => {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), timeout)
    );
    const result = await Promise.race([fetchFn(), timeoutPromise]);
    // 空结果视为失败，让 Promise.any 继续等其他任务
    if (!result || (Array.isArray(result) && result.length === 0)) {
      throw new Error(`${label} returned empty`);
    }
    return result;
  }));
}

/* HTTP GET (支持 Range / 重定向) */

/**
 * HTTP GET 请求，支持 Range、最多 5 次重定向
 * @param {string} urlStr - 请求 URL
 * @param {object} [opts={}] - 选项：start/end/timeout/headers/agent
 * @param {number} [_redirectCount=0] - 当前重定向次数（内部递归用）
 * @returns {Promise<{stream: import('http').IncomingMessage, statusCode: number, headers: object, contentLength: number, request: object}>}
 */
function httpGet(urlStr, opts = {}, _redirectCount = 0) {
  if (_redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const isHttps = urlStr.startsWith('https');
    const mod = isHttps ? https : http;
    const agent = opts.agent || (isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT);
    const headers = { 'User-Agent': 'Brix/2.0', 'Connection': 'keep-alive', ...opts.headers };
    // 设置 Range 头用于分块下载
    if (opts.start !== undefined) {
      headers['Range'] = opts.end !== undefined ? `bytes=${opts.start}-${opts.end}` : `bytes=${opts.start}-`;
    }
    const req = mod.get(urlStr, { headers, agent }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        // 相对路径补全为绝对 URL
        const nu = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).toString();
        return httpGet(nu, opts, _redirectCount + 1).then(resolve).catch(reject);
      }
      resolve({
        stream: res,
        statusCode: res.statusCode,
        headers: res.headers,
        contentLength: parseInt(res.headers['content-length'] || '0', 10),
        request: req
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/* 带方法的 JSON 请求（POST/PUT 等） */

/**
 * 带自定义方法的 JSON 请求：支持重定向、429 限流错误、4xx/5xx 错误
 * @param {string} urlStr - 请求 URL
 * @param {string} method - HTTP 方法（GET/POST/PUT/DELETE 等）
 * @param {string|Buffer} [body] - 请求体
 * @param {object} [headers] - 自定义请求头
 * @param {number} [_redirectCount=0] - 当前重定向次数（内部递归用）
 * @returns {Promise<object>} 解析后的 JSON
 */
function fetchJSONWithMethod(urlStr, method, body, headers, _redirectCount) {
  if (!_redirectCount) _redirectCount = 0;
  return new Promise((resolve, reject) => {
    if (_redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      agent: agent,
      headers: {
        'User-Agent': 'Brix/1.0 (Minecraft Launcher)',
        'Accept': 'application/json',
        ...(headers || {})
      }
    };
    const req = mod.request(options, (res) => {
      // 3xx 重定向：相对路径补全后递归请求
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
        res.resume();
        fetchJSONWithMethod(redirectUrl, method, body, headers, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      // 429 限流：返回带 retryAfter 的错误
      if (res.statusCode === 429) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
          const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
          err.isRateLimit = true;
          err.retryAfter = retryAfter;
          reject(err);
        });
        return;
      }
      // 4xx/5xx：返回带 httpStatus 的错误
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
          err.httpStatus = res.statusCode;
          reject(err);
        });
        return;
      }
      // 2xx：解析 JSON
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}, data: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout: ' + urlStr)); });
    if (body) req.write(body);
    req.end();
  });
}

/* 带 Bearer Token 的 JSON 请求 */

/**
 * 带 Bearer Token 的 HTTPS JSON 请求（用于微软账号等鉴权接口）
 * @param {string} urlStr - 请求 URL
 * @param {string} token - Bearer Token
 * @returns {Promise<object>} 解析后的 JSON
 */
function fetchJSONWithAuth(urlStr, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Brix/1.0' }
    }, (res) => {
      // 429 限流：返回带 retryAfter 的错误
      if (res.statusCode === 429) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
          const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
          err.isRateLimit = true;
          err.retryAfter = retryAfter;
          reject(err);
        });
        return;
      }
      // 4xx/5xx：返回带 httpStatus 的错误
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
          err.httpStatus = res.statusCode;
          reject(err);
        });
        return;
      }
      // 2xx：解析 JSON
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

module.exports = {
  fetchWithProtocol,
  _fetchOnce,
  cachedFetchJSON,
  fetchJSON,
  fetchText,
  fetchWithRacing,
  httpGet,
  fetchJSONWithMethod,
  fetchJSONWithAuth,
  // 请求去重与镜像冷却
  _isMirrorCoolingDown,
  _markMirrorRateLimited,
  _getDedupKey
};
