import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_SESION, tokenSesion } from './lib/session';

// Protege el panel y sus endpoints con la cookie de sesión (login en /login).
export const config = {
  matcher: ['/panel', '/api/panel-data', '/api/panel-lead', '/api/panel-lead-accion', '/api/panel-switch'],
};

export async function middleware(req: NextRequest) {
  const cookie = req.cookies.get(COOKIE_SESION)?.value;
  if (cookie && process.env.PANEL_PASSWORD && cookie === (await tokenSesion())) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}
