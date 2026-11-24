import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import confetti from 'canvas-confetti';
import { api, describeError, isApiConfigured } from '../api';
import { ApiNotConfiguredBanner, ApiStatusIndicator } from '../components/ApiStatusIndicator';
import { AutoTestPanel } from '../components/AutoTestPanel';
import { ResultPanel } from '../components/ResultPanel';
import { ResultsPanel } from '../components/ResultsPanel';
import { RingLegend, RingWheel } from '../components/RingWheel';
import { SessionSpins, type SessionSpin } from '../components/SessionSpins';
import { AudioService } from '../services/audio';
import type { IUCN, Region, RingSlice, RosterStudent, Settings, SpinLogRow, SpinQueueItem, Taxon } from '../types';
import { buildRingConfig } from '../utils/rings';
import { buildQueue, periodsForSemester, type QueueOrder, type Semester } from '../utils/roster';
import { DEFAULT_SETTINGS, parseSettings } from '../utils/settings';
import { buildSpinLogPayload } from '../utils/spin-log';
import {
  IUCN_STATUS,
  REGIONS,
  RING_KEYS,
  TAXA,
  createRng,
  emptyPairHistory,
  plantaeMercy,
  randomSeed,
  recordPair,
  spin,
  vetoRespin,
  type RingKey,
  type SpinOutcome,
  type SpinTriple,
} from '../utils/spin-engine';

const SPIN_DURATION_MS = 3000;
const REDUCED_MOTION_DURATION_MS = 400;

const RING_LABEL: Record<RingKey, string> = { region: 'Region', taxon: 'Taxon', iucn: 'IUCN' };

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

const todayIso = (): string => new Date().toISOString().split('T')[0];

export const SpinPage = () => {
  const configured = isApiConfigured();

  // --- Configuration loaded from the backend -------------------------------
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ringRows, setRingRows] = useState<RingSlice[] | null>(null);
  const [configState, setConfigState] = useState<LoadState>(configured ? 'loading' : 'idle');
  const [configError, setConfigError] = useState('');
  const [settingsWarnings, setSettingsWarnings] = useState<string[]>([]);

  const ringSetup = useMemo(
    () => buildRingConfig(ringRows, settings.applyRingWeights),
    [ringRows, settings.applyRingWeights]
  );
  const warnings = [...settingsWarnings, ...ringSetup.warnings];

  // --- Spin state -----------------------------------------------------------
  const [outcome, setOutcome] = useState<SpinOutcome | null>(null);
  const [wheelTarget, setWheelTarget] = useState<SpinTriple | null>(null);
  const [spinId, setSpinId] = useState(0);
  const [spinningRings, setSpinningRings] = useState<RingKey[]>([]);
  const [spinning, setSpinning] = useState(false);
  const [resultStudent, setResultStudent] = useState<string | null>(null);
  const [resultLogId, setResultLogId] = useState<string | null>(null);
  const [spinError, setSpinError] = useState<string | null>(null);
  const [vetoTarget, setVetoTarget] = useState<RingKey | null>(null);
  const [vetoWarning, setVetoWarning] = useState<string | null>(null);
  const [showRegionPicker, setShowRegionPicker] = useState(false);

  /** Region|Taxon counts for this page load. Real, normal spins only. */
  const pairHistory = useRef(emptyPairHistory());
  const timers = useRef<{ tick?: number; done?: number }>({});
  const logCounter = useRef(0);

  // --- Class queue ----------------------------------------------------------
  const [semester, setSemester] = useState<Semester>('S1');
  const [period, setPeriod] = useState('A');
  const [orderMode, setOrderMode] = useState<QueueOrder>('alphabetical');
  const [roster, setRoster] = useState<RosterStudent[] | null>(null);
  const [queue, setQueue] = useState<SpinQueueItem[]>([]);
  const [currentStudent, setCurrentStudent] = useState<SpinQueueItem | null>(null);
  const [queueStatus, setQueueStatus] = useState<{ text: string; isError: boolean } | null>(null);

  // --- Logs -----------------------------------------------------------------
  const [sessionSpins, setSessionSpins] = useState<SessionSpin[]>([]);
  const [loggedRows, setLoggedRows] = useState<SpinLogRow[]>([]);
  const [hiddenTestRows, setHiddenTestRows] = useState(0);
  const [loggedLoading, setLoggedLoading] = useState(false);
  const [loggedError, setLoggedError] = useState<string | null>(null);

  const sessionId = useMemo(() => randomSeed(), []);

  const periodRef = useRef(period);
  periodRef.current = period;

  const fetchLoggedSpins = useCallback(() => {
    if (!isApiConfigured()) return;
    setLoggedLoading(true);
    setLoggedError(null);
    api
      .getSpins({ date: todayIso(), period: periodRef.current || undefined })
      .then((rows) => {
        // Auto-test rows are kept out of the classroom history view.
        setLoggedRows(rows.filter((row) => !row.is_test));
        setHiddenTestRows(rows.filter((row) => row.is_test).length);
      })
      .catch((err) => setLoggedError(`Could not load today's spins. ${describeError(err)}`))
      .finally(() => setLoggedLoading(false));
  }, []);

  const loadConfig = useCallback(() => {
    if (!isApiConfigured()) return;
    setConfigState('loading');
    Promise.all([api.settings(), api.rings()])
      .then(([settingsRows, rings]) => {
        const parsed = parseSettings(settingsRows);
        setSettings(parsed.settings);
        setSettingsWarnings(parsed.warnings);
        setRingRows(rings);
        setConfigState('loaded');
        AudioService.setEnabled(parsed.settings.enableAudio);
      })
      .catch((err) => {
        setConfigError(describeError(err));
        setConfigState('error');
      });
  }, []);

  useEffect(() => {
    loadConfig();
    fetchLoggedSpins();
  }, [loadConfig, fetchLoggedSpins]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      window.clearInterval(pending.tick);
      window.clearTimeout(pending.done);
    };
  }, []);

  // --- Logging --------------------------------------------------------------

  const updateSessionSpin = (id: string, patch: Partial<SessionSpin>) =>
    setSessionSpins((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  /** Send one spin to the backend. The status only becomes "logged" on a confirmed write. */
  const sendLog = useCallback(
    (entry: Pick<SessionSpin, 'id' | 'payload'>) => {
      updateSessionSpin(entry.id, { status: 'pending', error: undefined });
      api
        .logSpin(entry.payload)
        .then((result) => {
          updateSessionSpin(entry.id, {
            status: 'logged',
            error: result.warnings.length > 0 ? result.warnings.join(' ') : undefined,
          });
          fetchLoggedSpins();
        })
        .catch((err) => updateSessionSpin(entry.id, { status: 'failed', error: describeError(err) }));
    },
    [fetchLoggedSpins]
  );

  const recordOutcome = (next: SpinOutcome, student: SpinQueueItem | null) => {
    const payload = buildSpinLogPayload({
      outcome: next,
      timestamp: new Date(),
      sessionId,
      student,
      isTest: false,
    });
    const id = `${sessionId}-${++logCounter.current}`;
    const canLog = isApiConfigured();
    setSessionSpins((prev) => [{ id, payload, status: canLog ? 'pending' : 'local_only' }, ...prev]);
    setResultLogId(id);

    // The student has had their turn whether or not the log write succeeds.
    if (student) {
      setQueue((prev) =>
        prev.map((item) =>
          item.email === student.email && item.period === student.period ? { ...item, hasSpun: true } : item
        )
      );
    }

    if (canLog) sendLog({ id, payload });
  };

  const retryLog = (id: string) => {
    const entry = sessionSpins.find((s) => s.id === id);
    if (entry) sendLog(entry);
  };

  // --- Spinning -------------------------------------------------------------

  const celebrate = (mercy: boolean) => {
    if (!settings.enableConfetti || prefersReducedMotion()) return;
    try {
      confetti({
        particleCount: mercy ? 200 : 100,
        spread: mercy ? 100 : 70,
        origin: { y: 0.6 },
        ...(mercy ? { colors: ['#4CAF50', '#8BC34A', '#CDDC39'] } : {}),
      });
    } catch {
      // Confetti is decoration. A failure here must never interrupt a spin.
    }
  };

  const settle = (next: SpinOutcome, student: SpinQueueItem | null, countsTowardPairCap: boolean) => {
    setOutcome(next);
    setSpinning(false);
    setResultStudent(student ? student.name : null);
    setVetoTarget(null);
    if (countsTowardPairCap) {
      pairHistory.current = recordPair(pairHistory.current, next.region, next.taxon);
    }
    if (next.vetoUsed) AudioService.playVeto();
    else AudioService.playWin();
    celebrate(next.plantaeMercy);
    recordOutcome(next, student);
  };

  const beginSpin = (target: RingKey | null) => {
    if (spinning) return;
    setSpinError(null);
    setVetoWarning(null);

    let next: SpinOutcome;
    try {
      const seed = randomSeed();
      if (target) {
        if (!outcome) {
          setVetoWarning('Spin first. There is no result to veto yet.');
          return;
        }
        next = vetoRespin({ seed, current: outcome, target, config: ringSetup.config });
      } else {
        next = spin({
          seed,
          config: ringSetup.config,
          history: pairHistory.current,
          pairCapPct: settings.pairCapPercent,
        });
      }
    } catch (err) {
      // No legal outcome. Say so; never substitute a made-up result.
      setSpinError(describeError(err));
      return;
    }

    // The result is decided before the animation starts, so the wheel can land on it.
    const student = currentStudent;
    setWheelTarget(next);
    setSpinningRings(target ? [target] : RING_KEYS);
    setSpinId((id) => id + 1);
    setSpinning(true);
    AudioService.playTick();

    const duration = prefersReducedMotion() ? REDUCED_MOTION_DURATION_MS : SPIN_DURATION_MS;
    timers.current.tick = window.setInterval(() => AudioService.playTick(), settings.tickerSpeed);
    timers.current.done = window.setTimeout(() => {
      window.clearInterval(timers.current.tick);
      settle(next, student, target === null);
    }, duration);
  };

  const handleSpinClick = () => beginSpin(vetoTarget);

  const handleVetoClick = () => {
    if (!vetoTarget) {
      setVetoWarning('Select Region, Taxon, or IUCN to veto first.');
      return;
    }
    beginSpin(vetoTarget);
  };

  const applyPlantaeMercy = (region: Region) => {
    setShowRegionPicker(false);
    setSpinError(null);
    try {
      const next = plantaeMercy({ seed: randomSeed(), current: outcome, region, config: ringSetup.config });
      setWheelTarget(next);
      settle(next, currentStudent, false);
    } catch (err) {
      setSpinError(describeError(err));
    }
  };

  /** Put a logged spin back on screen so the teacher can veto one of its rings. */
  const handleRerollFromHistory = (row: SpinLogRow) => {
    const region = REGIONS.find((r) => r === row.result_region);
    const taxon = TAXA.find((t) => t === row.result_taxon);
    const iucn = IUCN_STATUS.find((i) => i === row.result_iucn);
    if (!region || !taxon || !iucn) {
      setSpinError('That logged spin has a value this wheel does not know, so it cannot be re-rolled here.');
      return;
    }
    const primed: SpinOutcome = {
      region: region as Region,
      taxon: taxon as Taxon,
      iucn: iucn as IUCN,
      seed: '',
      flags: [],
      plantaeMercy: row.plantae_mercy,
      vetoUsed: false,
    };
    setSpinError(null);
    setOutcome(primed);
    setWheelTarget(primed);
    setResultLogId(null);
    setResultStudent(row.student_name || null);
    setCurrentStudent(
      row.student_name ? { email: row.email, name: row.student_name, period: row.period, hasSpun: true } : null
    );
    setVetoTarget(null);
    setShowRegionPicker(false);
  };

  // --- Class queue ----------------------------------------------------------

  const handleLoadRoster = async () => {
    if (!isApiConfigured()) {
      setQueueStatus({ text: 'The backend is not configured, so the roster cannot be loaded.', isError: true });
      return;
    }

    let students = roster;
    if (!students) {
      try {
        setQueueStatus({ text: 'Loading roster…', isError: false });
        students = await api.roster();
        setRoster(students);
      } catch (err) {
        setQueueStatus({ text: `Could not load the roster. ${describeError(err)}`, isError: true });
        return;
      }
    }

    const built = buildQueue(students, semester, period, orderMode, createRng(randomSeed()));
    setQueue(built.queue);
    setCurrentStudent(null);
    const duplicateNote =
      built.duplicatesIgnored > 0
        ? ` ${built.duplicatesIgnored} duplicate roster row${built.duplicatesIgnored === 1 ? '' : 's'} ignored.`
        : '';
    setQueueStatus(
      built.queue.length === 0
        ? { text: `No students found for ${semester} period ${period}.`, isError: true }
        : { text: `Loaded ${built.queue.length} students for ${semester} period ${period}.${duplicateNote}`, isError: false }
    );
    fetchLoggedSpins();
  };

  const handleNextSpinner = () => {
    const next = queue.find((item) => !item.hasSpun);
    if (!next) {
      setCurrentStudent(null);
      setQueueStatus({ text: 'All students in this queue have spun.', isError: false });
      return;
    }
    setCurrentStudent(next);
  };

  const periodOptions = roster ? periodsForSemester(roster, semester) : [];
  const currentHasSpun = currentStudent
    ? queue.some((q) => q.email === currentStudent.email && q.period === currentStudent.period && q.hasSpun)
    : false;

  const resultLog = resultLogId ? sessionSpins.find((s) => s.id === resultLogId) : undefined;
  const latestPayload = sessionSpins[0]?.payload;
  const showHarness = import.meta.env.DEV || settings.enableTestHarness;

  const spinLabel = spinning
    ? 'Spinning…'
    : vetoTarget
      ? `Veto: re-spin ${RING_LABEL[vetoTarget]}`
      : 'SPIN';

  return (
    <div className="mx-auto max-w-[1700px] space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-4xl font-extrabold text-sun md:text-5xl">Ringwheel</h1>
          <p className="text-ink-dim">Classroom spinner</p>
        </div>
        <div className="flex items-center gap-4">
          <ApiStatusIndicator />
          <Link to="/admin" className="btn">
            Admin
          </Link>
        </div>
      </header>

      <ApiNotConfiguredBanner />

      {configState === 'error' && (
        <div className="rounded-xl border-2 border-bad bg-bad/10 p-4" role="alert" data-testid="config-error">
          <h2 className="text-lg font-bold text-bad">Settings could not be loaded from the backend</h2>
          <p className="mt-1">{configError}</p>
          <p className="mt-1">
            Spins are using the built-in defaults: every option equally likely and a {DEFAULT_SETTINGS.pairCapPercent}%
            pair cap.
          </p>
          <button type="button" className="btn mt-2" onClick={loadConfig}>
            Try again
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-xl border border-sun bg-sun/10 p-4" role="status" data-testid="config-warnings">
          <h2 className="font-bold text-sun">Check the sheet configuration</h2>
          <ul className="mt-1 list-disc pl-6 text-sm">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(280px,1fr)_minmax(460px,1.5fr)_minmax(300px,1fr)]">
        {/* Left: class queue and session history */}
        <div className="order-3 space-y-5 xl:order-1">
          <section className="panel" aria-labelledby="class-heading">
            <h2 id="class-heading" className="mb-3 text-xl font-bold">
              Class
            </h2>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="eyebrow">Semester</span>
                <select className="field" value={semester} onChange={(e) => setSemester(e.target.value as Semester)}>
                  <option value="S1">S1</option>
                  <option value="S2">S2</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="eyebrow">Period</span>
                {periodOptions.length > 0 ? (
                  <select className="field" value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="period-select">
                    {!periodOptions.includes(period) && <option value={period}>{period}</option>}
                    {periodOptions.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="field w-20"
                    value={period}
                    maxLength={4}
                    onChange={(e) => setPeriod(e.target.value.toUpperCase())}
                  />
                )}
              </label>
              <label className="flex flex-col gap-1">
                <span className="eyebrow">Order</span>
                <select className="field" value={orderMode} onChange={(e) => setOrderMode(e.target.value as QueueOrder)}>
                  <option value="alphabetical">Alphabetical</option>
                  <option value="random">Random</option>
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={handleLoadRoster}>
                Load Roster
              </button>
              <button type="button" className="btn btn-primary" onClick={handleNextSpinner} disabled={queue.length === 0 || spinning}>
                Next Spinner
              </button>
            </div>

            {queueStatus && (
              <p
                className={`mt-3 text-sm ${queueStatus.isError ? 'font-semibold text-bad' : 'text-ink-dim'}`}
                role={queueStatus.isError ? 'alert' : 'status'}
                data-testid="queue-status"
              >
                {queueStatus.text}
              </p>
            )}

            {queue.length > 0 && (
              <ol className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1 text-sm" data-testid="queue">
                {queue.map((item) => {
                  const isCurrent =
                    currentStudent !== null && currentStudent.email === item.email && currentStudent.period === item.period;
                  return (
                    <li
                      key={`${item.email}-${item.period}`}
                      className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 ${isCurrent ? 'bg-sun/20 font-bold' : ''}`}
                      aria-current={isCurrent ? 'true' : undefined}
                    >
                      <span>{item.name}</span>
                      <span className="text-xs text-ink-dim">{item.hasSpun ? 'Spun' : isCurrent ? 'Up now' : 'Waiting'}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <SessionSpins spins={sessionSpins} onRetry={retryLog} />
        </div>

        {/* Center: the wheel */}
        <div className="order-1 space-y-4 xl:order-2">
          <p className="text-center text-2xl font-bold" data-testid="current-student">
            {currentStudent ? (
              <>
                <span className="text-ink-dim">Up now: </span>
                {currentStudent.name}
              </>
            ) : (
              <span className="text-ink-dim">No student selected</span>
            )}
          </p>

          <RingWheel
            config={ringSetup.config}
            result={wheelTarget}
            spinningRings={spinningRings}
            spinId={spinId}
            durationMs={prefersReducedMotion() ? REDUCED_MOTION_DURATION_MS : SPIN_DURATION_MS}
            selectedRing={vetoTarget}
            onSelectRing={spinning ? undefined : (ring) => setVetoTarget((prev) => (prev === ring ? null : ring))}
            settled={!spinning && outcome !== null}
          />
          <RingLegend />

          {ringSetup.weighted && (
            <p className="text-center text-sm font-bold text-sun" data-testid="weighted-notice">
              Weighted spin: the odds follow the Rings sheet, shown by slice size.
            </p>
          )}

          {spinError && (
            <p className="rounded-lg border-2 border-bad bg-bad/10 p-3 text-center font-bold text-bad" role="alert" data-testid="spin-error">
              No spin was made. {spinError}
            </p>
          )}

          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              className="btn btn-primary px-12 py-4 text-3xl font-extrabold shadow-lg"
              onClick={handleSpinClick}
              disabled={spinning}
              data-testid="spin-button"
            >
              {spinLabel}
            </button>

            {currentStudent && currentHasSpun && !spinning && !vetoTarget && (
              <p className="text-sm text-ink-dim" data-testid="already-spun-hint">
                {currentStudent.name} has already spun. Choose Next Spinner, or pick a ring to veto.
              </p>
            )}

            <fieldset className="flex flex-wrap items-center justify-center gap-2" disabled={spinning}>
              <legend className="eyebrow mx-auto mb-1">Veto one ring</legend>
              {RING_KEYS.map((ring) => (
                <label
                  key={ring}
                  className={`btn flex items-center gap-2 ${vetoTarget === ring ? 'border-bad bg-bad/25' : ''}`}
                >
                  <input
                    type="radio"
                    name="veto-target"
                    checked={vetoTarget === ring}
                    onChange={() => setVetoTarget(ring)}
                  />
                  {RING_LABEL[ring]}
                </label>
              ))}
              <button type="button" className="btn" onClick={() => setVetoTarget(null)} disabled={!vetoTarget}>
                Clear
              </button>
            </fieldset>

            <div className="flex flex-wrap justify-center gap-3">
              <button type="button" className="btn btn-danger" onClick={handleVetoClick} disabled={spinning} data-testid="veto-button">
                {vetoTarget ? `Veto ${RING_LABEL[vetoTarget]} & Re-spin` : 'Veto & Re-spin'}
              </button>
              {settings.enablePlantaeMercy && (
                <button
                  type="button"
                  className="btn btn-leaf"
                  onClick={() => setShowRegionPicker(true)}
                  disabled={spinning}
                  data-testid="mercy-button"
                >
                  Plantae Mercy
                </button>
              )}
            </div>

            {vetoWarning && (
              <p className="font-semibold text-bad" role="alert" data-testid="veto-warning">
                {vetoWarning}
              </p>
            )}
          </div>
        </div>

        {/* Right: the result */}
        <div className="order-2 xl:order-3">
          <ResultPanel
            outcome={outcome}
            studentName={resultStudent}
            spinning={spinning}
            logStatus={resultLog ? resultLog.status : null}
            logError={resultLog?.error}
            onRetryLog={resultLog ? () => retryLog(resultLog.id) : undefined}
          />
        </div>
      </div>

      <section className="panel" aria-labelledby="logged-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="logged-heading" className="text-xl font-bold">
            Today in the log{period ? `, period ${period}` : ''}
          </h2>
          <div className="flex items-center gap-3 text-sm text-ink-dim">
            {hiddenTestRows > 0 && <span>{hiddenTestRows} test rows hidden</span>}
            <button type="button" className="btn text-sm" onClick={fetchLoggedSpins} disabled={!configured || loggedLoading}>
              Refresh
            </button>
          </div>
        </div>
        {configured ? (
          <ResultsPanel rows={loggedRows} loading={loggedLoading} error={loggedError} onReroll={handleRerollFromHistory} />
        ) : (
          <p className="text-ink-dim">The backend is not configured, so the saved log cannot be shown.</p>
        )}
      </section>

      {showHarness && (
        <AutoTestPanel config={ringSetup.config} pairCapPct={settings.pairCapPercent} sessionId={sessionId} />
      )}

      <details className="panel text-sm">
        <summary className="font-semibold text-ink-dim">Debug: last row sent to the log</summary>
        {latestPayload ? (
          <pre className="mt-3 overflow-auto whitespace-pre-wrap break-all text-xs" data-testid="debug-payload">
            {JSON.stringify(latestPayload, null, 2)}
          </pre>
        ) : (
          <p className="mt-3 text-ink-dim">No spin yet this session.</p>
        )}
      </details>

      {showRegionPicker && <RegionPicker onPick={applyPlantaeMercy} onCancel={() => setShowRegionPicker(false)} />}
    </div>
  );
};

interface RegionPickerProps {
  onPick: (region: Region) => void;
  onCancel: () => void;
}

/** Modal used by Plantae Mercy to choose the region. Escape cancels. */
function RegionPicker({ onPick, onCancel }: RegionPickerProps) {
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstButton.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel w-full max-w-2xl" role="dialog" aria-modal="true" aria-labelledby="mercy-heading">
        <h2 id="mercy-heading" className="mb-1 text-2xl font-bold">
          Plantae Mercy
        </h2>
        <p className="mb-4 text-ink-dim">Choose the region. The taxon becomes Plantae and the IUCN status is kept.</p>
        <div className="grid grid-cols-2 gap-3">
          {REGIONS.map((region, index) => (
            <button
              key={region}
              ref={index === 0 ? firstButton : undefined}
              type="button"
              className="btn btn-leaf py-3 text-lg"
              onClick={() => onPick(region)}
            >
              {region}
            </button>
          ))}
        </div>
        <button type="button" className="btn mt-4" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
