# Migraciones de Supabase — DialBrain

Registro de qué SQL ya se ejecutó en Supabase (SQL Editor) y cuál falta.

**Reglas:**
- Cada cambio de base de datos = **archivo NUEVO** numerado (`008_...sql`, `009_...sql`, ...). Nunca se edita ni se re-ejecuta un SQL ya aplicado.
- Claude crea la migración y la anota aquí como `⏳ pendiente`.
- Antony la corre en el SQL Editor y cambia el estado a `✅ ejecutado`.

| # | Archivo | Qué hace | Estado |
|---|---------|----------|--------|
| 001 | `001_dialbrain.sql` | Tablas base (leads, numeros_salida, intentos, us_state_tz, config de estados→timezone), cadencia 15/7d con hora ancla, despacho con local presence, registrar_resultado, vista metricas_intentos, RLS | ✅ ejecutado |
| 002 | `002_llamada_inmediata.sql` | Intento 1 vence al instante del insert; `despachar_llamadas` acepta `p_lead` para la llamada inmediata desde /api/leads | ✅ ejecutado |
| 003 | `003_clamp_con_jitter.sql` | Fix: el recorte a la ventana 9am–8pm ya no cae en horas exactas (9:00:00) — recorte aleatorio; repara los intentos ya programados en punto | ✅ ejecutado |
| 004 | `004_intento1_siempre_inmediato.sql` | El intento 1 SIEMPRE es inmediato, sin importar la hora; la ventana legal aplica del intento 2 en adelante | ✅ ejecutado |
| 005 | `005_status_conectado_convertido.sql` | Status conectado/transferido/convertido con ranking anti-retroceso; despacho incluye 'conectado'; RPC `actualizar_status_lead(telefono, status)` para n8n/app interna | ✅ ejecutado |
| 006 | `006_switch_marcado.sql` | Tabla `config` con el switch maestro `marcando`; el despachador no marca nada cuando está apagado | ✅ ejecutado |
| 007 | `007_pausa_por_lead.sql` | Columna `leads.pausado` + RPC `pausar_lead(lead_id, accion)` (pausar / reactivar / dnc); el despachador salta pausados | ✅ ejecutado |
