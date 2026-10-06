# Vercel + Supabase migration notes

The existing interface and layout are retained in `index.html`. Vercel serves that static page and routes clean `/api/...` URLs to the Node serverless handler in `api/legacy.js`. The deployed app requests data from Supabase through that handler. The Supabase migrations define PostgreSQL tables, Auth profile trigger, storage bucket, and row-level security policies. API writes are authenticated with Supabase Auth and use the server-only service role key.

The Vercel Function is pinned to Seoul (`icn1`) in `vercel.json`, matching the Supabase project region (`ap-northeast-2`) to reduce database round-trip latency. Static files continue to use Vercel's CDN.

## Setup

1. Create a Supabase project and run the migrations in numeric order: `202609290001_initial_schema.sql`, `202609290002_task_photos.sql`, `202609300001_account_activity.sql`, `202609300002_query_indexes.sql`, `202609300005_superadmin_events_reports.sql`, `202609300006_task_posting_features.sql`, `202610010007_task_completion_workflow.sql`, `202610010008_push_device_tokens.sql`, `202610060009_superadmin_controls.sql`, `202610060010_admin_operations.sql`, and `202610060011_admin_workflows_mfa.sql`. Apply each migration once.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Vercel project environment variables. Keep the service role key server-side only. Add `SUPERADMIN_MFA_ENCRYPTION_KEY` as a 64-character random hexadecimal value (32 random bytes); the API needs it to encrypt authenticator secrets and short-lived MFA challenges. In PowerShell, generate a value with:

   ```powershell
   $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
   $bytes = New-Object byte[] 32
   $rng.GetBytes($bytes)
   [BitConverter]::ToString($bytes).Replace('-', '').ToLower()
   ```

   Store the output as a Vercel environment variable for every deployment environment. Do not put it in browser code, commit it, or change it after enabling MFA unless you have a planned key rotation.
3. Deploy the repository to Vercel and sign up through the site. Confirm the account email if Supabase email confirmation is enabled.
4. Grant your account the initial superadmin role in the Supabase SQL editor: `update public.user_profiles set role = 'superadmin' where email = 'bahenajohnlouie3@gmail.com';` Then sign out and back in.
5. For local development, copy `.env.example` to `.env.local`, fill in the Supabase keys and a locally generated `SUPERADMIN_MFA_ENCRYPTION_KEY`, and run `npm install` followed by `npm run dev`. Never reuse or commit a production key in local development.

The optional on-site promotion/payment, completion-review, and marketplace-report features from migration `202609300003_marketplace_safety_and_revenue.sql` are currently retired. If migration 003 has already been run, apply `supabase/migrations/202609300004_remove_marketplace_safety_and_revenue.sql` once in the Supabase SQL Editor. It drops only the tables and views introduced for those features, including any rows in them; it leaves accounts, tasks, bids, messages, and saved tasks intact. Remove `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, or `APP_BASE_URL` from Vercel if you previously added them, and delete the webhook endpoint from PayMongo if you created one. Do not run migration 003 again unless you decide to restore those features.

Do not put the service-role key in browser code. The deployed app uses the static HTML interface, Node serverless API, and Supabase; the PHP and MySQL implementation has been removed.

Task posts can include up to three JPG, PNG, or WEBP images. The browser resizes them to JPEG before upload; the API accepts up to 450 KB per compressed image and stores them in the public `task-photos` Supabase Storage bucket. Public task images are viewable by anyone who can view the task. Task owners can open photos in a full-screen viewer and remove or replace individual photos while editing a task.

The administrator workspace has separate Dashboard, Users, Tasks, Reports, Audit log, and Operations pages. Superadmin sign-ins require authenticator-app TOTP, with one-time recovery codes and a required first-time setup. Operations includes moderation assignments, private staff-only notes, priority/SLA tracking, staff activity summaries, suspension appeals, staff permissions, platform analytics, announcement audience estimates and previews, and safe service/database health checks. Bulk member suspensions show a review step and require a shared reason and duration; each account change is written to the audit log. Authorized staff can view moderation history on member profiles. Published announcements appear in the member notification center and track read receipts. Superadmins manage staff roles and permissions; moderator staff can be granted task, report, and dispute access; support staff can view member records without moderation or account-editing controls. Report queues support status, reason, date, and text filters, paginated results, waiting-time indicators, and resolution notes. Dashboard trend data covers the last 30 days and can be exported as CSV. New privileged actions are written to `admin_audit_events`, which keeps administrator and target snapshots so the audit trail survives profile deletion. Existing activity history remains available, but older events cannot be reconstructed into the durable audit log.

## Deploy code changes through GitHub

1. Run any required Supabase SQL migration in **Supabase Dashboard → SQL Editor** before deploying code that depends on it. Apply `202610060011_admin_workflows_mfa.sql` after `202610060010_admin_operations.sql` and all earlier migrations, if it has not already been run. Confirm `SUPERADMIN_MFA_ENCRYPTION_KEY` is present in Vercel before deploying.
2. Open PowerShell in the project folder and check the current branch and changed files:

   ```powershell
   cd C:\xampp\htdocs\airtaskerph
   git status
   git branch --show-current
   ```

3. Stage only the application/migration/documentation files for this feature (avoid `git add .` if unrelated files are modified), then commit and push the current branch to GitHub. Replace `main` if the branch command above shows a different name:

   ```powershell
   git add api\legacy.js js\app.js index.html supabase\migrations\202610060011_admin_workflows_mfa.sql VERCEL_SUPABASE.md
   git commit -m "Add admin workflow and security features"
   git push origin main
   ```

4. If the GitHub repository is connected to Vercel, the push starts a deployment automatically. Check **Vercel Dashboard → your project → Deployments** and wait for the deployment to complete.
