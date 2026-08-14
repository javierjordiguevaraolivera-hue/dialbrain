import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../lib/supabase';

// Datos del panel: leads recientes con su registro de intentos.
// Protegido por Basic Auth (middleware).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 500);

  const [{ data: cfg }, { data: leads, error }] = await Promise.all([
    supabase.from('config').select('marcando').eq('id', 1).single(),
    supabase
      .from('leads')
      .select(
        'id, nombre, telefono, estado_us, timezone, status, fuente, created_at, ' +
        'intentos ( numero_intento, status, programado_para, enviado_at, resultado_at, from_number, dapta_call_id )'
      )
      .order('created_at', { ascending: false })
      .order('numero_intento', { referencedTable: 'intentos', ascending: true })
      .limit(limit),
  ]);

  if (error) return res.status(500).json({ error: error.message });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ marcando: cfg?.marcando ?? null, leads: leads ?? [] });
}
