/**
 * Guards the rules that keep credentials and student data out of the
 * repository and out of the built site, and that keep Local Mode off the network.
 *
 * This repository is public. These checks fail the build if a rule is broken.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const isText = (file: string) => !/\.(png|jpg|jpeg|gif|ico|svg|woff2?|lockb)$/i.test(file) && file !== 'package-lock.json';
const read = (file: string) => readFileSync(`${ROOT}/${file}`, 'utf8');
const sources = tracked.filter((file) => /^src\/.*\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file));

describe('no credentials in the repository or the build', () => {
  it('no .env file of any kind is tracked', () => {
    expect(tracked.filter((file) => /(^|\/)\.env(\..*)?$/.test(file))).toEqual([]);
  });

  it('no tracked file contains a real Apps Script deployment address', () => {
    const offenders = tracked.filter(isText).filter((file) => /script\.google\.com\/macros\/s\/AKfycb[\w-]{20,}/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('the frontend reads no connection settings from build-time environment variables', () => {
    for (const file of sources) {
      const text = read(file);
      // Any VITE_ reference would be compiled into the site.
      expect(text, file).not.toMatch(/import\.meta\.env\.VITE_/);
      // Passing the whole env object around would compile every VITE_ value into the site.
      expect(text, file).not.toMatch(/import\.meta\.env(?!\.(DEV|PROD|MODE|BASE_URL)\b)/);
      expect(text, file).not.toMatch(/process\.env/);
    }
  });

  it('the frontend source has no hard-coded backend address or token', () => {
    for (const file of sources) {
      const text = read(file);
      expect(text, file).not.toMatch(/script\.google\.com\/macros\/s\//);
      expect(text, file).not.toMatch(/(token|TOKEN)\s*(=|:|\|\|)\s*['"][A-Za-z0-9_-]{8,}['"]/);
    }
  });
});

describe('Local Mode cannot reach a backend', () => {
  const localFiles = sources.filter((file) => file.startsWith('src/data/local/'));

  it('has source files to check', () => {
    expect(localFiles.length).toBeGreaterThanOrEqual(6);
  });

  it('nothing under src/data/local/ can make a network request', () => {
    for (const file of localFiles) {
      const text = read(file);
      for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\bimport\s*\(/]) {
        expect(text, `${file} must not use ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('nothing under src/data/local/ imports the backend client', () => {
    for (const file of localFiles) {
      const imports = [...read(file).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)];
      for (const [, typeOnly, names, from] of imports) {
        if (!/(^|\/)api$/.test(from)) continue;
        if (typeOnly) continue;
        const values = names.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '));
        // Error and comparison helpers are fine. The client itself is not.
        expect(values.filter((n) => !['ApiError', 'sameRows'].includes(n)), file).toEqual([]);
      }
      expect(read(file), file).not.toMatch(/connectedProvider|createApiClient/);
    }
  });

  it('only the connected provider, and nothing else, wires the backend client into the app', () => {
    const users = sources.filter((file) => /import\s+\{[^}]*\bapi\b[^}]*\}\s+from\s+'[^']*\/api'/.test(read(file)) || /createApiClient\(/.test(read(file)));
    expect(users.sort()).toEqual(['src/api.ts', 'src/data/provider.ts']);
  });

  it('pages and components talk to data only through the provider', () => {
    const ui = sources.filter((file) => /^src\/(pages|components)\//.test(file));
    for (const file of ui) {
      const text = read(file);
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/\bapi\.(health|roster|rings|settings|logSpin|getSpins|write|read)/);
    }
  });
});

describe('Vercel configuration', () => {
  const config = JSON.parse(read('vercel.json'));
  const headers: { key: string; value: string }[] = config.headers.find((h: { source: string }) => h.source === '/(.*)').headers;
  const csp = headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';

  it('sends every route to the app so a refresh or a direct link works', () => {
    expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });

  it('holds no secrets, environment values or paid add-ons', () => {
    expect(Object.keys(config).sort()).toEqual(['$schema', 'buildCommand', 'framework', 'headers', 'outputDirectory', 'rewrites']);
    expect(JSON.stringify(config)).not.toMatch(/token|secret|AKfycb/i);
  });

  it('lets the page talk only to Google Apps Script, and not even to its own host', () => {
    const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? '';
    expect(connect).toBe('connect-src https://script.google.com https://script.googleusercontent.com');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sends no referrer, so a class page address is never passed to another site', () => {
    expect(headers.find((h) => h.key === 'Referrer-Policy')?.value).toBe('no-referrer');
  });
});
