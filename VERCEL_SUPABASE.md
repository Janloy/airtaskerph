# Vercel + Supabase migration notes

The existing interface and layout are retained in `index.html`. Vercel serves that static page and routes clean `/api/...` URLs to the Node serverless handler in `api/legacy.js`. The deployed app requests data from Supabase through that handler. The Supabase migrations define PostgreSQL tables, Auth profile trigger, storage bucket, and row-level security policies. API writes are authenticated with Supabase Auth and use the server-only service role key.

The Vercel Function is pinned to Seoul (`icn1`) in `vercel.json`, matching the Supabase project region (`ap-northeast-2`) to reduce database round-trip latency. Static files continue to use Vercel's CDN.

## Setup

1. Create a Supabase project and run `supabase/migrations/202609290001_initial_schema.sql` in its SQL editor. Then run `supabase/migrations/202609290002_task_photos.sql` for task photos, `supabase/migrations/202609300001_account_activity.sql` for account activity, `supabase/migrations/202609300002_query_indexes.sql` for faster task and unread-message lookups, and `supabase/migrations/202609300005_superadmin_events_reports.sql` for the superadmin event feed and task reports. Apply each migration once, in numeric order.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Vercel project environment variables. Keep the service role key server-side only.
3. Deploy the repository to Vercel and sign up through the site. Confirm the account email if Supabase email confirmation is enabled.
4. Grant your account the initial superadmin role in the Supabase SQL editor: `update public.user_profiles set role = 'superadmin' where email = 'bahenajohnlouie3@gmail.com';` Then sign out and back in.
5. For local development, copy `.env.example` to `.env.local`, fill in the same three keys, and run `npm install` followed by `npm run dev`.

The optional on-site promotion/payment, completion-review, and marketplace-report features from migration `202609300003_marketplace_safety_and_revenue.sql` are currently retired. If migration 003 has already been run, apply `supabase/migrations/202609300004_remove_marketplace_safety_and_revenue.sql` once in the Supabase SQL Editor. It drops only the tables and views introduced for those features, including any rows in them; it leaves accounts, tasks, bids, messages, and saved tasks intact. Remove `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, or `APP_BASE_URL` from Vercel if you previously added them, and delete the webhook endpoint from PayMongo if you created one. Do not run migration 003 again unless you decide to restore those features.

Do not put the service-role key in browser code. The deployed app uses the static HTML interface, Node serverless API, and Supabase; the PHP and MySQL implementation has been removed.

Task posts can include up to three JPG, PNG, or WEBP images. The browser resizes them to JPEG before upload; the API accepts up to 450 KB per compressed image and stores them in the public `task-photos` Supabase Storage bucket. Public task images are viewable by anyone who can view the task. Task owners can open photos in a full-screen viewer and remove or replace individual photos while editing a task.

The superadmin-only area has separate Dashboard, Users, Tasks, Reports, and Audit log pages. User management supports name/email search, role filters, and permanent account deletion; Superadmin accounts cannot be deleted from the page. Deleting another account also removes its profile-owned task and report data through database cascades. Superadmins can mark reports reviewed or dismiss them, and members can report tasks from their detail view. Activity history is recorded going forward; older events cannot be reconstructed.

## Deploy code changes through GitHub

1. Run any required Supabase SQL migration in **Supabase Dashboard → SQL Editor** before deploying code that depends on it. For account activity, query performance, and the superadmin dashboard, run migrations `202609300001_account_activity.sql`, `202609300002_query_indexes.sql`, and `202609300005_superadmin_events_reports.sql` once after the initial schema migration.
2. Open PowerShell in the project folder and check the current branch and changed files:

   ```powershell
   cd C:\xampp\htdocs\airtaskerph
   git status
   git branch --show-current
   ```

3. Stage and commit the changes, then push the current branch to GitHub. Replace `main` if the branch command above shows a different name:

   ```powershell
   git add .
   git commit -m "Improve task photo editing layout"
   git push origin main
   ```

4. If the GitHub repository is connected to Vercel, the push starts a deployment automatically. Check **Vercel Dashboard → your project → Deployments** and wait for the deployment to complete.
