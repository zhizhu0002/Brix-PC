/**
 * Brix - Minecraft Launcher
 * Copyright (c) 2026 YMA. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

/**
 * app.js - Brix 前端主应用逻辑
 * ============================================================================
 * 所有渲染进程(前端)的UI交互逻辑，是用户界面的核心控制器。
 *
 * 核心功能：
 * 1. 版本管理 - 版本列表加载、渲染、筛选、选择
 * 2. 启动流程 - 启动按钮处理、启动模态框、进度轮询/SSE监听
 * 3. 模组管理 - 模组搜索、安装、详情、多选操作
 * 4. 系统设置 - Java路径/内存/窗口/语言/下载等设置
 * 5. 账户管理 - Microsoft/离线登录、皮肤显示
 * 6. Java管理 - Java运行时下载、切换、自动检测
 * 7. 整合包 - Modrinth/CurseForge整合包浏览和安装
 * 8. 地图/Saves - 存档和世界管理
 * 9. 资源下载 - 光影/材质/数据包等资源下载
 * 10. 界面框架 - Toast通知、Modal对话框、页面导航
 *
 * 架构说明：
 * - 单页面应用(SPA)架构，通过页面切换实现多视图
 * - 全局状态变量管理应用数据
 * - 通过 API 对象调用后端接口
 * - DOM缓存(domCache)优化频繁的DOM查询
 */

/* 全局状态变量 - 应用数据状态中心 */
let currentVersionTab = 'release';
let allVersions = [];
let installedVersions = [];
let versionIconsTimestamp = Date.now();
let currentModTab = 'installed-mods';
let modSearchOffset = 0;
let modSearchTotal = 0;
let modSearchQuery = '';
let modSearchResults = [];
let _modDownloadVersionId = '';
let currentInstallSessionId = null;
let msAuthPollInterval = null;
let currentLoaderType = 'fabric';
let gameLogEventSource = null;
let currentModDetailId = null;
let currentModDetailSource = 'modrinth';
let previousPage = null;
let modDetailHistory = [];
let modDetailVersions = [];
let modDownloadPollTimers = [];
let _isRestoringModDetail = false;
let _favorites = [];
let _currentFavId = '';
let _favMultiSelectMode = false;
let _favSelectedItems = new Set();
let _favSearchQuery = '';


let launchDepPollTimer = null;
let modMultiSelectMode = false;
let modSelectedIds = new Set();
let modSelectedVersions = new Map();

/* 优化基础设施 - DOM缓存、防抖节流等 */

/* DOM 缓存对象 */




/* 原有函数 */






document.addEventListener('DOMContentLoaded', () => {
  init();
  setTimeout(initSettingsPages, 500);
  renderSponsors();
  loadMachineId();
  updateActivationStatus();
  // 启动时不再自动弹出"更新公告"，新版本提示由更新检测单独处理，避免同时出现两个弹窗

  if (window.electronAPI?.platform && window.electronAPI.platform !== 'win32') {
    document.querySelectorAll('.win-only').forEach((el) => (el.style.display = 'none'));
  }

  let _acChk = 0;
  let _lastVisible = true;
  const _acTick = async () => {
    try {
      const s = await window.electronAPI?.activateStatus?.();
      const btn = document.getElementById('nav-explore-btn');
      if (!btn) return;
      
      btn.style.display = '';
      _lastVisible = true;
    } catch (_) {}
  };
  setInterval(_acTick, 120000);
  setTimeout(_acTick, 30000);
});

/* 全局资源加载错误处理 */
(function() {
    const RESOURCE_RETRY_MAX = 3;
    const RESOURCE_RETRY_DELAY = 2000;
    
    const imageFallbackMap = {
        'img/logo.ico': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjNjBhNWFhIi8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMTgiIGZpbGw9IiNmZmYiLz48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSI5IiBmaWxsPSIjZmZmIiBmaWxsLW9wYWNpdHk9IjAuMyIvPjwvc3ZnPg==',
        'img/Grass.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjMTgyNTAwIi8+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjEyIiB4PSIxMiIgeT0iMTIiIGZpbGw9IiMwNDA3MDAiLz48L3N2Zz4=',
        'img/CommandBlock.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjN2Y2YzAwIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOCIgb3BhY2l0eT0iMC41IiBmaWxsPSIjMDAwIi8+PC9zdmc+',
        'img/Fabric.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjMzRiYWZmIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNiIgZmlsbD0iI2ZmZmZmZiIvPjwvc3ZnPg==',
        'img/NeoForge.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjZjJhMzZkIi8+PHJlY3Qgd2lkdGg9IjEyIiBoZWlnaHQ9IjEyIiB4PSI2IiB5PSI2IiBmaWxsPSIjZmZmIi8+PC9zdmc+',
        'img/OptiFabric.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjYmU4Y2Y1Ii8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOCIgb3BhY2l0eT0iMC42IiBmaWxsPSIjZmZmIi8+PC9zdmc+',
        'img/pcl.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjNmJiOGZiIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNiIgZmlsbD0iI2ZmZmZmZiIvPjwvc3ZnPg==',
        'img/hmcl.png': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjMGJiNzBjIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNiIgZmlsbD0iI2ZmZmZmZiIvPjwvc3ZnPg==',
    };
    
    function getImageFallback(src) {
        for (const [key, value] of Object.entries(imageFallbackMap)) {
            if (src.includes(key)) return value;
        }
        return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjZmZmIi8+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiB4PSI3IiB5PSI3IiBmaWxsPSIjZmZmIiBmaWxsLW9wYWNpdHk9IjAuMyIvPjwvc3ZnPg==';
    }
    
    document.addEventListener('error', (e) => {
        const target = e.target;
        
        if (target.tagName === 'IMG') {
            handleImageError(target);
        } else if (target.tagName === 'SCRIPT') {
            handleScriptError(target);
        } else if (target.tagName === 'LINK' && target.rel === 'stylesheet') {
            handleStyleError(target);
        }
    }, true);
    
    function handleImageError(img) {
        if (img.dataset._resourceRetried) return;
        
        const originalSrc = img.src;
        const retryCount = parseInt(img.dataset._retryCount || '0');
        
        if (retryCount < RESOURCE_RETRY_MAX) {
            img.dataset._retryCount = String(retryCount + 1);
            setTimeout(() => {
                img.src = originalSrc;
            }, RESOURCE_RETRY_DELAY * (retryCount + 1) + Math.random() * 500);
        } else {
            img.dataset._resourceRetried = 'true';
            const fallback = getImageFallback(originalSrc);
            if (fallback) {
                img.src = fallback;
                console.warn(`[Resource] Image fallback used: ${originalSrc}`);
            } else {
                img.style.display = 'none';
                console.error(`[Resource] Image failed with no fallback: ${originalSrc}`);
            }
        }
    }
    
    function handleScriptError(script) {
        if (script.dataset._resourceRetried) return;
        
        const originalSrc = script.src;
        const retryCount = parseInt(script.dataset._retryCount || '0');
        
        console.warn(`[Resource] Script load failed: ${originalSrc} (attempt ${retryCount + 1})`);
        
        if (retryCount < RESOURCE_RETRY_MAX) {
            script.dataset._retryCount = String(retryCount + 1);
            const newScript = document.createElement('script');
            newScript.src = originalSrc;
            newScript.dataset._retryCount = String(retryCount + 1);
            newScript.dataset._resourceRetried = 'true';
            script.parentNode.replaceChild(newScript, script);
        } else {
            console.error(`[Resource] Script failed after ${RESOURCE_RETRY_MAX} retries: ${originalSrc}`);
            showResourceError(`脚本加载失败: ${originalSrc}`);
        }
    }
    
    function handleStyleError(link) {
        if (link.dataset._resourceRetried) return;
        
        const originalHref = link.href;
        const retryCount = parseInt(link.dataset._retryCount || '0');
        
        console.warn(`[Resource] Style load failed: ${originalHref} (attempt ${retryCount + 1})`);
        
        if (retryCount < RESOURCE_RETRY_MAX) {
            link.dataset._retryCount = String(retryCount + 1);
            setTimeout(() => {
                link.href = originalHref;
            }, RESOURCE_RETRY_DELAY * (retryCount + 1) + Math.random() * 500);
        } else {
            console.error(`[Resource] Style failed after ${RESOURCE_RETRY_MAX} retries: ${originalHref}`);
            showResourceError(`样式加载失败: ${originalHref}`);
        }
    }
    
    function showResourceError(message) {
        try {
            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 20px;
                background: rgba(239, 68, 68, 0.95);
                color: white;
                border-radius: 8px;
                font-size: 13px;
                z-index: 9999;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                animation: slideIn 0.3s ease-out;
            `;
            toast.textContent = message;
            document.body.appendChild(toast);
            
            setTimeout(() => {
                toast.style.animation = 'slideOut 0.3s ease-out';
                setTimeout(() => toast.remove(), 300);
            }, 5000);
        } catch (e) {
            console.error(`[Resource] Failed to show error toast: ${e.message}`);
        }
    }
    
    console.log('[Resource] Global resource error handler initialized');
})();

/* 滚动条修复 - 平滑滚动与触摸支持 */
(function() {
    const SCROLL_FRICTION = 0.95;
    const MIN_SCROLL_VELOCITY = 0.5;
    
    function initSmoothScroll() {
        const scrollableElements = document.querySelectorAll('.sidebar-nav, .page.active');
        
        scrollableElements.forEach(el => {
            let velocity = 0;
            let animationFrame = null;
            
            el.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY;
                velocity = delta * 1.5;
                applyScroll(el, velocity);
            }, { passive: false });
            
            let touchStartY = 0;
            let touchStartTime = 0;
            let touchStartScrollTop = 0;
            
            el.addEventListener('touchstart', (e) => {
                touchStartY = e.touches[0].clientY;
                touchStartTime = Date.now();
                touchStartScrollTop = el.scrollTop;
                velocity = 0;
                if (animationFrame) {
                    cancelAnimationFrame(animationFrame);
                    animationFrame = null;
                }
            }, { passive: true });
            
            el.addEventListener('touchmove', (e) => {
                const currentY = e.touches[0].clientY;
                const deltaY = touchStartY - currentY;
                el.scrollTop = touchStartScrollTop + deltaY;
            }, { passive: true });
            
            el.addEventListener('touchend', (e) => {
                const touchEndY = e.changedTouches[0].clientY;
                const touchEndTime = Date.now();
                const timeDiff = touchEndTime - touchStartTime;
                const distanceDiff = touchStartY - touchEndY;
                
                if (timeDiff > 0 && timeDiff < 200) {
                    velocity = (distanceDiff / timeDiff) * 30;
                    applyInertiaScroll(el, velocity);
                }
            }, { passive: true });
            
            function applyScroll(el, amount) {
                el.scrollTop += amount;
            }
            
            function applyInertiaScroll(el, initialVelocity) {
                velocity = initialVelocity;
                
                function animate() {
                    if (Math.abs(velocity) < MIN_SCROLL_VELOCITY) {
                        velocity = 0;
                        animationFrame = null;
                        return;
                    }
                    
                    el.scrollTop += velocity;
                    velocity *= SCROLL_FRICTION;
                    animationFrame = requestAnimationFrame(animate);
                }
                
                animate();
            }
        });
    }
    
    document.addEventListener('DOMContentLoaded', () => {
        initSmoothScroll();
        
        const observer = new MutationObserver(() => {
            initSmoothScroll();
        });
        
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();

/* @brix-protected: anti-ai-plagiarism-v1.0 */



















