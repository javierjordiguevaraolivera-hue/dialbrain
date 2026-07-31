-- ============================================================
-- DialBrain — Migración 002: llamada inmediata al entrar el lead
--
-- 1) El intento 1 ya no se programa a +1–3 min: vence en el
--    instante exacto del insert (speed-to-lead real).
-- 2) despachar_llamadas acepta p_lead para despachar ese lead
--    al instante desde /api/leads, sin esperar al cron.
--    (Se hace DROP antes del CREATE porque cambia la firma.)
-- ============================================================

-- 1. Cadencia: intento 1 inmediato
create or replace function fn_plan_cadencia() returns trigger
language plpgsql as $$
declare
  v_tz         text;
  v_local      timestamp;
  v_entrada    numeric;                       -- hora local de entrada (fraccional)
  v_ancla      numeric;
  v_ws         constant numeric := 9;         -- ventana: inicio (9:00am)
  v_we         constant numeric := 20;        -- ventana: fin (8:00pm)
  v_counts     constant int[] := array[4,3,2,2,2,1,1];
  v_base       date;
  v_dia        int;
  v_i          int;
  v_n          int;
  v_num        int := 0;
  v_fecha      date;
  v_ini        numeric;
  v_seg        numeric;
  v_hora       numeric;
  v_ancla_slot int;
  v_ts         timestamptz;
  v_speed      boolean := false;
begin
  v_tz      := coalesce(new.timezone, 'America/New_York');
  v_local   := new.created_at at time zone v_tz;
  v_entrada := extract(hour from v_local)
             + extract(minute from v_local) / 60.0
             + extract(second from v_local) / 3600.0;

  if v_entrada >= v_ws and v_entrada < v_we then
    v_ancla := v_entrada;
  else
    v_ancla := v_ws + random() * (v_we - v_ws);
  end if;

  -- primer día de marcación: hoy si todavía queda ventana útil
  if v_entrada < v_we - 0.5 then
    v_base  := v_local::date;
    v_speed := (v_entrada >= v_ws);
  else
    v_base := v_local::date + 1;
  end if;

  for v_dia in 1..7 loop
    v_n     := v_counts[v_dia];
    v_fecha := v_base + (v_dia - 1);

    if v_dia = 1 and v_base = v_local::date then
      v_ini := greatest(v_ws, v_entrada + 0.05);
    else
      v_ini := v_ws;
    end if;
    v_seg := (v_we - v_ini) / v_n;

    v_ancla_slot := least(v_n, greatest(1, ceil((v_ancla - v_ini) / nullif(v_seg, 0))::int));

    for v_i in 1..v_n loop
      v_num := v_num + 1;

      if v_dia = 1 and v_i = 1 and v_speed then
        -- speed-to-lead: vence YA — /api/leads lo despacha en el mismo request
        v_ts := new.created_at;
      elsif v_dia > 1 and v_i = v_ancla_slot then
        v_hora := greatest(v_ws, least(v_we - 0.05, v_ancla + (random() * 2 - 1)));
        v_ts   := (v_fecha::timestamp + make_interval(secs => (v_hora * 3600)::float8))
                  at time zone v_tz;
      else
        v_hora := v_ini + (v_i - 1) * v_seg + random() * v_seg;
        v_ts   := (v_fecha::timestamp + make_interval(secs => (v_hora * 3600)::float8))
                  at time zone v_tz;
      end if;

      insert into intentos (lead_id, numero_intento, programado_para)
      values (new.id, v_num, v_ts);
    end loop;
  end loop;

  update leads set status = 'en_cadencia' where id = new.id and status = 'nuevo';
  return new;
end $$;

-- 2. Despacho con filtro opcional por lead
drop function if exists despachar_llamadas(int);

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
  -- higiene: intentos 'enviado' sin resultado en 30 min -> fallo
  update intentos i set status = 'fallo', resultado_at = now()
  where i.status = 'enviado' and i.enviado_at < now() - interval '30 minutes';

  -- higiene: leads en cadencia sin intentos vivos -> agotado
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
      and l.status = 'en_cadencia'
      and (p_lead is null or i.lead_id = p_lead)
    order by i.programado_para
    limit p_limite
    for update of i skip locked
  loop
    -- local presence: mismo area code > mismo estado > el menos usado
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
      exit;  -- no hay números disponibles: el intento queda pendiente
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
