import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../lib/supabase';

// Acciones sobre un lead desde el panel: pausar | reactivar | dnc.
// Protegido por la cookie de sesión (middleware).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});

  const { data, error } = await supabase.rpc('pausar_lead', {
    p_lead: b.lead_id,
    p_accion: b.accion,
  });
  if (error) return res.status(500).json({ error: error.message });

  console.log(`[panel] acción "${b.accion}" sobre lead ${b.lead_id}:`, JSON.stringify(data));
  return res.status(200).json(data);
}
