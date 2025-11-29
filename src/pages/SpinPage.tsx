import { useState, useEffect, useMemo } from 'react';
import confetti from 'canvas-confetti';
import { SpinnerWheels } from '../components/SpinnerWheels';
import { SpinEngine, REGIONS, TAXA, IUCN_STATUS, randomSeed } from '../utils/spin-engine';
import { AudioService } from '../services/audio';
import { api, isApiConfigured } from '../api';
import { ApiStatusIndicator, ApiNotConfiguredBanner } from '../components/ApiStatusIndicator';
import type { SpinResult, Region, Settings, SpinsLogPayload } from '../types';

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
  const [vetoUsed, setVetoUsed] = useState(false);
  const [vetoTarget, setVetoTarget] = useState<'region' | 'taxon' | 'iucn' | null>(null);
  const [vetoWarning, setVetoWarning] = useState<string | null>(null);

  // Generate session ID once per page load
  const sessionId = useMemo(() => randomSeed(), []);

  useEffect(() => {
    // Only load settings from API if configured
    if (!isApiConfigured()) {
      console.warn('API not configured - using default settings');
      return;
    }

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

    const payload: SpinsLogPayload = {
      timestamp_iso: new Date().toISOString(),
      session_id: sessionId,
      // A2: Student info defaults to empty strings until student selector is implemented
      period: '', 
      student_name: '', 
      email: '', 
      result_A: result.region, 
      result_B: result.taxon, 
      result_C: result.iucn, 
      plantae_mercy: result.plantaeMercyApplied ?? false,
      veto_used: isVeto,
      seed: randomSeed(),
      is_test: false,
      rule_flags_json: JSON.stringify(finalRuleFlags),
    };

    if (isApiConfigured()) {
      api.logSpin(payload).catch(err => {
        console.error('Failed to log spin:', err);
      });
    } else {
      console.warn('API not configured - spin not logged');
    }

    if (isVeto) {
      setVetoUsed(true);
    } else {
      setVetoUsed(false);
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
