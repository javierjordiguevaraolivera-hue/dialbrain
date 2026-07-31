import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase.js';
import { dispararLlamada, marcarFallo, type FilaDespacho } from '../lib/dapta.js';

// Entrada de leads. Al insertar, el trigger de Supabase genera solo
// el plan de 15 intentos con la cadencia y la hora ancla del lead.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (req.headers['x-api-key'] !== process.env.LEADS_API_KEY) {
    console.warn('[leads] rechazado 401: x-api-key inválida o ausente');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  console.log('[leads] payload recibido:', JSON.stringify(b));

  const digits = String(b.telefono ?? b.phone ?? '').replace(/\D/g, '');

  // Acepta US (10 dígitos, o 11 con 1) y Perú (celular de 9 dígitos que
  // empieza en 9, o 11 con el 51 delante) — Perú es para testeo.
  let telefono: string | null = null;
  let timezone: string | null = null;
  if (digits.length === 10 && !digits.startsWith('1')) telefono = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) telefono = `+${digits}`;
  else if (digits.length === 9 && digits.startsWith('9')) {
    telefono = `+51${digits}`;
    timezone = 'America/Lima';
  } else if (digits.length === 11 && digits.startsWith('519')) {
    telefono = `+${digits}`;
    timezone = 'America/Lima';
  }
  if (!telefono) {
    console.warn('[leads] rechazado 400: telefono inválido ->', JSON.stringify(b.telefono ?? b.phone ?? null));
    return res.status(400).json({ error: 'telefono inválido (se espera US de 10 dígitos o celular peruano de 9)' });
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      nombre: b.nombre ?? b.name ?? null,
      telefono,
      estado_us: b.estado ?? b.estado_us ?? b.state ?? null,
      timezone, // null para US: el trigger la deriva del estado
      fuente: b.fuente ?? b.source ?? null,
    })
    .select('id, timezone, status')
    .single();

  if (error) {
    console.error('[leads] error de Supabase:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const { count } = await supabase
    .from('intentos')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', data.id);

  console.log(`[leads] lead creado ${data.id} (${telefono}, tz ${data.timezone}) con ${count ?? 0} intentos programados`);

  // Llamada inmediata: el intento 1 vence en el mismo instante del insert,
  // y se despacha aquí mismo — sin esperar al tick del cron.
  let llamadaInmediata = false;
  const { data: filas, error: errDespacho } = await supabase.rpc('despachar_llamadas', {
    p_limite: 1,
    p_lead: data.id,
  });
  if (errDespacho) {
    console.error('[leads] error despachando llamada inmediata:', errDespacho.message);
  } else if (filas?.length) {
    const f: FilaDespacho = filas[0];
    try {
      await dispararLlamada(f);
      llamadaInmediata = true;
      console.log(`[leads] llamada inmediata disparada -> ${f.lead_telefono} desde ${f.from_number}`);
    } catch (e) {
      console.error('[leads] llamada inmediata FALLÓ:', String(e));
      await marcarFallo(f.intento_id);
    }
  } else {
    console.warn('[leads] llamada inmediata no despachada (¿sin números disponibles?)');
  }

  return res.status(201).json({
    lead_id: data.id,
    timezone: data.timezone,
    intentos_programados: count ?? 0,
    llamada_inmediata: llamadaInmediata,
  });
}
