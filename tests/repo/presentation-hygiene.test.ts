/**
 * Guards for Presentation Draw (PR 10a: logic and storage, no screens).
 *
 * - The presentation logic is pure: no network, no storage, no clock, no randomness of its own.
 * - Nothing a teacher can see is wired to it yet.
 * - The frozen baseline used by the rollback tests is test-only and has not been edited.
 * - The database version and the Ecology wheel are untouched.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION } from '../../src/data/local/idb-store';
import { BACKUP_FORMAT_VERSION, WORKSPACE_SCHEMA_VERSION } from '../../src/data/local/schema';
import * as baselineIdb from '../compat/baseline-a785855/idb-store';
import * as baselineSchema from '../compat/baseline-a785855/schema';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const read = (file: string) => readFileSync(`${ROOT}/${file}`, 'utf8');
const source = tracked.filter((file) => /^src\/.*\.(ts|tsx)$/.test(file));
const app = source.filter((file) => !/\.test\.tsx?$/.test(file));
const logic = app.filter((file) => file.startsWith('src/presentation/'));
/** Comments are prose. The rules below are about code. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (file: string) => [...code(file).matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map((m) => m[1] ?? m[2] ?? m[3]);

describe('the presentation logic is pure', () => {
  it('has source files to check', () => {
    expect(logic.map((file) => file.replace('src/presentation/', '')).sort()).toEqual([
      'actions.ts',
      'capacity.ts',
      'carry-over.ts',
      'draw.ts',
      'eligibility.ts',
      'public-view.ts',
      'replay.ts',
      'schedule.ts',
      'types.ts',
      'validate.ts',
    ]);
  });

  it('nothing under src/presentation/ can make a network request', () => {
    for (const file of logic) {
      for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\bimport\s*\(/, /\bnavigator\b/, /\bImage\s*\(/]) {
        expect(code(file), `${file} must not use ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('it touches no storage, page, clock or random source: every input is passed in', () => {
    for (const file of logic) {
      for (const forbidden of [/\bindexedDB\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bdocument\./, /\bwindow\./, /\bnew Date\s*\(/, /\bDate\.now\b/, /Math\.random/, /\bcrypto\b/]) {
        expect(code(file), `${file} must not use ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('it imports only its own modules and the existing seeded shuffle', () => {
    for (const file of logic) {
      for (const from of importsOf(file)) {
        expect(from === '../utils/spin-engine' || /^\.\/[a-z-]+$/.test(from), `${file} imports ${from}`).toBe(true);
      }
    }
  });
});

describe('nothing a teacher can see is wired to Presentation Draw yet', () => {
  const reaches = (file: string) => importsOf(file).some((from) => /(^|\/)presentation\//.test(from) || /(^|\/)presentations$/.test(from));

  it('only the local storage layer uses the presentation code', () => {
    const users = app.filter((file) => !file.startsWith('src/presentation/') && reaches(file));
    expect(users.sort()).toEqual(['src/data/local/idb-store.ts', 'src/data/local/presentations.ts', 'src/data/local/schema.ts', 'src/data/local/store.ts']);
  });

  it('no page, component, route or provider imports it', () => {
    const screens = app.filter((file) => /^src\/(pages|components|data\/[^/]+\.tsx?$)/.test(file) || file === 'src/App.tsx' || file === 'src/main.tsx');
    expect(screens.length).toBeGreaterThan(5);
    for (const file of screens) {
      expect(reaches(file), `${file} must not import presentation code in PR 10a`).toBe(false);
      expect(code(file), `${file} must not call the size-checked backup yet`).not.toMatch(/exportBackupChecked|updatePresentation|continuePresentation/);
    }
  });

  it('there is no route for it', () => {
    expect(read('src/App.tsx')).not.toMatch(/present/i);
  });
});

describe('the frozen baseline', () => {
  const FROZEN: Record<string, string> = {
    'csv.ts': '33503ed0656999d50faec9e088aa44c4c0cb78601ab4715aa1f556b4e093f1a9',
    'idb-store.ts': 'ac9b51db6431ffbe4332064c739f24ec281393a84e521113602c79dc808fbc01',
    'schema.ts': '760f1aaba17475d12572c7e46dbad846163056aee48dea3e5a5ce45b3e6ba844',
    'store.ts': 'bcd1b8bf8eeed83cb558b1a6f50378e8266804fbed3a6db4950258eaa8533833',
    'types.ts': '2715a42bc9b756595685b298e3c60909ec91dc41c914b0b41f1c13bdb69c8830',
    'workspaces.ts': '20984476bf76d52655f951feee6084e4c7d05533707b4967132e102203c0a824',
  };

  it('has not been edited since it was copied from the baseline commit', () => {
    const files = tracked.filter((file) => /^tests\/compat\/baseline-a785855\/.*\.ts$/.test(file));
    expect(files.map((file) => file.split('/').pop()).sort()).toEqual(Object.keys(FROZEN));
    for (const file of files) {
      const name = file.split('/').pop() as string;
      expect(createHash('sha256').update(readFileSync(`${ROOT}/${file}`)).digest('hex'), `${file} was changed`).toBe(FROZEN[name]);
    }
  });

  it('is never imported by the app, and the app never imports anything from tests/', () => {
    for (const file of source) {
      const text = read(file);
      expect(text, file).not.toMatch(/baseline-a785855|tests\/compat/);
      expect(importsOf(file).filter((from) => /(^|\/)tests\//.test(from)), file).toEqual([]);
    }
  });

  it('imports nothing outside its own folder', () => {
    for (const name of Object.keys(FROZEN)) {
      for (const from of importsOf(`tests/compat/baseline-a785855/${name}`)) expect(from, name).toMatch(/^\.\/[a-z-]+$/);
    }
  });
});

describe('what this change must not move', () => {
  it('the database name and version are the baseline build\'s, so the older site can open the same database', () => {
    expect(DB_VERSION).toBe(1);
    expect(DB_VERSION).toBe(baselineIdb.DB_VERSION);
    expect(DB_NAME).toBe(baselineIdb.DB_NAME);
  });

  it('a class or backup without presentation data keeps the baseline version numbers', () => {
    expect(WORKSPACE_SCHEMA_VERSION).toBe(baselineSchema.WORKSPACE_SCHEMA_VERSION);
    expect(BACKUP_FORMAT_VERSION).toBe(baselineSchema.BACKUP_FORMAT_VERSION);
  });
});
