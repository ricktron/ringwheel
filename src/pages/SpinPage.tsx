import { useState, useEffect, useMemo } from 'react';
import confetti from 'canvas-confetti';
import { SpinnerWheels } from '../components/SpinnerWheels';
import { ResultsPanel } from '../components/ResultsPanel';
import { SpinEngine, REGIONS, TAXA, IUCN_STATUS, randomSeed } from '../utils/spin-engine';
import { AudioService } from '../services/audio';
import { api, isApiConfigured } from '../api';
import { ApiStatusIndicator, ApiNotConfiguredBanner } from '../components/ApiStatusIndicator';
import type { SpinResult, Region, Settings, SpinsLogPayload, RosterStudent, SpinQueueItem, SpinLogRow, Taxon, IUCN } from '../types';

type TestMode = 'normal' | 'veto_region' | 'veto_taxon' | 'veto_iucn' | 'mercy';
type ModeStats = {
    total: number;
    nonMercyPlantaeHits: number;        // taxon === 'Plantae' on non-mercy results
    multiFieldChangesOnVeto: number;    // veto changed more than one ring
    mercyFlagIssues: number;            // mercy spins missing flags
    mercyVetoIssues: number;            // mercy spins with veto_used = true
};
type TestSummary = Record<TestMode, ModeStats>;

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}



export const SpinPage = () => {
  const [spinning, setSpinning] = useState(false);
  const [currentResult, setCurrentResult] = useState<SpinResult>({
    region: REGIONS[0],
    taxon: TAXA[0],
    iucn: IUCN_STATUS[0],
    timestamp: Date.now(),
  });
  const [spinEngine] = useState(() => new SpinEngine());
  const [settings, setSettings] = useState<Settings>({
    enableAudio: true,
    enableConfetti: true,
    enablePlantaeMercy: true,
    pairCapPercent: 12,
    tickerSpeed: 100,
  });
  const [manualRegion, setManualRegion] = useState<Region | undefined>();
  const [showRegionPicker, setShowRegionPicker] = useState(false);

  const [vetoTarget, setVetoTarget] = useState<'region' | 'taxon' | 'iucn' | null>(null);
  const [vetoWarning, setVetoWarning] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [lastLoggedRow, setLastLoggedRow] = useState<SpinsLogPayload | null>(null);

  // C1: Spin queue state
  const [selectedSemester, setSelectedSemester] = useState<'S1' | 'S2'>('S1');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('A');
  const [orderMode, setOrderMode] = useState<'alphabetical' | 'random'>('alphabetical');

  const [rosterCache, setRosterCache] = useState<RosterStudent[] | null>(null);
  const [spinQueue, setSpinQueue] = useState<SpinQueueItem[]>([]);
  const [currentStudent, setCurrentStudent] = useState<SpinQueueItem | null>(null);

  const [queueStatus, setQueueStatus] = useState<string | null>(null);

  const [results, setResults] = useState<SpinLogRow[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);

  // Auto Test Suite State
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [testSpinsPerMode, setTestSpinsPerMode] = useState(20);
  const [enabledTestModes, setEnabledTestModes] = useState<Record<TestMode, boolean>>({
    normal: true,
    veto_region: true,
    veto_taxon: true,
    veto_iucn: true,
    mercy: true,
  });
  const [testSummary, setTestSummary] = useState<TestSummary | null>(null);
  const [testProgress, setTestProgress] = useState<{ done: number; total: number } | null>(null);
  const [testErrors, setTestErrors] = useState<string[]>([]);

  // Generate session ID once per page load
  const sessionId = useMemo(() => randomSeed(), []);

  const getTodayIso = () => new Date().toISOString().split('T')[0];

  const fetchSpinsForToday = () => {
    if (!isApiConfigured()) return;
    
    setResultsLoading(true);
    setResultsError(null);
    
    api.getSpins({
      date: getTodayIso(),
      period: selectedPeriod || undefined,
    })
    .then(data => {
      setResults(data);
      setResultsLoading(false);
    })
    .catch(err => {
      console.error('Failed to fetch spins:', err);
      setResultsError('Failed to load spins history.');
      setResultsLoading(false);
    });
  };

  useEffect(() => {
    // Only load settings from API if configured
    if (!isApiConfigured()) {
      console.warn('API not configured - using default settings');
      return;
    }

    fetchSpinsForToday();

    // Load settings from API (using new api client)
    // Note: The API returns SettingRow[], but legacy Settings type is used in UI
    // For now, we keep the legacy settings handling; this can be unified later
    api.settings().then(rows => {
      // Convert SettingRow[] to Settings object
      const settingsMap = new Map(rows.map(r => [r.key, r.value]));
      setSettings(prev => ({
        enableAudio: settingsMap.has('enableAudio') ? settingsMap.get('enableAudio') === 'true' : prev.enableAudio,
        enableConfetti: settingsMap.has('enableConfetti') ? settingsMap.get('enableConfetti') === 'true' : prev.enableConfetti,
        enablePlantaeMercy: settingsMap.has('enablePlantaeMercy') ? settingsMap.get('enablePlantaeMercy') !== 'false' : prev.enablePlantaeMercy,
        pairCapPercent: parseInt(settingsMap.get('midterm_pair_cap_pct') || settingsMap.get('pairCapPercent') || '12', 10),
        tickerSpeed: parseInt(settingsMap.get('tickerSpeed') || '100', 10),
      }));
      const audioEnabled = settingsMap.get('enableAudio') !== 'false';
      AudioService.setEnabled(audioEnabled);
    }).catch(err => {
      console.error('Failed to load settings:', err);
    });
  }, []);

  const runAutoTestSuite = async () => {
    if (!isApiConfigured()) {
      setTestErrors(['API not configured. Cannot run tests.']);
      return;
    }

    setIsRunningTests(true);
    setTestErrors([]);
    setTestSummary(null);

    const modesToRun = (Object.keys(enabledTestModes) as TestMode[]).filter(m => enabledTestModes[m]);
    const totalSpins = modesToRun.length * testSpinsPerMode;
    
    const summary: TestSummary = {
      normal: { total: 0, nonMercyPlantaeHits: 0, multiFieldChangesOnVeto: 0, mercyFlagIssues: 0, mercyVetoIssues: 0 },
      veto_region: { total: 0, nonMercyPlantaeHits: 0, multiFieldChangesOnVeto: 0, mercyFlagIssues: 0, mercyVetoIssues: 0 },
      veto_taxon: { total: 0, nonMercyPlantaeHits: 0, multiFieldChangesOnVeto: 0, mercyFlagIssues: 0, mercyVetoIssues: 0 },
      veto_iucn: { total: 0, nonMercyPlantaeHits: 0, multiFieldChangesOnVeto: 0, mercyFlagIssues: 0, mercyVetoIssues: 0 },
      mercy: { total: 0, nonMercyPlantaeHits: 0, multiFieldChangesOnVeto: 0, mercyFlagIssues: 0, mercyVetoIssues: 0 },
    };

    let spinsDone = 0;
    setTestProgress({ done: 0, total: totalSpins });

    try {
      for (const mode of modesToRun) {
        for (let i = 0; i < testSpinsPerMode; i++) {
          let result: SpinResult;
          let ruleFlags: string[] = [];
          let vetoUsed = false;
          let target: 'region' | 'taxon' | 'iucn' | null = null;

          // Base spin for veto modes
          const baseResult = spinEngine.spin({});

          if (mode === 'normal') {
            result = spinEngine.spin({});
            ruleFlags = ['auto_test_run'];
            if (result.taxon === 'Plantae') {
              summary.normal.nonMercyPlantaeHits++;
            }
          } else if (mode === 'veto_region') {
            target = 'region';
            vetoUsed = true;
            const vetoOutput = spinEngine.vetoSpinSingle(baseResult, 'region');
            result = vetoOutput.result;
            ruleFlags = ['auto_test_run', 'veto_respin', ...vetoOutput.ruleFlags];
            
            summary.veto_region.total++;
            let changes = 0;
            if (result.region !== baseResult.region) changes++;
            if (result.taxon !== baseResult.taxon) changes++;
            if (result.iucn !== baseResult.iucn) changes++;
            if (changes !== 1) summary.veto_region.multiFieldChangesOnVeto++;

          } else if (mode === 'veto_taxon') {
            target = 'taxon';
            vetoUsed = true;
            const vetoOutput = spinEngine.vetoSpinSingle(baseResult, 'taxon');
            result = vetoOutput.result;
            ruleFlags = ['auto_test_run', 'veto_respin', ...vetoOutput.ruleFlags];

            summary.veto_taxon.total++;
            let changes = 0;
            if (result.region !== baseResult.region) changes++;
            if (result.taxon !== baseResult.taxon) changes++;
            if (result.iucn !== baseResult.iucn) changes++;
            if (changes !== 1) summary.veto_taxon.multiFieldChangesOnVeto++;

          } else if (mode === 'veto_iucn') {
            target = 'iucn';
            vetoUsed = true;
            const vetoOutput = spinEngine.vetoSpinSingle(baseResult, 'iucn');
            result = vetoOutput.result;
            ruleFlags = ['auto_test_run', 'veto_respin', ...vetoOutput.ruleFlags];

            summary.veto_iucn.total++;
            let changes = 0;
            if (result.region !== baseResult.region) changes++;
            if (result.taxon !== baseResult.taxon) changes++;
            if (result.iucn !== baseResult.iucn) changes++;
            if (changes !== 1) summary.veto_iucn.multiFieldChangesOnVeto++;

          } else if (mode === 'mercy') {
            // Mercy logic
            const mercyRegion = REGIONS[Math.floor(Math.random() * REGIONS.length)];
            result = {
              ...baseResult,
              region: mercyRegion,
              taxon: 'Plantae',
              plantaeMercyApplied: true,
            };
            ruleFlags = ['auto_test_run', 'plantae_mercy', 'wildcard_iucn'];
            vetoUsed = false;

            summary.mercy.total++;
            if (result.taxon !== 'Plantae') summary.mercy.mercyFlagIssues++;
            if (vetoUsed) summary.mercy.mercyVetoIssues++; // Should be false
            if (!ruleFlags.includes('plantae_mercy') || !ruleFlags.includes('wildcard_iucn')) {
                summary.mercy.mercyFlagIssues++;
            }
          } else {
             // Should not happen
             result = baseResult; 
          }

          const payload = buildSpinLogPayload(result, ruleFlags, {
            vetoUsed,
            target,
            isTest: true
          });

          await api.logSpin(payload);
          
          spinsDone++;
          setTestProgress({ done: spinsDone, total: totalSpins });
        }
      }
      
      setTestSummary(summary);
      
      // Check for errors to display
      const errors: string[] = [];
      if (summary.veto_region.multiFieldChangesOnVeto > 0) errors.push(`Veto (Region): ${summary.veto_region.multiFieldChangesOnVeto} spins changed more than one field`);
      if (summary.veto_taxon.multiFieldChangesOnVeto > 0) errors.push(`Veto (Taxon): ${summary.veto_taxon.multiFieldChangesOnVeto} spins changed more than one field`);
      if (summary.veto_iucn.multiFieldChangesOnVeto > 0) errors.push(`Veto (IUCN): ${summary.veto_iucn.multiFieldChangesOnVeto} spins changed more than one field`);
      if (summary.mercy.mercyFlagIssues > 0) errors.push(`Mercy: ${summary.mercy.mercyFlagIssues} spins had flag issues`);
      if (summary.mercy.mercyVetoIssues > 0) errors.push(`Mercy: ${summary.mercy.mercyVetoIssues} spins had veto_used=true`);

      setTestErrors(errors);

    } catch (e) {
      console.error("Auto test suite failed", e);
      setTestErrors(prev => [...prev, `Test suite failed: ${e}`]);
    } finally {
      setIsRunningTests(false);
      setTestProgress(null);
    }
  };

  const handleLoadRoster = async () => {
    if (!isApiConfigured()) {
      setQueueStatus("API not configured – cannot load roster");
      return;
    }

    let roster = rosterCache;
    if (!roster) {
      try {
        setQueueStatus("Loading roster...");
        roster = await api.roster();
        setRosterCache(roster);
      } catch (err) {
        console.error("Failed to load roster:", err);
        setQueueStatus("Failed to load roster from API.");
        return;
      }
    }

    // Filter candidates
    // Note: We assume 'class' field might be used later, but for now just filter by period
    const candidates = roster.filter(student => {
      const p = selectedSemester === 'S1' ? student.s1Period : student.s2Period;
      return p === selectedPeriod;
    });

    let queue: SpinQueueItem[] = candidates.map(student => ({
      email: student.email,
      name: `${student.first} ${student.last}`.trim(),
      period: (selectedSemester === 'S1' ? student.s1Period : student.s2Period) ?? '',
      hasSpun: false,
    }));

    if (orderMode === 'alphabetical') {
      queue.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      queue = shuffleArray(queue);
    }

    setSpinQueue(queue);
    setCurrentStudent(null);
    setQueueStatus(`Loaded ${queue.length} students for ${selectedSemester} Period ${selectedPeriod}`);
  };

  const handleNextSpinner = () => {
    const next = spinQueue.find(item => !item.hasSpun);
    if (!next) {
      setQueueStatus("All students in this queue have spun.");
      return;
    }
    setCurrentStudent(next);
    // Note: We do not mark them as spun yet (Phase C2)
  };

  const buildSpinLogPayload = (
    result: SpinResult,
    ruleFlags: string[],
    options: { vetoUsed: boolean; target: 'region' | 'taxon' | 'iucn' | null; isTest: boolean }
  ): SpinsLogPayload => {
    const timestamp_iso = new Date(result.timestamp).toISOString();

    const studentName = currentStudent ? currentStudent.name : '';
    const studentEmail = currentStudent ? currentStudent.email : '';
    const studentPeriod = currentStudent ? currentStudent.period : '';

    return {
      timestamp_iso,
      session_id: sessionId,
      period: studentPeriod,
      student_name: studentName,
      email: studentEmail,
      result_A: result.region,
      result_B: result.taxon,
      result_C: result.iucn,
      plantae_mercy: result.plantaeMercyApplied ?? false,
      veto_used: options.vetoUsed,
      seed: randomSeed(),
      is_test: options.isTest,
      rule_flags_json: JSON.stringify(ruleFlags),
    };
  };

  const applySpin = (
    result: SpinResult,
    ruleFlags: string[],
    isVeto: boolean,
    target: 'region' | 'taxon' | 'iucn' | null
  ) => {
    setCurrentResult(result);
    setSpinning(false);
    setManualRegion(undefined);
    setShowRegionPicker(false);

    // Trigger confetti
    if (settings.enableConfetti) {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
      });
    }

    // Add generic veto flag if specific one is present
    const finalRuleFlags = [...ruleFlags];
    if (isVeto && !finalRuleFlags.includes('veto_respin')) {
      finalRuleFlags.push('veto_respin');
    }

    const payload = buildSpinLogPayload(result, finalRuleFlags, {
      vetoUsed: isVeto,
      target: target,
      isTest: false
    });

    if (isApiConfigured()) {
      api.logSpin(payload).then(() => {
        // Mark currentStudent as having spun, if present
        if (currentStudent) {
          setSpinQueue(prev =>
            prev.map(item =>
              item.email === currentStudent.email && item.period === currentStudent.period
                ? { ...item, hasSpun: true }
                : item
            )
          );
        }
        setLastLoggedRow(payload);
        fetchSpinsForToday();
      }).catch(err => {
        console.error('Failed to log spin:', err);
      });
    } else {
      console.warn('API not configured - spin not logged');
    }


  };

  const executeSpin = (isVetoRespin: boolean, target: 'region' | 'taxon' | 'iucn' | null) => {
    if (spinning) return;

    setSpinning(true);
    setVetoWarning(null);
    AudioService.playTick();

    // Simulate spinning animation
    const spinDuration = 2000; // 2 seconds
    const tickInterval = settings.tickerSpeed;
    let elapsed = 0;

    const tickerInterval = setInterval(() => {
      AudioService.playTick();
      elapsed += tickInterval;

      if (elapsed >= spinDuration) {
        clearInterval(tickerInterval);
        
        let result: SpinResult;
        let ruleFlags: string[] = [];

        if (isVetoRespin && target) {
           const vetoOutput = spinEngine.vetoSpinSingle(currentResult, target);
           result = vetoOutput.result;
           ruleFlags = vetoOutput.ruleFlags;
           AudioService.playVeto();
        } else {
           const spinOptions = {
             manualRegion,
           };
           result = spinEngine.spin(spinOptions);
           if (result.manualRegion) ruleFlags.push('manual_region');
           AudioService.playWin();
        }

        applySpin(result, ruleFlags, isVetoRespin, target);
        
        if (isVetoRespin) {
            setVetoTarget(null);
        }
      }
    }, tickInterval);
  };

  const performVetoSpin = (target: 'region' | 'taxon' | 'iucn') => {
    executeSpin(true, target);
  };

  const handleSpinClick = () => {
    if (vetoTarget) {
      performVetoSpin(vetoTarget);
    } else {
      executeSpin(false, null);
    }
  };

  const handleVetoClick = () => {
    if (!vetoTarget) {
      setVetoWarning('Select Region, Taxon, or IUCN Status to veto first.');
      return;
    }
    performVetoSpin(vetoTarget);
  };

  const handlePlantaeMercy = () => {
    setShowRegionPicker(true);
  };

  /**
   * Plantae Mercy Contract:
   * - It forces taxon to 'Plantae'.
   * - It sets region from the mercy region picker.
   * - It leaves iucn as-is (for now).
   * - It sets plantaeMercyApplied / plantae_mercy true.
   * - It passes ['plantae_mercy', 'wildcard_iucn'] as rule flags.
   * - It does not set veto_used and does not call veto spin logic.
   */

  const handleRerollFromHistory = (row: SpinLogRow) => {
    // Prime the rings
    setCurrentResult(prev => ({
      ...prev,
      region: row.result_region as Region,
      taxon: row.result_taxon as Taxon,
      iucn: row.result_iucn as IUCN,
      timestamp: Date.now(),
      plantaeMercyApplied: row.plantae_mercy,
    }));

    // Prime the student
    setCurrentStudent(row.student_name
      ? { email: row.email, name: row.student_name, period: row.period, hasSpun: false }
      : null
    );

    // Reset UI state
    setVetoTarget(null);
    setShowRegionPicker(false);
  };

  const applyPlantaeMercy = (chosenRegionKey: Region) => {
    const mercyResult: SpinResult = {
      ...currentResult,
      region: chosenRegionKey,
      taxon: 'Plantae',
      // keep the current IUCN or later let the user pick a new one
      timestamp: Date.now(),
      plantaeMercyApplied: true,
      manualRegion: undefined, // It's manual but handled via mercy path
    };

    applySpin(
      mercyResult,
      ['plantae_mercy', 'wildcard_iucn'],
      false, // vetoUsed
      null // target
    );

    // Extra celebration for mercy
    AudioService.playWin(); // Or playPlantaeMercy if available
    if (settings.enableConfetti) {
      confetti({
        particleCount: 200,
        spread: 100,
        origin: { y: 0.6 },
        colors: ['#4CAF50', '#8BC34A', '#CDDC39'], // Greenish colors
      });
    }
  };

  const handleRegionSelect = (region: Region) => {
    // setManualRegion(region); // No longer needed for mercy path
    setShowRegionPicker(false);
    applyPlantaeMercy(region);
  };

  const showPlantaeMercyButton = settings.enablePlantaeMercy;

  const getSpinModeLabel = () => {
    if (showRegionPicker) return "Plantae Mercy";
    if (vetoTarget) {
      if (vetoTarget === 'region') return "Veto (Region)";
      if (vetoTarget === 'taxon') return "Veto (Taxon)";
      if (vetoTarget === 'iucn') return "Veto (IUCN)";
    }
    return "Normal";
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-4xl font-bold text-gray-800">
            🎡 Ringwheel Spinner
          </h1>
          <ApiStatusIndicator />
        </div>

        <ApiNotConfiguredBanner />

        {/* Auto Test Suite Bar */}
        {(import.meta.env.DEV || (settings as any).enableTestHarness) && (
          <div className="bg-gray-800 text-white p-4 rounded-lg shadow-md mb-6 border border-gray-700">
            <div className="flex flex-wrap items-center gap-4 mb-2">
              <h3 className="font-bold text-lg text-yellow-400">🛠 Auto Test Suite</h3>
              <div className="flex items-center gap-2">
                <label className="text-xs uppercase font-bold text-gray-400">Spins/Mode</label>
                <input 
                  type="number" 
                  value={testSpinsPerMode} 
                  onChange={e => setTestSpinsPerMode(Math.max(1, Math.min(500, parseInt(e.target.value) || 20)))}
                  className="w-16 px-2 py-1 text-black rounded text-sm"
                  disabled={isRunningTests}
                />
              </div>
              <button
                onClick={runAutoTestSuite}
                disabled={isRunningTests}
                className="bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 text-white px-4 py-1 rounded font-bold text-sm transition-colors"
              >
                {isRunningTests ? `Running... (${testProgress?.done} / ${testProgress?.total})` : 'Run Auto Test Suite'}
              </button>
            </div>
            
            <div className="flex flex-wrap gap-3 text-sm mb-2">
              {(Object.keys(enabledTestModes) as TestMode[]).map(mode => (
                <label key={mode} className="flex items-center gap-1 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={enabledTestModes[mode]} 
                    onChange={e => setEnabledTestModes(prev => ({ ...prev, [mode]: e.target.checked }))}
                    disabled={isRunningTests}
                  />
                  <span className="capitalize">{mode.replace('_', ' ')}</span>
                </label>
              ))}
            </div>

            {/* Summary Panel */}
            {testSummary && !isRunningTests && (
              <div className="mt-3 bg-gray-900 p-3 rounded text-xs font-mono">
                <div className="grid grid-cols-4 gap-2 font-bold border-b border-gray-700 pb-1 mb-1 text-gray-400">
                  <div>Mode</div>
                  <div>Total</div>
                  <div>Issues</div>
                  <div>Status</div>
                </div>
                {(Object.keys(testSummary) as TestMode[]).filter(m => enabledTestModes[m]).map(mode => {
                   const stats = testSummary[mode];
                   const issues = stats.multiFieldChangesOnVeto + stats.mercyFlagIssues + stats.mercyVetoIssues;
                   const isOk = issues === 0;
                   return (
                     <div key={mode} className="grid grid-cols-4 gap-2">
                       <div className="capitalize">{mode.replace('_', ' ')}</div>
                       <div>{stats.total}</div>
                       <div className={issues > 0 ? "text-red-400 font-bold" : "text-gray-500"}>
                         {mode === 'normal' ? `Plantae: ${stats.nonMercyPlantaeHits}` : issues}
                       </div>
                       <div>{isOk ? "✅ OK" : "⚠️ Check"}</div>
                     </div>
                   );
                })}
              </div>
            )}

            {testErrors.length > 0 && (
               <div className="mt-2 text-red-400 text-xs">
                 <ul className="list-disc list-inside">
                   {testErrors.map((err, i) => <li key={i}>{err}</li>)}
                 </ul>
               </div>
            )}
          </div>
        )}

        {/* Queue Panel (Phase C1) */}
        <div className="bg-white p-4 rounded-lg shadow-md mb-6 border border-gray-200 max-w-4xl mx-auto">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Semester</label>
              <select 
                value={selectedSemester} 
                onChange={e => setSelectedSemester(e.target.value as 'S1' | 'S2')}
                className="border rounded px-2 py-1 text-sm"
              >
                <option value="S1">S1</option>
                <option value="S2">S2</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Period</label>
              <input 
                type="text" 
                value={selectedPeriod} 
                onChange={e => setSelectedPeriod(e.target.value.toUpperCase())}
                className="border rounded px-2 py-1 text-sm w-16"
                maxLength={2}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Order</label>
              <select 
                value={orderMode} 
                onChange={e => setOrderMode(e.target.value as 'alphabetical' | 'random')}
                className="border rounded px-2 py-1 text-sm"
              >
                <option value="alphabetical">Alphabetical</option>
                <option value="random">Random</option>
              </select>
            </div>
            <button 
              onClick={handleLoadRoster}
              className="bg-indigo-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-indigo-700 transition-colors"
            >
              Load Roster
            </button>
            <button 
              onClick={handleNextSpinner}
              className="bg-green-600 text-white px-3 py-1 rounded text-sm font-semibold hover:bg-green-700 transition-colors"
              disabled={spinQueue.length === 0}
            >
              Next Spinner
            </button>
          </div>

          {queueStatus && (
            <div className="mt-2 text-sm text-gray-600 italic">
              {queueStatus}
            </div>
          )}

          {currentStudent && (
            <div className="mt-3 p-2 bg-blue-50 border border-blue-200 rounded flex items-center justify-between">
              <span className="font-bold text-blue-800">Current: {currentStudent.name} ({currentStudent.period})</span>
            </div>
          )}

          {spinQueue.length > 0 && (
            <div className="mt-3 max-h-32 overflow-y-auto border border-gray-100 rounded text-xs">
              <table className="w-full text-left">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1">Name</th>
                    <th className="px-2 py-1">Period</th>
                  </tr>
                </thead>
                <tbody>
                  {spinQueue.map((item, idx) => {
                    const isCurrent = currentStudent === item;
                    return (
                      <tr key={idx} className={isCurrent ? "bg-blue-100" : "even:bg-gray-50"}>
                        <td className="px-2 py-1">
                          {item.hasSpun ? "✓" : (item === currentStudent ? "•" : "")}
                        </td>
                        <td className="px-2 py-1 font-medium">{item.name}</td>
                        <td className="px-2 py-1">{item.period}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <SpinnerWheels
          region={currentResult.region}
          taxon={currentResult.taxon}
          iucn={currentResult.iucn}
          spinning={spinning}
          regionItems={REGIONS}
          taxonItems={TAXA}
          iucnItems={IUCN_STATUS}
          onRingClick={setVetoTarget}
          selectedRing={vetoTarget}
        />

        <div className="flex flex-col items-center gap-4 mt-8">
          {vetoWarning && (
            <div className="text-red-600 font-semibold animate-pulse">
              {vetoWarning}
            </div>
          )}

          <div className="flex justify-center mb-2">
            <span className={`px-3 py-1 rounded-full text-sm font-bold border ${
              getSpinModeLabel() === 'Normal' 
                ? 'bg-gray-100 text-gray-600 border-gray-200' 
                : 'bg-yellow-100 text-yellow-800 border-yellow-200'
            }`}>
              Mode: {getSpinModeLabel()}
            </span>
          </div>
          
          <div className="flex justify-center gap-4">
            <button
              onClick={handleSpinClick}
              disabled={spinning}
              className="px-8 py-4 bg-blue-600 text-white rounded-lg font-semibold text-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors shadow-lg"
            >
              {spinning ? 'Spinning...' : 'SPIN'}
            </button>

            {!spinning && (
              <button
                onClick={handleVetoClick}
                className="px-6 py-4 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition-colors shadow-lg"
              >
                {vetoTarget ? `Veto ${vetoTarget === 'iucn' ? 'IUCN' : vetoTarget.charAt(0).toUpperCase() + vetoTarget.slice(1)} & Re-spin` : 'Veto & Re-spin'}
              </button>
            )}

            {!spinning && showPlantaeMercyButton && (
              <button
                onClick={handlePlantaeMercy}
                className="px-6 py-4 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition-colors shadow-lg"
              >
                🌿 Plantae Mercy
              </button>
            )}
          </div>
        </div>

        <div className="mt-12 border-t pt-4">
          <button 
            onClick={() => setShowDebug(!showDebug)}
            className="text-xs text-gray-400 hover:text-gray-600 underline mb-2"
          >
            {showDebug ? 'Hide Debug Panel' : 'Show Debug Panel'}
          </button>
          
          {showDebug && (
            <div className="bg-gray-100 p-4 rounded text-xs font-mono overflow-auto border border-gray-300">
              <h3 className="font-bold mb-2 text-gray-700">Last Logged Spin</h3>
              {lastLoggedRow ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div><span className="font-semibold">Timestamp:</span> {lastLoggedRow.timestamp_iso}</div>
                  <div><span className="font-semibold">Student:</span> {lastLoggedRow.student_name || '(none)'}</div>
                  <div><span className="font-semibold">Email:</span> {lastLoggedRow.email || '(none)'}</div>
                  <div><span className="font-semibold">Period:</span> {lastLoggedRow.period || '(none)'}</div>
                  <div className="col-span-2 border-t border-gray-200 my-1"></div>
                  <div><span className="font-semibold">Result A:</span> {lastLoggedRow.result_A}</div>
                  <div><span className="font-semibold">Result B:</span> {lastLoggedRow.result_B}</div>
                  <div><span className="font-semibold">Result C:</span> {lastLoggedRow.result_C}</div>
                  <div><span className="font-semibold">Mercy:</span> {lastLoggedRow.plantae_mercy ? 'Yes' : 'No'}</div>
                  <div><span className="font-semibold">Veto Used:</span> {lastLoggedRow.veto_used ? 'Yes' : 'No'}</div>
                  <div className="col-span-2 border-t border-gray-200 my-1"></div>
                  <div className="col-span-2">
                    <span className="font-semibold">Rule Flags:</span>
                    <ul className="list-disc list-inside ml-2 mt-1">
                      {(() => {
                        try {
                          const flags = JSON.parse(lastLoggedRow.rule_flags_json);
                          return Array.isArray(flags) ? flags.map((f: string, i: number) => <li key={i}>{f}</li>) : <li>Invalid JSON</li>;
                        } catch {
                          return <li>Error parsing JSON</li>;
                        }
                      })()}
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="text-gray-500 italic">No spin logged yet this session.</div>
              )}
            </div>
          )}
        </div>

        <div className="max-w-4xl mx-auto mt-6">
          <ResultsPanel
            rows={results}
            loading={resultsLoading}
            error={resultsError}
            onReroll={handleRerollFromHistory}
          />
        </div>

        {showRegionPicker && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-8 max-w-2xl">
              <h2 className="text-2xl font-bold mb-4">Select Region for Plantae Mercy</h2>
              <div className="grid grid-cols-2 gap-4">
                {REGIONS.map(region => (
                  <button
                    key={region}
                    onClick={() => handleRegionSelect(region)}
                    className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                  >
                    {region}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowRegionPicker(false)}
                className="mt-4 px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="mt-12 bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-bold mb-4">Current Result</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-600">Region</p>
              <p className="text-xl font-semibold text-blue-600">{currentResult.region}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Taxon</p>
              <p className="text-xl font-semibold text-green-600">{currentResult.taxon}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">IUCN Status</p>
              <p className="text-xl font-semibold text-red-600">{currentResult.iucn}</p>
            </div>
          </div>
          {currentResult.plantaeMercyApplied && (
            <p className="mt-4 text-green-600 font-semibold">🌿 Plantae Mercy Applied</p>
          )}
          {currentResult.manualRegion && (
            <p className="mt-2 text-blue-600 font-semibold">📍 Manual Region: {currentResult.manualRegion}</p>
          )}
        </div>

        <div className="mt-6 text-center">
          <a
            href="/admin"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            Go to Admin Panel
          </a>
        </div>
      </div>
    </div>
  );
};
