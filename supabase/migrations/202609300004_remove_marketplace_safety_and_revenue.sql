-- Roll back the temporary on-platform promotion, payment webhook, report,
-- task completion, and review features added by migration 202609300003.
-- This drops the feature tables and their contents; core marketplace tables remain.
begin;

drop view if exists public.task_review_summary;
drop view if exists public.task_promotion_revenue;

drop table if exists public.marketplace_reports;
drop table if exists public.task_reviews;
drop table if exists public.task_completions;
drop table if exists public.payment_webhook_events;
drop table if exists public.task_promotions;

commit;
