/**
 * @file server/services/resource-service.js
 * @description 统一资源加载服务 - 支持模组、整合包、数据包、材质包、光影包的搜索与加载
 *   替代原有分散的资源路由，提供统一的加载接口和错误处理
 */

const networkManager = require('../http-client/network-manager');
const ctx = require('../context');

/* ==========================================================================
 * 资源类型定义
 * ========================================================================== */

const RESOURCE_TYPES = {
  mod: { projectType: 'mod', name: '模组', icon: '📦' },
  modpack: { projectType: 'modpack', name: '整合包', icon: '🎁' },
  datapack: { projectType: 'datapack', name: '数据包', icon: '📊' },
  resourcepack: { projectType: 'resourcepack', name: '材质包', icon: '🎨' },
  shader: { projectType: 'shader', name: '光影包', icon: '✨' }
};

/* ==========================================================================
 * 统一搜索接口
 * ========================================================================== */

/**
 * 搜索资源（支持所有资源类型）
 * @param {string} query - 搜索关键词
 * @param {string} resourceType - 资源类型（mod/modpack/datapack/resourcepack/shader）
 * @param {Object} [filters={}] - 过滤条件
 * @param {string} [filters.loader] - 加载器（forge/fabric/quilt/neoforge）
 * @param {string} [filters.version] - 游戏版本
 * @param {string} [filters.category] - 分类
 * @param {string} [filters.sort] - 排序方式
 * @param {number} [filters.limit=15] - 每页数量
 * @param {number} [filters.offset=0] - 偏移量
 * @returns {Promise<Object>} { hits, total, offset, type }
 */
async function searchResources(query, resourceType, filters = {}) {
  const {
    loader = '',
    version = '',
    category = '',
    sort = 'relevance',
    limit = 15,
    offset = 0
  } = filters;

  // 验证资源类型
  const typeConfig = RESOURCE_TYPES[resourceType];
  if (!typeConfig) {
    throw new Error(`不支持的资源类型: ${resourceType}`);
  }

  // 中文搜索词翻译
  let processedQuery = query || '';
  if (processedQuery && /[\u4e00-\u9fff]/.test(processedQuery)) {
    processedQuery = translateChineseQuery(processedQuery, resourceType);
  }

  // 构建搜索URL
  const facets = [[`project_type:${typeConfig.projectType}`]];
  if (loader) facets.push([`categories:${loader}`]);
  if (version) facets.push([`versions:${version}`]);
  if (category) facets.push([`categories:${category}`]);

  const sortMap = {
    relevance: 'relevance',
    downloads: 'downloads',
    newest: 'newest',
    updated: 'updated',
    follows: 'follows'
  };
  const sortField = sortMap[sort] || (processedQuery ? 'relevance' : 'downloads');

  const searchUrl = `${ctx.urls.MODRINTH_API}/search` +
    `?query=${encodeURIComponent(processedQuery)}` +
    `&index=${sortField}` +
    `&limit=${limit}` +
    `&offset=${offset}` +
    `&facets=${encodeURIComponent(JSON.stringify(facets))}`;

  // 使用统一网络管理器请求：L2单次20秒 × 3次重试，与network-manager.js对齐
  const result = await networkManager.cachedFetchJSON(searchUrl, 60000, {
    timeout: 20000,
    retries: 3
  });

  // 格式化结果
  const hits = (result.hits || []).map(hit => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description || '',
    author: (hit.author || '').replace(/_/g, ''),
    icon: hit.icon_url || '',
    downloads: hit.downloads || 0,
    followers: hit.followers || 0,
    categories: hit.categories || [],
    versions: hit.versions || [],
    dateCreated: hit.date_created || '',
    dateModified: hit.date_modified || '',
    source: 'modrinth',
    projectType: typeConfig.projectType,
    installed: false
  }));

  return {
    hits,
    total: result.total_hits || hits.length,
    offset,
    type: resourceType
  };
}

/**
 * 获取资源详情
 * @param {string} projectId - 项目ID
 * @param {string} resourceType - 资源类型
 * @returns {Promise<Object>} 资源详情
 */
async function getResourceDetail(projectId, resourceType) {
  const projectUrl = `${ctx.urls.MODRINTH_API}/project/${projectId}`;
  const versionUrl = `${ctx.urls.MODRINTH_API}/project/${projectId}/version`;

  const [project, versions] = await Promise.all([
    networkManager.cachedFetchJSON(projectUrl, 300000, { timeout: 20000, retries: 3 }),
    networkManager.cachedFetchJSON(versionUrl, 300000, { timeout: 20000, retries: 3 })
  ]);

  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    description: project.description,
    body: project.body,
    icon: project.icon_url,
    downloads: project.downloads,
    followers: project.followers,
    categories: project.categories,
    license: project.license,
    source: 'modrinth',
    versions: Array.isArray(versions) ? versions.map(v => ({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions || [],
      loaders: v.loaders || [],
      files: (v.files || []).map(f => ({
        url: f.url,
        filename: f.filename,
        primary: f.primary,
        size: f.size
      })),
      datePublished: v.date_published,
      dependencies: v.dependencies || []
    })) : []
  };
}

/* ==========================================================================
 * 中文搜索翻译
 * ========================================================================== */

const CHINESE_KEYWORD_MAP = {
  // 常见模组中文翻译
  '优化': 'sodium optifine',
  '光影': 'shader iris',
  '小地图': 'minimap',
  '地图': 'map journeymap',
  '背包': 'inventory',
  '合成': 'crafting',
  '装饰': 'decoration',
  '魔法': 'magic',
  '科技': 'technology',
  '冒险': 'adventure',
  '红石': 'redstone',
  '自动化': 'automation',
  '存储': 'storage',
  '食物': 'food',
  '武器': 'weapon',
  '装备': 'equipment',
  '生物': 'mobs',
  '维度': 'dimension',
  '建筑': 'building'
};

/**
 * 翻译中文搜索词
 * @param {string} query - 中文搜索词
 * @param {string} resourceType - 资源类型
 * @returns {string} 翻译后的搜索词
 */
function translateChineseQuery(query, resourceType) {
  if (!query) return query;
  const q = query.toLowerCase().trim();

  // 精确匹配
  if (CHINESE_KEYWORD_MAP[q]) {
    return CHINESE_KEYWORD_MAP[q];
  }

  // 模糊匹配
  for (const [cn, en] of Object.entries(CHINESE_KEYWORD_MAP)) {
    if (q.includes(cn) || cn.includes(q)) {
      return en;
    }
  }

  return query;
}

/* ==========================================================================
 * 批量搜索（多类型同时搜索）
 * ========================================================================== */

/**
 * 批量搜索多种资源类型
 * @param {string} query - 搜索关键词
 * @param {string[]} types - 资源类型数组
 * @param {Object} filters - 过滤条件
 * @returns {Promise<Object>} 各类型搜索结果 { [type]: { hits, total } }
 */
async function searchMultipleTypes(query, types, filters = {}) {
  const results = {};
  const promises = types.map(async (type) => {
    try {
      results[type] = await searchResources(query, type, filters);
    } catch (e) {
      console.warn(`[ResourceService] 搜索${type}失败:`, e.message);
      results[type] = { hits: [], total: 0, offset: 0, type, error: e.message };
    }
  });
  await Promise.all(promises);
  return results;
}

/* ==========================================================================
 * 多站点跨站搜索
 * ========================================================================== */

/**
 * 多站点搜索配置
 * 支持的站点列表（国内镜像优先）
 */
const SEARCH_SITES = {
  modrinth: {
    name: 'Modrinth',
    baseUrl: 'https://mod.mcimirror.top/modrinth/v2',
    // 备选源：MCI镜像不可用时依次尝试
    backupUrls: [
      'https://api.modrinth.com/v2',           // Modrinth官方（中度限制地区可能可达）
      'https://staging-api.modrinth.com/v2'    // Modrinth预发布API
    ],
    backupUrl: null,
    enabled: true,
    region: 'CN'
  },
  curseforge: {
    name: 'CurseForge',
    baseUrl: 'https://mod.mcimirror.top/curseforge/v1',
    backupUrls: [
      'https://api.curseforge.com/v1'          // CurseForge官方（需API key，作为最后手段）
    ],
    backupUrl: null,
    enabled: true,
    region: 'CN'
  }
};

/**
 * 跨站搜索资源
 * 同时从多个站点搜索，合并结果并按相关性和下载量排序
 * @param {string} query - 搜索关键词
 * @param {string} resourceType - 资源类型
 * @param {Object} [filters={}] - 过滤条件
 * @returns {Promise<Object>} 合并后的搜索结果
 */
async function searchAcrossSites(query, resourceType, filters = {}) {
  const { limit = 15, offset = 0 } = filters;

  // 验证资源类型
  const typeConfig = RESOURCE_TYPES[resourceType];
  if (!typeConfig) {
    throw new Error(`不支持的资源类型: ${resourceType}`);
  }

  // 并发从各站点搜索
  const sitePromises = [];
  const enabledSites = Object.entries(SEARCH_SITES).filter(([_, s]) => s.enabled);

  for (const [siteKey, siteConfig] of enabledSites) {
    sitePromises.push(
      searchFromSite(siteKey, siteConfig, query, resourceType, filters)
        .then(hits => ({ site: siteKey, siteName: siteConfig.name, hits, error: null }))
        .catch(e => ({ site: siteKey, siteName: siteConfig.name, hits: [], error: e.message }))
    );
  }

  const siteResults = await Promise.all(sitePromises);

  // 合并结果
  const mergedHits = [];
  const seenIds = new Set();

  for (const result of siteResults) {
    for (const hit of result.hits) {
      // 去重（按项目ID或标题）
      const dedupKey = hit.id || hit.title;
      if (!seenIds.has(dedupKey)) {
        seenIds.add(dedupKey);
        hit.source = result.site;
        hit.sourceName = result.siteName;
        mergedHits.push(hit);
      }
    }
  }

  // 排序：下载量降序
  mergedHits.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

  // 分页
  const pagedHits = mergedHits.slice(offset, offset + limit);

  // 构建站点状态
  const siteStatus = siteResults.map(r => ({
    site: r.site,
    name: r.siteName,
    success: !r.error,
    resultCount: r.hits.length,
    error: r.error
  }));

  return {
    hits: pagedHits,
    total: mergedHits.length,
    offset,
    type: resourceType,
    sites: siteStatus,
    multiSite: true
  };
}

/**
 * 从单个站点搜索
 * @param {string} siteKey - 站点键
 * @param {Object} siteConfig - 站点配置
 * @param {string} query - 搜索关键词
 * @param {string} resourceType - 资源类型
 * @param {Object} filters - 过滤条件
 * @returns {Promise<Array>} 搜索结果数组
 */
async function searchFromSite(siteKey, siteConfig, query, resourceType, filters) {
  const { loader = '', version = '', category = '', sort = 'relevance', limit = 15 } = filters;
  const typeConfig = RESOURCE_TYPES[resourceType];

  // 中文翻译
  let processedQuery = query || '';
  if (processedQuery && /[\u4e00-\u9fff]/.test(processedQuery)) {
    processedQuery = translateChineseQuery(processedQuery, resourceType);
  }

  if (siteKey === 'modrinth') {
    // Modrinth 搜索 - 构建搜索URL的函数（支持不同baseUrl）
    const buildModrinthUrl = (baseUrl) => {
      const facets = [[`project_type:${typeConfig.projectType}`]];
      if (loader) facets.push([`categories:${loader}`]);
      if (version) facets.push([`versions:${version}`]);
      if (category) facets.push([`categories:${category}`]);
      const sortField = sort === 'downloads' ? 'downloads' : 'relevance';
      return `${baseUrl}/search` +
        `?query=${encodeURIComponent(processedQuery)}` +
        `&index=${sortField}` +
        `&limit=${limit}` +
        `&offset=0` +
        `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    };

    // 依次尝试主源和备选源
    const urlsToTry = [siteConfig.baseUrl, ...(siteConfig.backupUrls || [])];
    let lastError = null;

    for (const baseUrl of urlsToTry) {
      try {
        const searchUrl = buildModrinthUrl(baseUrl);
        // 备选源快速失败：8秒超时，1次重试，确保3个源总计<25秒
        const isPrimary = baseUrl === siteConfig.baseUrl;
        const result = await networkManager.cachedFetchJSON(searchUrl, 60000, {
          timeout: isPrimary ? 20000 : 8000,
          retries: isPrimary ? 2 : 1
        });

        const hits = (result.hits || []).map(hit => ({
          id: hit.project_id,
          slug: hit.slug,
          title: hit.title,
          description: hit.description || '',
          author: (hit.author || '').replace(/_/g, ''),
          icon: hit.icon_url || '',
          downloads: hit.downloads || 0,
          categories: hit.categories || [],
          versions: hit.versions || [],
          projectType: typeConfig.projectType
        }));

        if (baseUrl !== siteConfig.baseUrl) {
          console.info(`[ResourceService] Modrinth备选源成功: ${baseUrl.substring(0, 40)}`);
        }
        return hits;
      } catch (e) {
        lastError = e;
        console.warn(`[ResourceService] Modrinth源失败(${baseUrl.substring(0, 40)}): ${e.message.substring(0, 60)}`);
        // 继续尝试下一个备选源
      }
    }

    throw lastError || new Error('所有Modrinth源均不可用');
  } else if (siteKey === 'curseforge') {
    // CurseForge 搜索（通过镜像）
    const classId = getCurseForgeClassId(resourceType);
    if (!classId) return []; // 不支持的类型

    const buildCurseForgeUrl = (baseUrl) => `${baseUrl}/search` +
      `?classId=${classId}` +
      `&searchFilter=${encodeURIComponent(processedQuery)}` +
      `&sortField=2` +
      `&sortOrder=desc` +
      `&pageSize=${limit}`;

    // 依次尝试主源和备选源
    const urlsToTry = [siteConfig.baseUrl, ...(siteConfig.backupUrls || [])];
    let lastError = null;

    for (const baseUrl of urlsToTry) {
      try {
        const searchUrl = buildCurseForgeUrl(baseUrl);
        // 备选源快速失败：8秒超时，1次重试
        const isPrimary = baseUrl === siteConfig.baseUrl;
        const result = await networkManager.cachedFetchJSON(searchUrl, 60000, {
          timeout: isPrimary ? 20000 : 8000,
          retries: isPrimary ? 2 : 1
        });

        if (!result.data) return [];

        const hits = result.data.map(item => ({
          id: `cf-${item.id}`,
          slug: item.slug,
          title: item.name,
          description: item.summary || '',
        author: (item.authors && item.authors[0] && item.authors[0].name) || '',
        icon: (item.logo && item.logo.url) || '',
        downloads: item.downloadCount || 0,
        categories: (item.categories || []).map(c => c.name),
        versions: [],
        projectType: typeConfig.projectType,
        source: 'curseforge'
      }));

        if (baseUrl !== siteConfig.baseUrl) {
          console.info(`[ResourceService] CurseForge备选源成功: ${baseUrl.substring(0, 40)}`);
        }
        return hits;
      } catch (e) {
        lastError = e;
        console.warn(`[ResourceService] CurseForge源失败(${baseUrl.substring(0, 40)}): ${e.message.substring(0, 60)}`);
      }
    }

    // CurseForge所有源失败，返回空数组而非抛错（CurseForge是辅助源）
    console.warn('[ResourceService] CurseForge所有源均不可用');
    return [];
  }

  return [];
}

/**
 * 获取CurseForge资源类别ID
 * @param {string} resourceType - 资源类型
 * @returns {number|null} 类别ID
 */
function getCurseForgeClassId(resourceType) {
  const classIds = {
    mod: 6,          // Mods
    modpack: 4471,   // Modpacks
    datapack: 6945,  // Datapacks (可能不支持)
    resourcepack: 12, // Resource Packs
    shader: 6552     // Shader Packs
  };
  return classIds[resourceType] || null;
}

/* ==========================================================================
 * 错误处理包装器
 * ========================================================================== */

/**
 * 包装搜索请求，统一错误处理
 * @param {Function} searchFn - 搜索函数
 * @returns {Function} 包装后的函数
 */
function withErrorHandler(searchFn) {
  return async function (...args) {
    try {
      return await searchFn(...args);
    } catch (e) {
      const diagnosis = networkManager.diagnoseError(e);
      const error = new Error(diagnosis.message);
      error.suggestion = diagnosis.suggestion;
      error.isNetworkError = diagnosis.isNetworkError;
      error.originalError = e;
      throw error;
    }
  };
}

/* ==========================================================================
 * 模块导出
 * ========================================================================== */

module.exports = {
  // 资源类型
  RESOURCE_TYPES,

  // 搜索接口
  searchResources: withErrorHandler(searchResources),
  getResourceDetail: withErrorHandler(getResourceDetail),
  searchMultipleTypes: withErrorHandler(searchMultipleTypes),

  // 跨站搜索
  searchAcrossSites: withErrorHandler(searchAcrossSites),
  SEARCH_SITES,

  // 中文翻译
  translateChineseQuery,

  // 错误处理
  withErrorHandler
};
