import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';

function parseMaybeJson(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return {};
}

// Post-call webhook de Dapta: llega el resultado de cada llamada con las
// dynamic_variables (lead_id / intento_id) y el call_analysis.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (process.env.WEBHOOK_TOKEN && req.query.token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  const bodyStr = JSON.stringify(b);
  console.log('[postcall] payload recibido:', bodyStr.length > 4000 ? bodyStr.slice(0, 4000) + '…(truncado)' : bodyStr);
  const call = b.call ?? b.data ?? b;

  const vars = parseMaybeJson(call.dynamic_variables ?? call.llm_dynamic_variables);
  const analysis = parseMaybeJson(call.call_analysis);
  const custom = parseMaybeJson(analysis.custom_analysis_data);

  const reason = String(call.disconnection_reason ?? '');
  const transferido =
    custom.transfer_completed === true ||
    custom.lead_status === 'transferido' ||
    reason === 'call_transfer';
  const buzon = analysis.in_voicemail === true || reason === 'voicemail_reached';
  // contestó un humano pero no se llegó a transferir
  const conectado =
    !transferido && !buzon &&
    (reason === 'user_hangup' || reason === 'agent_hangup' || reason === 'inactivity');
  const resultado = transferido ? 'transferido' : buzon ? 'buzon' : conectado ? 'conectado' : 'no_contesto';
  const callId = call.call_id ?? b.call_id ?? null;

  // Precisión: intento_id si el flow ya lo manda; si no, el último 'enviado' del lead
  let intentoId: string | null = vars.intento_id ?? null;
  const leadId: string | null = vars.lead_id ?? null;

  if (!intentoId && leadId) {
    const { data } = await supabase
      .from('intentos')
      .select('id')
      .eq('lead_id', leadId)
      .eq('status', 'enviado')
      .order('enviado_at', { ascending: false })
      .limit(1);
    intentoId = data?.[0]?.id ?? null;
  }

  if (!intentoId) {
    // 200 igual para que Dapta no reintente; se registra el motivo
    console.warn('[postcall] sin intento_id ni lead_id en las variables — no se registró resultado');
    return res.status(200).json({ ok: false, motivo: 'sin intento_id ni lead_id en las variables' });
  }

  console.log(`[postcall] intento ${intentoId} -> resultado "${resultado}" (call_id ${callId ?? 'n/a'})`);

  const { error } = await supabase.rpc('registrar_resultado', {
    p_intento: intentoId,
    p_resultado: resultado,
    p_call_id: callId ? String(callId) : null,
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, intento_id: intentoId, resultado });
}
