-- ============================================================
-- DialBrain — Migración 005: modelo de 3 status + RPC externo
--
-- Status del lead:
--   nuevo -> en_cadencia -> conectado -> transferido -> convertido
--                                     \-> agotado | dnc
--
--   conectado   = contestó pero no se transfirió -> SIGUE en cadencia
--   transferido = llegó al piso de agentes       -> se detiene la cadencia
--   convertido  = pasó el tiempo monetizable     -> se detiene la cadencia
--
-- El ranking evita retrocesos: convertido > transferido > conectado.
-- Fuentes: Dapta post-call (conectado/transferido) y la app interna
-- vía RPC actualizar_status_lead (transferido/convertido por teléfono).
-- ============================================================

-- 1. Migrar el status viejo 'contactado' -> 'transferido'
update leads set status = 'transferido' where status = 'contactado';

-- 2. Despacho: también se marca a los leads 'conectado' (reintentos siguen)
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
  update intentos i set status = 'fallo', resultado_at = now()
  where i.status = 'enviado' and i.enviado_at < now() - interval '30 minutes';

  update leads l set status = 'agotado'
  where l.status = 'en_cadencia'
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

-- 3. Ranking de status (para nunca retroceder)
create or replace function fn_rank_status(p text) returns int
language sql immutable as $$
  select case p
    when 'convertido'  then 4
    when 'transferido' then 3
    when 'conectado'   then 2
    when 'en_cadencia' then 1
    else 0
  end
$$;

-- 4. Resultado por intento (post-call de Dapta), ahora con 'conectado'
create or replace function registrar_resultado(
  p_intento   uuid,
  p_resultado text,              -- transferido | conectado | buzon | no_contesto | fallo
  p_call_id   text default null
) returns void
language plpgsql as $$
declare
  v_lead uuid;
begin
  update intentos set
    status        = p_resultado,
    dapta_call_id = coalesce(p_call_id, dapta_call_id),
    resultado_at  = now()
  where id = p_intento
  returning intentos.lead_id into v_lead;

  if v_lead is null then
    return;
  end if;

  if p_resultado = 'transferido' then
    -- llegó al piso: se apaga la cadencia (sin pisar 'convertido')
    update leads set status = 'transferido'
    where id = v_lead and fn_rank_status(status) < fn_rank_status('transferido') and status <> 'dnc';
    update intentos set status = 'cancelado', resultado_at = now()
    where intentos.lead_id = v_lead and status = 'pendiente';
  elsif p_resultado = 'conectado' then
    -- contestó pero no se transfirió: se anota y la cadencia SIGUE
    update leads set status = 'conectado'
    where id = v_lead and fn_rank_status(status) < fn_rank_status('conectado') and status <> 'dnc';
  elsif not exists (
    select 1 from intentos i
    where i.lead_id = v_lead and i.status in ('pendiente', 'enviado')
  ) then
    update leads set status = 'agotado'
    where id = v_lead and status = 'en_cadencia';
  end if;
end $$;

-- 5. RPC para la app interna / n8n: reporta status por número de teléfono
--    POST /rest/v1/rpc/actualizar_status_lead  {"p_telefono": "...", "p_status": "..."}
create or replace function actualizar_status_lead(p_telefono text, p_status text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_digits text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
  v_status text;
  v_lead   record;
begin
  -- normaliza (acepta inglés/español y typos comunes)
  v_status := case lower(trim(coalesce(p_status, '')))
    when 'connected'   then 'conectado'
    when 'conected'    then 'conectado'
    when 'conectado'   then 'conectado'
    when 'transferred' then 'transferido'
    when 'transfered'  then 'transferido'
    when 'transferido' then 'transferido'
    when 'converted'   then 'convertido'
    when 'convertido'  then 'convertido'
    else null
  end;
  if v_status is null then
    return json_build_object('ok', false, 'error', 'status inválido (usa connected | transferred | converted)');
  end if;
  if length(v_digits) < 9 then
    return json_build_object('ok', false, 'error', 'teléfono inválido');
  end if;

  -- busca el lead más reciente cuyo número termine en los mismos dígitos
  select id, status into v_lead
  from leads
  where right(regexp_replace(telefono, '\D', '', 'g'), 9) = right(v_digits, 9)
    and status <> 'dnc'
  order by created_at desc
  limit 1;

  if v_lead.id is null then
    return json_build_object('ok', false, 'error', 'lead no encontrado para ese teléfono');
  end if;

  -- nunca retrocede (converted no se pisa con transferred, etc.)
  if fn_rank_status(v_status) <= fn_rank_status(v_lead.status) then
    return json_build_object('ok', true, 'lead_id', v_lead.id,
      'status', v_lead.status, 'nota', 'sin cambio: el lead ya tenía un status igual o superior');
  end if;

  update leads set status = v_status where id = v_lead.id;

  -- transferido/convertido detienen la cadencia; conectado la deja seguir
  if v_status in ('transferido', 'convertido') then
    update intentos set status = 'cancelado', resultado_at = now()
    where lead_id = v_lead.id and status = 'pendiente';
  end if;

  return json_build_object('ok', true, 'lead_id', v_lead.id,
    'status_anterior', v_lead.status, 'status_nuevo', v_status);
end $$;

-- solo el service_role puede llamarla
revoke execute on function actualizar_status_lead(text, text) from public, anon, authenticated;
