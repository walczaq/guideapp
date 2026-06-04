-- ============================================================================
-- Fieldnote v0.6 — photo attachments in the guides room
--
-- Storage: a public-read bucket `guide-chat` (images only, 6 MB cap). Uploads
-- are NOT open to the anon key — the client gets a one-time signed upload URL
-- from the guide_media_upload edge function, which validates the guide token
-- with the service role. Public read is fine (a guessable URL only leaks the
-- image itself, and the room is low-sensitivity).
--
-- post_guide_chat gains p_media_url (validated to point at our bucket);
-- list_guide_chat returns media_url. Body may be empty when a photo is present.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('guide-chat', 'guide-chat', true, 6291456, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

alter table guide_chat_messages add column if not exists media_url text;

drop function if exists post_guide_chat(text, text, boolean);
create or replace function post_guide_chat(p_guide_token text, p_body text, p_anon boolean default false, p_media_url text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_name text; v_body text; v_id bigint; v_anon boolean; v_media text;
begin
  select g.id, g.name into v_gid, v_name from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  v_body  := btrim(coalesce(p_body, ''));
  v_media := nullif(btrim(coalesce(p_media_url, '')), '');
  if v_media is not null and v_media not like 'https://xgelrfdrdvrlltcsquqh.supabase.co/storage/v1/object/public/guide-chat/%' then
    raise exception 'Invalid media URL' using errcode = '22023';
  end if;
  if v_body = '' and v_media is null then raise exception 'Empty message' using errcode = '22023'; end if;
  v_anon := coalesce(p_anon, false);
  insert into guide_chat_messages (guide_id, guide_name, body, anon, media_url)
    values (v_gid, case when v_anon then 'Anonymous' else v_name end, left(v_body, 1000), v_anon, v_media)
    returning id into v_id;
  return json_build_object('id', v_id);
end; $$;
grant execute on function post_guide_chat(text, text, boolean, text) to anon, authenticated;

drop function if exists list_guide_chat(text, int, bigint);
create or replace function list_guide_chat(p_guide_token text, p_limit int default 100, p_after_id bigint default 0)
returns table (id bigint, guide_name text, body text, media_url text, created_at timestamptz, mine boolean)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if coalesce(p_after_id, 0) > 0 then
    return query
      select m.id, m.guide_name, m.body, m.media_url, m.created_at, (m.guide_id = v_gid) as mine
      from guide_chat_messages m
      where m.id > p_after_id
      order by m.id asc
      limit 500;
  else
    return query
      select m.id, m.guide_name, m.body, m.media_url, m.created_at, (m.guide_id = v_gid) as mine
      from (
        select * from guide_chat_messages
        order by id desc
        limit greatest(1, least(coalesce(p_limit, 100), 500))
      ) m
      order by m.id asc;
  end if;
end; $$;
grant execute on function list_guide_chat(text, int, bigint) to anon, authenticated;
