-- Testing Hub: start a new test pass (applied 11 Nov 2026 to the open-brain
-- Supabase project as migration "testing_hub_clear"; kept here for reference).
--
-- One function, so a clear either happens completely or not at all. The page
-- calls it only after asking for the hub password and the word CLEAR, and after
-- saving a full copy (records, log and every file) under archive/ in the
-- testing-hub bucket. Only an allow-listed, signed-in account can run it.
--
-- 'results': tests back to Not run (last result kept as "prev", Invalid stays
--   Invalid), actual/comments/evidence/blocked-by/attachments cleared, parties'
--   recorded risk cleared, defects removed, log kept.
-- 'everything': every record except the project name, and the log.
-- th_log is append-only from the page, which is why this is security definer.

create or replace function public.th_clear(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tests int := 0; v_defects int := 0; v_parties int := 0; v_other int := 0; v_log int := 0;
begin
  if not th_private.is_allowed() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  if p_mode = 'results' then
    update th_records
       set data = data || jsonb_build_object(
             'status', case when data->>'status' = 'Invalid' then 'Invalid' else 'Not run' end,
             'prev', case when coalesce(data->>'status', 'Not run') in ('Not run', 'Invalid') then coalesce(data->>'prev', '–') else data->>'status' end,
             'actual', '', 'comments', '', 'evidence', '',
             'blockedBy', '[]'::jsonb, 'shots', '[]'::jsonb)
     where kind = 'test';
    get diagnostics v_tests = row_count;
    update th_records set data = data || jsonb_build_object('recorded', '') where kind = 'party';
    get diagnostics v_parties = row_count;
    delete from th_records where kind = 'defect';
    get diagnostics v_defects = row_count;
    insert into th_log (at, text, by)
      values (now(), 'New test pass started: results reset, defects removed (the previous pass is in the archive).', coalesce(auth.jwt() ->> 'email', 'hub'));

  elsif p_mode = 'everything' then
    select count(*) filter (where kind = 'test'), count(*) filter (where kind = 'defect'), count(*) filter (where kind = 'party'),
           count(*) filter (where kind not in ('test', 'defect', 'party', 'meta') or (kind = 'meta' and rid <> 'project'))
      into v_tests, v_defects, v_parties, v_other
      from th_records;
    delete from th_records where not (kind = 'meta' and rid = 'project');
    delete from th_log;
    get diagnostics v_log = row_count;
    insert into th_log (at, text, by)
      values (now(), 'Hub emptied for a new project (the previous contents are in the archive).', coalesce(auth.jwt() ->> 'email', 'hub'));

  else
    raise exception 'Unknown mode: %', p_mode using errcode = '22023';
  end if;

  return jsonb_build_object('mode', p_mode, 'tests', v_tests, 'defects', v_defects, 'parties', v_parties, 'other', v_other, 'log', v_log);
end;
$$;

revoke all on function public.th_clear(text) from public, anon;
grant execute on function public.th_clear(text) to authenticated;
