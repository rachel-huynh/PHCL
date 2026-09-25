-- =====================================================================
-- 20_pm_notify.sql — QUẢN LÝ DỰ ÁN, GIAI ĐOẠN 4: THÔNG BÁO + CHỮ KÝ ĐÃ LƯU
--
-- Chạy SAU 19_pm_workflow.sql (bản có BỘ HỒ SƠ 26/09/2026 — chạy lại 19 trước
-- nếu đã chạy bản cũ).
--
--   pm_notice     thông báo trong app (chuông ở góc trên): "có chứng từ chờ bạn
--                 duyệt", "chứng từ của bạn đã được duyệt / bị trả về / bị từ
--                 chối / bị huỷ". Sinh tự động từ nhật ký pm_doc_event, nên mọi
--                 đường thay đổi trạng thái đều báo, không sót đường nào.
--   pm_signature  chữ ký mẫu của mỗi người, để lần sau bấm "Dùng chữ ký đã lưu"
--                 thay vì vẽ lại. Mỗi người chỉ thấy và sửa được chữ ký của mình.
--
-- Email là bước sau (cần Edge Function + dịch vụ gửi mail); bảng pm_notice đã
-- đủ thông tin để bước đó chỉ việc đọc ra gửi đi.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_notice (
  id           bigserial primary key,
  user_id      uuid not null references app_user(id) on delete cascade,
  doc_id       bigint references pm_doc(id) on delete cascade,
  kind         text not null check (kind in ('todo', 'approved', 'returned', 'rejected', 'cancelled')),
  doc_no       text,
  doc_type     text,
  project_code text,
  actor_email  text,
  comment      text,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index if not exists pm_notice_user_idx on pm_notice (user_id, read_at, created_at desc);
comment on table pm_notice is
  'Thông báo trong app. Chỉ trigger ghi; người dùng chỉ đọc và đánh dấu đã đọc (read_at) thông báo của mình.';

create table if not exists pm_signature (
  user_id    uuid primary key default auth.uid() references app_user(id) on delete cascade,
  png        text not null check (png like 'data:image/png;base64,%' and length(png) <= 300000),
  updated_at timestamptz not null default now()
);
comment on table pm_signature is
  'Chữ ký mẫu. Khi ký, ảnh được CHÉP vào bước duyệt — đổi chữ ký mẫu sau này không sửa chứng từ đã ký.';


-- Theo quyết định 24/09/2026: TẠM KHÔNG BẮT BUỘC ký (chưa có iPad cho mọi người
-- duyệt). App vẫn mời ký, bấm "Bỏ qua" được. Muốn bắt buộc: sửa value thành
-- true ở Hệ thống → Cài đặt (am_setting). "do nothing": chạy lại file này
-- không ghi đè giá trị đã sửa trong app.
insert into am_setting (key, value, note)
values ('pm_require_signature', 'false'::jsonb,
        'true = bắt buộc ký tay khi gửi duyệt và khi duyệt chứng từ dự án; false = không bắt buộc')
on conflict (key) do nothing;


-- =====================================================================
-- 2. SINH THÔNG BÁO TỪ NHẬT KÝ BỘ HỒ SƠ
-- =====================================================================

-- Thông báo mới (26/09/2026): pkg_id, và kind "next" = bộ trước đã duyệt xong,
-- tới lượt bạn lập chứng từ tiếp theo (vd Thu mua lập QC sau khi bộ PR duyệt).
alter table pm_notice add column if not exists pkg_id bigint references pm_pkg(id) on delete cascade;
alter table pm_notice drop constraint if exists pm_notice_kind_check;
alter table pm_notice add constraint pm_notice_kind_check
  check (kind in ('todo', 'approved', 'returned', 'rejected', 'cancelled', 'next'));

/* Mọi thay đổi trạng thái của một bộ đi qua pm_pkg_event, nên báo từ đây là
   không sót đường nào:
   - bộ đang chờ duyệt: báo "việc cần làm" cho mọi người làm được bước hiện
     tại (kể cả khi Kế toán trưởng / GM JVC trả PA / MC về AM team);
   - kết cục (duyệt xong / trả về người lập / từ chối / huỷ): báo người lập;
   - duyệt xong: báo người lập chứng từ bắt buộc kế tiếp (QC sau bộ PR, PO sau
     bộ QC, AH sau PO) theo chuỗi của pháp nhân. */
create or replace function pm_notify_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg; p pm_project; s pm_pkg_step; v_nos text; v_lead text; v_first bigint; v_next text;
begin
  select * into k from pm_pkg where id = new.pkg_id;
  if k.id is null then return null; end if;
  select * into p from pm_project where code = k.project_code;
  select string_agg(x.doc_no, ' + ' order by t.seq), (array_agg(x.id order by t.seq))[1]
    into v_nos, v_first
    from pm_doc x join pm_doc_type t on t.code = x.doc_type
   where x.pkg_id = k.id and x.status not in ('cancelled');
  v_lead := pm_grp_lead(k.grp);

  -- Việc "chờ duyệt" cũ của bộ này hết đúng rồi: bước đã chuyển, hoặc bộ đã về người lập.
  update pm_notice set read_at = now()
   where pkg_id = k.id and kind = 'todo' and read_at is null;

  if k.status = 'in_review' then
    select * into s from pm_pkg_step where pkg_id = k.id and step = k.current_step;
    insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
    select u.id, v_first, k.id, 'todo', v_nos, v_lead, k.project_code, new.actor_email,
           case when new.action = 'return_am' then new.comment end
    from   app_user u
    where  u.active and (u.id is distinct from k.created_by or pm_self_ok())
      and  app_user_role_covers(u.id, s.role_code, p.dept_code)
      and  exists (select 1 from app_user_role ur
                   join app_permission ap on ap.role_code = ur.role_code
                   where ur.user_id = u.id and ap.module_code = 'approval' and ap.can_approve);
  end if;

  if k.status in ('approved', 'returned', 'rejected', 'cancelled') and new.to_status = k.status
     and k.created_by is not null and k.created_by is distinct from new.actor
     and exists (select 1 from app_user where id = k.created_by) then
    insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
    values (k.created_by, v_first, k.id, k.status, v_nos, v_lead, k.project_code, new.actor_email, new.comment);
  end if;

  if k.status = 'approved' and new.to_status = 'approved' then
    select t.code into v_next from pm_doc_type t
     where t.required and t.side = 'operator'
       and t.seq > (select max(x.seq) from pm_doc_type x where x.code = v_lead or x.grp = k.grp)
     order by t.seq limit 1;
    if v_next is not null then
      insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email)
      select u.id, v_first, k.id, 'next', v_nos, v_next, k.project_code, new.actor_email
      from   app_user u
      join   pm_chain c on c.entity = pm_entity(p.dept_code) and c.doc_type = v_next and c.step = 0
      where  u.active and app_user_role_covers(u.id, c.role_code, p.dept_code);
    end if;
  end if;
  return null;
end $$;

-- Thông báo sinh từ BỘ; nhật ký từng chứng từ (lập, sửa quản trị) không báo gì nữa.
drop trigger if exists pm_notify on pm_doc_event;
drop trigger if exists pm_notify on pm_pkg_event;
create trigger pm_notify after insert on pm_pkg_event
  for each row execute function pm_notify_trg();


-- =====================================================================
-- 3. RLS — mỗi người chỉ thấy đồ của mình
-- =====================================================================

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('pm_notice', 'pm_signature')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table pm_notice    enable row level security;
alter table pm_signature enable row level security;

create policy pm_notice_read on pm_notice
  for select to authenticated using (user_id = (select auth.uid()));
create policy pm_notice_mark on pm_notice
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy pm_signature_own on pm_signature
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on pm_notice, pm_signature from anon;
revoke insert, update, delete on pm_notice from authenticated;
grant select on pm_notice to authenticated;
grant update (read_at) on pm_notice to authenticated;       -- chỉ đánh dấu đã đọc
grant select, insert, update, delete on pm_signature to authenticated;
revoke execute on function pm_notify_trg() from public, anon, authenticated;
-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 4. KIỂM CHỨNG
-- =====================================================================

select 'Bảng thông báo + chữ ký có RLS' as "Mục",
       count(*) filter (where rowsecurity)::text || '/' || count(*)::text as "Thực tế",
       '2/2' as "Mong đợi",
       case when count(*) = 2 and bool_and(rowsecurity) then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_tables where schemaname = 'public' and tablename in ('pm_notice', 'pm_signature')
union all
select 'Trigger sinh thông báo', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_trigger where tgname = 'pm_notify' and not tgisinternal
union all
select 'Gửi duyệt nhận chữ ký', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ Chạy lại 19_pm_workflow.sql trước' end
from   pg_proc where proname = 'pm_doc_submit' and pronargs = 2
union all
select 'Bản gửi duyệt cũ đã bỏ (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ Chạy lại 19_pm_workflow.sql' end
from   pg_proc where proname = 'pm_doc_submit' and pronargs = 1
union all
select 'Bộ hồ sơ (26/09): trigger trên nhật ký bộ', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ Chạy lại 19_pm_workflow.sql trước' end
from   pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'pm_notify' and c.relname = 'pm_pkg_event';
