import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../lib/supabase';

// Switch maestro desde el panel (cookie de sesión vía middleware).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  const marcando = b.marcando === true;

  const { error } = await supabase
    .from('config')
    .update({ marcando, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) return res.status(500).json({ error: error.message });

  console.log(`[panel] marcado ${marcando ? 'ENCENDIDO' : 'APAGADO'} desde el panel`);
  return res.status(200).json({ marcando });
}
