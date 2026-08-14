import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../../lib/supabase';

function parseMaybeJson(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return {};
}

// Post-call webhook de Dapta: llega el resultado de cada llamada con las
// dynamic_variables (lead_id / intento_id) y el call_analysis.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  // lead_status del análisis de Dapta (enum del agente), plano o anidado
  const leadStatus = String(b.lead_status ?? custom.lead_status ?? '');
  const mapeado: string | null =
    leadStatus === 'transferido' ? 'transferido'
    : leadStatus === 'buzon' ? 'buzon'
    : leadStatus === 'no_contesto' ? 'no_contesto'
    : leadStatus === 'colgo_antes_de_transferir' ? 'conectado'
    : leadStatus === 'error_transferencia' ? 'conectado'  // contestó, el transfer falló
    : null;

  const reason = String(call.disconnection_reason ?? '');
  let resultado: string;
  if (custom.transfer_completed === true || reason === 'call_transfer') resultado = 'transferido';
  else if (mapeado) resultado = mapeado;
  else if (analysis.in_voicemail === true || reason === 'voicemail_reached') resultado = 'buzon';
  else if (reason === 'user_hangup' || reason === 'agent_hangup' || reason === 'inactivity') resultado = 'conectado';
  else resultado = 'no_contesto';

  const callId = call.call_id ?? b.call_id ?? null;

  // Precisión: intento_id si viene; si no, el último 'enviado' del lead.
  // Acepta formato plano (b.lead_id) o anidado en dynamic_variables.
  let intentoId: string | null = b.intento_id ?? vars.intento_id ?? null;
  const leadId: string | null = b.lead_id ?? vars.lead_id ?? null;

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

  // Último fallback: matchear por el teléfono del lead (to_number)
  if (!intentoId) {
    const digits = String(b.to_number ?? call.to_number ?? '').replace(/\D/g, '');
    if (digits.length >= 9) {
      const { data: leads } = await supabase
        .from('leads')
        .select('id')
        .like('telefono', `%${digits.slice(-9)}`)
        .order('created_at', { ascending: false })
        .limit(1);
      if (leads?.[0]?.id) {
        const { data } = await supabase
          .from('intentos')
          .select('id')
          .eq('lead_id', leads[0].id)
          .eq('status', 'enviado')
          .order('enviado_at', { ascending: false })
          .limit(1);
        intentoId = data?.[0]?.id ?? null;
      }
    }
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
