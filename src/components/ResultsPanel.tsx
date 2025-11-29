import React from 'react';
import type { SpinLogRow } from '../types';

interface ResultsPanelProps {
  rows: SpinLogRow[];
  loading?: boolean;
  error?: string | null;
  onReroll?: (row: SpinLogRow) => void;
}

export const ResultsPanel: React.FC<ResultsPanelProps> = ({
  rows,
  loading,
  error,
  onReroll,
}) => {
  if (loading) {
    return <div className="text-gray-500 text-sm p-4">Loading spins...</div>;
  }

  if (error) {
    return <div className="text-red-500 text-sm p-4">Error: {error}</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="text-gray-500 text-sm p-4">
        No spins recorded yet for this date/period.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Time</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Name</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Period</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Region</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Taxon</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">IUCN</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Flags</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {rows.map((row, idx) => {
            const timeStr = new Date(row.timestamp_iso).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
            
            const flags = [
              ...(row.rule_flags || []),
              row.plantae_mercy ? 'Mercy' : null,
              row.veto_used ? 'Veto' : null,
            ].filter(Boolean);

            return (
              <tr key={idx} className="hover:bg-gray-50">
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{timeStr}</td>
                <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-900">
                  {row.student_name || '(none)'}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{row.period}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{row.result_region}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{row.result_taxon}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{row.result_iucn}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-wrap gap-1">
                    {flags.map((flag, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          flag === 'Mercy'
                            ? 'bg-green-100 text-green-800'
                            : flag === 'Veto'
                            ? 'bg-red-100 text-red-800'
                            : flag === 'wildcard_iucn'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {onReroll && (
                    <button
                      onClick={() => onReroll(row)}
                      className="text-indigo-600 hover:text-indigo-900 text-xs font-medium border border-indigo-200 rounded px-2 py-1 hover:bg-indigo-50 transition-colors"
                    >
                      Re-roll
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
