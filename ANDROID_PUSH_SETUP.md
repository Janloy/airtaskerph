# Android push notifications

TaskerPH uses Firebase Cloud Messaging (FCM) for native Android notifications. The app asks for notification permission after sign-in, registers this device token to the signed-in user, and sends visible pushes for task updates and new messages.

## 1. Create the Firebase Android app

1. Create or open the TaskerPH project in the Firebase Console.
2. Add an Android app with package name `ph.airtaskerph.app`.
3. Download `google-services.json` and place it at `android/app/google-services.json`. This file is ignored by Git.
4. In **Project settings → Service accounts**, create a private key for a service account that has permission to send Firebase Cloud Messaging messages. Keep the JSON private key out of Git and the client app.

## 2. Add server credentials in Vercel

Add these server-side environment variables to the Vercel project, for Production and Preview as needed:

- `FCM_PROJECT_ID`: Firebase project ID.
- `FCM_CLIENT_EMAIL`: service account `client_email`.
- `FCM_PRIVATE_KEY`: service account `private_key`; preserve its newlines or enter them as `\n`.

Never add the service-account private key to `index.html`, Android assets, or `google-services.json`.

## 3. Create the device-token table

Run `supabase/migrations/202610010008_push_device_tokens.sql` in the Supabase SQL Editor.

## 4. Build and install on a real Android phone

On the development computer, install Android Studio 2025.2.1 or later with an Android SDK. On the phone, enable **Developer options → USB debugging**, connect it by USB, and approve the computer prompt.

From the project folder:

```bash
npm install
npm run app:android
```

In Android Studio, select the connected phone and click **Run**. Sign in to TaskerPH and allow notifications when prompted. To test background delivery, put the app in the background and send the signed-in user a message or task update from another account. Tap the notification to open the related conversation or task.

For each native plugin or Android project change, rebuild/reinstall the app. The website JavaScript bundle is rebuilt and Capacitor-synced by `npm run app:sync`.
