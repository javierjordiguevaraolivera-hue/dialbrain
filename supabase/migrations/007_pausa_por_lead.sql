-- ============================================================
-- DialBrain — Migración 007: pausa por lead + DNC (soft delete)
--
-- - leads.pausado = true  -> el despachador lo salta; sus intentos
--   quedan 'pendiente' esperando.
-- - Reactivar: los intentos cuya hora pasó durante la pausa se
--   pierden (F); los futuros continúan normal. Si ya no queda
--   ninguno, el lead pasa a 'agotado'.
-- - DNC: status 'dnc' + se cancelan los intentos pendientes.
--   La fila NUNCA se borra; jamás se vuelve a marcar.
-- ============================================================

alter table leads add column if not exists pausado boolean not null default false;

-- 1. Despacho: salta leads pausados
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
    select i.id as i_id, i.lead_id as l_id, l.nombre, l.telefono, l.estado_us
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
    select * into v_num
    from numeros_salida n
    where n.activo
      and not n.en_spam
      and (n.llamadas_fecha is distinct from current_date or n.llamadas_hoy < n.tope_diario)
    order by
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

-- 2. Acciones sobre un lead: pausar | reactivar | dnc
create or replace function pausar_lead(p_lead uuid, p_accion text)
returns json
language plpgsql as $$
declare
  v_lead       leads%rowtype;
  v_cancelados int := 0;
begin
  select * into v_lead from leads where id = p_lead;
  if v_lead.id is null then
    return json_build_object('ok', false, 'error', 'lead no encontrado');
  end if;

  if p_accion = 'pausar' then
    update leads set pausado = true where id = p_lead;
    return json_build_object('ok', true, 'accion', 'pausado');

  elsif p_accion = 'reactivar' then
    if v_lead.status = 'dnc' then
      return json_build_object('ok', false, 'error', 'el lead está en DNC: no se reactiva');
    end if;
    update leads set pausado = false where id = p_lead;
    -- los intentos cuya hora pasó durante la pausa se pierden (F)
    update intentos set status = 'cancelado', resultado_at = now()
    where lead_id = p_lead and status = 'pendiente' and programado_para < now();
    get diagnostics v_cancelados = row_count;

    if v_lead.status = 'en_cadencia' and not exists (
      select 1 from intentos where lead_id = p_lead and status in ('pendiente', 'enviado')
    ) then
      update leads set status = 'agotado' where id = p_lead;
      return json_build_object('ok', true, 'accion', 'reactivado',
        'intentos_perdidos', v_cancelados, 'nota', 'sin intentos restantes: lead agotado');
    end if;
    return json_build_object('ok', true, 'accion', 'reactivado', 'intentos_perdidos', v_cancelados);

  elsif p_accion = 'dnc' then
    -- soft delete: nunca más se marca, la data queda intacta
    update leads set status = 'dnc', pausado = false where id = p_lead;
    update intentos set status = 'cancelado', resultado_at = now()
    where lead_id = p_lead and status = 'pendiente';
    return json_build_object('ok', true, 'accion', 'dnc');
  end if;

  return json_build_object('ok', false, 'error', 'accion inválida (pausar | reactivar | dnc)');
end $$;
