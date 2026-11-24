import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, describeError, getApiConfig, isApiConfigured, saveBrowserApiConfig, type SheetSnapshot } from '../api';
import { ApiNotConfiguredBanner, ApiStatusIndicator } from '../components/ApiStatusIndicator';
import type { RingSlice, SettingRow, Settings } from '../types';
import { mergeRingWeights, ringWeightsFromRows, validateRingWeights, type RingWeights } from '../utils/rings';
import { DEFAULT_SETTINGS, mergeSettingsRows, parseSettings } from '../utils/settings';
import { saveGuarded } from '../utils/sheet-save';
import { DEFAULT_RING_CONFIG, RING_KEYS, normalizePairCapPct, type RingKey } from '../utils/spin-engine';

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';
type Notice = { text: string; isError: boolean } | null;

const RING_TITLE: Record<RingKey, string> = { region: 'Regions', taxon: 'Taxa', iucn: 'IUCN status' };

const BOOLEAN_SETTINGS: { key: keyof Settings; label: string; hint?: string }[] = [
  { key: 'enableAudio', label: 'Sound effects' },
  { key: 'enableConfetti', label: 'Confetti' },
  { key: 'enablePlantaeMercy', label: 'Plantae Mercy button' },
  {
    key: 'applyRingWeights',
    label: 'Apply ring weights to spins',
    hint: 'Off: every option is equally likely. On: spins follow the weights and active flags in the Rings sheet.',
  },
  {
    key: 'usePairCapSetting',
    label: 'Use the pair cap value below',
    hint: 'Off: spins use the fixed 12% cap the app has always used. On: spins use the value below.',
  },
  { key: 'enableTestHarness', label: 'Show the auto test harness on the spin page' },
];

const EMPTY_SNAPSHOT = { rows: [], base: [] };

export const AdminPage = () => {
  const [loadState, setLoadState] = useState<LoadState>(isApiConfigured() ? 'loading' : 'idle');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  /** True after a save was refused because the sheet changed underneath this page. */
  const [conflict, setConflict] = useState(false);

  // What the sheets held when they were loaded. A save is refused if the sheet
  // no longer matches, so another person's edit is never overwritten.
  const [settingsSnap, setSettingsSnap] = useState<SheetSnapshot<SettingRow>>(EMPTY_SNAPSHOT);
  const [ringsSnap, setRingsSnap] = useState<SheetSnapshot<RingSlice>>(EMPTY_SNAPSHOT);
  const ringRows = ringsSnap.rows;

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [weights, setWeights] = useState<RingWeights>(() => ringWeightsFromRows([]));
  const [adminToken, setAdminToken] = useState('');

  const config = getApiConfig();
  const [connUrl, setConnUrl] = useState(config.url);
  const [connToken, setConnToken] = useState('');

  const load = useCallback(() => {
    if (!isApiConfigured()) {
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    setConflict(false);
    Promise.all([api.readSettings(), api.readRings()])
      .then(([loadedSettings, loadedRings]) => {
        setSettingsSnap(loadedSettings);
        setRingsSnap(loadedRings);
        setSettings(parseSettings(loadedSettings.rows).settings);
        setWeights(ringWeightsFromRows(loadedRings.rows));
        setLoadState('loaded');
      })
      .catch((err) => {
        setLoadError(describeError(err));
        setLoadState('error');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Saving is only allowed on top of data that was actually loaded. Otherwise a
  // failed load followed by a save would overwrite the sheet with defaults.
  const canSave = loadState === 'loaded' && !saving;

  const handleSaveSettings = async () => {
    if (!canSave) return;
    if (!normalizePairCapPct(settings.pairCapPercent).valid) {
      setNotice({ text: 'Not saved. The pair cap must be above 0 and at most 100.', isError: true });
      return;
    }
    if (!(settings.tickerSpeed >= 50 && settings.tickerSpeed <= 500)) {
      setNotice({ text: 'Not saved. The tick speed must be between 50 and 500 ms.', isError: true });
      return;
    }
    setSaving(true);
    setNotice({ text: 'Saving settings…', isError: false });
    try {
      const saved = await saveGuarded({
        sheetName: 'Settings',
        loaded: settingsSnap,
        read: api.readSettings,
        write: api.writeSettings,
        buildRows: (current) => mergeSettingsRows(current, settings),
        identify: (row) => String(row.key ?? ''),
        adminToken: adminToken || undefined,
      });
      setSettingsSnap(saved);
      setNotice({ text: 'Settings saved to the sheet.', isError: false });
    } catch (err) {
      setConflict(err instanceof ApiError && err.kind === 'conflict');
      setNotice({ text: `Settings were NOT saved. ${describeError(err)}`, isError: true });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWeights = async () => {
    if (!canSave) return;
    const problems = validateRingWeights(weights, ringRows);
    if (problems.length > 0) {
      setNotice({ text: `Not saved. ${problems.join(' ')}`, isError: true });
      return;
    }
    setSaving(true);
    setNotice({ text: 'Saving weights…', isError: false });
    try {
      const saved = await saveGuarded({
        sheetName: 'Rings',
        loaded: ringsSnap,
        read: api.readRings,
        write: api.writeRings,
        buildRows: (current) => mergeRingWeights(current, weights),
        identify: (row) => `${String(row.ring_name ?? '')} ${String(row.label ?? '')}`.trim(),
        adminToken: adminToken || undefined,
      });
      setRingsSnap(saved);
      setNotice({ text: 'Weights saved to the sheet.', isError: false });
    } catch (err) {
      setConflict(err instanceof ApiError && err.kind === 'conflict');
      setNotice({ text: `Weights were NOT saved. ${describeError(err)}`, isError: true });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveConnection = () => {
    try {
      // An empty token field keeps the token that is already saved in this browser.
      const tokenToSave = connToken || (config.tokenSource === 'browser' ? config.token : '');
      saveBrowserApiConfig(connUrl, tokenToSave);
      setConnToken('');
      setNotice({ text: 'Connection saved in this browser.', isError: false });
      load();
    } catch (err) {
      setNotice({ text: `Connection was not saved. ${describeError(err)}`, isError: true });
    }
  };

  const handleClearConnection = () => {
    try {
      saveBrowserApiConfig('', '');
      setConnUrl(getApiConfig().url);
      setConnToken('');
      setNotice({ text: 'Connection settings removed from this browser.', isError: false });
      load();
    } catch (err) {
      setNotice({ text: describeError(err), isError: true });
    }
  };

  const setWeight = (ring: RingKey, label: string, value: number) =>
    setWeights((prev) => ({ ...prev, [ring]: { ...prev[ring], [label]: value } }));

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl font-extrabold text-sun">Ringwheel admin</h1>
        <div className="flex items-center gap-4">
          <ApiStatusIndicator key={`${config.url}|${config.tokenSource}`} />
          <Link to="/spin" className="btn btn-primary">
            Back to spinner
          </Link>
        </div>
      </header>

      <ApiNotConfiguredBanner />

      {loadState === 'error' && (
        <div className="rounded-xl border-2 border-bad bg-bad/10 p-4" role="alert" data-testid="admin-load-error">
          <h2 className="text-lg font-bold text-bad">The current settings could not be loaded</h2>
          <p className="mt-1">{loadError}</p>
          <p className="mt-1">Saving is turned off so the sheet is not overwritten with defaults.</p>
          <button type="button" className="btn mt-2" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {notice && (
        <div
          className={`rounded-xl border-2 p-4 font-semibold ${notice.isError ? 'border-bad bg-bad/10 text-bad' : 'border-good bg-good/10 text-good'}`}
          role={notice.isError ? 'alert' : 'status'}
          data-testid="admin-notice"
        >
          {notice.text}
          {conflict && notice.isError && (
            <div className="mt-3">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setNotice(null);
                  load();
                }}
                data-testid="reload-after-conflict"
              >
                Reload current values
              </button>
            </div>
          )}
        </div>
      )}

      <section className="panel" aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="mb-3 text-2xl font-bold">
          Settings
        </h2>
        <div className="space-y-3">
          {BOOLEAN_SETTINGS.map(({ key, label, hint }) => (
            <label key={key} className="flex items-start justify-between gap-4">
              <span>
                <span className="font-semibold">{label}</span>
                {hint && <span className="block text-sm text-ink-dim">{hint}</span>}
              </span>
              <input
                type="checkbox"
                className="mt-1 h-6 w-6"
                checked={settings[key] as boolean}
                onChange={(e) => setSettings((prev) => ({ ...prev, [key]: e.target.checked }))}
              />
            </label>
          ))}

          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="font-semibold">Pair cap (%)</span>
              <span className="block text-sm text-ink-dim">
                A Region and Taxon pair cannot come up again while it makes up this share of the session's spins or more.
              </span>
              {!settings.usePairCapSetting && (
                <span className="block text-sm text-sun" data-testid="pair-cap-inactive">
                  Not in use. Spins use the fixed 12% cap until "Use the pair cap value below" is turned on and saved.
                </span>
              )}
            </span>
            <input
              type="number"
              className="field w-24"
              min={1}
              max={100}
              value={Number.isFinite(settings.pairCapPercent) ? settings.pairCapPercent : ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, pairCapPercent: Number(e.target.value) }))}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span className="font-semibold">Tick speed (ms)</span>
            <input
              type="number"
              className="field w-24"
              min={50}
              max={500}
              value={Number.isFinite(settings.tickerSpeed) ? settings.tickerSpeed : ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, tickerSpeed: Number(e.target.value) }))}
            />
          </label>
        </div>

        <button type="button" className="btn btn-primary mt-5" onClick={handleSaveSettings} disabled={!canSave} data-testid="save-settings">
          Save Settings
        </button>
        <p className="mt-2 text-sm text-ink-dim">Other rows and notes in the Settings sheet are left as they are.</p>
      </section>

      <section className="panel" aria-labelledby="weights-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="weights-heading" className="text-2xl font-bold">
            Ring weights
          </h2>
          <button type="button" className="btn" onClick={() => setWeights(ringWeightsFromRows([]))}>
            Reset to equal
          </button>
        </div>

        {!settings.applyRingWeights && (
          <p className="mb-4 rounded-lg border border-sun bg-sun/10 p-3 text-sm" data-testid="weights-inactive">
            These weights are stored in the sheet but are <strong>not used</strong> right now. Spins treat every option
            as equally likely until "Apply ring weights to spins" is turned on and saved.
          </p>
        )}

        {RING_KEYS.map((ring) => (
          <fieldset key={ring} className="mb-5">
            <legend className="mb-2 text-lg font-semibold text-ember">{RING_TITLE[ring]}</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {DEFAULT_RING_CONFIG[ring].map(({ label }) => (
                <label key={label} className="flex flex-col gap-1 text-sm">
                  <span>
                    {label}
                    {ring === 'taxon' && label === 'Plantae' && <span className="text-ink-dim"> (mercy only)</span>}
                  </span>
                  <input
                    type="number"
                    className="field"
                    min={0}
                    step={0.1}
                    value={Number.isFinite(weights[ring][label]) ? weights[ring][label] : ''}
                    onChange={(e) => setWeight(ring, label, e.target.value === '' ? Number.NaN : Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        <button type="button" className="btn btn-primary" onClick={handleSaveWeights} disabled={!canSave} data-testid="save-weights">
          Save Weights
        </button>
        <p className="mt-2 text-sm text-ink-dim">
          Only the weight column changes. Colors, order, active flags and any other rows in the Rings sheet are kept.
        </p>
      </section>

      <section className="panel" aria-labelledby="connection-heading">
        <h2 id="connection-heading" className="mb-1 text-2xl font-bold">
          Connection
        </h2>
        <p className="mb-3 text-sm text-ink-dim">
          Saved in this browser only. Use this instead of build-time variables on any copy of the site that other people
          can open, because build-time values are readable by everyone who loads the page.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="eyebrow">Backend URL</span>
            <input type="url" className="field" value={connUrl} onChange={(e) => setConnUrl(e.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="eyebrow">API token</span>
            <input
              type="password"
              className="field"
              value={connToken}
              onChange={(e) => setConnToken(e.target.value)}
              placeholder={config.tokenSource === 'none' ? 'Not set' : 'Set (leave blank to keep)'}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="eyebrow">Admin token (only if the backend requires one, never stored)</span>
            <input
              type="password"
              className="field"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
        <p className="mt-3 text-sm" data-testid="token-source">
          {config.tokenSource === 'browser' && 'API token source: saved in this browser.'}
          {config.tokenSource === 'build' && (
            <span className="text-sun">
              API token source: built into the site. Anyone who can open this site can read it.
            </span>
          )}
          {config.tokenSource === 'none' && 'API token source: none.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={handleSaveConnection}>
            Save connection
          </button>
          <button type="button" className="btn" onClick={handleClearConnection}>
            Remove from this browser
          </button>
        </div>
      </section>
    </div>
  );
};
