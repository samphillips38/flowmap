// Account sign-in and cloud run history API client.

const Auth = (function () {
  let user = null;
  let authMode = 'login';

  async function apiFetch(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // Non-JSON error bodies are ignored.
    }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function isLoggedIn() {
    return !!user;
  }

  function renderAuthState() {
    const signedOut = document.getElementById('auth-signed-out');
    const signedIn = document.getElementById('auth-signed-in');
    const emailEl = document.getElementById('auth-user-email');
    const syncHint = document.getElementById('history-sync-hint');
    if (!signedOut || !signedIn) return;

    if (user) {
      signedOut.classList.add('hidden');
      signedIn.classList.remove('hidden');
      syncHint?.classList.add('hidden');
      if (emailEl) emailEl.textContent = user.email;
    } else {
      signedIn.classList.add('hidden');
      signedOut.classList.remove('hidden');
      syncHint?.classList.remove('hidden');
      if (emailEl) emailEl.textContent = '';
    }
  }

  function setAuthError(message) {
    const el = document.getElementById('auth-error');
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    const loginTab = document.getElementById('auth-tab-login');
    const registerTab = document.getElementById('auth-tab-register');
    const submitBtn = document.getElementById('auth-submit-btn');
    const passwordInput = document.getElementById('auth-password');
    if (loginTab) loginTab.classList.toggle('active', authMode === 'login');
    if (registerTab) registerTab.classList.toggle('active', authMode === 'register');
    if (submitBtn) {
      submitBtn.dataset.mode = authMode;
      submitBtn.textContent = authMode === 'register' ? 'Create account' : 'Sign in';
    }
    if (passwordInput) {
      passwordInput.autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    }
    setAuthError('');
  }

  function openModal() {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    setAuthMode(authMode);
    document.getElementById('auth-email')?.focus();
  }

  function closeModal() {
    document.getElementById('auth-modal')?.classList.add('hidden');
    setAuthError('');
  }

  async function notifyAuthReady() {
    if (typeof window.onAuthReady === 'function') {
      await window.onAuthReady();
    }
  }

  async function refreshSession() {
    try {
      const data = await apiFetch('/api/me');
      user = data.user || null;
    } catch {
      user = null;
    }
    renderAuthState();
  }

  function setupUi() {
    document.getElementById('auth-open-btn')?.addEventListener('click', openModal);
    document.getElementById('auth-signout-btn')?.addEventListener('click', async () => {
      try {
        await apiFetch('/api/logout', { method: 'POST' });
      } catch {
        // Clear local state even if the request fails.
      }
      user = null;
      renderAuthState();
      closeModal();
      await notifyAuthReady();
    });

    document.getElementById('auth-tab-login')?.addEventListener('click', () => setAuthMode('login'));
    document.getElementById('auth-tab-register')?.addEventListener('click', () => setAuthMode('register'));
    document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('auth-modal-backdrop')?.addEventListener('click', closeModal);

    document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-email')?.value?.trim();
      const password = document.getElementById('auth-password')?.value;
      const submitBtn = document.getElementById('auth-submit-btn');
      if (!email || !password) return;

      setAuthError('');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const path = authMode === 'register' ? '/api/register' : '/api/login';
        const data = await apiFetch(path, {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        user = data.user;
        renderAuthState();
        closeModal();
        await notifyAuthReady();
      } catch (err) {
        setAuthError(err.message);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  async function init() {
    setupUi();
    setAuthMode('login');
    await refreshSession();
  }

  async function saveCloudRun(run) {
    await apiFetch('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ run }),
    });
  }

  async function fetchCloudRuns() {
    const data = await apiFetch('/api/runs');
    return Array.isArray(data.runs) ? data.runs : [];
  }

  async function syncLocalRunsToCloud(localRuns) {
    const data = await apiFetch('/api/runs/sync', {
      method: 'POST',
      body: JSON.stringify({ runs: localRuns }),
    });
    return Array.isArray(data.runs) ? data.runs : [];
  }

  async function deleteCloudRun(id) {
    await apiFetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  return {
    init,
    isLoggedIn,
    saveCloudRun,
    fetchCloudRuns,
    syncLocalRunsToCloud,
    deleteCloudRun,
  };
})();
