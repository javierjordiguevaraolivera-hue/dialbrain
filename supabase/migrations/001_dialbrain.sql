-- ============================================================
-- DialBrain (Sistema 2.0) — Cerebro del predictive dialer
-- Migración 001: tablas + cadencia + despacho + resultados
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Mapeo estado de EE.UU. -> timezone IANA (tz dominante)
-- ------------------------------------------------------------
create table if not exists us_state_tz (
  estado text primary key,
  tz     text not null
);

insert into us_state_tz (estado, tz) values
('AL','America/Chicago'),   ('AK','America/Anchorage'), ('AZ','America/Phoenix'),
('AR','America/Chicago'),   ('CA','America/Los_Angeles'),('CO','America/Denver'),
('CT','America/New_York'),  ('DE','America/New_York'),  ('DC','America/New_York'),
('FL','America/New_York'),  ('GA','America/New_York'),  ('HI','Pacific/Honolulu'),
('ID','America/Denver'),    ('IL','America/Chicago'),   ('IN','America/New_York'),
('IA','America/Chicago'),   ('KS','America/Chicago'),   ('KY','America/New_York'),
('LA','America/Chicago'),   ('ME','America/New_York'),  ('MD','America/New_York'),
('MA','America/New_York'),  ('MI','America/New_York'),  ('MN','America/Chicago'),
('MS','America/Chicago'),   ('MO','America/Chicago'),   ('MT','America/Denver'),
('NE','America/Chicago'),   ('NV','America/Los_Angeles'),('NH','America/New_York'),
('NJ','America/New_York'),  ('NM','America/Denver'),    ('NY','America/New_York'),
('NC','America/New_York'),  ('ND','America/Chicago'),   ('OH','America/New_York'),
('OK','America/Chicago'),   ('OR','America/Los_Angeles'),('PA','America/New_York'),
('PR','America/Puerto_Rico'),('RI','America/New_York'), ('SC','America/New_York'),
('SD','America/Chicago'),   ('TN','America/Chicago'),   ('TX','America/Chicago'),
('UT','America/Denver'),    ('VT','America/New_York'),  ('VA','America/New_York'),
('WA','America/Los_Angeles'),('WV','America/New_York'), ('WI','America/Chicago'),
('WY','America/Denver')
on conflict (estado) do nothing;

-- ------------------------------------------------------------
-- 2. Leads
-- ------------------------------------------------------------
create table if not exists leads (
  id         uuid primary key default gen_random_uuid(),
  nombre     text,
  telefono   text not null,              -- E.164: +1XXXXXXXXXX
  estado_us  text,                       -- 'FL', 'CA', ...
  timezone   text,                       -- se completa solo desde estado_us
  status     text not null default 'nuevo',
             -- nuevo -> en_cadencia -> contactado | agotado | dnc
  fuente     text,
  created_at timestamptz not null default now()
);

create index if not exists idx_leads_status on leads (status);

-- ------------------------------------------------------------
-- 3. Números de salida (WAVV)
-- ------------------------------------------------------------
create table if not exists numeros_salida (
  id             bigint generated always as identity primary key,
  telefono       text not null unique,   -- E.164: +1XXXXXXXXXX
  area_code      text generated always as (substring(telefono from 3 for 3)) stored,
  estado_us      text,
  activo         boolean not null default true,
  en_spam        boolean not null default false,
  tope_diario    int not null default 100,
  llamadas_hoy   int not null default 0,
  llamadas_fecha date,
  last_used_at   timestamptz
);

-- ------------------------------------------------------------
-- 4. Intentos (la cola precalculada: 15 por lead)
-- ------------------------------------------------------------
create table if not exists intentos (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads (id) on delete cascade,
  numero_intento  int  not null,
  programado_para timestamptz not null,
  status          text not null default 'pendiente',
                  -- pendiente -> enviado -> transferido | buzon | no_contesto | fallo | cancelado
  from_number     text,
  dapta_call_id   text,
  enviado_at      timestamptz,
  resultado_at    timestamptz,
  unique (lead_id, numero_intento)
);

create index if not exists idx_intentos_cola on intentos (status, programado_para);
create index if not exists idx_intentos_lead on intentos (lead_id);

-- ------------------------------------------------------------
-- 5. Defaults del lead: timezone desde el estado
-- ------------------------------------------------------------
create or replace function fn_lead_defaults() returns trigger
language plpgsql as $$
begin
  new.estado_us := nullif(upper(trim(coalesce(new.estado_us, ''))), '');
  if new.timezone is null then
    select tz into new.timezone from us_state_tz where estado = new.estado_us;
    new.timezone := coalesce(new.timezone, 'America/New_York');
  end if;
  return new;
end $$;

drop trigger if exists trg_lead_defaults on leads;
create trigger trg_lead_defaults
  before insert on leads
  for each row execute function fn_lead_defaults();

-- ------------------------------------------------------------
-- 6. Cadencia: al entrar el lead se generan sus 15 intentos
--    (4-3-2-2-2-1-1 en 7 días, decreciente)
--
--    Reglas:
--    - Ventana legal: 9:00am a 8:00pm HORA LOCAL del lead.
--    - Hora ancla = hora local en que se registró (tenía el
--      teléfono en la mano). Cada día (del 2 en adelante) lleva
--      UN intento cerca del ancla (±60 min aleatorios).
--    - El resto de intentos del día caen en posición aleatoria
--      CONTINUA dentro de su franja (nada de horas en punto).
--    - Speed-to-lead: el intento 1 sale 1–3 min después de
--      entrar el lead (si entró dentro de la ventana).
--    - Si entró fuera de ventana, arranca al abrir la ventana
--      siguiente y su ancla es aleatoria.
-- ------------------------------------------------------------
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

    -- el día 1 arranca donde estemos parados; los demás usan la ventana completa
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
        -- speed-to-lead: 1 a 3 minutos después de entrar
        v_ts := new.created_at + make_interval(secs => (60 + random() * 120)::float8);
      elsif v_dia > 1 and v_i = v_ancla_slot then
        -- el intento del día cercano a la hora ancla (±60 min)
        v_hora := greatest(v_ws, least(v_we - 0.05, v_ancla + (random() * 2 - 1)));
        v_ts   := (v_fecha::timestamp + make_interval(secs => (v_hora * 3600)::float8))
                  at time zone v_tz;
      else
        -- posición aleatoria continua dentro de su franja
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

drop trigger if exists trg_plan_cadencia on leads;
create trigger trg_plan_cadencia
  after insert on leads
  for each row execute function fn_plan_cadencia();

-- ------------------------------------------------------------
-- 7. Despacho: toma los intentos vencidos, asigna número de
--    salida (local presence) y los marca 'enviado'.
--    Seguro ante ticks concurrentes (SKIP LOCKED).
-- ------------------------------------------------------------
create or replace function despachar_llamadas(p_limite int default 10)
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

-- ------------------------------------------------------------
-- 8. Resultado de la llamada (lo dispara el post-call de Dapta)
-- ------------------------------------------------------------
create or replace function registrar_resultado(
  p_intento   uuid,
  p_resultado text,              -- transferido | buzon | no_contesto | fallo
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
    -- contacto logrado: se apaga toda la cadencia restante
    update leads set status = 'contactado' where id = v_lead;
    update intentos set status = 'cancelado', resultado_at = now()
    where intentos.lead_id = v_lead and status = 'pendiente';
  elsif not exists (
    select 1 from intentos i
    where i.lead_id = v_lead and i.status in ('pendiente', 'enviado')
  ) then
    update leads set status = 'agotado'
    where id = v_lead and status = 'en_cadencia';
  end if;
end $$;

-- ------------------------------------------------------------
-- 9. Vista de métricas: hora local y estado de cada intento
--    (para "¿a qué hora contestan mejor los de Florida?")
-- ------------------------------------------------------------
create or replace view metricas_intentos as
select
  i.id,
  i.lead_id,
  l.estado_us,
  l.timezone,
  i.numero_intento,
  i.status,
  i.from_number,
  i.programado_para,
  i.enviado_at,
  extract(hour from (i.enviado_at at time zone l.timezone))::int as hora_local,
  extract(isodow from (i.enviado_at at time zone l.timezone))::int as dia_semana
from intentos i
join leads l on l.id = i.lead_id
where i.enviado_at is not null;

-- ------------------------------------------------------------
-- 10. Seguridad: RLS activado sin políticas.
--     Solo el service_role (la API en Vercel) puede leer/escribir.
-- ------------------------------------------------------------
alter table leads          enable row level security;
alter table numeros_salida enable row level security;
alter table intentos       enable row level security;
alter table us_state_tz    enable row level security;
