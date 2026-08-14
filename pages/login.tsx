import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      router.push('/panel');
    } catch (err: any) {
      setError(String(err?.message ?? err));
      setEnviando(false);
    }
  }

  return (
    <>
      <Head>
        <title>DialBrain — Entrar</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main>
        <form className="card" onSubmit={entrar}>
          <div className="logo">📞</div>
          <h1>DialBrain</h1>
          <p className="sub">Panel de leads y llamadas</p>

          <label>
            Correo
            <input
              type="email"
              required
              autoFocus
              autoComplete="username"
              placeholder="tu@correo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" disabled={enviando}>
            {enviando ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </main>

      <style jsx global>{`
        :root {
          --bg: #0b1220; --panel: #111a2e; --border: #1e2a44; --text: #e6ecf7;
          --muted: #8b9bb8; --accent: #4f8cff;
        }
        * { box-sizing: border-box; margin: 0; }
        body { background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
        main { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 36px 32px; width: 100%; max-width: 360px; text-align: center; }
        .logo { font-size: 34px; margin-bottom: 6px; }
        h1 { font-size: 22px; letter-spacing: .3px; }
        .sub { color: var(--muted); font-size: 13px; margin: 4px 0 24px; }
        label { display: block; text-align: left; font-size: 12px; color: var(--muted); margin-bottom: 14px; }
        input { display: block; width: 100%; margin-top: 5px; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 9px; font-size: 14px; }
        input:focus { outline: none; border-color: var(--accent); }
        button { width: 100%; background: var(--accent); border: 0; color: #fff; padding: 11px; border-radius: 9px; cursor: pointer; font-weight: 700; font-size: 14px; margin-top: 6px; }
        button:hover { opacity: .92; }
        button:disabled { opacity: .5; cursor: default; }
        .error { background: #451919; color: #f87171; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; margin-bottom: 14px; text-align: left; }
      `}</style>
    </>
  );
}
