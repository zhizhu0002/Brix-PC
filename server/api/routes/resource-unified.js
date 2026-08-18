/**
 * @file server/api/routes/resource-unified.js
 * @description 统一资源搜索路由 - 替代分散的 mod-search.js、resources.js、modpacks.js
 *   提供统一的 /api/resources/search 接口，支持所有资源类型
 */

const resourceService = require('../../services/resource-service');
const networkManager = require('../../http-client/network-manager');

module.exports = {
  /**
   * 注册统一资源路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象
   */
  register(registerRoute, deps) {
    const { sendJSON, sendError } = deps;

    /* /api/resources/search - 统一资源搜索（支持所有类型） */
    registerRoute('GET', '/api/resources/search', async (req, res, parsedUrl) => {
      await new Promise((r) => setImmediate(r));

      const query = parsedUrl.query.query || '';
      const resourceType = parsedUrl.query.type || 'mod';
      const loader = parsedUrl.query.loader || '';
      const version = parsedUrl.query.version || '';
      const category = parsedUrl.query.category || '';
      const sort = parsedUrl.query.sort || 'relevance';
      const limit = parseInt(parsedUrl.query.limit || '15', 10);
      const offset = parseInt(parsedUrl.query.offset || '0', 10);

      console.debug(`[ResourceUnified] 搜索: type=${resourceType}, query="${query}", offset=${offset}`);

      try {
        const result = await resourceService.searchResources(query, resourceType, {
          loader, version, category, sort, limit, offset
        });

        console.debug(`[ResourceUnified] 搜索完成: type=${resourceType}, 找到${result.hits.length}个结果`);
        sendJSON(res, result);
      } catch (e) {
        console.error(`[ResourceUnified] 搜索失败: type=${resourceType}, error=${e.message}`);

        const diagnosis = networkManager.diagnoseError(e);

        // 返回用户友好的错误信息
        if (diagnosis.isNetworkError) {
          sendError(res, `${getResourceTypeName(resourceType)}服务暂时不可用，请稍后重试`);
        } else if (e.message.includes('API错误') || e.message.includes('internal_error')) {
          sendError(res, `${getResourceTypeName(resourceType)}服务暂时不可用，请稍后重试`);
        } else {
          sendError(res, `搜索失败: ${diagnosis.message}`);
        }
      }
    });

    /* /api/resources/detail - 统一资源详情 */
    registerRoute('GET', '/api/resources/detail', async (req, res, parsedUrl) => {
      const projectId = parsedUrl.query.projectId;
      const resourceType = parsedUrl.query.type || 'mod';

      if (!projectId) {
        sendError(res, 'Missing projectId parameter', 400);
        return;
      }

      console.debug(`[ResourceUnified] 获取详情: projectId=${projectId}, type=${resourceType}`);

      try {
        const detail = await resourceService.getResourceDetail(projectId, resourceType);
        sendJSON(res, detail);
      } catch (e) {
        console.error(`[ResourceUnified] 获取详情失败: ${e.message}`);
        const diagnosis = networkManager.diagnoseError(e);
        sendError(res, diagnosis.message);
      }
    });

    /* /api/resources/multi-search - 多类型同时搜索 */
    registerRoute('GET', '/api/resources/multi-search', async (req, res, parsedUrl) => {
      const query = parsedUrl.query.query || '';
      const types = (parsedUrl.query.types || 'mod,modpack,datapack,resourcepack,shader').split(',');
      const filters = {
        loader: parsedUrl.query.loader || '',
        version: parsedUrl.query.version || '',
        category: parsedUrl.query.category || '',
        sort: parsedUrl.query.sort || 'relevance',
        limit: parseInt(parsedUrl.query.limit || '5', 10),
        offset: 0
      };

      console.debug(`[ResourceUnified] 多类型搜索: query="${query}", types=${types.join(',')}`);

      try {
        const results = await resourceService.searchMultipleTypes(query, types, filters);
        sendJSON(res, results);
      } catch (e) {
        console.error(`[ResourceUnified] 多类型搜索失败: ${e.message}`);
        sendError(res, '搜索失败: ' + e.message);
      }
    });

    /* /api/resources/cross-site-search - 跨站搜索（多站点并发）
     * 同时从 Modrinth、CurseForge 等站点搜索，合并结果
     */
    registerRoute('GET', '/api/resources/cross-site-search', async (req, res, parsedUrl) => {
      await new Promise((r) => setImmediate(r));

      const query = parsedUrl.query.query || '';
      const resourceType = parsedUrl.query.type || 'mod';
      const filters = {
        loader: parsedUrl.query.loader || '',
        version: parsedUrl.query.version || '',
        category: parsedUrl.query.category || '',
        sort: parsedUrl.query.sort || 'downloads',
        limit: parseInt(parsedUrl.query.limit || '15', 10),
        offset: parseInt(parsedUrl.query.offset || '0', 10)
      };

      console.debug(`[ResourceUnified] 跨站搜索: query="${query}", type=${resourceType}`);

      try {
        const result = await resourceService.searchAcrossSites(query, resourceType, filters);
        console.debug(`[ResourceUnified] 跨站搜索完成: 找到${result.total}个结果，来源${(result.sites || []).length}个站点`);
        sendJSON(res, result);
      } catch (e) {
        console.error(`[ResourceUnified] 跨站搜索失败: ${e.message}`);
        const diagnosis = networkManager.diagnoseError(e);
        sendError(res, `跨站搜索失败: ${diagnosis.message}`);
      }
    });

    /* /api/resources/network-status - 获取网络状态 */
    registerRoute('GET', '/api/resources/network-status', async (req, res, parsedUrl) => {
      try {
        // 触发网络检测
        await networkManager.checkNetworkStatus();
        const info = networkManager.getNetworkInfo();
        sendJSON(res, info);
      } catch (e) {
        sendJSON(res, { isOnline: false, error: e.message });
      }
    });

    /* /api/resources/categories - 获取资源分类列表 */
    registerRoute('GET', '/api/resources/categories', async (req, res, parsedUrl) => {
      const resourceType = parsedUrl.query.type || 'mod';

      // 返回预设分类
      const categories = getResourceCategories(resourceType);
      sendJSON(res, { categories });
    });
  }
};

/* ==========================================================================
 * 辅助函数
 * ========================================================================== */

function getResourceTypeName(type) {
  const names = {
    mod: '模组', modpack: '整合包', datapack: '数据包',
    resourcepack: '材质包', shader: '光影包'
  };
  return names[type] || type;
}

function getResourceCategories(type) {
  const commonCategories = [
    { name: 'adventure', display: '冒险' },
    { name: 'optimization', display: '优化' },
    { name: 'magic', display: '魔法' },
    { name: 'technology', display: '科技' },
    { name: 'decoration', display: '装饰' },
    { name: 'storage', display: '存储' },
    { name: 'food', display: '食物' },
    { name: 'equipment', display: '装备' },
    { name: 'utility', display: '实用' },
    { name: 'performance', display: '性能' }
  ];

  if (type === 'resourcepack') {
    return [
      { name: '16x', display: '16x' },
      { name: '32x', display: '32x' },
      { name: '64x', display: '64x' },
      { name: '128x', display: '128x' },
      { name: '256x', display: '256x' },
      { name: '512x+', display: '512x+' },
      { name: 'cartoon', display: '卡通' },
      { name: 'medieval', display: '中世纪' },
      { name: 'modern', display: '现代' },
      { name: 'photo-realistic', display: '写实' }
    ];
  }

  if (type === 'shader') {
    return [
      { name: 'pbr', display: 'PBR' },
      { name: 'path-tracing', display: '光线追踪' },
      { name: 'reflections', display: '反射' },
      { name: 'shadows', display: '阴影' },
      { name: 'volumetric-light', display: '体积光' }
    ];
  }

  return commonCategories;
}
