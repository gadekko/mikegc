-- Migration date: 2026-10-30
-- Deleting an account through GoTrue cascades into the user's projects,
-- workflows, chats, tabular reviews and documents. Their access-cleanup trigger
-- then runs as supabase_auth_admin, which cannot write private-content grants,
-- so the whole deletion failed. The trigger only removes grants for the row
-- being deleted or moved, so it can safely run as its owner.
alter function public.clear_org_private_item_access() security definer;
alter function public.clear_org_private_item_access()
  set search_path = pg_catalog, public, pg_temp;
