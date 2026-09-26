-- =====================================================================
-- 36_demo_mode.sql — CHẾ ĐỘ THỬ NGHIỆM (DEMO / ĐÀO TẠO) + GÓP Ý (27/09/2026)
--
-- Chạy SAU 35_vendor_photo_count.sql, trên CẢ project thật và project demo.
-- Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE trên project thật.
--
-- Chế độ thử nghiệm dùng một PROJECT SUPABASE RIÊNG (quyết định kiến trúc
-- 27/09/2026): dữ liệu thật không bao giờ nằm chung, không thể bị xoá nhầm
-- khi "làm mới dữ liệu thử", người dùng thử được bấm mọi nút. App là một;
-- nút ở Công cụ quản trị chuyển trình duyệt sang project demo và ngược lại;
-- link demo (#sbcfg=…, có cờ demo) gửi cho người dùng thử.
--
--   am_setting app_mode   'live' (mặc định) · 'demo' — CHỈ sql/demo/DEMO_SETUP.sql
--                         đặt 'demo', và file đó từ chối chạy trên project thật.
--   am_setting demo_cfg   (project thật) địa chỉ + anon key của project demo, để
--                         quản trị chuyển sang demo và sao chép link demo.
--   app_feedback          góp ý của người dùng (nút 💬 Góp ý): màn hình, loại,
--                         nội dung, phiên bản — quản trị xem / xuất Excel / xử lý.
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================

insert into am_setting (key, value, note) values
  ('app_mode', '"live"'::jsonb, 'Chế độ của project này: live = dữ liệu thật; demo = dữ liệu thử (chỉ DEMO_SETUP.sql đặt)'),
  ('demo_cfg', '{}'::jsonb, 'Project demo: {"url": "https://…supabase.co", "key": "anon key"} — dùng cho nút chuyển sang chế độ thử nghiệm và link demo'),
  ('feedback_button', 'false'::jsonb, 'Hiện nút 💬 Góp ý trên project thật (true) — project demo luôn hiện')
on conflict (key) do nothing;

create table if not exists app_feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid default auth.uid() references app_user(id) on delete set null,
  email       text,
  kind        text not null default 'idea' check (kind in ('bug', 'idea', 'question', 'praise')),
  view        text,                              -- màn hình đang mở
  text        text not null check (length(trim(text)) > 0 and length(text) <= 4000),
  app_version text,
  lang        text,
  status      text not null default 'new' check (status in ('new', 'seen', 'planned', 'done', 'wontfix')),
  reply       text,
  handled_by  text,
  handled_at  timestamptz
);
create index if not exists app_feedback_created_idx on app_feedback (created_at desc);
comment on table app_feedback is 'Góp ý của người dùng (nút 💬 Góp ý). Ai đăng nhập cũng gửi được; người có quyền xem Hệ thống đọc và xử lý.';

alter table app_feedback enable row level security;
revoke all on app_feedback from anon, authenticated;
grant select, insert on app_feedback to authenticated;
grant update (status, reply, handled_by, handled_at) on app_feedback to authenticated;
grant usage, select on sequence app_feedback_id_seq to authenticated;

drop policy if exists app_feedback_add on app_feedback;
create policy app_feedback_add on app_feedback for insert to authenticated
  with check ((select app_is_member()) and user_id = auth.uid());
drop policy if exists app_feedback_read on app_feedback;
create policy app_feedback_read on app_feedback for select to authenticated
  using (user_id = auth.uid() or (select app_can('system', 'view')));
drop policy if exists app_feedback_handle on app_feedback;
create policy app_feedback_handle on app_feedback for update to authenticated
  using ((select app_can('system', 'edit'))) with check ((select app_can('system', 'edit')));

select app_lock_anon();

select 'Cài đặt app_mode / demo_cfg / feedback_button' as "Mục", count(*)::text as "Thực tế", '3' as "Mong đợi", case when count(*) = 3 then '✔' else '✘ HỎNG' end as "Đạt"
from   am_setting where key in ('app_mode', 'demo_cfg', 'feedback_button')
union all
select 'Chế độ của project này', (select value #>> '{}' from am_setting where key = 'app_mode'), 'live (project thật) / demo', '—'
union all
select 'Bảng góp ý có RLS', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_class where relname = 'app_feedback' and relrowsecurity;
