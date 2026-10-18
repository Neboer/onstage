import html from '../static/index.html?raw';
import version from '../VERSION?raw';

export const dynamic = 'force-dynamic';

export function GET() {
  // Static preview visitors may have cached the previous script at this origin.
  // Change its URL for each release so the live service uses the matching client.
  const document = html.replace(/(\/static\/(?:app\.js|theme\.js|styles\.css|onstage-mark\.svg))"/g,
    `$1?v=${encodeURIComponent(version.trim())}"`);
  return new Response(document, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    },
  });
}

export function HEAD() {
  const response = GET();
  return new Response(null, { headers: response.headers });
}
