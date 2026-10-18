import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The shared frontend is authoritative. Public output is generated, never edited. */
export function prepareStatic(root = process.cwd()) {
  const source = resolve(root, 'static');
  const output = resolve(root, 'public');
  const html = readFileSync(resolve(source, 'index.html'), 'utf8');
  if (/preview\/adapter|onstage-preview-mode|__ONSTAGE_PREVIEW__/.test(html)) {
    throw new Error('The hosted service must not contain the browser-local review adapter.');
  }
  if (existsSync(output)) rmSync(output, { recursive: true });
  mkdirSync(output, { recursive: true });
  cpSync(source, resolve(output, 'static'), {
    recursive: true,
    // Only the root route serves HTML, with release cache busting and headers.
    filter: (path) => path !== resolve(source, 'index.html'),
  });
  cpSync(resolve(source, 'onstage-mark.svg'), resolve(output, 'favicon.svg'));
  cpSync(resolve(source, 'sw.js'), resolve(output, 'sw.js'));
  writeFileSync(resolve(output, '_headers'), [
    '/static/*',
    '  X-Content-Type-Options: nosniff',
    '/static/assets/optimized/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/sw.js',
    '  Cache-Control: no-cache',
    '  Service-Worker-Allowed: /',
    ...['app.js', 'theme.js', 'styles.css', 'pwa.js', 'sw.js', 'assets-manifest.json', 'manifest.webmanifest', 'onstage-mark.svg'].flatMap(name => [
      `/static/${name}`, '  Cache-Control: no-cache',
    ]),
    ...['bands', 'characters', 'scenes', 'stickers'].flatMap(name => [
      `/static/assets/${name}/*`, '  Cache-Control: no-cache',
    ]),
    '/static/icons/*',
    '  Cache-Control: no-cache',
    '/favicon.svg',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
  ].join('\n'));
}
