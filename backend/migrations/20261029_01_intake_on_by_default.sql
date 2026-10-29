-- Migration date: 2026-10-29
-- Intake is on by default. An organization without saved intake settings is
-- treated as enabled, owners may switch it on before choosing a Legal team,
-- and submissions wait until a Legal team exists. Losing the last reviewer no
-- longer switches intake off.
alter table public.intake_settings alter column enabled set default true;

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
  -- Losing the last reviewer leaves intake on; submissions wait for a new team.
  update public.intake_settings set revision=revision+1,updated_at=now()
    where org_id=old.org_id;
  insert into public.intake_events(org_id,kind) select old.org_id,'roster_changed'
    where exists(select 1 from public.intake_settings where org_id=old.org_id);
  return old;
end $$;

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
    or exists(select 1 from unnest(reviewers) x where public.intake_member_role(p_org,x) is null)
    then raise exception 'Choose current organization members for the Legal team' using errcode='22023'; end if;
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
  -- Intake is on unless an owner switched it off, but needs a Legal team.
  if not coalesce((select enabled from public.intake_settings where org_id=p_org),true) then raise exception 'Intake is paused' using errcode='P0003'; end if;
  if not exists(select 1 from public.intake_reviewers where org_id=p_org) then raise exception 'Intake has no Legal team yet' using errcode='P0005'; end if;
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

create or replace function public.intake_configuration(p_org uuid,p_actor uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare role text; s public.intake_settings;
begin
  perform 1 from public.organizations where id=p_org for share;
  role:=public.intake_member_role(p_org,p_actor);
  if role is null then raise exception 'Intake not found' using errcode='P0002'; end if;
  select * into s from public.intake_settings where org_id=p_org;
  return jsonb_build_object('configured',s.org_id is not null,'enabled',coalesce(s.enabled,true),
    'has_team',exists(select 1 from public.intake_reviewers where org_id=p_org),
    'can_configure',role='owner','is_reviewer',public.intake_is_reviewer(p_org,p_actor)) ||
    case when role='owner' then jsonb_build_object('revision',coalesce(s.revision,0),'reviewer_ids',
      (select coalesce(jsonb_agg(user_id order by user_id),'[]') from public.intake_reviewers where org_id=p_org)) else '{}'::jsonb end;
end $$;
