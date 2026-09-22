-- ---------- 헬퍼 함수 ----------
create or replace function gs.day_type(d date) returns int
language sql stable security definer set search_path=gs, public, extensions as $$
  select case
    when exists(select 1 from gs.holidays h where h.d=d) then 3
    when extract(dow from d)=6 then 2   -- 토
    when extract(dow from d)=5 then 1   -- 금
    else 0                              -- 주중(일~목)
  end;
$$;

create or replace function gs.season_kind(d date) returns text
language sql stable security definer set search_path=gs, public, extensions as $$
  with md as (select to_char(d,'MM-DD') as v)
  select coalesce(
    (select r.kind from gs.season_ranges r, md
       where md.v between r.start_md and r.end_md
       order by case r.kind when 'high' then 0 when 'mid' then 1 else 2 end
       limit 1),
    'off');
$$;

-- ---------- api() 단일 진입점 ----------
create or replace function gs.api(action text, payload jsonb default '{}', token text default null)
returns jsonb
language plpgsql security definer set search_path=gs, public, extensions as $$
declare
  v_user text; v_token text;
  r record; d date; k text; dt int; p int; tot int; ncnt int;
  arr jsonb;
begin
  -- ===== 공개 액션 =====
  if action = 'rooms' then
    return (select jsonb_agg(jsonb_build_object(
        'id',rm.id,'name',rm.name,'type',rt.name,'type_id',rt.id,
        'cap_base',rm.cap_base,'cap_max',rm.cap_max,
        'price_from',(select min(price) from gs.prices pp where pp.room_id=rm.id)
      ) order by rm.sort)
      from gs.rooms rm join gs.room_types rt on rt.id=rm.type_id
      where rm.active);

  elsif action = 'quote' then
    -- payload: {room_id, checkin, checkout}
    tot:=0; ncnt:=0; arr:='[]'::jsonb;
    for d in select generate_series((payload->>'checkin')::date,(payload->>'checkout')::date - 1, interval '1 day')::date loop
      k:=gs.season_kind(d); dt:=gs.day_type(d);
      select price into p from gs.prices where room_id=payload->>'room_id' and season_kind=k and daytype=dt;
      tot:=tot+coalesce(p,0); ncnt:=ncnt+1;
      arr:=arr||jsonb_build_object('date',d,'season',k,'daytype',dt,'price',coalesce(p,0));
    end loop;
    return jsonb_build_object('nights',ncnt,'total',tot,'detail',arr);

  elsif action = 'availability' then
    -- payload: {from, to}  -> 해당기간 예약(확정/신청)된 (room_id, checkin, checkout)
    return (select coalesce(jsonb_agg(jsonb_build_object('room_id',room_id,'checkin',checkin,'checkout',checkout)),'[]')
      from gs.reservations
      where status<>'cancelled' and checkout > (payload->>'from')::date and checkin < (payload->>'to')::date);

  elsif action = 'reserve' then
    -- payload: {room_id, checkin, checkout, guest_name, guest_phone, guests}
    -- 서버에서 요금 재계산(신뢰) 후 저장
    tot:=0; ncnt:=0;
    for d in select generate_series((payload->>'checkin')::date,(payload->>'checkout')::date -1,interval '1 day')::date loop
      select price into p from gs.prices where room_id=payload->>'room_id'
        and season_kind=gs.season_kind(d) and daytype=gs.day_type(d);
      tot:=tot+coalesce(p,0); ncnt:=ncnt+1;
    end loop;
    -- 중복예약 방지
    if exists(select 1 from gs.reservations where room_id=payload->>'room_id' and status<>'cancelled'
              and checkout>(payload->>'checkin')::date and checkin<(payload->>'checkout')::date) then
      return jsonb_build_object('ok',false,'error','해당 날짜는 이미 예약이 있습니다.');
    end if;
    insert into gs.reservations(room_id,checkin,checkout,nights,guest_name,guest_phone,guests,total_price,agree_privacy,agree_marketing)
      values(payload->>'room_id',(payload->>'checkin')::date,(payload->>'checkout')::date,ncnt,
             payload->>'guest_name',payload->>'guest_phone',(payload->>'guests')::int,tot,
             coalesce((payload->>'agree_privacy')::boolean,false),coalesce((payload->>'agree_marketing')::boolean,false))
      returning id into ncnt;
    return jsonb_build_object('ok',true,'id',ncnt,'total',tot);

  elsif action = 'login' then
    -- payload: {username, password}
    select username into v_user from gs.admins
      where username=payload->>'username' and pass_hash=crypt(payload->>'password',pass_hash);
    if v_user is null then return jsonb_build_object('ok',false,'error','로그인 실패'); end if;
    insert into gs.sessions(username) values(v_user) returning gs.sessions.token into v_token;
    return jsonb_build_object('ok',true,'token',v_token);
  end if;

  -- ===== 관리자 액션 (토큰 필요) =====
  select username into v_user from gs.sessions where sessions.token=api.token and expires_at>now();
  if v_user is null then return jsonb_build_object('ok',false,'error','권한 없음(로그인 필요)'); end if;

  if action = 'admin.reservations' then
    return (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') from gs.reservations x);
  elsif action = 'admin.set_status' then
    update gs.reservations set status=payload->>'status' where id=(payload->>'id')::bigint;
    return jsonb_build_object('ok',true);
  elsif action = 'admin.set_price' then
    insert into gs.prices(room_id,season_kind,daytype,price)
      values(payload->>'room_id',payload->>'season_kind',(payload->>'daytype')::int,(payload->>'price')::int)
      on conflict (room_id,season_kind,daytype) do update set price=excluded.price;
    return jsonb_build_object('ok',true);
  elsif action = 'admin.add_reservation' then
    -- 수기(전화) 예약 등록. 서버에서 요금 재계산, 상태 지정 가능(기본 confirmed)
    tot:=0; ncnt:=0;
    for d in select generate_series((payload->>'checkin')::date,(payload->>'checkout')::date -1,interval '1 day')::date loop
      select price into p from gs.prices where room_id=payload->>'room_id'
        and season_kind=gs.season_kind(d) and daytype=gs.day_type(d);
      tot:=tot+coalesce(p,0); ncnt:=ncnt+1;
    end loop;
    insert into gs.reservations(room_id,checkin,checkout,nights,guest_name,guest_phone,guests,total_price,status,memo,agree_privacy)
      values(payload->>'room_id',(payload->>'checkin')::date,(payload->>'checkout')::date,ncnt,
             payload->>'guest_name',payload->>'guest_phone',(payload->>'guests')::int,tot,
             coalesce(payload->>'status','confirmed'),payload->>'memo',true)
      returning id into ncnt;
    return jsonb_build_object('ok',true,'id',ncnt,'total',tot);
  end if;

  return jsonb_build_object('ok',false,'error','알 수 없는 action: '||action);
end;
$$;

-- api() 만 실행 권한 부여 (테이블 직접권한은 없음)
grant usage on schema gs to anon, authenticated;
grant execute on function gs.api(text,jsonb,text) to anon, authenticated;

-- ⚠️ REST(Data API)는 public 스키마만 노출한다. 프론트의 supabase.rpc('api')가
-- public.api 를 찾으므로, gs.api 로 위임하는 래퍼를 public 에 둔다. (프론트 진입점 = public.api)
create or replace function public.api(action text, payload jsonb default '{}'::jsonb, token text default null)
returns jsonb language sql security definer set search_path=public, gs as $wrap$
  select gs.api(action, payload, token);
$wrap$;
grant execute on function public.api(text,jsonb,text) to anon, authenticated;

-- ============================================================
