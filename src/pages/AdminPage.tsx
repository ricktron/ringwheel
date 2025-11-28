import { useState, useEffect } from 'react';
import { api, isApiConfigured } from '../api';
import type { Settings, RingWeights, SettingRow, RingSlice } from '../types';
import { REGIONS, TAXA, IUCN_STATUS } from '../utils/spin-engine';

// Default ring colors matching schema/Rings.csv
const RING_COLORS = {
  A: '#4f46e5', // Regions - indigo
  B: '#16a34a', // Taxa - green
  C: '#eab308', // IUCN - yellow
} as const;

export const AdminPage = () => {
  const [settings, setSettings] = useState<Settings>({
    enableAudio: true,
    enableConfetti: true,
    enablePlantaeMercy: true,
    pairCapPercent: 12,
    tickerSpeed: 100,
  });

  const [weights, setWeights] = useState<RingWeights>({
    regions: Object.fromEntries(REGIONS.map(r => [r, 1])),
    taxa: Object.fromEntries(TAXA.map(t => [t, 1])),
    iucn: Object.fromEntries(IUCN_STATUS.map(i => [i, 1])),
  } as RingWeights);

  const [saveStatus, setSaveStatus] = useState<string>('');

  useEffect(() => {
    // Load current settings and weights using new api
    Promise.all([
      api.settings(),
      api.rings(),
    ]).then(([settingsRows, ringsRows]) => {
      // Convert SettingRow[] to Settings object
      const settingsMap = new Map<string, string>(settingsRows.map((r: SettingRow) => [r.key, r.value]));
      setSettings(prev => ({
        enableAudio: settingsMap.has('enableAudio') ? settingsMap.get('enableAudio') === 'true' : prev.enableAudio,
        enableConfetti: settingsMap.has('enableConfetti') ? settingsMap.get('enableConfetti') === 'true' : prev.enableConfetti,
        enablePlantaeMercy: settingsMap.has('enablePlantaeMercy') ? settingsMap.get('enablePlantaeMercy') !== 'false' : prev.enablePlantaeMercy,
        pairCapPercent: parseInt(settingsMap.get('midterm_pair_cap_pct') || settingsMap.get('pairCapPercent') || '12', 10),
        tickerSpeed: parseInt(settingsMap.get('tickerSpeed') || '100', 10),
      }));
      
      // Convert RingSlice[] to legacy RingWeights format for display
      // The new schema maps: Ring A = Regions, Ring B = Taxa, Ring C = IUCN
      if (ringsRows.length > 0) {
        const newWeights: RingWeights = {
          regions: {} as Record<string, number>,
          taxa: {} as Record<string, number>,
          iucn: {} as Record<string, number>,
        };
        
        ringsRows.forEach((slice: RingSlice) => {
          if (slice.ring_name === 'A') {
            (newWeights.regions as Record<string, number>)[slice.label] = slice.weight;
          } else if (slice.ring_name === 'B') {
            (newWeights.taxa as Record<string, number>)[slice.label] = slice.weight;
          } else if (slice.ring_name === 'C') {
            (newWeights.iucn as Record<string, number>)[slice.label] = slice.weight;
          }
        });
        
        // Fill in any missing values with default weight of 1
        REGIONS.forEach(r => {
          if (!(r in newWeights.regions)) {
            (newWeights.regions as Record<string, number>)[r] = 1;
          }
        });
        TAXA.forEach(t => {
          if (!(t in newWeights.taxa)) {
            (newWeights.taxa as Record<string, number>)[t] = 1;
          }
        });
        IUCN_STATUS.forEach(i => {
          if (!(i in newWeights.iucn)) {
            (newWeights.iucn as Record<string, number>)[i] = 1;
          }
        });
        
        setWeights(newWeights as RingWeights);
      }
    }).catch(err => {
      console.error('Failed to load settings/rings:', err);
    });
  }, []);

  const handleSettingsChange = (key: keyof Settings, value: boolean | number) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleWeightChange = (
    category: 'regions' | 'taxa' | 'iucn',
    key: string,
    value: number
  ) => {
    setWeights(prev => ({
      ...prev,
      [category]: {
        ...prev[category],
        [key]: value,
      },
    }));
  };

  const handleSaveSettings = async () => {
    setSaveStatus('Saving settings...');
    try {
      // Convert Settings object to SettingRow[]
      const rows: SettingRow[] = [
        { key: 'enableAudio', value: String(settings.enableAudio) },
        { key: 'enableConfetti', value: String(settings.enableConfetti) },
        { key: 'enablePlantaeMercy', value: String(settings.enablePlantaeMercy) },
        { key: 'pairCapPercent', value: String(settings.pairCapPercent) },
        { key: 'tickerSpeed', value: String(settings.tickerSpeed) },
      ];
      await api.writeSettings(rows);
      setSaveStatus('Settings saved successfully!');
    } catch (err) {
      setSaveStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setTimeout(() => setSaveStatus(''), 3000);
  };

  const handleSaveWeights = async () => {
    setSaveStatus('Saving weights...');
    try {
      // Convert legacy RingWeights to RingSlice[] format
      // This maps legacy regions/taxa/iucn to rings A/B/C
      const rows: RingSlice[] = [];
      let orderIndex = 0;
      
      // Ring A = Regions
      Object.entries(weights.regions).forEach(([label, weight]) => {
        rows.push({
          ring_name: 'A',
          label,
          color_hex: RING_COLORS.A,
          weight: weight as number,
          order_index: orderIndex++,
          active: true,
        });
      });
      
      // Ring B = Taxa
      Object.entries(weights.taxa).forEach(([label, weight]) => {
        rows.push({
          ring_name: 'B',
          label,
          color_hex: RING_COLORS.B,
          weight: weight as number,
          order_index: orderIndex++,
          active: true,
        });
      });
      
      // Ring C = IUCN
      Object.entries(weights.iucn).forEach(([label, weight]) => {
        rows.push({
          ring_name: 'C',
          label,
          color_hex: RING_COLORS.C,
          weight: weight as number,
          order_index: orderIndex++,
          active: true,
        });
      });
      
      await api.writeRings(rows);
      setSaveStatus('Weights saved successfully!');
    } catch (err) {
      setSaveStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setTimeout(() => setSaveStatus(''), 3000);
  };

  const resetWeights = () => {
    setWeights({
      regions: Object.fromEntries(REGIONS.map(r => [r, 1])),
      taxa: Object.fromEntries(TAXA.map(t => [t, 1])),
      iucn: Object.fromEntries(IUCN_STATUS.map(i => [i, 1])),
    } as RingWeights);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800">⚙️ Admin Panel</h1>
          <a
            href="/spin"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Back to Spinner
          </a>
        </div>

        {saveStatus && (
          <div className="mb-6 p-4 bg-green-100 border border-green-400 text-green-700 rounded-lg">
            {saveStatus}
          </div>
        )}

        {/* Settings Section */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <h2 className="text-2xl font-bold mb-4">Settings</h2>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="font-semibold">Enable Audio</label>
              <input
                type="checkbox"
                checked={settings.enableAudio}
                onChange={(e) => handleSettingsChange('enableAudio', e.target.checked)}
                className="w-6 h-6"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="font-semibold">Enable Confetti</label>
              <input
                type="checkbox"
                checked={settings.enableConfetti}
                onChange={(e) => handleSettingsChange('enableConfetti', e.target.checked)}
                className="w-6 h-6"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="font-semibold">Enable Plantae Mercy</label>
              <input
                type="checkbox"
                checked={settings.enablePlantaeMercy}
                onChange={(e) => handleSettingsChange('enablePlantaeMercy', e.target.checked)}
                className="w-6 h-6"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="font-semibold">Pair Cap Percentage</label>
              <input
                type="number"
                value={settings.pairCapPercent}
                onChange={(e) => handleSettingsChange('pairCapPercent', Number(e.target.value))}
                min="0"
                max="100"
                className="w-20 px-2 py-1 border rounded"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="font-semibold">Ticker Speed (ms)</label>
              <input
                type="number"
                value={settings.tickerSpeed}
                onChange={(e) => handleSettingsChange('tickerSpeed', Number(e.target.value))}
                min="50"
                max="500"
                className="w-20 px-2 py-1 border rounded"
              />
            </div>
          </div>

          <button
            onClick={handleSaveSettings}
            className="mt-6 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            Save Settings
          </button>
        </div>

        {/* Ring Weights Section */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">Ring Weights</h2>
            <button
              onClick={resetWeights}
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 transition-colors"
            >
              Reset to Equal
            </button>
          </div>

          {/* Regions */}
          <div className="mb-6">
            <h3 className="text-xl font-semibold mb-3 text-blue-600">Regions</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {REGIONS.map(region => (
                <div key={region} className="flex flex-col">
                  <label className="text-sm font-medium mb-1">{region}</label>
                  <input
                    type="number"
                    value={weights.regions[region]}
                    onChange={(e) => handleWeightChange('regions', region, Number(e.target.value))}
                    min="0"
                    step="0.1"
                    className="px-2 py-1 border rounded"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Taxa */}
          <div className="mb-6">
            <h3 className="text-xl font-semibold mb-3 text-green-600">Taxa</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {TAXA.map(taxon => (
                <div key={taxon} className="flex flex-col">
                  <label className="text-sm font-medium mb-1">{taxon}</label>
                  <input
                    type="number"
                    value={weights.taxa[taxon]}
                    onChange={(e) => handleWeightChange('taxa', taxon, Number(e.target.value))}
                    min="0"
                    step="0.1"
                    className="px-2 py-1 border rounded"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* IUCN */}
          <div className="mb-6">
            <h3 className="text-xl font-semibold mb-3 text-red-600">IUCN Status</h3>
            <div className="grid grid-cols-2 md:grid-cols-7 gap-4">
              {IUCN_STATUS.map(status => (
                <div key={status} className="flex flex-col">
                  <label className="text-sm font-medium mb-1">{status}</label>
                  <input
                    type="number"
                    value={weights.iucn[status]}
                    onChange={(e) => handleWeightChange('iucn', status, Number(e.target.value))}
                    min="0"
                    step="0.1"
                    className="px-2 py-1 border rounded"
                  />
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={handleSaveWeights}
            className="mt-6 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            Save Weights
          </button>
        </div>

        {/* API Status */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-bold mb-4">API Status</h2>
          <p className={`font-semibold ${isApiConfigured() ? 'text-green-600' : 'text-red-600'}`}>
            {isApiConfigured() 
              ? '✓ API is configured' 
              : '✗ API not configured (check .env file)'}
          </p>
          <p className="mt-2 text-sm text-gray-600">
            Configure VITE_SPIN_API_URL and VITE_SPIN_API_TOKEN in your .env file
          </p>
        </div>
      </div>
    </div>
  );
};
