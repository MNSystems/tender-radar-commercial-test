-- STAGING ONLY. Apply after review; does not change existing tables.
-- One automatic initial run per search profile. Claims are atomic.
create table if not exists commercial.initial_search_claims (
  profile_id bigint primary key references commercial.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  dispatch_status text not null default 'queued'
);
alter table commercial.initial_search_claims enable row level security;
revoke all on commercial.initial_search_claims from anon, authenticated;
create or replace function commercial.claim_initial_search(p_profile_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted integer;
begin
  insert into commercial.initial_search_claims(profile_id)
  select p.id from commercial.profiles p
  where p.id = p_profile_id and p.active = true
  on conflict (profile_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
end
$$;
revoke all on function commercial.claim_initial_search(bigint) from public, anon, authenticated;
grant execute on function commercial.claim_initial_search(bigint) to service_role;
