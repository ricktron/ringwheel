import { useState, useEffect, useMemo } from 'react';
import confetti from 'canvas-confetti';
import { SpinnerWheels } from '../components/SpinnerWheels';
import { SpinEngine, REGIONS, TAXA, IUCN_STATUS, randomSeed } from '../utils/spin-engine';
import { AudioService } from '../services/audio';
import { api } from '../api';
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

  // Generate session ID once per page load
  const sessionId = useMemo(() => randomSeed(), []);

  useEffect(() => {
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

  const performSpin = (isVetoRespin = false) => {
    if (spinning) return;

    setSpinning(true);
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
        
        // Perform actual spin
        const result = spinEngine.spin({
          enablePlantaeMercy: settings.enablePlantaeMercy,
          manualRegion,
        });

        setCurrentResult(result);
        setSpinning(false);
        setManualRegion(undefined);
        setShowRegionPicker(false);

        // Play win sound
        AudioService.playWin();

        // Trigger confetti
        if (settings.enableConfetti) {
          confetti({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 },
          });
        }

        // Build SpinsLogPayload matching schema/SpinsLog.csv headers
        const ruleFlags: string[] = [];
        if (result.plantaeMercyApplied) ruleFlags.push('plantae_mercy');
        if (result.manualRegion) ruleFlags.push('manual_region');
        if (isVetoRespin) ruleFlags.push('veto_respin');

        const payload: SpinsLogPayload = {
          timestamp_iso: new Date().toISOString(),
          session_id: sessionId,
          period: '', // Not tracked in legacy UI
          student_name: '', // Not tracked in legacy UI
          email: '', // Not tracked in legacy UI
          result_A: result.region, // Ring A = Region
          result_B: result.taxon, // Ring B = Taxon
          result_C: result.iucn, // Ring C = IUCN
          plantae_mercy: result.plantaeMercyApplied ?? false,
          veto_used: isVetoRespin || vetoUsed,
          // Note: Legacy SpinEngine doesn't expose seed; generate one for logging reference
          // Future: Use planSpin() which returns deterministic seed for reproducibility
          seed: randomSeed(),
          is_test: false,
          rule_flags_json: JSON.stringify(ruleFlags),
        };

        // Log spin to backend using new api client
        api.logSpin(payload).catch(err => {
          console.error('Failed to log spin:', err);
        });

        // Reset veto flag after logging
        if (isVetoRespin) {
          setVetoUsed(true);
        }
      }
    }, tickInterval);
  };

  const handleVeto = () => {
    spinEngine.vetoSpin(currentResult, 'triple');
    AudioService.playVeto();
    performSpin(true); // Mark as veto respin
  };

  const handlePlantaeMercy = () => {
    setShowRegionPicker(true);
  };

  const handleRegionSelect = (region: Region) => {
    setManualRegion(region);
    setShowRegionPicker(false);
    performSpin(false); // Regular spin with manual region
  };

  const showPlantaeMercyButton = 
    settings.enablePlantaeMercy && 
    currentResult.taxon === 'Plantae' && 
    ['NT', 'VU', 'EN'].includes(currentResult.iucn);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-center mb-8 text-gray-800">
          🎡 Ringwheel Spinner
        </h1>

        <SpinnerWheels
          region={currentResult.region}
          taxon={currentResult.taxon}
          iucn={currentResult.iucn}
          spinning={spinning}
          regionItems={REGIONS}
          taxonItems={TAXA}
          iucnItems={IUCN_STATUS}
        />

        <div className="flex justify-center gap-4 mt-8">
          <button
            onClick={() => performSpin(false)}
            disabled={spinning}
            className="px-8 py-4 bg-blue-600 text-white rounded-lg font-semibold text-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors shadow-lg"
          >
            {spinning ? 'Spinning...' : 'SPIN'}
          </button>

          {!spinning && (
            <button
              onClick={handleVeto}
              className="px-6 py-4 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition-colors shadow-lg"
            >
              🚫 Veto & Re-spin
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
