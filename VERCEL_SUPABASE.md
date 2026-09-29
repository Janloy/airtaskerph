# Vercel + Supabase migration notes

The existing UI and CSS are retained. `index.html` is the static Vercel entry point; Vercel rewrites the existing `/api/*.php` URLs to a single Node serverless API, so the UI's current request paths remain intact. The Supabase migration defines PostgreSQL tables, Auth profile trigger, storage bucket, and row-level security policies. API writes are authenticated with Supabase Auth and use the server-only service role key.

## Setup

1. Create a Supabase project and run `supabase/migrations/202609290001_initial_schema.sql` in its SQL editor.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Vercel project environment variables. Keep the service role key server-side only.
3. Deploy the repository to Vercel and sign up through the site. Confirm the account email if Supabase email confirmation is enabled.
4. Grant your account the initial superadmin role in the Supabase SQL editor: `update public.user_profiles set role = 'superadmin' where email = 'bahenajohnlouie3@gmail.com';` Then sign out and back in.
5. For local development, copy `.env.example` to `.env.local`, fill in the same three keys, and run `npm install` followed by `npm run dev`.

Existing MySQL accounts and task data are not automatically copied. Export/import them separately if you need to preserve existing records. Do not put the service-role key in browser code.
