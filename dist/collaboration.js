(() => {
  const keys = ['shiguang-diary-v1', 'shiguang-ai-conversations-v1', 'shiguang-structured-notes-v1'];
  const allowed = new Set(keys);
  const baseUrl = String(window.SHIGUANG_API_BASE || '').replace(/\/$/, '');
  const api = (path, options = {}) => fetch(`${baseUrl}${path}`, { credentials: 'same-origin', ...options });
  const nativeSet = Storage.prototype.setItem;
  const nativeGet = Storage.prototype.getItem;
  let currentUser = null;
  let baseValues = {};
  let pending = {};
  let retryDelays = {};
  let connected = false;
  let syncRevision = 0;
  let authStatus = { registrationOpen: false, remainingAccounts: 0 };
  let activity = [];

  function setRaw(key, value) { nativeSet.call(localStorage, key, value); }
  function emitValue(key, value, actor) {
    window.dispatchEvent(new CustomEvent('shiguang:remote-state', { detail: { key, value, actor } }));
  }
  function authMessage(message, error = false) {
    const el = document.getElementById('authMessage');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', error);
  }
  function setLiveStatus(message, live = false) {
    const el = document.getElementById('collabStatus');
    if (!el) return;
    el.textContent = message;
    el.dataset.live = live ? 'true' : 'false';
    const dot = document.getElementById('collabDot');
    if (dot) dot.dataset.live = live ? 'true' : 'false';
  }
  function renderActivity() {
    const list = document.getElementById('collabActivity');
    if (!list) return;
    const recent = activity.slice(-4).reverse();
    list.innerHTML = recent.length
      ? recent.map(item => `<span class="activity-item"><b>${window.escapeHtml(item.userName || '用户')}</b> ${window.escapeHtml(item.label || '更新了共享记录')} <small>${new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></span>`).join('')
      : '<span class="activity-empty">暂时还没有共享操作记录</span>';
  }
  function addActivity(item) {
    if (!item?.id || activity.some(entry => entry.id === item.id)) return;
    activity = [...activity, item].slice(-40);
    renderActivity();
  }
  function showAuthenticated(user) {
    currentUser = user;
    window.collabUser = user;
    document.documentElement.classList.remove('auth-pending');
    const bar = document.getElementById('collabBar');
    if (bar) bar.hidden = false;
    const name = document.getElementById('collabUserName');
    if (name) name.textContent = user.name;
    setLiveStatus('正在连接共享空间…');
  }
  function showAuthScreen(mode = 'login') {
    const wall = document.getElementById('authWall');
    if (!wall) return;
    wall.hidden = false;
    document.documentElement.classList.add('auth-pending');
    const registering = mode === 'register';
    document.getElementById('authHeading').textContent = registering ? '加入共享空间' : '欢迎回来';
    document.getElementById('authSubtitle').textContent = registering ? '创建你的个人身份，两位成员共享同一份日常与学习记录。' : '登录后继续查看共享的日常、对话和学习笔记。';
    document.getElementById('authSubmit').textContent = registering ? '创建账号并进入' : '登录共享空间';
    document.getElementById('inviteField').hidden = !registering;
    document.getElementById('authName').autocomplete = registering ? 'nickname' : 'username';
    document.getElementById('authPassword').autocomplete = registering ? 'new-password' : 'current-password';
    document.getElementById('authToggle').hidden = !authStatus.registrationOpen;
    document.getElementById('authToggle').textContent = registering ? '已有账号？去登录' : '首次使用？创建账号';
    document.getElementById('authMode').value = mode;
    if (registering && authStatus.remainingAccounts < 2) document.getElementById('authName').value = authStatus.remainingAccounts === 1 ? '听听' : '呼呼';
  }
  async function jsonRequest(path, method = 'GET', body) {
    const response = await api(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '暂时无法连接，请稍后再试。');
    return payload;
  }
  async function sendValue(key, base, value) {
    const result = await jsonRequest('/api/sync/update', 'POST', { key, base, value });
    baseValues[key] = result.value;
    syncRevision = Math.max(syncRevision, result.revision || 0);
    if (nativeGet.call(localStorage, key) === value && result.value !== value) {
      setRaw(key, result.value);
      emitValue(key, result.value, result.actor);
    }
    if (result.activity) addActivity(result.activity);
    return result;
  }
  function queueValue(key) {
    if (!connected || !allowed.has(key)) return;
    const task = Promise.resolve(pending[key]).catch(() => {}).then(async () => {
      const value = nativeGet.call(localStorage, key);
      if (value == null || value === baseValues[key]) return;
      setLiveStatus('同步中…');
      try {
        await sendValue(key, baseValues[key] ?? null, value);
        retryDelays[key] = 0;
        setLiveStatus('已实时同步', true);
      } catch (error) {
        setLiveStatus('网络暂时中断，记录仍保存在本机');
        console.warn('Shared sync paused:', error.message);
        retryDelays[key] = Math.min((retryDelays[key] || 1500) * 2, 60_000);
        setTimeout(() => queueValue(key), retryDelays[key]);
      }
    }).finally(() => { if (pending[key] === task) delete pending[key]; });
    pending[key] = task;
  }
  Storage.prototype.setItem = function(key, value) {
    nativeSet.call(this, key, value);
    if (this === localStorage) queueValue(String(key));
  };

  async function loadSharedState() {
    const snapshot = await jsonRequest('/api/sync/state');
    activity = snapshot.activity || [];
    renderActivity();
    for (const key of keys) {
      const local = nativeGet.call(localStorage, key);
      const remote = snapshot.values?.[key];
      if (typeof remote === 'string') {
        baseValues[key] = remote;
        if (remote !== local) {
          setRaw(key, remote);
          emitValue(key, remote, null);
        }
      } else if (local != null) {
        const result = await sendValue(key, null, local);
        baseValues[key] = result.value;
        if (result.value !== local) {
          setRaw(key, result.value);
          emitValue(key, result.value, result.actor);
        }
      } else baseValues[key] = null;
    }
    const refreshed = await jsonRequest('/api/sync/state');
    syncRevision = refreshed.revision || 0;
    activity = refreshed.activity || activity;
    renderActivity();
    for (const key of keys) {
      const remote = refreshed.values?.[key];
      if (typeof remote === 'string' && remote !== nativeGet.call(localStorage, key)) {
        baseValues[key] = remote;
        setRaw(key, remote);
        emitValue(key, remote, null);
      }
    }
    showAuthenticated(snapshot.user);
    connected = true;
    setLiveStatus('已实时连接', true);
    window.dispatchEvent(new CustomEvent('shiguang:collab-ready', { detail: { user: snapshot.user, activity } }));
    startEvents();
  }
  function applyEvent(event) {
    if (!event || !allowed.has(event.key) || typeof event.value !== 'string') return;
    const value = event.value;
    baseValues[event.key] = value;
    if (pending[event.key]) {
      queueValue(event.key);
      if (event.activity) addActivity(event.activity);
      setLiveStatus('已实时连接', true);
      return;
    }
    if (nativeGet.call(localStorage, event.key) !== value) {
      setRaw(event.key, value);
      emitValue(event.key, value, event.actor);
      if (event.actor?.id !== currentUser?.id) {
        const msg = document.getElementById('toast');
        if (msg && event.activity) {
          msg.textContent = `${event.activity.userName} 更新了${event.activity.label}`;
          msg.classList.add('show');
          setTimeout(() => msg.classList.remove('show'), 2600);
        }
      }
    }
    if (event.activity) addActivity(event.activity);
    setLiveStatus('已实时连接', true);
  }
  function startEvents() {
    const events = new EventSource(`${baseUrl}/api/sync/events`, { withCredentials: true });
    events.addEventListener('hello', event => {
      const data = JSON.parse(event.data || '{}');
      if (data.activity) { activity = data.activity; renderActivity(); }
      if ((data.revision || 0) > syncRevision) reconcileSharedState();
      setLiveStatus('已实时连接', true);
    });
    events.addEventListener('update', event => {
      try { applyEvent(JSON.parse(event.data)); } catch { /* Ignore malformed event frames. */ }
    });
    events.onopen = () => setLiveStatus('已实时连接', true);
    events.onerror = async () => {
      setLiveStatus('实时连接中断，正在重连');
      try {
        const response = await api('/api/auth/me');
        if (response.status === 401) {
          events.close();
          connected = false;
          showAuthScreen('login');
          authMessage('登录已过期，请重新登录。', true);
        }
      } catch { /* EventSource reconnects automatically after temporary network errors. */ }
    };
  }
  async function reconcileSharedState() {
    try {
      const snapshot = await jsonRequest('/api/sync/state');
      activity = snapshot.activity || activity;
      renderActivity();
      for (const key of keys) {
        const remote = snapshot.values?.[key];
        if (typeof remote !== 'string') continue;
        baseValues[key] = remote;
        if (pending[key]) { queueValue(key); continue; }
        if (remote !== nativeGet.call(localStorage, key)) {
          setRaw(key, remote);
          emitValue(key, remote, null);
        }
      }
      syncRevision = snapshot.revision || syncRevision;
    } catch { setLiveStatus('同步恢复中…'); }
  }
  async function refreshAuthStatus() {
    try { authStatus = await jsonRequest('/api/auth/status'); }
    catch { authStatus = { registrationOpen: false, remainingAccounts: 0 }; }
    const help = document.getElementById('authHelp');
    if (help) help.textContent = authStatus.registrationOpen
      ? `共享空间还可注册 ${authStatus.remainingAccounts} 位成员。注册需要管理员提供的邀请码。`
      : '共享空间暂未开放注册；请管理员确认服务端已配置邀请码。';
  }
  async function boot() {
    const wall = document.getElementById('authWall');
    if (!wall || location.protocol === 'file:') return;
    try {
      await refreshAuthStatus();
      const result = await jsonRequest('/api/auth/me');
      await loadSharedState();
      wall.hidden = true;
      document.dispatchEvent(new CustomEvent('shiguang:collab-ready'));
    } catch {
      showAuthScreen('login');
      authMessage('无法连接共享服务器，请检查网络或稍后重试。', true);
    }
  }

  document.getElementById('authToggle')?.addEventListener('click', () => {
    const mode = document.getElementById('authMode').value;
    showAuthScreen(mode === 'login' ? 'register' : 'login');
    authMessage('');
  });
  document.getElementById('authForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const mode = document.getElementById('authMode').value;
    const button = document.getElementById('authSubmit');
    button.disabled = true;
    authMessage(mode === 'register' ? '正在创建账号…' : '正在登录…');
    try {
      const body = { name: form.elements.name.value.trim(), password: form.elements.password.value };
      if (mode === 'register') body.inviteCode = form.elements.inviteCode.value.trim();
      await jsonRequest(`/api/auth/${mode}`, 'POST', body);
      await loadSharedState();
      document.getElementById('authWall').hidden = true;
      form.reset();
      if (window.refreshApiStatus) window.refreshApiStatus();
    } catch (error) { authMessage(error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('collabLogout')?.addEventListener('click', async () => {
    await jsonRequest('/api/auth/logout', 'POST', {});
    location.reload();
  });

  window.addEventListener('shiguang:remote-state', event => {
    if (event.detail?.key === 'shiguang-ai-conversations-v1' && window.refreshApiStatus) window.refreshApiStatus();
  });
  window.addEventListener('online', () => keys.forEach(queueValue));
  window.escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  window.collabState = () => ({ user: currentUser, connected, activity: activity.slice() });
  boot();
})();
