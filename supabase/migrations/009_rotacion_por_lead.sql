-- ============================================================
-- DialBrain — Migración 009: rotación de números POR LEAD
--
-- Bug: la rotación era global y el local presence dominaba, así
-- que a un lead se le repetía el mismo número en cada intento.
--
-- Regla nueva por intento:
--   1. numero_preferido SOLO aplica al intento 1.
--   2. Primero los números NUNCA usados con este lead
--      (entre ellos gana el de mismo area code > mismo estado).
--   3. Si ya se usaron todos, el que hace MÁS tiempo no se usa
--      con este lead.
--   -> nunca se repite el número del intento anterior, salvo que
--      solo quede uno disponible.
-- ============================================================

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
    select i.id as i_id, i.numero_intento, i.lead_id as l_id,
           l.nombre, l.telefono, l.estado_us, l.numero_preferido
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
    select n.* into v_num
    from numeros_salida n
    left join lateral (
      select count(*) as usados, max(i2.enviado_at) as ultimo_uso
      from intentos i2
      where i2.lead_id = r.l_id
        and i2.from_number = n.telefono
    ) u on true
    where n.activo
      and not n.en_spam
      and (n.llamadas_fecha is distinct from current_date or n.llamadas_hoy < n.tope_diario)
    order by
      -- preferido: SOLO fuerza el intento 1
      (r.numero_intento = 1 and n.telefono is not distinct from r.numero_preferido) desc,
      -- rotación por lead: primero los nunca usados con este lead
      u.usados asc,
      -- local presence como desempate
      (n.area_code = substring(r.telefono from 3 for 3)) desc,
      (n.estado_us is not distinct from r.estado_us) desc,
      -- si todos ya se usaron: el que hace más tiempo no se usa con este lead
      u.ultimo_uso asc nulls first,
      n.last_used_at asc nulls first
    limit 1
    for update of n skip locked;

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
