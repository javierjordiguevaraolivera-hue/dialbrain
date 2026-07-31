import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';

// Tick del despachador. Lo dispara el cron de Vercel (o pg_cron) cada minuto.
// Toma los intentos vencidos vía RPC y dispara todos los webhooks a Dapta en paralelo.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limite = parseInt(process.env.DIALS_PER_TICK ?? '1', 10);
  const { data: filas, error } = await supabase.rpc('despachar_llamadas', { p_limite: limite });
  if (error) return res.status(500).json({ error: error.message });
  if (!filas?.length) return res.status(200).json({ despachadas: 0 });

  const resultados = await Promise.allSettled(
    filas.map(async (f: any) => {
      const r = await fetch(process.env.DAPTA_WEBHOOK_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: f.lead_id,
          intento_id: f.intento_id,
          lead_phone: f.lead_telefono,
          lead_name: f.lead_nombre ?? '',
          outbound_number: f.from_number,
          transfer_number: process.env.TRANSFER_NUMBER,
        }),
      });
      if (!r.ok) throw new Error(`Dapta respondió ${r.status}`);

      const body: any = await r.json().catch(() => null);
      const callId = body?.response?.call_id ?? body?.call_id ?? null;
      if (callId) {
        await supabase
          .from('intentos')
          .update({ dapta_call_id: String(callId) })
          .eq('id', f.intento_id);
      }
    })
  );

  await Promise.all(
    resultados.map(async (r, i) => {
      if (r.status === 'rejected') {
        await supabase
          .from('intentos')
          .update({ status: 'fallo', resultado_at: new Date().toISOString() })
          .eq('id', filas[i].intento_id);
      }
    })
  );

  const ok = resultados.filter((r) => r.status === 'fulfilled').length;
  return res.status(200).json({ despachadas: ok, fallidas: filas.length - ok });
}
