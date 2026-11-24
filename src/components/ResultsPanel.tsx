import type { SpinLogRow } from '../types';

interface ResultsPanelProps {
  rows: SpinLogRow[];
  loading?: boolean;
  error?: string | null;
  onReroll?: (row: SpinLogRow) => void;
}

/** Today's spins as recorded in the SpinsLog sheet. */
export const ResultsPanel = ({ rows, loading, error, onReroll }: ResultsPanelProps) => {
  if (loading) {
    return <p className="text-ink-dim">Loading spins…</p>;
  }

  if (error) {
    return (
      <p className="text-bad" role="alert">
        {error}
      </p>
    );
  }

  if (rows.length === 0) {
    return <p className="text-ink-dim">No spins recorded yet for this date and period.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="min-w-full text-sm" data-testid="logged-spins">
        <thead className="bg-panel-raised text-left text-ink-dim">
          <tr>
            {['Time', 'Name', 'Period', 'Region', 'Taxon', 'IUCN', 'Flags', 'Actions'].map((heading) => (
              <th key={heading} scope="col" className="px-3 py-2 font-semibold">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const timeStr = new Date(row.timestamp_iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const flags = [
              ...row.rule_flags,
              row.plantae_mercy ? 'Mercy' : null,
              row.veto_used ? 'Veto' : null,
              row.is_test ? 'Test' : null,
            ].filter((flag): flag is string => Boolean(flag));

            return (
              <tr key={`${row.timestamp_iso}-${idx}`} className="border-t border-line">
                <td className="px-3 py-2 whitespace-nowrap text-ink-dim">{timeStr}</td>
                <td className="px-3 py-2 whitespace-nowrap font-semibold">{row.student_name || '(none)'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-ink-dim">{row.period}</td>
                <td className="px-3 py-2 whitespace-nowrap">{row.result_region}</td>
                <td className="px-3 py-2 whitespace-nowrap">{row.result_taxon}</td>
                <td className="px-3 py-2 whitespace-nowrap">{row.result_iucn}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {flags.map((flag) => (
                      <span key={flag} className="rounded border border-line px-2 py-0.5 text-xs text-ink-dim">
                        {flag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {onReroll && (
                    <button type="button" className="btn text-xs" onClick={() => onReroll(row)}>
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
