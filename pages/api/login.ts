import type { NextApiRequest, NextApiResponse } from 'next';
import { COOKIE_SESION, tokenSesion } from '../../lib/session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  const ok =
    !!process.env.PANEL_PASSWORD &&
    String(b.email ?? '').trim().toLowerCase() === String(process.env.PANEL_EMAIL ?? '').toLowerCase() &&
    String(b.password ?? '') === process.env.PANEL_PASSWORD;

  if (!ok) {
    console.warn('[login] intento fallido para:', String(b.email ?? ''));
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }

  const token = await tokenSesion();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_SESION}=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`
  );
  return res.status(200).json({ ok: true });
}
