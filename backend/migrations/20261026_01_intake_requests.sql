-- Migration date: 2026-10-26
-- Opt-in, organization-owned legal requests. All entry points are server-only.
create table if not exists public.intake_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.intake_reviewers (
  org_id uuid not null references public.intake_settings(org_id) on delete cascade,
  user_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(org_id,user_id),
  foreign key(org_id,user_id) references public.org_members(org_id,user_id) on delete cascade
);
create table if not exists public.intake_requests (
  incarnation_id uuid not null default gen_random_uuid(),
  id uuid primary key,
  org_id uuid not null references public.intake_settings(org_id) on delete cascade,
  requester_id uuid references auth.users(id) on delete set null,
  assignee_id uuid references auth.users(id) on delete set null,
  category text not null check(category in ('nda','general')),
  subject text not null check(char_length(subject) between 1 and 200 and btrim(subject) <> ''),
  description text not null check(char_length(description) between 1 and 20000 and btrim(description) <> ''),
  requested_by_date date,
  timezone text,
  state text not null default 'submitted' check(state in ('submitted','in_review','needs_information','resolved','cancelled')),
  version integer not null default 1 check(version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id,id),
  check ((requested_by_date is null) = (timezone is null)),
  check (timezone is null or char_length(timezone) between 1 and 100)
);
create index if not exists intake_requests_org_created on public.intake_requests(org_id,created_at,id);
create index if not exists intake_requests_requester on public.intake_requests(requester_id,org_id);
create index if not exists intake_requests_assignee_state on public.intake_requests(org_id,assignee_id,state);
create table if not exists public.intake_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  request_id uuid not null,
  author_id uuid references auth.users(id) on delete set null,
  kind text not null check(kind in ('question','reply','answer')),
  body text not null check(char_length(body) between 1 and 20000 and btrim(body) <> ''),
  created_at timestamptz not null default now(),
  foreign key(org_id,request_id) references public.intake_requests(org_id,id) on delete cascade
);
create index if not exists intake_messages_request on public.intake_messages(request_id,created_at,id);
create table if not exists public.intake_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.intake_settings(org_id) on delete cascade,
  request_id uuid,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null,
  from_state text,
  to_state text,
  assignee_id uuid references auth.users(id) on delete set null,
  message_id uuid references public.intake_messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  foreign key(org_id,request_id) references public.intake_requests(org_id,id) on delete cascade
);
create index if not exists intake_events_request on public.intake_events(request_id,id);
create table if not exists public.intake_commands (
  org_id uuid not null references public.intake_settings(org_id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  command_id uuid not null,
  request_id uuid,
  action text not null,
  input jsonb not null check(octet_length(input::text) <= 100000),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(org_id,actor_id,command_id),
  foreign key(org_id,request_id) references public.intake_requests(org_id,id) on delete cascade
);

-- Membership reads never inherit content access from an administrative role.
create or replace function public.intake_member_role(p_org uuid,p_actor uuid)
returns text language sql stable set search_path=public,pg_temp as $$
  select m.role from public.org_members m join public.organizations o on o.id=m.org_id
  join public.user_profiles u on u.user_id=m.user_id
  where m.org_id=p_org and m.user_id=p_actor and o.kind='team' and o.deleted_at is null
    and u.account_deletion_requested_at is null
$$;
create or replace function public.intake_is_reviewer(p_org uuid,p_actor uuid)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select public.intake_member_role(p_org,p_actor) is not null and exists(
    select 1 from public.intake_reviewers where org_id=p_org and user_id=p_actor)
$$;
create or replace function public.intake_can_read(p_org uuid,p_actor uuid,p_request uuid)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select public.intake_member_role(p_org,p_actor) is not null and exists(
    select 1 from public.intake_requests where org_id=p_org and id=p_request
      and (requester_id=p_actor or public.intake_is_reviewer(p_org,p_actor)))
$$;
create or replace function public.intake_lock_org(p_org uuid,p_actor uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  -- Same first lock as remove_org_member and organization deletion. Avoid
  -- membership row locks: existing deletion triggers already lock the org.
  perform 1 from public.organizations where id=p_org and kind='team' and deleted_at is null for update;
  if not found or public.intake_member_role(p_org,p_actor) is null then
    raise exception 'Intake not found' using errcode='P0002';
  end if;
end $$;
create or replace function public.intake_replay(p_org uuid,p_actor uuid,p_command uuid,p_action text,p_input jsonb)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare c public.intake_commands;
begin
  if p_command is null then raise exception 'Command ID is required' using errcode='22023'; end if;
  select * into c from public.intake_commands where org_id=p_org and actor_id=p_actor and command_id=p_command;
  if not found then return null; end if;
  if c.action<>p_action or c.input<>p_input then
    raise exception 'Command was already used for different input' using errcode='P0001';
  end if;
  return c.result || '{"replayed":true}'::jsonb;
end $$;
create or replace function public.intake_record_command(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_action text,p_input jsonb,p_version integer,p_message uuid default null)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare result jsonb;
begin
  result:=jsonb_build_object('request_id',p_request,'applied_version',p_version,'message_id',p_message,'replayed',false);
  insert into public.intake_commands(org_id,actor_id,command_id,request_id,action,input,result)
    values(p_org,p_actor,p_command,p_request,p_action,p_input,result);
  return result;
end $$;

-- Roster changes and real departures use the same atomic unassignment path.
create or replace function public.intake_reviewer_departure()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare r public.intake_requests;
begin
  perform 1 from public.organizations where id=old.org_id for update;
  if not found then return old; end if;
  for r in select * from public.intake_requests where org_id=old.org_id and assignee_id=old.user_id
    and state not in ('resolved','cancelled') order by id for update loop
    update public.intake_requests set assignee_id=null,
      state=case when state='in_review' then 'submitted' else state end,
      version=version+1,updated_at=now() where id=r.id;
    insert into public.intake_events(org_id,request_id,kind,from_state,to_state)
      values(old.org_id,r.id,'reviewer_removed',r.state,case when r.state='in_review' then 'submitted' else r.state end);
  end loop;
  update public.intake_settings set revision=revision+1,updated_at=now(),
    enabled=enabled and exists(select 1 from public.intake_reviewers where org_id=old.org_id)
    where org_id=old.org_id;
  insert into public.intake_events(org_id,kind) select old.org_id,'roster_changed'
    where exists(select 1 from public.intake_settings where org_id=old.org_id);
  return old;
end $$;
drop trigger if exists intake_reviewer_departure on public.intake_reviewers;
create trigger intake_reviewer_departure after delete on public.intake_reviewers
  for each row execute function public.intake_reviewer_departure();

create or replace function public.intake_configure(p_org uuid,p_actor uuid,p_command uuid,p_revision integer,p_enabled boolean,p_reviewers uuid[])
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare v integer; input jsonb; replay jsonb; reviewers uuid[];
begin
  perform public.intake_lock_org(p_org,p_actor);
  if public.intake_member_role(p_org,p_actor)<>'owner' then raise exception 'Only the organization owner can configure intake' using errcode='42501'; end if;
  select coalesce(array_agg(distinct x order by x),'{}'::uuid[]) into reviewers from unnest(p_reviewers) x;
  input:=jsonb_build_object('revision',p_revision,'enabled',p_enabled,'reviewers',reviewers);
  replay:=public.intake_replay(p_org,p_actor,p_command,'configure',input);
  if replay is not null then return replay; end if;
  if p_enabled is null or p_revision is null or p_reviewers is null or cardinality(reviewers)>500
    or (p_enabled and cardinality(reviewers)=0) or exists(select 1 from unnest(reviewers) x where public.intake_member_role(p_org,x) is null)
    then raise exception 'Choose current Legal team members before enabling intake' using errcode='22023'; end if;
  insert into public.intake_settings(org_id) values(p_org) on conflict do nothing;
  select revision into v from public.intake_settings where org_id=p_org;
  if v<>p_revision then raise exception 'Intake configuration changed; reload it' using errcode='P0001'; end if;
  -- Add first so replacing the last reviewer does not spuriously pause intake.
  insert into public.intake_reviewers(org_id,user_id,added_by) select p_org,x,p_actor from unnest(reviewers) x on conflict do nothing;
  delete from public.intake_reviewers where org_id=p_org and not(user_id=any(reviewers));
  update public.intake_settings set enabled=p_enabled,revision=revision+1,updated_at=now() where org_id=p_org returning revision into v;
  insert into public.intake_events(org_id,actor_id,kind) values(p_org,p_actor,'configured');
  return public.intake_record_command(p_org,p_actor,p_command,null,'configure',input,v);
end $$;

create or replace function public.intake_submit_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_category text,p_subject text,p_description text,p_date date default null,p_timezone text default null)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare input jsonb; replay jsonb;
begin
  perform public.intake_lock_org(p_org,p_actor);
  input:=jsonb_build_object('id',p_request,'category',p_category,'subject',p_subject,'description',p_description,'date',p_date,'timezone',p_timezone);
  replay:=public.intake_replay(p_org,p_actor,p_command,'submit',input);
  if replay is not null then
    if not public.intake_can_read(p_org,p_actor,p_request) then raise exception 'Request not found' using errcode='P0002'; end if;
    return replay;
  end if;
  if not coalesce((select enabled from public.intake_settings where org_id=p_org),false) then raise exception 'Intake is paused' using errcode='P0003'; end if;
  if p_request is null or p_category is null or p_subject is null or p_description is null
    or p_category not in ('nda','general') or char_length(p_subject) not between 1 and 200 or btrim(p_subject)=''
    or char_length(p_description) not between 1 and 20000 or btrim(p_description)=''
    or ((p_date is null)<>(p_timezone is null))
    or (p_timezone is not null and not exists(select 1 from pg_timezone_names where name=p_timezone))
    then raise exception 'Invalid request details' using errcode='22023'; end if;
  if exists(select 1 from public.intake_requests where id=p_request) then raise exception 'Request ID already used' using errcode='P0001'; end if;
  insert into public.intake_requests(id,org_id,requester_id,category,subject,description,requested_by_date,timezone)
    values(p_request,p_org,p_actor,p_category,p_subject,p_description,p_date,p_timezone);
  insert into public.intake_events(org_id,request_id,actor_id,kind,to_state) values(p_org,p_request,p_actor,'submitted','submitted');
  return public.intake_record_command(p_org,p_actor,p_command,p_request,'submit',input,1);
end $$;

-- Internal common transaction boundary. Only the explicit command functions
-- below are exposed by the API; action vocabulary is closed here as well.
create or replace function public.intake_change_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_version integer,p_action text,p_body text default null,p_assignee uuid default null)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb; next_state text; mid uuid; reviewer boolean;
begin
  perform public.intake_lock_org(p_org,p_actor);
  if not public.intake_can_read(p_org,p_actor,p_request) then raise exception 'Request not found' using errcode='P0002'; end if;
  input:=jsonb_build_object('id',p_request,'version',p_version,'body',p_body,'assignee',p_assignee);
  -- Resolve committed operations after current read access, before checking
  -- state/assignment that the original operation itself may have changed.
  replay:=public.intake_replay(p_org,p_actor,p_command,p_action,input);
  if replay is not null then return replay; end if;
  if not coalesce((select enabled from public.intake_settings where org_id=p_org),false) then raise exception 'Intake is paused' using errcode='P0003'; end if;
  select * into r from public.intake_requests where org_id=p_org and id=p_request for update;
  reviewer:=public.intake_is_reviewer(p_org,p_actor);
  if p_action not in ('assign','ask','reply','publish','cancel') or p_action is null then raise exception 'Invalid command' using errcode='22023'; end if;
  if (p_action='assign' and not reviewer)
    or (p_action in ('ask','publish') and (not reviewer or r.assignee_id is distinct from p_actor))
    or (p_action='reply' and r.requester_id is distinct from p_actor)
    then raise exception 'This action is not available to you' using errcode='42501'; end if;
  if p_version is null or r.version<>p_version or r.state in ('resolved','cancelled') then raise exception 'Request changed; reload it' using errcode='P0001'; end if;
  next_state:=r.state;
  if p_action='assign' then
    if p_assignee is not null and not public.intake_is_reviewer(p_org,p_assignee) then raise exception 'Choose a current Legal reviewer' using errcode='22023'; end if;
    if r.state in ('submitted','in_review') then next_state:=case when p_assignee is null then 'submitted' else 'in_review' end; end if;
  elsif p_action in ('ask','reply','publish') then
    if p_body is null or char_length(p_body) not between 1 and 20000 or btrim(p_body)='' then raise exception 'Enter a message of at most 20000 characters' using errcode='22023'; end if;
    if (p_action='reply' and r.state<>'needs_information') or (p_action in ('ask','publish') and r.state<>'in_review') then raise exception 'Request changed; reload it' using errcode='P0001'; end if;
    next_state:=case p_action when 'ask' then 'needs_information' when 'publish' then 'resolved'
      else case when public.intake_is_reviewer(p_org,r.assignee_id) then 'in_review' else 'submitted' end end;
    insert into public.intake_messages(org_id,request_id,author_id,kind,body)
      values(p_org,p_request,p_actor,case p_action when 'ask' then 'question' when 'publish' then 'answer' else 'reply' end,p_body) returning id into mid;
  else next_state:='cancelled'; end if;
  update public.intake_requests set state=next_state,assignee_id=case when p_action='assign' then p_assignee else assignee_id end,
    version=version+1,updated_at=now() where id=p_request;
  insert into public.intake_events(org_id,request_id,actor_id,kind,from_state,to_state,assignee_id,message_id)
    values(p_org,p_request,p_actor,p_action,r.state,next_state,case when p_action='assign' then p_assignee else r.assignee_id end,mid);
  return public.intake_record_command(p_org,p_actor,p_command,p_request,p_action,input,r.version+1,mid);
end $$;

create or replace function public.intake_assign_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_version integer,p_assignee uuid)
returns jsonb language sql set search_path=public,pg_temp as $$
  select public.intake_change_request(p_org,p_actor,p_command,p_request,p_version,'assign',null,p_assignee)
$$;

create or replace function public.intake_ask_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_version integer,p_body text)
returns jsonb language sql set search_path=public,pg_temp as $$
  select public.intake_change_request(p_org,p_actor,p_command,p_request,p_version,'ask',p_body,null)
$$;

create or replace function public.intake_reply_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_version integer,p_body text)
returns jsonb language sql set search_path=public,pg_temp as $$
  select public.intake_change_request(p_org,p_actor,p_command,p_request,p_version,'reply',p_body,null)
$$;

create or replace function public.intake_publish_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_version integer,p_body text)
returns jsonb language sql set search_path=public,pg_temp as $$
  select public.intake_change_request(p_org,p_actor,p_command,p_request,p_version,'publish',p_body,null)
$$;

create or replace function public.intake_cancel_request(p_org uuid,p_actor uuid,p_command uuid,p_request uuid,p_version integer)
returns jsonb language sql set search_path=public,pg_temp as $$
  select public.intake_change_request(p_org,p_actor,p_command,p_request,p_version,'cancel',null,null)
$$;

create or replace function public.intake_configuration(p_org uuid,p_actor uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare role text; s public.intake_settings;
begin
  perform 1 from public.organizations where id=p_org for share;
  role:=public.intake_member_role(p_org,p_actor);
  if role is null then raise exception 'Intake not found' using errcode='P0002'; end if;
  select * into s from public.intake_settings where org_id=p_org;
  return jsonb_build_object('configured',s.org_id is not null,'enabled',coalesce(s.enabled,false),
    'can_configure',role='owner','is_reviewer',public.intake_is_reviewer(p_org,p_actor)) ||
    case when role='owner' then jsonb_build_object('revision',coalesce(s.revision,0),'reviewer_ids',
      (select coalesce(jsonb_agg(user_id order by user_id),'[]') from public.intake_reviewers where org_id=p_org)) else '{}'::jsonb end;
end $$;
create or replace function public.intake_roster(p_org uuid,p_actor uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare actor_role text;
begin
  perform 1 from public.organizations where id=p_org for share;
  actor_role:=public.intake_member_role(p_org,p_actor);
  if actor_role is null then raise exception 'Intake not found' using errcode='P0002'; end if;
  if actor_role<>'owner' and not public.intake_is_reviewer(p_org,p_actor) then raise exception 'Legal team access required' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',u.display_name,'email',u.email,
    'is_reviewer',r.user_id is not null) order by m.user_id),'[]')
    from public.org_members m join public.user_profiles u on u.user_id=m.user_id
    left join public.intake_reviewers r on r.org_id=m.org_id and r.user_id=m.user_id
    where m.org_id=p_org and u.account_deletion_requested_at is null and (actor_role='owner' or r.user_id is not null));
end $$;
create or replace function public.intake_request_view(p_org uuid,p_actor uuid,p_request uuid)
returns jsonb language sql stable set search_path=public,pg_temp as $$
  select to_jsonb(r) || jsonb_build_object(
    'requester_name',coalesce(u.display_name,u.email,'Former member'),
    'assignee_name',case when r.assignee_id is null then null else coalesce(a.display_name,a.email,'Former member') end,
    'capabilities',jsonb_build_object(
      'assign',s.enabled and r.state not in ('resolved','cancelled') and public.intake_is_reviewer(p_org,p_actor),
      'ask',s.enabled and r.state='in_review' and coalesce(r.assignee_id=p_actor,false) and public.intake_is_reviewer(p_org,p_actor),
      'publish',s.enabled and r.state='in_review' and coalesce(r.assignee_id=p_actor,false) and public.intake_is_reviewer(p_org,p_actor),
      'reply',s.enabled and r.state='needs_information' and coalesce(r.requester_id=p_actor,false),
      'cancel',s.enabled and r.state not in ('resolved','cancelled')))
    from public.intake_requests r join public.intake_settings s on s.org_id=r.org_id
    left join public.user_profiles u on u.user_id=r.requester_id left join public.user_profiles a on a.user_id=r.assignee_id
    where r.id=p_request and r.org_id=p_org and public.intake_can_read(p_org,p_actor,p_request)
$$;
create or replace function public.intake_list_requests(p_org uuid,p_actor uuid,p_view text default 'mine',p_state text default null,p_assignee uuid default null,p_search text default '',p_offset integer default 0,p_limit integer default 50)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
begin
  perform 1 from public.organizations where id=p_org for share;
  if public.intake_member_role(p_org,p_actor) is null then raise exception 'Intake not found' using errcode='P0002'; end if;
  if p_view='queue' and not public.intake_is_reviewer(p_org,p_actor) then raise exception 'Legal team access required' using errcode='42501'; end if;
  if p_view not in ('mine','queue') or p_view is null or p_offset<0 or p_offset is null or p_limit not between 1 and 100 or p_limit is null
    or p_search is null or char_length(p_search)>200 or (p_state is not null and p_state not in ('submitted','in_review','needs_information','resolved','cancelled')) then raise exception 'Invalid request filter' using errcode='22023'; end if;
  return (select coalesce(jsonb_agg(public.intake_request_view(p_org,p_actor,x.id) order by x.created_at desc,x.id desc),'[]') from (
    select r.id,r.created_at from public.intake_requests r where r.org_id=p_org
      and (p_view='queue' or coalesce(r.requester_id=p_actor,false)) and (p_state is null or r.state=p_state)
      and (p_assignee is null or r.assignee_id=p_assignee)
      and (p_search='' or strpos(lower(r.subject),lower(p_search))>0 or strpos(lower(r.description),lower(p_search))>0)
      order by r.created_at desc,r.id desc offset p_offset limit p_limit
  ) x);
end $$;
create or replace function public.intake_get_request(p_org uuid,p_actor uuid,p_request uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare result jsonb;
begin
  perform 1 from public.organizations where id=p_org for share;
  result:=public.intake_request_view(p_org,p_actor,p_request);
  if result is null then raise exception 'Request not found' using errcode='P0002'; end if;
  return result;
end $$;
create or replace function public.intake_read_history(p_org uuid,p_actor uuid,p_request uuid,p_events boolean default false,p_offset integer default 0,p_limit integer default 50)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
begin
  perform 1 from public.organizations where id=p_org for share;
  if not public.intake_can_read(p_org,p_actor,p_request) then raise exception 'Request not found' using errcode='P0002'; end if;
  if p_offset<0 or p_offset is null or p_limit not between 1 and 100 or p_limit is null then raise exception 'Invalid page' using errcode='22023'; end if;
  if p_events then
    return (select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from (
      select e.id,e.kind,e.from_state,e.to_state,e.created_at,coalesce(u.display_name,u.email,'Former member') as actor_name
      from public.intake_events e left join public.user_profiles u on u.user_id=e.actor_id
      where e.org_id=p_org and e.request_id=p_request order by e.id offset p_offset limit p_limit) x);
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at,x.id),'[]') from (
    select m.id,m.kind,m.body,m.created_at,coalesce(u.display_name,u.email,'Former member') as author_name
    from public.intake_messages m left join public.user_profiles u on u.user_id=m.author_id
    where m.org_id=p_org and m.request_id=p_request order by m.created_at,m.id offset p_offset limit p_limit) x);
end $$;

create or replace function public.intake_purge(p_org uuid,p_actor uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  perform public.intake_lock_org(p_org,p_actor);
  if public.intake_member_role(p_org,p_actor)<>'owner' then raise exception 'Only the organization owner can delete intake data' using errcode='42501'; end if;
  delete from public.intake_requests where org_id=p_org;
  insert into public.intake_events(org_id,actor_id,kind)
    select p_org,p_actor,'requests_purged' where exists(select 1 from public.intake_settings where org_id=p_org);
end $$;

-- Erasure never transfers the Legal queue to the departing user's successor.
create or replace function public.intake_erase_identity(p_actor uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  perform o.id from public.organizations o where exists(select 1 from public.intake_requests r
    where r.org_id=o.id and (coalesce(r.requester_id=p_actor,false) or coalesce(r.assignee_id=p_actor,false)))
    or exists(select 1 from public.intake_reviewers v where v.org_id=o.id and v.user_id=p_actor)
    order by o.id for update;
  delete from public.intake_reviewers where user_id=p_actor;
  -- Receipts embed typed command input. Delete references to the erased person
  -- as well as their own receipts, instead of leaving their ID in opaque JSON.
  delete from public.intake_commands where actor_id=p_actor or input->>'assignee'=p_actor::text
    or (input->'reviewers') @> to_jsonb(array[p_actor]);
  update public.intake_requests set requester_id=null where requester_id=p_actor;
  update public.intake_requests set assignee_id=null where assignee_id=p_actor;
  update public.intake_messages set author_id=null where author_id=p_actor;
  update public.intake_events set actor_id=null where actor_id=p_actor;
  update public.intake_events set assignee_id=null where assignee_id=p_actor;
  update public.intake_reviewers set added_by=null where added_by=p_actor;
end $$;
create or replace function public.intake_auth_erasure()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.intake_erase_identity(old.id);
  return old;
end $$;
drop trigger if exists intake_auth_erasure on auth.users;
create trigger intake_auth_erasure before delete on auth.users for each row execute function public.intake_auth_erasure();

-- Keyset selection is complete beyond PostgREST's row cap. Child reads still
-- use the same authorized request history functions as the interactive API.
create or replace function public.intake_export_requests(p_actor uuid,p_after uuid default null,p_limit integer default 100)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
begin
  if p_limit not between 1 and 100 then raise exception 'Invalid page' using errcode='22023'; end if;
  return (select coalesce(jsonb_agg(public.intake_request_view(x.org_id,p_actor,x.id) order by x.id),'[]') from (
    select r.id,r.org_id from public.intake_requests r where coalesce(r.requester_id=p_actor,false)
      and (p_after is null or r.id>p_after) and public.intake_can_read(r.org_id,p_actor,r.id)
      order by r.id limit p_limit) x);
end $$;
create or replace function public.intake_validate_export(p_actor uuid,p_requests jsonb)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select jsonb_array_length(p_requests)<=100 and not exists(
    select 1 from jsonb_to_recordset(p_requests) x(id uuid,incarnation_id uuid)
    where not exists(select 1 from public.intake_requests r where r.id=x.id
      and r.incarnation_id=x.incarnation_id and coalesce(r.requester_id=p_actor,false)
      and public.intake_can_read(r.org_id,p_actor,r.id)))
$$;

-- Tables and functions are inaccessible to browser database roles, even if
-- default Supabase grants change. The backend service role supplies the actor.
do $$ declare obj record; begin
  for obj in select tablename from pg_tables where schemaname='public' and tablename like 'intake_%' loop
    execute format('alter table public.%I enable row level security',obj.tablename);
    execute format('revoke all on public.%I from public,anon,authenticated',obj.tablename);
    execute format('grant all on public.%I to service_role',obj.tablename);
  end loop;
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'intake_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',obj.signature);
    execute format('grant execute on function %s to service_role',obj.signature);
  end loop;
end $$;
grant usage,select on sequence public.intake_events_id_seq to service_role;
