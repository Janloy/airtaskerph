import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

const accessTokenKey = 'taskerph-supabase-access-token';
let deviceToken = '';
let lastRegisteredAccessToken = '';
let registering = false;
let registrationStarted = false;

async function updateDeviceRegistration(action, authToken) {
  if (!deviceToken || !authToken) return;
  try {
    const response = await fetch('/api/push_devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ device_action: action, token: deviceToken, platform: Capacitor.getPlatform() })
    });
    if (!response.ok) throw new Error(`Push device registration returned ${response.status}.`);
    return true;
  } catch (error) {
    console.warn('Could not update push notification registration.', error);
    return false;
  }
}

async function registerDeviceForCurrentUser() {
  const authToken = localStorage.getItem(accessTokenKey);
  if (!authToken || !deviceToken || registering || lastRegisteredAccessToken === authToken) return;
  registering = true;
  try {
    if (await updateDeviceRegistration('register', authToken)) lastRegisteredAccessToken = authToken;
  } finally {
    registering = false;
  }
}

async function requestPushPermissionAndRegister() {
  if (!Capacitor.isNativePlatform() || !localStorage.getItem(accessTokenKey)) return;
  if (registrationStarted) { await registerDeviceForCurrentUser(); return; }
  try {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== 'granted') return;
    registrationStarted = true;
    if (Capacitor.getPlatform() === 'android') {
      await PushNotifications.createChannel({ id: 'taskerph_activity', name: 'TaskerPH activity', description: 'Messages and task updates', importance: 4, sound: 'default', visibility: 0 });
    }
    await PushNotifications.register();
  } catch (error) {
    console.warn('Could not register for push notifications.', error);
  }
}

async function initNativePush() {
  if (!Capacitor.isNativePlatform()) return;
  document.documentElement.classList.add('capacitor-native-app');
  await PushNotifications.addListener('registration', ({ value }) => {
    deviceToken = value;
    lastRegisteredAccessToken = '';
    void registerDeviceForCurrentUser();
  });
  await PushNotifications.addListener('registrationError', (error) => console.warn('Push registration error.', error));
  await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
    window.dispatchEvent(new CustomEvent('taskerph:push-open', { detail: notification.data || {} }));
  });
  window.addEventListener('taskerph:auth-updated', () => {
    if (localStorage.getItem(accessTokenKey)) void requestPushPermissionAndRegister();
  });
  window.taskerphPushLogout = async () => {
    const authToken = localStorage.getItem(accessTokenKey);
    await updateDeviceRegistration('unregister', authToken);
    lastRegisteredAccessToken = '';
  };
  await requestPushPermissionAndRegister();
}

void initNativePush();
