-- ============================================================
-- DialBrain — Migración 003: clamp con jitter
--
-- Bug: cuando el intento ancla (±60 min) caía fuera de la
-- ventana, se recortaba a las 9:00:00 o 19:57:00 EXACTAS —
-- horas en punto repetidas = patrón de máquina.
-- Fix: el recorte también es aleatorio (9:00–9:45 / 19:12–19:57).
-- ============================================================

create or replace function fn_plan_cadencia() returns trigger
language plpgsql as $$
declare
  v_tz         text;
  v_local      timestamp;
  v_entrada    numeric;
  v_ancla      numeric;
  v_ws         constant numeric := 9;
  v_we         constant numeric := 20;
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
        -- intento del día cerca del ancla (±60 min), con recorte ALEATORIO
        v_hora := v_ancla + (random() * 2 - 1);
        if v_hora < v_ws then
          v_hora := v_ws + random() * 0.75;            -- 9:00–9:45, nunca en punto
        elsif v_hora > v_we - 0.05 then
          v_hora := v_we - 0.05 - random() * 0.75;     -- 19:12–19:57
        end if;
        v_ts := (v_fecha::timestamp + make_interval(secs => (v_hora * 3600)::float8))
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

-- Arregla los intentos ya programados que quedaron en horas exactas
update intentos i
set programado_para = i.programado_para + make_interval(secs => (random() * 2700)::float8)
from leads l
where l.id = i.lead_id
  and i.status = 'pendiente'
  and extract(minute from (i.programado_para at time zone l.timezone)) = 0
  and extract(second from (i.programado_para at time zone l.timezone)) < 1;
