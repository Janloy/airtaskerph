# iPhone Home Screen push notifications

TaskerPH supports Web Push for its iPhone Home Screen web app on iOS/iPadOS 16.4 or later. This is separate from native APNs notifications: people must add the site to their Home Screen, open that installed app, sign in, and tap **Enable notifications** in Profile. Notifications require permission and an internet connection.

## Configure the server

1. Apply `supabase/migrations/202610200002_web_push_subscriptions.sql` in the Supabase SQL Editor after the earlier migrations.
2. Generate a VAPID key pair in the project folder:

   ```powershell
   npx web-push generate-vapid-keys
   ```

3. Add these Vercel environment variables for Production and Preview as needed:
   - `WEB_PUSH_VAPID_PUBLIC_KEY`: generated public key.
   - `WEB_PUSH_VAPID_PRIVATE_KEY`: generated private key. Keep it server-side and never commit it.
   - `WEB_PUSH_VAPID_SUBJECT`: a contact URI such as `mailto:you@yourdomain.com`, replaced with an address you control.
4. Deploy the application and confirm the Vercel deployment succeeds.

Keep the same VAPID key pair after users subscribe. Rotating it requires users to enable notifications again on their devices.

## Enable on iPhone

1. Open `https://taskerph.vercel.app` in Safari on an iPhone running iOS/iPadOS 16.4 or later.
2. Tap **Share → Add to Home Screen**, then launch TaskerPH from its new Home Screen icon.
3. Sign in, open **Profile → Notifications → Enable notifications**, and allow the iOS permission prompt.
4. Send the account a message or task update from another account to test. In the foreground, TaskerPH shows an in-app alert; in the background or when closed, iOS displays a system notification.

The notification can be disabled from the same Profile section. iOS web push cannot be enabled from an ordinary Safari tab; the installed Home Screen app is required.
