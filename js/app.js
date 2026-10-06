const state = { user: null, tasks: [], myTasks: [], savedTasks: [], savedTaskIds: new Set(), activeTask: null, taskDetailReturn: null, publicProfileReturn: null, publicProfileTasks: [], conversationReturnPage: 'marketplace-page', conversationTimer: null, conversationMessages: [], conversationLastFullSync: 0, conversationFetchInFlight: false, pendingMessages: [], sendingMessage: false, notificationTimer: null, taskRefreshTimer: null, logoutTrigger: null, authPromptOpen: false, authReturnIntent: null, authPromptTrigger: null, preserveAuthIntent: false, glassOpacity: 0, themeUsesSystem: true, filters: { status: '', category: '', search: '' } };
let mfaLoginChallenge = '';
let mfaEnrollmentPromise = null;
let myBidsData = [];
let notificationCenterItems = [];
const seenTaskUpdateToasts = new Set();
const seenMessageToasts = new Set();
let pendingNativePushOpen = null;
let taskFetchSequence = 0;
let taskFetchInFlight = false;
let taskListLoaded = false;
const pendingSavedTaskIds = new Set();
const AUTH_SYNC_KEY = 'taskerph-auth-sync';
const AUTH_TOKEN_KEY = 'taskerph-supabase-access-token';
const AUTH_REFRESH_TOKEN_KEY = 'taskerph-supabase-refresh-token';
const AUTH_ACTIVITY_KEY = 'taskerph-last-active-at';
const AUTH_INACTIVITY_LIMIT = 30 * 24 * 60 * 60 * 1000;
let authRefreshPromise = null;
const INSTALL_GUIDE_DISMISSED_KEY = 'taskerph-install-guide-dismissed';
const INSTALL_GUIDE_INSTALLED_KEY = 'taskerph-installed';
let deferredInstallPrompt = null;
let accountActivityTimer = null;
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
const $ = (selector) => document.querySelector(selector);
function broadcastAuthChange() {
  try { localStorage.setItem(AUTH_SYNC_KEY, String(Date.now())); } catch (error) { void error; }
}
function enhancePasswordInputs(root = document) {
  const inputs = [];
  if (root instanceof Element && root.matches('input[type="password"]')) inputs.push(root);
  if (root.querySelectorAll) inputs.push(...root.querySelectorAll('input[type="password"]'));

  inputs.forEach((input) => {
    if (input.closest('.password-field-wrap')) return;

    const wrapper = document.createElement('span');
    wrapper.className = 'password-field-wrap';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.classList.remove('mt-2');
    input.classList.add('password-field-input');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-visibility-toggle';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('title', 'Show password');
    toggle.innerHTML = '<i class="fa-solid fa-eye" aria-hidden="true"></i>';
    toggle.addEventListener('click', () => {
      const showPassword = input.type === 'password';
      input.type = showPassword ? 'text' : 'password';
      toggle.innerHTML = `<i class="fa-solid ${showPassword ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>`;
      toggle.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
      toggle.setAttribute('title', showPassword ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(showPassword));
    });
    wrapper.appendChild(toggle);
  });
}
enhancePasswordInputs();
new MutationObserver((records) => {
  records.forEach((record) => record.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) enhancePasswordInputs(node);
  }));
}).observe(document.body, { childList: true, subtree: true });
function persistAuthTokens(payload) {
  try {
    if (payload.access_token) localStorage.setItem(AUTH_TOKEN_KEY, payload.access_token);
    if (payload.refresh_token) localStorage.setItem(AUTH_REFRESH_TOKEN_KEY, payload.refresh_token);
  } catch (error) { void error; }
}
function clearStoredAuth() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_REFRESH_TOKEN_KEY);
    localStorage.removeItem(AUTH_ACTIVITY_KEY);
  } catch (error) { void error; }
}
function recordAuthActivity() {
  if (!state.user) return;
  const now = Date.now();
  if (now - (Number(window.__taskerphLastActivityWrite) || 0) < 60_000) return;
  window.__taskerphLastActivityWrite = now;
  try { localStorage.setItem(AUTH_ACTIVITY_KEY, String(now)); } catch (error) { void error; }
}
async function refreshStoredAuth() {
  if (authRefreshPromise) return authRefreshPromise;
  authRefreshPromise = (async () => {
    let refreshToken = null;
    try { refreshToken = localStorage.getItem(AUTH_REFRESH_TOKEN_KEY); } catch (error) { void error; }
    if (!refreshToken) return false;
    try {
      const response = await fetch('api/auth?action=refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }), cache: 'no-store'
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success || !payload.access_token || !payload.refresh_token) return false;
      persistAuthTokens(payload);
      return true;
    } catch (error) { return false; }
  })();
  try { return await authRefreshPromise; }
  finally { authRefreshPromise = null; }
}
function handleExpiredAuth() {
  void window.taskerphPushLogout?.();
  state.user = null;
  clearStoredAuth();
  applySystemAppearance();
  applyGlassOpacity(0);
  state.myTasks = [];
  state.savedTasks = [];
  state.savedTaskIds.clear();
  updateSavedTaskCount(0);
  renderTasks();
  if (state.notificationTimer) clearInterval(state.notificationTimer);
  renderAuth();
  broadcastAuthChange();
  openModal('#login-modal');
}
const api = async (url, options = {}, hasRetried = false) => {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  try { const token = localStorage.getItem(AUTH_TOKEN_KEY); if (token) headers.Authorization = `Bearer ${token}`; } catch (error) { void error; }
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({ success: false, message: 'Invalid server response.' }));
  persistAuthTokens(payload);
  if ((!response.ok || !payload.success) && payload.auth_required && !hasRetried && await refreshStoredAuth()) return api(url, options, true);
  if (!response.ok || !payload.success) {
    if (payload.auth_required && state.user) {
      handleExpiredAuth();
      payload.message = 'Your session has ended. Please log in again.';
    }
    const requestError = new Error(payload.message || 'Request failed.');
    requestError.suspensionAppealAvailable = Boolean(payload.suspension_appeal_available);
    if(payload.mfa_setup_required&&state.user?.role==='superadmin') {
      state.user.mfa_setup_required=true;
      showPage('superadmin-account-page');
      renderSuperadminAccountSettings();
      if(!url.includes('action=mfa_begin')&&!url.includes('action=mfa_enable')) {
        requestError.message='Authenticator setup is required. Complete the setup dialog to continue using Superadmin tools.';
        void openSuperadminMfaEnrollment();
      }
    }
    throw requestError;
  }
  if (state.user) recordAuthActivity();
  return payload;
};
['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
  document.addEventListener(eventName, recordAuthActivity, { passive: true });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) recordAuthActivity();
});
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const money = (value) => `\u20B1${Number(value).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
const initials = (user) => `${user?.first_name?.[0] || ''}${user?.last_name?.[0] || ''}`.toUpperCase();

function notify(message, type = 'success') {
  const element = document.createElement('div');
  const isError = type === 'error';
  element.className = `app-toast ${isError ? 'app-toast-error' : 'app-toast-success'} fixed right-4 top-20 z-[70] max-w-sm rounded-lg px-4 py-3 shadow-xl`;
  element.setAttribute('role', isError ? 'alert' : 'status');
  element.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  element.innerHTML = `<span class="app-toast-icon"><i class="fa-solid ${isError ? 'fa-xmark' : 'fa-check'}"></i></span><span class="app-toast-copy"><strong>${isError ? 'Something went wrong' : 'Success'}</strong><span></span></span><button class="app-toast-close" type="button" aria-label="Dismiss notification"><i class="fa-solid fa-xmark"></i></button>`;
  element.querySelector('.app-toast-copy span').textContent = message;
  element.querySelector('.app-toast-close').addEventListener('click', () => dismissToast(element));
  document.body.appendChild(element);
  setTimeout(() => dismissToast(element), 4000);
}
function notifyReceived(title, message, openAction = () => loadNotificationCenter()) {
  const element = document.createElement('div');
  element.className = 'app-toast app-toast-received fixed right-4 top-20 z-[70] max-w-sm rounded-lg px-4 py-3 shadow-xl';
  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-label', `${title || 'New notification'}. Open to view.`);
  element.setAttribute('aria-live', 'polite');
  element.innerHTML = '<span class="app-toast-icon"><i class="fa-solid fa-bell" aria-hidden="true"></i></span><span class="app-toast-copy"><strong></strong><span></span></span><button class="app-toast-action" type="button">View</button><button class="app-toast-close" type="button" aria-label="Dismiss notification"><i class="fa-solid fa-xmark"></i></button>';
  element.querySelector('.app-toast-copy strong').textContent = title || 'New notification';
  element.querySelector('.app-toast-copy span').textContent = message || 'You have a new update.';
  element.querySelector('.app-toast-close').addEventListener('click', () => dismissToast(element));
  const openTarget = async () => { dismissToast(element); await openAction(); };
  element.querySelector('.app-toast-action').addEventListener('click', openTarget);
  element.addEventListener('click', (event) => { if (!event.target.closest('button')) void openTarget(); });
  element.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) { event.preventDefault(); void openTarget(); } });
  document.body.appendChild(element);
  setTimeout(() => dismissToast(element), 7000);
}
function dismissToast(element) {
  if (element.classList.contains('app-toast-leaving')) return;
  element.classList.add('app-toast-leaving');
  element.addEventListener('animationend', () => element.remove(), { once: true });
}
const activeActionProgress = new Map();
function renderActionProgress() {
  let indicator = $('#action-progress-indicator');
  if (!activeActionProgress.size) {
    indicator?.remove();
    return;
  }
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'action-progress-indicator';
    indicator.className = 'action-progress-indicator';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span></span>';
    document.body.appendChild(indicator);
  }
  indicator.querySelector('span').textContent = [...activeActionProgress.values()].at(-1);
  requestAnimationFrame(() => indicator.classList.add('is-visible'));
}
function setActionProgress(key, label, busy) {
  if (busy) activeActionProgress.set(key, label);
  else activeActionProgress.delete(key);
  renderActionProgress();
}
function ensureNotificationControls() {
  const controls = [
    { saved: '.desktop-only .saved-header-button:not(.mobile-saved-button)', id: 'desktop-notification-trigger', countId: 'desktop-notification-count', extra: 'hidden' },
    { saved: '.mobile-saved-button', id: 'mobile-notification-trigger', countId: 'mobile-notification-count', extra: 'mobile-only hidden' }
  ];
  controls.forEach(({ saved, id, countId, extra }) => {
    if ($(`#${id}`)) return;
    const savedButton = $(saved);
    if (!savedButton) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.dataset.notifications = '';
    button.className = `notification-trigger touch-target ${extra} rounded-lg border border-[#c9d4d9] px-3 text-[#006f70]`;
    button.setAttribute('aria-label', 'Notifications');
    button.innerHTML = `<i class="fa-regular fa-bell" aria-hidden="true"></i><span id="${countId}" class="notification-count hidden">0</span>`;
    savedButton.parentElement.insertBefore(button, savedButton);
  });
}
function ensureNotificationsPage() {
  if ($('#notifications-page')) return;
  document.body.insertAdjacentHTML('beforeend', '<section id="notifications-page" class="app-page page-shell hidden"><div class="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10"><div class="flex flex-wrap items-end justify-between gap-4"><div><p class="text-sm font-bold uppercase tracking-[.16em] text-[#008f8c]">Your activity</p><h1 class="mt-1 text-3xl font-bold sm:text-4xl">Notifications</h1><p class="mt-2 text-sm text-[#52616c]">Messages, bids, and updates about your tasks.</p></div><div class="flex gap-2"><button type="button" data-notifications-mark-all class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">Mark all as read</button><button type="button" data-page="marketplace-page" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">Browse tasks</button></div></div><div id="notification-center-list" class="mt-6 grid gap-3" aria-live="polite"></div></div></section>');
}
async function loadNotificationCenter() {
  ensureNotificationsPage();
  showPage('notifications-page');
  $('#notification-center-list').innerHTML = '<div class="card p-8 text-center text-sm text-[#52616c]"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Loading notifications...</div>';
  try {
    const payload = await api('api/notifications?action=center');
    notificationCenterItems = payload.items || [];
    setNotificationCount('#desktop-notification-count', payload.unread_count || 0);
    setNotificationCount('#mobile-notification-count', payload.unread_count || 0);
    $('#notification-center-list').innerHTML = notificationCenterItems.length ? notificationCenterItems.map((item) => `<button type="button" data-open-notification="${escapeHtml(item.id)}" class="notification-center-item ${item.is_read ? '' : 'is-unread'}"><span class="notification-center-icon"><i class="${item.type === 'message' ? 'fa-regular fa-message' : item.type === 'bid' ? 'fa-solid fa-gavel' : item.type==='announcement' ? 'fa-solid fa-bullhorn' : 'fa-regular fa-bell'}" aria-hidden="true"></i></span><span class="notification-center-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span><small>${escapeHtml(formatActivityTimestamp(item.created_at))}</small></span>${item.is_read ? '' : '<span class="notification-center-unread" aria-label="Unread"></span>'}</button>`).join('') : '<div class="empty-state rounded-xl border border-dashed border-[#c9d4d9] px-5 py-12 text-center"><i class="fa-regular fa-bell mb-3 text-2xl text-[#008f8c]" aria-hidden="true"></i><p class="font-bold">You’re all caught up.</p><p class="mt-1 text-sm text-[#52616c]">New messages, bids, and task updates will appear here.</p></div>';
  } catch (error) {
    $('#notification-center-list').innerHTML = `<div class="empty-state rounded-xl border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><p class="font-bold">Could not load notifications.</p><p class="mt-2 text-sm text-[#52616c]">${escapeHtml(error.message)}</p><button type="button" data-notifications-retry class="touch-target mt-4 rounded-lg border border-[#c9d4d9] px-4 font-bold text-[#006f70]">Try again</button></div>`;
  }
}
async function openAnnouncement(item) {
  if (!item || item.type !== 'announcement' || !Number.isSafeInteger(Number(item.entity_id))) {
    notify('This announcement could not be opened. Refresh your notifications and try again.', 'error');
    return;
  }
  try {
    await api('api/notifications?action=read_item',{method:'POST',body:JSON.stringify({type:'announcement',id:Number(item.entity_id)})});
    item.is_read=true;
    const notificationButton=[...document.querySelectorAll('[data-open-notification]')]
      .find((button)=>button.dataset.openNotification===String(item.id));
    notificationButton?.classList.remove('is-unread');
    notificationButton?.querySelector('.notification-center-unread')?.remove();
    if (!$('#announcement-reader-modal')) {
      document.body.insertAdjacentHTML('beforeend','<div id="announcement-reader-modal" class="modal-backdrop fixed inset-0 z-[120] hidden items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="announcement-reader-title"><article class="modal-panel announcement-reader-panel"><header><span class="announcement-reader-icon"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span><button type="button" data-close="announcement-reader-modal" aria-label="Close announcement"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header><p id="announcement-reader-audience" class="announcement-reader-eyebrow"></p><h2 id="announcement-reader-title"></h2><time id="announcement-reader-date"></time><div id="announcement-reader-body"></div><footer><button type="button" data-close="announcement-reader-modal" class="touch-target rounded-lg bg-[#006f70] px-5 font-bold text-white">Done</button></footer></article></div>');
    }
    $('#announcement-reader-audience').textContent='TaskerPH announcement';
    $('#announcement-reader-title').textContent=item.title||'Announcement';
    $('#announcement-reader-date').textContent=formatActivityTimestamp(item.created_at);
    $('#announcement-reader-body').textContent=item.body||'';
    openModal('#announcement-reader-modal');
    void updateNotificationCounts();
  } catch(error) { notify(error.message,'error'); }
}
function openLegalDocument(documentType) {
  const documents = {
    terms: {
      title: 'Terms of Service',
      description: 'The TaskerPH Terms of Service have not been published yet. Please check back after the finalized terms are available.'
    },
    privacy: {
      title: 'Privacy Policy',
      description: 'The TaskerPH Privacy Policy has not been published yet. Please check back after the finalized policy is available.'
    }
  };
  const legalDocument = documents[documentType];
  if (!legalDocument) {
    notify('That legal document could not be opened.', 'error');
    return;
  }
  if (!$('#legal-document-modal')) {
    document.body.insertAdjacentHTML('beforeend', '<div id="legal-document-modal" class="modal-backdrop fixed inset-0 z-[120] hidden items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="legal-document-title"><article class="modal-panel legal-reader-panel"><header><div><p class="legal-reader-label">TaskerPH · Legal</p><h2 id="legal-document-title"></h2></div><button type="button" data-close="legal-document-modal" aria-label="Close legal document"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header><div class="legal-reader-content"><p id="legal-document-description"></p><p class="legal-reader-note">Effective date: To be announced</p></div><footer><button type="button" data-close="legal-document-modal" class="touch-target rounded-lg bg-[#006f70] px-5 font-bold text-white">Done</button></footer></article></div>');
  }
  $('#legal-document-title').textContent = legalDocument.title;
  $('#legal-document-description').textContent = legalDocument.description;
  openModal('#legal-document-modal');
}
function setNotificationCount(selector, count) {
  const element = $(selector);
  if (!element) return;
  element.textContent = count > 99 ? '99+' : String(count);
  element.classList.toggle('hidden', count < 1);
}
async function updateNotificationCounts() {
  if (!state.user) {
    ['#desktop-bid-count', '#mobile-bid-count'].forEach((selector) => setNotificationCount(selector, 0));
    ['#desktop-notification-count', '#mobile-notification-count'].forEach((selector) => setNotificationCount(selector, 0));
    return;
  }
  try {
    const payload = await api('api/notifications?action=counts');
    setNotificationCount('#desktop-bid-count', payload.pending_bids);
    setNotificationCount('#mobile-bid-count', payload.pending_bids);
    setNotificationCount('#desktop-message-count', payload.bidder_unread_messages);
    setNotificationCount('#mobile-message-count', payload.bidder_unread_messages);
    const updates = await api('api/notifications?action=task_updates');
    (updates.updates || []).reverse().forEach((item) => {
      const toastKey = `${state.user.id}:${item.id}`;
      if (seenTaskUpdateToasts.has(toastKey)) return;
      seenTaskUpdateToasts.add(toastKey);
      const title = item.title && item.title !== 'undefined' ? item.title : 'New notification';
      const body = item.body && item.body !== 'undefined' ? item.body : 'There is a new update about one of your tasks.';
      notifyReceived(title, body);
    });
    const center = await api('api/notifications?action=center');
    setNotificationCount('#desktop-notification-count', center.unread_count || 0);
    setNotificationCount('#mobile-notification-count', center.unread_count || 0);
    if (['admin','moderator'].includes(state.user?.role)) {
      staffUnreadAnnouncementCount = Number(center.unread_announcement_count) || 0;
      setStaffNotificationBadge(staffActionNotificationCount + staffUnreadAnnouncementCount);
    }
    (center.items || []).filter((item) => item.type === 'message' && !item.is_read)
      .slice(0, 3).reverse().forEach((item) => {
        const toastKey = `${state.user.id}:${item.id}`;
        if (seenMessageToasts.has(toastKey)) return;
        seenMessageToasts.add(toastKey);
        notifyReceived(item.title, item.body, () => openConversation(item.task_id, item.other_user_id));
      });
  } catch (error) { void error; }
}
function startNotificationPolling() {
  if (state.notificationTimer) clearInterval(state.notificationTimer);
  updateNotificationCounts();
  state.notificationTimer = setInterval(updateNotificationCounts, 10000);
}
function updateTaskMessageCount(count) {
  const element = $('#task-message-count');
  if (!element) return;
  const unread = Number(count) || 0;
  element.textContent = unread ? `${unread} new message${unread === 1 ? '' : 's'}` : '';
  element.classList.toggle('hidden', unread < 1);
  element.style.display = unread ? 'inline-flex' : 'none';
}
function openModal(id) {
  document.querySelectorAll('.modal-backdrop').forEach((modal) => {
    modal.classList.add('hidden');
    modal.classList.remove('modal-active');
  });
  const modal = $(id);
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('modal-active');
  document.body.classList.add('overflow-hidden');
}
function openSuspensionAppealDialog() {
  let modal=$('#suspension-appeal-modal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend','<div id="suspension-appeal-modal" class="modal-backdrop fixed inset-0 z-[130] hidden items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="suspension-appeal-title"><form class="modal-panel w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><p class="text-xs font-bold uppercase tracking-wider text-amber-700">Suspended account</p><h2 id="suspension-appeal-title" class="mt-2 text-2xl font-bold">Request a review</h2><p class="mt-2 text-sm leading-6 text-slate-600">Explain why you believe the suspension should be reconsidered. An administrator will review your appeal.</p><label class="mt-5 block text-sm font-bold">Appeal reason<textarea name="reason" required minlength="20" maxlength="2000" rows="5" class="form-control mt-2" placeholder="Provide at least 20 characters"></textarea></label><div class="mt-5 flex justify-end gap-2"><button type="button" data-appeal-cancel class="touch-target rounded-lg border px-4 font-bold">Cancel</button><button type="submit" class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white">Submit appeal</button></div></form></div>');
    modal=$('#suspension-appeal-modal');
    modal.querySelector('[data-appeal-cancel]').addEventListener('click',()=>{clearStoredAuth();closeModal('suspension-appeal-modal');});
    modal.querySelector('form').addEventListener('submit',async(event)=>{
      event.preventDefault();
      const form=event.currentTarget;
      if (!form.reportValidity()) return;
      setBusy(form,true,'Submitting appeal...');
      try {
        const payload=await api('api/suspension_appeals',{method:'POST',body:JSON.stringify({action:'submit',reason:form.elements.reason.value})});
        clearStoredAuth();
        form.reset();
        closeModal('suspension-appeal-modal');
        notify(payload.message);
      } catch(error) { notify(error.message,'error'); }
      finally { setBusy(form,false); }
    });
  }
  openModal('#suspension-appeal-modal');
}
function closeModal(id) {
  const modalId = id.startsWith('#') ? id.slice(1) : id;
  const modal = $(`#${modalId}`);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('modal-active');
  }
  if (modalId === 'profile-confirm-modal') {
    $('#profile-confirm-form')?.reset();
    $('#profile-confirm-error')?.classList.add('hidden');
    $('#profile-confirm-error')?.replaceChildren();
  }
  if (modalId === 'conversation-modal' && state.conversationTimer) { clearInterval(state.conversationTimer); state.conversationTimer = null; }
  if (modalId === 'account-activity-modal' && accountActivityTimer) { clearInterval(accountActivityTimer); accountActivityTimer = null; }
  if (!document.querySelector('.modal-backdrop:not(.hidden)')) {
    document.body.classList.remove('overflow-hidden');
    document.documentElement.classList.remove('overflow-hidden');
    document.body.style.removeProperty('overflow');
    document.documentElement.style.removeProperty('overflow');
  }
  if (modalId === 'logout-confirm-modal' && state.logoutTrigger) {
    const trigger = state.logoutTrigger;
    state.logoutTrigger = null;
    requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  }
  if (modalId === 'auth-required-modal') {
    state.authPromptOpen = false;
    state.authReturnIntent = null;
    const trigger = state.authPromptTrigger;
    state.authPromptTrigger = null;
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  if (modalId === 'bid-auth-modal') {
    state.authPromptOpen = false;
    state.authReturnIntent = null;
    const trigger = state.authPromptTrigger;
    state.authPromptTrigger = null;
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  if ((id === 'login-modal' || id === 'register-modal') && state.authReturnIntent) {
    if (!state.preserveAuthIntent) {
      state.authReturnIntent = null;
      state.authPromptTrigger = null;
    }
    state.preserveAuthIntent = false;
  }
}
function decisionModal({ title, message, confirmLabel = 'Confirm', danger = false, withReason = false, reasonLabel = 'Cancellation reason', reasonPlaceholder = 'Let the other participant know why' }) {
  let modal = $('#action-confirm-modal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', '<div id="action-confirm-modal" class="modal-backdrop fixed inset-0 z-[115] hidden items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="action-confirm-title"><form class="modal-panel w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl sm:p-7"><div class="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-teal-700"><i class="fa-solid fa-circle-question" aria-hidden="true"></i></div><h2 id="action-confirm-title" class="text-2xl font-bold"></h2><p data-confirm-message class="mt-3 whitespace-pre-line text-sm leading-6 text-slate-600"></p><label data-confirm-reason-wrap class="mt-5 hidden text-sm font-bold">Cancellation reason <span class="font-normal text-slate-500">(optional)</span><textarea name="reason" rows="3" maxlength="500" class="form-control mt-2" placeholder="Let the other participant know why"></textarea></label><div class="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" data-confirm-cancel class="touch-target rounded-lg border border-slate-300 px-5 font-bold">Go back</button><button type="submit" data-confirm-submit class="touch-target rounded-lg bg-[#006f70] px-5 font-bold text-white"></button></div></form></div>');
    modal = $('#action-confirm-modal');
  }
  const form = modal.querySelector('form');
  modal.querySelector('#action-confirm-title').textContent = title;
  modal.querySelector('[data-confirm-message]').textContent = message;
  modal.querySelector('[data-confirm-submit]').textContent = confirmLabel;
  modal.querySelector('[data-confirm-submit]').classList.toggle('bg-rose-600', danger);
  modal.querySelector('[data-confirm-submit]').classList.toggle('hover:bg-rose-700', danger);
  modal.querySelector('[data-confirm-submit]').classList.toggle('bg-[#006f70]', !danger);
  const reasonWrap = modal.querySelector('[data-confirm-reason-wrap]');
  reasonWrap.firstChild.textContent = reasonLabel + ' ';
  reasonWrap.querySelector('textarea').placeholder = reasonPlaceholder;
  reasonWrap.classList.toggle('hidden', !withReason);
  form.elements.reason.value = '';
  openModal('#action-confirm-modal');
  return new Promise((resolve) => {
    const finish = (value) => { closeModal('action-confirm-modal'); form.removeEventListener('submit', submit); modal.querySelector('[data-confirm-cancel]').removeEventListener('click', cancel); resolve(value); };
    const submit = (event) => { event.preventDefault(); finish(withReason ? { reason: form.elements.reason.value.trim() } : true); };
    const cancel = () => finish(null);
    form.addEventListener('submit', submit);
    modal.querySelector('[data-confirm-cancel]').addEventListener('click', cancel);
    requestAnimationFrame(() => (withReason ? form.elements.reason : modal.querySelector('[data-confirm-cancel]')).focus({ preventScroll: true }));
  });
}
function closeDrawer() {
  $('#mobile-drawer')?.classList.add('-translate-x-full');
  $('#drawer-overlay')?.classList.add('hidden');
}
function closeDesktopProfileMenu() {
  $('#desktop-profile-dropdown')?.classList.add('hidden');
  $('#desktop-profile-trigger')?.setAttribute('aria-expanded', 'false');
  $('#superadmin-profile-dropdown')?.classList.add('hidden');
  $('#superadmin-profile-trigger')?.setAttribute('aria-expanded', 'false');
}
function updateSavedTaskCount(count) {
  const total = Number(count) || 0;
  ['#saved-task-count', '#mobile-saved-task-count', '#desktop-saved-task-count'].forEach((selector) => {
    const element = $(selector);
    if (!element) return;
    element.textContent = total > 99 ? '99+' : String(total);
    element.classList.toggle('hidden', total < 1);
  });
  const profileCount = $('#profile-saved-task-count');
  if (profileCount) profileCount.textContent = `${total} saved`;
}
function resetScrollPosition() {
  window.scrollTo(0, 0);
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const activePage = document.querySelector('.app-page:not(.hidden)');
  if (activePage) activePage.scrollTop = 0;
  const main = $('main');
  if (main) main.scrollTop = 0;
}
function setButtonBusy(button, busy, label = 'Saving...') {
  if (!button) return;
  if (busy) {
    if (button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    setActionProgress(button, label, true);
    button.dataset.busyHtml = button.innerHTML;
    button.dataset.busyDisabled = String(button.disabled);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i><span>${escapeHtml(label)}</span>`;
    return;
  }
  if (button.dataset.busy !== 'true') return;
  button.innerHTML = button.dataset.busyHtml || button.innerHTML;
  button.disabled = button.dataset.busyDisabled === 'true';
  button.removeAttribute('aria-busy');
  delete button.dataset.busy;
  delete button.dataset.busyHtml;
  delete button.dataset.busyDisabled;
  setActionProgress(button, '', false);
}
function setSavedButtonBusy(button, busy, label = '') {
  if (busy) {
    if (button.dataset.savedBusy === 'true') return;
    button.dataset.savedBusy = 'true';
    button.dataset.savedBusyDisabled = String(button.disabled);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-saving');
    setActionProgress(button, label, true);
    return;
  }
  if (button.dataset.savedBusy !== 'true') return;
  button.disabled = button.dataset.savedBusyDisabled === 'true';
  button.removeAttribute('aria-busy');
  button.classList.remove('is-saving');
  delete button.dataset.savedBusy;
  delete button.dataset.savedBusyDisabled;
  setActionProgress(button, '', false);
}
function setBusy(form, busy, label = 'Saving...') {
  const button = form.querySelector('button[type="submit"], button:not([type])');
  form.toggleAttribute('aria-busy', busy);
  setButtonBusy(button, busy, label);
}
function initializeTaskPhotoInputs() {
  ['task-form', 'create-task-form', 'edit-form'].forEach((formId) => {
    const form = $(`#${formId}`);
    const description = form?.querySelector('textarea[name="description"]')?.closest('label');
    if (!form || !description || form.querySelector('[data-task-photo-input]')) return;
    const field = document.createElement('div');
    field.className = 'task-photo-field';
    field.innerHTML = `<span class="task-photo-label">Task photos <small>Optional Â· up to 3 images total</small></span><div class="task-existing-photo-section hidden"><div class="task-existing-photo-heading"><strong>Current photos</strong><small>Tap to view Â· Ã— to remove</small></div><div class="task-existing-photos" aria-live="polite"></div></div><label class="task-photo-picker"><i class="fa-regular fa-image" aria-hidden="true"></i><span>Add photos</span><input data-task-photo-input type="file" accept="image/jpeg,image/png,image/webp" multiple><small>JPG, PNG, or WEBP</small></label><div class="task-photo-previews" aria-live="polite"></div>`;
    description.insertAdjacentElement('afterend', field);
    const input = field.querySelector('[data-task-photo-input]');
    input.addEventListener('change', () => {
      const files = [...input.files];
      const preview = field.querySelector('.task-photo-previews');
      preview.replaceChildren();
      const retainedCount = JSON.parse(form.dataset.keepImageUrls || '[]').length;
      if (files.length + retainedCount > 3) { input.value = ''; notify(`You can keep or upload up to 3 photos total. Remove ${Math.max(0, files.length + retainedCount - 3)} existing photo(s) first.`, 'error'); return; }
      if (files.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024)) {
        input.value = '';
        notify('Use JPG, PNG, or WEBP photos under 8 MB each.', 'error');
        return;
      }
      files.forEach((file, fileIndex) => {
        const tile = document.createElement('div');
        tile.className = 'task-photo-preview';
        const image = document.createElement('img');
        image.src = URL.createObjectURL(file);
        image.alt = file.name;
        image.onload = () => URL.revokeObjectURL(image.src);
        const caption = document.createElement('span');
        caption.textContent = file.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'task-photo-remove';
        remove.setAttribute('aria-label', `Remove selected photo ${fileIndex + 1}`);
        remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        remove.addEventListener('click', () => {
          const transfer = new DataTransfer();
          [...input.files].forEach((selected, index) => { if (index !== fileIndex) transfer.items.add(selected); });
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        tile.append(image, remove, caption);
        preview.appendChild(tile);
      });
    });
  });
}
function initializeTaskPostingFields() {
  ['task-form', 'create-task-form', 'edit-form'].forEach((formId) => {
    const form = $(`#${formId}`);
    if (!form || form.querySelector('[data-task-extra-fields]')) return;
    const edit = formId === 'edit-form';
    const prefix = edit ? 'edit-' : `${formId}-`;
    const fields = document.createElement('div');
    fields.className = 'task-extra-fields';
    fields.dataset.taskExtraFields = '';
    fields.innerHTML = `<input type="hidden" name="draft_id"><label class="block text-sm font-bold">Preferred date <span class="font-normal text-slate-500">(optional)</span><input type="date" name="schedule_date" id="${prefix}schedule_date" class="form-control mt-2"></label><div class="grid gap-4 sm:grid-cols-2"><label class="block text-sm font-bold">Task location type<select name="task_mode" id="${prefix}task_mode" class="form-control mt-2"><option value="on_site">On-site</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label><label class="block text-sm font-bold">Budget type<select name="budget_type" id="${prefix}budget_type" class="form-control mt-2"><option value="fixed">Fixed budget</option><option value="negotiable">Negotiable</option></select></label></div><label class="task-materials-field"><input type="checkbox" name="materials_included" id="${prefix}materials_included"><span><strong>Budget includes materials</strong><small>Turn this on if the listed budget covers supplies or parts.</small></span></label><label class="block text-sm font-bold">Skills or requirements <span class="font-normal text-slate-500">(optional)</span><textarea name="requirements" id="${prefix}requirements" rows="3" maxlength="1500" class="form-control mt-2" placeholder="List skills, tools, or experience the tasker should have."></textarea></label><label class="block text-sm font-bold">Task checklist <span class="font-normal text-slate-500">(optional, one item per line)</span><textarea name="checklist" id="${prefix}checklist" rows="3" maxlength="2000" class="form-control mt-2" placeholder="Measure the area\nBring the required tools\nClean up after the work"></textarea></label><div class="task-writing-guide"><strong><i class="fa-solid fa-lightbulb" aria-hidden="true"></i> Helpful writing tip</strong><span>Describe the result you want, mention access or timing limits, and list anything the tasker should bring.</span></div>`;
    const locationLabel = form.querySelector('[name="location"]')?.closest('label');
    const description = form.querySelector('[name="description"]')?.closest('label');
    (locationLabel || description)?.insertAdjacentElement(locationLabel ? 'afterend' : 'beforebegin', fields);
    const locationInput = form.elements.namedItem('location');
    const modeInput = form.elements.namedItem('task_mode');
    if (locationInput && modeInput) {
      const updateLocationHint = () => {
        const online = modeInput.value === 'online';
        locationInput.placeholder = online ? 'Online (or add a meeting preference)' : 'City or barangay';
        if (online && !locationInput.value.trim()) locationInput.value = 'Online';
        if (!online && locationInput.value.trim() === 'Online') locationInput.value = '';
      };
      modeInput.addEventListener('change', updateLocationHint);
    }
    const submit = form.querySelector('button[type="submit"], button:not([type])');
    if (submit && !edit) {
      const actions = document.createElement('div');
      actions.className = 'task-posting-actions';
      actions.innerHTML = '<button type="button" data-task-preview class="touch-target task-draft-secondary"><i class="fa-regular fa-eye" aria-hidden="true"></i> Preview</button><button type="button" data-save-task-draft class="touch-target task-draft-secondary"><i class="fa-regular fa-floppy-disk" aria-hidden="true"></i> Save draft</button>';
      submit.insertAdjacentElement('beforebegin', actions);
    }
    if (!edit) {
      const titleLabel = form.querySelector('[name="title"]')?.closest('label');
      if (titleLabel) {
        const duplicate = document.createElement('p');
        duplicate.className = 'task-duplicate-note hidden';
        duplicate.setAttribute('role', 'status');
        duplicate.textContent = 'You have already posted an active task with this title. You can still confirm if this is a separate request.';
        titleLabel.insertAdjacentElement('afterend', duplicate);
      }
    }
  });
  if (!$('#task-preview-modal')) {
    const modal = document.createElement('div');
    modal.id = 'task-preview-modal';
    modal.className = 'modal-backdrop fixed inset-0 z-[120] hidden items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'task-preview-title');
    modal.innerHTML = '<div class="modal-panel task-preview-panel"><div class="task-preview-heading"><div><p>Listing preview</p><h2 id="task-preview-title">Your task as taskers will see it</h2></div><button type="button" data-close="task-preview-modal" aria-label="Close preview"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><div id="task-preview-content"></div><button type="button" data-close="task-preview-modal" class="touch-target task-preview-done">Back to editing</button></div>';
    document.body.appendChild(modal);
  }
}
initializeTaskPostingFields();
initializeTaskPhotoInputs();
document.addEventListener('focusout', async (event) => {
  const title = event.target;
  const form = title.closest('form');
  if (title.name !== 'title' || !['task-form', 'create-task-form'].includes(form?.id) || !title.value.trim()) return;
  try {
    const payload = await api('api/create_task?action=check_duplicate', { method: 'POST', body: JSON.stringify({ title: title.value }) });
    const note = form.querySelector('.task-duplicate-note');
    if (note) note.classList.toggle('hidden', !payload.duplicate);
  } catch { /* Publishing repeats the duplicate check and reports any issue. */ }
}, true);
async function taskFormPreviewMarkup(form) {
  const value = (name) => String(form.elements.namedItem(name)?.value || '').trim();
  const title = value('title') || 'Untitled task';
  const requirements = value('requirements');
  const checklist = value('checklist').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
  const mode = form.elements.namedItem('task_mode')?.selectedOptions?.[0]?.textContent || 'On-site';
  const budgetType = form.elements.namedItem('budget_type')?.value === 'negotiable' ? 'Negotiable' : 'Fixed budget';
  const date = value('schedule_date');
  const dateText = date ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'long' }).format(new Date(`${date}T00:00:00`)) : 'Flexible date';
  const photos = await Promise.all([...(form.querySelector('[data-task-photo-input]')?.files || [])].slice(0, 3).map(compressTaskPhoto));
  const photoMarkup = photos.length ? `<div class="task-preview-photos">${photos.map((photo, index) => `<img src="${photo}" alt="Task photo ${index + 1}">`).join('')}</div>` : '';
  return `<article class="task-preview-card"><p class="task-preview-category">${escapeHtml(value('category') || 'Task category')}</p><h3>${escapeHtml(title)}</h3>${photoMarkup}<p class="task-preview-description">${escapeHtml(value('description') || 'Your task description will appear here.')}</p><div class="task-preview-meta"><span><i class="fa-solid fa-peso-sign" aria-hidden="true"></i>${escapeHtml(value('budget') ? money(Number(value('budget')) || 0) : 'Budget not set')} · ${budgetType}</span><span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${escapeHtml(value('location') || (mode === 'Online' ? 'Online' : 'Location not set'))} · ${escapeHtml(mode)}</span><span><i class="fa-regular fa-calendar" aria-hidden="true"></i>${escapeHtml(dateText)}</span><span><i class="fa-solid fa-box" aria-hidden="true"></i>Materials ${form.elements.namedItem('materials_included')?.checked ? 'included' : 'not included'}</span></div>${requirements ? `<div class="task-preview-section"><strong>Requirements</strong><p>${escapeHtml(requirements)}</p></div>` : ''}${checklist.length ? `<div class="task-preview-section"><strong>Checklist</strong><ul>${checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}</article>`;
}
async function prefillTaskForm(form, data, draftId = '') {
  form.reset();
  Object.entries(data || {}).forEach(([key, value]) => {
    const input = form.elements.namedItem(key);
    if (!input || key === 'photos') return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = key === 'checklist' && Array.isArray(value) ? value.join('\n') : value ?? '';
  });
  const draftInput = form.elements.namedItem('draft_id');
  if (draftInput) draftInput.value = draftId;
  form.dataset.keepImageUrls = '[]';
  const photoInput = form.querySelector('[data-task-photo-input]');
  if (photoInput) {
    const transfer = new DataTransfer();
    for (const [index, dataUrl] of (Array.isArray(data?.photos) ? data.photos : []).entries()) {
      try { const blob = await fetch(dataUrl).then((response) => response.blob()); transfer.items.add(new File([blob], `draft-photo-${index + 1}.jpg`, { type: 'image/jpeg' })); } catch { /* A draft remains usable if an older saved photo cannot load. */ }
    }
    photoInput.files = transfer.files;
    photoInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
async function saveTaskDraft(form) {
  const button = form.querySelector('[data-save-task-draft]');
  if (button) setButtonBusy(button, true, 'Saving draft...');
  try {
    const snapshot = await taskFormPayload(form);
    const draftId = form.elements.namedItem('draft_id')?.value || '';
    const payload = await api('api/create_task?action=draft_save', { method: 'POST', body: JSON.stringify({ draft_id: draftId, data: snapshot }) });
    form.elements.namedItem('draft_id').value = String(payload.draft.id);
    void refreshTaskDraftCount();
    notify('Your task draft has been saved.');
  } catch (error) { notify(error.message, 'error'); }
  finally { if (button) setButtonBusy(button, false); }
}
let currentTaskDrafts = [];
async function refreshTaskDraftCount() {
  if (!state.user) return;
  try {
    const payload = await api('api/create_task?action=draft_list', { method: 'POST', body: '{}' });
    currentTaskDrafts = payload.drafts || [];
    const count = currentTaskDrafts.length;
    const profileCount = $('#profile-draft-count');
    if (profileCount) profileCount.textContent = `${count} ${count === 1 ? 'draft' : 'drafts'}`;
    const desktopCount = $('#desktop-task-draft-count');
    if (desktopCount) { desktopCount.textContent = String(count); desktopCount.classList.toggle('hidden', count < 1); }
  } catch { /* The shortcut remains available even when a count refresh fails. */ }
}
async function loadMyTaskDrafts() {
  const payload = await api('api/create_task?action=draft_list', { method: 'POST', body: '{}' });
  const draftsNode = $('#my-task-drafts');
  if (!draftsNode) return;
  const drafts = currentTaskDrafts = payload.drafts || [];
  const profileDraftCount = $('#profile-draft-count');
  if (profileDraftCount) profileDraftCount.textContent = `${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'}`;
  const desktopDraftCount = $('#desktop-task-draft-count');
  if (desktopDraftCount) { desktopDraftCount.textContent = String(drafts.length); desktopDraftCount.classList.toggle('hidden', drafts.length < 1); }
  draftsNode.innerHTML = drafts.length ? `<section class="task-drafts-section"><div class="task-drafts-heading"><div><p>Your workspace</p><h2>Saved drafts <span>${drafts.length}</span></h2></div><p>Only you can see drafts until you publish them.</p></div><div class="task-drafts-grid">${drafts.map((draft) => `<article class="task-draft-card"><div><p>${escapeHtml(draft.data?.category || 'Task draft')}</p><h3>${escapeHtml(draft.data?.title || 'Untitled task')}</h3><small>Updated ${escapeHtml(formatActivityTimestamp(draft.updated_at))}</small></div><div class="task-draft-actions"><button type="button" data-resume-task-draft="${Number(draft.id)}" class="task-draft-resume"><i class="fa-solid fa-pen" aria-hidden="true"></i> Continue</button><button type="button" data-delete-task-draft="${Number(draft.id)}" class="task-draft-delete" aria-label="Delete draft"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></div></article>`).join('')}</div></section>` : '<section class="task-drafts-section task-drafts-empty"><i class="fa-regular fa-file-lines" aria-hidden="true"></i><strong>No saved drafts yet</strong><span>Start a task post and choose “Save draft” to continue it later.</span></section>';
}
function renderExistingTaskPhotos(form) {
  const container = form.querySelector('.task-existing-photos');
  if (!container) return;
  let urls = [];
  try { urls = JSON.parse(form.dataset.keepImageUrls || '[]'); } catch { urls = []; }
  container.replaceChildren();
  container.closest('.task-existing-photo-section')?.classList.toggle('hidden', !urls.length);
  urls.forEach((url, index) => {
    const tile = document.createElement('div');
    tile.className = 'task-photo-preview task-photo-existing';
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'task-photo-view';
    view.setAttribute('data-photo-url', url);
    view.setAttribute('data-photo-alt', `Current task photo ${index + 1}`);
    const image = document.createElement('img');
    image.src = url;
    image.alt = `Current task photo ${index + 1}`;
    view.appendChild(image);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'task-photo-remove';
    remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
    remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    remove.addEventListener('click', () => {
      const kept = JSON.parse(form.dataset.keepImageUrls || '[]');
      kept.splice(index, 1);
      form.dataset.keepImageUrls = JSON.stringify(kept);
      renderExistingTaskPhotos(form);
      form.querySelector('[data-task-photo-input]')?.dispatchEvent(new Event('change'));
    });
    const caption = document.createElement('span');
    caption.textContent = `Photo ${index + 1}`;
    tile.append(view, remove, caption);
    container.appendChild(tile);
  });
}
function openPhotoViewer(url, alt = 'Task photo') {
  let viewer = $('#photo-lightbox');
  if (!viewer) {
    viewer = document.createElement('div');
    viewer.id = 'photo-lightbox';
    viewer.className = 'photo-lightbox hidden';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', 'Task photo viewer');
    viewer.innerHTML = '<button type="button" class="photo-lightbox-close" aria-label="Close photo" data-photo-viewer-close><i class="fa-solid fa-xmark" aria-hidden="true"></i></button><img class="photo-lightbox-image" alt=""><p class="photo-lightbox-caption"></p>';
    document.body.appendChild(viewer);
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer || event.target.closest('[data-photo-viewer-close]')) closePhotoViewer();
    });
  }
  viewer.dataset.bodyWasLocked = String(document.body.classList.contains('overflow-hidden'));
  viewer.querySelector('img').src = url;
  viewer.querySelector('img').alt = alt;
  viewer.querySelector('.photo-lightbox-caption').textContent = alt;
  viewer.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
  viewer.querySelector('[data-photo-viewer-close]').focus({ preventScroll: true });
}
function closePhotoViewer() {
  const viewer = $('#photo-lightbox');
  if (!viewer) return;
  viewer.classList.add('hidden');
  if (viewer.dataset.bodyWasLocked !== 'true') document.body.classList.remove('overflow-hidden');
  delete viewer.dataset.bodyWasLocked;
}
async function compressTaskPhoto(file) {
  let source, sourceWidth, sourceHeight, releaseSource = () => {};
  try {
    source = await createImageBitmap(file);
    sourceWidth = source.width;
    sourceHeight = source.height;
    releaseSource = () => source.close?.();
  } catch {
    const objectUrl = URL.createObjectURL(file);
    source = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not read one of the selected photos.'));
      image.src = objectUrl;
    });
    sourceWidth = source.naturalWidth;
    sourceHeight = source.naturalHeight;
    releaseSource = () => URL.revokeObjectURL(objectUrl);
  }
  const canvas = document.createElement('canvas');
  let scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  let quality = 0.82;
  let blob;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 450 * 1024) break;
    if (quality > 0.52) quality -= 0.1;
    else scale *= 0.78;
  }
  releaseSource();
  if (!blob || blob.size > 450 * 1024) throw new Error('A photo could not be compressed. Try a smaller image.');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read one of the selected photos.'));
    reader.readAsDataURL(blob);
  });
}
async function taskFormPayload(form) {
  const payload = Object.fromEntries(new FormData(form));
  delete payload.photos;
  payload.materials_included = Boolean(form.querySelector('[name="materials_included"]')?.checked);
  payload.schedule_date = payload.schedule_date || null;
  payload.checklist = String(payload.checklist || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
  delete payload.draft_id;
  const files = [...(form.querySelector('[data-task-photo-input]')?.files || [])];
  payload.photos = await Promise.all(files.map(compressTaskPhoto));
  try { payload.keep_image_urls = JSON.parse(form.dataset.keepImageUrls || '[]'); } catch { payload.keep_image_urls = []; }
  return payload;
}
function taskPhotoMarkup(task, compact = false) {
  const photos = Array.isArray(task.image_urls) ? task.image_urls.slice(0, 3) : [];
  if (!photos.length) return '';
  return `<div class="task-photo-gallery${compact ? ' is-compact' : ''}" aria-label="Task photos">${photos.map((url, index) => `<button type="button" class="task-photo-view" data-photo-url="${escapeHtml(url)}" data-photo-alt="${escapeHtml(task.title)} â€” photo ${index + 1}" aria-label="View photo ${index + 1} for ${escapeHtml(task.title)}"><img src="${escapeHtml(url)}" alt="Photo for ${escapeHtml(task.title)}" loading="lazy"><span><i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i></span></button>`).join('')}</div>`;
}
function requestAuthGate(route, trigger = null) {
  if (state.user) return false;
  state.authReturnIntent = route;
  state.authPromptTrigger = trigger;
  state.authPromptOpen = true;
  closeDrawer();
  closeDesktopProfileMenu();
  openModal('#auth-required-modal');
  requestAnimationFrame(() => $('#auth-required-signin')?.focus({ preventScroll: true }));
  return true;
}
function requestBidAuthGate(task, trigger = null) {
  if (state.user) return false;
  const taskSnapshot = typeof task === 'object' ? task : state.activeTask;
  const taskId = Number(typeof task === 'object' ? task.id : task);
  state.authReturnIntent = { route: 'task-detail', taskId, task: taskSnapshot || null };
  state.authPromptTrigger = trigger;
  state.authPromptOpen = true;
  openModal('#bid-auth-modal');
  requestAnimationFrame(() => $('#bid-auth-signin')?.focus({ preventScroll: true }));
  return true;
}
function protectedRouteForElement(target) {
  if (target.closest('[data-profile-page]')) return 'profile';
  if (target.closest('[data-my-tasks]')) return 'tasks';
  if (target.closest('[data-my-bids]')) return 'bids';
  if (target.closest('[data-saved-tasks], [data-save-task]')) return 'saved';
  if (target.closest('[data-modal="task-modal"], [data-page="create-task-page"]')) return 'post';
  if (target.closest('[data-message-task]')) return 'messages';
  return null;
}
function showPage(pageId) {
  const protectedIntent = { 'create-task-page': 'post', 'my-tasks-modal': 'tasks', 'my-bids-page': 'bids', 'profile-page': 'profile', 'saved-tasks-page': 'saved', 'conversation-modal': 'messages' }[pageId];
  if (protectedIntent && requestAuthGate(protectedIntent)) return false;
  const role = state.user?.role;
  const permissions=state.user?.staff_permissions||{};
  const canModerateAdmin = role==='superadmin'||Boolean(permissions.can_moderate_tasks);
  const canViewUsers = role==='superadmin'||Boolean(permissions.can_view_users);
  const canReviewReports = role==='superadmin'||Boolean(permissions.can_review_reports);
  const canViewStaffProfiles = role==='superadmin'||canViewUsers||canModerateAdmin||canReviewReports;
  const canOpenStaffDashboard=['admin','moderator'].includes(role);
  if (['account-activity-modal','audit-log-page','admin-operations-page'].includes(pageId) && role !== 'superadmin') { notify('Only the Superadmin can open this page.', 'error'); return false; }
  if (pageId==='superadmin-account-page'&&role!=='superadmin'&&!canOpenStaffDashboard) { notify('Only Admin staff can open workspace account settings.', 'error'); return false; }
  if (pageId==='staff-dashboard-page'&&!canOpenStaffDashboard) { notify('Only Admin or Moderator staff can open this dashboard.', 'error'); return false; }
  if (pageId === 'user-management-page' && !canViewUsers) { notify('You do not have permission to view user records.', 'error'); return false; }
  if (pageId === 'superadmin-user-profile-page' && !canViewStaffProfiles) { notify('Only staff can view member profiles.', 'error'); return false; }
  if (['task-management-page','superadmin-task-detail-page'].includes(pageId) && !canModerateAdmin) { notify('You do not have permission to moderate tasks.', 'error'); return false; }
  if (pageId==='report-management-page'&&!canReviewReports) { notify('You do not have permission to review reports.', 'error'); return false; }
  ensureAdminControls();
  const staffWorkspacePage = ['staff-dashboard-page','task-management-page','superadmin-task-detail-page','report-management-page','user-management-page','superadmin-user-profile-page','superadmin-account-page'].includes(pageId);
  const staffConsoleRole = ['admin','moderator','support'].includes(role);
  const staffConsoleActive = staffConsoleRole && (staffWorkspacePage || (pageId === 'profile-page' && ['admin','moderator'].includes(role)));
  document.body.classList.toggle('staff-admin-mode',canOpenStaffDashboard&&staffWorkspacePage);
  document.body.classList.toggle('superadmin-mode',role === 'superadmin' || staffConsoleActive);
  document.querySelectorAll('.app-page').forEach((page) => page.classList.toggle('hidden', page.id !== pageId));
  updateWorkspacePageLabels(role);
  if (pageId === 'superadmin-account-page') renderSuperadminAccountSettings();
  const activeAdminPage = ({ 'superadmin-task-detail-page': 'task-management-page', 'superadmin-user-profile-page': 'user-management-page' })[pageId] || pageId;
  document.querySelectorAll('.superadmin-sidebar [data-admin-page], .superadmin-sidebar [data-page]').forEach((button) => {
    if (button.dataset.adminPage==='admin-operations-page'&&role!=='superadmin') {
      button.hidden=true;
      return;
    }
    if (button.dataset.page==='staff-dashboard-page'&&role==='superadmin') button.dataset.page='account-activity-modal';
    if (button.dataset.page==='account-activity-modal'&&canOpenStaffDashboard) button.dataset.page='staff-dashboard-page';
    const target = button.dataset.adminPage || button.dataset.page;
    const superadminOnly = ['account-activity-modal','audit-log-page','admin-operations-page'].includes(target);
    const staffAccountSettingsOnly=target==='superadmin-account-page';
    const staffDashboardOnly = target==='staff-dashboard-page';
    const usersOnly = target === 'user-management-page';
    const moderationOnly = ['task-management-page','superadmin-task-detail-page'].includes(target);
    const reportsOnly = target==='report-management-page';
    button.hidden = Boolean((superadminOnly && role !== 'superadmin') || (staffAccountSettingsOnly&&role!=='superadmin'&&!canOpenStaffDashboard) || (staffDashboardOnly&&!canOpenStaffDashboard) || (usersOnly && !canViewUsers) || (moderationOnly && !canModerateAdmin) || (reportsOnly&&!canReviewReports));
    const active = target === activeAdminPage;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('main')?.classList.toggle('hidden', pageId && pageId !== 'marketplace-page');
  const mobileNav = document.querySelector('.mobile-bottom-nav');
  const activeMobileNavItem = {
    'marketplace-page': mobileNav?.querySelector('a[href="#marketplace"]'),
    'my-tasks-modal': mobileNav?.querySelector('[data-my-tasks]'),
    'my-bids-page': mobileNav?.querySelector('[data-my-bids]'),
    'profile-page': mobileNav?.querySelector('[data-profile-page]'),
    'create-task-page': mobileNav?.querySelector('[data-modal="task-modal"]'),
  }[pageId];
  mobileNav?.querySelectorAll('.mobile-nav-item').forEach((item) => {
    const isActive = item === activeMobileNavItem;
    item.classList.toggle('is-active', isActive);
    if (isActive) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  closeDrawer();
  closeDesktopProfileMenu();
  document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((modal) => closeModal(`#${modal.id}`));
  resetScrollPosition();
  if (pageId === 'marketplace-page' && state.taskRefreshTimer) refreshMarketplaceTasks();
  if (pageId === 'user-management-page') void loadAdminUsers(true);
  if (pageId === 'task-management-page' && canModerateAdmin && role !== 'superadmin') void loadModeratorTasks();
  if (pageId === 'report-management-page') void loadAdminReports(true);
  if (pageId === 'audit-log-page') void loadAdminAudit(true);
  if (pageId === 'admin-operations-page') void loadAdminOperations();
  if (pageId === 'staff-dashboard-page') void loadStaffDashboard();
}

function updateWorkspacePageLabels(role) {
  const roleLabel = ({ admin: 'Admin', moderator: 'Moderator', support: 'Support', superadmin: 'Superadmin' })[role] || 'Workspace';
  document.querySelectorAll('[data-workspace-label]').forEach((label) => {
    const section = label.closest('.app-page');
    const title = label.dataset.workspaceLabel;
    const pageLabel = title === 'users' ? 'Users' : title === 'moderation' ? 'Moderation' : title === 'safety' ? 'Safety' : '';
    if (section && pageLabel) label.textContent = `${roleLabel} · ${pageLabel}`;
  });
}

function renderAuth() {
  const loggedIn = Boolean(state.user);
  ensureNotificationControls();
  $('#desktop-notification-trigger')?.classList.toggle('hidden', !loggedIn);
  $('#mobile-notification-trigger')?.classList.toggle('hidden', !loggedIn);
  const activePageId = document.querySelector('.app-page:not(.hidden)')?.id;
  const staffConsolePage = ['staff-dashboard-page','task-management-page','superadmin-task-detail-page','report-management-page','user-management-page','superadmin-user-profile-page','superadmin-account-page'].includes(activePageId) || (activePageId === 'profile-page' && ['admin','moderator'].includes(state.user?.role));
  document.body.classList.toggle('staff-admin-mode', ['admin','moderator'].includes(state.user?.role) && staffConsolePage);
  document.body.classList.toggle('superadmin-mode', state.user?.role === 'superadmin' || (['admin','moderator','support'].includes(state.user?.role) && staffConsolePage));
  if ($('#admin-topbar-name') && loggedIn) $('#admin-topbar-name').textContent = `${state.user.first_name || ''} ${state.user.last_name || ''}`.trim();
  const globalProfileRole = $('#superadmin-global-profile .superadmin-profile-copy small');
  if (globalProfileRole && loggedIn) globalProfileRole.textContent = state.user.role === 'superadmin' ? 'Platform administrator' : `${({admin:'Administrator',moderator:'Moderator',support:'Support'})[state.user.role] || 'Staff'} workspace`;
  $('#mobile-header-login-button')?.classList.toggle('hidden', loggedIn);
  $('.mobile-saved-button')?.classList.toggle('hidden', !loggedIn);
  $('#auth-actions').innerHTML = loggedIn ? `<div class="desktop-profile-root relative hidden lg:block"><button id="desktop-profile-trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="desktop-profile-dropdown" class="desktop-profile-trigger touch-target flex items-center gap-2 rounded-xl border border-slate-200 px-2 py-1.5 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><span class="desktop-profile-avatar"><img id="desktop-avatar-image" class="hidden" alt=""><span id="desktop-avatar-fallback">${escapeHtml(initials(state.user))}</span></span><span class="max-w-32"><strong class="block truncate text-sm">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.last_name)}</strong><small class="block truncate text-xs text-slate-500">${escapeHtml(state.user.email)}</small></span><i class="fa-solid fa-chevron-down text-xs text-slate-500" aria-hidden="true"></i></button><div id="desktop-profile-dropdown" class="desktop-profile-dropdown hidden" aria-label="Profile menu"><div class="desktop-profile-menu-user"><span class="desktop-profile-menu-avatar"><img id="desktop-menu-avatar-image" class="hidden" alt=""><span id="desktop-menu-avatar-fallback">${escapeHtml(initials(state.user))}</span></span><span class="min-w-0"><strong class="block truncate">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.middle_initial ? `${state.user.middle_initial}. ` : '')}${escapeHtml(state.user.last_name)}</strong><small class="block truncate">${escapeHtml(state.user.email)}</small><em>${escapeHtml(({superadmin:'Super Admin',admin:'Administrator',moderator:'Moderator',support:'Support'})[state.user.role]||'TaskerPH Member')}</em></span></div><button data-appearance-toggle class="desktop-profile-menu-row"><i class="fa-solid fa-circle-half-stroke"></i><span>Appearance</span><strong id="desktop-appearance-state">Light</strong></button><label class="desktop-glass-row"><span><i class="fa-solid fa-wand-magic-sparkles"></i> Glass transparency</span><strong id="desktop-glass-label">0%</strong><input id="desktop-glass-opacity" type="range" min="0" max="100" step="1" value="0" aria-label="Glass transparency"></label><button data-page="create-task-page" class="desktop-profile-menu-row"><i class="fa-solid fa-plus"></i><span>Post a task</span></button><button data-my-tasks class="desktop-profile-menu-row"><i class="fa-solid fa-clipboard-list"></i><span>My tasks</span></button><button type="button" data-my-task-drafts class="desktop-profile-menu-row"><i class="fa-regular fa-file-lines"></i><span>Saved drafts</span><strong id="desktop-task-draft-count" class="desktop-menu-count">0</strong></button><button data-my-bids class="desktop-profile-menu-row"><i class="fa-solid fa-gavel"></i><span>My bids</span></button><button data-saved-tasks class="desktop-profile-menu-row"><i class="fa-regular fa-bookmark"></i><span>Saved tasks</span><strong id="desktop-saved-task-count" class="desktop-menu-count">0</strong></button><div class="desktop-profile-menu-divider"></div><button data-profile-page class="desktop-profile-menu-row"><i class="fa-solid fa-user"></i><span>View profile</span></button><button data-desktop-profile-form="edit-profile-form" class="desktop-profile-menu-row"><i class="fa-solid fa-user-pen"></i><span>Edit profile</span></button><button data-desktop-profile-form="change-email-form" class="desktop-profile-menu-row"><i class="fa-solid fa-envelope"></i><span>Change email</span></button><button data-desktop-profile-form="change-password-form" class="desktop-profile-menu-row"><i class="fa-solid fa-lock"></i><span>Change password</span></button><button data-modal="support-modal" class="desktop-profile-menu-row"><i class="fa-solid fa-circle-question"></i><span>Help &amp; Support</span></button><button data-action="logout" class="desktop-profile-logout"><i class="fa-solid fa-arrow-right-from-bracket"></i>Log out</button><small class="desktop-profile-version">TaskerPH Â· Version 1.0.0</small></div></div><button data-action="logout" class="mobile-only touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold">Log out</button>` : `<button data-modal="login-modal" class="touch-target rounded-lg px-4 text-sm font-bold text-[#006f70] hover:bg-[#e9f4f2]">Log in</button><button data-modal="register-modal" class="touch-target rounded-lg bg-[#006f70] px-4 text-sm font-bold text-white shadow-sm hover:bg-[#005b5c]">Join TaskerPH</button>`;
  if (loggedIn && state.user.avatar_path) {
    ['#desktop-avatar-image', '#desktop-menu-avatar-image'].forEach((selector) => { const image = $(selector); if (image) { image.src = `${state.user.avatar_path}?v=${encodeURIComponent(state.user.avatar_path)}`; image.classList.remove('hidden'); } });
    ['#desktop-avatar-fallback', '#desktop-menu-avatar-fallback'].forEach((selector) => $(selector)?.classList.add('hidden'));
  }
  $('#mobile-auth').innerHTML = loggedIn ? `<div class="mb-5 rounded-lg bg-[#e9f4f2] p-4"><p class="font-bold">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.last_name)}</p><p class="text-xs uppercase tracking-wider text-[#68727c]">${escapeHtml(state.user.role)}</p></div><button data-action="logout" class="touch-target w-full rounded-lg border border-[#c9d4d9] px-4 text-left text-sm font-bold">Log out</button>` : `<button data-modal="login-modal" class="touch-target w-full rounded-lg border border-[#c9d4d9] px-4 text-left text-sm font-bold">Log in</button><button data-modal="register-modal" class="touch-target mt-2 w-full rounded-lg bg-[#006f70] px-4 text-left text-sm font-bold text-white">Join TaskerPH</button>`;
  if (['superadmin','admin','moderator','support'].includes(state.user?.role)) $('#mobile-auth').insertAdjacentHTML('afterbegin', `<button id="mobile-activity-dashboard" data-activity-dashboard class="touch-target mb-3 w-full rounded-lg bg-[#006f70] px-4 text-left text-sm font-bold text-white"><i class="fa-solid fa-chart-line mr-2" aria-hidden="true"></i>${state.user.role==='superadmin'?'Superadmin dashboard':state.user.role==='support'?'Support workspace':'Admin dashboard'}</button>`);
  $('#role-banner').innerHTML = loggedIn ? `<strong>${escapeHtml(state.user.role === 'superadmin' ? 'Superadmin control' : state.user.role === 'support' ? 'Support workspace' : ['admin','moderator'].includes(state.user.role) ? 'Moderation workspace' : 'Your task space')}:</strong> ${state.user.role === 'user' ? 'Post tasks, track your listings, and discover work nearby.' : state.user.role === 'support' ? 'Review member records and help resolve account questions.' : 'Use your moderation tools responsibly to keep the marketplace useful.'}` : '<strong>Welcome to TaskerPH:</strong> Find trusted local help or post your next task in minutes.';
  $('#post-task-button').classList.toggle('hidden', !loggedIn);
  $('#mobile-post').classList.toggle('hidden', !loggedIn);
  $('#hero-post').classList.toggle('hidden', !loggedIn);
  $('#hero-post').classList.toggle('inline-flex', loggedIn);
  $('#hero-login')?.classList.toggle('hidden', loggedIn);
  $('#hero-login')?.classList.toggle('inline-flex', !loggedIn);
  document.querySelector('.mobile-bottom-nav')?.classList.toggle('is-guest-hidden', !loggedIn);
  $('#my-bids-button').classList.toggle('hidden', !loggedIn);
  $('#mobile-my-bids').classList.toggle('hidden', !loggedIn);
  $('#my-tasks-button').classList.toggle('hidden', !loggedIn);
  $('#mobile-my-tasks').classList.toggle('hidden', !loggedIn);
  $('#admin-button').classList.toggle('hidden', state.user?.role !== 'superadmin');
  const hasAdminWorkspace=['superadmin','admin','moderator','support'].includes(state.user?.role);
  $('#activity-dashboard-button')?.classList.toggle('hidden', !hasAdminWorkspace);
  if ($('#activity-dashboard-button') && hasAdminWorkspace) $('#activity-dashboard-button').innerHTML=`<i class="fa-solid fa-chart-line mr-2" aria-hidden="true"></i>${state.user.role==='superadmin'?'Superadmin dashboard':state.user.role==='support'?'Support workspace':'Admin dashboard'}`;
  $('#mobile-activity-dashboard')?.classList.toggle('hidden', !hasAdminWorkspace);
  document.querySelectorAll('[data-superadmin-return]').forEach((button) => button.classList.toggle('hidden', state.user?.role !== 'superadmin'));
  const desktopAppearanceState = $('#desktop-appearance-state');
  if (desktopAppearanceState) desktopAppearanceState.textContent = document.body.classList.contains('dark-mode') ? 'Dark' : 'Light';
  if ($('#desktop-glass-opacity')) applyGlassOpacity(state.glassOpacity);
  updateSavedTaskCount(state.savedTaskIds.size);
  closeDesktopProfileMenu();
  window.dispatchEvent(new Event('taskerph:auth-updated'));
  if (state.user && pendingNativePushOpen) {
    const pending = pendingNativePushOpen;
    pendingNativePushOpen = null;
    void handleNativePushOpen(pending);
  }
}
function formatActivityTimestamp(value) {
  if (!value) return 'Not recorded yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded yet' : new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
let accountActivityData = { users: [], events: [], reports: [], tasks: [], under_review_tasks: [], trends: [], stats: {} };
let staffDashboardData = { recent_reports: [], under_review_tasks: [] };
let adminNotificationAnnouncements = [];
let staffActionNotificationCount = 0;
let staffUnreadAnnouncementCount = 0;
let superadminTaskView = 'list';
let superadminUserPage = 1;
let superadminUserTotal = 0;
let superadminUserHasMore = false;
let adminReportRows = [];
let adminReportStaff = [];
let adminReportPage = 0;
let adminReportHasMore = false;
let adminReportTotal = 0;
let adminAuditRows = [];
let adminAuditPage = 0;
let adminAuditHasMore = false;
let adminAuditTotal = 0;
let adminOperationsLoading = false;
let adminOperationsData = { disputes: [], appeals: [], staff: [], announcements: [], analytics: {}, health: [], staffActivity: {} };
const bulkSuspensionSelection = new Map();
let announcementPreviewTimer = 0;
let adminOperationsStaff = [];
let adminUserSearchTimer = null;
let adminReportSearchTimer = null;
let adminAuditSearchTimer = null;
let superadminHasMoreTasks = false;
let superadminLoadingMoreTasks = false;
let superadminSearchingTasks = false;
let superadminTaskResultTotal = 0;
let superadminTaskSearchRequestId = 0;
let superadminTaskSearchTimer = null;
let superadminTaskQuery = { search: '', status: 'all' };
try { superadminTaskView = localStorage.getItem('taskerph-superadmin-task-view') === 'cards' ? 'cards' : 'list'; } catch (error) { void error; }
function renderAccountActivityUsers() {
  const filter = $('#account-activity-filter')?.value || 'all';
  const search = ($('#account-activity-search')?.value || '').trim().toLocaleLowerCase();
  const now = Date.now();
  const users = accountActivityData.users.filter((user) => filter === 'admins'
    ? user.role === 'admin' || user.role === 'superadmin'
    : filter === 'users' ? user.role === 'user' : true).filter((user) => {
      if (!search) return true;
      const name = `${user.first_name} ${user.middle_initial ? `${user.middle_initial} ` : ''}${user.last_name}`;
      return `${name} ${user.email} ${user.role}`.toLocaleLowerCase().includes(search);
    });
  $('#account-activity-users').innerHTML = users.length ? users.map((user) => {
    const recentlyActive = user.last_seen_at && now - new Date(user.last_seen_at).getTime() <= 5 * 60 * 1000;
    const name = `${user.first_name} ${user.middle_initial ? `${user.middle_initial}. ` : ''}${user.last_name}`.trim();
    return `<article class="rounded-lg border border-[#dbe3e7] p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><strong class="block truncate">${escapeHtml(name)}</strong><span class="block truncate text-xs text-[#68727c]">${escapeHtml(user.email)}</span></div><span class="account-activity-role">${escapeHtml(user.role)}</span></div><div class="mt-2 grid gap-1 text-xs text-[#4c5962] sm:grid-cols-2"><p>Last login: <strong>${escapeHtml(formatActivityTimestamp(user.last_login_at))}</strong></p><p>Last activity: <strong>${escapeHtml(recentlyActive ? 'Active in the last 5 min' : formatActivityTimestamp(user.last_seen_at))}</strong></p></div></article>`;
  }).join('') : `<p class="text-sm text-[#68727c]">No ${filter === 'admins' ? 'admins' : filter === 'users' ? 'users' : 'accounts'} found.</p>`;
}
function ensureAdminControls() {
  const roleSelects = [$('#admin-edit-user-form select[name="role"]'), $('#superadmin-user-filter')].filter(Boolean);
  roleSelects.forEach((select) => {
    for (const [value, label] of [['moderator','Moderator'],['support','Support']]) {
      if (![...select.options].some((option) => option.value === value)) select.add(new Option(label, value));
    }
  });
  const staffForm = $('#admin-form');
  if (staffForm && !staffForm.elements.role) {
    staffForm.querySelector('button[type="submit"],button:not([type])')?.insertAdjacentHTML('beforebegin','<label class="block text-sm font-bold lg:col-span-2">Staff role<select name="role" required class="form-control mt-2"><option value="admin">Admin · moderation</option><option value="moderator">Moderator · tasks, reports, disputes</option><option value="support">Support · read-only member records</option></select></label>');
  }
  const reports = $('#account-activity-reports');
  if (reports && !$('#admin-report-controls')) reports.insertAdjacentHTML('beforebegin','<div id="admin-report-controls" class="admin-workspace-controls"><label>Search reports<input id="admin-report-search" type="search" placeholder="Task, reason, reporter details"></label><label>Status<select id="admin-report-status"><option value="all">All statuses</option><option value="Open">Open</option><option value="Reviewed">Reviewed</option><option value="Dismissed">Dismissed</option></select></label><label>Reason<select id="admin-report-reason"><option value="all">All reasons</option><option>Scam or fraud</option><option>Inappropriate content</option><option>Misleading information</option><option>Other</option></select></label><label>From<input id="admin-report-from" type="date"></label><label>To<input id="admin-report-to" type="date"></label></div>');
  if (reports && !$('#admin-report-pagination')) reports.insertAdjacentHTML('afterend','<div id="admin-report-pagination" class="superadmin-pagination"></div>');
  const audit = $('#account-activity-events');
  if (audit && !$('#admin-audit-controls')) audit.insertAdjacentHTML('beforebegin','<div id="admin-audit-controls" class="admin-workspace-controls"><label>Search audit history<input id="admin-audit-search" type="search" placeholder="Administrator, action, target, reason"></label><button type="button" id="admin-audit-export" class="superadmin-load-more-button"><i class="fa-solid fa-download mr-2" aria-hidden="true"></i>Export all as CSV</button></div>');
  if (audit && !$('#admin-audit-pagination')) audit.insertAdjacentHTML('afterend','<div id="admin-audit-pagination" class="superadmin-pagination"></div>');
  if (!$('#staff-dashboard-page')) $('footer')?.insertAdjacentHTML('beforebegin','<section id="staff-dashboard-page" class="app-page page-shell hidden"><div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8"><div class="card overflow-hidden rounded-2xl bg-white shadow-xl"><div class="superadmin-topbar"><div class="superadmin-topbar-right"><span class="superadmin-avatar"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></span><span><strong id="staff-dashboard-name">Admin workspace</strong><small>Marketplace operations</small></span></div><div class="superadmin-topbar-right"><button type="button" id="staff-notification-trigger" class="superadmin-topbar-icon" title="Open admin action notifications" aria-label="Open admin action notifications"><i class="fa-regular fa-bell" aria-hidden="true"></i><b id="staff-notification-badge">0</b></button><button type="button" data-staff-dashboard-refresh class="touch-target rounded-lg border px-4 py-2 text-sm font-bold text-[#006f70]"><i class="fa-solid fa-rotate mr-2" aria-hidden="true"></i>Refresh</button></div></div><div class="flex items-start justify-between gap-4 border-b border-[#dbe3e7] p-5 sm:p-6"><div><p class="text-xs font-bold uppercase tracking-[.16em] text-[#008f8c]">TaskerPH · Admin</p><h1 class="mt-1 text-3xl font-bold">Admin dashboard</h1><p class="mt-1 text-sm text-[#68727c]">Review marketplace activity and jump into your authorized workspaces.</p></div></div><div class="space-y-5 p-5 sm:p-6"><nav class="superadmin-sidebar flex flex-wrap gap-2" aria-label="Admin sections"><button data-page="staff-dashboard-page" class="rounded-lg bg-[#006f70] px-4 py-2 text-sm font-bold text-white">Dashboard</button><button data-admin-page="task-management-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Tasks</button><button data-admin-page="report-management-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Reports</button><button data-admin-page="user-management-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Users</button></nav><div id="staff-dashboard-state" class="hidden" role="status" aria-live="polite"></div><div id="staff-dashboard-stats" class="superadmin-stats-grid"></div><div class="superadmin-dashboard-grid"><section class="superadmin-panel"><div class="superadmin-panel-heading"><div><h3>Latest tasks</h3><p>Most recently posted marketplace tasks</p></div><button data-admin-page="task-management-page" class="superadmin-text-link">Manage tasks</button></div><div id="staff-dashboard-tasks" class="superadmin-list"></div></section><section class="superadmin-panel"><div class="superadmin-panel-heading"><div><h3>Reports needing review</h3><p>Open reports assigned to your permissions</p></div><button data-admin-page="report-management-page" class="superadmin-text-link">View reports</button></div><div id="staff-dashboard-reports" class="superadmin-list"></div></section><section class="superadmin-panel superadmin-wide-panel"><div class="superadmin-panel-heading"><div><h3>Quick access</h3><p>Available admin workspaces</p></div></div><div id="staff-dashboard-shortcuts" class="superadmin-shortcuts"></div></section></div></div></div></div></section>');
  const userManagementHeader=$('#user-management-page .flex.flex-wrap.items-center.justify-between.gap-4');
  const canCreateStaff=state.user?.role==='superadmin';
  if(canCreateStaff&&userManagementHeader&&!$('#user-management-create-admin')){
    userManagementHeader.insertAdjacentHTML('beforeend','<button type="button" id="user-management-create-admin" data-modal="admin-modal" class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#006f70] px-4 text-sm font-bold text-white shadow-sm hover:bg-[#005b5c]"><i class="fa-solid fa-user-plus" aria-hidden="true"></i><span>Create admin</span></button>');
  }
  const userManagementCreateAdmin=$('#user-management-create-admin');
  if(userManagementCreateAdmin&&!canCreateStaff) userManagementCreateAdmin.remove();
  if (!$('#admin-operations-page')) $('footer')?.insertAdjacentHTML('beforebegin','<section id="admin-operations-page" class="app-page page-shell hidden"><div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8"><div class="card rounded-2xl bg-white p-5 shadow-xl sm:p-7"><div class="flex flex-wrap items-center justify-between gap-4"><div><p class="text-xs font-bold uppercase tracking-[.16em] text-[#008f8c]">Superadmin · Operations</p><h1 class="mt-1 text-3xl font-bold">Admin operations</h1><p class="mt-2 text-sm text-[#68727c]">Disputes, staff permissions, platform analytics, suspension appeals, announcements, and system status.</p></div><button type="button" data-admin-ops-refresh class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white"><i class="fa-solid fa-rotate mr-2" aria-hidden="true"></i>Refresh</button></div><nav class="superadmin-sidebar my-5 flex flex-wrap gap-2" aria-label="Superadmin sections"><button data-page="account-activity-modal" class="rounded-lg border px-4 py-2 text-sm font-bold">Dashboard</button><button data-admin-page="user-management-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Users</button><button data-admin-page="task-management-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Tasks</button><button data-admin-page="report-management-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Reports</button><button data-admin-page="audit-log-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Audit log</button><button data-admin-page="admin-operations-page" class="rounded-lg bg-[#006f70] px-4 py-2 text-sm font-bold text-white">Operations</button><button data-admin-page="superadmin-account-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Account settings</button></nav><div id="admin-operations-state" class="grid gap-5 lg:grid-cols-2" aria-live="polite"></div></div></div></section>');
  const operationsPage=$('#admin-operations-page');
  operationsPage?.classList.add('admin-operations-workspace');
  operationsPage?.querySelector('.card')?.classList.add('admin-operations-shell');
  operationsPage?.querySelector('.card > .flex.flex-wrap.items-center.justify-between.gap-4')?.classList.add('admin-operations-hero');
  operationsPage?.querySelector('.superadmin-sidebar')?.classList.add('admin-operations-nav');
  $('#admin-operations-state')?.classList.add('admin-operations-grid');
  document.querySelectorAll('.superadmin-sidebar').forEach((nav)=>{
    if(['admin','moderator'].includes(state.user?.role)&&!nav.querySelector('[data-admin-page="superadmin-account-page"]')){
      nav.insertAdjacentHTML('beforeend','<button data-admin-page="superadmin-account-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Account settings</button>');
    }
    let operations=nav.querySelector('[data-admin-page="admin-operations-page"]');
    if (!operations) {
      nav.insertAdjacentHTML('beforeend','<button data-admin-page="admin-operations-page" class="rounded-lg border px-4 py-2 text-sm font-bold">Operations</button>');
      operations=nav.querySelector('[data-admin-page="admin-operations-page"]');
    }
    const accountSettings=nav.querySelector('[data-admin-page="superadmin-account-page"]');
    if (operations&&accountSettings&&operations.nextElementSibling!==accountSettings) nav.insertBefore(operations,accountSettings);
    if (['admin','moderator'].includes(state.user?.role)) {
      const order=new Map([['dashboard',0],['staff-dashboard-page',0],['user-management-page',1],['task-management-page',2],['report-management-page',3],['superadmin-account-page',4],['audit-log-page',5],['admin-operations-page',6]]);
      const buttons=[...nav.children].filter((child)=>child.matches('button'));
      buttons.sort((a,b)=>{
        const target=(button)=>button.dataset.adminPage||(button.dataset.page==='account-activity-modal'?'dashboard':button.dataset.page)||'';
        return (order.get(target(a))??99)-(order.get(target(b))??99);
      }).forEach((button)=>nav.appendChild(button));
    }
  });
  const summary = $('#account-activity-summary');
  if (summary && !$('#superadmin-trends')) summary.insertAdjacentHTML('afterend','<section id="superadmin-trends" class="superadmin-panel superadmin-trends"><div class="superadmin-panel-heading"><div><h3>Platform trends</h3><p>Daily registrations, task posts, completions, and reports</p></div><button type="button" id="admin-trends-export" class="superadmin-text-link"><i class="fa-solid fa-download mr-1" aria-hidden="true"></i>Download CSV</button></div><div class="admin-workspace-controls superadmin-trend-controls"><label>Period<select id="admin-trend-days"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></label><label>Task category<select id="admin-trend-category"><option value="">All categories</option><option>Home &amp; Repair</option><option>Cleaning Services</option><option>Moving &amp; Transport</option><option>Delivery &amp; Logistics</option><option>IT &amp; Tech Support</option><option>Digital &amp; Creative</option><option>Events &amp; Entertainment</option><option>Errands &amp; Shopping</option><option>Tutoring &amp; Training</option><option>Beauty &amp; Wellness</option><option>Pet Care</option><option>Business Services</option></select></label></div><div id="superadmin-trend-chart"></div></section>');
  if (!$('#admin-suspension-modal')) document.body.insertAdjacentHTML('beforeend','<div id="admin-suspension-modal" class="modal-backdrop fixed inset-0 z-[108] hidden items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="admin-suspension-title"><section class="modal-panel w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><p id="admin-suspension-access-note" class="text-xs font-bold uppercase tracking-wider text-rose-600">Superadmin account controls</p><h2 id="admin-suspension-title" class="mt-2 text-2xl font-bold">Suspend account</h2><p id="admin-suspension-user" class="mt-1 text-sm text-slate-600"></p><form id="admin-suspension-form" class="mt-5 grid gap-4"><input type="hidden" name="user_id"><label class="grid gap-2 text-sm font-bold">Duration<select name="duration" class="form-control"><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="permanent">Indefinite</option></select></label><label class="grid gap-2 text-sm font-bold">Reason<textarea name="reason" required maxlength="1000" rows="3" class="form-control" placeholder="Explain the policy or safety reason"></textarea></label><div class="flex justify-end gap-2"><button type="button" data-close="admin-suspension-modal" class="touch-target rounded-lg border px-4 font-bold">Cancel</button><button type="submit" class="touch-target rounded-lg bg-rose-600 px-4 font-bold text-white">Suspend account</button></div></form></section></div>');
  const suspensionForm=$('#admin-suspension-form');
  if (suspensionForm && !suspensionForm.dataset.bound) {
    suspensionForm.dataset.bound='true';
    suspensionForm.addEventListener('submit',async(event)=>{
      event.preventDefault();
      const form=event.currentTarget;
      setBusy(form,true,'Suspending account...');
      try {
        const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'suspend_user',...Object.fromEntries(new FormData(form))})});
        closeModal('admin-suspension-modal');
        form.reset();
        notify(payload.message);
        if (state.user?.role==='superadmin') await loadAccountActivity();
        await loadAdminUsers(false,superadminUserPage);
      } catch(error) { notify(error.message,'error'); }
      finally { setBusy(form,false); }
    });
  }
}
function adminOpsCard(title, content, subtitle = '') {
  const section=title.toLowerCase().replace(/\s+/g,'-');
  const icons={'disputes':'fa-scale-balanced','suspension-appeals':'fa-shield-halved','staff-permissions':'fa-user-gear','platform-analytics':'fa-chart-line','announcements':'fa-bullhorn','system-health':'fa-heart-pulse'};
  return `<section class="admin-ops-card superadmin-panel" data-section="${section}"><header class="admin-ops-card-header"><span class="admin-ops-card-icon"><i class="fa-solid ${icons[section]||'fa-layer-group'}" aria-hidden="true"></i></span><div><h2>${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div></header><div class="admin-ops-card-content">${content}</div></section>`;
}
async function loadAdminOperations() {
  const container=$('#admin-operations-state');
  if (!container||state.user?.role!=='superadmin'||adminOperationsLoading) return;
  adminOperationsLoading=true;
  container.innerHTML='<p class="text-sm text-slate-500">Loading operations data…</p>';
  try {
    const days=Number($('#admin-analytics-days')?.value||30);
    const [disputes,appeals,staff,announcements,analytics,health,staffActivity]=await Promise.all([
      api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'list_disputes'})}),
      api('api/suspension_appeals',{method:'POST',body:JSON.stringify({action:'list',status:'Open'})}),
      api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'list_staff'})}),
      api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'list_announcements'})}),
      api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'admin_analytics',days})}),
      api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'admin_health'})}),
      api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'staff_activity_summary'})})
    ]);
    adminOperationsData={disputes:disputes.disputes||[],appeals:appeals.appeals||[],staff:staff.staff||[],announcements:announcements.announcements||[],analytics,health:health.health||[],staffActivity};
    adminOperationsStaff=disputes.staff||[];
    renderAdminOperations();
  } catch(error) {
    container.innerHTML=`<p class="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 lg:col-span-2">Could not load admin operations: ${escapeHtml(error.message)}</p>`;
  } finally { adminOperationsLoading=false; }
}
function renderAdminOperations() {
  const container=$('#admin-operations-state');
  if (!container) return;
  const {disputes,appeals,staff,announcements,analytics,health,staffActivity}=adminOperationsData;
  const disputeHtml=disputes.length?disputes.map((entry)=>{
    const caseKey=`dispute:${Number(entry.id)}`;
    const notes=(entry.notes||[]).map((note)=>`<p class="text-sm"><b>${escapeHtml(note.author_name)}</b> · ${escapeHtml(formatActivityTimestamp(note.created_at))}<br>${escapeHtml(note.note)}</p>`).join('')||'<p class="text-xs text-slate-500">No private notes.</p>';
    const assignees=adminOperationsStaff.map((person)=>`<option value="${Number(person.id)}" ${Number(entry.assigned_to)===Number(person.id)?'selected':''}>${escapeHtml(`${person.first_name} ${person.last_name} (${person.role})`)}</option>`).join('');
    return `<article class="mb-3 rounded-lg border p-3"><div class="flex flex-wrap justify-between gap-2"><strong>${escapeHtml(entry.task?.title||`Task #${entry.task_id}`)}</strong><span class="superadmin-status-pill" data-status="${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span></div><p class="mt-2 whitespace-pre-line text-sm text-slate-600">${escapeHtml(entry.details)}</p><p class="mt-2 text-xs text-slate-500">Submitted ${escapeHtml(formatActivityTimestamp(entry.created_at))} · ${escapeHtml(entry.task?.owner?`${entry.task.owner.first_name} ${entry.task.owner.last_name}`:'Member')}</p><div class="mt-3 grid gap-2 sm:grid-cols-2"><label class="text-xs font-bold">Assignee<select data-case-assignee="${caseKey}" class="form-control mt-1"><option value="">Unassigned</option>${assignees}</select></label><label class="text-xs font-bold">Priority<select data-case-priority="${caseKey}" class="form-control mt-1">${['low','normal','high','urgent'].map((value)=>`<option value="${value}" ${(entry.priority||'normal')===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select></label><label class="text-xs font-bold">SLA due<input type="datetime-local" data-case-sla="${caseKey}" value="${entry.sla_due_at?new Date(entry.sla_due_at).toISOString().slice(0,16):''}" class="form-control mt-1"></label><button type="button" data-case-save="${caseKey}" class="self-end rounded-lg border px-3 py-2 text-xs font-bold">Save case workflow</button></div><div class="mt-3 rounded-lg bg-slate-50 p-3"><strong class="text-xs uppercase tracking-wide">Private staff notes</strong><div class="mt-2 space-y-2">${notes}<div class="mt-2 flex gap-2"><input data-case-note-input="${caseKey}" maxlength="2000" class="form-control" placeholder="Add a private note"><button type="button" data-case-note="${caseKey}" class="rounded-lg border px-3 py-2 text-xs font-bold">Add note</button></div></div></div>${entry.status==='Open'?`<div class="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]"><select data-dispute-status="${Number(entry.task_id)}" class="form-control"><option>In Progress</option><option>Completed</option><option>Cancelled</option></select><input data-dispute-note="${Number(entry.task_id)}" class="form-control" maxlength="1000" placeholder="Resolution note" aria-label="Resolution note"><button type="button" data-ops-resolve-dispute="${Number(entry.task_id)}" class="rounded-lg bg-[#006f70] px-3 py-2 text-xs font-bold text-white">Resolve</button></div>`:''}</article>`;
  }).join(''):'<p class="text-sm text-slate-500">No disputes found.</p>';
  const appealHtml=appeals.length?appeals.map((entry)=>`<article class="mb-3 rounded-lg border p-3"><strong>${escapeHtml(entry.claimant_name)}</strong><p class="text-xs text-slate-500">${escapeHtml(entry.claimant_email)} · ${escapeHtml(formatActivityTimestamp(entry.created_at))}</p><p class="mt-2 whitespace-pre-line text-sm">${escapeHtml(entry.reason)}</p><div class="mt-3 flex gap-2"><button type="button" data-ops-review-appeal="${Number(entry.id)}" data-appeal-status="Approved" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Approve &amp; reactivate</button><button type="button" data-ops-review-appeal="${Number(entry.id)}" data-appeal-status="Denied" class="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700">Deny</button></div></article>`).join(''):'<p class="text-sm text-slate-500">No open suspension appeals.</p>';
  const staffHtml=staff.length?staff.map((entry)=>`<form data-ops-staff-form="${Number(entry.id)}" class="mb-3 rounded-lg border p-3"><strong>${escapeHtml(`${entry.first_name} ${entry.last_name}`)}</strong><span class="ml-2 account-activity-role">${escapeHtml(entry.role)}</span><p class="mb-2 text-xs text-slate-500">${escapeHtml(entry.email)}</p><div class="grid gap-2 sm:grid-cols-2">${[['can_view_users','View user records'],['can_moderate_tasks','Moderate tasks'],['can_review_reports','Review reports'],['can_resolve_disputes','Resolve disputes']].map(([key,label])=>`<label class="flex items-center gap-2 text-sm"><input type="checkbox" name="${key}" ${entry.permissions[key]?'checked':''}>${label}</label>`).join('')}</div><button class="mt-3 rounded-lg bg-[#006f70] px-3 py-2 text-xs font-bold text-white">Save permissions</button></form>`).join(''):'<p class="text-sm text-slate-500">No staff accounts have been created yet.</p>';
  const categories=analytics.categories||[];
  const summary=analytics.summary||{};
  const analyticsHtml=`<label class="mb-3 inline-flex items-center gap-2 text-sm font-semibold">Period<select id="admin-analytics-days" class="form-control"><option value="7" ${analytics.days===7?'selected':''}>7 days</option><option value="30" ${analytics.days===30?'selected':''}>30 days</option><option value="90" ${analytics.days===90?'selected':''}>90 days</option></select></label><div class="grid grid-cols-2 gap-2 sm:grid-cols-3">${[['Registrations',summary.registrations],['Active now',summary.active_users],['Tasks created',summary.tasks_created],['Completed',summary.tasks_completed],['Cancelled',summary.tasks_cancelled],['Disputes',summary.disputes_opened],['Reports',summary.reports_opened],['Avg. report response (hrs)',summary.avg_report_response_hours??'—'],['Completion rate',`${summary.completion_rate??0}%`],['Cancellation rate',`${summary.cancellation_rate??0}%`],['Dispute rate',`${summary.dispute_rate??0}%`]].map(([label,value])=>`<div class="rounded-lg bg-slate-50 p-3"><small class="block text-xs text-slate-500">${label}</small><strong>${escapeHtml(String(value??0))}</strong></div>`).join('')}</div><h3 class="mb-2 mt-4 font-bold">Task categories</h3>${categories.length?`<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr><th>Category</th><th>Tasks</th><th>Completed</th><th>Cancelled</th></tr></thead><tbody>${categories.map((row)=>`<tr><td>${escapeHtml(row.category||'Uncategorized')}</td><td>${Number(row.tasks)||0}</td><td>${Number(row.completed)||0}</td><td>${Number(row.cancelled)||0}</td></tr>`).join('')}</tbody></table></div>`:'<p class="text-sm text-slate-500">No tasks in this period.</p>'}`;
  const healthHtml=health.map((item)=>`<div class="mb-2 flex items-center justify-between gap-3 rounded-lg border p-3"><strong>${escapeHtml(item.name)}</strong><span class="${item.status==='Operational'?'text-emerald-700':'text-rose-700'} text-sm font-bold">${escapeHtml(item.status)}</span><small class="text-xs text-slate-500">${escapeHtml(formatActivityTimestamp(item.checked_at))}</small></div>`).join('')||'<p class="text-sm text-slate-500">No status checks available.</p>';
  const announcementsHtml=`<form id="admin-announcement-form" class="mb-4 grid gap-3"><input type="hidden" name="id"><label class="text-sm font-semibold">Title<input name="title" required maxlength="120" class="form-control mt-1"></label><label class="text-sm font-semibold">Message<textarea name="body" required maxlength="2000" rows="3" class="form-control mt-1"></textarea></label><div class="grid gap-3 sm:grid-cols-2"><label class="text-sm font-semibold">Audience<select name="audience" class="form-control mt-1"><option value="everyone">Everyone</option><option value="members">Members</option><option value="staff">Staff</option></select></label><label class="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" name="is_published">Publish immediately</label></div><div class="grid gap-3 sm:grid-cols-2"><label class="text-sm font-semibold">Starts at<input type="datetime-local" name="starts_at" class="form-control mt-1"></label><label class="text-sm font-semibold">Expires at (optional)<input type="datetime-local" name="expires_at" class="form-control mt-1"></label></div><button type="submit" class="justify-self-start rounded-lg bg-[#006f70] px-4 py-2 text-sm font-bold text-white">Create announcement</button></form>${announcements.length?announcements.map((item)=>`<article class="mb-2 rounded-lg border p-3"><div class="flex justify-between gap-2"><strong>${escapeHtml(item.title)}</strong><span class="text-xs font-bold ${item.is_published?'text-emerald-700':'text-slate-500'}">${item.is_published?'Published':'Draft'}</span></div><p class="mt-1 text-sm text-slate-600">${escapeHtml(item.body)}</p><small class="text-xs text-slate-500">${escapeHtml(item.audience)} · Starts ${escapeHtml(formatActivityTimestamp(item.starts_at))}</small><div class="mt-2 flex gap-2"><button type="button" data-ops-edit-announcement="${Number(item.id)}" class="rounded-lg border px-3 py-1 text-xs font-bold">Edit</button><button type="button" data-ops-delete-announcement="${Number(item.id)}" class="rounded-lg border border-rose-300 px-3 py-1 text-xs font-bold text-rose-700">Delete</button></div></article>`).join(''):'<p class="text-sm text-slate-500">No announcements created.</p>'}`;
  const staffSummary=staffActivity.staff||[];
  const totalStaffActions=staffSummary.reduce((total,item)=>total+(Number(item.action_count)||0),0);
  const staffActivityHtml=`<div class="mb-3 grid grid-cols-2 gap-2"><div class="rounded-lg bg-slate-50 p-3"><small class="block text-xs text-slate-500">Staff accounts</small><strong>${staffSummary.length}</strong></div><div class="rounded-lg bg-slate-50 p-3"><small class="block text-xs text-slate-500">Actions in last ${Number(staffActivity.days)||30} days</small><strong>${totalStaffActions}</strong></div></div>${staffSummary.length?staffSummary.map((item)=>`<article class="mb-2 rounded-lg border p-3"><strong>${escapeHtml(`${item.first_name||''} ${item.last_name||''}`.trim()||'Staff')} · ${escapeHtml(item.role||'staff')}</strong><p class="text-xs text-slate-500">${escapeHtml(item.email||'')} · ${Number(item.action_count)||0} audited actions</p><p class="mt-1 text-sm">Last action: ${escapeHtml(formatActivityTimestamp(item.last_action_at))}</p></article>`).join(''):'<p class="text-sm text-slate-500">No staff activity summary available.</p>'}`;
  container.innerHTML=adminOpsCard('Disputes',disputeHtml,'Assignments, private notes, priority, SLA, and resolution')+adminOpsCard('Suspension appeals',appealHtml,'Approving an appeal immediately reactivates that account.')+adminOpsCard('Staff permissions',staffHtml,'Explicit permission overrides for Admin, Moderator, and Support accounts.')+adminOpsCard('Staff activity',staffActivityHtml,'Recent administrative actions for staff accountability.')+adminOpsCard('Platform analytics',analyticsHtml,`Last ${analytics.days||30} days`)+adminOpsCard('Announcements',announcementsHtml,'Preview the message and estimate its eligible audience before scheduling.')+adminOpsCard('System health',healthHtml,'Safe service and database availability checks; no credentials are exposed.');
  const announcementForm=$('#admin-announcement-form');
  if(announcementForm&&!$('#admin-announcement-preview')) announcementForm.insertAdjacentHTML('afterend','<section id="admin-announcement-preview" class="mb-4 rounded-xl border border-teal-200 bg-teal-50 p-4" aria-live="polite"><h3 class="font-bold text-teal-950">Audience and announcement preview</h3><p data-announcement-audience class="mt-1 text-sm text-teal-900">Checking eligible audience…</p><article class="mt-3 rounded-lg bg-white p-3"><strong data-announcement-preview-title>Announcement title</strong><p data-announcement-preview-body class="mt-1 whitespace-pre-wrap text-sm text-slate-700">Your announcement message preview will appear here.</p><small data-announcement-preview-timing class="mt-2 block text-xs text-slate-500"></small></article></section>');
  void refreshAnnouncementPreview();
}
async function refreshAnnouncementPreview(){
  const form=$('#admin-announcement-form'), panel=$('#admin-announcement-preview');
  if(!form||!panel) return;
  const data=new FormData(form);
  const title=String(data.get('title')||'').trim(), body=String(data.get('body')||'').trim();
  panel.querySelector('[data-announcement-preview-title]').textContent=title||'Announcement title';
  panel.querySelector('[data-announcement-preview-body]').textContent=body||'Your announcement message preview will appear here.';
  const startsAt=data.get('starts_at'), expiresAt=data.get('expires_at');
  panel.querySelector('[data-announcement-preview-timing]').textContent=`${data.has('is_published')?'Published':'Draft'} · Starts ${startsAt?formatActivityTimestamp(new Date(startsAt).toISOString()):'immediately'}${expiresAt?` · Expires ${formatActivityTimestamp(new Date(expiresAt).toISOString())}`:''}`;
  const audience=String(data.get('audience')||'everyone');
  panel.querySelector('[data-announcement-audience]').textContent='Estimating eligible recipients…';
  try{
    const result=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'announcement_audience_preview',audience,starts_at:startsAt?new Date(startsAt).toISOString():null,expires_at:expiresAt?new Date(expiresAt).toISOString():null,is_published:data.has('is_published')})});
    const count=Number(result.estimated_recipients??result.counts?.[audience]??result.audience_count??result.count);
    panel.querySelector('[data-announcement-audience]').textContent=Number.isFinite(count)?`${count} eligible ${audience==='everyone'?'accounts':audience==='staff'?'staff accounts':'member accounts'} will receive this when it becomes active.`:'Audience estimate is unavailable.';
  }catch(error){panel.querySelector('[data-announcement-audience]').textContent=`Could not estimate audience: ${error.message}`;}
}
document.addEventListener('click',async(event)=>{
  if(event.target.closest('[data-staff-dashboard-refresh]')){await loadStaffDashboard();return;}
  const refresh=event.target.closest('[data-admin-ops-refresh]');
  if(refresh){await loadAdminOperations();return;}
  const saveCase=event.target.closest('[data-case-save]');
  if(saveCase){
    const [caseType,rawId]=saveCase.dataset.caseSave.split(':');
    const key=saveCase.dataset.caseSave;
    const assignedValue=document.querySelector(`[data-case-assignee="${key}"]`)?.value||'';
    const priority=document.querySelector(`[data-case-priority="${key}"]`)?.value||'normal';
    const slaValue=document.querySelector(`[data-case-sla="${key}"]`)?.value||'';
    if(!slaValue||!Number.isFinite(new Date(slaValue).getTime())){notify('Set a valid SLA due date before saving this case.','error');document.querySelector(`[data-case-sla="${key}"]`)?.focus();return;}
    try{
      const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'update_moderation_case',case_type:caseType,case_id:Number(rawId),assigned_to:assignedValue?Number(assignedValue):null,priority,sla_due_at:new Date(slaValue).toISOString()})});
      notify(payload.message);
      if(caseType==='report') await loadAdminReports(false); else await loadAdminOperations();
    }catch(error){notify(error.message,'error');}
    return;
  }
  const addCaseNote=event.target.closest('[data-case-note]');
  if(addCaseNote){
    const [caseType,rawId]=addCaseNote.dataset.caseNote.split(':');
    const key=addCaseNote.dataset.caseNote;
    const input=document.querySelector(`[data-case-note-input="${key}"]`);
    const note=input?.value.trim()||'';
    if(!note){notify('Enter a private note first.','error');return;}
    try{
      const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'add_moderation_note',case_type:caseType,case_id:Number(rawId),note})});
      notify(payload.message);
      if(caseType==='report') await loadAdminReports(false); else await loadAdminOperations();
    }catch(error){notify(error.message,'error');}
    return;
  }
  const bulkReview=event.target.closest('[data-bulk-suspend-review]');
  if(bulkReview){
    if(!bulkSuspensionSelection.size){notify('Select at least one unsuspended member account first.','error');return;}
    if(bulkSuspensionSelection.size>50){notify('Bulk suspension is limited to 50 accounts at a time.','error');return;}
    if(!$('#bulk-suspend-modal')) document.body.insertAdjacentHTML('beforeend','<div id="bulk-suspend-modal" class="modal-backdrop fixed inset-0 z-[129] hidden items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="bulk-suspend-title"><section class="modal-panel max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"><p class="text-xs font-bold uppercase tracking-wider text-amber-700">Review before applying</p><h2 id="bulk-suspend-title" class="mt-1 text-2xl font-bold">Bulk suspend members</h2><p id="bulk-suspend-preview" class="mt-2 text-sm text-slate-600"></p><form id="bulk-suspend-form" class="mt-4 grid gap-4"><label class="grid gap-2 text-sm font-bold">Duration<select name="duration" required class="form-control"><option value="24h">24 hours</option><option value="7d" selected>7 days</option><option value="30d">30 days</option><option value="permanent">Indefinite</option></select></label><label class="grid gap-2 text-sm font-bold">Reason for every selected account<textarea name="reason" required minlength="3" maxlength="1000" rows="3" class="form-control" placeholder="Explain the policy or safety reason"></textarea></label><div class="flex justify-end gap-2"><button type="button" data-close="bulk-suspend-modal" class="touch-target rounded-lg border px-4 font-bold">Cancel</button><button type="submit" class="touch-target rounded-lg bg-amber-700 px-4 font-bold text-white">Confirm bulk suspension</button></div></form></section></div>');
    const preview=$('#bulk-suspend-preview');
    if(preview) preview.innerHTML=`The following ${bulkSuspensionSelection.size} member accounts will be suspended. This action will be written to the audit log:<ul class="mt-2 list-disc pl-5">${[...bulkSuspensionSelection.values()].map((name)=>`<li>${escapeHtml(name)}</li>`).join('')}</ul>`;
    const form=$('#bulk-suspend-form');
    if(form&&!form.dataset.bound){
      form.dataset.bound='true';
      form.addEventListener('submit',async(submitEvent)=>{
        submitEvent.preventDefault();
        if(!form.reportValidity())return;
        const ids=[...bulkSuspensionSelection.keys()];
        setBusy(form,true,'Suspending selected accounts...');
        try{
          const result=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'bulk_suspend_members',user_ids:ids,...Object.fromEntries(new FormData(form))})});
          bulkSuspensionSelection.clear();
          closeModal('bulk-suspend-modal');
          form.reset();
          notify(result.message);
          await loadAdminUsers(true);
        }catch(error){notify(error.message,'error');}
        finally{setBusy(form,false);}
      });
    }
    openModal('#bulk-suspend-modal');
    return;
  }
  const resolve=event.target.closest('[data-ops-resolve-dispute]');
  if(resolve){
    const taskId=Number(resolve.dataset.opsResolveDispute), card=resolve.closest('article');
    const resolution=card?.querySelector(`[data-dispute-note="${taskId}"]`)?.value.trim();
    const status=card?.querySelector(`[data-dispute-status="${taskId}"]`)?.value;
    if(!resolution){notify('Enter a resolution note before closing this dispute.','error');return;}
    setButtonBusy(resolve,true,'Resolving...');
    try{const payload=await api('api/task_lifecycle',{method:'POST',body:JSON.stringify({action:'resolve_dispute',task_id:taskId,status,resolution})});notify(payload.message);await loadAdminOperations();}
    catch(error){notify(error.message,'error');}
    finally{setButtonBusy(resolve,false);}
    return;
  }
  const review=event.target.closest('[data-ops-review-appeal]');
  if(review){
    const status=review.dataset.appealStatus;
    const decision=await decisionModal({title:`${status} this suspension appeal?`,message:status==='Approved'?'Approving immediately removes the user suspension.':'The user will remain suspended.',confirmLabel:`${status} appeal`,withReason:true,reasonLabel:'Resolution note'});
    if(!decision)return;
    if(!decision.reason){notify('A resolution note is required.','error');return;}
    try{const payload=await api('api/suspension_appeals',{method:'POST',body:JSON.stringify({action:'review',appeal_id:review.dataset.opsReviewAppeal,status,note:decision.reason})});notify(payload.message);await loadAdminOperations();}
    catch(error){notify(error.message,'error');}
    return;
  }
  const edit=event.target.closest('[data-ops-edit-announcement]');
  if(edit){
    const item=adminOperationsData.announcements.find((entry)=>Number(entry.id)===Number(edit.dataset.opsEditAnnouncement));
    const form=$('#admin-announcement-form');
    if(!item||!form)return;
    form.elements.id.value=String(item.id);
    form.elements.title.value=item.title;
    form.elements.body.value=item.body;
    form.elements.audience.value=item.audience;
    form.elements.is_published.checked=item.is_published;
    form.elements.starts_at.value=item.starts_at?new Date(item.starts_at).toISOString().slice(0,16):'';
    form.elements.expires_at.value=item.expires_at?new Date(item.expires_at).toISOString().slice(0,16):'';
    form.querySelector('button[type="submit"]').textContent='Save announcement';
    form.scrollIntoView({behavior:'smooth',block:'center'});
    void refreshAnnouncementPreview();
    return;
  }
  const remove=event.target.closest('[data-ops-delete-announcement]');
  if(remove){
    const confirmed=await decisionModal({title:'Delete this announcement?',message:'This removes the announcement and its read receipts.',confirmLabel:'Delete announcement',danger:true});
    if(!confirmed)return;
    try{const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'delete_announcement',id:remove.dataset.opsDeleteAnnouncement})});notify(payload.message);await loadAdminOperations();}
    catch(error){notify(error.message,'error');}
  }
});
document.addEventListener('submit',async(event)=>{
  const staffForm=event.target.closest('[data-ops-staff-form]');
  if(staffForm){
    event.preventDefault();
    const form=new FormData(staffForm);
    const permissionNames=['can_view_users','can_moderate_tasks','can_review_reports','can_resolve_disputes'];
    const payloadData={action:'update_staff_permissions',user_id:Number(staffForm.dataset.opsStaffForm)};
    permissionNames.forEach((key)=>{payloadData[key]=form.has(key);});
    setBusy(staffForm,true,'Saving permissions...');
    try{const result=await api('api/admin_actions',{method:'POST',body:JSON.stringify(payloadData)});notify(result.message);await loadAdminOperations();}
    catch(error){notify(error.message,'error');}
    finally{setBusy(staffForm,false);}
    return;
  }
  const announcementForm=event.target.closest('#admin-announcement-form');
  if(announcementForm){
    event.preventDefault();
    if(!announcementForm.reportValidity())return;
    const fields=new FormData(announcementForm);
    const data=Object.fromEntries(fields);
    data.is_published=fields.has('is_published');
    for(const key of ['starts_at','expires_at']) if(data[key]) data[key]=new Date(data[key]).toISOString(); else if(key==='expires_at') data[key]=null;
    setBusy(announcementForm,true,'Saving announcement...');
    try{const result=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'save_announcement',...data})});notify(result.message);announcementForm.reset();announcementForm.elements.id.value='';announcementForm.querySelector('button[type="submit"]').textContent='Create announcement';await loadAdminOperations();}
    catch(error){notify(error.message,'error');}
    finally{setBusy(announcementForm,false);}
  }
});
document.addEventListener('change',(event)=>{
  if(event.target.matches('#admin-analytics-days')) void loadAdminOperations();
});
function renderAdminReportQueue() {
  const container = $('#account-activity-reports');
  if (!container) return;
  const rows = adminReportRows;
  container.innerHTML = rows.length ? rows.map((report) => {
    const task = report.task || {}, reporter = report.reporter || {};
    const taskTitle = task.title || 'Removed task';
    const ageHours = Math.max(0,Math.floor((Date.now()-new Date(report.created_at).getTime())/3_600_000));
    const age = ageHours >= 24 ? `${Math.floor(ageHours/24)}d waiting` : `${ageHours}h waiting`;
    const caseKey=`report:${Number(report.id)}`;
    const notes=(report.notes||[]).map((note)=>`<p class="text-sm"><b>${escapeHtml(note.author_name)}</b> · ${escapeHtml(formatActivityTimestamp(note.created_at))}<br>${escapeHtml(note.note)}</p>`).join('')||'<p class="text-xs text-slate-500">No private notes.</p>';
    const assignees=adminReportStaff.map((person)=>`<option value="${Number(person.id)}" ${Number(report.assigned_to)===Number(person.id)?'selected':''}>${escapeHtml(`${person.first_name} ${person.last_name} (${person.role})`)}</option>`).join('');
    return `<article class="superadmin-report-row admin-report-card" data-admin-report-row="${Number(report.id)}"><div class="superadmin-report-main"><div class="superadmin-report-heading"><div class="min-w-0"><span class="superadmin-report-kicker">${Number(report.task_report_count)||1} report${Number(report.task_report_count)===1?'':'s'} on task · ${Number(report.task_open_report_count)||0} open · ${escapeHtml(report.reason)} · ${escapeHtml(age)}</span><strong>${escapeHtml(taskTitle)}</strong></div><span class="superadmin-report-status" data-status="${escapeHtml(report.status)}">${escapeHtml(report.status)}</span></div><p class="superadmin-report-count">${escapeHtml(`${reporter.first_name||''} ${reporter.last_name||''}`.trim()||'Member')} · ${escapeHtml(reporter.email||'')} · Submitted ${escapeHtml(formatActivityTimestamp(report.created_at))}</p><p class="admin-report-details">${escapeHtml(report.details||'No additional details provided.')}</p>${report.resolution_note?`<p class="admin-report-resolution"><strong>Resolution:</strong> ${escapeHtml(report.resolution_note)}</p>`:''}<div class="superadmin-report-actions"><button type="button" data-superadmin-view-profile="${Number(report.reporter_id)||0}" class="superadmin-report-button superadmin-report-button-view"><i class="fa-regular fa-user" aria-hidden="true"></i><span>Reporter profile</span></button>${task.id?`<button type="button" data-superadmin-view-task="${Number(task.id)}" class="superadmin-report-button superadmin-report-button-view"><i class="fa-regular fa-eye" aria-hidden="true"></i><span>View task</span></button>`:'<span class="superadmin-report-removed">Task removed</span>'}</div></div><div class="mt-3 grid gap-2 sm:grid-cols-2"><label class="text-xs font-bold">Assignee<select data-case-assignee="${caseKey}" class="form-control mt-1"><option value="">Unassigned</option>${assignees}</select></label><label class="text-xs font-bold">Priority<select data-case-priority="${caseKey}" class="form-control mt-1">${['low','normal','high','urgent'].map((value)=>`<option value="${value}" ${(report.priority||'normal')===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select></label><label class="text-xs font-bold">SLA due<input type="datetime-local" data-case-sla="${caseKey}" value="${report.sla_due_at?new Date(report.sla_due_at).toISOString().slice(0,16):''}" class="form-control mt-1"></label><button type="button" data-case-save="${caseKey}" class="self-end rounded-lg border px-3 py-2 text-xs font-bold">Save case workflow</button></div><div class="mt-3 rounded-lg bg-slate-50 p-3"><strong class="text-xs uppercase tracking-wide">Private staff notes</strong><div class="mt-2 space-y-2">${notes}<div class="mt-2 flex gap-2"><input data-case-note-input="${caseKey}" maxlength="2000" class="form-control" placeholder="Add a private note"><button type="button" data-case-note="${caseKey}" class="rounded-lg border px-3 py-2 text-xs font-bold">Add note</button></div></div></div>${report.status==='Open'?`<div class="superadmin-report-actions admin-report-review"><label>Resolution note<textarea name="resolution_note" maxlength="1000" rows="2" placeholder="Record the decision and any action taken"></textarea></label><button type="button" data-review-report="${Number(report.id)}" data-report-status="Reviewed" class="superadmin-report-button superadmin-report-button-review">Mark reviewed</button><button type="button" data-review-report="${Number(report.id)}" data-report-status="Dismissed" class="superadmin-report-button superadmin-report-button-dismiss">Dismiss</button></div>`:''}</article>`;
  }).join('') : '<p class="p-4 text-sm text-slate-500">No reports match these filters.</p>';
  const pagination = $('#admin-report-pagination');
  if (pagination) pagination.innerHTML = `<span>${adminReportRows.length ? `Page ${adminReportPage+1} · ${adminReportTotal} matching reports` : 'No reports'}</span><div><button type="button" data-admin-report-page="${adminReportPage-1}" ${adminReportPage===0?'disabled':''} aria-label="Previous report page"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><strong>${adminReportPage+1}</strong><button type="button" data-admin-report-page="${adminReportPage+1}" ${adminReportHasMore?'':'disabled'} aria-label="Next report page"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>`;
}
async function loadAdminReports(reset = false) {
  if (state.user?.role === 'superadmin') ensureAdminControls();
  if (!['superadmin','admin','moderator'].includes(state.user?.role)) return;
  if (reset) adminReportPage = 0;
  const params = {
    action:'list_reports', offset:adminReportPage*50,
    search:$('#admin-report-search')?.value.trim()||'',
    status:$('#admin-report-status')?.value||'all',
    reason:$('#admin-report-reason')?.value||'all',
    from:$('#admin-report-from')?.value||'',
    to:$('#admin-report-to')?.value||''
  };
  try {
    const payload = await api('api/admin_actions',{method:'POST',body:JSON.stringify(params)});
    adminReportRows = payload.reports||[];
    adminReportStaff=payload.staff||[];
    adminReportTotal=Number(payload.total_count)||0;
    adminReportHasMore = Boolean(payload.has_more);
    renderAdminReportQueue();
  } catch (error) { notify(error.message,'error'); }
}
function renderAdminAudit() {
  const container = $('#account-activity-events');
  if (!container) return;
  const olderEvents=adminAuditPage===0?accountActivityData.events.map((entry)=>`<article class="superadmin-feed-row admin-audit-row"><span class="superadmin-feed-icon"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></span><div class="min-w-0"><strong>${escapeHtml(entry.summary)}</strong><small>${escapeHtml(entry.user?`${entry.user.first_name} ${entry.user.last_name} · ${entry.user.email}`:'System')} · ${escapeHtml(formatActivityTimestamp(entry.created_at))} · Legacy activity</small></div></article>`):'';
  container.innerHTML = adminAuditRows.length||olderEvents ? `${adminAuditRows.map((entry) => `<article class="superadmin-feed-row admin-audit-row"><span class="superadmin-feed-icon"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></span><div class="min-w-0"><strong>${escapeHtml(entry.action.replaceAll('_',' '))} · ${escapeHtml(entry.target_label||entry.target_type||'Platform')}</strong><small>${escapeHtml(entry.actor_name)} · ${escapeHtml(entry.actor_email)} · ${escapeHtml(formatActivityTimestamp(entry.created_at))}</small>${entry.reason?`<p>${escapeHtml(entry.reason)}</p>`:''}${entry.before_state||entry.after_state?`<details><summary>Change details</summary><pre>${escapeHtml(JSON.stringify({before:entry.before_state,after:entry.after_state},null,2))}</pre></details>`:''}</div></article>`).join('')}${olderEvents}` : '<p class="p-4 text-sm text-slate-500">No audit events match this search.</p>';
  const pagination = $('#admin-audit-pagination');
  if (pagination) pagination.innerHTML = `<span>Page ${adminAuditPage+1} · ${adminAuditTotal} events</span><div><button type="button" data-admin-audit-page="${adminAuditPage-1}" ${adminAuditPage===0?'disabled':''} aria-label="Previous audit page"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><strong>${adminAuditPage+1}</strong><button type="button" data-admin-audit-page="${adminAuditPage+1}" ${adminAuditHasMore?'':'disabled'} aria-label="Next audit page"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>`;
}
async function loadAdminAudit(reset = false) {
  if (state.user?.role !== 'superadmin') return;
  ensureAdminControls();
  if (reset) adminAuditPage = 0;
  try {
    const payload = await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'list_audit',offset:adminAuditPage*50,search:$('#admin-audit-search')?.value.trim()||''})});
    adminAuditRows=payload.events||[];
    adminAuditTotal=Number(payload.total_count)||0;
    adminAuditHasMore=Boolean(payload.has_more);
    if (adminAuditPage===0 && !$('#admin-audit-search')?.value.trim()) accountActivityData.events=accountActivityData.events||[];
    renderAdminAudit();
  } catch (error) { notify(error.message,'error'); }
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
async function exportAuditCsv() {
  const events = [];
  try {
    for (let offset=0;;offset+=500) {
      const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'export_audit',offset})});
      events.push(...(payload.events||[]));
      if (!payload.has_more) break;
    }
    const columns=['created_at','actor_name','actor_email','action','target_type','target_id','target_label','reason','before_state','after_state'];
    const csv=[columns.join(','),...events.map((event)=>columns.map((column)=>csvCell(typeof event[column]==='object'?JSON.stringify(event[column]):event[column])).join(','))].join('\r\n');
    const link=document.createElement('a');
    link.href=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));
    link.download=`taskerph-admin-audit-${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    notify(`Exported ${events.length} audit events.`);
  } catch (error) { notify(error.message,'error'); }
}
async function loadAdminUsers(reset = false, page = 1) {
  if (state.user?.role !== 'superadmin' && !state.user?.staff_permissions?.can_view_users) return;
  if (reset) page=1;
  superadminUserPage=page;
  try {
    const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'list_users',offset:(page-1)*50,search:$('#superadmin-user-search')?.value.trim()||'',role:$('#superadmin-user-filter')?.value||'all'})});
    accountActivityData.users=payload.users||[];
    superadminUserTotal=Number(payload.total_count)||0;
    superadminUserHasMore=Boolean(payload.has_more);
    renderSuperadminUsers();
  } catch(error) { notify(error.message,'error'); }
}
async function loadModeratorTasks() {
  if (!['admin','moderator'].includes(state.user?.role)) return;
  try {
    const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'more_tasks',offset:0,search:'',status:'all'})});
    accountActivityData.tasks=payload.tasks||[];
    superadminHasMoreTasks=Boolean(payload.has_more_tasks);
    superadminTaskResultTotal=Number(payload.total_count)||0;
    superadminTaskQuery={search:'',status:'all'};
    renderSuperadminTasks();
  } catch(error) { notify(error.message,'error'); }
}
async function loadStaffDashboard() {
  if (!['admin','moderator'].includes(state.user?.role)) return;
  const stateBox=$('#staff-dashboard-state');
  if (stateBox) {
    stateBox.textContent='Loading your admin dashboard…';
    stateBox.className='superadmin-dashboard-state';
  }
  try {
    const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'staff_dashboard'})});
    renderStaffDashboard(payload);
    if (stateBox) stateBox.className='hidden';
  } catch(error) {
    if (stateBox) {
      stateBox.textContent=`Dashboard data could not load: ${error.message}`;
      stateBox.className='superadmin-dashboard-state';
    }
  }
}
function renderStaffDashboard(data) {
  const stats=data.stats||{}, permissions=data.permissions||{};
  staffDashboardData = {
    recent_reports: Array.isArray(data.recent_reports) ? data.recent_reports : [],
    under_review_tasks: Array.isArray(data.under_review_tasks) ? data.under_review_tasks : [],
  };
  const actionCount = (permissions.can_review_reports ? Number(stats.open_reports) || 0 : 0)
    + (permissions.can_moderate_tasks ? Number(stats.under_review_tasks) || 0 : 0);
  staffActionNotificationCount = actionCount;
  setStaffNotificationBadge(actionCount + staffUnreadAnnouncementCount);
  const name=`${state.user?.first_name||''} ${state.user?.last_name||''}`.trim();
  if ($('#staff-dashboard-name')) $('#staff-dashboard-name').textContent=name||'Admin workspace';
  const metrics=[
    ...(permissions.can_moderate_tasks?[['Total tasks',stats.tasks,'fa-list-check'],['Open tasks',stats.open_tasks,'fa-briefcase'],['Under review',stats.under_review_tasks,'fa-eye']]:[]),
    ...(permissions.can_review_reports?[['Open reports',stats.open_reports,'fa-flag']]:[]),
    ...(permissions.can_resolve_disputes?[['Open disputes',stats.open_disputes,'fa-scale-balanced']]:[]),
    ...(permissions.can_view_users?[['Member accounts',stats.users,'fa-users']]:[])
  ];
  $('#staff-dashboard-stats').innerHTML=metrics.length?metrics.map(([label,value,icon])=>`<article class="superadmin-stat"><span class="superadmin-stat-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span><span class="superadmin-stat-label">${label}</span><strong class="superadmin-stat-value">${Number(value)||0}</strong></article>`).join(''):'<p class="text-sm text-slate-500">No dashboard metrics are available for your current permissions.</p>';
  const tasks=data.recent_tasks||[];
  $('#staff-dashboard-tasks').innerHTML=permissions.can_moderate_tasks
    ?tasks.length?tasks.map((task)=>`<article class="superadmin-compact-row"><span class="superadmin-compact-icon"><i class="fa-solid fa-briefcase" aria-hidden="true"></i></span><span class="superadmin-compact-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.category||'Uncategorized')} · ${escapeHtml(task.owner_name)} · ${escapeHtml(formatActivityTimestamp(task.created_at))}</small></span><span class="superadmin-status-pill" data-status="${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></article>`).join(''):'<p class="superadmin-empty-state">No tasks have been posted yet.</p>'
    :'<p class="superadmin-empty-state">Task moderation is not enabled for this account.</p>';
  const reports=data.recent_reports||[];
  $('#staff-dashboard-reports').innerHTML=permissions.can_review_reports
    ?reports.length?reports.map((report)=>`<article class="superadmin-compact-row"><span class="superadmin-compact-icon"><i class="fa-solid fa-flag" aria-hidden="true"></i></span><span class="superadmin-compact-copy"><strong>${escapeHtml(report.task?.title||`Task #${report.task_id}`)}</strong><small>${escapeHtml(report.reason)} · ${escapeHtml(formatActivityTimestamp(report.created_at))}</small></span><span class="superadmin-status-pill" data-status="Open">Open</span></article>`).join(''):'<p class="superadmin-empty-state">There are no open reports.</p>'
    :'<p class="superadmin-empty-state">Report review is not enabled for this account.</p>';
  const shortcuts=[
    ...(permissions.can_moderate_tasks?[['task-management-page','fa-list-check','Task moderation','Review and manage marketplace tasks']]:[]),
    ...(permissions.can_review_reports?[['report-management-page','fa-flag','Report queue','Review reports and record decisions']]:[]),
    ...(permissions.can_view_users?[['user-management-page','fa-users','User records','View member account details']]:[])
  ];
  $('#staff-dashboard-shortcuts').innerHTML=shortcuts.length?shortcuts.map(([page,icon,title,description])=>`<button type="button" data-admin-page="${page}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span><strong>${title}</strong><small>${description}</small></span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`).join(''):'<p class="superadmin-empty-state">Contact your Superadmin to request an admin workspace permission.</p>';
}
function setStaffNotificationBadge(count) {
  const badge = $('#staff-notification-badge');
  if (badge) badge.textContent = count > 99 ? '99+' : String(count);
  $('#staff-notification-trigger')?.setAttribute('aria-label', `${count} admin notifications`);
}
async function loadDashboardTrends() {
  if (state.user?.role!=='superadmin') return;
  try {
    const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'dashboard_trends',days:Number($('#admin-trend-days')?.value)||30,category:$('#admin-trend-category')?.value||''})});
    accountActivityData.trends=payload.trends||[];
    renderSuperadminTrends();
  } catch(error) { notify(error.message,'error'); }
}
function openReportersModal(taskId) {
  const reports = accountActivityData.reports.filter((report) => Number(report.task_id) === Number(taskId));
  if (!reports.length) { notify('No reports were found for this task.', 'error'); return; }
  const task = reports[0].task || {};
  const owner = task.owner || {};
  const ownerName = `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'Task poster';
  const reportItems = reports.map((report) => {
    const reporter = report.reporter || {};
    const reporterName = `${reporter.first_name || ''} ${reporter.last_name || ''}`.trim() || 'Member';
    const icon = report.status === 'Open' ? 'fa-circle-exclamation' : report.status === 'Reviewed' ? 'fa-circle-check' : 'fa-circle-minus';
    return `<article class="superadmin-reporter-detail"><header><div><span class="superadmin-report-person-label"><i class="fa-regular fa-flag" aria-hidden="true"></i> Reported by</span><button type="button" data-superadmin-view-profile="${Number(reporter.id || report.reporter_id) || 0}" class="superadmin-report-profile-link">${escapeHtml(reporterName)} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button><small>${escapeHtml(reporter.email || '')}</small></div><span class="superadmin-report-status" data-status="${escapeHtml(report.status)}"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeHtml(report.status)}</span></header><div class="superadmin-report-reason"><span>Reason</span><strong>${escapeHtml(report.reason || 'Not provided')}</strong></div><div class="superadmin-report-details"><span>Details</span><p>${escapeHtml(report.details || 'No additional details provided.')}</p></div><small class="superadmin-report-date">Submitted ${escapeHtml(formatActivityTimestamp(report.created_at))}</small>${report.status === 'Open' ? `<div class="superadmin-report-submission-actions"><button type="button" data-review-report="${report.id}" data-report-status="Reviewed" class="superadmin-report-button superadmin-report-button-review"><i class="fa-solid fa-check" aria-hidden="true"></i><span>Mark reviewed</span></button><button type="button" data-review-report="${report.id}" data-report-status="Dismissed" class="superadmin-report-button superadmin-report-button-dismiss"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Dismiss</span></button></div>` : ''}</article>`;
  }).join('');
  let modal = $('#reporters-detail-modal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', '<div id="reporters-detail-modal" class="modal-backdrop fixed inset-0 z-[108] hidden items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="reporters-detail-title"><div class="modal-panel reporters-detail-panel"><header class="reporters-detail-heading"><div><p>Superadmin · Task reports</p><h2 id="reporters-detail-title"></h2><span id="reporters-detail-count"></span></div><button type="button" data-close="reporters-detail-modal" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header><div id="reporters-detail-poster"></div><div id="reporters-detail-list" class="reporters-detail-list"></div><footer><button type="button" data-close="reporters-detail-modal" class="superadmin-report-button superadmin-report-button-view">Done</button></footer></div></div>');
    modal = $('#reporters-detail-modal');
  }
  $('#reporters-detail-title').textContent = task.title || 'Removed task';
  $('#reporters-detail-count').textContent = `${reports.length} ${reports.length === 1 ? 'report' : 'reports'}`;
  $('#reporters-detail-poster').innerHTML = task.user_id ? `<div class="reporters-detail-poster"><span class="superadmin-report-person-label">Task poster</span><button type="button" data-superadmin-view-profile="${Number(task.user_id)}" class="superadmin-report-profile-link">${escapeHtml(ownerName)} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button><small>${escapeHtml(owner.email || '')}</small></div>` : '';
  $('#reporters-detail-list').innerHTML = reportItems;
  openModal('#reporters-detail-modal');
}

async function openSuperadminNotifications() {
  const isStaff = ['admin','moderator'].includes(state.user?.role);
  const reports = isStaff ? staffDashboardData.recent_reports : accountActivityData.reports;
  const openReports = reports.filter((report) => report.status === 'Open');
  const reportGroups = new Map();
  openReports.forEach((report) => {
    const key = report.task_id ? String(report.task_id) : `report-${report.id}`;
    if (!reportGroups.has(key)) reportGroups.set(key, []);
    reportGroups.get(key).push(report);
  });
  const reportItems = [...reportGroups.values()].map((reports) => {
    const report = reports[0], title = report.task?.title || 'Removed task';
    return `<button type="button" data-admin-notification-report="${Number(report.task_id) || 0}" class="superadmin-notification-item"><span class="superadmin-notification-icon is-report"><i class="fa-solid fa-flag" aria-hidden="true"></i></span><span><strong>Open task report${reports.length === 1 ? '' : 's'}</strong><small>${escapeHtml(title)} · ${reports.length} ${reports.length === 1 ? 'report needs' : 'reports need'} review</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
  }).join('');
  const reviewTasks = isStaff ? staffDashboardData.under_review_tasks : accountActivityData.under_review_tasks;
  const disputeItems = reviewTasks.map((task) => `<button type="button" data-admin-notification-task="${Number(task.id)}" class="superadmin-notification-item"><span class="superadmin-notification-icon is-dispute"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i></span><span><strong>Task paused for review</strong><small>${escapeHtml(task.title)} · ${escapeHtml(task.owner_name || 'Task poster')}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`).join('');
  let announcementItems='';
  try {
    const notificationPayload=await api('api/notifications?action=center');
    adminNotificationAnnouncements=(notificationPayload.items||[]).filter((item)=>item.type==='announcement');
    announcementItems=adminNotificationAnnouncements.map((item)=>`<button type="button" data-admin-announcement="${escapeHtml(item.id)}" class="superadmin-notification-item"><span class="superadmin-notification-icon is-announcement"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.is_read?'Announcement · Read':'Announcement · Click to read')} · ${escapeHtml(formatActivityTimestamp(item.created_at))}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`).join('');
  } catch(error) { notify(`Could not load announcements: ${error.message}`,'error'); }
  let modal = $('#superadmin-notifications-modal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', '<div id="superadmin-notifications-modal" class="modal-backdrop fixed inset-0 z-[108] hidden items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="superadmin-notifications-title"><section class="modal-panel superadmin-notifications-panel"><header><div><p id="admin-notifications-eyebrow" class="superadmin-review-label">Superadmin dashboard</p><h2 id="superadmin-notifications-title">Action notifications</h2><p>Open reports and tasks paused for review.</p></div><button type="button" data-close="superadmin-notifications-modal" aria-label="Close notifications"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header><div id="superadmin-notifications-list" class="superadmin-notifications-list"></div></section></div>');
    modal = $('#superadmin-notifications-modal');
  }
  if ($('#admin-notifications-eyebrow')) $('#admin-notifications-eyebrow').textContent = isStaff ? 'Admin workspace' : 'Superadmin dashboard';
  const items = `${reportItems}${disputeItems}${announcementItems}`;
  $('#superadmin-notifications-list').innerHTML = items || '<div class="superadmin-notifications-empty"><i class="fa-regular fa-circle-check" aria-hidden="true"></i><strong>You’re all caught up</strong><span>No open reports or tasks under review.</span></div>';
  openModal('#superadmin-notifications-modal');
}
async function removeTaskFromModeration(taskId, reason) {
  const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'delete_task',task_id:taskId,reason})});
  notify(payload.message);
  await loadTasks();
  if (state.user?.role==='superadmin') {
    await loadAccountActivity();
    showPage('task-management-page');
  } else {
    await loadModeratorTasks();
    showPage('task-management-page');
  }
}
function renderSuperadminTrends() {
  const container=$('#superadmin-trend-chart');
  if (!container) return;
  const trends=accountActivityData.trends||[];
  const maximum=Math.max(1,...trends.flatMap((day)=>[Number(day.registrations)||0,Number(day.tasks)||0,Number(day.completions)||0,Number(day.reports)||0]));
  const series=[['registrations','Registrations'],['tasks','Tasks'],['completions','Completions'],['reports','Reports']];
  container.innerHTML=trends.length?`<div class="superadmin-trend-legend">${series.map(([key,label])=>`<span data-series="${key}"><i></i>${label}</span>`).join('')}</div><div class="superadmin-trend-bars" role="img" aria-label="Daily platform registrations, tasks, completions, and reports for the last 30 days">${trends.map((day)=>`<div class="superadmin-trend-day" title="${escapeHtml(day.day)}: ${series.map(([key,label])=>`${label} ${Number(day[key])||0}`).join(', ')}"><div>${series.map(([key])=>`<i data-series="${key}" style="height:${Math.max(Number(day[key])?2:0,(Number(day[key])||0)/maximum*100)}%"></i>`).join('')}</div><small>${escapeHtml(String(day.day||'').slice(5))}</small></div>`).join('')}</div>`:'<p class="superadmin-empty-state">Trend data is not available yet.</p>';
}
function exportTrendCsv() {
  const trends=accountActivityData.trends||[];
  const columns=['day','registrations','tasks','completions','reports'];
  const csv=[columns.join(','),...trends.map((day)=>columns.map((column)=>csvCell(day[column])).join(','))].join('\r\n');
  const link=document.createElement('a');
  link.href=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));
  link.download=`taskerph-platform-trends-${new Date().toISOString().slice(0,10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
function renderAccountActivity(payload) {
  accountActivityData = { users: Array.isArray(payload.users) ? payload.users : [], events: Array.isArray(payload.events) ? payload.events : [], reports: Array.isArray(payload.reports) ? payload.reports : [], tasks: Array.isArray(payload.tasks) ? payload.tasks : [], under_review_tasks: Array.isArray(payload.under_review_tasks) ? payload.under_review_tasks : [], trends: Array.isArray(payload.trends) ? payload.trends : [], stats: payload.stats || {} };
  superadminHasMoreTasks = Boolean(payload.has_more_tasks);
  superadminTaskResultTotal = Number(accountActivityData.stats.total_tasks) || 0;
  superadminTaskQuery = { search: '', status: 'all' };
  if ($('#superadmin-task-search')) $('#superadmin-task-search').value = '';
  if ($('#superadmin-task-status-filter')) $('#superadmin-task-status-filter').value = 'all';
  const users = accountActivityData.users;
  const active = Number(accountActivityData.stats.active_count) || 0;
  const admins = Number(accountActivityData.stats.admin_count) || 0;
  const members = Math.max(0,(Number(accountActivityData.stats.total_users)||users.length)-admins);
  const summary = [
    ['Members', members, 'fa-users', 'text-sky-600'], ['Staff', admins, 'fa-user-shield', 'text-violet-600'],
    ['Total tasks', accountActivityData.stats.total_tasks || 0, 'fa-list-check', 'text-teal-600'], ['Open tasks', accountActivityData.stats.open_tasks || 0, 'fa-briefcase', 'text-amber-600'],
    ['Completed', accountActivityData.stats.completed_tasks || 0, 'fa-circle-check', 'text-emerald-600'], ['Open reports', accountActivityData.stats.open_reports || 0, 'fa-flag', 'text-rose-600'], ['Active now', active, 'fa-bolt', 'text-blue-600']
  ].map(([label, value, icon, color]) => `<article class="superadmin-stat"><span class="superadmin-stat-icon ${color}"><i class="fa-solid ${icon}" aria-hidden="true"></i></span><span class="superadmin-stat-label">${label}</span><strong class="superadmin-stat-value">${value}</strong></article>`).join('');
  $('#account-activity-summary').innerHTML = summary;
  $('#superadmin-dashboard-state')?.classList.add('hidden');
  const openReports = Number(accountActivityData.stats.open_reports)||0;
  const adminActionCount = openReports + accountActivityData.under_review_tasks.length;
  if ($('#admin-report-badge')) $('#admin-report-badge').textContent = String(adminActionCount);
  $('#admin-notification-trigger')?.setAttribute('aria-label', `${adminActionCount} Superadmin notifications: ${openReports} open reports and ${accountActivityData.under_review_tasks.length} tasks under review`);
  const eventsHtml = accountActivityData.events.slice(0, 6).map((event) => `<article class="superadmin-feed-row"><span class="superadmin-feed-icon"><i class="fa-solid ${event.event_type === 'user_registered' ? 'fa-user-plus' : event.event_type === 'task_completed' ? 'fa-circle-check' : event.event_type.includes('report') ? 'fa-flag' : 'fa-clock'}"></i></span><div class="min-w-0"><strong>${escapeHtml(event.summary)}</strong><small>${escapeHtml(event.user ? `${event.user.first_name} ${event.user.last_name} · ${event.user.email}` : 'System')} · ${escapeHtml(formatActivityTimestamp(event.created_at))}</small></div></article>`).join('') || '<p class="p-4 text-sm text-slate-500">No activity recorded yet.</p>';
  const dashboardEvents=$('#dashboard-events');
  if(dashboardEvents) dashboardEvents.innerHTML=eventsHtml;
  const adminAuditContainer=$('#account-activity-events');
  if(adminAuditContainer && !$('#admin-audit-controls')) adminAuditContainer.innerHTML=eventsHtml;
  const reportsByTask = new Map();
  accountActivityData.reports.forEach((report) => {
    const key = report.task_id ? `task:${report.task_id}` : `missing:${report.id}`;
    if (!reportsByTask.has(key)) reportsByTask.set(key, []);
    reportsByTask.get(key).push(report);
  });
  const reportsHtml = [...reportsByTask.values()].map((reports) => {
    const task = reports[0].task || {};
    const owner = task.owner || {};
    const ownerName = `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'Task poster';
    const openCount = reports.filter((report) => report.status === 'Open').length;
    const overallStatus = openCount ? 'Open' : reports.every((report) => report.status === 'Dismissed') ? 'Dismissed' : 'Reviewed';
    return `<article class="superadmin-report-row"><div class="superadmin-report-main"><div class="superadmin-report-heading"><div class="min-w-0"><span class="superadmin-report-kicker">Reported task</span><strong>${escapeHtml(task.title || 'Removed task')}</strong></div><span class="superadmin-report-status" data-status="${overallStatus}"><i class="fa-solid ${overallStatus === 'Open' ? 'fa-circle-exclamation' : overallStatus === 'Reviewed' ? 'fa-circle-check' : 'fa-circle-minus'}" aria-hidden="true"></i>${openCount ? `${openCount} open` : overallStatus}</span></div><p class="superadmin-report-count">${reports.length} ${reports.length === 1 ? 'user has' : 'users have'} reported this task</p><div class="superadmin-report-people"><button type="button" data-show-reporters="${Number(reports[0].task_id) || 0}" class="superadmin-report-button superadmin-report-button-view"><i class="fa-solid fa-users" aria-hidden="true"></i><span>Who reported? · ${reports.length}</span></button>${task.user_id ? `<div><span class="superadmin-report-person-label"><i class="fa-regular fa-user" aria-hidden="true"></i> Task poster</span><button type="button" data-superadmin-view-profile="${Number(task.user_id)}" class="superadmin-report-profile-link">${escapeHtml(ownerName)} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button><small>${escapeHtml(owner.email || '')}</small></div>` : ''}</div></div><div class="superadmin-report-actions">${task.id ? `<button type="button" data-superadmin-view-task="${Number(task.id)}" class="superadmin-report-button superadmin-report-button-view"><i class="fa-regular fa-eye" aria-hidden="true"></i><span>View task</span></button>` : '<span class="superadmin-report-removed">Task removed</span>'}</div></article>`;
  }).join('') || '<p class="p-4 text-sm text-slate-500">No reports submitted.</p>';
  document.querySelectorAll('#dashboard-reports').forEach((node) => { node.innerHTML = reportsHtml; });
  const totalTasks = Number(accountActivityData.stats.total_tasks) || 0;
  const completedTasks = Number(accountActivityData.stats.completed_tasks) || 0;
  const openTasks = Number(accountActivityData.stats.open_tasks) || 0;
  const inProgressTasks = Math.max(0, totalTasks - completedTasks - openTasks);
  const taskShare = (count) => totalTasks ? `${Math.max(0, Math.min(100, count / totalTasks * 100))}%` : '0%';
  const pulse = $('#dashboard-task-pulse');
  if (pulse) pulse.innerHTML = `<div class="superadmin-pulse-summary"><strong>${totalTasks.toLocaleString('en-PH')}</strong><span>Total tasks tracked</span></div><div class="superadmin-pulse-track" role="img" aria-label="${openTasks} open, ${inProgressTasks} in progress, and ${completedTasks} completed tasks"><span class="pulse-open" style="width:${taskShare(openTasks)}"></span><span class="pulse-progress" style="width:${taskShare(inProgressTasks)}"></span><span class="pulse-complete" style="width:${taskShare(completedTasks)}"></span></div><div class="superadmin-pulse-legend"><span><i class="pulse-open"></i>Open <b>${openTasks.toLocaleString('en-PH')}</b></span><span><i class="pulse-progress"></i>In progress <b>${inProgressTasks.toLocaleString('en-PH')}</b></span><span><i class="pulse-complete"></i>Completed <b>${completedTasks.toLocaleString('en-PH')}</b></span></div><div class="superadmin-pulse-foot"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Counts update with dashboard activity.</div>`;
  renderSuperadminTasks();
  renderSuperadminTrends();
  const recentTasksHtml = accountActivityData.tasks.slice(0, 5).map((task) => `<article class="superadmin-compact-row"><span class="superadmin-compact-icon"><i class="fa-solid fa-briefcase" aria-hidden="true"></i></span><span class="superadmin-compact-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.category)} · ${escapeHtml(formatActivityTimestamp(task.created_at))}</small></span><span class="superadmin-status-pill" data-status="${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></article>`).join('') || '<p class="superadmin-empty-state">No tasks posted yet.</p>';
  $('#dashboard-recent-tasks')?.replaceChildren();
  if ($('#dashboard-recent-tasks')) $('#dashboard-recent-tasks').innerHTML = recentTasksHtml;
  const recentUsersHtml = users.filter((user) => user.role === 'user').sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 5).map((user) => `<article class="superadmin-compact-row"><span class="superadmin-member-avatar">${escapeHtml(initials(user))}</span><span class="superadmin-compact-copy"><strong>${escapeHtml(`${user.first_name} ${user.last_name}`)}</strong><small>${escapeHtml(user.email)}</small></span><span class="superadmin-status-pill member-role">Member</span></article>`).join('') || '<p class="superadmin-empty-state">No members yet.</p>';
  if ($('#dashboard-members')) $('#dashboard-members').innerHTML = recentUsersHtml;
  if ($('#admin-topbar-name')) $('#admin-topbar-name').textContent = `${state.user?.first_name || ''} ${state.user?.last_name || ''}`.trim();
  renderSuperadminUsers();
}function renderSuperadminUsers() {
  const body = $('#superadmin-users-table'); if (!body) return;
  const users = accountActivityData.users.filter((user) => user.role !== 'superadmin' && !(state.user?.role === 'admin' && Number(user.id) === Number(state.user.id)));
  const pageSize = 50;
  const pageCount = Math.max(1,Math.ceil(superadminUserTotal/pageSize));
  const isSuperadmin=state.user?.role==='superadmin';
  const isAdmin=state.user?.role==='admin';
  const tableWrap=body.closest('.overflow-x-auto');
  if(tableWrap&&!$('#bulk-suspend-toolbar')) tableWrap.insertAdjacentHTML('beforebegin','<div id="bulk-suspend-toolbar" class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><span id="bulk-suspend-count" class="text-sm font-semibold text-amber-900"></span><button type="button" data-bulk-suspend-review class="rounded-lg bg-amber-700 px-3 py-2 text-sm font-bold text-white">Review bulk suspension</button></div>');
  const bulkToolbar=$('#bulk-suspend-toolbar');
  if(bulkToolbar) {
    bulkToolbar.classList.toggle('hidden',!isSuperadmin&&!isAdmin);
    const count=$('#bulk-suspend-count');
    if(count) count.textContent=`${bulkSuspensionSelection.size} member account${bulkSuspensionSelection.size===1?'':'s'} selected`;
  }
  body.innerHTML = users.length ? users.map((user) => {
    const name=`${user.first_name} ${user.middle_initial ? `${user.middle_initial}. ` : ''}${user.last_name}`;
    const suspension=user.is_suspended?`<span class="superadmin-status-pill is-suspended">${user.suspended_until&&new Date(user.suspended_until)>new Date()?`Suspended until ${escapeHtml(formatActivityTimestamp(user.suspended_until))}`:'Suspended'}</span>`:'';
    const eligible=user.role==='user'&&!user.is_suspended;
    const checkbox=(isSuperadmin||isAdmin)&&eligible?`<input type="checkbox" data-bulk-suspend-user="${Number(user.id)}" aria-label="Select ${escapeHtml(name)} for bulk suspension" ${bulkSuspensionSelection.has(Number(user.id))?'checked':''} class="mr-2">`:'';
    const actions=`<button data-superadmin-view-profile="${Number(user.id)}" class="superadmin-user-edit rounded-lg border px-3 py-2 text-xs font-bold">View profile</button>${isSuperadmin?`<button data-edit-user="${Number(user.id)}" class="superadmin-user-edit rounded-lg border px-3 py-2 text-xs font-bold">Edit</button>${user.is_suspended?`<button data-unsuspend-user="${Number(user.id)}" class="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700">Reactivate</button>`:`<button data-suspend-user="${Number(user.id)}" class="rounded-lg border border-amber-200 px-3 py-2 text-xs font-bold text-amber-700">Suspend</button>`}<button data-delete-user="${Number(user.id)}" class="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600">Delete</button>`:isAdmin&&user.role==='user'&&!user.is_suspended?`<button data-suspend-user="${Number(user.id)}" class="rounded-lg border border-amber-200 px-3 py-2 text-xs font-bold text-amber-700">Suspend</button>`:''}`;
    return `<tr class="border-b border-[#edf0f1]"><td class="p-3 font-semibold">${checkbox}${escapeHtml(name)}<div>${suspension}</div></td><td class="p-3">${escapeHtml(user.email)}</td><td class="p-3"><span class="account-activity-role">${escapeHtml(user.role)}</span></td><td class="p-3">${escapeHtml(formatActivityTimestamp(user.created_at))}</td><td class="p-3"><div class="flex flex-wrap items-center gap-2">${actions}</div></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="p-6 text-center text-sm text-[#68727c]">No matching accounts.</td></tr>';
  let pagination = $('#superadmin-user-pagination');
  if (!pagination) { body.closest('.overflow-x-auto')?.insertAdjacentHTML('afterend','<div id="superadmin-user-pagination" class="superadmin-pagination"></div>'); pagination = $('#superadmin-user-pagination'); }
  if (pagination) { pagination.hidden = superadminUserTotal <= pageSize; pagination.innerHTML = superadminUserTotal > pageSize ? `<span>Showing ${(superadminUserPage-1)*pageSize+1}–${Math.min(superadminUserPage*pageSize+users.length,superadminUserTotal)} of ${superadminUserTotal} users</span><div><button type="button" data-superadmin-user-page="${superadminUserPage-1}" ${superadminUserPage===1?'disabled':''} aria-label="Previous user page"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><strong>Page ${superadminUserPage} of ${pageCount}</strong><button type="button" data-superadmin-user-page="${superadminUserPage+1}" ${superadminUserPage===pageCount?'disabled':''} aria-label="Next user page"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>` : ''; }
}
function renderSuperadminTasks() {
  const container = $('#account-activity-tasks');
  if (!container) return;
  const allTasks = accountActivityData.tasks || [];
  const term = ($('#superadmin-task-search')?.value || '').trim().toLocaleLowerCase();
  const statusFilter = $('#superadmin-task-status-filter')?.value || 'all';
  const tasks = allTasks.filter((task) => {
    if (statusFilter !== 'all' && task.status !== statusFilter) return false;
    if (!term) return true;
    const owner = task.owner || {};
    const searchable = `${task.id} ${task.title} ${task.category} ${task.status} ${task.location} ${task.description} ${task.budget} ${owner.first_name} ${owner.last_name} ${owner.email}`;
    return searchable.toLocaleLowerCase().includes(term);
  });
  const totalPlatformTasks = superadminTaskResultTotal || Number(accountActivityData.stats?.total_tasks) || allTasks.length;
  if ($('#superadmin-task-result-count')) $('#superadmin-task-result-count').textContent = `Showing ${tasks.length} matching · ${allTasks.length} loaded of ${totalPlatformTasks} tasks`;
  container.className = superadminTaskView === 'cards' ? 'superadmin-task-cards' : 'superadmin-task-list';
  const content = tasks.map((task) => {
    const owner = task.owner || {};
    const ownerName = `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'TaskerPH member';
    const ownerLine = `${ownerName}${owner.email ? ` · ${owner.email}` : ''}`;
    const actions = `<div class="superadmin-task-card-actions"><button type="button" data-superadmin-view-task="${Number(task.id)}" class="admin-action-button text-[#006f70]"><i class="fa-regular fa-eye mr-1" aria-hidden="true"></i>View</button><button type="button" data-delete="${Number(task.id)}" class="admin-action-button text-rose-600"><i class="fa-regular fa-trash-can mr-1" aria-hidden="true"></i>Remove</button></div>`;
    if (superadminTaskView === 'cards') return `<article class="superadmin-task-card"><div class="superadmin-task-card-top"><span class="superadmin-review-label">${escapeHtml(task.category || 'Uncategorized')}</span><span class="superadmin-status-pill" data-status="${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></div><h3>${escapeHtml(task.title)}</h3>${taskPhotoMarkup(task, true)}<p class="superadmin-task-card-description">${escapeHtml(task.description || 'No description provided.')}</p><div class="superadmin-task-card-meta"><span><i class="fa-solid fa-peso-sign" aria-hidden="true"></i>${money(task.budget)}</span><span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${escapeHtml(task.location || 'No location')}</span></div><div class="superadmin-task-card-owner"><i class="fa-regular fa-user" aria-hidden="true"></i><span>${escapeHtml(ownerLine)}</span><small>${escapeHtml(formatActivityTimestamp(task.created_at))}</small></div>${actions}</article>`;
    return `<article class="superadmin-task-row"><div class="min-w-0"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.category || 'Uncategorized')} · ${escapeHtml(task.status)} · ${money(task.budget)}</p><small>${escapeHtml(ownerLine)}</small></div>${actions}</article>`;
  }).join('') || `<p class="superadmin-profile-empty">${term || statusFilter !== 'all' ? 'No tasks match your search or status filter.' : 'No tasks posted yet.'}</p>`;
  container.innerHTML = content;
  document.querySelectorAll('[data-admin-task-view]').forEach((button) => {
    const active = button.dataset.adminTaskView === superadminTaskView;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  let loadMoreButton = $('#superadmin-task-load-more');
  if (!loadMoreButton) { container.insertAdjacentHTML('afterend','<div class="superadmin-load-more-wrap"><button type="button" id="superadmin-task-load-more" class="superadmin-load-more-button"></button></div>'); loadMoreButton = $('#superadmin-task-load-more'); }
  if (loadMoreButton) { loadMoreButton.hidden = !superadminHasMoreTasks; loadMoreButton.disabled = superadminLoadingMoreTasks || superadminSearchingTasks; loadMoreButton.innerHTML = superadminLoadingMoreTasks || superadminSearchingTasks ? '<i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Loading...' : '<i class="fa-solid fa-chevron-down mr-2" aria-hidden="true"></i>Load more tasks'; }
}
async function loadMoreSuperadminTasks() {
  if (superadminLoadingMoreTasks || !superadminHasMoreTasks) return;
  const requestId = superadminTaskSearchRequestId;
  superadminLoadingMoreTasks = true;
  renderSuperadminTasks();
  try {
    const payload = await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'more_tasks',offset:accountActivityData.tasks.length,search:superadminTaskQuery.search,status:superadminTaskQuery.status})});
    if (requestId !== superadminTaskSearchRequestId) return;
    accountActivityData.tasks.push(...(payload.tasks||[]));
    superadminHasMoreTasks = Boolean(payload.has_more_tasks);
    superadminTaskResultTotal = Number(payload.total_count) || 0;
  } catch (error) { notify(error.message,'error'); }
  finally { superadminLoadingMoreTasks = false; renderSuperadminTasks(); }
}
async function searchSuperadminTasks() {
  if (!['superadmin','admin','moderator'].includes(state.user?.role)) return;
  const query = { search: ($('#superadmin-task-search')?.value || '').trim(), status: $('#superadmin-task-status-filter')?.value || 'all' };
  superadminTaskQuery = query;
  const requestId = ++superadminTaskSearchRequestId;
  superadminSearchingTasks = true;
  renderSuperadminTasks();
  if ($('#superadmin-task-result-count')) $('#superadmin-task-result-count').textContent = 'Searching all platform tasks...';
  try {
    const payload = await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'more_tasks',offset:0,...query})});
    if (requestId !== superadminTaskSearchRequestId) return;
    accountActivityData.tasks = payload.tasks || [];
    superadminTaskResultTotal = Number(payload.total_count) || 0;
    superadminHasMoreTasks = Boolean(payload.has_more_tasks);
    renderSuperadminTasks();
  } catch (error) {
    if (requestId === superadminTaskSearchRequestId) notify(error.message,'error');
  } finally {
    if (requestId === superadminTaskSearchRequestId) { superadminSearchingTasks = false; renderSuperadminTasks(); }
  }
}
async function loadAccountActivity() {
  if (state.user?.role !== 'superadmin') { notify('Only the Superadmin can view account activity.', 'error'); return; }
  $('#superadmin-dashboard-state')?.classList.remove('hidden');
  if ($('#superadmin-dashboard-state')) $('#superadmin-dashboard-state').textContent = 'Loading admin dashboard data...';
  $('#superadmin-users-table').innerHTML = '<tr><td colspan="5" class="p-6 text-center text-sm text-[#68727c]">Loading accounts...</td></tr>';
  try {
    const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'activity_dashboard' }) });
    renderAccountActivity(payload);
    if ($('#audit-log-page') && !$('#audit-log-page').classList.contains('hidden')) void loadAdminAudit(true);
    if ($('#report-management-page') && !$('#report-management-page').classList.contains('hidden')) void loadAdminReports(true);
  } catch (error) {
    const message = escapeHtml(error.message);
    $('#superadmin-users-table').innerHTML = `<tr><td colspan="5" class="p-6 text-center text-sm text-red-600">${message}</td></tr>`;
    if ($('#superadmin-dashboard-state')) { $('#superadmin-dashboard-state').innerHTML = `<strong>Dashboard data could not load.</strong> ${message} Check that the latest Supabase migration has been applied.`; $('#superadmin-dashboard-state').className = 'superadmin-dashboard-state'; }
  }
}
async function openAccountActivity() {
  if (state.user?.role !== 'superadmin') { notify('Only the Superadmin can view account activity.', 'error'); return; }
  closeDrawer();
  showPage('account-activity-modal');
  await loadAccountActivity();
  if (accountActivityTimer) clearInterval(accountActivityTimer);
  accountActivityTimer = setInterval(() => {
    if ($('#account-activity-modal')?.classList.contains('hidden')) { clearInterval(accountActivityTimer); accountActivityTimer = null; return; }
    loadAccountActivity();
  }, 30_000);
}
function renderProfile() {
  if (!state.user) return;
  const user = state.user;
  $('#profile-name').textContent = `${user.first_name} ${user.middle_initial ? `${user.middle_initial}. ` : ''}${user.last_name}`;
  $('#profile-email').textContent = user.email;
  $('#profile-role').textContent = ({superadmin:'Super Admin',admin:'Administrator',moderator:'Moderator',support:'Support'})[user.role] || 'TaskerPH Member';
  $('#edit-profile-form').elements.first_name.value = user.first_name || '';
  $('#edit-profile-form').elements.middle_initial.value = user.middle_initial || '';
  $('#edit-profile-form').elements.last_name.value = user.last_name || '';
  $('#change-email-form').elements.email.value = user.email || '';
  const avatar = $('#profile-avatar');
  avatar.classList.toggle('hidden', !user.avatar_path);
  $('#profile-avatar-fallback').classList.toggle('hidden', Boolean(user.avatar_path));
  if (user.avatar_path) avatar.src = `${user.avatar_path}?v=${encodeURIComponent(user.avatar_path)}`;
}
function renderSuperadminAccountSettings() {
  if (!['superadmin','admin','moderator'].includes(state.user?.role)) return;
  const profile = $('#admin-edit-profile');
  if (profile) {
    profile.elements.first_name.value = state.user.first_name || '';
    profile.elements.middle_initial.value = state.user.middle_initial || '';
    profile.elements.last_name.value = state.user.last_name || '';
  }
  const email = $('#admin-change-email');
  if (email) email.elements.email.value = state.user.email || '';
  if ($('#admin-topbar-name')) $('#admin-topbar-name').textContent = `${state.user.first_name || ''} ${state.user.last_name || ''}`.trim();
  const staffWorkspace=state.user.role!=='superadmin';
  const eyebrow=$('#superadmin-account-page .superadmin-account-heading p');
  if(eyebrow) eyebrow.textContent=staffWorkspace?'Admin workspace':'Superadmin workspace';
  const dashboardButton=$('#superadmin-account-page [data-page="account-activity-modal"]');
  if(dashboardButton) dashboardButton.dataset.page=staffWorkspace?'staff-dashboard-page':'account-activity-modal';
  const sidebarDashboard=$('#superadmin-account-page .superadmin-sidebar [data-page="account-activity-modal"]');
  if(sidebarDashboard) sidebarDashboard.dataset.page=staffWorkspace?'staff-dashboard-page':'account-activity-modal';
  const sidebar=$('#superadmin-account-page .superadmin-sidebar');
  if(sidebar) sidebar.setAttribute('aria-label',staffWorkspace?'Admin sections':'Superadmin sections');
  const heading=$('#superadmin-account-page .superadmin-account-heading h1');
  if(heading) heading.textContent='Account settings';
  const description=$('#superadmin-account-page .superadmin-account-heading p:last-child');
  if(description) description.textContent='Manage your profile and sign-in credentials.';
  if(state.user.role==='superadmin') {
    const grid=$('#superadmin-account-page .superadmin-account-grid');
    if(grid&&!$('#superadmin-mfa-settings')) {
      grid.insertAdjacentHTML('afterend','<section id="superadmin-mfa-settings" class="superadmin-account-panel superadmin-mfa-settings"><div><span class="superadmin-account-icon"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></span><h2>Authenticator MFA</h2><p id="superadmin-mfa-status"></p></div><div id="superadmin-mfa-actions"></div></section>');
    }
    const status=$('#superadmin-mfa-status'), actions=$('#superadmin-mfa-actions');
    if(status) status.textContent=state.user.mfa_enabled?'Authenticator verification is enabled for future sign-ins. Store your recovery codes safely.':'Authenticator verification is required before using Superadmin tools.';
    if(actions) actions.innerHTML=state.user.mfa_enabled
      ? '<form id="superadmin-mfa-disable-form" class="grid gap-3"><label>Authenticator or recovery code<input name="code" inputmode="numeric" autocomplete="one-time-code" required class="form-control"></label><button type="submit" class="superadmin-account-save">Disable MFA</button></form>'
      : '<button type="button" data-mfa-start class="superadmin-account-save">Set up authenticator</button>';
  }
}
async function openSuperadminMfaEnrollment() {
  if(mfaEnrollmentPromise) return mfaEnrollmentPromise;
  mfaEnrollmentPromise=(async()=>{try {
    const setup=await api('api/auth?action=mfa_begin',{method:'POST',body:JSON.stringify({})});
    let modal=$('#superadmin-mfa-enroll-modal');
    if(!modal) {
      document.body.insertAdjacentHTML('beforeend','<div id="superadmin-mfa-enroll-modal" class="modal-backdrop fixed inset-0 z-[130] hidden items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="superadmin-mfa-enroll-title"><section class="modal-panel w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"><p class="superadmin-review-label">Superadmin security</p><h2 id="superadmin-mfa-enroll-title" class="mt-1 text-2xl font-bold">Set up authenticator MFA</h2><p class="mt-2 text-sm leading-6 text-slate-600">Add this account to an authenticator app using the secret key below. The key is shown only during setup.</p><code id="superadmin-mfa-secret" class="mt-4 block break-all rounded-xl bg-slate-100 p-4 font-mono text-sm font-bold"></code><button type="button" data-mfa-copy class="mt-2 rounded-lg border px-3 py-2 text-sm font-bold">Copy setup key</button><form id="superadmin-mfa-enroll-form" class="mt-5 grid gap-3"><label class="text-sm font-bold">6-digit authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern=\"[0-9]{6}\" minlength=\"6\" maxlength=\"6\" required class="form-control mt-2"></label><button type="submit" class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white">Enable MFA</button></form></section></div>');
      modal=$('#superadmin-mfa-enroll-modal');
      $('#superadmin-mfa-enroll-form').addEventListener('submit',async(event)=>{
        event.preventDefault();
        const form=event.currentTarget;
        if(!form.reportValidity()) return;
        setBusy(form,true,'Verifying code...');
        try {
          const result=await api('api/auth?action=mfa_enable',{method:'POST',body:JSON.stringify({code:form.elements.code.value})});
          state.user=result.user;
          $('#superadmin-mfa-enroll-title').textContent='Save your recovery codes';
          modal.querySelector('section').innerHTML=`<p class="superadmin-review-label">One-time recovery codes</p><h2 id="superadmin-mfa-enroll-title" class="mt-1 text-2xl font-bold">Save these codes now</h2><p class="mt-2 text-sm leading-6 text-slate-600">Each code works once if you lose access to your authenticator. They will not be shown again.</p><ul class="mfa-recovery-codes mt-4 grid grid-cols-2 gap-2">${result.recovery_codes.map((code)=>`<li><code>${escapeHtml(code)}</code></li>`).join('')}</ul><button type="button" data-mfa-finish class="touch-target mt-5 w-full rounded-lg bg-[#006f70] px-4 font-bold text-white">I saved my codes</button>`;
          modal.querySelector('[data-mfa-finish]').addEventListener('click',async()=>{
            closeModal('superadmin-mfa-enroll-modal');
            modal.remove();
            try {
              await window.taskerphPushLogout?.();
              await api('api/auth?action=logout',{method:'POST'});
            } catch(error) { console.error('MFA enrollment completed, but the old sign-in session could not be revoked:',error); }
            clearStoredAuth();
            state.user=null;
            broadcastAuthChange();
            renderAuth();
            showPage('marketplace-page');
            openModal('#login-modal');
            notify('MFA is enabled. Sign in again with your authenticator code to continue.');
          });
          notify(result.message);
        } catch(error) { notify(error.message,'error'); }
        finally { setBusy(form,false); }
      });
      modal.querySelector('[data-mfa-copy]').addEventListener('click',async()=>{
        try { await navigator.clipboard.writeText($('#superadmin-mfa-secret').textContent); notify('Authenticator setup key copied.'); }
        catch(error) { notify('Could not copy the setup key. Select and copy it manually.','error'); }
      });
    }
    $('#superadmin-mfa-secret').textContent=setup.secret;
    $('#superadmin-mfa-enroll-form').reset();
    openModal('#superadmin-mfa-enroll-modal');
  } catch(error) { notify(error.message,'error'); }
  finally { mfaEnrollmentPromise=null; }
  })();
  return mfaEnrollmentPromise;
}
async function openProfile(formId = null) {
  closeDrawer();
  closeDesktopProfileMenu();
  if (!state.user) { requestAuthGate('profile'); return; }
  renderProfile();
  showPage('profile-page');
  if (formId) {
    const form = $(`#${formId}`);
    form?.classList.remove('hidden');
    form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  try {
    state.user = (await api('api/profile_actions?action=get')).user;
    renderAuth(); renderProfile();
    if (formId) $(`#${formId}`)?.querySelector('input')?.focus({ preventScroll: true });
  }
  catch (error) { notify(error.message, 'error'); }
}
function applyAppearance(dark) {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
  document.body.classList.toggle('dark-mode', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f172a' : '#f8fafc');
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', dark ? 'black' : 'default');
  const appearanceState = $('#appearance-state');
  if (appearanceState) appearanceState.textContent = dark ? 'Dark' : 'Light';
  const desktopAppearanceState = $('#desktop-appearance-state');
  if (desktopAppearanceState) desktopAppearanceState.textContent = dark ? 'Dark' : 'Light';
  const superadminAppearanceState = $('#superadmin-appearance-state');
  if (superadminAppearanceState) superadminAppearanceState.textContent = dark ? 'Dark' : 'Light';
}
function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
function userThemeKey(user) {
  return `theme_${user.id}`;
}
function applyUserAppearance(user) {
  if (!user?.id) { applySystemAppearance(); return; }
  let savedTheme = null;
  try { savedTheme = localStorage.getItem(userThemeKey(user)); } catch (error) { void error; }
  const hasPreference = savedTheme === 'dark' || savedTheme === 'light';
  state.themeUsesSystem = !hasPreference;
  applyAppearance(hasPreference ? savedTheme === 'dark' : systemPrefersDark());
}
function applySystemAppearance() {
  state.themeUsesSystem = true;
  applyAppearance(systemPrefersDark());
}
function saveUserAppearance(dark) {
  applyAppearance(dark);
  if (!state.user?.id) { state.themeUsesSystem = true; return; }
  state.themeUsesSystem = false;
  try { localStorage.setItem(userThemeKey(state.user), dark ? 'dark' : 'light'); } catch (error) { void error; }
}
const systemAppearanceQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
const handleSystemAppearanceChange = (event) => {
  if (state.themeUsesSystem) applyAppearance(event.matches);
};
if (systemAppearanceQuery?.addEventListener) systemAppearanceQuery.addEventListener('change', handleSystemAppearanceChange);
else systemAppearanceQuery?.addListener?.(handleSystemAppearanceChange);
window.addEventListener('storage', (event) => {
  if (!state.user?.id) return;
  if (event.key === userThemeKey(state.user)) {
    const hasPreference = event.newValue === 'dark' || event.newValue === 'light';
    state.themeUsesSystem = !hasPreference;
    applyAppearance(hasPreference ? event.newValue === 'dark' : systemPrefersDark());
  }
  if (event.key === userGlassKey(state.user)) applyGlassOpacity(event.newValue ?? 0);
});
function userGlassKey(user) {
  return `glass-transparency_${user.id}`;
}
function applyGlassOpacity(value, { persist = false } = {}) {
  const transparency = Math.max(0, Math.min(100, Number(value) || 0));
  const level = transparency / 100;
  state.glassOpacity = transparency;
  const root = document.documentElement;
  root.style.setProperty('--admin-glass-opacity', (1 - level * 0.28).toFixed(2));
  // 0% means a fully opaque surface; the glass effect only activates by choice.
  root.style.setProperty('--glass-opacity', (1 - level * 0.55).toFixed(2));
  root.style.setProperty('--glass-blur', `${(level * 24).toFixed(1)}px`);
  root.style.setProperty('--glass-border-alpha', (0.76 - level * 0.3).toFixed(2));
  root.style.setProperty('--glass-light-border-alpha', (0.76 - level * 0.16).toFixed(2));
  root.style.setProperty('--glass-dark-border-alpha', (0.15 - level * 0.04).toFixed(2));
  root.classList.toggle('liquid-glass-active', Boolean(state.user?.id && transparency > 0));
  const slider = $('#glass-opacity');
  if (slider) {
    slider.value = String(transparency);
    slider.setAttribute('aria-valuetext', transparency === 0 ? '0% transparency, solid' : `${transparency}% transparency`);
  }
  const desktopSlider = $('#desktop-glass-opacity');
  if (desktopSlider) desktopSlider.value = String(transparency);
  const superadminSlider = $('#superadmin-glass-opacity');
  if (superadminSlider) {
    superadminSlider.value = String(transparency);
    superadminSlider.setAttribute('aria-valuetext', transparency === 0 ? '0% transparency, solid' : `${transparency}% transparency`);
  }
  const label = $('#glass-opacity-label');
  if (label) label.textContent = `${transparency}% Transparency`;
  const desktopLabel = $('#desktop-glass-label');
  if (desktopLabel) desktopLabel.textContent = `${transparency}%`;
  const superadminLabel = $('#superadmin-glass-label');
  if (superadminLabel) superadminLabel.textContent = `${transparency}%`;
  if (persist && state.user?.id) {
    try { localStorage.setItem(userGlassKey(state.user), String(transparency)); } catch (error) { void error; }
  }
}
function loadUserGlassPreference(user) {
  let savedTransparency = '0';
  if (user?.id) {
    try { savedTransparency = localStorage.getItem(userGlassKey(user)) ?? '0'; } catch (error) { void error; }
  }
  applyGlassOpacity(savedTransparency);
}
$('#explore-tasks-button').addEventListener('click', () => {
  if ($('main')?.classList.contains('hidden')) showPage('marketplace-page');
  requestAnimationFrame(() => $('#live-marketplace')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
});
function renderTasks() {
  const feed = $('#task-feed');
  if (!state.tasks.length) { feed.innerHTML = '<div class="card col-span-full px-6 py-14 text-center"><i class="fa-solid fa-magnifying-glass mb-4 text-3xl text-[#008f8c]"></i><h3 class="text-xl font-bold">No tasks match those filters</h3><p class="mt-2 text-[#68727c]">Try a different category or search phrase.</p></div>'; return; }
  feed.innerHTML = state.tasks.map(taskCardMarkup).join('');
}
function taskCardMarkup(task, index = 0) {
  const canManage = state.user && (['admin','moderator','superadmin'].includes(state.user.role) || (state.user.role === 'user' && Number(state.user.id) === Number(task.user_id)));
  const ownTask = state.user && Number(state.user.id) === Number(task.user_id);
  const saved = Boolean(state.user) && state.savedTaskIds.has(Number(task.id));
  return `<article data-task="${task.id}" style="--card-delay: ${Math.min(index, 8) * 45}ms" class="task-card card flex cursor-pointer flex-col p-5"><div class="flex items-start justify-between gap-3"><div><span class="text-xs font-bold uppercase tracking-[.15em] text-[#008f8c]">${escapeHtml(task.category)}</span><h3 class="mt-2 text-lg font-bold leading-tight">${escapeHtml(task.title)}</h3></div><div class="flex shrink-0 items-center gap-2"><span class="badge ${task.status === 'Open' ? 'badge-open' : task.status === 'Completed' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(task.status)}</span><button type="button" data-save-task="${task.id}" class="task-save-button touch-target ${saved ? 'is-saved' : ''}" aria-label="${ownTask ? 'Your task' : saved ? 'Remove saved task' : 'Save task'}" aria-pressed="${saved}" ${ownTask ? 'disabled title="You cannot save your own task"' : ''}><i class="fa-${saved ? 'solid' : 'regular'} fa-bookmark" aria-hidden="true"></i><span class="sr-only">${ownTask ? 'Your task' : saved ? 'Remove saved task' : 'Save task'}</span></button></div></div>${taskPhotoMarkup(task, true)}<p class="mt-4 line-clamp-3 text-sm leading-6 text-[#68727c]">${escapeHtml(task.description)}</p><div class="mt-5 grid grid-cols-2 gap-3 border-y border-[#edf0f1] py-4 text-sm"><div><p class="text-xs text-[#68727c]">Budget</p><p class="mt-1 font-bold">${money(task.budget)}</p></div><div><p class="text-xs text-[#68727c]">Location</p><p class="mt-1 font-bold">${escapeHtml(task.location)}</p></div></div><div class="mt-4 flex items-center justify-between gap-3"><p class="text-xs text-[#68727c]">Posted by <strong class="text-[#17202a]">${escapeHtml(task.owner_name)}</strong></p>${canManage ? `<div class="flex"><button data-edit="${task.id}" class="touch-target rounded-lg px-2 text-sm font-bold text-[#006f70] hover:bg-[#e9f4f2]"><i class="fa-solid fa-pen-to-square"></i><span class="sr-only">Edit task</span></button><button data-delete="${task.id}" class="touch-target rounded-lg px-2 text-sm font-bold text-red-600 hover:bg-red-50"><i class="fa-solid fa-trash"></i><span class="sr-only">Delete task</span></button></div>` : '<span class="text-xs font-bold text-[#008f8c]">View task <i class="fa-solid fa-arrow-right ml-1"></i></span>'}</div></article>`;
}
function renderSavedTasks() {
  const list = $('#saved-tasks-list');
  if (!list) return;
  list.innerHTML = state.savedTasks.length
    ? state.savedTasks.map((task, index) => taskCardMarkup(task, index)).join('')
    : '<div class="empty-state col-span-full rounded-xl border border-dashed border-[#c9d4d9] px-5 py-12 text-center"><i class="fa-regular fa-bookmark mb-3 text-3xl text-[#008f8c]"></i><p class="font-bold">No saved tasks yet.</p><p class="mt-1 text-sm text-[#68727c]">Explore the marketplace and bookmark tasks you\'re interested in!</p><button data-page="marketplace-page" class="touch-target mt-5 rounded-lg bg-[#006f70] px-5 font-bold text-white">Explore tasks</button></div>';
}
async function refreshSavedTaskData() {
  if (!state.user) {
    state.savedTasks = [];
    state.savedTaskIds.clear();
    updateSavedTaskCount(0);
    renderSavedTasks();
    return;
  }
  const payload = await api('api/saved_tasks?action=list');
  state.savedTasks = payload.tasks;
  state.savedTaskIds = new Set(payload.tasks.map((task) => Number(task.id)));
  updateSavedTaskCount(payload.count);
  renderSavedTasks();
}
async function loadSavedTasks() {
  if (!state.user) { requestAuthGate('saved'); return; }
  showPage('saved-tasks-page');
  if (state.savedTasks.length) renderSavedTasks();
  else $('#saved-tasks-list').innerHTML = '<p class="py-8 text-center text-sm text-[#68727c]">Loading saved tasks...</p>';
  try {
    await refreshSavedTaskData();
  } catch (error) { notify(error.message, 'error'); }
}
async function toggleSavedTask(task) {
  if (!state.user) { requestAuthGate('saved'); return; }
  if (Number(state.user.id) === Number(task.user_id)) { notify('You cannot save your own task.', 'error'); return; }
  const taskId = Number(task.id);
  if (pendingSavedTaskIds.has(taskId)) return;
  pendingSavedTaskIds.add(taskId);
  const saved = !state.savedTaskIds.has(Number(task.id));
  const buttons = [...document.querySelectorAll(`[data-save-task="${taskId}"]`)];
  buttons.forEach((button) => setSavedButtonBusy(button, true, saved ? 'Saving task...' : 'Removing saved task...'));
  const applySavedState = (isSaved) => {
    if (isSaved) {
      state.savedTaskIds.add(taskId);
      state.savedTasks = [{ ...task, is_saved: true }, ...state.savedTasks.filter((item) => Number(item.id) !== taskId)];
    } else {
      state.savedTaskIds.delete(taskId);
      state.savedTasks = state.savedTasks.filter((item) => Number(item.id) !== taskId);
    }
    state.tasks = state.tasks.map((item) => Number(item.id) === taskId ? { ...item, is_saved: isSaved } : item);
    updateSavedTaskCount(state.savedTaskIds.size);
    document.querySelectorAll(`[data-save-task="${taskId}"]`).forEach((button) => {
      button.classList.toggle('is-saved', isSaved);
      button.setAttribute('aria-pressed', String(isSaved));
      button.setAttribute('aria-label', isSaved ? 'Remove saved task' : 'Save task');
      button.querySelector('i').className = `fa-${isSaved ? 'solid' : 'regular'} fa-bookmark`;
      const accessibleLabel = button.querySelector('.sr-only');
      if (accessibleLabel) accessibleLabel.textContent = isSaved ? 'Remove saved task' : 'Save task';
    });
    renderSavedTasks();
  };
  applySavedState(saved);
  try {
    const payload = await api('api/saved_tasks', { method: 'POST', body: JSON.stringify({ action: 'toggle', task_id: task.id, saved }) });
    if (payload.saved !== saved) applySavedState(payload.saved);
    broadcastAuthChange();
    notify(payload.saved ? 'Task saved to your bookmarks!' : 'Task removed from saved items');
  } catch (error) { applySavedState(!saved); notify(error.message, 'error'); }
  finally {
    pendingSavedTaskIds.delete(taskId);
    buttons.forEach((button) => setSavedButtonBusy(button, false));
  }
}
function markSubmittedBids() { state.tasks.filter((task) => task.has_bid).forEach((task) => { const card = document.querySelector(`[data-task="${task.id}"]`); if (card && !card.querySelector('.submitted-bid-mark')) card.insertAdjacentHTML('afterbegin', '<span class="submitted-bid-mark"><i class="fa-solid fa-check"></i> Bid submitted</span>'); }); }
async function fetchTaskList({ silent = false } = {}) {
  const requestId = ++taskFetchSequence;
  taskFetchInFlight = true;
  const params = new URLSearchParams(Object.entries(state.filters).filter(([, value]) => value));
  params.set('_ts', String(Date.now()));
  try {
    const payload = await api(`api/get_tasks?${params}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache' } });
    if (requestId !== taskFetchSequence) return;
    const changed = !taskListLoaded || JSON.stringify(payload.tasks) !== JSON.stringify(state.tasks);
    state.tasks = payload.tasks;
    taskListLoaded = true;
    if (changed) { renderTasks(); markSubmittedBids(); }
  } catch (error) { if (!silent) notify(error.message, 'error'); }
  finally { if (requestId === taskFetchSequence) taskFetchInFlight = false; }
}
function loadTasks() { return fetchTaskList(); }
function refreshMarketplaceTasks() {
  if (document.hidden || !navigator.onLine || taskFetchInFlight || document.querySelector('.app-page:not(.hidden)')?.id !== 'marketplace-page') return;
  return fetchTaskList({ silent: true });
}
function startTaskPolling() {
  if (state.taskRefreshTimer) clearInterval(state.taskRefreshTimer);
  state.taskRefreshTimer = setInterval(refreshMarketplaceTasks, 10000);
}
function fillEditForm(task) {
  Object.entries(task).forEach(([key, value]) => {
    const input = $(`#edit-${key}`);
    if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = key === 'checklist' && Array.isArray(value) ? value.join('\n') : value ?? '';
  });
  const form = $('#edit-form');
  const statusField = $('#edit-status');
  if (statusField) statusField.disabled = !['admin','superadmin'].includes(state.user?.role);
  form.dataset.keepImageUrls = JSON.stringify(Array.isArray(task.image_urls) ? task.image_urls.slice(0, 3) : []);
  const photoInput = form.querySelector('[data-task-photo-input]');
  if (photoInput) photoInput.value = '';
  form.querySelector('.task-photo-previews')?.replaceChildren();
  renderExistingTaskPhotos(form);
  openModal('#edit-modal');
}
function taskDetailExtras(task) {
  const mode = { on_site: 'On-site', online: 'Online', hybrid: 'Hybrid' }[task.task_mode] || 'On-site';
  const date = task.schedule_date ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'long' }).format(new Date(`${task.schedule_date}T00:00:00`)) : 'Flexible date';
  const checklist = Array.isArray(task.checklist) ? task.checklist.filter(Boolean) : [];
  return `<div class="task-detail-facts"><span><i class="fa-regular fa-calendar" aria-hidden="true"></i><strong>Preferred date</strong>${escapeHtml(date)}</span><span><i class="fa-solid fa-laptop-house" aria-hidden="true"></i><strong>Work type</strong>${escapeHtml(mode)}</span><span><i class="fa-solid fa-peso-sign" aria-hidden="true"></i><strong>Budget</strong>${task.budget_type === 'negotiable' ? 'Negotiable' : 'Fixed'}${task.materials_included ? ' · materials included' : ''}</span></div>${task.requirements ? `<section class="task-detail-extra"><h3>Requirements</h3><p>${escapeHtml(task.requirements)}</p></section>` : ''}${checklist.length ? `<section class="task-detail-extra"><h3>Task checklist</h3><ul>${checklist.map((item) => `<li><i class="fa-regular fa-circle-check" aria-hidden="true"></i>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}`;
}
async function openTask(task) {
  const currentPage = document.querySelector('.app-page:not(.hidden)')?.id;
  if (currentPage !== 'task-detail-modal') {
    state.taskDetailReturn = { pageId: currentPage || 'marketplace-page', scrollY: window.scrollY };
  }
  state.activeTask = task;
  const isOwner = state.user && Number(state.user.id) === Number(task.user_id);
  updateTaskMessageCount(isOwner ? task.unread_message_count : 0);
  $('#task-detail-content').innerHTML = `<p class="text-sm font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category)}</p><h2 class="mt-1 text-2xl font-bold">${escapeHtml(task.title)}</h2>${taskPhotoMarkup(task)}<div class="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-[#f5f7f8] p-4 text-sm"><div><p class="text-xs text-[#68727c]">Budget</p><p class="mt-1 font-bold">${money(task.budget)}</p></div><div><p class="text-xs text-[#68727c]">Location</p><p class="mt-1 font-bold">${escapeHtml(task.location)}</p></div></div><p class="mt-5 whitespace-pre-wrap text-sm leading-6 text-[#4c5962]">${escapeHtml(task.description)}</p>${taskDetailExtras(task)}<div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbe3e7] bg-white p-4"><div><p class="text-xs font-semibold uppercase tracking-wider text-[#68727c]">Posted by</p>${isOwner ? `<p class="mt-1 inline-flex items-center gap-2 font-bold text-slate-700"><i class="fa-regular fa-user" aria-hidden="true"></i>${escapeHtml(task.owner_name)} <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold">You</span></p>` : `<button type="button" data-public-profile="${Number(task.user_id)}" data-profile-task="${Number(task.id)}" class="mt-1 inline-flex items-center gap-2 font-bold text-[#006f70] hover:underline"><i class="fa-regular fa-user" aria-hidden="true"></i>${escapeHtml(task.owner_name)}<i class="fa-solid fa-arrow-up-right-from-square text-xs" aria-hidden="true"></i></button>`}</div>${!isOwner ? `<button type="button" data-public-profile="${Number(task.user_id)}" data-profile-task="${Number(task.id)}" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">View tasker profile</button>` : ''}</div>${!state.user && task.status === 'Open' ? `<div class="mt-5 flex flex-wrap gap-3"><button type="button" data-guest-bid="${Number(task.id)}" class="touch-target rounded-lg bg-[#006f70] px-5 font-bold text-white">Submit bid</button><button type="button" data-contact-tasker="${Number(task.id)}" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">Contact Tasker</button></div>` : ''}`;
  const canManage = state.user && (['admin','moderator','superadmin'].includes(state.user.role) || (state.user.role === 'user' && Number(state.user.id) === Number(task.user_id)));
  if (state.user && !isOwner && !['admin', 'superadmin'].includes(state.user.role)) $('#task-detail-content').insertAdjacentHTML('beforeend', `<div class="mt-5 border-t border-[#edf0f1] pt-4"><button type="button" data-report-task="${Number(task.id)}" disabled class="touch-target rounded-lg border border-slate-200 bg-slate-100 px-4 text-sm font-bold text-slate-500" aria-label="Checking whether you already reported this task"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Checking report status...</button></div>`);
  if (canManage) {
    const mayDeleteTask = task.status !== 'Completed' || ['admin', 'superadmin'].includes(state.user?.role);
    $('#task-detail-content').insertAdjacentHTML('beforeend', `<div class="mt-6 flex flex-wrap gap-3 border-t border-[#edf0f1] pt-5"><button data-edit="${task.id}" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]"><i class="fa-solid fa-pen-to-square mr-2"></i>Edit task</button>${mayDeleteTask ? `<button data-delete="${task.id}" class="touch-target rounded-lg border border-red-200 px-4 text-sm font-bold text-red-600"><i class="fa-solid fa-trash mr-2"></i>Delete task</button>` : '<p class="self-center text-sm font-semibold text-[#52616c]">Completed tasks are kept in your history.</p>'}</div>`);
  }
  $('#task-detail-id').value = task.id;
  if (!$('#bid-submitted-state')) $('#bid-section').insertAdjacentHTML('beforebegin', '<div id="bid-submitted-state" class="submitted-bid-state hidden"><i class="fa-solid fa-circle-check"></i><div><strong>Bid submitted</strong><p>The task owner can review your offer and message you here.</p></div></div>');
  $('#bid-submitted-state').classList.add('hidden');
  $('#bid-section').classList.toggle('hidden', !state.user || isOwner || task.status !== 'Open');
  $('#bids-section').classList.toggle('hidden', !isOwner && !['admin', 'superadmin'].includes(state.user?.role));
  if (!state.user) { $('#bids-section').classList.add('hidden'); $('#bids-list').replaceChildren(); }
  showPage('task-detail-modal');
  const backgroundLoads = [];
  if (isOwner) backgroundLoads.push(api(`api/notifications?action=task_messages&task_id=${task.id}`).then((payload) => updateTaskMessageCount(payload.unread_count)).catch(() => {}));
  if (state.user && !isOwner && !['admin', 'superadmin'].includes(state.user.role)) backgroundLoads.push(api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'has_reported', task_id: Number(task.id) }) }).then((payload) => setTaskReportButtonState(task.id, payload.has_reported)).catch(() => setTaskReportButtonState(task.id, false)));
  if (!state.user) return;
  try {
    const bidRequest = api(`api/bid_actions?action=list&task_id=${task.id}`);
    const [payload] = await Promise.all([bidRequest, ...backgroundLoads]);
    const myBid = payload.bids.find((bid) => Number(bid.bidder_id) === Number(state.user?.id));
    const hasActiveBid = Boolean(myBid && ['Pending', 'Accepted'].includes(myBid.status));
    $('#bid-section').classList.toggle('hidden', hasActiveBid || isOwner || task.status !== 'Open');
    $('#bid-submitted-state').classList.toggle('hidden', !hasActiveBid);
    renderBids(payload.bids, task);
    const roleContext = roleTaskContextMarkup(task, payload.bids, Boolean(isOwner));
    if (roleContext) $('#task-detail-content').insertAdjacentHTML('beforeend', roleContext);
    void updateNotificationCounts();
  } catch (error) { notify(error.message, 'error'); }
}
function setTaskReportButtonState(taskId, hasReported) {
  const button = document.querySelector(`[data-report-task="${Number(taskId)}"]`);
  if (!button) return;
  button.disabled = Boolean(hasReported);
  button.className = hasReported
    ? 'touch-target rounded-lg border border-slate-200 bg-slate-100 px-4 text-sm font-bold text-slate-500 cursor-not-allowed'
    : 'touch-target rounded-lg border border-red-200 px-4 text-sm font-bold text-red-600 hover:bg-red-50';
  button.setAttribute('aria-label', hasReported ? 'You have already reported this task' : 'Report this task');
  button.innerHTML = hasReported
    ? '<i class="fa-solid fa-circle-check mr-2" aria-hidden="true"></i>Report submitted'
    : '<i class="fa-regular fa-flag mr-2" aria-hidden="true"></i>Report this task';
}
function returnFromTaskDetails() {
  const previous = state.taskDetailReturn || { pageId: 'marketplace-page', scrollY: 0 };
  state.taskDetailReturn = null;
  showPage(previous.pageId);
  requestAnimationFrame(() => window.scrollTo({ top: previous.scrollY, left: 0, behavior: 'instant' }));
}
async function openSuperadminTask(task) {
  if (!['superadmin','admin','moderator'].includes(state.user?.role)) { notify('Only moderation staff can review marketplace tasks.', 'error'); return; }
  state.superadminTaskReturn = document.querySelector('.app-page:not(.hidden)')?.id || 'task-management-page';
  const content = $('#superadmin-task-detail-content');
  content.innerHTML = '<div class="superadmin-review-card p-10 text-center"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Loading task and bid details...</div>';
  showPage('superadmin-task-detail-page');
  try {
    const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'view_task_details', task_id: Number(task.id) }) });
    task = payload.task;
    const owner = task.owner || {};
    const fullName = task.owner_name || `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'TaskerPH member';
    const photos = taskPhotoMarkup(task);
    const ownerAvatar = owner.avatar_path
      ? `<img class="superadmin-review-owner-avatar" src="${escapeHtml(owner.avatar_path)}" alt="${escapeHtml(fullName)} profile photo" loading="lazy">`
      : `<span class="superadmin-review-owner-icon"><i class="fa-solid fa-user" aria-hidden="true"></i></span>`;
    const bidsHtml = (payload.bids || []).map((bid) => {
      const bidder = bid.bidder || {};
      const bidderName = `${bidder.first_name || ''} ${bidder.middle_initial ? `${bidder.middle_initial}. ` : ''}${bidder.last_name || ''}`.trim() || 'TaskerPH member';
      const statusClass = bid.status === 'Accepted' ? 'is-accepted' : bid.status === 'Pending' ? 'is-pending' : 'is-rejected';
      return `<article class="superadmin-bid-row"><div class="superadmin-bid-person"><span class="superadmin-bid-avatar">${bidder.avatar_path ? `<img src="${escapeHtml(bidder.avatar_path)}" alt="">` : `<i class="fa-solid fa-user" aria-hidden="true"></i>`}</span><div class="min-w-0"><button type="button" data-superadmin-view-profile="${Number(bid.bidder_id)}" class="superadmin-bid-profile">${escapeHtml(bidderName)} <i class="fa-solid fa-arrow-up-right-from-square text-xs" aria-hidden="true"></i></button><small>${escapeHtml(bidder.email || '')}</small></div></div><div class="superadmin-bid-offer"><span>Bid offer</span><strong>${money(bid.amount)}</strong></div><span class="superadmin-bid-status ${statusClass}">${escapeHtml(bid.status)}</span><div class="superadmin-bid-message"><p>${escapeHtml(bid.message || 'No message provided.')}</p>${bid.removal_reason ? `<small>Removal reason: ${escapeHtml(bid.removal_reason)}</small>` : ''}<small>Submitted ${escapeHtml(formatActivityTimestamp(bid.created_at))}</small></div></article>`;
    }).join('') || '<p class="superadmin-profile-empty">No bids have been submitted for this task.</p>';
    const stats = payload.stats || {};
    content.innerHTML = `<div class="superadmin-review-summary"><div><span class="superadmin-review-label">Listing status</span><span class="superadmin-status-pill" data-status="${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></div><div><span class="superadmin-review-label">Task ID</span><strong>#${Number(task.id)}</strong></div><div><span class="superadmin-review-label">Posted</span><strong>${escapeHtml(formatActivityTimestamp(task.created_at))}</strong></div></div><div class="superadmin-bid-count-grid"><article><span>Total bids</span><strong>${Number(stats.total_bids) || 0}</strong></article><article><span>Accepted</span><strong>${Number(stats.accepted_bids) || 0}</strong></article><article><span>Pending</span><strong>${Number(stats.pending_bids) || 0}</strong></article><article><span>Not accepted</span><strong>${Number(stats.rejected_bids) || 0}</strong></article></div><div class="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,.8fr)]"><article class="superadmin-review-card"><p class="text-xs font-bold uppercase tracking-[.15em] text-[#008f8c]">${escapeHtml(task.category || 'Uncategorized')}</p><h2 class="mt-2 text-2xl font-extrabold">${escapeHtml(task.title)}</h2>${photos}<div class="mt-5 grid gap-3 sm:grid-cols-2"><div class="superadmin-review-field"><span>Budget</span><strong>${money(task.budget)}</strong></div><div class="superadmin-review-field"><span>Location</span><strong>${escapeHtml(task.location || 'Not provided')}</strong></div></div><div class="superadmin-review-description"><h3>Task description</h3><p>${escapeHtml(task.description || 'No description provided.')}</p></div>${taskDetailExtras(task)}</article><aside class="superadmin-review-card h-fit"><div class="superadmin-review-owner-profile">${ownerAvatar}</div><p class="superadmin-review-label">Posted by</p><button type="button" data-superadmin-view-profile="${Number(task.user_id)}" class="mt-1 text-left text-xl font-bold text-[#006f70] hover:underline">${escapeHtml(fullName)} <i class="fa-solid fa-arrow-up-right-from-square ml-1 text-xs" aria-hidden="true"></i></button><p class="mt-1 break-all text-sm text-slate-500">${escapeHtml(owner.email || '')}</p><div class="mt-5 border-t border-slate-200 pt-4"><p class="superadmin-review-label">Moderation</p><p class="mt-2 text-sm leading-6 text-slate-600">Remove this listing if it violates marketplace rules or contains unsafe content.</p><button type="button" data-delete="${Number(task.id)}" class="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-rose-200 px-4 font-bold text-rose-600 hover:bg-rose-50"><i class="fa-solid fa-trash" aria-hidden="true"></i>Remove listing</button></div></aside></div><section class="superadmin-review-card"><div class="mb-4"><p class="superadmin-review-label">Bid activity</p><h3 class="mt-1 text-xl font-bold">Submitted bids</h3><p class="mt-1 text-sm text-slate-500">${Number(stats.total_bids) || 0} bids received · latest ${(payload.bids || []).length}</p></div><div class="space-y-3">${bidsHtml}</div></section>`;
    if (task.status === 'Under Review') {
      const disputes=(payload.disputes||[]).map((dispute)=>{const reporterRole=Number(dispute.opened_by)===Number(task.user_id)?'Poster':'Tasker';return `<article class="superadmin-review-field"><span>${reporterRole} report · ${escapeHtml(`${dispute.opener?.first_name||''} ${dispute.opener?.last_name||''}`.trim()||'Participant')} · ${escapeHtml(formatActivityTimestamp(dispute.created_at))}</span><p>${escapeHtml(dispute.details)}</p></article>`;}).join('');
      content.insertAdjacentHTML('afterbegin',`<section class="superadmin-review-card task-dispute-admin"><p class="superadmin-review-label">Participant dispute</p><h2 class="mt-1 text-xl font-bold">Resolve task issue</h2><p class="mt-2 text-sm">The task is paused. Review the report details and choose how it should proceed.</p><div class="mt-3 grid gap-2">${disputes||'<p>No report details were found for this task.</p>'}</div><div class="mt-4 flex flex-wrap gap-2"><button type="button" data-resolve-task="${Number(task.id)}" data-resolution-status="In Progress" class="touch-target rounded-lg border px-4 font-bold">Resume task</button><button type="button" data-resolve-task="${Number(task.id)}" data-resolution-status="Completed" class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white">Mark completed</button><button type="button" data-resolve-task="${Number(task.id)}" data-resolution-status="Cancelled" class="touch-target rounded-lg border border-rose-300 px-4 font-bold text-rose-700">Cancel task</button></div></section>`);
    }
  } catch (error) {
    content.innerHTML = `<div class="superadmin-review-card p-8 text-center"><p class="font-bold">Could not load task moderation details.</p><p class="mt-2 text-sm text-slate-500">${escapeHtml(error.message)}</p></div>`;
  }
}
async function openSuperadminUserProfile(userId) {
  if (!['superadmin','support','admin','moderator'].includes(state.user?.role)) { notify('Only staff can view member profiles.', 'error'); return; }
  state.superadminProfileReturn = document.querySelector('.app-page:not(.hidden)')?.id || 'user-management-page';
  const content = $('#superadmin-user-profile-content');
  content.innerHTML = '<div class="superadmin-review-card p-10 text-center"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Loading account profile...</div>';
  showPage('superadmin-user-profile-page');
  try {
    const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'view_user_profile', user_id: Number(userId) }) });
    const profile = payload.profile;
    state.superadminProfileTasks = payload.tasks || [];
    state.superadminProfileBids = payload.submitted_bids || [];
    const name = `${profile.first_name} ${profile.middle_initial ? `${profile.middle_initial}. ` : ''}${profile.last_name}`.trim();
    const initials = `${profile.first_name?.[0] || ''}${profile.last_name?.[0] || ''}`.toUpperCase();
    const canReviewTasks=['superadmin','admin','moderator'].includes(state.user?.role);
    const avatar = profile.avatar_path ? `<img class="superadmin-profile-avatar" src="${escapeHtml(profile.avatar_path)}" alt="${escapeHtml(name)}">` : `<span class="superadmin-profile-avatar superadmin-profile-initials">${escapeHtml(initials)}</span>`;
    const tasks = (payload.tasks || []).map((task) => `<article class="superadmin-profile-task"><div class="min-w-0"><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category || 'Uncategorized')}</p><h3 class="mt-1 truncate font-bold">${escapeHtml(task.title)}</h3><p class="mt-1 text-sm text-slate-500">${escapeHtml(task.location || 'No location')} · ${money(task.budget)}</p></div><span class="superadmin-status-pill" data-status="${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>${canReviewTasks?`<button type="button" data-superadmin-view-task="${Number(task.id)}" class="admin-action-button text-[#006f70]">View task</button>`:''}</article>`).join('') || '<p class="superadmin-profile-empty">No tasks posted by this account.</p>';
    const activity = (payload.recent_activity || []).map((item) => `<article class="superadmin-profile-activity"><span><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></span><div class="min-w-0"><strong>${escapeHtml(item.summary)}</strong><small>${escapeHtml(item.event_type.replaceAll('_',' '))} · ${escapeHtml(formatActivityTimestamp(item.created_at))}</small></div></article>`).join('') || '<p class="superadmin-profile-empty">No recent account activity.</p>';
    const moderationHistory=(payload.moderation_history||[]).map((item)=>`<article class="superadmin-profile-activity"><span><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></span><div class="min-w-0"><strong>${escapeHtml(item.summary||item.action||'Moderation action')}</strong><small>${escapeHtml(item.actor_name||'Staff')} · ${escapeHtml(formatActivityTimestamp(item.created_at))}</small>${item.reason?`<p class="mt-1 text-sm">${escapeHtml(item.reason)}</p>`:''}</div></article>`).join('')||'<p class="superadmin-profile-empty">No moderation history recorded for this account.</p>';
    const activityTitle = profile.role === 'admin' ? 'Recent admin activity' : 'Recent account activity';
    const submittedBids = (payload.submitted_bids || []).map((bid) => {
      const task = bid.task || {};
      const ownerName = task.owner ? `${task.owner.first_name} ${task.owner.last_name}`.trim() : 'TaskerPH member';
      const statusClass = bid.status === 'Accepted' ? 'is-accepted' : bid.status === 'Pending' ? 'is-pending' : 'is-rejected';
      return `<article class="superadmin-profile-bid"><div class="min-w-0 flex-1"><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category || 'Task bid')}</p><h4>${escapeHtml(task.title || `Task #${bid.task_id}`)}</h4><p>Task owner: ${escapeHtml(ownerName)} · ${money(bid.amount)} · Submitted ${escapeHtml(formatActivityTimestamp(bid.created_at))}</p><blockquote>${escapeHtml(bid.message || '')}</blockquote></div><span class="superadmin-bid-status ${statusClass}">${escapeHtml(bid.status)}</span>${canReviewTasks?`<button type="button" data-superadmin-view-task="${Number(bid.task_id)}" class="admin-action-button text-[#006f70]">View task</button>`:''}</article>`;
    }).join('') || '<p class="superadmin-profile-empty">This account has not submitted any bids.</p>';
    content.innerHTML = `<section class="superadmin-profile-hero">${avatar}<div class="min-w-0 flex-1"><p class="superadmin-review-label">Superadmin account review</p><h2>${escapeHtml(name)}</h2><p>${escapeHtml(profile.email)}</p></div><span class="superadmin-profile-role">${escapeHtml(profile.role)}</span></section><section class="superadmin-profile-stats"><article><span>Member since</span><strong>${escapeHtml(formatActivityTimestamp(profile.created_at))}</strong></article><article><span>Last login</span><strong>${escapeHtml(formatActivityTimestamp(profile.last_login_at))}</strong></article><article><span>Tasks posted</span><strong>${Number(payload.stats?.total_tasks) || 0}</strong></article><article><span>Completed tasks</span><strong>${Number(payload.stats?.completed_tasks) || 0}</strong></article><article><span>Bids submitted</span><strong>${Number(payload.stats?.total_bids) || 0}</strong></article><article><span>Accepted bids</span><strong>${Number(payload.stats?.accepted_bids) || 0}</strong></article></section><section class="superadmin-review-card"><div class="mb-4"><p class="superadmin-review-label">Marketplace activity</p><h3 class="mt-1 text-xl font-bold">User's tasks</h3><p class="mt-1 text-sm text-slate-500">Latest ${(payload.tasks || []).length} listings for this account.</p></div><div class="space-y-3">${tasks}</div></section><section class="superadmin-review-card"><div class="mb-4"><p class="superadmin-review-label">Marketplace activity</p><h3 class="mt-1 text-xl font-bold">Submitted bids</h3><p class="mt-1 text-sm text-slate-500">Latest ${(payload.submitted_bids || []).length} bids from this account.</p></div><div class="space-y-3">${submittedBids}</div></section><section class="superadmin-review-card"><div class="mb-4"><p class="superadmin-review-label">Account timeline</p><h3 class="mt-1 text-xl font-bold">${activityTitle}</h3></div><div class="space-y-3">${activity}</div></section><section class="superadmin-review-card"><div class="mb-4"><p class="superadmin-review-label">Moderation timeline</p><h3 class="mt-1 text-xl font-bold">Moderation history</h3><p class="mt-1 text-sm text-slate-500">Authorized staff can review actions involving this account.</p></div><div class="space-y-3">${moderationHistory}</div></section>`;
  } catch (error) {
    content.innerHTML = `<div class="superadmin-review-card p-8 text-center"><p class="font-bold">Could not load this account profile.</p><p class="mt-2 text-sm text-slate-500">${escapeHtml(error.message)}</p></div>`;
  }
}
async function openPublicProfile(userId, taskId = null) {
  const currentPage = document.querySelector('.app-page:not(.hidden)')?.id || 'marketplace-page';
  state.publicProfileReturn = { pageId: currentPage, scrollY: window.scrollY, taskId: Number(taskId) || null };
  $('#public-profile-content').innerHTML = '<div class="card p-8 text-center text-sm text-[#68727c]"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Loading tasker profile...</div>';
  showPage('public-profile-page');
  try {
    const payload = await api(`api/profile_actions?action=public&id=${encodeURIComponent(userId)}`);
    state.publicProfileTasks = payload.tasks || [];
    const profile = payload.profile;
    const fullName = `${profile.first_name} ${profile.middle_initial ? `${profile.middle_initial}. ` : ''}${profile.last_name}`;
    const initialsText = `${profile.first_name?.[0] || ''}${profile.last_name?.[0] || ''}`.toUpperCase();
    const avatar = profile.avatar_path
      ? `<img src="${escapeHtml(profile.avatar_path)}" alt="${escapeHtml(fullName)}" class="h-20 w-20 rounded-2xl object-cover ring-4 ring-white shadow-lg">`
      : `<span class="flex h-20 w-20 items-center justify-center rounded-2xl bg-[#d1fae5] text-2xl font-extrabold text-[#047857] ring-4 ring-white shadow-lg">${escapeHtml(initialsText)}</span>`;
    const joined = new Date(profile.created_at).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
    const listings = state.publicProfileTasks.length ? state.publicProfileTasks.map((task) => `<article class="rounded-xl border border-[#dbe3e7] bg-white p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category)}</p><h3 class="mt-1 font-bold text-[#17202a]">${escapeHtml(task.title)}</h3><p class="mt-1 text-sm text-[#68727c]">${escapeHtml(task.location)} &middot; ${money(task.budget)}</p></div><span class="badge ${task.status === 'Open' ? 'badge-open' : task.status === 'Completed' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(task.status)}</span></div><button type="button" data-open-public-task="${task.id}" class="mt-4 touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">View task <i class="fa-solid fa-arrow-right ml-2" aria-hidden="true"></i></button></article>`).join('') : '<div class="rounded-xl border border-dashed border-[#c9d4d9] px-5 py-10 text-center text-sm text-[#68727c]">This tasker has no public listings yet.</div>';
    $('#public-profile-content').innerHTML = `<section class="relative overflow-hidden rounded-2xl border border-[#dbe3e7] bg-white p-6 shadow-sm sm:p-8"><div class="absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-emerald-100 via-teal-50 to-amber-50" aria-hidden="true"></div><div class="relative flex flex-col items-start gap-5 sm:flex-row sm:items-end">${avatar}<div class="min-w-0 flex-1"><p class="text-xs font-bold uppercase tracking-[.16em] text-[#008f8c]">TaskerPH community member</p><h2 class="mt-1 text-3xl font-extrabold tracking-tight text-[#17202a]">${escapeHtml(fullName)}</h2><p class="mt-2 text-sm text-[#68727c]"><i class="fa-regular fa-calendar mr-2" aria-hidden="true"></i>Member since ${escapeHtml(joined)}</p></div></div><div class="mt-7 grid grid-cols-2 gap-3 sm:max-w-md"><div class="rounded-xl bg-[#f5f7f8] p-4"><p class="text-2xl font-extrabold text-[#17202a]">${Number(payload.total_tasks) || 0}</p><p class="mt-1 text-xs font-semibold uppercase tracking-wider text-[#68727c]">Tasks posted</p></div><div class="rounded-xl bg-[#f5f7f8] p-4"><p class="text-2xl font-extrabold text-[#17202a]">${Number(payload.completed_tasks) || 0}</p><p class="mt-1 text-xs font-semibold uppercase tracking-wider text-[#68727c]">Completed listings</p></div></div></section><section class="mt-8"><div class="mb-4 flex items-end justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-[.16em] text-[#008f8c]">Marketplace activity</p><h2 class="mt-1 text-2xl font-bold">Recent listings</h2></div><span class="text-sm text-[#68727c]">Latest ${state.publicProfileTasks.length}</span></div><div class="grid gap-3 sm:grid-cols-2">${listings}</div></section>`;
    const statsGrid = $('#public-profile-content section:first-child .mt-7.grid');
    statsGrid?.classList.remove('sm:max-w-md');
    statsGrid?.classList.add('sm:max-w-2xl');
    if (statsGrid) {
      const rating = Number(payload.average_rating) || 0;
      const ratingCount = Number(payload.rating_count) || 0;
      const completedListingStat = statsGrid.children[1];
      if (completedListingStat) {
        completedListingStat.querySelector('p:first-child').textContent = String(Number(payload.completed_listings) || 0);
        completedListingStat.querySelector('p:last-child').textContent = 'Completed listings';
      }
      statsGrid.insertAdjacentHTML('beforeend', `<div class="rounded-xl bg-[#f5f7f8] p-4"><p class="text-2xl font-extrabold text-[#17202a]">${Number(payload.completed_as_tasker) || 0}</p><p class="mt-1 text-xs font-semibold uppercase tracking-wider text-[#68727c]">Completed as tasker</p></div>`);
      statsGrid.insertAdjacentHTML('beforeend', `<div class="rounded-xl bg-[#f5f7f8] p-4"><p class="text-2xl font-extrabold text-[#17202a]">${ratingCount ? `${rating.toFixed(1)} <span class="text-amber-500">★</span>` : '—'}</p><p class="mt-1 text-xs font-semibold uppercase tracking-wider text-[#68727c]">Average rating</p><p class="mt-1 text-xs text-[#52616c]">${ratingCount} ${ratingCount === 1 ? 'review' : 'reviews'}</p></div>`);
    }
    const reviews=(payload.reviews||[]).map((review)=>`<article class="profile-review"><div><strong>${escapeHtml(review.reviewer_name)}</strong><span>${Number(review.rating)}/5 stars</span></div><small>${escapeHtml(formatActivityTimestamp(review.created_at))}</small>${review.comment?`<p>${escapeHtml(review.comment)}</p>`:''}</article>`).join('');
    $('#public-profile-content').insertAdjacentHTML('beforeend',`<section class="mt-8"><p class="text-xs font-bold uppercase tracking-[.16em] text-[#008f8c]">Completed task feedback</p><h2 class="mt-1 text-2xl font-bold">Reviews</h2><div class="mt-4 grid gap-3">${reviews||'<p class="text-sm text-[#52616c]">No reviews yet.</p>'}</div></section>`);
  } catch (error) {
    $('#public-profile-content').innerHTML = `<div class="card p-8 text-center"><p class="font-bold">Could not load this tasker profile.</p><p class="mt-2 text-sm text-[#68727c]">${escapeHtml(error.message)}</p><button type="button" data-public-profile-back class="touch-target mt-5 rounded-lg border border-[#c9d4d9] px-4 font-bold text-[#006f70]">Go back</button></div>`;
  }
}
function returnFromPublicProfile() {
  const previous = state.publicProfileReturn || { pageId: 'marketplace-page', scrollY: 0 };
  state.publicProfileReturn = null;
  showPage(previous.pageId);
  requestAnimationFrame(() => window.scrollTo({ top: previous.scrollY, left: 0, behavior: 'instant' }));
}
function taskProblemModal(taskId) {
  if (!$('#task-problem-modal')) document.body.insertAdjacentHTML('beforeend', '<div id="task-problem-modal" class="modal-backdrop fixed inset-0 z-[106] hidden items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="task-problem-title"><form id="task-problem-form" class="modal-panel w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><input type="hidden" name="task_id"><p class="text-xs font-bold uppercase tracking-wider text-amber-700">Task review</p><h2 id="task-problem-title" class="mt-1 text-2xl font-bold">Report a problem</h2><p class="mt-2 text-sm leading-6 text-slate-600">This pauses completion while the issue is reviewed. Describe what happened so the other participant can understand.</p><label class="mt-5 block text-sm font-bold">Problem details<textarea name="details" rows="5" minlength="10" maxlength="2000" required class="form-control mt-2" placeholder="Describe the issue (at least 10 characters)"></textarea></label><div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" data-close="task-problem-modal" class="touch-target rounded-lg border border-slate-300 px-5 font-bold">Cancel</button><button type="submit" class="touch-target rounded-lg bg-amber-700 px-5 font-bold text-white">Pause task and report</button></div></form></div>');
  const form=$('#task-problem-form'); form.elements.task_id.value=String(taskId); form.reset(); form.elements.task_id.value=String(taskId); openModal('#task-problem-modal');
}
function reviewForm(taskId, revieweeName) { return `<form data-task-review="${Number(taskId)}" class="task-review-form"><div><strong>Leave a review</strong><small>Rate your experience with ${escapeHtml(revieweeName || 'the other participant')}.</small></div><label>Rating<select name="rating" required class="form-control"><option value="">Choose a rating</option><option value="5">5 stars - Excellent</option><option value="4">4 stars - Good</option><option value="3">3 stars - Okay</option><option value="2">2 stars - Poor</option><option value="1">1 star - Very poor</option></select></label><label>Comment <span>(optional)</span><textarea name="comment" rows="3" maxlength="1000" class="form-control" placeholder="Share helpful feedback"></textarea></label><button type="submit" class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white">Submit review</button></form>`; }
function lifecycleActionsForOwner(task) {
  if (task.status === 'Awaiting Confirmation') return `<div class="task-lifecycle-panel is-awaiting"><strong>Tasker marked this task as done</strong><p>Confirm completion or report a problem to pause the task.</p><div><button type="button" data-task-lifecycle="confirm_completion" data-task-id="${Number(task.id)}" class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white">Confirm completion</button><button type="button" data-task-lifecycle="report_problem" data-task-id="${Number(task.id)}" class="touch-target rounded-lg border border-amber-300 px-4 font-bold text-amber-800">Report a problem</button></div></div>`;
  if (task.status === 'In Progress') return `<div class="task-lifecycle-panel"><strong>Working with ${escapeHtml(task.accepted_tasker_name || 'your selected tasker')}</strong><p>When the work is done, the tasker will mark it done and ask you to confirm.</p><div><button type="button" data-task-lifecycle="report_problem" data-task-id="${Number(task.id)}" class="touch-target rounded-lg border border-amber-300 px-4 font-bold text-amber-800">Report a problem</button><button type="button" data-task-lifecycle="cancel_assignment" data-task-id="${Number(task.id)}" class="touch-target rounded-lg border border-rose-300 px-4 font-bold text-rose-700">Cancel assignment</button></div></div>`;
  if (task.status === 'Under Review') return '<div class="task-lifecycle-panel is-awaiting"><strong>Task paused for review</strong><p>A reported problem is awaiting review before this task can continue or complete.</p></div>';
  if (task.status === 'Cancelled') return '<div class="task-lifecycle-panel is-cancelled"><strong>Assignment cancelled</strong></div>';
  if (task.status === 'Completed' && task.accepted_tasker_id) return task.has_reviewed ? '<div class="task-lifecycle-panel is-complete"><strong>Completion confirmed · You reviewed the tasker</strong></div>' : `<div class="task-lifecycle-panel is-complete"><strong>Completion confirmed</strong>${reviewForm(task.id, task.accepted_tasker_name)}</div>`;
  return '';
}
function renderBids(bids, task) { const isOwner = state.user && Number(state.user.id) === Number(task.user_id); const isModerator = ['admin', 'superadmin'].includes(state.user?.role); $('#bids-section h3').textContent = `Bids (${bids.length})`; $('#bids-list').innerHTML = bids.length ? bids.map((bid) => `<div class="bid-row rounded-lg border border-[#dbe3e7] p-4"><div class="bid-row-heading"><div class="bid-person"><button type="button" data-public-profile="${Number(bid.bidder_id)}" data-profile-task="${Number(task.id)}" class="bidder-profile-link">${bid.bidder_avatar_path ? `<img src="${escapeHtml(bid.bidder_avatar_path)}" alt="" class="bidder-profile-avatar bidder-profile-photo">` : `<span class="bidder-profile-avatar"><i class="fa-regular fa-user" aria-hidden="true"></i></span>`}<span class="bidder-profile-copy"><strong>${escapeHtml(bid.bidder_name)}</strong><small>View bidder profile <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></small></span></button>${bid.unread_message_count ? `<span data-bid-message-count="${task.id}-${bid.bidder_id}" class="task-message-count"><i class="fa-solid fa-message"></i> ${bid.unread_message_count} new</span>` : ''}<p class="text-xs text-[#68727c]">Offer: ${money(bid.amount)} &middot; ${escapeHtml(bid.status)}</p></div></div><p class="mt-3 text-sm leading-6 text-[#4c5962]">${escapeHtml(bid.message)}</p>${bid.removal_reason ? `<p class="bid-removal-reason"><strong>Removal reason:</strong> ${escapeHtml(bid.removal_reason)}</p>` : ''}<div class="bid-row-actions">${isOwner || isModerator ? `<button data-message-task="${task.id}" data-message-user="${bid.bidder_id}" class="touch-target rounded-lg border border-[#c9d4d9] px-3 text-xs font-bold text-[#006f70]">Message</button>` : ''}${(isOwner || isModerator) && bid.status === 'Pending' ? `<button data-accept-bid="${bid.id}" data-accept-task="${task.id}" class="touch-target rounded-lg bg-[#006f70] px-3 text-xs font-bold text-white">Accept</button><button data-remove-bid="${bid.id}" data-remove-bid-task="${task.id}" class="touch-target rounded-lg border border-red-200 px-3 text-xs font-bold text-red-600">Remove</button>` : ''}</div></div>`).join('') : '<p class="text-sm text-[#68727c]">No bids yet.</p>'; }
async function loadMyBids() { if (!state.user) { requestAuthGate('bids'); return; } showPage('my-bids-page'); $('#my-bids-page-list').innerHTML = '<p class="py-8 text-center text-sm text-[#68727c]">Loading your bids...</p>'; $('#my-bids-search').oninput = renderFilteredMyBids; $('#my-bids-status-filter').onchange = renderFilteredMyBids; $('#my-bids-task-filter').onchange = renderFilteredMyBids; try { const payload = await api('api/bid_actions?action=my_bids'); myBidsData = payload.bids || []; renderFilteredMyBids(); } catch (error) { notify(error.message, 'error'); } }
function renderFilteredMyBids() {
  const query = ($('#my-bids-search')?.value || '').trim().toLocaleLowerCase();
  const bidStatus = $('#my-bids-status-filter')?.value || 'all';
  const taskStatus = $('#my-bids-task-filter')?.value || 'all';
  const filtered = myBidsData.filter((bid) => {
    if (bidStatus !== 'all' && bid.status !== bidStatus) return false;
    if (taskStatus !== 'all' && bid.task_status !== taskStatus) return false;
    if (!query) return true;
    return [bid.title, bid.category, bid.owner_name, bid.location, bid.status, bid.task_status, bid.message]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query));
  });
  const count = $('#my-bids-result-count');
  if (count) count.textContent = `Showing ${filtered.length} of ${myBidsData.length} ${myBidsData.length === 1 ? 'bid' : 'bids'}`;
  if (!filtered.length && myBidsData.length) {
    $('#my-bids-page-list').innerHTML = '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><i class="fa-solid fa-filter mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">No bids match these filters.</p><p class="mt-1 text-sm text-[#68727c]">Try another status or search term.</p></div>';
    return;
  }
  renderEditableMyBids(filtered);
  updateCompletedBidStatusLabels(filtered);
  linkMyBidOwnerProfiles(filtered);
  renderMyBidWorkflow(filtered);
}
function displayedBidStatus(bid) {
  return bid.status === 'Accepted' && bid.task_status === 'Completed' ? 'Completed' : bid.status;
}
function updateCompletedBidStatusLabels(bids) {
  const cards = $('#my-bids-page-list')?.querySelectorAll(':scope > article') || [];
  bids.forEach((bid, index) => {
    const badge = cards[index]?.querySelector('.badge');
    if (!badge) return;
    const status = displayedBidStatus(bid);
    badge.textContent = status;
    badge.classList.remove('badge-open', 'badge-complete', 'badge-progress');
    badge.classList.add(status === 'Completed' || status === 'Rejected' ? 'badge-complete' : status === 'Accepted' ? 'badge-open' : 'badge-progress');
  });
}
function linkMyBidOwnerProfiles(bids) {
  const cards = $('#my-bids-page-list')?.querySelectorAll(':scope > article') || [];
  bids.forEach((bid, index) => {
    const ownerLine = [...(cards[index]?.querySelectorAll('p') || [])].find((line) => line.textContent.startsWith('Task owner:'));
    if (!ownerLine || !Number(bid.owner_id)) return;
    const link = document.createElement('button');
    link.type = 'button';
    link.dataset.publicProfile = String(bid.owner_id);
    link.dataset.profileTask = String(bid.task_id);
    link.className = 'font-bold text-[#006f70] underline decoration-[#8bc9c0] underline-offset-2 hover:text-[#004f50]';
    link.textContent = bid.owner_name || 'View poster';
    ownerLine.replaceChildren(document.createTextNode('Task owner: '), link, document.createTextNode(` · ${bid.location || ''}`));
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.dataset.viewBidTask = String(bid.task_id);
    detailsButton.className = 'touch-target mt-3 rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70] hover:bg-[#f5f7f8]';
    detailsButton.innerHTML = '<i class="fa-regular fa-file-lines mr-2" aria-hidden="true"></i>View task details';
    cards[index]?.append(detailsButton);
  });
}
async function loadMyTasks() { if (!state.user) { requestAuthGate('tasks'); return; } currentTaskDrafts = []; $('#my-task-drafts')?.replaceChildren(); showPage('my-tasks-modal'); $('#my-tasks-list').innerHTML = '<p class="py-8 text-center text-sm text-[#68727c]">Loading your tasks...</p>'; try { const payload = await api('api/get_tasks?mine=1'); state.myTasks = payload.tasks; renderMyTasks(state.myTasks); addCancelledTaskActions(state.myTasks); if (!$('#my-task-drafts')) $('#my-tasks-list').insertAdjacentHTML('beforebegin', '<div id="my-task-drafts"></div>'); await loadMyTaskDrafts(); } catch (error) { notify(error.message, 'error'); } }
function addCancelledTaskActions(tasks) {
  const cards = $('#my-tasks-list')?.querySelectorAll(':scope > article') || [];
  tasks.forEach((task, index) => {
    if (task.status !== 'Cancelled' || !cards[index]) return;
    const actions = document.createElement('div');
    actions.className = 'mt-3 flex flex-wrap gap-2 border-t border-[#edf0f1] pt-3';
    actions.innerHTML = `<button type="button" data-reopen-task="${Number(task.id)}" class="touch-target rounded-lg bg-[#006f70] px-4 text-sm font-bold text-white"><i class="fa-solid fa-arrow-rotate-left mr-2" aria-hidden="true"></i>Reopen task</button><button type="button" data-repost-task="${Number(task.id)}" class="touch-target rounded-lg border border-[#b8ded8] px-4 text-sm font-bold text-[#076c64]"><i class="fa-solid fa-copy mr-2" aria-hidden="true"></i>Repost as new</button>`;
    cards[index].append(actions);
  });
}
function renderEditableMyBids(bids) { const html = bids.length ? bids.map((bid) => `<article class="activity-row rounded-lg border border-[#dbe3e7] p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(bid.category)}</p><h3 class="mt-1 font-bold">${escapeHtml(bid.title)}</h3><p class="mt-1 text-xs text-[#68727c]">Task owner: ${escapeHtml(bid.owner_name)} &middot; ${escapeHtml(bid.location)}</p></div><div class="flex items-center gap-2"><span class="badge ${bid.status === 'Accepted' ? 'badge-open' : bid.status === 'Rejected' || bid.status === 'Cancelled' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(bid.status)}</span>${bid.unread_message_count ? `<span data-bid-message-count="${bid.task_id}" class="task-message-count"><i class="fa-solid fa-message"></i> ${bid.unread_message_count} new</span>` : ''}</div></div>${bid.status === 'Cancelled' && bid.task_status === 'Open' ? '<p class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">The poster reopened this task, so the previous assignment was cancelled. You can submit a new bid if you are still interested.</p>' : ''}${bid.removal_reason ? `<p class="bid-removal-reason"><strong>Removed by owner:</strong> ${escapeHtml(bid.removal_reason)}</p>` : ''}<div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf0f1] pt-3 text-sm"><span>Your offer: <strong>${money(bid.amount)}</strong></span><span class="text-[#68727c]">Task: ${escapeHtml(bid.task_status)}</span><div class="flex gap-2">${bid.status === 'Pending' && bid.task_status === 'Open' ? `<button data-edit-bid="${bid.id}" class="touch-target rounded-lg border border-[#c9d4d9] px-3 text-xs font-bold text-[#006f70]">Edit bid</button><button data-delete-bid="${bid.id}" data-delete-bid-task="${bid.task_id}" class="touch-target rounded-lg border border-red-200 px-3 text-xs font-bold text-red-600">Delete bid</button>` : ''}<button data-message-task="${bid.task_id}" data-message-user="${bid.owner_id}" class="touch-target rounded-lg border border-[#008f8c] px-3 text-xs font-bold text-[#006f70]">Message owner</button></div></div><form data-bid-edit-form="${bid.id}" class="bid-edit-form hidden mt-4 grid gap-3 rounded-lg bg-[#f5f7f8] p-3"><label class="block text-sm font-bold">Offer amount<input name="amount" type="number" min="0" step="0.01" value="${bid.amount}" required class="form-control mt-2"></label><label class="block text-sm font-bold">Offer message<textarea name="message" rows="4" required maxlength="1000" class="form-control min-h-[100px] w-full resize-y overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600">${escapeHtml(bid.message)}</textarea></label><div class="mt-3 flex justify-end gap-2"><button type="submit" data-save-bid="${bid.id}" class="touch-target rounded-lg bg-[#006f70] px-3 text-xs font-bold text-white">Save</button><button type="button" data-cancel-bid="${bid.id}" class="touch-target rounded-lg border border-[#c9d4d9] px-3 text-xs font-bold">Cancel</button></div></form><p class="mt-2 text-sm text-[#4c5962]">${escapeHtml(bid.message)}</p></article>`).join('') : '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><i class="fa-solid fa-gavel mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">You have not placed any bids yet.</p><p class="mt-1 text-sm text-[#68727c]">Open a task from the marketplace to make your first offer.</p></div>'; $('#my-bids-page-list').innerHTML = html; }
function renderMyBids(bids) { const html = bids.length ? bids.map((bid) => `<article class="activity-row rounded-lg border border-[#dbe3e7] p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(bid.category)}</p><h3 class="mt-1 font-bold">${escapeHtml(bid.title)}</h3><p class="mt-1 text-xs text-[#68727c]">Task owner: ${escapeHtml(bid.owner_name)} &middot; ${escapeHtml(bid.location)}</p></div><span class="badge ${bid.status === 'Accepted' ? 'badge-open' : bid.status === 'Rejected' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(bid.status)}</span></div><div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf0f1] pt-3 text-sm"><span>Your offer: <strong>${money(bid.amount)}</strong></span><span class="text-[#68727c]">Task: ${escapeHtml(bid.task_status)}</span><button data-message-task="${bid.task_id}" data-message-user="${bid.owner_id}" class="touch-target rounded-lg border border-[#008f8c] px-3 text-xs font-bold text-[#006f70]">Message owner</button></div><p class="mt-2 text-sm text-[#4c5962]">${escapeHtml(bid.message)}</p></article>`).join('') : '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><i class="fa-solid fa-gavel mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">You have not placed any bids yet.</p><p class="mt-1 text-sm text-[#68727c]">Open a task from the marketplace to make your first offer.</p></div>'; $('#my-bids-page-list').innerHTML = html; }
function renderMyTasks(tasks) { $('#my-tasks-list').innerHTML = tasks.length ? tasks.map((task) => `<article class="activity-row rounded-lg border border-[#dbe3e7] p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category)}</p><h3 class="mt-1 font-bold">${escapeHtml(task.title)}</h3><p class="mt-1 text-xs text-[#68727c]">${escapeHtml(task.location)} · ${money(task.budget)}${task.schedule_date ? ` · ${escapeHtml(task.schedule_date)}` : ''}</p></div><span class="badge ${task.status === 'Open' ? 'badge-open' : task.status === 'Completed' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(task.status)}</span></div><div class="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf0f1] pt-3"><span class="text-sm text-[#68727c]">${escapeHtml((task.description || '').slice(0,90))}${(task.description || '').length > 90 ? '...' : ''}</span><div class="flex flex-wrap items-center justify-end gap-3"><span class="task-bid-count"><i class="fa-solid fa-gavel"></i> ${task.bid_count} ${task.bid_count === 1 ? 'bid' : 'bids'}</span><button data-open-my-task="${task.id}" class="touch-target rounded-lg px-3 text-xs font-bold text-[#006f70]">Open</button>${task.status === 'Completed' ? `<button type="button" data-repost-task="${Number(task.id)}" class="touch-target rounded-lg border border-[#b8ded8] px-3 text-xs font-bold text-[#076c64]"><i class="fa-solid fa-rotate-right mr-1" aria-hidden="true"></i>Repost</button>` : ''}</div></div>${lifecycleActionsForOwner(task)}</article>`).join('') : '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d4] px-5 py-10 text-center"><i class="fa-solid fa-clipboard-list mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">You have not posted a task yet.</p><p class="mt-1 text-sm text-[#68727c]">Post a task and it will appear here.</p></div>'; }
function lifecycleActionsForTasker(bid) { if (bid.status !== 'Accepted') return ''; if (bid.task_status === 'In Progress') return `<div class="task-lifecycle-panel"><strong>Your bid was accepted</strong><p>Coordinate the schedule with the poster. When all agreed work is finished, mark it done to request confirmation.</p><div><button type="button" data-task-lifecycle="mark_done" data-task-id="${Number(bid.task_id)}" class="touch-target rounded-lg bg-[#006f70] px-4 font-bold text-white">Mark as done</button><button type="button" data-task-lifecycle="report_problem" data-task-id="${Number(bid.task_id)}" class="touch-target rounded-lg border border-amber-300 px-4 font-bold text-amber-800">Report a problem</button><button type="button" data-task-lifecycle="cancel_assignment" data-task-id="${Number(bid.task_id)}" class="touch-target rounded-lg border border-rose-300 px-4 font-bold text-rose-700">Cancel assignment</button></div></div>`; if (bid.task_status === 'Awaiting Confirmation') return '<div class="task-lifecycle-panel is-awaiting"><strong>Waiting for poster confirmation</strong><p>The poster has been notified. The task is not complete until they confirm it.</p></div>'; if (bid.task_status === 'Under Review') return '<div class="task-lifecycle-panel is-awaiting"><strong>Task paused for review</strong><p>A problem was reported. The task is paused while the issue is reviewed.</p></div>'; if (bid.task_status === 'Cancelled') return '<div class="task-lifecycle-panel is-cancelled"><strong>Assignment cancelled</strong></div>'; if (bid.task_status === 'Completed') return bid.has_reviewed ? '<div class="task-lifecycle-panel is-complete"><strong>Completion confirmed · You reviewed the poster</strong></div>' : `<div class="task-lifecycle-panel is-complete"><strong>Completion confirmed</strong>${reviewForm(bid.task_id,bid.owner_name)}</div>`; return ''; }
function roleTaskContextMarkup(task, bids, isOwner) {
  const acceptedBid = (bids || []).find((bid) => bid.status === 'Accepted');
  if (isOwner) {
    if (!acceptedBid) return `<section class="task-role-context"><p class="task-role-eyebrow">Poster view</p><h3>Manage your listing</h3><p>Review incoming offers in the bids section below. Task progress and completion controls will appear here after you accept a tasker.</p></section>`;
    const assignedTask = { ...task, accepted_tasker_id: acceptedBid.bidder_id, accepted_tasker_name: acceptedBid.bidder_name, has_reviewed: acceptedBid.has_reviewed };
    return `<section class="task-role-context"><p class="task-role-eyebrow">Poster view · ${escapeHtml(task.status)}</p><h3>Assigned tasker</h3><div class="task-role-person"><button type="button" data-public-profile="${Number(acceptedBid.bidder_id)}" data-profile-task="${Number(task.id)}">${escapeHtml(acceptedBid.bidder_name)} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button><span>Accepted offer: <strong>${money(acceptedBid.amount)}</strong></span></div></section>${lifecycleActionsForOwner(assignedTask)}`;
  }
  const myBid = (bids || []).find((bid) => Number(bid.bidder_id) === Number(state.user?.id));
  if (!myBid) return '';
  const taskerBid = { ...myBid, task_status: task.status, owner_name: task.owner_name, has_reviewed: myBid.has_reviewed };
  return `<section class="task-role-context"><p class="task-role-eyebrow">Tasker view · ${escapeHtml(task.status)}</p><h3>Your offer</h3><div class="task-role-person"><span>Offer: <strong>${money(myBid.amount)}</strong></span><span>Bid status: <strong>${escapeHtml(displayedBidStatus(taskerBid))}</strong></span></div>${myBid.status === 'Accepted' ? lifecycleActionsForTasker(taskerBid) : `<p class="mt-3 text-sm">${myBid.status === 'Pending' ? 'Your offer is waiting for the poster.' : myBid.status === 'Rejected' ? 'The poster selected another tasker.' : 'This bid is no longer active.'}</p>`}</section>`;
}
async function refreshCurrentTaskWorkflow(taskId, nextStatus = null) {
  const pageId = document.querySelector('.app-page:not(.hidden)')?.id;
  if (pageId === 'my-bids-page') return loadMyBids();
  if (pageId === 'task-detail-modal') {
    if (nextStatus && Number(state.activeTask?.id) === Number(taskId)) return openTask({ ...state.activeTask, status: nextStatus });
    const payload = await api(`api/bid_actions?action=task_details&task_id=${encodeURIComponent(taskId)}`);
    return openTask(payload.task);
  }
  return loadMyTasks();
}
function renderMyBidWorkflow(bids) { bids.forEach((bid,index)=>{ const actions=lifecycleActionsForTasker(bid); if(actions) $('#my-bids-page-list').children[index]?.insertAdjacentHTML('beforeend',actions); }); }
function formatMessageTime(value) { const date = new Date(String(value).replace(' ', 'T')); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
async function refreshConversation() {
  const taskId = Number($('#conversation-task-id')?.value);
  const otherUserId = Number($('#conversation-user-id')?.value);
  if (!taskId || !otherUserId || state.conversationFetchInFlight || document.hidden || $('#conversation-modal')?.classList.contains('hidden')) return;
  state.conversationFetchInFlight = true;
  try {
    const params = new URLSearchParams({ action: 'list', task_id: String(taskId), other_user_id: String(otherUserId) });
    const previous = state.conversationMessages.filter((message) => Number.isFinite(Number(message.id)));
    const latest = previous.at(-1);
    const fullSync = !latest || Date.now() - state.conversationLastFullSync >= 30_000;
    if (!fullSync && latest?.created_at) params.set('after', latest.created_at);
    const payload = await api(`api/messages?${params}`);
    // Discard a response if the user switched conversations while it was loading.
    if (taskId !== Number($('#conversation-task-id')?.value) || otherUserId !== Number($('#conversation-user-id')?.value) || document.hidden || $('#conversation-modal')?.classList.contains('hidden')) return;
    if (fullSync) {
      state.conversationMessages = payload.messages;
      state.conversationLastFullSync = Date.now();
    } else if (payload.messages.length) {
      const merged = new Map(state.conversationMessages.map((message) => [String(message.id), message]));
      payload.messages.forEach((message) => merged.set(String(message.id), message));
      state.conversationMessages = [...merged.values()].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    renderConversation(state.conversationMessages, false);
    if (state.activeTask) { state.activeTask.unread_message_count = 0; updateTaskMessageCount(0); }
    const badgeSelector = state.conversationReturnPage === 'my-bids-page'
      ? `[data-bid-message-count="${taskId}"]`
      : `[data-bid-message-count="${taskId}-${otherUserId}"]`;
    document.querySelectorAll(badgeSelector).forEach((element) => element.remove());
  } catch (error) { notify(error.message, 'error'); }
  finally { state.conversationFetchInFlight = false; }
}
async function openConversation(taskId, otherUserId) {
  if (state.conversationTimer) clearInterval(state.conversationTimer);
  state.conversationReturnPage = document.querySelector('.app-page:not(.hidden)')?.id || 'marketplace-page';
  state.conversationMessages = [];
  state.conversationLastFullSync = 0;
  $('#conversation-task-id').value = taskId;
  $('#conversation-user-id').value = otherUserId;
  if (!$('#conversation-task-summary')) {
    $('#conversation-user-id').insertAdjacentHTML('afterend', '<div id="conversation-task-summary" class="card mt-6 flex flex-col justify-between gap-4 border-l-4 border-l-[#008f8c] p-4 sm:flex-row sm:items-center"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">About this task</p><h2 id="conversation-task-title" class="mt-1 text-lg font-bold">Loading task...</h2><p id="conversation-task-meta" class="mt-1 text-sm text-[#52616c]"></p></div><button type="button" data-conversation-task-details class="touch-target shrink-0 rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">View task details</button></div>');
  }
  $('#conversation-task-title').textContent = 'Loading task...';
  $('#conversation-task-meta').textContent = '';
  const taskDetailsButton = $('[data-conversation-task-details]');
  if (taskDetailsButton) taskDetailsButton.disabled = false;
  $('#conversation-list').innerHTML = '<p class="text-sm text-[#68727c]">Loading conversation...</p>';
  showPage('conversation-modal');
  await Promise.all([refreshConversation(), loadConversationTaskSummary(taskId)]);
  await updateNotificationCounts();
  state.conversationTimer = setInterval(refreshConversation, 5000);
}
async function handleNativePushOpen(data = {}) {
  if (!state.user) { pendingNativePushOpen = data; return; }
  const taskId = Number(data.task_id);
  if (data.type === 'message' && taskId && Number(data.other_user_id)) {
    await openConversation(taskId, Number(data.other_user_id));
    return;
  }
  if (taskId) {
    try {
      const payload = await api(`api/bid_actions?action=task_details&task_id=${encodeURIComponent(taskId)}`);
      await openTask(payload.task);
      return;
    } catch (error) { notify(error.message, 'error'); }
  }
  await loadNotificationCenter();
}
window.addEventListener('taskerph:push-open', (event) => { void handleNativePushOpen(event.detail || {}); });
async function loadConversationTaskSummary(taskId) {
  try {
    const payload = await api(`api/bid_actions?action=task_details&task_id=${encodeURIComponent(taskId)}`);
    if (Number($('#conversation-task-id')?.value) !== Number(taskId)) return;
    const task = payload.task;
    $('#conversation-task-title').textContent = task.title || `Task #${taskId}`;
    $('#conversation-task-meta').textContent = [task.category, task.status, task.location].filter(Boolean).join(' · ');
  } catch (error) {
    if (Number($('#conversation-task-id')?.value) === Number(taskId)) {
      $('#conversation-task-title').textContent = `Task #${taskId}`;
      $('#conversation-task-meta').textContent = 'Task details are unavailable.';
      const button = $('[data-conversation-task-details]');
      if (button) button.disabled = true;
    }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.conversationTimer) { clearInterval(state.conversationTimer); state.conversationTimer = null; }
    return;
  }
  if (!$('#conversation-modal')?.classList.contains('hidden')) {
    refreshConversation();
    state.conversationTimer = setInterval(refreshConversation, 5000);
  }
});
function renderConversation(messages, scrollToBottom = true) {
  const confirmedIds = new Set(messages.map((message) => String(message.id)));
  state.pendingMessages = state.pendingMessages.filter((message) => !message.server_id || !confirmedIds.has(String(message.server_id)));
  const taskId = Number($('#conversation-task-id').value), otherId = Number($('#conversation-user-id').value);
  const pending = state.pendingMessages.filter((message) => message.task_id === taskId && message.other_user_id === otherId);
  const items = [...messages, ...pending].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  $('#conversation-list').innerHTML = items.length ? items.map((message) => {
    const mine = Number(message.sender_id) === Number(state.user.id);
    const status = mine ? (message.delivery_status || (message.read_at ? 'Seen' : 'Sent Â· Delivered')) : '';
    return `<div class="message-bubble ${mine ? 'message-mine' : 'message-theirs'}"><p class="text-sm">${escapeHtml(message.body)}</p><p class="mt-1 text-[11px] opacity-70">${escapeHtml(message.sender_name)} &middot; ${escapeHtml(formatMessageTime(message.created_at))}</p>${mine ? `<p class="message-status">${status}</p>` : ''}</div>`;
  }).join('') : '<p class="text-sm text-[#68727c]">Start the conversation about this task.</p>';
  if (scrollToBottom) $('#conversation-list').scrollTop = $('#conversation-list').scrollHeight;
}
function startMobileSplash() {
  const splash = $('.mobile-splash');
  if (!splash || document.documentElement.classList.contains('mobile-splash-seen') || !window.matchMedia('(max-width: 1023px)').matches) return null;
  const status = $('#mobile-splash-status');
  const messages = ['Connecting to Tasker PH...', 'Loading latest marketplace data...', 'Almost ready...'];
  const controller = { splash, slowTimer: 0, rotateTimer: 0 };
  controller.slowTimer = window.setTimeout(() => {
    splash.classList.add('is-waiting');
    let index = 0;
    if (status) status.textContent = messages[index];
    controller.rotateTimer = window.setInterval(() => {
      index = (index + 1) % messages.length;
      if (status) status.textContent = messages[index];
    }, 1800);
  }, 3000);
  return controller;
}
async function finishMobileSplash(controller) {
  if (!controller) return;
  window.clearTimeout(controller.slowTimer);
  window.clearInterval(controller.rotateTimer);
  controller.splash.classList.add('is-exiting');
  controller.splash.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => controller.splash.remove(), 520);
}
async function init() {
  const mobileSplash = startMobileSplash();
  const footer = document.querySelector('footer');
  if (footer) document.body.appendChild(footer);
  try {
    localStorage.removeItem('taskerph-appearance');
    localStorage.removeItem('theme');
  } catch (error) { void error; }
  let sessionExpired = false;
  try {
    const accessToken = localStorage.getItem(AUTH_TOKEN_KEY);
    const refreshToken = localStorage.getItem(AUTH_REFRESH_TOKEN_KEY);
    let lastActivity = Number(localStorage.getItem(AUTH_ACTIVITY_KEY)) || 0;
    if (accessToken || refreshToken) {
      if (!lastActivity) {
        lastActivity = Date.now();
        localStorage.setItem(AUTH_ACTIVITY_KEY, String(lastActivity));
      }
      if (Date.now() - lastActivity >= AUTH_INACTIVITY_LIMIT) {
        sessionExpired = true;
        clearStoredAuth();
        broadcastAuthChange();
      }
    }
    if (!sessionExpired) {
      let session = await api('api/auth?action=session');
      if (!session.user && refreshToken && await refreshStoredAuth()) session = await api('api/auth?action=session');
      state.user = session.user;
      if (state.user) recordAuthActivity();
    }
  } catch (error) { notify(error.message, 'error'); }
  const taskDetailPage = $('#task-detail-modal');
  taskDetailPage?.classList.remove('modal-backdrop', 'fixed', 'inset-0', 'z-50', 'items-center', 'justify-center', 'p-4');
  const myTasksPage = $('#my-tasks-modal');
  myTasksPage?.classList.remove('modal-backdrop', 'fixed', 'inset-0', 'z-50', 'items-center', 'justify-center', 'p-4');
  myTasksPage?.classList.add('app-page', 'page-shell', 'my-tasks-page', 'hidden');
  taskDetailPage?.classList.add('app-page', 'page-shell', 'task-detail-page', 'hidden');
  [taskDetailPage, myTasksPage].forEach((page) => {
    const backButton = page?.querySelector('[data-close]');
    if (backButton) {
      backButton.className = 'touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]';
      backButton.innerHTML = '<i class="fa-solid fa-arrow-left mr-2"></i>Back to tasks';
    }
  });
  renderAuth();
  if (sessionExpired) {
    openModal('#login-modal');
    notify('You were signed out because the account was inactive for 30 days. Please log in again.', 'error');
  }
  if (state.user) applyUserAppearance(state.user);
  else applySystemAppearance();
  loadUserGlassPreference(state.user);
  try { localStorage.removeItem('taskerph-glass-opacity'); } catch (error) { void error; }
  if (state.user?.role === 'superadmin') {
    if(state.user.mfa_setup_required) {
      showPage('superadmin-account-page');
      renderSuperadminAccountSettings();
      await openSuperadminMfaEnrollment();
      await finishMobileSplash(mobileSplash);
      return;
    }
    showPage('account-activity-modal');
    await openAccountActivity();
    await finishMobileSplash(mobileSplash);
    return;
  }
  if (['admin','moderator'].includes(state.user?.role)) {
    showPage('staff-dashboard-page');
    const staffLoads=[loadStaffDashboard(),loadTasks()];
    if (state.user) staffLoads.push(refreshSavedTaskData().catch((error)=>notify(error.message,'error')));
    await Promise.all(staffLoads);
    renderTasks();
    startNotificationPolling();
    startTaskPolling();
    await finishMobileSplash(mobileSplash);
    maybeShowInstallGuide();
    return;
  }
  const initialLoads = [loadTasks()];
  if (state.user) initialLoads.push(refreshSavedTaskData().catch((error) => notify(error.message, 'error')));
  await Promise.all(initialLoads);
  if (state.user) renderTasks();
  startNotificationPolling(); startTaskPolling(); await finishMobileSplash(mobileSplash); maybeShowInstallGuide();
}
window.addEventListener('storage', async (event) => {
  if (event.key !== AUTH_SYNC_KEY) return;
  try {
    let session = await api('api/auth?action=session');
    if (!session.user && await refreshStoredAuth()) session = await api('api/auth?action=session');
    const wasLoggedIn = Boolean(state.user);
    const previousUserId = state.user?.id;
    state.user = session.user;
    if (!state.user) {
      applySystemAppearance();
      applyGlassOpacity(0);
      state.myTasks = [];
      state.savedTasks = [];
      state.savedTaskIds.clear();
      updateSavedTaskCount(0);
      if (state.notificationTimer) clearInterval(state.notificationTimer);
      if (wasLoggedIn) {
        closeDrawer();
        showPage('marketplace-page');
        openModal('#login-modal');
      }
    } else {
      if (!wasLoggedIn || Number(previousUserId) !== Number(state.user.id)) {
        applyUserAppearance(state.user);
        loadUserGlassPreference(state.user);
      }
      await refreshSavedTaskData();
      startNotificationPolling();
    }
    renderAuth();
    renderTasks();
    if (state.user && state.user.role !== 'superadmin' && (!wasLoggedIn || Number(previousUserId) !== Number(state.user.id))) await loadTasks();
    if (state.user?.role === 'superadmin' && (!wasLoggedIn || Number(previousUserId) !== Number(state.user.id))) await openAccountActivity();
    await updateNotificationCounts();
  } catch (error) { notify(error.message, 'error'); }
});
async function performLogout() {
  await window.taskerphPushLogout?.();
  await api('api/auth?action=logout', { method: 'POST' });
  clearStoredAuth();
  state.logoutTrigger = null;
  closeModal('logout-confirm-modal');
  state.user = null;
  applySystemAppearance();
  applyGlassOpacity(0);
  state.myTasks = [];
  state.savedTasks = [];
  state.savedTaskIds.clear();
  state.activeTask = null;
  myBidsData = [];
  updateSavedTaskCount(0);
  renderSavedTasks();
  renderTasks();
  broadcastAuthChange();
  renderAuth();
  await updateNotificationCounts();
  showPage('marketplace-page');
  await loadTasks();
  notify('You have been logged out.');
}
function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: window-controls-overlay)').matches
    || navigator.standalone === true
    || document.referrer.startsWith('android-app://');
}
function dismissInstallGuide(installed = false) {
  try {
    localStorage.setItem(installed ? INSTALL_GUIDE_INSTALLED_KEY : INSTALL_GUIDE_DISMISSED_KEY, '1');
  } catch (error) { void error; }
  closeModal('install-guide-modal');
  $('#install-guide-modal')?.remove();
  if (!document.querySelector('.modal-backdrop:not(.hidden)')) {
    document.body.classList.remove('overflow-hidden');
    document.documentElement.classList.remove('overflow-hidden');
    document.body.style.removeProperty('overflow');
    document.documentElement.style.removeProperty('overflow');
  }
}
function markTaskerInstalled() { dismissInstallGuide(true); }
function maybeShowInstallGuide() {
  const appleTouchDevice = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const androidDevice = /Android/i.test(navigator.userAgent);
  const compactTouchDevice = window.matchMedia('(max-width: 1023px) and (pointer: coarse)').matches;
  const mobileOrTablet = appleTouchDevice || androidDevice || compactTouchDevice;
  if (isStandaloneApp()) markTaskerInstalled();
  let alreadyInstalled = false;
  let dismissed = false;
  try {
    alreadyInstalled = localStorage.getItem(INSTALL_GUIDE_INSTALLED_KEY) === '1';
    dismissed = localStorage.getItem(INSTALL_GUIDE_DISMISSED_KEY) === '1';
  } catch (error) { void error; }
  if (!mobileOrTablet || alreadyInstalled || dismissed || document.querySelector('.modal-backdrop:not(.hidden)')) return;
  const guideId = appleTouchDevice ? '#install-guide-ios' : androidDevice ? '#install-guide-android' : '#install-guide-other';
  $(guideId)?.classList.remove('hidden');
  openModal('#install-guide-modal');
}
function handleInstallGuideDismiss(event) {
  const target = event.target instanceof Element ? event.target : null;
  const done = target?.closest('#install-guide-done');
  const dismiss = target?.closest('[data-dismiss-install-guide]');
  if (!done && !dismiss) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  dismissInstallGuide(false);
}
document.addEventListener('pointerup', handleInstallGuideDismiss, true);
document.addEventListener('click', handleInstallGuideDismiss, true);
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('#install-guide-native')?.classList.remove('hidden');
  $('#install-guide-native')?.classList.add('inline-flex');
});
window.addEventListener('appinstalled', markTaskerInstalled);
const installDisplayMode = window.matchMedia('(display-mode: standalone)');
const handleInstallDisplayModeChange = () => { if (isStandaloneApp()) markTaskerInstalled(); };
if (installDisplayMode.addEventListener) installDisplayMode.addEventListener('change', handleInstallDisplayModeChange);
else installDisplayMode.addListener?.(handleInstallDisplayModeChange);
window.addEventListener('pageshow', handleInstallDisplayModeChange);
$('#install-guide-native')?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await promptEvent.prompt();
  const result = await promptEvent.userChoice;
  if (result?.outcome === 'accepted') markTaskerInstalled();
});
async function resumeAuthIntent(intent) {
  if (!intent) return;
  if (typeof intent === 'object' && intent.route === 'task-detail') {
    const task = intent.task || [...state.tasks, ...state.savedTasks].find((item) => Number(item.id) === Number(intent.taskId));
    if (task) await openTask(task);
    else notify('That task is no longer available.', 'error');
    return;
  }
  switch (intent) {
    case 'post': showPage('create-task-page'); break;
    case 'tasks': await loadMyTasks(); break;
    case 'bids': await loadMyBids(); break;
    case 'profile': await openProfile(); break;
    case 'saved': await loadSavedTasks(); break;
    case 'messages': showPage('marketplace-page'); break;
    default: showPage('marketplace-page');
  }
}
document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-conversation-task-details]')) {
    const taskId = Number($('#conversation-task-id')?.value);
    if (!taskId) return;
    try {
      const payload = await api(`api/bid_actions?action=task_details&task_id=${encodeURIComponent(taskId)}`);
      await openTask(payload.task);
    } catch (error) { notify(error.message, 'error'); }
    return;
  }
  if (event.target.closest('[data-notifications]')) { closeDesktopProfileMenu(); closeDrawer(); await loadNotificationCenter(); return; }
  if (event.target.closest('[data-notifications-retry]')) { await loadNotificationCenter(); return; }
  if (event.target.closest('[data-notifications-mark-all]')) {
    try { const payload = await api('api/notifications?action=mark_all_read', { method: 'POST', body: JSON.stringify({}) }); notify(payload.message); await loadNotificationCenter(); void updateNotificationCounts(); }
    catch (error) { notify(error.message, 'error'); }
    return;
  }
  const openNotificationButton = event.target.closest('[data-open-notification]');
  if (openNotificationButton) {
    const item = notificationCenterItems.find((entry) => String(entry.id) === openNotificationButton.dataset.openNotification);
    if (!item) return;
    if (item.type === 'message') { await openConversation(item.task_id, item.other_user_id); return; }
    if (item.type === 'announcement') { await openAnnouncement(item); return; }
    try {
      if (item.type === 'bid') await api(`api/notifications?action=read_bids&task_id=${encodeURIComponent(item.task_id)}`);
      else await api('api/notifications?action=read_item', { method: 'POST', body: JSON.stringify({ type: 'task', id: item.id }) });
      const payload = await api(`api/bid_actions?action=task_details&task_id=${encodeURIComponent(item.task_id)}`);
      await openTask(payload.task);
      void updateNotificationCounts();
    } catch (error) { notify(error.message, 'error'); }
    return;
  }
  const draftsShortcut = event.target.closest('[data-my-task-drafts]');
  if (draftsShortcut) {
    closeDesktopProfileMenu();
    await loadMyTasks();
    requestAnimationFrame(() => $('#my-task-drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return;
  }
  const previewButton = event.target.closest('[data-task-preview]');
  if (previewButton) {
    const form = previewButton.closest('form');
    if (form) $('#task-preview-content').innerHTML = await taskFormPreviewMarkup(form);
    openModal('#task-preview-modal');
    return;
  }
  const saveDraftButton = event.target.closest('[data-save-task-draft]');
  if (saveDraftButton) { const form = saveDraftButton.closest('form'); if (form) await saveTaskDraft(form); return; }
  const resumeDraftButton = event.target.closest('[data-resume-task-draft]');
  if (resumeDraftButton) {
    const draft = currentTaskDrafts.find((item) => Number(item.id) === Number(resumeDraftButton.dataset.resumeTaskDraft));
    if (!draft) { notify('Draft not found. Refresh My Tasks and try again.', 'error'); return; }
    const form = $('#create-task-form');
    await prefillTaskForm(form, draft.data, draft.id);
    showPage('create-task-page');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const deleteDraftButton = event.target.closest('[data-delete-task-draft]');
  if (deleteDraftButton) {
    try { await api('api/create_task?action=draft_delete', { method: 'POST', body: JSON.stringify({ draft_id: deleteDraftButton.dataset.deleteTaskDraft }) }); await loadMyTaskDrafts(); notify('Draft deleted.'); }
    catch (error) { notify(error.message, 'error'); }
    return;
  }
  const reopenTaskButton = event.target.closest('[data-reopen-task]');
  if (reopenTaskButton) {
    const approved = await decisionModal({ title: 'Reopen this cancelled task?', message: 'This will make the same listing open for new bids again. The previous cancelled assignment will stay in its history.', confirmLabel: 'Reopen task' });
    if (!approved) return;
    setButtonBusy(reopenTaskButton, true, 'Reopening...');
    try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'reopen_task', task_id: reopenTaskButton.dataset.reopenTask }) }); notify(payload.message); await loadTasks(); await loadMyTasks(); }
    catch (error) { notify(error.message, 'error'); }
    finally { setButtonBusy(reopenTaskButton, false); }
    return;
  }
  const repostButton = event.target.closest('[data-repost-task]');
  if (repostButton) {
    const approved = await decisionModal({ title: 'Repost this task?', message: 'Create a new open listing using the saved details from this task?', confirmLabel: 'Create listing' });
    if (!approved) return;
    setButtonBusy(repostButton, true, 'Reposting...');
    try { const payload = await api('api/create_task?action=repost', { method: 'POST', body: JSON.stringify({ task_id: repostButton.dataset.repostTask }) }); notify(payload.message); await loadTasks(); await loadMyTasks(); }
    catch (error) { notify(error.message, 'error'); }
    finally { setButtonBusy(repostButton, false); }
    return;
  }
  const userPageButton = event.target.closest('[data-superadmin-user-page]');
  if (userPageButton) { await loadAdminUsers(false,Number(userPageButton.dataset.superadminUserPage)||1); return; }
  const reportPageButton=event.target.closest('[data-admin-report-page]');
  if (reportPageButton) { adminReportPage=Math.max(0,Number(reportPageButton.dataset.adminReportPage)||0); await loadAdminReports(false); return; }
  const auditPageButton=event.target.closest('[data-admin-audit-page]');
  if (auditPageButton) { adminAuditPage=Math.max(0,Number(auditPageButton.dataset.adminAuditPage)||0); await loadAdminAudit(false); return; }
  if (event.target.closest('#admin-audit-export')) { await exportAuditCsv(); return; }
  if (event.target.closest('#admin-trends-export')) { exportTrendCsv(); return; }
  if (event.target.closest('#superadmin-task-load-more')) { await loadMoreSuperadminTasks(); return; }
  const taskViewButton = event.target.closest('[data-admin-task-view]');
  if (taskViewButton) {
    event.preventDefault();
    superadminTaskView = taskViewButton.dataset.adminTaskView === 'cards' ? 'cards' : 'list';
    try { localStorage.setItem('taskerph-superadmin-task-view', superadminTaskView); } catch (error) { void error; }
    renderSuperadminTasks();
    return;
  }
  const adminPageButton = event.target.closest('[data-admin-page]');
  if (adminPageButton) { event.preventDefault(); event.stopImmediatePropagation(); const targetPage = document.getElementById(adminPageButton.dataset.adminPage); if (!targetPage) { notify('This Superadmin page could not be found. Refresh the page and try again.', 'error'); return; } showPage(targetPage.id); return; }
  const viewAdminTaskButton = event.target.closest('[data-superadmin-view-task]');
  if (viewAdminTaskButton) {
    const taskId = Number(viewAdminTaskButton.dataset.superadminViewTask);
    const task = [...(accountActivityData.tasks || []), ...(state.superadminProfileTasks || [])].find((item) => Number(item.id) === taskId) || { id: taskId };
    if (viewAdminTaskButton.closest('#reporters-detail-modal')) closeModal('reporters-detail-modal');
    openSuperadminTask(task);
    return;
  }
  if (event.target.closest('#admin-notification-trigger, #staff-notification-trigger')) { openSuperadminNotifications(); return; }
  const adminAnnouncementButton=event.target.closest('[data-admin-announcement]');
  if(adminAnnouncementButton) {
    const announcement=adminNotificationAnnouncements.find((item)=>String(item.id)===adminAnnouncementButton.dataset.adminAnnouncement);
    if(!announcement) { notify('This announcement could not be found. Refresh notifications and try again.','error'); return; }
    closeModal('superadmin-notifications-modal');
    await openAnnouncement(announcement);
    return;
  }
  const adminNotificationReport = event.target.closest('[data-admin-notification-report]');
  if (adminNotificationReport) {
    const taskId = Number(adminNotificationReport.dataset.adminNotificationReport);
    closeModal('superadmin-notifications-modal');
    if (['admin','moderator'].includes(state.user?.role)) { showPage('report-management-page'); return; }
    if (taskId > 0) openReportersModal(taskId);
    else showPage('report-management-page');
    return;
  }
  const adminNotificationTask = event.target.closest('[data-admin-notification-task]');
  if (adminNotificationTask) {
    const taskId = Number(adminNotificationTask.dataset.adminNotificationTask);
    const task = accountActivityData.under_review_tasks.find((item) => Number(item.id) === taskId) || { id: taskId };
    closeModal('superadmin-notifications-modal');
    if (['admin','moderator'].includes(state.user?.role)) { showPage('task-management-page'); return; }
    openSuperadminTask(task);
    return;
  }
  const showReportersButton = event.target.closest('[data-show-reporters]');
  if (showReportersButton) { openReportersModal(showReportersButton.dataset.showReporters); return; }
  const viewAdminProfileButton = event.target.closest('[data-superadmin-view-profile]');
  if (viewAdminProfileButton) { if (viewAdminProfileButton.closest('#reporters-detail-modal')) closeModal('reporters-detail-modal'); await openSuperadminUserProfile(viewAdminProfileButton.dataset.superadminViewProfile); return; }
  const backFromAdminProfile = event.target.closest('[data-superadmin-profile-back]');
  if (backFromAdminProfile) { showPage(state.superadminProfileReturn || 'user-management-page'); return; }
  const backFromAdminTask = event.target.closest('[data-superadmin-task-back]');
  if (backFromAdminTask) { showPage(state.superadminTaskReturn || 'task-management-page'); return; }
  const deleteUserButton = event.target.closest('[data-delete-user]');
  const editUserButton = event.target.closest('[data-edit-user]');
  const suspendUserButton=event.target.closest('[data-suspend-user]');
  if (suspendUserButton) {
    const user=accountActivityData.users.find((item)=>Number(item.id)===Number(suspendUserButton.dataset.suspendUser));
    const canSuspendAsAdmin=state.user?.role==='admin'&&Boolean(state.user.staff_permissions?.can_view_users)&&user?.role==='user';
    if (!user || user.is_suspended || (state.user?.role!=='superadmin'&&!canSuspendAsAdmin)) return;
    const form=$('#admin-suspension-form');
    form.reset();
    $('#admin-suspension-access-note').textContent=state.user.role==='admin'?'Admin access · Member accounts only':'Superadmin account controls';
    form.elements.user_id.value=String(user.id);
    $('#admin-suspension-user').textContent=`${user.first_name} ${user.last_name} · ${user.email}`;
    openModal('#admin-suspension-modal');
    return;
  }
  const unsuspendButton=event.target.closest('[data-unsuspend-user]');
  if (unsuspendButton) {
    const user=accountActivityData.users.find((item)=>Number(item.id)===Number(unsuspendButton.dataset.unsuspendUser));
    if (!user || state.user?.role!=='superadmin') return;
    const confirmed=await decisionModal({title:'Reactivate this account?',message:`${user.first_name} ${user.last_name} will be able to sign in and use TaskerPH again.`,confirmLabel:'Reactivate account'});
    if (!confirmed) return;
    try {
      const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'unsuspend_user',user_id:user.id,reason:'Suspension lifted by Superadmin'})});
      notify(payload.message);
      await loadAccountActivity();
      await loadAdminUsers(false,superadminUserPage);
    } catch(error) { notify(error.message,'error'); }
    return;
  }
  if (editUserButton) {
    const user = accountActivityData.users.find((item) => Number(item.id) === Number(editUserButton.dataset.editUser));
    if (!user || user.role === 'superadmin' || state.user?.role !== 'superadmin') return;
    const form = $('#admin-edit-user-form');
    form.elements.user_id.value = String(user.id);
    form.elements.first_name.value = user.first_name || '';
    form.elements.middle_initial.value = user.middle_initial || '';
    form.elements.last_name.value = user.last_name || '';
    form.elements.email.value = user.email || '';
    form.elements.role.value = user.role;
    openModal('#admin-edit-user-modal');
    return;
  }
  if (deleteUserButton) {
    const user = accountActivityData.users.find((item) => Number(item.id) === Number(deleteUserButton.dataset.deleteUser));
    if (!user || user.role === 'superadmin' || state.user?.role !== 'superadmin') return;
    $('#delete-user-id').value = String(user.id);
    $('#delete-user-name').textContent = `${user.first_name} ${user.last_name}`.trim();
    $('#delete-user-email').textContent = user.email;
    openModal('#delete-user-modal');
    return;
  }
  const confirmDeleteUser=event.target.closest('#confirm-delete-user');
  if (confirmDeleteUser && state.user?.role==='superadmin') {
    event.preventDefault();
    const userId=$('#delete-user-id').value;
    if (!userId) return;
    const decision=await decisionModal({title:'Permanently delete this account?',message:`${$('#delete-user-name').textContent} and their profile-owned tasks and report history will be permanently deleted. This action cannot be undone. Add the reason to the durable administrator audit log.`,confirmLabel:'Continue to delete',danger:true,withReason:true,reasonLabel:'Deletion reason',reasonPlaceholder:'Explain the policy or operational reason'});
    if (!decision) return;
    if (!decision.reason) { notify('A deletion reason is required.','error'); return; }
    const button=confirmDeleteUser;
    setButtonBusy(button,true,'Deleting account...');
    try {
      const payload=await api('api/admin_actions',{method:'POST',body:JSON.stringify({action:'delete_user',user_id:userId,reason:decision.reason})});
      closeModal('delete-user-modal');
      notify(payload.message);
      await loadAccountActivity();
      await loadAdminUsers(true);
      showPage('user-management-page');
    } catch(error) { notify(error.message,'error'); }
    finally { setButtonBusy(button,false); }
    return;
  }
  const accountActivityButton = event.target.closest('[data-activity-dashboard]');
  if (accountActivityButton) {
    event.preventDefault();
    if (state.user?.role==='superadmin') await openAccountActivity();
    else if (state.user?.role==='support') showPage('user-management-page');
    else if (['admin','moderator'].includes(state.user?.role)) showPage('staff-dashboard-page');
    return;
  }
  const reportButton = event.target.closest('[data-report-task]');
  if (reportButton) {
    $('#report-task-id').value = reportButton.dataset.reportTask;
    $('#report-task-form').reset();
    $('#report-task-id').value = reportButton.dataset.reportTask;
    openModal('#report-task-modal');
    return;
  }
  const reviewButton = event.target.closest('[data-review-report]');
  if (reviewButton) {
    if (reviewButton.closest('#reporters-detail-modal')) closeModal('reporters-detail-modal');
    let note=reviewButton.closest('[data-admin-report-row]')?.querySelector('[name="resolution_note"]')?.value.trim()||'';
    if (!note) {
      const decision=await decisionModal({title:`${reviewButton.dataset.reportStatus} this report?`,message:'Add a resolution note so the review decision is recorded.',confirmLabel:'Continue',withReason:true,reasonLabel:'Resolution note',reasonPlaceholder:'Summarize your decision and any action taken'});
      if (!decision) return;
      note=decision.reason;
      if (!note) { notify('A resolution note is required.','error'); return; }
    }
    try {
      const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'review_report', report_id: reviewButton.dataset.reviewReport, status: reviewButton.dataset.reportStatus,note }) });
      notify(payload.message);
      await loadAdminReports(true);
      if (state.user?.role==='superadmin') await loadAccountActivity();
    }
    catch (error) { notify(error.message, 'error'); }
    return;
  }
  const photoButton = event.target.closest('[data-photo-url]');
  if (photoButton) { event.preventDefault(); event.stopPropagation(); openPhotoViewer(photoButton.dataset.photoUrl, photoButton.dataset.photoAlt); return; }
  const blockedRoute = protectedRouteForElement(event.target);
  if (!state.user && blockedRoute) {
    event.preventDefault();
    requestAuthGate(blockedRoute, event.target.closest('button, a'));
    return;
  }
  const guestBidButton = event.target.closest('[data-guest-bid]');
  if (guestBidButton && !state.user) {
    event.preventDefault();
    requestBidAuthGate(Number(guestBidButton.dataset.guestBid), guestBidButton);
    return;
  }
  const contactTaskerButton = event.target.closest('[data-contact-tasker]');
  if (contactTaskerButton && !state.user) {
    event.preventDefault();
    requestBidAuthGate(Number(contactTaskerButton.dataset.contactTasker), contactTaskerButton);
    return;
  }
  const profileTrigger = event.target.closest('#desktop-profile-trigger');
  if (profileTrigger) {
    const dropdown = $('#desktop-profile-dropdown');
    const opening = dropdown?.classList.contains('hidden');
    dropdown?.classList.toggle('hidden', !opening);
    profileTrigger.setAttribute('aria-expanded', String(Boolean(opening)));
    if (opening) void refreshTaskDraftCount();
    return;
  }
  const superadminProfileTrigger = event.target.closest('#superadmin-profile-trigger');
  if (superadminProfileTrigger) {
    const dropdown = $('#superadmin-profile-dropdown');
    const opening = dropdown?.classList.contains('hidden');
    dropdown?.classList.toggle('hidden', !opening);
    superadminProfileTrigger.setAttribute('aria-expanded', String(Boolean(opening)));
    return;
  }
  const superadminAccountFormButton = event.target.closest('[data-superadmin-account-form]');
  if (superadminAccountFormButton) {
    closeDesktopProfileMenu();
    const profileForms = {
      'admin-edit-profile': 'edit-profile-form',
      'admin-change-email': 'change-email-form',
      'admin-change-password': 'change-password-form',
    };
    const profileForm = profileForms[superadminAccountFormButton.dataset.superadminAccountForm];
    if (state.user?.role !== 'superadmin') {
      if (!profileForm || !['admin','moderator'].includes(state.user?.role)) return;
      renderSuperadminAccountSettings();
      showPage('superadmin-account-page');
      requestAnimationFrame(() => $(`#${profileForm}`)?.querySelector('input')?.focus({ preventScroll: true }));
      return;
    }
    renderSuperadminAccountSettings();
    showPage('superadmin-account-page');
    requestAnimationFrame(() => $(`#${superadminAccountFormButton.dataset.superadminAccountForm}`)?.querySelector('input')?.focus({ preventScroll: true }));
    return;
  }
  const desktopProfileForm = event.target.closest('[data-desktop-profile-form]');
  if (desktopProfileForm) { closeDesktopProfileMenu(); await openProfile(desktopProfileForm.dataset.desktopProfileForm); return; }
  const pageButton = event.target.closest('[data-page]'); if (pageButton) { showPage(pageButton.dataset.page); return; }
  const publicProfileButton = event.target.closest('[data-public-profile]'); if (publicProfileButton) { await openPublicProfile(publicProfileButton.dataset.publicProfile, publicProfileButton.dataset.profileTask); return; }
  if (event.target.closest('[data-public-profile-back]')) { returnFromPublicProfile(); return; }
  const savedTasksButton = event.target.closest('[data-saved-tasks]'); if (savedTasksButton) { closeDesktopProfileMenu(); await loadSavedTasks(); return; }
  const saveTaskButton = event.target.closest('[data-save-task]'); if (saveTaskButton) { event.preventDefault(); event.stopPropagation(); const taskId = Number(saveTaskButton.dataset.saveTask); const task = [...state.tasks, ...state.savedTasks].find((item) => Number(item.id) === taskId); if (task) await toggleSavedTask(task); return; }
  const modalButton = event.target.closest('[data-modal]'); if (modalButton) { if (modalButton.dataset.modal==='admin-modal'&&state.user?.role!=='superadmin') { notify('Only the Superadmin can create Admin accounts.','error'); return; } closeDesktopProfileMenu(); if (modalButton.dataset.modal === 'task-modal') showPage('create-task-page'); else openModal(`#${modalButton.dataset.modal}`); closeDrawer(); }
  const marketplaceLink = event.target.closest('a[href="#marketplace"]'); if (marketplaceLink) { event.preventDefault(); resetScrollPosition(); showPage('marketplace-page'); closeDrawer(); }
  const closeButton = event.target.closest('[data-close]'); if (closeButton) { if (closeButton.dataset.close === 'login-modal' && event.target.closest('[data-modal="register-modal"]')) state.preserveAuthIntent = true; if (closeButton.dataset.close === 'task-detail-modal') returnFromTaskDetails(); else if (closeButton.dataset.close === 'my-tasks-modal') showPage('marketplace-page'); else closeModal(`#${closeButton.dataset.close}`); }
  if (event.target.closest('[data-close-conversation]')) { showPage(state.conversationReturnPage); return; }
  if (event.target.classList.contains('modal-backdrop')) closeModal(`#${event.target.id}`);
  const taskCard = event.target.closest('[data-task]'); if (taskCard && !event.target.closest('[data-edit], [data-delete], [data-save-task]')) { const taskId = Number(taskCard.dataset.task); const task = [...state.tasks, ...state.savedTasks].find((item) => Number(item.id) === taskId); if (task) openTask(task); }
  if (event.target.closest('[data-my-bids]')) { closeDesktopProfileMenu(); resetScrollPosition(); closeDrawer(); loadMyBids(); }
  if (event.target.closest('[data-my-tasks]')) { closeDesktopProfileMenu(); resetScrollPosition(); closeDrawer(); loadMyTasks(); }
  if (event.target.closest('[data-profile-page]')) { closeDesktopProfileMenu(); resetScrollPosition(); void refreshTaskDraftCount(); openProfile(); return; }
  const legalDocumentButton = event.target.closest('[data-legal-document]');
  if (legalDocumentButton) { openLegalDocument(legalDocumentButton.dataset.legalDocument); return; }
  const profileFormToggle = event.target.closest('[data-profile-form]');
  if (profileFormToggle) { const form = $(`#${profileFormToggle.dataset.profileForm}`); form?.classList.toggle('hidden'); return; }
  if (event.target.closest('[data-appearance-toggle]')) { saveUserAppearance(!document.body.classList.contains('dark-mode')); }
  const myTaskButton = event.target.closest('[data-open-my-task]'); if (myTaskButton) { const task = state.myTasks.find((item) => Number(item.id) === Number(myTaskButton.dataset.openMyTask)); if (task) { closeModal('my-tasks-modal'); openTask(task); } }
  const bidTaskDetailsButton = event.target.closest('[data-view-bid-task]');
  if (bidTaskDetailsButton) {
    bidTaskDetailsButton.disabled = true;
    try {
      const payload = await api(`api/bid_actions?action=task_details&task_id=${encodeURIComponent(bidTaskDetailsButton.dataset.viewBidTask)}`);
      await openTask(payload.task);
    } catch (error) { notify(error.message, 'error'); }
    finally { bidTaskDetailsButton.disabled = false; }
    return;
  }
  const publicTaskButton = event.target.closest('[data-open-public-task]'); if (publicTaskButton) { const task = state.publicProfileTasks.find((item) => Number(item.id) === Number(publicTaskButton.dataset.openPublicTask)); if (task) openTask({ ...task, owner_name: `${$('#public-profile-content h2')?.textContent || 'TaskerPH member'}`, has_bid: false, is_saved: false, bid_count: 0, unread_message_count: 0 }); return; }
  if (event.target.closest('[data-menu]')) { $('#mobile-drawer').classList.remove('-translate-x-full'); $('#drawer-overlay').classList.remove('hidden'); }
  if (event.target.id === 'drawer-overlay' || event.target.closest('[data-close-drawer]')) closeDrawer();
  const logout = event.target.closest('[data-action="logout"]'); if (logout) { state.logoutTrigger = logout; closeDesktopProfileMenu(); openModal('#logout-confirm-modal'); requestAnimationFrame(() => $('#cancel-logout')?.focus({ preventScroll: true })); return; }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    if (['superadmin','admin','moderator'].includes(state.user?.role)) {
      const decision=await decisionModal({title:'Remove this marketplace listing?',message:'This permanently removes the task and its related bids and conversations. Record the moderation reason in the audit log.',confirmLabel:'Remove listing',danger:true,withReason:true,reasonLabel:'Moderation reason',reasonPlaceholder:'Explain why this listing is being removed'});
      if (!decision) return;
      if (!decision.reason) { notify('A moderation reason is required.','error'); return; }
      try { await removeTaskFromModeration(deleteButton.dataset.delete,decision.reason); }
      catch(error) { notify(error.message,'error'); }
      return;
    }
    $('#delete-task-id').value = deleteButton.dataset.delete;
    openModal('#delete-task-modal');
  }
  const editButton = event.target.closest('[data-edit]'); if (editButton) { const task = state.tasks.find((item) => Number(item.id) === Number(editButton.dataset.edit)); if (task) fillEditForm(task); }
  const acceptButton = event.target.closest('[data-accept-bid]');
  if (acceptButton) {
    const bidRow=acceptButton.closest('.bid-row');
    const bidderName=bidRow?.querySelector('.bidder-profile-copy strong')?.textContent||'selected tasker';
    const offer=bidRow?.querySelector('.bid-person > p')?.textContent||'their offer';
    const taskTitle=state.activeTask?.title||'this task';
    const accepted = await decisionModal({ title: 'Accept this tasker?', message: `${bidderName}\n\nTask: “${taskTitle}”\n${offer}\n\nThis assigns the tasker, closes other bids, and starts the task.`, confirmLabel: 'Accept tasker' });
    if (!accepted) return;
    try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'accept', task_id: acceptButton.dataset.acceptTask, bid_id: acceptButton.dataset.acceptBid }) }); notify(payload.message); showPage('marketplace-page'); void loadTasks(); void updateNotificationCounts(); }
    catch (error) { notify(error.message, 'error'); }
  }
  const lifecycleButton = event.target.closest('[data-task-lifecycle]');
  if (lifecycleButton) {
    const lifecycleAction=lifecycleButton.dataset.taskLifecycle, taskId=Number(lifecycleButton.dataset.taskId || state.activeTask?.id);
    if (!Number.isSafeInteger(taskId) || taskId < 1) { notify('Could not identify this task. Close and reopen its details, then try again.', 'error'); return; }
    if(lifecycleAction==='report_problem') { taskProblemModal(taskId); return; }
    let cancelDetails = null;
    if(lifecycleAction==='cancel_assignment') {
      cancelDetails = await decisionModal({ title: 'Cancel this assignment?', message: 'This will stop the active task and notify the other participant.', confirmLabel: 'Cancel assignment', danger: true, withReason: true });
      if (!cancelDetails) return;
    }
    if(lifecycleAction==='confirm_completion') {
      const approved = await decisionModal({ title: 'Confirm task completion?', message: 'This will close the task and allow both participants to leave reviews.', confirmLabel: 'Confirm completion' });
      if (!approved) return;
    }
    lifecycleButton.disabled=true;
    try {
      const payload=await api('api/task_lifecycle',{method:'POST',body:JSON.stringify({action:lifecycleAction,task_id:taskId,...(cancelDetails?{reason:cancelDetails.reason}:{})})});
      notify(payload.message);
      const nextStatus = { mark_done: 'Awaiting Confirmation', confirm_completion: 'Completed', report_problem: 'Under Review', cancel_assignment: 'Cancelled' }[lifecycleAction];
      try { await refreshCurrentTaskWorkflow(taskId, nextStatus); }
      catch (refreshError) { console.error('Task action succeeded but the view could not refresh:', refreshError); }
      void updateNotificationCounts();
    }
    catch(error){notify(error.message,'error');lifecycleButton.disabled=false;}
    return;
  }
  const resolveTaskButton=event.target.closest('[data-resolve-task]');
  if(resolveTaskButton) {
    const taskId=Number(resolveTaskButton.dataset.resolveTask), resolution=resolveTaskButton.dataset.resolutionStatus;
    const decision=await decisionModal({title:`Resolve this task as ${resolution}?`,message:'This closes the open dispute, updates the task status, and notifies both the poster and tasker. A resolution note is required for the audit history.',confirmLabel:`Set ${resolution}`,danger:resolution==='Cancelled',withReason:true,reasonLabel:'Resolution note',reasonPlaceholder:'Summarize the decision and next steps'});
    if(!decision) return;
    if(!decision.reason) { notify('A resolution note is required.','error'); return; }
    try { const payload=await api('api/task_lifecycle',{method:'POST',body:JSON.stringify({action:'resolve_dispute',task_id:taskId,status:resolution,resolution:decision.reason})}); notify(payload.message); await searchSuperadminTasks(); const task=accountActivityData.tasks.find((item)=>Number(item.id)===taskId)||{id:taskId}; await openSuperadminTask(task); }
    catch(error){notify(error.message,'error');}
    return;
  }
  const removeBidButton = event.target.closest('[data-remove-bid]'); if (removeBidButton) { $('#remove-bid-id').value = removeBidButton.dataset.removeBid; $('#remove-bid-task-id').value = removeBidButton.dataset.removeBidTask; $('#remove-bid-reason').value = ''; openModal('#remove-bid-modal'); }
  const messageButton = event.target.closest('[data-message-task]'); if (messageButton) openConversation(messageButton.dataset.messageTask, messageButton.dataset.messageUser);
  const editBidButton = event.target.closest('[data-edit-bid]'); if (editBidButton) { const form = document.querySelector(`[data-bid-edit-form="${editBidButton.dataset.editBid}"]`); form?.classList.toggle('hidden'); }
  const cancelBidButton = event.target.closest('[data-cancel-bid]'); if (cancelBidButton) document.querySelector(`[data-bid-edit-form="${cancelBidButton.dataset.cancelBid}"]`)?.classList.add('hidden');
  const deleteBidButton = event.target.closest('[data-delete-bid]'); if (deleteBidButton) { $('#delete-bid-id').value = deleteBidButton.dataset.deleteBid; $('#delete-bid-task-id').value = deleteBidButton.dataset.deleteBidTask; openModal('#delete-bid-modal'); }
});
document.addEventListener('keydown', (event) => {
  const photoViewer = $('#photo-lightbox');
  if (event.key === 'Escape' && photoViewer && !photoViewer.classList.contains('hidden')) {
    closePhotoViewer();
    return;
  }
  const logoutDialog = $('#logout-confirm-modal');
  if (event.key === 'Tab' && logoutDialog && !logoutDialog.classList.contains('hidden')) {
    const focusable = [...logoutDialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!logoutDialog.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (event.key === 'Escape') {
    if (!$('#superadmin-profile-dropdown')?.classList.contains('hidden')) {
      closeDesktopProfileMenu();
      $('#superadmin-profile-trigger')?.focus();
      return;
    }
    if (!$('#desktop-profile-dropdown')?.classList.contains('hidden')) {
      closeDesktopProfileMenu();
      $('#desktop-profile-trigger')?.focus();
      return;
    }
    const activeModal = document.querySelector('.modal-backdrop:not(.hidden)');
    if (activeModal) closeModal(`#${activeModal.id}`);
    else if (!$('#conversation-modal')?.classList.contains('hidden')) showPage(state.conversationReturnPage);
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.desktop-profile-root, .superadmin-user-menu')) closeDesktopProfileMenu();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshMarketplaceTasks(); });
window.addEventListener('focus', refreshMarketplaceTasks);
$('#confirm-logout').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await performLogout(); }
  catch (error) { notify(error.message, 'error'); }
  finally { if (button.isConnected) button.disabled = false; }
});
$('#auth-required-signin').addEventListener('click', () => {
  state.authPromptOpen = false;
  state.authPromptTrigger = null;
  openModal('#login-modal');
  requestAnimationFrame(() => $('#login-form')?.elements.email?.focus({ preventScroll: true }));
});
$('#bid-auth-signin').addEventListener('click', () => {
  state.authPromptOpen = false;
  state.authPromptTrigger = null;
  openModal('#login-modal');
  requestAnimationFrame(() => $('#login-form')?.elements.email?.focus({ preventScroll: true }));
});
$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); state.filters.search = $('#search-input').value.trim(); loadTasks(); });
$('#glass-opacity').addEventListener('input', (event) => applyGlassOpacity(event.target.value, { persist: true }));
document.addEventListener('input', (event) => {
  if (event.target.id === 'desktop-glass-opacity') applyGlassOpacity(event.target.value, { persist: true });
  if (event.target.id === 'superadmin-glass-opacity') applyGlassOpacity(event.target.value, { persist: true });
  if (event.target.id === 'superadmin-user-search') {
    clearTimeout(adminUserSearchTimer);
    adminUserSearchTimer=setTimeout(()=>void loadAdminUsers(true),300);
  }
  if (event.target.id === 'admin-report-search') {
    clearTimeout(adminReportSearchTimer);
    adminReportSearchTimer=setTimeout(()=>void loadAdminReports(true),300);
  }
  if (event.target.id === 'admin-audit-search') {
    clearTimeout(adminAuditSearchTimer);
    adminAuditSearchTimer=setTimeout(()=>void loadAdminAudit(true),300);
  }
  if(event.target.closest('#admin-announcement-form')) {
    clearTimeout(announcementPreviewTimer);
    announcementPreviewTimer=setTimeout(()=>void refreshAnnouncementPreview(),350);
  }
});
document.addEventListener('change',(event)=>{
  if (event.target.matches('#superadmin-user-filter')) void loadAdminUsers(true);
  if (event.target.matches('#admin-report-status, #admin-report-reason, #admin-report-from, #admin-report-to')) void loadAdminReports(true);
  if (event.target.matches('#admin-trend-days, #admin-trend-category')) void loadDashboardTrends();
  if(event.target.matches('[data-bulk-suspend-user]')) {
    const id=Number(event.target.dataset.bulkSuspendUser);
    const user=accountActivityData.users.find((item)=>Number(item.id)===id);
    if(event.target.checked&&user) bulkSuspensionSelection.set(id,`${user.first_name} ${user.last_name}`.trim());
    else bulkSuspensionSelection.delete(id);
    renderSuperadminUsers();
  }
  if(event.target.closest('#admin-announcement-form')) {
    clearTimeout(announcementPreviewTimer);
    announcementPreviewTimer=setTimeout(()=>void refreshAnnouncementPreview(),250);
  }
});
$('#status-filter').addEventListener('change', (event) => { state.filters.status = event.target.value; loadTasks(); });
$('#category-filter').addEventListener('change', (event) => { state.filters.category = event.target.value; loadTasks(); });
$('#refresh-tasks-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  const icon = button.querySelector('i');
  const label = button.querySelector('span');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  icon.classList.add('fa-spin');
  label.textContent = 'Refreshing...';
  try { await loadTasks(); }
  finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    icon.classList.remove('fa-spin');
    label.textContent = 'Refresh tasks';
  }
});
async function publishTaskForm(form) {
  if (!form.reportValidity()) return;
  setBusy(form, true, 'Publishing task...');
  try {
    const snapshot = await taskFormPayload(form);
    const duplicate = await api('api/create_task?action=check_duplicate', { method: 'POST', body: JSON.stringify({ title: snapshot.title }) });
    if (duplicate.duplicate) {
      const approved = await decisionModal({ title: 'Publish a duplicate task?', message: 'You already have an active task with this title. Do you want to publish another copy?', confirmLabel: 'Publish another' });
      if (!approved) return;
    }
    const draftId = form.elements.namedItem('draft_id')?.value;
    const payload = await api('api/create_task', { method: 'POST', body: JSON.stringify({ ...snapshot, allow_duplicate: Boolean(duplicate.duplicate) }) });
    if (draftId) api('api/create_task?action=draft_delete', { method: 'POST', body: JSON.stringify({ draft_id: draftId }) }).catch(() => {});
    form.reset();
    form.elements.namedItem('draft_id').value = '';
    form.querySelector('.task-photo-previews')?.replaceChildren();
    form.dataset.keepImageUrls = '[]';
    if (form.id === 'task-form') closeModal('task-modal');
    else showPage('marketplace-page');
    notify(payload.message || 'Your task is live.');
    await loadTasks();
  } catch (error) { notify(error.message, 'error'); }
  finally { setBusy(form, false); }
}
$('#task-form').addEventListener('submit', (event) => { event.preventDefault(); void publishTaskForm(event.currentTarget); });
$('#create-task-form').addEventListener('submit', (event) => { event.preventDefault(); void publishTaskForm(event.currentTarget); });
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form=event.currentTarget;
  setBusy(form,true,'Signing in...');
  try {
    const payload=mfaLoginChallenge
      ? await api('api/auth?action=verify_mfa_login',{method:'POST',body:JSON.stringify({challenge:mfaLoginChallenge,code:form.elements.mfa_code?.value||''})})
      : await api('api/auth?action=login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if(payload.mfa_required) {
      clearStoredAuth();
      mfaLoginChallenge=payload.mfa_challenge;
      let code=form.elements.mfa_code;
      if(!code) {
        const fields=form.querySelector('.login-form-fields')||form;
        fields.insertAdjacentHTML('beforeend','<label id="login-mfa-code-label" class="mt-3 block text-sm font-bold">Authenticator or recovery code<input name="mfa_code" inputmode="numeric" autocomplete="one-time-code" required class="form-control mt-2"></label><p id="login-mfa-help" class="mt-2 text-sm text-slate-600">Enter the current 6-digit code from your authenticator app, or one unused recovery code. <button type="button" data-mfa-login-restart class="font-bold text-[#006f70] underline">Start over</button></p>');
      }
      const submit=form.querySelector('[type="submit"]');
      if(submit) submit.textContent='Verify code';
      form.elements.mfa_code?.focus();
      notify(payload.message);
      return;
    }
    const returnIntent=state.authReturnIntent;
    mfaLoginChallenge='';
    state.authReturnIntent=null;
    state.authPromptOpen=false;
    state.authPromptTrigger=null;
    state.user=payload.user;
    recordAuthActivity();
    applyUserAppearance(state.user);
    loadUserGlassPreference(state.user);
    state.myTasks=[];
    state.activeTask=null;
    renderTasks();
    if(state.user.role!=='superadmin') await refreshSavedTaskData();
    broadcastAuthChange();
    form.querySelector('#login-mfa-code-label')?.remove();
    form.querySelector('#login-mfa-help')?.remove();
    const loginSubmit=form.querySelector('[type="submit"]');
    if(loginSubmit) loginSubmit.textContent='Log in';
    form.reset();
    closeDrawer();
    closeModal('login-modal');
    renderAuth();
    const landingPage=state.user.role==='superadmin'?(state.user.mfa_setup_required?'superadmin-account-page':'account-activity-modal'):['admin','moderator'].includes(state.user.role)?'staff-dashboard-page':'marketplace-page';
    showPage(landingPage);
    if(state.user.role!=='superadmin') await loadTasks();
    if(state.user.role==='superadmin'&&state.user.mfa_setup_required) {
      renderSuperadminAccountSettings();
      await openSuperadminMfaEnrollment();
    } else if(state.user.role==='superadmin') await openAccountActivity();
    startNotificationPolling();
    notify(payload.message);
    if(state.user.role!=='superadmin') await resumeAuthIntent(returnIntent);
  } catch(error) {
    notify(error.message,'error');
    if(error.suspensionAppealAvailable) openSuspensionAppealDialog();
  } finally {
    setBusy(form,false);
    const submit=form.querySelector('[type="submit"]');
    if(submit) submit.textContent=mfaLoginChallenge?'Verify code':'Log in';
  }
});
document.addEventListener('click',(event)=>{
  const restart=event.target.closest('[data-mfa-login-restart]');
  if(restart){
    mfaLoginChallenge='';
    $('#login-mfa-code-label')?.remove();
    $('#login-mfa-help')?.remove();
    const submit=$('#login-form [type="submit"]');
    if(submit) submit.textContent='Log in';
    $('#login-form')?.elements.email?.focus();
    return;
  }
  if(event.target.closest('[data-mfa-start]')) void openSuperadminMfaEnrollment();
});
document.addEventListener('submit',async(event)=>{
  const form=event.target;
  if(form.id!=='superadmin-mfa-disable-form') return;
  event.preventDefault();
  if(!form.reportValidity()) return;
  const approved=await decisionModal({title:'Disable authenticator MFA?',message:'This removes the extra sign-in check from your Superadmin account.',confirmLabel:'Disable MFA'});
  if(!approved) return;
  setBusy(form,true,'Disabling MFA...');
  try {
    const payload=await api('api/auth?action=mfa_disable',{method:'POST',body:JSON.stringify({code:form.elements.code.value})});
    state.user=payload.user;
    renderSuperadminAccountSettings();
    notify(payload.message);
  } catch(error) { notify(error.message,'error'); }
  finally { setBusy(form,false); }
});
$('#register-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true); try { const payload = await api('api/auth?action=register', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); event.target.reset(); if (state.authReturnIntent) state.preserveAuthIntent = true; closeModal('register-modal'); notify(payload.message); openModal('#login-modal'); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#edit-profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  $('#profile-confirm-error').classList.add('hidden');
  $('#profile-confirm-error').textContent = '';
  $('#profile-current-password').value = '';
  openModal('#profile-confirm-modal');
  $('#profile-current-password').focus({ preventScroll: true });
});
$('#profile-confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = $('#profile-current-password').value;
  if (!password) { $('#profile-current-password').reportValidity(); return; }
  const errorMessage = $('#profile-confirm-error');
  errorMessage.classList.add('hidden');
  setBusy(form, true, 'Updating profile...');
  try {
    const payload = await api('api/profile_actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'update_profile', ...Object.fromEntries(new FormData($('#edit-profile-form'))), current_password: password })
    });
    state.user = payload.user;
    renderAuth();
    renderProfile();
    $('#edit-profile-form').classList.add('hidden');
    closeModal('profile-confirm-modal');
    notify('Profile updated successfully!');
  } catch (error) {
    errorMessage.textContent = error.message || 'Incorrect password. Please try again.';
    errorMessage.classList.remove('hidden');
    $('#profile-current-password').focus({ preventScroll: true });
  } finally {
    setBusy(form, false);
  }
});
$('#change-email-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Updating email...'); try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'update_email', ...Object.fromEntries(new FormData(event.target)) }) }); state.user = payload.user; event.target.elements.current_password.value = ''; renderAuth(); renderProfile(); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#change-password-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Updating password...'); try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'change_password', ...Object.fromEntries(new FormData(event.target)) }) }); event.target.reset(); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#admin-edit-user-form')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setBusy(form, true, 'Saving account...');
  try {
    const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'update_user', ...Object.fromEntries(new FormData(form)) }) });
    closeModal('admin-edit-user-modal'); notify(payload.message); await loadAccountActivity(); await loadAdminUsers(false,superadminUserPage);
  } catch (error) { notify(error.message, 'error'); } finally { setBusy(form, false); }
});
$('#admin-edit-profile')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setBusy(form, true, 'Saving profile...');
  try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'update_profile', ...Object.fromEntries(new FormData(form)) }) }); state.user = payload.user; renderAuth(); renderSuperadminAccountSettings(); form.elements.current_password.value = ''; notify(payload.message); }
  catch (error) { notify(error.message, 'error'); } finally { setBusy(form, false); }
});
$('#admin-change-email')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setBusy(form, true, 'Updating email...');
  try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'update_email', ...Object.fromEntries(new FormData(form)) }) }); state.user = payload.user; renderAuth(); renderSuperadminAccountSettings(); form.elements.current_password.value = ''; notify(payload.message); }
  catch (error) { notify(error.message, 'error'); } finally { setBusy(form, false); }
});
$('#admin-change-password')?.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setBusy(form, true, 'Updating password...');
  try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'change_password', ...Object.fromEntries(new FormData(form)) }) }); form.reset(); notify(payload.message); }
  catch (error) { notify(error.message, 'error'); } finally { setBusy(form, false); }
});
$('#profile-picture-input').addEventListener('change', async (event) => { const input = event.target, file = input.files?.[0]; if (!file) return; const edit = input.closest('.profile-avatar-wrap')?.querySelector('.profile-avatar-edit'); const original = edit?.innerHTML; setActionProgress(input, 'Uploading profile photo...', true); input.disabled = true; input.closest('.profile-avatar-wrap')?.setAttribute('aria-busy', 'true'); if (edit) edit.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span class="sr-only">Uploading photo...</span>'; try { const avatar_data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); const payload = await api('api/profile_actions?action=upload_avatar', { method: 'POST', body: JSON.stringify({ avatar_data }) }); state.user = payload.user; renderAuth(); renderProfile(); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setActionProgress(input, '', false); input.value = ''; input.disabled = false; input.closest('.profile-avatar-wrap')?.removeAttribute('aria-busy'); if (edit) edit.innerHTML = original; } });
$('#admin-form').addEventListener('submit', async (event) => { event.preventDefault(); if(state.user?.role!=='superadmin'){notify('Only the Superadmin can create Admin accounts.','error');return;} setBusy(event.target, true); try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'create_admin', ...Object.fromEntries(new FormData(event.target)) }) }); event.target.reset(); closeModal('admin-modal'); notify(payload.message); await loadAccountActivity(); await loadAdminUsers(true); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#account-activity-filter')?.addEventListener('change', renderAccountActivityUsers);
$('#account-activity-search')?.addEventListener('input', renderAccountActivityUsers);
$('#superadmin-task-search')?.addEventListener('input', () => { clearTimeout(superadminTaskSearchTimer); superadminTaskSearchTimer = setTimeout(searchSuperadminTasks, 300); });
$('#superadmin-task-status-filter')?.addEventListener('change', () => { clearTimeout(superadminTaskSearchTimer); searchSuperadminTasks(); });
$('#admin-global-search')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('#superadmin-user-search').value = event.currentTarget.value.trim();
  showPage('user-management-page');
  void loadAdminUsers(true);
});
$('#refresh-account-activity')?.addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; try { await loadAccountActivity(); } finally { button.disabled = false; } });
$('#report-task-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return; const taskId = Number($('#report-task-id').value); setBusy(form, true, 'Sending report...'); try { await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'submit_report', task_id: taskId, reason: form.elements.reason.value, details: form.elements.details.value }) }); closeModal('report-task-modal'); form.reset(); setTaskReportButtonState(taskId, true); notify('Thank you for your report. Our team will review it shortly.'); } catch (error) { notify(error.message, 'error'); } finally { setBusy(form, false); } });
$('#edit-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Saving task...'); try { const form = event.target; const photoPayload = await taskFormPayload(form); const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'update_task', ...photoPayload }) }); const taskId = Number(form.elements.namedItem('task_id').value); closeModal('edit-modal'); setBusy(form, false); notify(payload.message); await loadTasks(); const updatedTask = state.tasks.find((task) => Number(task.id) === taskId); if (updatedTask) await openTask(updatedTask); if (state.myTasks.length) { state.myTasks = state.myTasks.map((task) => Number(task.id) === taskId ? { ...task, ...updatedTask } : task); renderMyTasks(state.myTasks); } } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#bid-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!state.user) { requestBidAuthGate(Number($('#task-detail-id').value), event.submitter || event.target.querySelector('[type="submit"]')); return; } setBusy(event.target, true); try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'place', task_id: $('#task-detail-id').value, ...Object.fromEntries(new FormData(event.target)) }) }); event.target.reset(); notify(payload.message); const task = state.tasks.find((item) => Number(item.id) === Number($('#task-detail-id').value)) || state.activeTask; if (task) openTask(task); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#conversation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.sendingMessage) return;
  const form = event.currentTarget, input = $('#conversation-body'), body = input.value.trim();
  if (!body) return;
  const taskId = Number($('#conversation-task-id').value), otherUserId = Number($('#conversation-user-id').value);
  const sendButton = form.querySelector('button');
  const optimistic = { id: `pending-${Date.now()}`, task_id: taskId, other_user_id: otherUserId, sender_id: state.user.id, recipient_id: otherUserId, sender_name: `${state.user.first_name} ${state.user.last_name}`, body, created_at: new Date().toISOString(), delivery_status: 'Sending...' };
  state.sendingMessage = true;
  state.pendingMessages.push(optimistic);
  input.value = '';
  input.disabled = true;
  sendButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  renderConversation(state.conversationMessages);
  try {
    const payload = await api('api/messages', { method: 'POST', body: JSON.stringify({ action: 'send', task_id: taskId, other_user_id: otherUserId, body }) });
    if (payload.message) state.conversationMessages = [...state.conversationMessages, { ...payload.message, sender_name: optimistic.sender_name }];
    else optimistic.delivery_status = 'Sent';
    optimistic.server_id = payload.message?.id || null;
    optimistic.delivery_status = 'Sent';
    renderConversation(state.conversationMessages);
    updateNotificationCounts();
  } catch (error) {
    state.pendingMessages = state.pendingMessages.filter((message) => message !== optimistic);
    input.value = body;
    notify(error.message, 'error');
    renderConversation(state.conversationMessages);
  } finally {
    state.sendingMessage = false;
    input.disabled = false;
    sendButton.disabled = false;
    form.removeAttribute('aria-busy');
    input.focus();
  }
});
document.addEventListener('submit', async (event) => { const form = event.target.closest('[data-bid-edit-form]'); if (!form) return; event.preventDefault(); setBusy(form, true); try { const taskId = form.closest('article')?.querySelector('[data-message-task]')?.dataset.messageTask; const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'update', bid_id: form.dataset.bidEditForm, task_id: taskId, ...Object.fromEntries(new FormData(form)) }) }); notify(payload.message); form.classList.add('hidden'); loadMyBids(); } catch (error) { notify(error.message, 'error'); } finally { setBusy(form, false); } });
document.addEventListener('submit', async (event) => {
  const problemForm=event.target.closest('#task-problem-form');
  if(problemForm) {
    event.preventDefault(); if(!problemForm.reportValidity()) return; setBusy(problemForm,true,'Sending report...');
    try { const taskId=Number(problemForm.elements.task_id.value); if(!Number.isSafeInteger(taskId)||taskId<1) throw new Error('Could not identify this task. Close and reopen its details, then try again.'); const payload=await api('api/task_lifecycle',{method:'POST',body:JSON.stringify({action:'report_problem',task_id:taskId,details:problemForm.elements.details.value})}); closeModal('task-problem-modal'); notify(payload.message); try { await refreshCurrentTaskWorkflow(taskId,'Under Review'); } catch(refreshError) { console.error('Problem report succeeded but the view could not refresh:',refreshError); } }
    catch(error){notify(error.message,'error');} finally {setBusy(problemForm,false);} return;
  }
  const review=event.target.closest('[data-task-review]');
  if(review) {
    event.preventDefault(); if(!review.reportValidity()) return; setBusy(review,true,'Submitting review...');
    try { const taskId=Number(review.dataset.taskReview); const payload=await api('api/task_lifecycle',{method:'POST',body:JSON.stringify({action:'review',task_id:taskId,rating:review.elements.rating.value,comment:review.elements.comment.value})}); notify(payload.message); await refreshCurrentTaskWorkflow(taskId); }
    catch(error){notify(error.message,'error');} finally {setBusy(review,false);}
  }
});
$('#conversation-body').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#conversation-form').requestSubmit(); } });
$('#confirm-delete-bid').addEventListener('click', async () => { const button = $('#confirm-delete-bid'); setButtonBusy(button, true, 'Deleting bid...'); try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'delete', bid_id: $('#delete-bid-id').value, task_id: $('#delete-bid-task-id').value }) }); closeModal('delete-bid-modal'); notify(payload.message); await loadMyBids(); await loadTasks(); } catch (error) { notify(error.message, 'error'); } finally { setButtonBusy(button, false); } });
$('#confirm-remove-bid').addEventListener('click', async () => { const button = $('#confirm-remove-bid'); const reason = $('#remove-bid-reason').value.trim(); if (!reason) { notify('Please provide a reason for removing the bidder.', 'error'); return; } setButtonBusy(button, true, 'Removing bidder...'); try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'remove_bid', bid_id: $('#remove-bid-id').value, task_id: $('#remove-bid-task-id').value, reason }) }); closeModal('remove-bid-modal'); notify(payload.message); const task = state.tasks.find((item) => Number(item.id) === Number($('#remove-bid-task-id').value)) || state.activeTask; if (task) await openTask(task); await loadTasks(); } catch (error) { notify(error.message, 'error'); } finally { setButtonBusy(button, false); } });
$('#confirm-delete-task').addEventListener('click', async () => { const button = $('#confirm-delete-task'); const taskId = $('#delete-task-id').value; setButtonBusy(button, true, 'Deleting task...'); try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'delete_task', task_id: taskId }) }); closeModal('delete-task-modal'); notify(payload.message); await loadTasks(); if (state.user?.role === 'superadmin') { await loadAccountActivity(); showPage('task-management-page'); } else if (['admin','moderator'].includes(state.user?.role)) { await loadModeratorTasks(); showPage('task-management-page'); } else showPage('marketplace-page'); } catch (error) { notify(error.message, 'error'); } finally { setButtonBusy(button, false); } });
init();
