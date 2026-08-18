-- ============================================================
-- DialBrain — Migración 008: número de salida preferido por lead
--
-- leads.numero_preferido (opcional): si está seteado y ese número
-- está activo/sin spam/bajo su tope diario, TODAS las llamadas a
-- ese lead salen desde ahí. Si no está disponible, cae a la
-- rotación normal (local presence). NULL = automático (default).
-- ============================================================

alter table leads add column if not exists numero_preferido text;

create or replace function despachar_llamadas(p_limite int default 10, p_lead uuid default null)
returns table (
  intento_id    uuid,
  lead_id       uuid,
  lead_nombre   text,
  lead_telefono text,
  lead_estado   text,
  from_number   text
)
language plpgsql as $$
declare
  r     record;
  v_num record;
begin
  if not (select c.marcando from config c where c.id = 1) then
    return;
  end if;

  update intentos i set status = 'fallo', resultado_at = now()
  where i.status = 'enviado' and i.enviado_at < now() - interval '30 minutes';

  update leads l set status = 'agotado'
  where l.status = 'en_cadencia'
    and not l.pausado
    and not exists (
      select 1 from intentos i
      where i.lead_id = l.id and i.status in ('pendiente', 'enviado')
    );

  for r in
    select i.id as i_id, i.lead_id as l_id, l.nombre, l.telefono, l.estado_us, l.numero_preferido
    from intentos i
    join leads l on l.id = i.lead_id
    where i.status = 'pendiente'
      and i.programado_para <= now()
      and l.status in ('en_cadencia', 'conectado')
      and not l.pausado
      and (p_lead is null or i.lead_id = p_lead)
    order by i.programado_para
    limit p_limite
    for update of i skip locked
  loop
    -- preferido del lead primero; si no está disponible, local presence
    select * into v_num
    from numeros_salida n
    where n.activo
      and not n.en_spam
      and (n.llamadas_fecha is distinct from current_date or n.llamadas_hoy < n.tope_diario)
    order by
      (n.telefono is not distinct from r.numero_preferido) desc,
      (n.area_code = substring(r.telefono from 3 for 3)) desc,
      (n.estado_us is not distinct from r.estado_us) desc,
      n.last_used_at asc nulls first
    limit 1
    for update skip locked;

    if v_num is null then
      exit;
    end if;

    update numeros_salida set
      llamadas_hoy   = case when llamadas_fecha = current_date then llamadas_hoy + 1 else 1 end,
      llamadas_fecha = current_date,
      last_used_at   = now()
    where id = v_num.id;

    update intentos set
      status      = 'enviado',
      from_number = v_num.telefono,
      enviado_at  = now()
    where id = r.i_id;

    intento_id    := r.i_id;
    lead_id       := r.l_id;
    lead_nombre   := r.nombre;
    lead_telefono := r.telefono;
    lead_estado   := r.estado_us;
    from_number   := v_num.telefono;
    return next;
  end loop;
end $$;
