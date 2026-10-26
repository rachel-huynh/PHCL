-- =====================================================================
-- 46_asset_history_fields.sql — DÒNG ĐỜI TÀI SẢN GHI ĐỦ CÁC TRƯỜNG SỬA ĐƯỢC (user 26/10/2026)
--
-- Bảng tài sản (thanh bên của sổ) nay sửa được tên, dự án, vị trí, số lượng, đơn vị, đơn giá,
-- hãng / model / số seri, nhà cung cấp, hãng sản xuất, số hoá đơn, ngày mua, ngày sử dụng,
-- số tháng khấu hao, ghi chú (assetops.js aoAssetEdit). Nhật ký app_audit đã ghi mọi thay đổi;
-- "Dòng đời tài sản" (am_asset_history) trước chỉ hiện một danh sách cột cố định — nay hiện
-- thêm các trường trên. Phần còn lại của hàm giữ nguyên như 31_asset_ops.sql.
--
-- Chạy SAU 31_asset_ops.sql. Chạy lại nhiều lần vô hại.
-- =====================================================================

create or replace function am_asset_history(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a am_asset; v jsonb;
  -- Các cột hiện trong dòng đời (46): thêm mọi trường sửa được ở bảng tài sản.
  v_keys text[] := array['status_code', 'dept_code', 'location_code', 'asset_code', 'qty', 'unit_price', 'label_printed',
                         'fin_status', 'fin_cost', 'warranty_until', 'name_vi', 'name_en', 'purpose_code', 'unit_code', 'depreciate_months',
                         'spec_brand', 'spec_model', 'serial', 'invoice_no', 'supplier', 'manufacturer', 'purchase_date', 'in_use_date', 'note'];
begin
  perform app_require('assets', 'view');
  select * into a from am_asset where id = p_id;
  if not found then raise exception 'Không có tài sản %.', p_id; end if;
  if not am_in_scope(a.dept_code) then raise exception 'Tài sản nằm ngoài phạm vi của bạn.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(e order by e ->> 'at' desc), '[]'::jsonb) into v from (
    -- Nhật ký thay đổi (app_audit): tạo, và các cột có ý nghĩa với dòng đời.
    select jsonb_build_object('at', au.at, 'kind', case au.op when 'INSERT' then 'created' else 'change' end, 'who', au.email,
             'data', case au.op when 'INSERT' then jsonb_build_object('asset_code', au.new_data ->> 'asset_code', 'dept_code', au.new_data ->> 'dept_code',
                                                                      'location_code', au.new_data ->> 'location_code', 'status_code', au.new_data ->> 'status_code')
                          else (select jsonb_object_agg(k, jsonb_build_object('o', au.old_data -> k, 'n', au.new_data -> k))
                                from jsonb_object_keys(au.new_data) k
                                where k = any (v_keys)) end) e
    from app_audit au where au.tbl = 'am_asset' and au.pk = p_id::text
      and (au.op = 'INSERT' or exists (select 1 from jsonb_object_keys(au.new_data) k
                                       where k = any (v_keys)))
    union all
    select jsonb_build_object('at', s.created_at, 'kind', 'intake', 'data', jsonb_build_object('shipment', s.id, 'project_code', to_jsonb(s) ->> 'project_code',
             'po', to_jsonb(s) ->> 'po_doc_no', 'supplier', to_jsonb(s) ->> 'supplier'))
    from am_shipment s where s.id = a.shipment_id
    union all
    select jsonb_build_object('at', r.created_at, 'kind', 'label',
             'data', jsonb_build_object('no', r.code))
    from am_alr_line l join am_alr r on r.id = l.alr_id where l.asset_id = p_id
    union all
    select jsonb_build_object('at', p.taken_at, 'kind', 'photo', 'who', p.taken_name, 'data', jsonb_build_object('photo_kind', p.kind))
    from am_asset_photo p where p.asset_id = p_id
    union all
    select jsonb_build_object('at', coalesce(t.done_at, t.submitted_at, t.created_at), 'kind', 'transfer', 'who', t.created_name,
             'data', jsonb_build_object('id', t.id, 'no', t.no, 'status', t.status, 'from', t.from_dept, 'to', t.to_dept, 'loc', t.to_location,
                                        'old_code', tl.old_code, 'new_code', tl.new_code, 'qty', tl.qty))
    from am_transfer_line tl join am_transfer t on t.id = tl.transfer_id where (tl.asset_id = p_id or tl.new_asset_id = p_id) and t.status <> 'cancelled'
    union all
    select jsonb_build_object('at', i.created_at, 'kind', 'incident', 'who', i.created_name,
             'data', jsonb_build_object('id', i.id, 'no', i.no, 'type', i.kind, 'status', i.status, 'outcome', i.outcome, 'cost', i.cost, 'text', i.description))
    from am_incident i where i.asset_id = p_id
    union all
    select jsonb_build_object('at', coalesce(cl.at, c.closed_at, c.opened_at), 'kind', 'count', 'who', cl.by_name,
             'data', jsonb_build_object('code', c.code, 'found', cl.found, 'qty', cl.qty_found, 'loc', cl.loc_found, 'cond', cl.cond, 'note', cl.note))
    from am_count_line cl join am_count c on c.id = cl.count_id where cl.asset_id = p_id and c.status <> 'cancelled' and cl.found is not null
    union all
    select jsonb_build_object('at', q.approved_at, 'kind', 'liquidation',
             'data', jsonb_build_object('status', q.status, 'lr', d.doc_no, 'batch', b.code, 'outcome', q.outcome, 'buyer', q.buyer, 'price', q.sale_value))
    from pm_lq_item q left join pm_doc d on d.id = q.lr_doc_id left join pm_lq_batch b on b.id = q.batch_id where q.asset_id = p_id
    union all
    select jsonb_build_object('at', ln.first_seen::date, 'kind', 'accounting',
             'data', jsonb_build_object('line', ln.description, 'cost', ln.cost, 'share', k.share, 'kind_acc', ln.kind, 'status', ln.status))
    from am_acc_link k join am_acc_line ln on ln.id = k.line_id where k.asset_id = p_id
  ) q;
  return jsonb_build_object('asset', to_jsonb(a), 'events', v,
    'incidents', (select coalesce(jsonb_agg(to_jsonb(i) order by i.id desc), '[]'::jsonb) from am_incident i where i.asset_id = p_id),
    'transfers', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'no', t.no, 'status', t.status, 'from', t.from_dept, 'to', t.to_dept) order by t.id desc), '[]'::jsonb)
                  from am_transfer t where exists (select 1 from am_transfer_line tl where tl.transfer_id = t.id and (tl.asset_id = p_id or tl.new_asset_id = p_id))));
end $$;

select app_lock_anon();
