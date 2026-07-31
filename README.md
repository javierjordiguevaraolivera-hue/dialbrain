# DialBrain — Predictive Dialer (Sistema 2.0)

Cerebro del predictive dialer: la cadencia y el estado viven en **Supabase**, el pulso corre en **Vercel** (cron cada minuto), y **Dapta** hace la llamada y el transfer al piso de agentes (ecomfycalls).

## Cómo funciona

1. Entra un lead por `POST /api/leads` → se inserta en Supabase y un trigger genera **su plan único de 15 intentos en 7 días** (4-3-2-2-2-1-1, intensidad decreciente):
   - Ventana legal 9:00am–8:00pm **hora local del lead** (timezone derivada del estado US).
   - **Hora ancla** = hora en que se registró (tenía el teléfono en la mano). Cada día lleva un intento cerca del ancla (±60 min aleatorios).
   - El resto cae en posición aleatoria continua dentro de franjas — dos leads jamás comparten horario.
   - **Speed-to-lead**: el intento 1 sale 1–3 minutos después de entrar.
2. El cron de Vercel pega a `GET /api/cron/dispatch` cada minuto → RPC `despachar_llamadas(limite)` toma los intentos vencidos (`SKIP LOCKED`, sin dobles), asigna número de salida con **local presence** (mismo area code > mismo estado > menos usado) y dispara los webhooks a Dapta en paralelo.
3. Dapta llama, avisa el texto y transfiere. Su **post-call webhook** pega a `POST /api/webhooks/dapta-postcall?token=...` con el `lead_id`/`intento_id` en las dynamic_variables → `registrar_resultado`:
   - `transferido` → lead pasa a `contactado`, se cancelan los intentos restantes.
   - `buzon` / `no_contesto` → se anota y la cadencia sigue sola.
   - Sin intentos vivos → lead `agotado`.

## Puesta en marcha

1. **Supabase**: pegar `supabase/migrations/001_dialbrain.sql` en el SQL Editor y ejecutar.
2. **Números WAVV**: insertarlos (empezamos con 5, escala a cientos):
   ```sql
   insert into numeros_salida (telefono, estado_us) values
   ('+17869493155', 'FL'),
   ('+1XXXXXXXXXX', 'TX');
   ```
3. **Vercel**: crear el proyecto desde este repo y cargar las env vars de `.env.example`.
   - ⚠️ El cron `* * * * *` (cada minuto) requiere plan **Pro**. En plan Hobby los crons son 1/día — usar la alternativa pg_cron de abajo (mismo endpoint, gratis).
4. **Dapta** (flow `RingFlow - Call`, id `oKe4c`):
   - Agregar el parámetro `intento_id` al trigger y pasarlo como variable del agente (junto a `lead_id`).
   - Configurar el post-call webhook del agente `RingFlow Outbound` apuntando a `https://TU-APP.vercel.app/api/webhooks/dapta-postcall?token=WEBHOOK_TOKEN`.

## Alternativa al cron de Vercel (gratis, desde Supabase)

Con las extensiones `pg_cron` y `pg_net` activadas (Database → Extensions):

```sql
select cron.schedule(
  'dialbrain-dispatch',
  '* * * * *',
  $$
  select net.http_get(
    url     := 'https://TU-APP.vercel.app/api/cron/dispatch',
    headers := '{"Authorization": "Bearer TU_CRON_SECRET"}'::jsonb
  );
  $$
);
```

pg_cron ≥ 1.5 acepta segundos (`'20 seconds'`) para cuando haya que acelerar el ritmo — junto con subir `DIALS_PER_TICK`, es todo lo que se toca para escalar.

## Probar

```bash
curl -X POST https://TU-APP.vercel.app/api/leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: LEADS_API_KEY" \
  -d '{"nombre": "Antony", "telefono": "7869842048", "estado": "FL", "fuente": "prueba"}'
```

Ver el plan generado:

```sql
select numero_intento, status, programado_para at time zone 'America/New_York' as hora_local_fl
from intentos
where lead_id = 'EL-UUID-DEVUELTO'
order by numero_intento;
```

Métricas ("¿a qué hora contestan mejor los de Florida?"):

```sql
select estado_us, hora_local, count(*) filter (where status = 'transferido') as transferidos, count(*) as intentos
from metricas_intentos
group by 1, 2
order by 1, 2;
```

## Estados

- **leads**: `nuevo` → `en_cadencia` → `contactado` | `agotado` | `dnc`
- **intentos**: `pendiente` → `enviado` → `transferido` | `buzon` | `no_contesto` | `fallo` | `cancelado`
