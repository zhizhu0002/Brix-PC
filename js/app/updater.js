/**
 * updater.js - 更新检查页面
 * ----------------------------------------------------------------------------
 * 职责：检查更新、展示更新日志、下载更新、执行安装
 * API 格式：
 *   GET http://api.2b2t.ren/brix/index.php?action=check_update
 *   返回:
 *     { success: false, message: "连接更新服务器失败" }
 *     { success: true, message: "已是最新版本", has_update: false, current_version: "1.1.0", changelog: "..." }
 *     { success: true, message: "发现新版本", has_update: true, current_version: "1.0.1",
 *       latest_version: "1.1.0", changelog: "...", download_url: "..." }
 */

(function () {
  'use strict';

  let _checkResult = null;
  let _isDownloading = false;
  let dom = {};

  function init() {
    cacheDom();
    if (!dom.container) return;
    bindEvents();
    // 页面显示时自动检查
    const page = dom.container.closest('.page');
    if (page) {
      const observer = new MutationObserver(() => {
        if (page.classList.contains('active')) {
          setVersionDisplay();
        }
      });
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    setVersionDisplay();
  }

  function cacheDom() {
    dom.container = document.getElementById('page-update');
    dom.versionSpan = document.getElementById('update-current-version');
    dom.statusText = document.getElementById('update-status-text');
    dom.changelog = document.getElementById('update-changelog');
    dom.progress = document.getElementById('update-progress');
    dom.progressBar = document.getElementById('update-progress-bar');
    dom.progressText = document.getElementById('update-progress-text');
    dom.checkBtn = document.getElementById('update-check-btn');
    dom.downloadBtn = document.getElementById('update-download-btn');
    dom.retryBtn = document.getElementById('update-retry-btn');
  }

  function bindEvents() {
    dom.checkBtn.addEventListener('click', checkUpdate);
    dom.downloadBtn.addEventListener('click', downloadUpdate);
    dom.retryBtn.addEventListener('click', checkUpdate);
  }

  async function setVersionDisplay() {
    try {
      if (window.electronAPI && window.electronAPI.update) {
        const res = await window.electronAPI.update.getVersion();
        if (res && res.version) {
          dom.versionSpan.textContent = res.version;
        }
      }
    } catch (e) {}
  }

  // ========================================================================
  // 检查更新
  // ========================================================================

  async function checkUpdate() {
    if (_isDownloading) return;

    setCheckingState();
    dom.checkBtn.disabled = true;
    dom.downloadBtn.style.display = 'none';
    dom.retryBtn.style.display = 'none';
    dom.changelog.style.display = 'none';

    try {
      if (!window.electronAPI || !window.electronAPI.update) {
        setErrorState('更新模块不可用');
        dom.checkBtn.disabled = false;
        return;
      }

      const result = await window.electronAPI.update.check();
      _checkResult = result;

      if (!result.success) {
        setErrorState(result.message || '连接更新服务器失败');
        dom.retryBtn.style.display = '';
        dom.checkBtn.disabled = false;
        return;
      }

      if (result.has_update) {
        setUpdateAvailableState(result);
      } else {
        setLatestState(result);
      }
    } catch (e) {
      setErrorState('检查更新失败: ' + e.message);
      dom.retryBtn.style.display = '';
    } finally {
      dom.checkBtn.disabled = false;
    }
  }

  // SVG 图标切换
  const ICONS = ['update-icon-spinner', 'update-icon-check', 'update-icon-download', 'update-icon-error', 'update-icon-idle'];

  function showIcon(id) {
    ICONS.forEach((i) => {
      const el = document.getElementById(i);
      if (el) el.style.display = el.id === id ? '' : 'none';
    });
  }

  function setCheckingState() {
    showIcon('update-icon-spinner');
    dom.statusText.textContent = '正在检查更新...';
    dom.statusText.style.color = 'var(--text-secondary)';
  }

  function setLatestState(result) {
    showIcon('update-icon-check');
    dom.statusText.textContent = result.message || '已是最新版本';
    dom.statusText.style.color = '#22c55e';
    dom.progress.style.display = 'none';

    if (result.changelog) {
      dom.changelog.textContent = result.changelog;
      dom.changelog.style.display = 'block';
    }
  }

  function setUpdateAvailableState(result) {
    showIcon('update-icon-download');
    dom.statusText.textContent = '发现新版本 ' + (result.latest_version || '');
    dom.statusText.style.color = '#f59e0b';
    dom.progress.style.display = 'none';

    let changelogText = '';
    if (result.changelog) {
      changelogText = '更新日志:\n' + result.changelog;
    }
    if (result.latest_version) {
      changelogText = '当前版本: ' + (result.current_version || '未知') +
        '\n最新版本: ' + result.latest_version +
        (changelogText ? '\n\n' + changelogText : '');
    }
    dom.changelog.textContent = changelogText;
    dom.changelog.style.display = 'block';

    dom.downloadBtn.style.display = '';
  }

  function setErrorState(message) {
    showIcon('update-icon-error');
    dom.statusText.textContent = message;
    dom.statusText.style.color = '#ef4444';
    dom.changelog.style.display = 'none';
    dom.progress.style.display = 'none';
  }

  // ========================================================================
  // 下载更新
  // ========================================================================

  async function downloadUpdate() {
    if (_isDownloading) return;
    if (!_checkResult || !_checkResult.download_url) {
      showToast('没有可用的下载地址', 'error');
      return;
    }

    _isDownloading = true;
    dom.downloadBtn.disabled = true;
    dom.checkBtn.disabled = true;

    dom.progress.style.display = 'block';
    dom.progressBar.style.width = '0%';
    dom.progressText.textContent = '正在下载...';
    showIcon('update-icon-spinner');
    dom.statusText.textContent = '正在下载更新...';
    dom.statusText.style.color = 'var(--text-secondary)';

    try {
      // 模拟进度（实际下载由主进程完成，无法获取中间进度）
      const progressInterval = setInterval(() => {
        const current = parseFloat(dom.progressBar.style.width) || 0;
        if (current < 80) {
          dom.progressBar.style.width = (current + Math.random() * 10) + '%';
        }
      }, 500);

      const result = await window.electronAPI.update.downloadAndInstall(_checkResult.download_url);

      clearInterval(progressInterval);

      if (result.success) {
        dom.progressBar.style.width = '100%';
        dom.progressText.textContent = '下载完成，正在启动安装程序...';
        showIcon('update-icon-check');
        dom.statusText.textContent = '安装程序已启动';
        dom.statusText.style.color = '#22c55e';
        dom.downloadBtn.style.display = 'none';
        showToast('更新下载完成，安装程序已启动', 'success');
      } else {
        dom.progress.style.display = 'none';
        setErrorState(result.error || '下载失败');
        dom.retryBtn.style.display = '';
        showToast('下载失败: ' + (result.error || '未知错误'), 'error');
      }
    } catch (e) {
      dom.progress.style.display = 'none';
      setErrorState('下载出错: ' + e.message);
      dom.retryBtn.style.display = '';
      showToast('下载出错: ' + e.message, 'error');
    } finally {
      _isDownloading = false;
      dom.downloadBtn.disabled = false;
      dom.checkBtn.disabled = false;
    }
  }

  // ========================================================================
  // 启动
  // ========================================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
