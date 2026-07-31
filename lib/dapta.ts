import { supabase } from './supabase.js';

export type FilaDespacho = {
  intento_id: string;
  lead_id: string;
  lead_nombre: string | null;
  lead_telefono: string;
  lead_estado: string | null;
  from_number: string;
};

// Dispara el webhook del flow "RingFlow - Call" en Dapta para un intento ya
// marcado 'enviado'. Lanza error si Dapta no responde 2xx.
export async function dispararLlamada(f: FilaDespacho): Promise<void> {
  const r = await fetch(process.env.DAPTA_WEBHOOK_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'accept': '*/*',
      'x-api-key': process.env.DAPTA_FLOW_API_KEY!,
    },
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
  console.log(`[dapta] webhook OK -> lead ${f.lead_telefono} desde ${f.from_number} (intento ${f.intento_id})`);

  const body: any = await r.json().catch(() => null);
  const callId = body?.response?.call_id ?? body?.call_id ?? null;
  if (callId) {
    await supabase.from('intentos').update({ dapta_call_id: String(callId) }).eq('id', f.intento_id);
  }
}

export async function marcarFallo(intentoId: string): Promise<void> {
  await supabase
    .from('intentos')
    .update({ status: 'fallo', resultado_at: new Date().toISOString() })
    .eq('id', intentoId);
}
