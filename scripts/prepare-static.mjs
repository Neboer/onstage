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
  writeFileSync(resolve(output, '_headers'), [
    '/static/*',
    '  X-Content-Type-Options: nosniff',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '/favicon.svg',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
  ].join('\n'));
}
