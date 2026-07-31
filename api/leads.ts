import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase.js';

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

  let telefono: string | null = null;
  if (digits.length === 10) telefono = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) telefono = `+${digits}`;
  if (!telefono) {
    console.warn('[leads] rechazado 400: telefono inválido ->', JSON.stringify(b.telefono ?? b.phone ?? null));
    return res.status(400).json({ error: 'telefono inválido (se espera número US de 10 dígitos)' });
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      nombre: b.nombre ?? b.name ?? null,
      telefono,
      estado_us: b.estado ?? b.estado_us ?? b.state ?? null,
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
  return res.status(201).json({ lead_id: data.id, timezone: data.timezone, intentos_programados: count ?? 0 });
}
