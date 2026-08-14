import Head from 'next/head';
import React, { useCallback, useEffect, useState } from 'react';

type Intento = {
  numero_intento: number;
  status: string;
  programado_para: string | null;
  enviado_at: string | null;
  resultado_at: string | null;
  from_number: string | null;
  dapta_call_id: string | null;
};

type Lead = {
  id: string;
  nombre: string | null;
  telefono: string;
  estado_us: string | null;
  timezone: string | null;
  status: string;
  pausado: boolean;
  fuente: string | null;
  created_at: string;
  intentos: Intento[];
};

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('es-PE', {
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : '—';

const Chip = ({ s }: { s: string }) => (
  <span className={`chip st-${s}`}>{s.replaceAll('_', ' ')}</span>
);

const FORM_VACIO = { nombre: '', telefono: '', estado: '', fuente: '' };

export default function Panel() {
  const [marcando, setMarcando] = useState<boolean | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [errorCarga, setErrorCarga] = useState('');
  const [updated, setUpdated] = useState('');
  const [q, setQ] = useState('');
  const [fs, setFs] = useState('');
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());

  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(FORM_VACIO);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [confirmacion, setConfirmacion] = useState<{
    titulo: string;
    texto: string;
    boton: string;
    peligro?: boolean;
    onOk: () => void;
  } | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch('/api/panel-data', { cache: 'no-store' });
      if (r.status === 401) { window.location.href = '/login'; return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setMarcando(d.marcando);
      setLeads(d.leads ?? []);
      setErrorCarga('');
      setUpdated(new Date().toLocaleTimeString('es-PE'));
    } catch (e: any) {
      setErrorCarga(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  const toggle = (id: string) =>
    setAbiertos((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  async function accionLead(lead: Lead, accion: 'pausar' | 'reactivar' | 'dnc') {
    const r = await fetch('/api/panel-lead-accion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: lead.id, accion }),
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) {
      setAviso({ ok: false, texto: d.error ?? `HTTP ${r.status}` });
    } else if (accion === 'reactivar') {
      setAviso({
        ok: true,
        texto: d.nota
          ? `Reactivado, pero ${d.nota}`
          : `Lead reactivado${d.intentos_perdidos ? ` (${d.intentos_perdidos} intento(s) vencidos durante la pausa se perdieron)` : ''} — continúa con sus intentos futuros`,
      });
    } else {
      setAviso({ ok: true, texto: accion === 'pausar' ? 'Lead pausado — no se le llamará hasta reactivarlo' : 'Lead marcado como NO LLAMAR (DNC)' });
    }
    cargar();
  }

  async function crearLead(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setAviso(null);
    try {
      const r = await fetch('/api/panel-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setAviso({
        ok: true,
        texto: d.llamada_inmediata
          ? `Lead creado con ${d.intentos_programados} intentos — llamada inmediata disparada 📞`
          : `Lead creado con ${d.intentos_programados} intentos (llamada inmediata NO salió: revisa switch/números)`,
      });
      setForm(FORM_VACIO);
      setModal(false);
      cargar();
    } catch (e: any) {
      setAviso({ ok: false, texto: String(e?.message ?? e) });
    } finally {
      setEnviando(false);
    }
  }

  const filtrados = leads.filter((l) => {
    if (fs && l.status !== fs) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    const digitos = t.replace(/\D/g, '');
    return (
      (l.nombre ?? '').toLowerCase().includes(t) ||
      (digitos !== '' && l.telefono.replace(/\D/g, '').includes(digitos))
    );
  });

  const counts: Record<string, number> = {};
  for (const l of leads) counts[l.status] = (counts[l.status] ?? 0) + 1;

  return (
    <>
      <Head>
        <title>DialBrain — Leads</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <header>
        <h1>📞 DialBrain</h1>
        <button
          className={`switch-chip clickeable ${marcando === false ? 'off' : ''}`}
          title="Switch maestro: prende/apaga TODO el marcado del sistema"
          disabled={marcando === null}
          onClick={() => {
            const nuevo = !(marcando === true);
            setConfirmacion({
              titulo: nuevo ? 'Prender el marcado' : 'Apagar el marcado',
              texto: nuevo
                ? 'El sistema volverá a llamar. Los intentos atrasados salen al ritmo normal, sin estampida.'
                : 'Se pausa TODO el sistema: nadie recibirá llamadas hasta que lo prendas de nuevo.',
              boton: nuevo ? 'Prender' : 'Apagar',
              peligro: !nuevo,
              onOk: async () => {
                await fetch('/api/panel-switch', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ marcando: nuevo }),
                });
                cargar();
              },
            });
          }}
        >
          <span
            className="dot"
            style={{ background: marcando === true ? '#4ade80' : marcando === false ? '#f87171' : '#666' }}
          />
          {marcando === true ? 'Marcado ON' : marcando === false ? 'Marcado OFF' : 'sin config'}
        </button>
        <span className="spacer" />
        <span className="meta">{updated && `Actualizado ${updated}`}</span>
        <button className="btn ghost" onClick={cargar}>Actualizar</button>
        <button className="btn" onClick={() => { setAviso(null); setModal(true); }}>+ Agregar lead</button>
        <button
          className="btn ghost"
          title="Cerrar sesión"
          onClick={async () => {
            await fetch('/api/logout', { method: 'POST' });
            window.location.href = '/login';
          }}
        >
          Salir
        </button>
      </header>

      {aviso && (
        <div className={`aviso ${aviso.ok ? 'ok' : 'err'}`}>
          {aviso.texto}
          <button className="cerrar-aviso" onClick={() => setAviso(null)}>✕</button>
        </div>
      )}

      <div className="controls">
        <input
          placeholder="Buscar por nombre o teléfono…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">Todos los status</option>
          <option value="en_cadencia">En cadencia</option>
          <option value="conectado">Conectado</option>
          <option value="transferido">Transferido</option>
          <option value="convertido">Convertido</option>
          <option value="agotado">Agotado</option>
          <option value="dnc">DNC</option>
        </select>
      </div>

      <div className="stats">
        <span className="stat"><b>{leads.length}</b>leads</span>
        {Object.entries(counts).map(([s, n]) => (
          <span key={s} className="stat"><b>{n}</b>{s.replaceAll('_', ' ')}</span>
        ))}
      </div>

      <div className="wrap">
        <table className="tabla">
          <thead>
            <tr>
              <th></th><th>Lead</th><th>Teléfono</th><th>Estado</th><th>Status</th>
              <th>Fuente</th><th>Entró</th><th>Intentos</th><th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {errorCarga ? (
              <tr><td colSpan={9} className="vacio">Error cargando datos: {errorCarga}</td></tr>
            ) : !filtrados.length ? (
              <tr><td colSpan={9} className="vacio">Sin leads todavía. Usa “Agregar lead” o manda un POST a /api/leads.</td></tr>
            ) : (
              filtrados.map((l) => {
                const ints = l.intentos ?? [];
                const hechos = ints.filter((i) => i.status !== 'pendiente').length;
                const abierto = abiertos.has(l.id);
                return (
                  <React.Fragment key={l.id}>
                    <tr className="lead" onClick={() => toggle(l.id)}>
                      <td className="caret">{abierto ? '▼' : '▶'}</td>
                      <td>{l.nombre || 'Sin nombre'}</td>
                      <td className="tel">{l.telefono}</td>
                      <td className="muted">{l.estado_us ?? '—'}</td>
                      <td>
                        <Chip s={l.status} />
                        {l.pausado && <span className="chip st-pausado">⏸ pausado</span>}
                      </td>
                      <td className="muted">{l.fuente ?? '—'}</td>
                      <td className="muted">{fmt(l.created_at)}</td>
                      <td className="muted">{hechos}/{ints.length}</td>
                      <td className="celda-acciones" onClick={(e) => e.stopPropagation()}>
                        {l.status !== 'dnc' && (
                          <div className="acciones-lead">
                            {l.pausado ? (
                              <button
                                className="btn mini"
                                title="Reactivar: continúa con sus intentos futuros (los vencidos durante la pausa se pierden)"
                                onClick={() => accionLead(l, 'reactivar')}
                              >
                                ▶ Reactivar
                              </button>
                            ) : (
                              <button
                                className="btn mini ghost"
                                title="Pausar: no se le llama hasta que lo reactives"
                                onClick={() => accionLead(l, 'pausar')}
                              >
                                ⏸ Pausar
                              </button>
                            )}
                            <button
                              className="btn mini peligro"
                              title="No llamar más (definitivo, la data se conserva)"
                              onClick={() =>
                                setConfirmacion({
                                  titulo: 'No llamar más',
                                  texto: `¿NO llamar NUNCA MÁS a ${l.nombre || l.telefono}? Es definitivo: la data se conserva, pero no hay vuelta atrás.`,
                                  boton: 'No llamar más',
                                  peligro: true,
                                  onOk: () => accionLead(l, 'dnc'),
                                })
                              }
                            >
                              🚫
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {abierto && (
                      <tr className="sub">
                        <td colSpan={9}>
                          <table className="intentos">
                            <thead>
                              <tr>
                                <th>#</th><th>Programado</th><th>Marcado</th>
                                <th>Desde</th><th>Resultado</th><th>Hora resultado</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ints.map((i) => (
                                <tr key={i.numero_intento}>
                                  <td>{i.numero_intento}</td>
                                  <td className="muted">{fmt(i.programado_para)}</td>
                                  <td>{fmt(i.enviado_at)}</td>
                                  <td className="tel">{i.from_number ?? '—'}</td>
                                  <td><Chip s={i.status} /></td>
                                  <td className="muted">{fmt(i.resultado_at)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="overlay" onClick={() => !enviando && setModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Agregar lead</h2>
            <p className="muted nota">Igual que un POST a /api/leads: se crea la cadencia y la primera llamada sale al instante.</p>
            <form onSubmit={crearLead}>
              <label>
                Teléfono *
                <input
                  required
                  placeholder="7869842048 o 987654321 (Perú)"
                  value={form.telefono}
                  onChange={(e) => setForm({ ...form, telefono: e.target.value })}
                />
              </label>
              <label>
                Nombre
                <input
                  placeholder="Juan Pérez"
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                />
              </label>
              <div className="fila">
                <label>
                  Estado US
                  <input
                    placeholder="FL"
                    maxLength={2}
                    style={{ textTransform: 'uppercase' }}
                    value={form.estado}
                    onChange={(e) => setForm({ ...form, estado: e.target.value.toUpperCase() })}
                  />
                </label>
                <label>
                  Fuente
                  <input
                    placeholder="manual"
                    value={form.fuente}
                    onChange={(e) => setForm({ ...form, fuente: e.target.value })}
                  />
                </label>
              </div>
              {aviso && !aviso.ok && <div className="aviso err chico">{aviso.texto}</div>}
              <div className="acciones">
                <button type="button" className="btn ghost" disabled={enviando} onClick={() => setModal(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn" disabled={enviando}>
                  {enviando ? 'Creando y llamando…' : 'Crear y llamar ahora'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmacion && (
        <div className="overlay" onClick={() => setConfirmacion(null)}>
          <div className="modal chica" onClick={(e) => e.stopPropagation()}>
            <h2>{confirmacion.titulo}</h2>
            <p className="muted nota">{confirmacion.texto}</p>
            <div className="acciones">
              <button className="btn ghost" onClick={() => setConfirmacion(null)}>Cancelar</button>
              <button
                className={`btn ${confirmacion.peligro ? 'peligro' : ''}`}
                onClick={() => {
                  const fn = confirmacion.onOk;
                  setConfirmacion(null);
                  fn();
                }}
              >
                {confirmacion.boton}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        :root {
          --bg: #0b1220; --panel: #111a2e; --border: #1e2a44; --text: #e6ecf7;
          --muted: #8b9bb8; --accent: #4f8cff;
        }
        * { box-sizing: border-box; margin: 0; }
        body { background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; padding: 24px; }
        header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
        h1 { font-size: 20px; font-weight: 700; letter-spacing: .3px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
        .switch-chip { display: flex; align-items: center; font-size: 12px; padding: 4px 12px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); color: var(--muted); }
        .spacer { flex: 1; }
        .meta { color: var(--muted); font-size: 12px; }
        .btn { background: var(--accent); border: 0; color: #fff; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; }
        .btn:hover { opacity: .9; }
        .btn:disabled { opacity: .5; cursor: default; }
        .btn.ghost { background: var(--panel); border: 1px solid var(--border); color: var(--text); }
        .controls { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
        input, select { background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
        .controls input { min-width: 240px; }
        .stats { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
        .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px 14px; font-size: 12px; color: var(--muted); }
        .stat b { color: var(--text); font-size: 15px; margin-right: 5px; }
        .wrap { overflow-x: auto; border-radius: 12px; }
        .tabla { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
        th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--border); }
        td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
        tr.lead { cursor: pointer; }
        tr.lead:hover td { background: #16223b; }
        .chip { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
        .st-en_cadencia { background: #16304f; color: #7db4ff; }
        .st-conectado   { background: #4a3a12; color: #ffce56; }
        .st-transferido { background: #123f2a; color: #4ade80; }
        .st-convertido  { background: #2d1650; color: #c084fc; }
        .st-agotado     { background: #2a3245; color: #9aa8c4; }
        .st-dnc, .st-fallo { background: #451919; color: #f87171; }
        .st-nuevo, .st-pendiente { background: #1d2940; color: #93a6c9; }
        .st-enviado     { background: #16304f; color: #7db4ff; }
        .st-buzon       { background: #33224d; color: #b79df0; }
        .st-no_contesto { background: #2a3245; color: #9aa8c4; }
        .st-cancelado   { background: #202737; color: #6b7896; text-decoration: line-through; }
        .st-pausado     { background: #3d3208; color: #fbbf24; margin-left: 6px; }
        .switch-chip.clickeable { cursor: pointer; }
        .switch-chip.clickeable:hover { border-color: var(--accent); }
        .switch-chip.off { border-color: #7f2a2a; }
        .acciones-lead { display: flex; gap: 6px; }
        .celda-acciones { cursor: default; }
        .btn.mini { padding: 4px 10px; font-size: 12px; white-space: nowrap; }
        .btn.peligro { background: #7f2a2a; }
        .modal.chica { max-width: 380px; }
        .modal.chica h2 { margin-bottom: 8px; }
        .modal.chica .nota { margin-bottom: 20px; font-size: 13px; }
        tr.sub td { background: #0d1626; padding: 8px 14px 16px; }
        table.intentos { width: 100%; border-collapse: collapse; }
        table.intentos th { padding: 6px 10px; font-size: 10px; border-bottom: 1px solid var(--border); }
        table.intentos td { padding: 6px 10px; border-bottom: 1px solid #17223a; font-size: 12.5px; }
        .tel { font-variant-numeric: tabular-nums; }
        .muted { color: var(--muted); }
        .caret { color: var(--muted); font-size: 11px; }
        .vacio { padding: 40px; text-align: center; color: var(--muted); }
        .overlay { position: fixed; inset: 0; background: rgba(4, 8, 18, .72); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 50; }
        .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 24px; width: 100%; max-width: 420px; }
        .modal h2 { font-size: 17px; margin-bottom: 4px; }
        .modal .nota { font-size: 12px; margin-bottom: 16px; }
        .modal label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
        .modal input { display: block; width: 100%; margin-top: 4px; }
        .modal .fila { display: flex; gap: 10px; }
        .modal .fila label { flex: 1; }
        .acciones { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
        .aviso { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; font-size: 13px; }
        .aviso.ok { background: #123f2a; color: #4ade80; }
        .aviso.err { background: #451919; color: #f87171; }
        .aviso.chico { margin: 0 0 12px; }
        .cerrar-aviso { margin-left: auto; background: none; border: 0; color: inherit; cursor: pointer; font-size: 13px; }
      `}</style>
    </>
  );
}

