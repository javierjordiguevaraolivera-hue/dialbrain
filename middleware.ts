import { NextRequest, NextResponse } from 'next/server';

// Basic Auth para el panel y sus endpoints (PANEL_EMAIL / PANEL_PASSWORD).
export const config = {
  matcher: ['/panel', '/api/panel-data', '/api/panel-lead'],
};

export function middleware(req: NextRequest) {
  const h = req.headers.get('authorization') ?? '';
  if (h.startsWith('Basic ')) {
    const decoded = atob(h.slice(6));
    const sep = decoded.indexOf(':');
    const email = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (
      email === process.env.PANEL_EMAIL &&
      pass === process.env.PANEL_PASSWORD &&
      process.env.PANEL_PASSWORD
    ) {
      return NextResponse.next();
    }
  }
  return new NextResponse('Autenticación requerida', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="DialBrain"' },
  });
}
