import type { NextApiRequest, NextApiResponse } from 'next';
import { crearLead } from '../../lib/crearLead';

// Entrada de leads desde el panel: protegida por Basic Auth (middleware).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  const { code, body } = await crearLead(b);
  return res.status(code).json(body);
}
