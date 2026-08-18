/**
 * oauth.js - 蓝天新云 OAuth 登录 + 下拉菜单
 * ----------------------------------------------------------------------------
 * 职责：蓝天新云账户登录/登出、下拉菜单
 */

(function () {
  'use strict';

  const OAUTH_CLIENT_ID = '5270cebebfd9b11fe61c73ff4960e07f';
  const OAUTH_CLIENT_SECRET = '604140516449e56aab55a8e3fedf06ac8c32e077d9bb686e';
  const OAUTH_AUTHORIZE_URL = 'https://hiltyun.com/oauth2/#/?response_type=code&client_id=' + OAUTH_CLIENT_ID + '&redirect_uri=';
  const OAUTH_SCOPE = 'basic';
  const STORE_KEY_ACCOUNT = 'brix_cloud_account';

  // DOM 元素缓存
  let dom = {};

  // OAuth 状态
  let _lastRedirectUri = '';
  let _currentAccount = null;

  /**
   * 初始化
   */
  function init() {
    cacheDom();
    if (!dom.avatar) return;

    restoreSession();
    bindEvents();
  }

  function cacheDom() {
    dom.wrap = document.getElementById('cloud-avatar-wrap') || document.querySelector('.cloud-avatar-wrap');
    dom.avatar = document.getElementById('cloud-avatar');
    dom.avatarInner = dom.avatar && dom.avatar.querySelector('.cloud-avatar-inner');
    dom.dropdown = document.getElementById('cloud-dropdown');
    dom.dropdownName = document.getElementById('cloud-dropdown-name');
    dom.syncItem = document.getElementById('cloud-dropdown-sync');
    dom.logoutItem = document.getElementById('cloud-dropdown-logout');
  }

  function bindEvents() {
    // 头像点击：已登录→显示下拉，未登录→登录流程
    dom.avatar.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_currentAccount && _currentAccount.uid) {
        toggleDropdown();
      } else {
        startLoginFlow();
      }
    });

    // 下拉菜单项
    dom.syncItem.addEventListener('click', () => {
      hideDropdown();
      // 跳转到云同步独立页面
      if (typeof navigateToPage === 'function') {
        navigateToPage('cloudsync');
      }
    });
    dom.logoutItem.addEventListener('click', () => {
      hideDropdown();
      logout();
    });

    // 点击外部关闭下拉
    document.addEventListener('click', (e) => {
      if (dom.dropdown && dom.dropdown.style.display !== 'none' &&
          !dom.dropdown.contains(e.target) && !dom.avatar.contains(e.target)) {
        hideDropdown();
      }
    });

    // OAuth code 回调
    if (window.electronAPI && window.electronAPI.oauth) {
      window.electronAPI.oauth.onCode(handleOAuthCode);
    }
  }

  // ========================================================================
  // 会话管理
  // ========================================================================

  async function restoreSession() {
    try {
      if (!window.electronAPI || !window.electronAPI.store) return;
      const account = await window.electronAPI.store.get(STORE_KEY_ACCOUNT);
      if (account && account.uid && account.qq) {
        _currentAccount = account;
        applyAvatar(account.qq);
        updateDropdownHeader(account.username || '蓝天用户');
      }
    } catch (e) { /* 静默 */ }
  }

  async function getSavedAccount() {
    try {
      if (!window.electronAPI || !window.electronAPI.store) return null;
      return await window.electronAPI.store.get(STORE_KEY_ACCOUNT);
    } catch (e) {
      return null;
    }
  }

  // ========================================================================
  // 下拉菜单
  // ========================================================================

  function toggleDropdown() {
    if (!dom.dropdown) return;
    const isVisible = dom.dropdown.style.display !== 'none';
    if (isVisible) {
      hideDropdown();
    } else {
      // 根据头像位置动态定位
      const rect = dom.avatar.getBoundingClientRect();
      dom.dropdown.style.top = (rect.bottom + 6) + 'px';
      dom.dropdown.style.right = (window.innerWidth - rect.right) + 'px';
      dom.dropdown.style.display = 'block';
    }
  }

  function hideDropdown() {
    if (dom.dropdown) dom.dropdown.style.display = 'none';
  }

  function updateDropdownHeader(name) {
    if (dom.dropdownName) dom.dropdownName.textContent = name || '蓝天用户';
  }

  // ========================================================================
  // 登录流程
  // ========================================================================

  async function startLoginFlow() {
    const confirmed = await showConfirmDialog(
      '蓝天新云账户',
      '使用蓝天新云账户登录',
      '确定',
      '取消'
    );
    if (!confirmed) return;

    try {
      showToast('正在启动登录...', 'info');

      const result = await window.electronAPI.oauth.start();
      if (result.error) {
        showToast('登录启动失败: ' + result.error, 'error');
        return;
      }

      const redirectUri = 'http://127.0.0.1:' + result.port + '/callback';
      _lastRedirectUri = redirectUri;
      const oauthUrl = OAUTH_AUTHORIZE_URL + encodeURIComponent(redirectUri) + '&scope=' + OAUTH_SCOPE;
      await window.electronAPI.openExternal(oauthUrl);
      showToast('请在浏览器中完成登录', 'info');
    } catch (e) {
      console.error('[OAuth] Start flow error:', e);
      showToast('登录失败: ' + e.message, 'error');
      try { await window.electronAPI.oauth.cancel(); } catch (_) {}
    }
  }

  async function handleOAuthCode(code) {
    if (!code) return;

    try {
      showToast('正在获取令牌...', 'info');

      const tokenData = await exchangeToken(code);
      if (!tokenData || !tokenData.access_token) {
        showToast('令牌获取失败', 'error');
        return;
      }

      showToast('正在获取用户信息...', 'info');

      const userData = await getUserInfo(tokenData.access_token);
      if (!userData || !userData.status || !userData.user) {
        showToast('用户信息获取失败', 'error');
        return;
      }

      const account = {
        uid: userData.user.uid,
        username: userData.user.username,
        qq: userData.user.qq,
        phone: userData.user.phone,
        email: userData.user.email,
        realname: userData.realname || null,
        loginTime: Date.now()
      };

      _currentAccount = account;
      if (window.electronAPI && window.electronAPI.store) {
        await window.electronAPI.store.set(STORE_KEY_ACCOUNT, account);
      }

      if (userData.user.qq) applyAvatar(userData.user.qq);
      updateDropdownHeader(userData.user.username || '蓝天用户');
      showToast('登录成功: ' + (userData.user.username || ''), 'success');
    } catch (e) {
      console.error('[OAuth] Code handler error:', e);
      showToast('登录处理失败: ' + e.message, 'error');
    }
  }

  async function exchangeToken(code) {
    const params = {
      grant_type: 'authorization_code',
      code: code,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    };
    if (_lastRedirectUri) params.redirect_uri = _lastRedirectUri;
    const result = await window.electronAPI.oauth.exchangeToken(params);
    if (result.error) throw new Error(result.error);
    return result;
  }

  async function getUserInfo(accessToken) {
    const result = await window.electronAPI.oauth.getUserInfo(accessToken);
    if (result.error) throw new Error(result.error);
    return result;
  }

  // ========================================================================
  // 登出
  // ========================================================================

  async function logout() {
    const confirmed = await showConfirmDialog(
      '蓝天新云账户',
      '是否退出当前蓝天新云账户？',
      '退出登录',
      '取消'
    );
    if (!confirmed) return;

    try {
      if (window.electronAPI && window.electronAPI.store) {
        await window.electronAPI.store.delete(STORE_KEY_ACCOUNT);
      }
      _currentAccount = null;
      resetAvatar();
      showToast('已退出登录', 'info');
    } catch (e) {
      console.error('[OAuth] Logout error:', e);
    }
  }

  // ========================================================================
  // 头像
  // ========================================================================

  function applyAvatar(qq) {
    if (!dom.avatar || !dom.avatarInner) return;
    dom.avatarInner.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'cloud-avatar-img';
    img.src = 'https://q2.qlogo.cn/headimg_dl?dst_uin=' + qq + '&spec=100';
    img.alt = '';
    img.onerror = resetAvatar;
    dom.avatarInner.appendChild(img);
    dom.avatar.classList.add('logged-in');
    dom.avatar.title = '';
  }

  function resetAvatar() {
    if (!dom.avatar || !dom.avatarInner) return;
    dom.avatarInner.innerHTML =
      '<svg class="cloud-avatar-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">' +
        '<line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/>' +
      '</svg>';
    dom.avatar.classList.remove('logged-in');
    dom.avatar.title = '点击登录蓝天新云账户';
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
