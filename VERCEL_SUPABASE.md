# Vercel + Supabase migration notes

The existing UI and CSS are retained. `index.html` is the static Vercel entry point; Vercel rewrites the existing `/api/*.php` URLs to a single Node serverless API, so the UI's current request paths remain intact. The Supabase migration defines PostgreSQL tables, Auth profile trigger, storage bucket, and row-level security policies. API writes are authenticated with Supabase Auth and use the server-only service role key.

## Setup

1. Create a Supabase project and run `supabase/migrations/202609290001_initial_schema.sql` in its SQL editor. Then run `supabase/migrations/202609290002_task_photos.sql` for task photos and `supabase/migrations/202609300001_account_activity.sql` for the superadmin account activity dashboard.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Vercel project environment variables. Keep the service role key server-side only.
3. Deploy the repository to Vercel and sign up through the site. Confirm the account email if Supabase email confirmation is enabled.
4. Grant your account the initial superadmin role in the Supabase SQL editor: `update public.user_profiles set role = 'superadmin' where email = 'bahenajohnlouie3@gmail.com';` Then sign out and back in.
5. For local development, copy `.env.example` to `.env.local`, fill in the same three keys, and run `npm install` followed by `npm run dev`.

Existing MySQL accounts and task data are not automatically copied. Export/import them separately if you need to preserve existing records. Do not put the service-role key in browser code.

Task posts can include up to three JPG, PNG, or WEBP images. The browser resizes them to JPEG before upload; the API accepts up to 450 KB per compressed image and stores them in the public `task-photos` Supabase Storage bucket. Public task images are viewable by anyone who can view the task. Task owners can open photos in a full-screen viewer and remove or replace individual photos while editing a task.

The superadmin-only **Account activity** dashboard lists admins and users with their most recent login and authenticated activity times. It does not show a recent actions feed. The account presence migration records login and activity timestamps going forward; older history cannot be reconstructed.

## Deploy code changes through GitHub

1. Run any required Supabase SQL migration in **Supabase Dashboard → SQL Editor** before deploying code that depends on it. For account activity, run `supabase/migrations/202609300001_account_activity.sql` once after the initial schema migration.
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
