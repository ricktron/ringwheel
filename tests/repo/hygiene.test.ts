/**
 * Guards the rule that no credential belongs in public source or in a build.
 *
 * This repository is public. These checks fail the build if a real backend
 * address or a token-like value is committed again.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveApiConfig } from '../../src/api';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const isText = (file: string) => !/\.(png|jpg|jpeg|gif|ico|svg|woff2?|lockb)$/i.test(file) && file !== 'package-lock.json';
const read = (file: string) => readFileSync(`${ROOT}/${file}`, 'utf8');

describe('no credentials in the repository', () => {
  it('.env.example holds placeholders only', () => {
    const env: Record<string, string> = {};
    for (const line of read('.env.example').split('\n')) {
      const match = line.match(/^\s*(VITE_[A-Z_]+)\s*=\s*(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
    // The app itself must recognize both values as placeholders and refuse to use them.
    expect(resolveApiConfig(env).problems).toEqual([
      'The backend URL is still the placeholder from the example file.',
      'The API token is still the placeholder from the example file.',
    ]);
    // No leftover legacy token variable with a value.
    for (const [name, value] of Object.entries(env)) {
      if (/TOKEN/.test(name)) expect(value).toMatch(/your-api-token-here/);
    }
  });

  it('only the example env file is tracked', () => {
    expect(tracked.filter((file) => /(^|\/)\.env(\..*)?$/.test(file))).toEqual(['.env.example']);
  });

  it('no tracked file contains a real Apps Script deployment address', () => {
    const offenders = tracked.filter(isText).filter((file) => /script\.google\.com\/macros\/s\/AKfycb[\w-]{20,}/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('the frontend source has no hard-coded backend address or token fallback', () => {
    const sources = tracked.filter((file) => /^src\/.*\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file));
    for (const file of sources) {
      const text = read(file);
      expect(text, file).not.toMatch(/script\.google\.com\/macros\/s\//);
      // The token may only come from the environment or from browser storage.
      expect(text, file).not.toMatch(/(token|TOKEN)\s*(=|:|\|\|)\s*['"][A-Za-z0-9_-]{8,}['"]/);
    }
  });
});
