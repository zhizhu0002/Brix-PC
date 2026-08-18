/**
 * cloudsync.js - 云同步独立页面
 * ----------------------------------------------------------------------------
 * 职责：云端备份/恢复 Minecraft 账户
 *   - 上传备份：选择要备份的本地账户 → 打包 → 上传到云端
 *   - 恢复备份：选择要恢复的备份 → 选择要导入的账户 → 导入到本地
 *   - 删除备份：删除云端备份
 */

(function () {
  'use strict';

  const STORE_KEY_ACCOUNT = 'brix_cloud_account';

  let _currentAccount = null;
  let dom = {};

  function init() {
    cacheDom();
    if (!dom.container) return;
    bindEvents();
    const page = dom.container.closest('.page');
    if (page) {
      const observer = new MutationObserver(() => {
        if (page.classList.contains('active')) refreshView();
      });
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    refreshView();
  }

  function cacheDom() {
    dom.container = document.getElementById('page-cloudsync');
    dom.loginPrompt = document.getElementById('cloudsync-login-prompt');
    dom.loginBtn = document.getElementById('cloudsync-login-btn');
    dom.content = document.getElementById('cloudsync-content');
    dom.username = document.getElementById('cloudsync-username');
    dom.refreshBtn = document.getElementById('cloudsync-refresh-btn');
    dom.uploadBtn = document.getElementById('cloudsync-upload-btn');
    dom.loading = document.getElementById('cloudsync-loading');
    dom.empty = document.getElementById('cloudsync-empty');
    dom.storageInfo = document.getElementById('cloudsync-storage-info');
    dom.list = document.getElementById('cloudsync-list');
  }

  function bindEvents() {
    dom.loginBtn.addEventListener('click', () => {
      navigateToPage('home');
      const avatar = document.getElementById('cloud-avatar');
      if (avatar) avatar.click();
    });
    dom.refreshBtn.addEventListener('click', loadBackups);
    dom.uploadBtn.addEventListener('click', onUploadClick);
  }

  async function refreshView() {
    _currentAccount = await getAccount();
    if (_currentAccount && _currentAccount.uid) {
      dom.loginPrompt.style.display = 'none';
      dom.content.style.display = 'block';
      dom.username.textContent = _currentAccount.username || '蓝天用户';
      loadBackups();
    } else {
      dom.loginPrompt.style.display = 'block';
      dom.content.style.display = 'none';
    }
  }

  async function getAccount() {
    try {
      if (!window.electronAPI || !window.electronAPI.store) return null;
      return await window.electronAPI.store.get(STORE_KEY_ACCOUNT);
    } catch (e) {
      return null;
    }
  }

  // ========================================================================
  // 上传备份 — 选择本地账户 → 打包 → 上传到云端
  // ========================================================================

  async function onUploadClick() {
    if (!_currentAccount || !_currentAccount.uid) return;

    try {
      const accountsRes = await window.fetch('/api/accounts');
      if (!accountsRes.ok) throw new Error('获取本地账号失败');
      const accounts = await accountsRes.json();

      if (!accounts || accounts.length === 0) {
        showToast('本地没有账号可备份', 'warn');
        return;
      }

      // 让用户选择要备份的账户
      const selected = await showAccountSelector({
        title: '选择要备份的账号',
        accounts: accounts.map(a => ({
          id: a.id,
          label: a.username + ' (' + typeLabel(a.type) + ')',
          sublabel: a.uuid || '',
          checked: true
        })),
        confirmText: '确认上传',
        emptyText: '请至少勾选一个账号'
      });

      if (!selected || selected.length === 0) {
        showToast('已取消', 'info');
        return;
      }

      // 根据用户选择筛选账户数据（去掉敏感令牌）
      const selectedIds = new Set(selected.map(s => s.id));
      const backupData = accounts
        .filter(a => selectedIds.has(a.id))
        .map(acc => ({
          username: acc.username,
          uuid: acc.uuid,
          type: acc.type,
          serverUrl: acc.serverUrl || '',
          skinModel: acc.skinModel || 'default',
          createdAt: acc.createdAt || new Date().toISOString()
        }));

      const jsonStr = JSON.stringify({
        type: 'brix_accounts_backup',
        version: 1,
        timestamp: new Date().toISOString(),
        accounts: backupData
      }, null, 2);

      const base64Data = btoa(unescape(encodeURIComponent(jsonStr)));
      const fileName = 'brix_accounts_backup_' + Date.now() + '.json';

      showToast('正在上传备份...', 'info');
      dom.uploadBtn.disabled = true;

      const result = await window.electronAPI.cloud.uploadBackup({
        uid: _currentAccount.uid,
        _multipart: true,
        _fileData: base64Data,
        _fileName: fileName,
        _fileField: 'file'
      });

      if (result.success) {
        showToast('备份上传成功（已备份 ' + backupData.length + ' 个账号）', 'success');
        loadBackups();
      } else {
        showToast('上传失败: ' + (result.message || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('备份失败: ' + e.message, 'error');
    } finally {
      dom.uploadBtn.disabled = false;
    }
  }

  // ========================================================================
  // 备份列表
  // ========================================================================

  async function loadBackups() {
    if (!_currentAccount || !_currentAccount.uid) return;

    dom.list.innerHTML = '';
    dom.empty.style.display = 'none';
    dom.storageInfo.textContent = '';
    dom.loading.style.display = 'block';

    try {
      const result = await window.electronAPI.cloud.listBackups(_currentAccount.uid);
      dom.loading.style.display = 'none';

      if (!result.success) {
        showToast('获取备份列表失败: ' + (result.message || '未知错误'), 'error');
        return;
      }

      const items = result.data || [];
      if (items.length === 0) {
        dom.empty.style.display = 'block';
        return;
      }

      dom.list.innerHTML = items.map(renderItem).join('');
      dom.storageInfo.textContent = '已用 ' + formatSize(result.total_size || 0) + ' / 共 ' + formatSize(result.max_size || 10485760);

      items.forEach((item) => {
        const fid = item.file_id;
        const restoreBtn = document.getElementById('cs-restore-' + fid);
        const deleteBtn = document.getElementById('cs-delete-' + fid);
        if (restoreBtn) restoreBtn.addEventListener('click', () => restoreBackup(item));
        if (deleteBtn) deleteBtn.addEventListener('click', () => deleteBackup(item));
      });
    } catch (e) {
      dom.loading.style.display = 'none';
      showToast('加载失败: ' + e.message, 'error');
    }
  }

  function renderItem(item) {
    const fid = item.file_id;
    const name = item.filename || '未知文件';
    const size = formatSize(item.size || 0);
    const time = item.upload_time || '';
    return '<div class="cloudsync-item">' +
      '<div class="cloudsync-item-info">' +
        '<span class="cloudsync-item-name">' + escapeHtml(name) + '</span>' +
        '<span class="cloudsync-item-meta">' + size + (time ? ' · ' + time : '') + '</span>' +
      '</div>' +
      '<div class="cloudsync-item-actions">' +
        '<button class="btn btn-ghost btn-sm" id="cs-restore-' + fid + '">恢复</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:#ef4444" id="cs-delete-' + fid + '">删除</button>' +
      '</div>' +
    '</div>';
  }

  // ========================================================================
  // 恢复备份 — 从云端下载 → 选择要导入的账户 → 导入本地
  // ========================================================================

  async function restoreBackup(item) {
    const name = item.filename || '';

    try {
      showToast('正在下载备份...', 'info');

      const result = await window.electronAPI.cloud.downloadBackup({
        uid: _currentAccount.uid,
        file_id: item.file_id
      });

      if (!result || result.success === false) {
        showToast('下载失败: ' + ((result && result.message) || '未知错误'), 'error');
        return;
      }

      if (!result._raw || !result.data) {
        showToast('下载失败: 未获取到文件数据', 'error');
        return;
      }

      let backupJson;
      try {
        const rawStr = atob(result.data);
        backupJson = JSON.parse(rawStr);
      } catch (e) {
        showToast('备份文件格式错误，无法解析', 'error');
        return;
      }

      if (!backupJson.accounts || !Array.isArray(backupJson.accounts) || backupJson.accounts.length === 0) {
        showToast('备份中没有账号数据', 'warn');
        return;
      }

      // 让用户选择要导入的账户
      const selected = await showAccountSelector({
        title: '选择要恢复的账号',
        subtitle: '备份: ' + name,
        accounts: backupJson.accounts.map(a => ({
          id: a.uuid + '_' + a.type,
          label: a.username + ' (' + typeLabel(a.type) + ')',
          sublabel: a.uuid || '',
          checked: true
        })),
        confirmText: '确认导入',
        emptyText: '请至少勾选一个账号'
      });

      if (!selected || selected.length === 0) {
        showToast('已取消', 'info');
        return;
      }

      // 筛选用户勾选的账户
      const selectedKeys = new Set(selected.map(s => s.id));
      const importAccounts = backupJson.accounts.filter(a =>
        selectedKeys.has(a.uuid + '_' + a.type)
      );

      if (importAccounts.length === 0) {
        showToast('请至少勾选一个账号', 'warn');
        return;
      }

      const importRes = await window.fetch('/api/accounts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: importAccounts })
      });
      const importResult = await importRes.json();

      if (importResult.success) {
        showToast('恢复成功，已导入 ' + importResult.count + ' 个账号', 'success');
        if (typeof loadAccounts === 'function') loadAccounts();
      } else {
        showToast('恢复失败: ' + (importResult.error || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('恢复出错: ' + e.message, 'error');
    }
  }

  // ========================================================================
  // 删除备份
  // ========================================================================

  async function deleteBackup(item) {
    const confirmed = await showConfirmDialog(
      '删除备份',
      '确定要删除 "' + (item.filename || '') + '" 吗？',
      '确定删除',
      '取消'
    );
    if (!confirmed) return;

    try {
      const result = await window.electronAPI.cloud.deleteBackup({
        uid: _currentAccount.uid,
        file_id: item.file_id
      });
      if (result.success) {
        showToast('删除成功', 'success');
        loadBackups();
      } else {
        showToast('删除失败: ' + (result.message || '未知错误'), 'error');
      }
    } catch (e) {
      showToast('删除出错: ' + e.message, 'error');
    }
  }

  // ========================================================================
  // 账户选择对话框
  // ========================================================================

  /**
   * 弹出一个可选择账户的对话框
   * @param {Object} opts
   * @param {string} opts.title - 对话框标题
   * @param {string} [opts.subtitle] - 副标题
   * @param {Array} opts.accounts - 账户列表 [{ id, label, sublabel, checked }]
   * @param {string} opts.confirmText - 确认按钮文字
   * @param {string} [opts.emptyText] - 未选择时提示
   * @returns {Promise<Array|null>} 选中的账户列表（id 数组），取消返回 null
   */
  function showAccountSelector(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      const itemsHtml = opts.accounts.map((a, i) => {
        const id = 'cs-sel-' + i;
        return '<label for="' + id + '" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,rgba(255,255,255,0.06));cursor:pointer">' +
          '<input type="checkbox" id="' + id + '" data-idx="' + i + '" ' + (a.checked ? 'checked' : '') +
          ' style="width:16px;height:16px;accent-color:var(--accent,#5b9aff);flex-shrink:0">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:500;color:var(--text-primary,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(a.label) + '</div>' +
            (a.sublabel ? '<div style="font-size:11px;color:var(--text-muted,#888);margin-top:1px">' + escapeHtml(a.sublabel) + '</div>' : '') +
          '</div>' +
        '</label>';
      }).join('');

      overlay.innerHTML =
        '<div class="modal-content" style="width:480px;min-height:auto;max-height:80vh;display:flex;flex-direction:column">' +
          '<div class="modal-header">' +
            '<h3>' + escapeHtml(opts.title || '选择账号') + '</h3>' +
            '<button class="modal-close cs-selector-cancel" aria-label="关闭">&times;</button>' +
          '</div>' +
          '<div class="modal-body" style="overflow-y:auto;flex:1;padding:4px 20px 12px">' +
            (opts.subtitle ? '<p style="font-size:12px;color:var(--text-muted,#888);margin:0 0 8px">' + escapeHtml(opts.subtitle) + '</p>' : '') +
            '<div style="margin-bottom:8px">' +
              '<label style="font-size:12px;color:var(--text-muted,#888);cursor:pointer;display:flex;align-items:center;gap:6px">' +
                '<input type="checkbox" id="cs-selector-toggle-all" style="accent-color:var(--accent,#5b9aff)"> 全选/取消全选' +
              '</label>' +
            '</div>' +
            '<div id="cs-selector-list">' + itemsHtml + '</div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="modal-btn modal-btn--secondary cs-selector-cancel">取消</button>' +
            '<button class="modal-btn modal-btn--primary" id="cs-selector-confirm">' + escapeHtml(opts.confirmText || '确认') + '</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('modal-visible'));

      // 全选/取消全选
      const toggleAll = overlay.querySelector('#cs-selector-toggle-all');
      const checkboxes = overlay.querySelectorAll('#cs-selector-list input[type="checkbox"]');
      toggleAll.addEventListener('change', () => {
        checkboxes.forEach(cb => cb.checked = toggleAll.checked);
      });

      // 单个勾选变化时更新全选状态
      checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
          const all = Array.from(checkboxes).every(c => c.checked);
          const none = Array.from(checkboxes).every(c => !c.checked);
          toggleAll.checked = all;
          toggleAll.indeterminate = !all && !none;
        });
      });

      // 更新 indeterminate 初始状态
      const allChecked = Array.from(checkboxes).every(c => c.checked);
      toggleAll.checked = allChecked;
      toggleAll.indeterminate = !allChecked && Array.from(checkboxes).some(c => c.checked);

      function close(result) {
        overlay.classList.remove('modal-visible');
        setTimeout(() => overlay.remove(), 200);
        resolve(result);
      }

      overlay.querySelectorAll('.cs-selector-cancel').forEach(el => {
        el.addEventListener('click', () => close(null));
      });

      overlay.querySelector('#cs-selector-confirm').addEventListener('click', () => {
        const selected = [];
        checkboxes.forEach((cb, i) => {
          if (cb.checked && opts.accounts[i]) {
            selected.push(opts.accounts[i]);
          }
        });
        if (selected.length === 0) {
          showToast(opts.emptyText || '请至少选择一个账号', 'warn');
          return;
        }
        close(selected);
      });

      // 点击遮罩层取消
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
    });
  }

  // ========================================================================
  // 工具
  // ========================================================================

  function typeLabel(type) {
    const map = { microsoft: '正版', thirdparty: '外置登录', offline: '离线' };
    return map[type] || type || '未知';
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
