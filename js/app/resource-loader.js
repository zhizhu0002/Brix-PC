/**
 * @file js/app/resource-loader.js
 * @description 统一前端资源加载器 - 管理所有资源类型的加载状态、错误重试、进度显示
 *   替代原有分散的前端加载逻辑，提供统一的加载接口
 */

/* ==========================================================================
 * 加载状态管理
 * ========================================================================== */

const LoadState = {
  IDLE: 'idle',
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error',
  RETRYING: 'retrying'
};

const loaderState = {
  current: new Map(), // 各资源类型的当前状态
  retryCount: new Map(), // 各资源类型的重试次数
  maxRetries: 3,
  retryDelay: 2000
};

/**
 * 获取资源类型的当前状态
 * @param {string} resourceType - 资源类型
 * @returns {string} 加载状态
 */
function getState(resourceType) {
  return loaderState.current.get(resourceType) || LoadState.IDLE;
}

/**
 * 设置资源类型的加载状态
 * @param {string} resourceType - 资源类型
 * @param {string} state - 加载状态
 */
function setState(resourceType, state) {
  loaderState.current.set(resourceType, state);
  updateLoadingUI(resourceType, state);
}

/**
 * 更新加载UI显示
 * @param {string} resourceType - 资源类型
 * @param {string} state - 加载状态
 */
function updateLoadingUI(resourceType, state) {
  const containerId = getResourceContainerId(resourceType);
  const container = document.getElementById(containerId);
  if (!container) return;

  switch (state) {
    case LoadState.LOADING:
      container.innerHTML = createLoadingHTML(resourceType);
      break;
    case LoadState.RETRYING:
      const retryCount = loaderState.retryCount.get(resourceType) || 0;
      container.innerHTML = createRetryingHTML(resourceType, retryCount);
      break;
  }
}

/* ==========================================================================
 * UI模板生成
 * ========================================================================== */

/**
 * 创建加载中HTML
 * @param {string} resourceType - 资源类型
 * @returns {string} HTML字符串
 */
function createLoadingHTML(resourceType) {
  const typeName = getResourceTypeName(resourceType);
  return `<div class="loading-spinner" style="text-align:center;padding:40px 20px;">
    <div class="spinner" style="width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div>
    <p style="color:var(--text-secondary);font-size:14px;">正在加载${typeName}列表...</p>
  </div>`;
}

/**
 * 创建重试中HTML
 * @param {string} resourceType - 资源类型
 * @param {number} retryCount - 当前重试次数
 * @returns {string} HTML字符串
 */
function createRetryingHTML(resourceType, retryCount) {
  const typeName = getResourceTypeName(resourceType);
  return `<div class="loading-spinner" style="text-align:center;padding:40px 20px;">
    <div class="spinner" style="width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--warning);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div>
    <p style="color:var(--text-secondary);font-size:14px;">正在重试加载${typeName}... (${retryCount}/${loaderState.maxRetries})</p>
  </div>`;
}

/**
 * 创建错误HTML
 * @param {string} resourceType - 资源类型
 * @param {string} errorMsg - 错误消息
 * @param {string} suggestion - 建议
 * @returns {string} HTML字符串
 */
function createErrorHTML(resourceType, errorMsg, suggestion) {
  const typeName = getResourceTypeName(resourceType);
  return `<div style="text-align:center;padding:40px 20px;">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:48px;height:48px;color:var(--danger);margin-bottom:12px;opacity:0.6;">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <p style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">加载${typeName}列表失败</p>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">${errorMsg}</p>
    ${suggestion ? `<p style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">💡 ${suggestion}</p>` : ''}
    <button class="btn btn-primary btn-sm" onclick="resourceLoader.retry('${resourceType}')" style="margin-top:4px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px">
        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
      </svg>
      立即重试
    </button>
  </div>`;
}

/**
 * 创建空列表HTML
 * @param {string} resourceType - 资源类型
 * @returns {string} HTML字符串
 */
function createEmptyHTML(resourceType) {
  const typeName = getResourceTypeName(resourceType);
  return `<div style="text-align:center;padding:40px 20px;">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;color:var(--text-muted);margin-bottom:12px;opacity:0.4;">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
    </svg>
    <p style="color:var(--text-muted);font-size:14px;">暂无${typeName}</p>
  </div>`;
}

/* ==========================================================================
 * 辅助函数
 * ========================================================================== */

/**
 * 获取资源容器ID
 * @param {string} resourceType - 资源类型
 * @returns {string} 容器元素ID
 */
function getResourceContainerId(resourceType) {
  const containerMap = {
    mod: 'mod-browse-list',
    modpack: 'modpack-list',
    datapack: 'datapack-list',
    resourcepack: 'resourcepack-list',
    shader: 'shader-list'
  };
  return containerMap[resourceType] || `${resourceType}-list`;
}

/**
 * 获取资源类型中文名称
 * @param {string} resourceType - 资源类型
 * @returns {string} 中文名称
 */
function getResourceTypeName(resourceType) {
  const nameMap = {
    mod: '模组',
    modpack: '整合包',
    datapack: '数据包',
    resourcepack: '材质包',
    shader: '光影包'
  };
  return nameMap[resourceType] || resourceType;
}

/* ==========================================================================
 * 统一加载函数
 * ========================================================================== */

/**
 * 加载资源列表（带重试机制）
 * @param {string} resourceType - 资源类型
 * @param {Object} [options={}] - 加载选项
 * @param {string} [options.query] - 搜索关键词
 * @param {string} [options.loader] - 加载器
 * @param {string} [options.version] - 游戏版本
 * @param {string} [options.category] - 分类
 * @param {string} [options.sort] - 排序
 * @param {number} [options.limit=15] - 每页数量
 * @param {number} [options.offset=0] - 偏移量
 * @param {Function} [options.onSuccess] - 成功回调
 * @param {Function} [options.onError] - 失败回调
 * @returns {Promise<Object>} 加载结果
 */
async function loadResources(resourceType, options = {}) {
  const {
    query = '',
    loader = '',
    version = '',
    category = '',
    sort = 'relevance',
    limit = 15,
    offset = 0,
    onSuccess = null,
    onError = null
  } = options;

  // 重置重试计数
  if (getState(resourceType) !== LoadState.RETRYING) {
    loaderState.retryCount.set(resourceType, 0);
  }

  setState(resourceType, LoadState.LOADING);

  // 30秒超时检测：后端已有多源自动切换（主源20秒+备源8秒×2≈36秒）
  // 前端30秒超时覆盖后端主源+1个备源，超时后直接报错
  const TIMEOUT_THRESHOLD = 30000;
  let timeoutTriggered = false;

  try {
    // 使用Promise.race实现超时检测
    const data = await Promise.race([
      API.searchResources(query, resourceType, loader, version, category, sort, limit, offset),
      new Promise((_, reject) => {
        setTimeout(() => {
          timeoutTriggered = true;
          reject(new Error('服务器响应超时'));
        }, TIMEOUT_THRESHOLD);
      })
    ]);

    setState(resourceType, LoadState.SUCCESS);

    if (onSuccess) {
      onSuccess(data);
    }

    return data;
  } catch (e) {
    console.error(`[ResourceLoader] 加载${getResourceTypeName(resourceType)}失败:`, e);

    const retryCount = (loaderState.retryCount.get(resourceType) || 0) + 1;
    loaderState.retryCount.set(resourceType, retryCount);

    // 自动重试
    if (retryCount <= loaderState.maxRetries) {
      setState(resourceType, LoadState.RETRYING);
      console.warn(`[ResourceLoader] 将在${loaderState.retryDelay}ms后重试 (${retryCount}/${loaderState.maxRetries})`);

      await new Promise(r => setTimeout(r, loaderState.retryDelay));

      // 递归重试
      return loadResources(resourceType, options);
    }

    // 重试耗尽，显示错误
    setState(resourceType, LoadState.ERROR);
    const container = document.getElementById(getResourceContainerId(resourceType));
    if (container) {
      container.innerHTML = createErrorHTML(resourceType, e.message || '加载失败', '请检查网络连接后重试');
    }

    if (onError) {
      onError(e);
    }
    throw e;
  }
}

/**
 * 手动重试加载
 * @param {string} resourceType - 资源类型
 */
async function retry(resourceType) {
  // 重置重试计数
  loaderState.retryCount.set(resourceType, 0);

  // 重新加载（使用上次的搜索条件）
  const lastQuery = getLastQuery(resourceType);
  await loadResources(resourceType, lastQuery);
}

/* ==========================================================================
 * 搜索状态缓存（记住上次搜索条件，用于重试）
 * ========================================================================== */

const lastQueryCache = new Map();

/**
 * 保存上次的搜索条件
 * @param {string} resourceType - 资源类型
 * @param {Object} query - 搜索条件
 */
function setLastQuery(resourceType, query) {
  lastQueryCache.set(resourceType, query);
}

/**
 * 获取上次的搜索条件
 * @param {string} resourceType - 资源类型
 * @returns {Object} 搜索条件
 */
function getLastQuery(resourceType) {
  return lastQueryCache.get(resourceType) || {};
}

/* ==========================================================================
 * 模块导出
 * ========================================================================== */

const resourceLoader = {
  // 状态
  LoadState,
  getState,
  getStateInfo: () => ({
    current: Object.fromEntries(loaderState.current),
    retryCount: Object.fromEntries(loaderState.retryCount)
  }),

  // 加载
  loadResources,
  retry,

  // UI
  createLoadingHTML,
  createErrorHTML,
  createEmptyHTML,

  // 辅助
  getResourceContainerId,
  getResourceTypeName,

  // 搜索条件缓存
  setLastQuery,
  getLastQuery
};

// 暴露到全局供 onclick 调用
if (typeof window !== 'undefined') {
  window.resourceLoader = resourceLoader;
  window.retryLoadAfterIntervention = retryLoadAfterIntervention;
}

module.exports = resourceLoader;
