import { supabase } from './supabase';
import { dispararLlamada, marcarFallo, type FilaDespacho } from './dapta';

export type ResultadoCrearLead = {
  code: number;
  body: Record<string, unknown>;
};

// Crea el lead (el trigger de Supabase genera la cadencia) y dispara
// la llamada inmediata en el mismo request. Compartido por /api/leads
// (x-api-key) y /api/panel-lead (Basic Auth del panel).
export async function crearLead(input: Record<string, any>): Promise<ResultadoCrearLead> {
  const b = input ?? {};
  console.log('[leads] payload recibido:', JSON.stringify(b));

  const digits = String(b.telefono ?? b.phone ?? '').replace(/\D/g, '');

  // Acepta US (10 dígitos, o 11 con 1) y Perú (celular de 9 dígitos que
  // empieza en 9, o 11 con el 51 delante) — Perú es para testeo.
  let telefono: string | null = null;
  let timezone: string | null = null;
  if (digits.length === 10 && !digits.startsWith('1')) telefono = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) telefono = `+${digits}`;
  else if (digits.length === 9 && digits.startsWith('9')) {
    telefono = `+51${digits}`;
    timezone = 'America/Lima';
  } else if (digits.length === 11 && digits.startsWith('519')) {
    telefono = `+${digits}`;
    timezone = 'America/Lima';
  }
  if (!telefono) {
    console.warn('[leads] rechazado 400: telefono inválido ->', JSON.stringify(b.telefono ?? b.phone ?? null));
    return { code: 400, body: { error: 'telefono inválido (se espera US de 10 dígitos o celular peruano de 9)' } };
  }

  // opcional: forzar el número de salida (si no, rotación automática)
  let numeroPreferido: string | null = null;
  const desdeDigits = String(b.desde ?? b.from_number ?? b.numero_preferido ?? '').replace(/\D/g, '');
  if (desdeDigits.length === 10) numeroPreferido = `+1${desdeDigits}`;
  else if (desdeDigits.length === 11 && desdeDigits.startsWith('1')) numeroPreferido = `+${desdeDigits}`;

  const { data, error } = await supabase
    .from('leads')
    .insert({
      nombre: b.nombre ?? b.name ?? null,
      telefono,
      estado_us: b.estado ?? b.estado_us ?? b.state ?? null,
      timezone, // null para US: el trigger la deriva del estado
      fuente: b.fuente ?? b.source ?? null,
      numero_preferido: numeroPreferido,
    })
    .select('id, timezone, status')
    .single();

  if (error) {
    console.error('[leads] error de Supabase:', error.message);
    return { code: 500, body: { error: error.message } };
  }

  const { count } = await supabase
    .from('intentos')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', data.id);

  console.log(`[leads] lead creado ${data.id} (${telefono}, tz ${data.timezone}) con ${count ?? 0} intentos programados`);

  // Llamada inmediata: el intento 1 vence en el mismo instante del insert,
  // y se despacha aquí mismo — sin esperar al tick del cron.
  let llamadaInmediata = false;
  const { data: filas, error: errDespacho } = await supabase.rpc('despachar_llamadas', {
    p_limite: 1,
    p_lead: data.id,
  });
  if (errDespacho) {
    console.error('[leads] error despachando llamada inmediata:', errDespacho.message);
  } else if (filas?.length) {
    const f: FilaDespacho = filas[0];
    try {
      await dispararLlamada(f);
      llamadaInmediata = true;
      console.log(`[leads] llamada inmediata disparada -> ${f.lead_telefono} desde ${f.from_number}`);
    } catch (e) {
      console.error('[leads] llamada inmediata FALLÓ:', String(e));
      await marcarFallo(f.intento_id);
    }
  } else {
    console.warn('[leads] llamada inmediata no despachada (¿switch apagado o sin números disponibles?)');
  }

  return {
    code: 201,
    body: {
      lead_id: data.id,
      timezone: data.timezone,
      intentos_programados: count ?? 0,
      llamada_inmediata: llamadaInmediata,
    },
  };
}
