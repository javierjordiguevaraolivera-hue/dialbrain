import type { NextApiRequest, NextApiResponse } from 'next';
import { COOKIE_SESION } from '../../lib/session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  res.setHeader('Set-Cookie', `${COOKIE_SESION}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  return res.status(200).json({ ok: true });
}
