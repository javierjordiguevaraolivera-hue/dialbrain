import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../lib/supabase';

// Interruptor maestro del marcado.
//   GET  /api/switch          -> estado actual
//   POST /api/switch {"marcando": false} -> apagar (true -> prender)
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers['x-api-key'] !== process.env.LEADS_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('config').select('marcando, updated_at').eq('id', 1).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    const marcando = b.marcando === true || b.marcando === 'true' || b.marcando === 1;
    const { error } = await supabase
      .from('config')
      .update({ marcando, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[switch] marcado ${marcando ? 'ENCENDIDO' : 'APAGADO'}`);
    return res.status(200).json({ marcando });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
