const state = { user: null, tasks: [], myTasks: [], savedTasks: [], savedTaskIds: new Set(), activeTask: null, taskDetailReturn: null, publicProfileReturn: null, publicProfileTasks: [], conversationReturnPage: 'marketplace-page', conversationTimer: null, conversationMessages: [], conversationLastFullSync: 0, conversationFetchInFlight: false, pendingMessages: [], sendingMessage: false, notificationTimer: null, taskRefreshTimer: null, logoutTrigger: null, authPromptOpen: false, authReturnIntent: null, authPromptTrigger: null, preserveAuthIntent: false, glassOpacity: 0, themeUsesSystem: true, filters: { status: '', category: '', search: '' } };
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
  state.user = null;
  clearStoredAuth();
  applySystemAppearance();
  applyGlassOpacity(0);
  state.myTasks = [];
  state.savedTasks = [];
  state.savedTaskIds.clear();
  updateSavedTaskCount(0);
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
    throw new Error(payload.message || 'Request failed.');
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
const money = (value) => `₱${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
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
function setNotificationCount(selector, count) {
  const element = $(selector);
  if (!element) return;
  element.textContent = count > 99 ? '99+' : String(count);
  element.classList.toggle('hidden', count < 1);
}
async function updateNotificationCounts() {
  if (!state.user) {
    ['#desktop-bid-count', '#mobile-bid-count'].forEach((selector) => setNotificationCount(selector, 0));
    return;
  }
  try {
    const payload = await api('api/notifications?action=counts');
    setNotificationCount('#desktop-bid-count', payload.pending_bids);
    setNotificationCount('#mobile-bid-count', payload.pending_bids);
    setNotificationCount('#desktop-message-count', payload.bidder_unread_messages);
    setNotificationCount('#mobile-message-count', payload.bidder_unread_messages);
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
function closeModal(id) {
  const modal = $(id);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('modal-active');
  }
  if (id === 'profile-confirm-modal') {
    $('#profile-confirm-form')?.reset();
    $('#profile-confirm-error')?.classList.add('hidden');
    $('#profile-confirm-error')?.replaceChildren();
  }
  if (id === 'conversation-modal' && state.conversationTimer) { clearInterval(state.conversationTimer); state.conversationTimer = null; }
  if (id === 'account-activity-modal' && accountActivityTimer) { clearInterval(accountActivityTimer); accountActivityTimer = null; }
  if (!document.querySelector('.modal-backdrop:not(.hidden)')) {
    document.body.classList.remove('overflow-hidden');
    document.documentElement.classList.remove('overflow-hidden');
    document.body.style.removeProperty('overflow');
    document.documentElement.style.removeProperty('overflow');
  }
  if (id === 'logout-confirm-modal' && state.logoutTrigger) {
    const trigger = state.logoutTrigger;
    state.logoutTrigger = null;
    requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  }
  if (id === 'auth-required-modal') {
    state.authPromptOpen = false;
    state.authReturnIntent = null;
    const trigger = state.authPromptTrigger;
    state.authPromptTrigger = null;
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  if (id === 'bid-auth-modal') {
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
function closeDrawer() {
  $('#mobile-drawer')?.classList.add('-translate-x-full');
  $('#drawer-overlay')?.classList.add('hidden');
}
function closeDesktopProfileMenu() {
  $('#desktop-profile-dropdown')?.classList.add('hidden');
  $('#desktop-profile-trigger')?.setAttribute('aria-expanded', 'false');
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
function setButtonBusy(button, busy, label = 'Saving…') {
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
function setBusy(form, busy, label = 'Saving…') {
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
    field.innerHTML = `<span class="task-photo-label">Task photos <small>Optional · up to 3 images total</small></span><div class="task-existing-photo-section hidden"><div class="task-existing-photo-heading"><strong>Current photos</strong><small>Tap to view · × to remove</small></div><div class="task-existing-photos" aria-live="polite"></div></div><label class="task-photo-picker"><i class="fa-regular fa-image" aria-hidden="true"></i><span>Add photos</span><input data-task-photo-input type="file" accept="image/jpeg,image/png,image/webp" multiple><small>JPG, PNG, or WEBP</small></label><div class="task-photo-previews" aria-live="polite"></div>`;
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
initializeTaskPhotoInputs();
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
  const files = [...(form.querySelector('[data-task-photo-input]')?.files || [])];
  payload.photos = await Promise.all(files.map(compressTaskPhoto));
  try { payload.keep_image_urls = JSON.parse(form.dataset.keepImageUrls || '[]'); } catch { payload.keep_image_urls = []; }
  return payload;
}
function taskPhotoMarkup(task, compact = false) {
  const photos = Array.isArray(task.image_urls) ? task.image_urls.slice(0, 3) : [];
  if (!photos.length) return '';
  return `<div class="task-photo-gallery${compact ? ' is-compact' : ''}" aria-label="Task photos">${photos.map((url, index) => `<button type="button" class="task-photo-view" data-photo-url="${escapeHtml(url)}" data-photo-alt="${escapeHtml(task.title)} — photo ${index + 1}" aria-label="View photo ${index + 1} for ${escapeHtml(task.title)}"><img src="${escapeHtml(url)}" alt="Photo for ${escapeHtml(task.title)}" loading="lazy"><span><i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i></span></button>`).join('')}</div>`;
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
  if (pageId === 'account-activity-modal' && state.user?.role !== 'superadmin') { notify('Only the Superadmin can open this dashboard.', 'error'); return false; }
  document.querySelectorAll('.app-page').forEach((page) => page.classList.toggle('hidden', page.id !== pageId));
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
}

function renderAuth() {
  const loggedIn = Boolean(state.user);
  $('#mobile-header-login-button')?.classList.toggle('hidden', loggedIn);
  $('.mobile-saved-button')?.classList.toggle('hidden', !loggedIn);
  $('#auth-actions').innerHTML = loggedIn ? `<div class="desktop-profile-root relative hidden lg:block"><button id="desktop-profile-trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="desktop-profile-dropdown" class="desktop-profile-trigger touch-target flex items-center gap-2 rounded-xl border border-slate-200 px-2 py-1.5 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><span class="desktop-profile-avatar"><img id="desktop-avatar-image" class="hidden" alt=""><span id="desktop-avatar-fallback">${escapeHtml(initials(state.user))}</span></span><span class="max-w-32"><strong class="block truncate text-sm">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.last_name)}</strong><small class="block truncate text-xs text-slate-500">${escapeHtml(state.user.email)}</small></span><i class="fa-solid fa-chevron-down text-xs text-slate-500" aria-hidden="true"></i></button><div id="desktop-profile-dropdown" class="desktop-profile-dropdown hidden" aria-label="Profile menu"><div class="desktop-profile-menu-user"><span class="desktop-profile-menu-avatar"><img id="desktop-menu-avatar-image" class="hidden" alt=""><span id="desktop-menu-avatar-fallback">${escapeHtml(initials(state.user))}</span></span><span class="min-w-0"><strong class="block truncate">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.middle_initial ? `${state.user.middle_initial}. ` : '')}${escapeHtml(state.user.last_name)}</strong><small class="block truncate">${escapeHtml(state.user.email)}</small><em>${state.user.role === 'superadmin' ? 'Super Admin' : state.user.role === 'admin' ? 'Administrator' : 'TaskerPH Member'}</em></span></div><button data-appearance-toggle class="desktop-profile-menu-row"><i class="fa-solid fa-circle-half-stroke"></i><span>Appearance</span><strong id="desktop-appearance-state">Light</strong></button><label class="desktop-glass-row"><span><i class="fa-solid fa-wand-magic-sparkles"></i> Glass transparency</span><strong id="desktop-glass-label">0%</strong><input id="desktop-glass-opacity" type="range" min="0" max="100" step="1" value="0" aria-label="Glass transparency"></label><button data-page="create-task-page" class="desktop-profile-menu-row"><i class="fa-solid fa-plus"></i><span>Post a task</span></button><button data-my-tasks class="desktop-profile-menu-row"><i class="fa-solid fa-clipboard-list"></i><span>My tasks</span></button><button data-my-bids class="desktop-profile-menu-row"><i class="fa-solid fa-gavel"></i><span>My bids</span></button><button data-saved-tasks class="desktop-profile-menu-row"><i class="fa-regular fa-bookmark"></i><span>Saved tasks</span><strong id="desktop-saved-task-count" class="desktop-menu-count">0</strong></button><div class="desktop-profile-menu-divider"></div><button data-profile-page class="desktop-profile-menu-row"><i class="fa-solid fa-user"></i><span>View profile</span></button><button data-desktop-profile-form="edit-profile-form" class="desktop-profile-menu-row"><i class="fa-solid fa-user-pen"></i><span>Edit profile</span></button><button data-desktop-profile-form="change-email-form" class="desktop-profile-menu-row"><i class="fa-solid fa-envelope"></i><span>Change email</span></button><button data-desktop-profile-form="change-password-form" class="desktop-profile-menu-row"><i class="fa-solid fa-lock"></i><span>Change password</span></button><button data-modal="support-modal" class="desktop-profile-menu-row"><i class="fa-solid fa-circle-question"></i><span>Help &amp; Support</span></button><button data-action="logout" class="desktop-profile-logout"><i class="fa-solid fa-arrow-right-from-bracket"></i>Log out</button><small class="desktop-profile-version">TaskerPH · Version 1.0.0</small></div></div><button data-action="logout" class="mobile-only touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold">Log out</button>` : `<button data-modal="login-modal" class="touch-target rounded-lg px-4 text-sm font-bold text-[#006f70] hover:bg-[#e9f4f2]">Log in</button><button data-modal="register-modal" class="touch-target rounded-lg bg-[#006f70] px-4 text-sm font-bold text-white shadow-sm hover:bg-[#005b5c]">Join TaskerPH</button>`;
  if (loggedIn && state.user.avatar_path) {
    ['#desktop-avatar-image', '#desktop-menu-avatar-image'].forEach((selector) => { const image = $(selector); if (image) { image.src = `${state.user.avatar_path}?v=${encodeURIComponent(state.user.avatar_path)}`; image.classList.remove('hidden'); } });
    ['#desktop-avatar-fallback', '#desktop-menu-avatar-fallback'].forEach((selector) => $(selector)?.classList.add('hidden'));
  }
  $('#mobile-auth').innerHTML = loggedIn ? `<div class="mb-5 rounded-lg bg-[#e9f4f2] p-4"><p class="font-bold">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.last_name)}</p><p class="text-xs uppercase tracking-wider text-[#68727c]">${escapeHtml(state.user.role)}</p></div><button data-action="logout" class="touch-target w-full rounded-lg border border-[#c9d4d9] px-4 text-left text-sm font-bold">Log out</button>` : `<button data-modal="login-modal" class="touch-target w-full rounded-lg border border-[#c9d4d9] px-4 text-left text-sm font-bold">Log in</button><button data-modal="register-modal" class="touch-target mt-2 w-full rounded-lg bg-[#006f70] px-4 text-left text-sm font-bold text-white">Join TaskerPH</button>`;
  if (state.user?.role === 'superadmin') $('#mobile-auth').insertAdjacentHTML('afterbegin', '<button id="mobile-activity-dashboard" data-activity-dashboard class="touch-target mb-3 w-full rounded-lg bg-[#006f70] px-4 text-left text-sm font-bold text-white"><i class="fa-solid fa-chart-line mr-2" aria-hidden="true"></i>Account activity</button>');
  $('#role-banner').innerHTML = loggedIn ? `<strong>${escapeHtml(state.user.role === 'superadmin' ? 'Superadmin control' : state.user.role === 'admin' ? 'Admin moderation' : 'Your task space')}:</strong> ${state.user.role === 'user' ? 'Post tasks, track your listings, and discover work nearby.' : 'Use your moderation tools responsibly to keep the marketplace useful.'}` : '<strong>Welcome to TaskerPH:</strong> Find trusted local help or post your next task in minutes.';
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
  $('#activity-dashboard-button')?.classList.toggle('hidden', state.user?.role !== 'superadmin');
  $('#mobile-activity-dashboard')?.classList.toggle('hidden', state.user?.role !== 'superadmin');
  const desktopAppearanceState = $('#desktop-appearance-state');
  if (desktopAppearanceState) desktopAppearanceState.textContent = document.body.classList.contains('dark-mode') ? 'Dark' : 'Light';
  if ($('#desktop-glass-opacity')) applyGlassOpacity(state.glassOpacity);
  updateSavedTaskCount(state.savedTaskIds.size);
  closeDesktopProfileMenu();
}
function formatActivityTimestamp(value) {
  if (!value) return 'Not recorded yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded yet' : new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
let accountActivityData = { users: [], events: [], reports: [], tasks: [], stats: {} };
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
function renderAccountActivity(payload) {
  accountActivityData = { users: Array.isArray(payload.users) ? payload.users : [], events: Array.isArray(payload.events) ? payload.events : [], reports: Array.isArray(payload.reports) ? payload.reports : [], tasks: Array.isArray(payload.tasks) ? payload.tasks : [], stats: payload.stats || {} };
  const users = accountActivityData.users;
  const now = Date.now();
  const active = users.filter((user) => user.last_seen_at && now - new Date(user.last_seen_at).getTime() <= 5 * 60 * 1000).length;
  const admins = users.filter((user) => user.role === 'admin' || user.role === 'superadmin').length;
  const members = users.filter((user) => user.role === 'user').length;
  $('#account-activity-summary').className = 'grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3';
  $('#account-activity-summary').innerHTML = [
    ['Users', members], ['Admins', admins], ['All tasks', accountActivityData.stats.total_tasks || 0], ['Open tasks', accountActivityData.stats.open_tasks || 0], ['Completed', accountActivityData.stats.completed_tasks || 0], ['Open reports', accountActivityData.reports.filter((r) => r.status === 'Open').length], ['Active now', active]
  ].map(([label, value]) => `<div class="rounded-lg border border-[#dbe3e7] bg-[#f8fafc] px-3 py-2"><span class="block text-xs text-[#68727c]">${label}</span><strong class="text-lg">${value}</strong></div>`).join('');
  $('#account-activity-events').innerHTML = accountActivityData.events.length ? accountActivityData.events.map((event) => `<article class="rounded-lg border border-[#dbe3e7] p-3"><strong>${escapeHtml(event.summary)}</strong><p class="mt-1 text-xs text-[#68727c]">${escapeHtml(event.user ? `${event.user.first_name} ${event.user.last_name} · ${event.user.email}` : 'System')} · ${escapeHtml(formatActivityTimestamp(event.created_at))}</p></article>`).join('') : '<p class="text-sm text-[#68727c]">No activity recorded yet.</p>';
  $('#account-activity-reports').innerHTML = accountActivityData.reports.length ? accountActivityData.reports.map((report) => `<article class="rounded-lg border border-[#dbe3e7] p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div><strong>${escapeHtml(report.task?.title || 'Removed task')}</strong><p class="text-sm">${escapeHtml(report.reason)} · ${escapeHtml(report.status)}</p><p class="text-xs text-[#68727c]">${escapeHtml(report.reporter ? `${report.reporter.first_name} ${report.reporter.last_name}` : 'Member')} · ${escapeHtml(formatActivityTimestamp(report.created_at))}</p>${report.details ? `<p class="mt-2 text-sm">${escapeHtml(report.details)}</p>` : ''}</div>${report.status === 'Open' ? `<div class="flex gap-2"><button data-review-report="${report.id}" data-report-status="Reviewed" class="rounded border px-3 py-1 text-sm">Mark reviewed</button><button data-review-report="${report.id}" data-report-status="Dismissed" class="rounded border px-3 py-1 text-sm">Dismiss</button></div>` : ''}</div></article>`).join('') : '<p class="text-sm text-[#68727c]">No reports submitted.</p>';
  $('#account-activity-tasks').innerHTML = accountActivityData.tasks.length ? accountActivityData.tasks.map((task) => `<article class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#dbe3e7] p-3"><div><strong>${escapeHtml(task.title)}</strong><p class="text-xs text-[#68727c]">${escapeHtml(task.category)} · ${escapeHtml(task.status)} · ₱${escapeHtml(Number(task.budget).toLocaleString('en-PH'))}</p><p class="text-xs text-[#68727c]">${escapeHtml(task.owner ? `${task.owner.first_name} ${task.owner.last_name} · ${task.owner.email}` : '')}</p></div><button data-delete="${Number(task.id)}" class="rounded border border-red-200 px-3 py-1 text-sm font-bold text-red-600">Remove task</button></article>`).join('') : '<p class="text-sm text-[#68727c]">No tasks posted yet.</p>';
  renderAccountActivityUsers();
}
async function loadAccountActivity() {
  if (state.user?.role !== 'superadmin') { notify('Only the Superadmin can view account activity.', 'error'); return; }
  $('#account-activity-users').innerHTML = '<p class="text-sm text-[#68727c]">Loading account list…</p>';
  try {
    const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'activity_dashboard' }) });
    renderAccountActivity(payload);
  } catch (error) {
    const message = escapeHtml(error.message);
    $('#account-activity-users').innerHTML = `<p class="text-sm text-red-600">${message}</p>`;
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
  $('#profile-role').textContent = user.role === 'superadmin' ? 'Super Admin' : user.role === 'admin' ? 'Administrator' : 'TaskerPH Member';
  $('#edit-profile-form').elements.first_name.value = user.first_name || '';
  $('#edit-profile-form').elements.middle_initial.value = user.middle_initial || '';
  $('#edit-profile-form').elements.last_name.value = user.last_name || '';
  $('#change-email-form').elements.email.value = user.email || '';
  const avatar = $('#profile-avatar');
  avatar.classList.toggle('hidden', !user.avatar_path);
  $('#profile-avatar-fallback').classList.toggle('hidden', Boolean(user.avatar_path));
  if (user.avatar_path) avatar.src = `${user.avatar_path}?v=${encodeURIComponent(user.avatar_path)}`;
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
  const label = $('#glass-opacity-label');
  if (label) label.textContent = `${transparency}% Transparency`;
  const desktopLabel = $('#desktop-glass-label');
  if (desktopLabel) desktopLabel.textContent = `${transparency}%`;
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
  const canManage = state.user && (state.user.role === 'admin' || state.user.role === 'superadmin' || (state.user.role === 'user' && Number(state.user.id) === Number(task.user_id)));
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
  buttons.forEach((button) => setSavedButtonBusy(button, true, saved ? 'Saving task…' : 'Removing saved task…'));
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
  Object.entries(task).forEach(([key, value]) => { const input = $(`#edit-${key}`); if (input) input.value = value; });
  const form = $('#edit-form');
  form.dataset.keepImageUrls = JSON.stringify(Array.isArray(task.image_urls) ? task.image_urls.slice(0, 3) : []);
  const photoInput = form.querySelector('[data-task-photo-input]');
  if (photoInput) photoInput.value = '';
  form.querySelector('.task-photo-previews')?.replaceChildren();
  renderExistingTaskPhotos(form);
  openModal('#edit-modal');
}
async function openTask(task) {
  const currentPage = document.querySelector('.app-page:not(.hidden)')?.id;
  if (currentPage !== 'task-detail-modal') {
    state.taskDetailReturn = { pageId: currentPage || 'marketplace-page', scrollY: window.scrollY };
  }
  state.activeTask = task;
  const isOwner = state.user && Number(state.user.id) === Number(task.user_id);
  updateTaskMessageCount(isOwner ? task.unread_message_count : 0);
  $('#task-detail-content').innerHTML = `<p class="text-sm font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category)}</p><h2 class="mt-1 text-2xl font-bold">${escapeHtml(task.title)}</h2>${taskPhotoMarkup(task)}<div class="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-[#f5f7f8] p-4 text-sm"><div><p class="text-xs text-[#68727c]">Budget</p><p class="mt-1 font-bold">${money(task.budget)}</p></div><div><p class="text-xs text-[#68727c]">Location</p><p class="mt-1 font-bold">${escapeHtml(task.location)}</p></div></div><p class="mt-5 whitespace-pre-wrap text-sm leading-6 text-[#4c5962]">${escapeHtml(task.description)}</p><div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbe3e7] bg-white p-4"><div><p class="text-xs font-semibold uppercase tracking-wider text-[#68727c]">Posted by</p><button type="button" data-public-profile="${Number(task.user_id)}" data-profile-task="${Number(task.id)}" class="mt-1 inline-flex items-center gap-2 font-bold text-[#006f70] hover:underline"><i class="fa-regular fa-user" aria-hidden="true"></i>${escapeHtml(task.owner_name)}<i class="fa-solid fa-arrow-up-right-from-square text-xs" aria-hidden="true"></i></button></div><button type="button" data-public-profile="${Number(task.user_id)}" data-profile-task="${Number(task.id)}" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">View tasker profile</button></div>${!state.user && task.status === 'Open' ? `<div class="mt-5 flex flex-wrap gap-3"><button type="button" data-guest-bid="${Number(task.id)}" class="touch-target rounded-lg bg-[#006f70] px-5 font-bold text-white">Submit bid</button><button type="button" data-contact-tasker="${Number(task.id)}" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]">Contact Tasker</button></div>` : ''}`;
  const canManage = state.user && (state.user.role === 'admin' || state.user.role === 'superadmin' || (state.user.role === 'user' && Number(state.user.id) === Number(task.user_id)));
  if (state.user && !isOwner && !['admin', 'superadmin'].includes(state.user.role)) $('#task-detail-content').insertAdjacentHTML('beforeend', `<div class="mt-5 border-t border-[#edf0f1] pt-4"><button type="button" data-report-task="${Number(task.id)}" class="touch-target rounded-lg border border-red-200 px-4 text-sm font-bold text-red-600"><i class="fa-regular fa-flag mr-2"></i>Report this task</button></div>`);
  if (canManage) $('#task-detail-content').insertAdjacentHTML('beforeend', `<div class="mt-6 flex flex-wrap gap-3 border-t border-[#edf0f1] pt-5"><button data-edit="${task.id}" class="touch-target rounded-lg border border-[#c9d4d9] px-4 text-sm font-bold text-[#006f70]"><i class="fa-solid fa-pen-to-square mr-2"></i>Edit task</button><button data-delete="${task.id}" class="touch-target rounded-lg border border-red-200 px-4 text-sm font-bold text-red-600"><i class="fa-solid fa-trash mr-2"></i>Delete task</button></div>`);
  $('#task-detail-id').value = task.id;
  if (!$('#bid-submitted-state')) $('#bid-section').insertAdjacentHTML('beforebegin', '<div id="bid-submitted-state" class="submitted-bid-state hidden"><i class="fa-solid fa-circle-check"></i><div><strong>Bid submitted</strong><p>The task owner can review your offer and message you here.</p></div></div>');
  $('#bid-submitted-state').classList.add('hidden');
  $('#bid-section').classList.toggle('hidden', !state.user || isOwner || task.status !== 'Open');
  $('#bids-section').classList.toggle('hidden', !isOwner && !['admin', 'superadmin'].includes(state.user?.role));
  if (!state.user) { $('#bids-section').classList.add('hidden'); $('#bids-list').replaceChildren(); }
  showPage('task-detail-modal');
  const backgroundLoads = [];
  if (isOwner) backgroundLoads.push(api(`api/notifications?action=task_messages&task_id=${task.id}`).then((payload) => updateTaskMessageCount(payload.unread_count)).catch(() => {}));
  if (!state.user) return;
  try {
    const bidRequest = api(`api/bid_actions?action=list&task_id=${task.id}`);
    const [payload] = await Promise.all([bidRequest, ...backgroundLoads]);
    const myBid = payload.bids.find((bid) => Number(bid.bidder_id) === Number(state.user?.id));
    $('#bid-section').classList.toggle('hidden', Boolean(myBid) || isOwner || task.status !== 'Open');
    $('#bid-submitted-state').classList.toggle('hidden', !myBid);
    renderBids(payload.bids, task);
    void updateNotificationCounts();
  } catch (error) { notify(error.message, 'error'); }
}
function returnFromTaskDetails() {
  const previous = state.taskDetailReturn || { pageId: 'marketplace-page', scrollY: 0 };
  state.taskDetailReturn = null;
  showPage(previous.pageId);
  requestAnimationFrame(() => window.scrollTo({ top: previous.scrollY, left: 0, behavior: 'instant' }));
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
function renderBids(bids, task) { const isOwner = state.user && Number(state.user.id) === Number(task.user_id); const isModerator = ['admin', 'superadmin'].includes(state.user?.role); $('#bids-section h3').textContent = `Bids (${bids.length})`; $('#bids-list').innerHTML = bids.length ? bids.map((bid) => `<div class="bid-row rounded-lg border border-[#dbe3e7] p-3"><div class="bid-row-heading"><div class="bid-person"><p class="bidder-name font-bold">${escapeHtml(bid.bidder_name)}</p>${bid.unread_message_count ? `<span data-bid-message-count="${task.id}-${bid.bidder_id}" class="task-message-count"><i class="fa-solid fa-message"></i> ${bid.unread_message_count} new</span>` : ''}<p class="text-xs text-[#68727c]">Offer: ${money(bid.amount)} &middot; ${escapeHtml(bid.status)}</p></div></div><p class="mt-2 text-sm text-[#4c5962]">${escapeHtml(bid.message)}</p>${bid.removal_reason ? `<p class="bid-removal-reason"><strong>Removal reason:</strong> ${escapeHtml(bid.removal_reason)}</p>` : ''}<div class="bid-row-actions">${isOwner || isModerator ? `<button data-message-task="${task.id}" data-message-user="${bid.bidder_id}" class="touch-target rounded-lg border border-[#c9d4d9] px-3 text-xs font-bold text-[#006f70]">Message</button>` : ''}${(isOwner || isModerator) && ['Pending', 'Accepted'].includes(bid.status) ? `${bid.status === 'Pending' ? `<button data-accept-bid="${bid.id}" data-accept-task="${task.id}" class="touch-target rounded-lg bg-[#006f70] px-3 text-xs font-bold text-white">Accept</button>` : ''}<button data-remove-bid="${bid.id}" data-remove-bid-task="${task.id}" class="touch-target rounded-lg border border-red-200 px-3 text-xs font-bold text-red-600">Remove</button>` : ''}</div></div>`).join('') : '<p class="text-sm text-[#68727c]">No bids yet.</p>'; }
async function loadMyBids() { if (!state.user) { requestAuthGate('bids'); return; } showPage('my-bids-page'); $('#my-bids-page-list').innerHTML = '<p class="py-8 text-center text-sm text-[#68727c]">Loading your bids...</p>'; try { const payload = await api('api/bid_actions?action=my_bids'); renderEditableMyBids(payload.bids); } catch (error) { notify(error.message, 'error'); } }
async function loadMyTasks() { if (!state.user) { requestAuthGate('tasks'); return; } showPage('my-tasks-modal'); $('#my-tasks-list').innerHTML = '<p class="py-8 text-center text-sm text-[#68727c]">Loading your tasks...</p>'; try { const payload = await api('api/get_tasks?mine=1'); state.myTasks = payload.tasks; renderMyTasks(state.myTasks); } catch (error) { notify(error.message, 'error'); } }
function renderEditableMyBids(bids) { const html = bids.length ? bids.map((bid) => `<article class="activity-row rounded-lg border border-[#dbe3e7] p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(bid.category)}</p><h3 class="mt-1 font-bold">${escapeHtml(bid.title)}</h3><p class="mt-1 text-xs text-[#68727c]">Task owner: ${escapeHtml(bid.owner_name)} &middot; ${escapeHtml(bid.location)}</p></div><div class="flex items-center gap-2"><span class="badge ${bid.status === 'Accepted' ? 'badge-open' : bid.status === 'Rejected' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(bid.status)}</span>${bid.unread_message_count ? `<span data-bid-message-count="${bid.task_id}" class="task-message-count"><i class="fa-solid fa-message"></i> ${bid.unread_message_count} new</span>` : ''}</div></div>${bid.removal_reason ? `<p class="bid-removal-reason"><strong>Removed by owner:</strong> ${escapeHtml(bid.removal_reason)}</p>` : ''}<div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf0f1] pt-3 text-sm"><span>Your offer: <strong>${money(bid.amount)}</strong></span><span class="text-[#68727c]">Task: ${escapeHtml(bid.task_status)}</span><div class="flex gap-2">${bid.status === 'Pending' && bid.task_status === 'Open' ? `<button data-edit-bid="${bid.id}" class="touch-target rounded-lg border border-[#c9d4d9] px-3 text-xs font-bold text-[#006f70]">Edit bid</button><button data-delete-bid="${bid.id}" data-delete-bid-task="${bid.task_id}" class="touch-target rounded-lg border border-red-200 px-3 text-xs font-bold text-red-600">Delete bid</button>` : ''}<button data-message-task="${bid.task_id}" data-message-user="${bid.owner_id}" class="touch-target rounded-lg border border-[#008f8c] px-3 text-xs font-bold text-[#006f70]">Message owner</button></div></div><form data-bid-edit-form="${bid.id}" class="bid-edit-form hidden mt-4 grid gap-3 rounded-lg bg-[#f5f7f8] p-3"><label class="block text-sm font-bold">Offer amount<input name="amount" type="number" min="0" step="0.01" value="${bid.amount}" required class="form-control mt-2"></label><label class="block text-sm font-bold">Offer message<textarea name="message" rows="4" required maxlength="1000" class="form-control min-h-[100px] w-full resize-y overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600">${escapeHtml(bid.message)}</textarea></label><div class="mt-3 flex justify-end gap-2"><button type="submit" data-save-bid="${bid.id}" class="touch-target rounded-lg bg-[#006f70] px-3 text-xs font-bold text-white">Save</button><button type="button" data-cancel-bid="${bid.id}" class="touch-target rounded-lg border border-[#c9d4d9] px-3 text-xs font-bold">Cancel</button></div></form><p class="mt-2 text-sm text-[#4c5962]">${escapeHtml(bid.message)}</p></article>`).join('') : '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><i class="fa-solid fa-gavel mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">You have not placed any bids yet.</p><p class="mt-1 text-sm text-[#68727c]">Open a task from the marketplace to make your first offer.</p></div>'; $('#my-bids-page-list').innerHTML = html; }
function renderMyBids(bids) { const html = bids.length ? bids.map((bid) => `<article class="activity-row rounded-lg border border-[#dbe3e7] p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(bid.category)}</p><h3 class="mt-1 font-bold">${escapeHtml(bid.title)}</h3><p class="mt-1 text-xs text-[#68727c]">Task owner: ${escapeHtml(bid.owner_name)} &middot; ${escapeHtml(bid.location)}</p></div><span class="badge ${bid.status === 'Accepted' ? 'badge-open' : bid.status === 'Rejected' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(bid.status)}</span></div><div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf0f1] pt-3 text-sm"><span>Your offer: <strong>${money(bid.amount)}</strong></span><span class="text-[#68727c]">Task: ${escapeHtml(bid.task_status)}</span><button data-message-task="${bid.task_id}" data-message-user="${bid.owner_id}" class="touch-target rounded-lg border border-[#008f8c] px-3 text-xs font-bold text-[#006f70]">Message owner</button></div><p class="mt-2 text-sm text-[#4c5962]">${escapeHtml(bid.message)}</p></article>`).join('') : '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><i class="fa-solid fa-gavel mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">You have not placed any bids yet.</p><p class="mt-1 text-sm text-[#68727c]">Open a task from the marketplace to make your first offer.</p></div>'; $('#my-bids-page-list').innerHTML = html; }
function renderMyTasks(tasks) { $('#my-tasks-list').innerHTML = tasks.length ? tasks.map((task) => `<article class="activity-row rounded-lg border border-[#dbe3e7] p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-[#008f8c]">${escapeHtml(task.category)}</p><h3 class="mt-1 font-bold">${escapeHtml(task.title)}</h3><p class="mt-1 text-xs text-[#68727c]">${escapeHtml(task.location)} &middot; ${money(task.budget)}</p></div><span class="badge ${task.status === 'Open' ? 'badge-open' : task.status === 'Completed' ? 'badge-complete' : 'badge-progress'}">${escapeHtml(task.status)}</span></div><div class="mt-3 flex items-center justify-between gap-3 border-t border-[#edf0f1] pt-3"><span class="text-sm text-[#68727c]">${escapeHtml(task.description.slice(0, 90))}${task.description.length > 90 ? '...' : ''}</span><div class="flex flex-wrap items-center justify-end gap-3"><span class="task-bid-count"><i class="fa-solid fa-gavel"></i> ${task.bid_count} ${task.bid_count === 1 ? 'bid' : 'bids'}</span><button data-open-my-task="${task.id}" class="touch-target rounded-lg px-3 text-xs font-bold text-[#006f70]">Open</button></div></div></article>`).join('') : '<div class="empty-state rounded-lg border border-dashed border-[#c9d4d9] px-5 py-10 text-center"><i class="fa-solid fa-clipboard-list mb-3 text-2xl text-[#008f8c]"></i><p class="font-bold">You have not posted a task yet.</p><p class="mt-1 text-sm text-[#68727c]">Post a task and it will appear here.</p></div>'; }
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
  $('#conversation-list').innerHTML = '<p class="text-sm text-[#68727c]">Loading conversation...</p>';
  showPage('conversation-modal');
  await refreshConversation();
  state.conversationTimer = setInterval(refreshConversation, 5000);
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
    const status = mine ? (message.delivery_status || (message.read_at ? 'Seen' : 'Sent · Delivered')) : '';
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
  const initialLoads = [loadTasks()];
  if (state.user) initialLoads.push(refreshSavedTaskData().catch((error) => notify(error.message, 'error')));
  await Promise.all(initialLoads);
  if (state.user) renderTasks();
  if (state.user?.role === 'superadmin') { showPage('account-activity-modal'); await openAccountActivity(); }
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
    if (state.user && (!wasLoggedIn || Number(previousUserId) !== Number(state.user.id))) await loadTasks();
    if (state.user?.role === 'superadmin' && (!wasLoggedIn || Number(previousUserId) !== Number(state.user.id))) await openAccountActivity();
    await updateNotificationCounts();
  } catch (error) { notify(error.message, 'error'); }
});
async function performLogout() {
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
  updateSavedTaskCount(0);
  renderSavedTasks();
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
  const accountActivityButton = event.target.closest('[data-activity-dashboard]');
  if (accountActivityButton) { event.preventDefault(); await openAccountActivity(); return; }
  const reportButton = event.target.closest('[data-report-task]');
  if (reportButton) {
    const reason = window.prompt('Report reason: Scam or fraud, Inappropriate content, Misleading information, or Other');
    if (!reason) return;
    const details = window.prompt('Add details (optional):') || '';
    try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'submit_report', task_id: reportButton.dataset.reportTask, reason, details }) }); notify(payload.message); }
    catch (error) { notify(error.message, 'error'); }
    return;
  }
  const reviewButton = event.target.closest('[data-review-report]');
  if (reviewButton) {
    try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'review_report', report_id: reviewButton.dataset.reviewReport, status: reviewButton.dataset.reportStatus }) }); notify(payload.message); await loadAccountActivity(); }
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
    return;
  }
  const desktopProfileForm = event.target.closest('[data-desktop-profile-form]');
  if (desktopProfileForm) { closeDesktopProfileMenu(); await openProfile(desktopProfileForm.dataset.desktopProfileForm); return; }
  const pageButton = event.target.closest('[data-page]'); if (pageButton) { showPage(pageButton.dataset.page); return; }
  const publicProfileButton = event.target.closest('[data-public-profile]'); if (publicProfileButton) { await openPublicProfile(publicProfileButton.dataset.publicProfile, publicProfileButton.dataset.profileTask); return; }
  if (event.target.closest('[data-public-profile-back]')) { returnFromPublicProfile(); return; }
  const savedTasksButton = event.target.closest('[data-saved-tasks]'); if (savedTasksButton) { closeDesktopProfileMenu(); await loadSavedTasks(); return; }
  const saveTaskButton = event.target.closest('[data-save-task]'); if (saveTaskButton) { event.preventDefault(); event.stopPropagation(); const taskId = Number(saveTaskButton.dataset.saveTask); const task = [...state.tasks, ...state.savedTasks].find((item) => Number(item.id) === taskId); if (task) await toggleSavedTask(task); return; }
  const modalButton = event.target.closest('[data-modal]'); if (modalButton) { closeDesktopProfileMenu(); if (modalButton.dataset.modal === 'task-modal') showPage('create-task-page'); else openModal(`#${modalButton.dataset.modal}`); closeDrawer(); }
  const marketplaceLink = event.target.closest('a[href="#marketplace"]'); if (marketplaceLink) { event.preventDefault(); resetScrollPosition(); showPage('marketplace-page'); closeDrawer(); }
  const closeButton = event.target.closest('[data-close]'); if (closeButton) { if (closeButton.dataset.close === 'login-modal' && event.target.closest('[data-modal="register-modal"]')) state.preserveAuthIntent = true; if (closeButton.dataset.close === 'task-detail-modal') returnFromTaskDetails(); else if (closeButton.dataset.close === 'my-tasks-modal') showPage('marketplace-page'); else closeModal(`#${closeButton.dataset.close}`); }
  if (event.target.closest('[data-close-conversation]')) { showPage(state.conversationReturnPage); return; }
  if (event.target.classList.contains('modal-backdrop')) closeModal(`#${event.target.id}`);
  const taskCard = event.target.closest('[data-task]'); if (taskCard && !event.target.closest('[data-edit], [data-delete], [data-save-task]')) { const taskId = Number(taskCard.dataset.task); const task = [...state.tasks, ...state.savedTasks].find((item) => Number(item.id) === taskId); if (task) openTask(task); }
  if (event.target.closest('[data-my-bids]')) { closeDesktopProfileMenu(); resetScrollPosition(); closeDrawer(); loadMyBids(); }
  if (event.target.closest('[data-my-tasks]')) { closeDesktopProfileMenu(); resetScrollPosition(); closeDrawer(); loadMyTasks(); }
  if (event.target.closest('[data-profile-page]')) { closeDesktopProfileMenu(); resetScrollPosition(); openProfile(); return; }
  const profileFormToggle = event.target.closest('[data-profile-form]');
  if (profileFormToggle) { const form = $(`#${profileFormToggle.dataset.profileForm}`); form?.classList.toggle('hidden'); return; }
  if (event.target.closest('[data-appearance-toggle]')) { saveUserAppearance(!document.body.classList.contains('dark-mode')); }
  const myTaskButton = event.target.closest('[data-open-my-task]'); if (myTaskButton) { const task = state.myTasks.find((item) => Number(item.id) === Number(myTaskButton.dataset.openMyTask)); if (task) { closeModal('my-tasks-modal'); openTask(task); } }
  const publicTaskButton = event.target.closest('[data-open-public-task]'); if (publicTaskButton) { const task = state.publicProfileTasks.find((item) => Number(item.id) === Number(publicTaskButton.dataset.openPublicTask)); if (task) openTask({ ...task, owner_name: `${$('#public-profile-content h2')?.textContent || 'TaskerPH member'}`, has_bid: false, is_saved: false, bid_count: 0, unread_message_count: 0 }); return; }
  if (event.target.closest('[data-menu]')) { $('#mobile-drawer').classList.remove('-translate-x-full'); $('#drawer-overlay').classList.remove('hidden'); }
  if (event.target.id === 'drawer-overlay' || event.target.closest('[data-close-drawer]')) closeDrawer();
  const logout = event.target.closest('[data-action="logout"]'); if (logout) { state.logoutTrigger = logout; closeDesktopProfileMenu(); openModal('#logout-confirm-modal'); requestAnimationFrame(() => $('#cancel-logout')?.focus({ preventScroll: true })); return; }
  const deleteButton = event.target.closest('[data-delete]'); if (deleteButton) { $('#delete-task-id').value = deleteButton.dataset.delete; openModal('#delete-task-modal'); }
  const editButton = event.target.closest('[data-edit]'); if (editButton) { const task = state.tasks.find((item) => Number(item.id) === Number(editButton.dataset.edit)); if (task) fillEditForm(task); }
  const acceptButton = event.target.closest('[data-accept-bid]'); if (acceptButton) { try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'accept', task_id: acceptButton.dataset.acceptTask, bid_id: acceptButton.dataset.acceptBid }) }); notify(payload.message); showPage('marketplace-page'); loadTasks(); } catch (error) { notify(error.message, 'error'); } }
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
  if (!event.target.closest('.desktop-profile-root')) closeDesktopProfileMenu();
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
  label.textContent = 'Refreshing…';
  try { await loadTasks(); }
  finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    icon.classList.remove('fa-spin');
    label.textContent = 'Refresh tasks';
  }
});
$('#task-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Posting task…'); try { await api('api/create_task', { method: 'POST', body: JSON.stringify(await taskFormPayload(event.target)) }); event.target.reset(); event.target.querySelector('.task-photo-previews')?.replaceChildren(); closeModal('task-modal'); setBusy(event.target, false); notify('Your task is live.'); loadTasks(); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#create-task-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Posting task…'); try { await api('api/create_task', { method: 'POST', body: JSON.stringify(await taskFormPayload(event.target)) }); event.target.reset(); event.target.querySelector('.task-photo-previews')?.replaceChildren(); setBusy(event.target, false); showPage('marketplace-page'); notify('Your task is live.'); loadTasks(); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Signing in…'); try { const payload = await api('api/auth?action=login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); const returnIntent = state.authReturnIntent; state.authReturnIntent = null; state.authPromptOpen = false; state.authPromptTrigger = null; state.user = payload.user; recordAuthActivity(); applyUserAppearance(state.user); loadUserGlassPreference(state.user); state.myTasks = []; state.activeTask = null; await refreshSavedTaskData(); broadcastAuthChange(); event.target.reset(); closeDrawer(); closeModal('login-modal'); renderAuth(); showPage(state.user.role === 'superadmin' ? 'account-activity-modal' : 'marketplace-page'); await loadTasks(); if (state.user.role === 'superadmin') await openAccountActivity(); startNotificationPolling(); notify(payload.message); await resumeAuthIntent(returnIntent); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
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
  setBusy(form, true, 'Updating profile…');
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
$('#change-email-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Updating email…'); try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'update_email', ...Object.fromEntries(new FormData(event.target)) }) }); state.user = payload.user; event.target.elements.current_password.value = ''; renderAuth(); renderProfile(); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#change-password-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Updating password…'); try { const payload = await api('api/profile_actions', { method: 'POST', body: JSON.stringify({ action: 'change_password', ...Object.fromEntries(new FormData(event.target)) }) }); event.target.reset(); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#profile-picture-input').addEventListener('change', async (event) => { const input = event.target, file = input.files?.[0]; if (!file) return; const edit = input.closest('.profile-avatar-wrap')?.querySelector('.profile-avatar-edit'); const original = edit?.innerHTML; setActionProgress(input, 'Uploading profile photo…', true); input.disabled = true; input.closest('.profile-avatar-wrap')?.setAttribute('aria-busy', 'true'); if (edit) edit.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span class="sr-only">Uploading photo…</span>'; try { const avatar_data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); const payload = await api('api/profile_actions?action=upload_avatar', { method: 'POST', body: JSON.stringify({ avatar_data }) }); state.user = payload.user; renderAuth(); renderProfile(); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setActionProgress(input, '', false); input.value = ''; input.disabled = false; input.closest('.profile-avatar-wrap')?.removeAttribute('aria-busy'); if (edit) edit.innerHTML = original; } });
$('#admin-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true); try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'create_admin', ...Object.fromEntries(new FormData(event.target)) }) }); event.target.reset(); closeModal('admin-modal'); notify(payload.message); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#account-activity-filter')?.addEventListener('change', renderAccountActivityUsers);
$('#account-activity-search')?.addEventListener('input', renderAccountActivityUsers);
$('#refresh-account-activity')?.addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; try { await loadAccountActivity(); } finally { button.disabled = false; } });
$('#edit-form').addEventListener('submit', async (event) => { event.preventDefault(); setBusy(event.target, true, 'Saving task…'); try { const form = event.target; const formData = new FormData(form); const photoPayload = await taskFormPayload(form); const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'update_task', ...Object.fromEntries(formData), photos: photoPayload.photos, keep_image_urls: photoPayload.keep_image_urls }) }); const taskId = Number(formData.get('task_id')); closeModal('edit-modal'); setBusy(form, false); notify(payload.message); await loadTasks(); const updatedTask = state.tasks.find((task) => Number(task.id) === taskId); if (updatedTask) await openTask(updatedTask); if (state.myTasks.length) { state.myTasks = state.myTasks.map((task) => Number(task.id) === taskId ? { ...task, ...updatedTask } : task); renderMyTasks(state.myTasks); } } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#bid-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!state.user) { requestBidAuthGate(Number($('#task-detail-id').value), event.submitter || event.target.querySelector('[type="submit"]')); return; } setBusy(event.target, true); try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'place', task_id: $('#task-detail-id').value, ...Object.fromEntries(new FormData(event.target)) }) }); event.target.reset(); notify(payload.message); const task = state.tasks.find((item) => Number(item.id) === Number($('#task-detail-id').value)) || state.activeTask; if (task) openTask(task); } catch (error) { notify(error.message, 'error'); } finally { setBusy(event.target, false); } });
$('#conversation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.sendingMessage) return;
  const form = event.currentTarget, input = $('#conversation-body'), body = input.value.trim();
  if (!body) return;
  const taskId = Number($('#conversation-task-id').value), otherUserId = Number($('#conversation-user-id').value);
  const sendButton = form.querySelector('button');
  const optimistic = { id: `pending-${Date.now()}`, task_id: taskId, other_user_id: otherUserId, sender_id: state.user.id, recipient_id: otherUserId, sender_name: `${state.user.first_name} ${state.user.last_name}`, body, created_at: new Date().toISOString(), delivery_status: 'Sending…' };
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
$('#conversation-body').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#conversation-form').requestSubmit(); } });
$('#confirm-delete-bid').addEventListener('click', async () => { const button = $('#confirm-delete-bid'); setButtonBusy(button, true, 'Deleting bid…'); try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'delete', bid_id: $('#delete-bid-id').value, task_id: $('#delete-bid-task-id').value }) }); closeModal('delete-bid-modal'); notify(payload.message); await loadMyBids(); await loadTasks(); } catch (error) { notify(error.message, 'error'); } finally { setButtonBusy(button, false); } });
$('#confirm-remove-bid').addEventListener('click', async () => { const button = $('#confirm-remove-bid'); const reason = $('#remove-bid-reason').value.trim(); if (!reason) { notify('Please provide a reason for removing the bidder.', 'error'); return; } setButtonBusy(button, true, 'Removing bidder…'); try { const payload = await api('api/bid_actions', { method: 'POST', body: JSON.stringify({ action: 'remove_bid', bid_id: $('#remove-bid-id').value, task_id: $('#remove-bid-task-id').value, reason }) }); closeModal('remove-bid-modal'); notify(payload.message); const task = state.tasks.find((item) => Number(item.id) === Number($('#remove-bid-task-id').value)) || state.activeTask; if (task) await openTask(task); await loadTasks(); } catch (error) { notify(error.message, 'error'); } finally { setButtonBusy(button, false); } });
$('#confirm-delete-task').addEventListener('click', async () => { const button = $('#confirm-delete-task'); const taskId = $('#delete-task-id').value; setButtonBusy(button, true, 'Deleting task…'); try { const payload = await api('api/admin_actions', { method: 'POST', body: JSON.stringify({ action: 'delete_task', task_id: taskId }) }); closeModal('delete-task-modal'); notify(payload.message); await loadTasks(); showPage('marketplace-page'); } catch (error) { notify(error.message, 'error'); } finally { setButtonBusy(button, false); } });
init();
