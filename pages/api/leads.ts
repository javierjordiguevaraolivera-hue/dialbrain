import type { NextApiRequest, NextApiResponse } from 'next';
import { crearLead } from '../../lib/crearLead';

// Entrada de leads vía API (n8n, funnels): protegida con x-api-key.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (req.headers['x-api-key'] !== process.env.LEADS_API_KEY) {
    console.warn('[leads] rechazado 401: x-api-key inválida o ausente');
    return res.status(401).json({ error: 'unauthorized' });
  }
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  const { code, body } = await crearLead(b);
  return res.status(code).json(body);
}
