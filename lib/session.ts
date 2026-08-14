// Token de sesión derivado de las credenciales del panel (env vars).
// Usa Web Crypto para funcionar igual en Edge (middleware) y Node (API).
export const COOKIE_SESION = 'dialbrain_session';

export async function tokenSesion(): Promise<string> {
  const data = new TextEncoder().encode(
    `${process.env.PANEL_EMAIL}:${process.env.PANEL_PASSWORD}:dialbrain-v1`
  );
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
