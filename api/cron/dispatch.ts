import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';
import { dispararLlamada, marcarFallo, type FilaDespacho } from '../../lib/dapta.js';

// Tick del despachador. Lo dispara el cron de Vercel (o pg_cron) cada minuto.
// Toma los intentos vencidos vía RPC y dispara todos los webhooks a Dapta en paralelo.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limite = parseInt(process.env.DIALS_PER_TICK ?? '1', 10);
  const { data: filas, error } = await supabase.rpc('despachar_llamadas', { p_limite: limite });
  if (error) {
    console.error('[dispatch] error de Supabase:', error.message);
    return res.status(500).json({ error: error.message });
  }
  if (!filas?.length) return res.status(200).json({ despachadas: 0 });

  console.log(`[dispatch] ${filas.length} intento(s) vencido(s):`, JSON.stringify(
    filas.map((f: FilaDespacho) => ({ intento: f.intento_id, lead: f.lead_telefono, desde: f.from_number }))
  ));

  const resultados = await Promise.allSettled(
    filas.map((f: FilaDespacho) => dispararLlamada(f))
  );

  await Promise.all(
    resultados.map(async (r, i) => {
      if (r.status === 'rejected') {
        console.error(`[dispatch] webhook FALLÓ para intento ${filas[i].intento_id}:`, String(r.reason));
        await marcarFallo(filas[i].intento_id);
      }
    })
  );

  const ok = resultados.filter((r) => r.status === 'fulfilled').length;
  return res.status(200).json({ despachadas: ok, fallidas: filas.length - ok });
}
