-- Migration date: 2026-10-26
-- The departure trigger checks whether auth.users still contains the departing
-- account. GoTrue/service-role membership deletion must not require broad read
-- access to auth.users. Scope and dynamic identifiers come from the trigger's
-- OLD membership and closed CASE expressions; the removal RPC still authorizes
-- the actor before it can delete that row.
alter function public.cleanup_removed_org_member_overrides() security definer;
alter function public.cleanup_removed_org_member_overrides()
  set search_path = pg_catalog, public, pg_temp;
