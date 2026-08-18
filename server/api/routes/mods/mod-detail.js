/**
 * @file server/api/routes/mods/mod-detail.js
 * @description 模组详情与版本列表查询相关路由
 */

const { extractDeps } = require('./shared');

module.exports = {
  /**
   * 注册模组详情相关路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象
   * @returns {void}
   */
  register(registerRoute, deps) {
    const {
      sendJSON, sendError, readBody, http, versions,
      MODRINTH_API, CURSEFORGE_API
    } = extractDeps(deps);

    /* /api/mods/project-versions - 获取模组的版本列表（支持 GET / POST） */
    registerRoute('*', '/api/mods/project-versions', async (req, res, parsedUrl) => {
      let pvProjectId, pvSource, pvGameVersion, pvLoader;
      if (req.method === 'GET') {
        const q = parsedUrl.query || {};
        pvProjectId = q.projectId;
        pvSource = q.source || 'modrinth';
        pvGameVersion = q.gameVersion || '';
        pvLoader = q.loader || '';
      } else {
        const pvBody = await readBody(req);
        pvProjectId = pvBody.projectId;
        pvSource = pvBody.source || 'modrinth';
        pvGameVersion = pvBody.gameVersion || '';
        pvLoader = pvBody.loader || '';
      }
      try {
        if (pvSource !== 'modrinth' || !pvProjectId) {
          sendJSON(res, { versions: [] });
          return;
        }
        const verParams = [];
        if (pvGameVersion) verParams.push(`game_versions=["${pvGameVersion}"]`);
        if (pvLoader) verParams.push(`loaders=["${pvLoader}"]`);
        // 性能优化：无过滤条件时限制返回最近100个版本
        if (verParams.length === 0) {
          verParams.push('limit=100');
        }
        const verQueryString = verParams.length > 0 ? '?' + verParams.join('&') : '';
        // 性能优化：优先使用官方API（支持limit参数），镜像作为备用
        let rawVersions;
        try {
          const officialVerUrl = `https://api.modrinth.com/v2/project/${pvProjectId}/version${verQueryString}`;
          rawVersions = await http.fetchJSON(officialVerUrl, 3, 30000);
        } catch (officialErr) {
          const mirrorVerUrl = `${MODRINTH_API}/project/${pvProjectId}/version${verQueryString}`;
          rawVersions = await http.cachedFetchJSON(mirrorVerUrl, 600000, 2, 60000);
        }
        let versions = (rawVersions || []).map((v) => ({
          versionId: v.id,
          versionNumber: v.version_number,
          gameVersions: v.game_versions || [],
          loaders: v.loaders || [],
          files: (v.files || []).map((f) => ({
            filename: f.filename,
            url: f.url,
            size: f.size || 0,
            primary: !!f.primary
          })),
          datePublished: v.date_published,
          changelog: v.changelog || ''
        }));
        // 三级回退：精确查询 → 仅 MC 版本 → 全量
        if (versions.length === 0 && (pvGameVersion || pvLoader)) {
          try {
            let fallbackUrl = `${MODRINTH_API}/project/${pvProjectId}/version`;
            const fallbackParams = [];
            if (pvGameVersion) fallbackParams.push(`game_versions=["${pvGameVersion}"]`);
            if (fallbackParams.length) fallbackUrl += '?' + fallbackParams.join('&');
            const fb1 = await http.cachedFetchJSON(fallbackUrl, 600000);
            versions = (fb1 || []).map((v) => ({
              versionId: v.id,
              versionNumber: v.version_number,
              gameVersions: v.game_versions || [],
              loaders: v.loaders || [],
              files: (v.files || []).map((f) => ({
                filename: f.filename,
                url: f.url,
                size: f.size || 0,
                primary: !!f.primary
              })),
              datePublished: v.date_published,
              changelog: v.changelog || ''
            }));
          } catch (e) {}
        }
        if (versions.length === 0 && (pvGameVersion || pvLoader)) {
          try {
            const fb2 = await http.cachedFetchJSON(`${MODRINTH_API}/project/${pvProjectId}/version?limit=10`, 600000);
            versions = (fb2 || []).map((v) => ({
              versionId: v.id,
              versionNumber: v.version_number,
              gameVersions: v.game_versions || [],
              loaders: v.loaders || [],
              files: (v.files || []).map((f) => ({
                filename: f.filename,
                url: f.url,
                size: f.size || 0,
                primary: !!f.primary
              })),
              datePublished: v.date_published,
              changelog: v.changelog || ''
            }));
          } catch (e) {}
        }
        sendJSON(res, { versions });
      } catch (e) {
        sendJSON(res, { versions: [] });
      }
    });

    /* /api/mods/detail - 获取模组详情（Modrinth / CurseForge） */
    registerRoute('GET', '/api/mods/detail', async (req, res, parsedUrl) => {
      const modProjectId = parsedUrl.query.projectId;
      const modSource = parsedUrl.query.source || 'modrinth';
      if (!modProjectId) { sendError(res, 'Missing projectId', 400); return; }

      try {
        if (modSource === 'modrinth') {
          let project;
          try {
            // 镜像源优先：带重试和超时控制（参数顺序: url, cacheTTL, retriesOrHeaders, timeoutMs）
            project = await http.cachedFetchJSON(`${MODRINTH_API}/project/${modProjectId}`, 300000, 3, 25000);
          } catch (mirrorErr) {
            // 镜像失败时回退到官方 API
            console.warn(`[Modrinth] 详情镜像请求失败，回退官方API: ${mirrorErr.message}`);
            const officialDetailUrl = `https://api.modrinth.com/v2/project/${modProjectId}`;
            project = await http.fetchJSON(officialDetailUrl, 2, 30000);
          }
          const detail = {
            id: project.id,
            slug: project.slug,
            title: project.title,
            description: project.description || '',
            body: project.body || '',
            icon: project.icon_url || '',
            downloads: project.downloads || 0,
            followers: project.followers || 0,
            categories: project.categories || [],
            loaders: project.loaders || [],
            gameVersions: project.game_versions || [],
            clientSide: project.client_side || 'unknown',
            serverSide: project.server_side || 'unknown',
            license: project.license?.name || '',
            sourceUrl: project.source_url || '',
            issuesUrl: project.issues_url || '',
            wikiUrl: project.wiki_url || '',
            discordUrl: project.discord_url || '',
            dateCreated: project.published || '',
            dateModified: project.updated || '',
            gallery: (project.gallery || []).map((g) => typeof g === 'string' ? g : g.url || ''),
            source: 'modrinth'
          };
          sendJSON(res, detail);
        } else if (modSource === 'curseforge') {
          const settings = versions.loadSettingsCached();
          const cfApiKey = settings.curseforgeApiKey || '';
          const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
          const cfProject = await http.fetchJSON(`${CURSEFORGE_API}/mods/${modProjectId}`, cfHeaders);
          const mod = cfProject.data || cfProject;
          const detail = {
            id: String(mod.id),
            slug: mod.slug || '',
            title: mod.name || 'Unknown',
            description: mod.summary || '',
            body: mod.description || mod.summary || '',
            icon: mod.logo?.url || '',
            downloads: mod.downloadCount || 0,
            followers: mod.followers || mod.thumbsUpCount || 0,
            categories: (mod.categories || []).map((c) => typeof c === 'string' ? c : c.name || ''),
            loaders: (mod.latestFilesIndexes || []).map((f) => {
              if (f.modLoader === 1) return 'forge';
              if (f.modLoader === 4) return 'fabric';
              if (f.modLoader === 5) return 'neoforge';
              return '';
            }).filter(Boolean),
            gameVersions: [...new Set((mod.latestFilesIndexes || []).map((f) => f.gameVersion))],
            clientSide: 'unknown',
            serverSide: 'unknown',
            license: '',
            sourceUrl: mod.links?.sourceUrl || '',
            issuesUrl: mod.links?.issuesUrl || '',
            wikiUrl: mod.links?.wikiUrl || '',
            discordUrl: '',
            dateCreated: mod.dateCreated || '',
            dateModified: mod.dateModified || '',
            gallery: (mod.screenshots || []).map((s) => typeof s === 'string' ? s : s.url || ''),
            source: 'curseforge'
          };
          sendJSON(res, detail);
        } else {
          sendError(res, 'Unsupported source', 400);
        }
      } catch (e) {
        sendError(res, '获取模组详情失败: ' + e.message);
      }
    });

    /* /api/mods/versions - 获取模组版本列表（含分页与加载器映射） */
    registerRoute('GET', '/api/mods/versions', async (req, res, parsedUrl) => {
      const mvProjectId = parsedUrl.query.projectId;
      const mvSource = parsedUrl.query.source || 'modrinth';
      const mvLoader = parsedUrl.query.loader || '';
      const mvGameVer = parsedUrl.query.gameVersion || '';
      if (!mvProjectId) { sendError(res, 'Missing projectId', 400); return; }

      try {
        if (mvSource === 'modrinth') {
          const encodedId = encodeURIComponent(mvProjectId);
          const params = [];
          if (mvLoader) params.push(`loaders=["${encodeURIComponent(mvLoader)}"]`);
          if (mvGameVer) params.push(`game_versions=["${encodeURIComponent(mvGameVer)}"]`);
          // 性能优化：无过滤条件时限制返回最近100个版本，避免超大响应（如Fabric API 900KB）
          if (params.length === 0) {
            params.push('limit=100');
          }
          const queryString = params.length > 0 ? '?' + params.join('&') : '';

          let versions;
          // 性能优化：MCI镜像不支持limit参数，对于版本列表请求优先使用官方API
          // 官方API: limit=20 响应20KB/1.3秒；MCI镜像: 30秒超时/900KB
          try {
            const officialUrl = `https://api.modrinth.com/v2/project/${encodedId}/version${queryString}`;
            versions = await http.fetchJSON(officialUrl, 3, 30000);
          } catch (officialErr) {
            // 官方API失败时回退到MCI镜像
            console.warn(`[Modrinth] 官方API版本请求失败，回退镜像: ${officialErr.message}`);
            const mirrorUrl = `${MODRINTH_API}/project/${encodedId}/version${queryString}`;
            versions = await http.cachedFetchJSON(mirrorUrl, 600000, 2, 60000);
          }
          const result = (versions || []).map((v) => ({
            id: v.id,
            versionNumber: v.version_number || '',
            versionName: v.name || v.version_number || '',
            gameVersions: v.game_versions || [],
            loaders: v.loaders || [],
            releaseType: v.version_type || 'release',
            datePublished: v.date_published || '',
            downloads: v.downloads || 0,
            changelog: v.changelog || '',
            files: (v.files || []).map((f) => ({
              id: f.id || f.hashes?.sha1 || '',
              url: f.url,
              filename: f.filename,
              size: f.size || 0,
              primary: f.primary || false,
              sha1: f.hashes?.sha1 || ''
            })),
            dependencies: (v.dependencies || []).map((d) => ({
              projectId: d.project_id,
              versionId: d.version_id,
              dependencyType: d.dependency_type,
              modName: d.project_id || ''
            }))
          }));
          sendJSON(res, { versions: result });
        } else if (mvSource === 'curseforge') {
          const settings = versions.loadSettingsCached();
          const cfApiKey = settings.curseforgeApiKey || '';
          const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};

          // CurseForge 分页拉取所有文件
          let allCfFiles = [];
          let cfPageIndex = 0;
          const cfPageSize = 1000;
          let cfHasMore = true;

          while (cfHasMore) {
            let cfUrl = `${CURSEFORGE_API}/mods/${mvProjectId}/files?pageSize=${cfPageSize}&index=${cfPageIndex}`;
            const cfParams = [];
            if (mvGameVer) cfParams.push(`gameVersion=${mvGameVer}`);
            if (mvLoader) {
              const loaderMap = { fabric: 4, forge: 1, neoforge: 6, quilt: 5 };
              const loaderType = loaderMap[mvLoader.toLowerCase()];
              if (loaderType) cfParams.push(`modLoaderType=${loaderType}`);
            }
            if (cfParams.length > 0) cfUrl += '&' + cfParams.join('&');

            const cfRes = await http.fetchJSON(cfUrl, cfHeaders, 25000);
            const cfBatch = cfRes.data || [];
            allCfFiles = allCfFiles.concat(cfBatch);

            const pagination = cfRes.pagination;
            if (pagination && pagination.totalCount > cfPageIndex + cfPageSize) {
              cfPageIndex += cfPageSize;
            } else {
              cfHasMore = false;
            }
            if (cfBatch.length < cfPageSize) cfHasMore = false;
          }

          // 按游戏版本分组文件
          const cfFiles = allCfFiles;
          const byVersion = new Map();
          for (const f of cfFiles) {
            const gv = (f.gameVersions || []).find((v) => /^\d+\.\d+/.test(v)) || (f.gameVersions || [])[0] || '';
            const key = gv || f.id;
            if (!byVersion.has(key)) {
              byVersion.set(key, {
                id: String(f.id),
                versionNumber: f.displayName || f.fileName || '',
                versionName: f.displayName || f.fileName || '',
                gameVersions: f.gameVersions || [],
                loaders: (f.gameVersions || []).filter((v) => ['fabric','forge','neoforge','quilt','fabric-loader','forge-loader'].includes(v.toLowerCase())).map((v) => v.toLowerCase().replace('-loader','')),
                releaseType: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
                datePublished: f.fileDate || '',
                downloads: 0,
                changelog: '',
                files: [],
                dependencies: (f.dependencies || []).map((d) => ({
                  projectId: String(d.modId || ''),
                  versionId: String(d.fileId || ''),
                  dependencyType: d.relationType === 3 ? 'required' : d.relationType === 5 ? 'required' : d.relationType === 2 ? 'optional' : d.relationType === 1 ? 'optional' : 'incompatible',
                  modName: ''
                }))
              });
            }
            byVersion.get(key).files.push({
              id: String(f.id),
              url: f.downloadUrl || '',
              filename: f.fileName || '',
              size: f.fileLength || 0,
              primary: byVersion.get(key).files.length === 0,
              sha1: ''
            });
          }
          sendJSON(res, { versions: Array.from(byVersion.values()) });
        } else {
          sendError(res, 'Unsupported source', 400);
        }
      } catch (e) {
        sendError(res, '获取模组版本列表失败: ' + e.message);
      }
    });
  }
};
