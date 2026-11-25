import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../data/context';
import { backupStatus, describeBackup, type BackupStatus } from '../data/local/workspaces';

/**
 * Always-visible statement of where classroom data is being kept.
 * `revision` changes whenever the page saved something, so the backup line stays current.
 */
export function StorageBadge({ revision = 0 }: { revision?: number }) {
  const { mode, store, workspace, storageProblem } = useData();
  const [status, setStatus] = useState<BackupStatus | null>(null);

  useEffect(() => {
    if (mode !== 'local') return;
    let cancelled = false;
    store
      .getBundle(workspace.id)
      .then((bundle) => {
        if (!cancelled && bundle) setStatus(backupStatus(bundle));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mode, store, workspace.id, workspace.rev, workspace.lastBackupAt, revision]);

  if (mode === 'connected') {
    return (
      <p className="rounded-lg border border-line px-3 py-2 text-sm" data-testid="storage-badge" data-mode="connected">
        <span className="font-bold">Connected Mode.</span> Data is read from and saved to your Google Sheet.{' '}
        <Link to="/admin" className="underline">
          Connection
        </Link>
      </p>
    );
  }

  const tone = storageProblem || !store.persistent ? 'border-bad text-bad' : status && status.state !== 'current' ? 'border-sun' : 'border-line';

  return (
    <p className={`rounded-lg border px-3 py-2 text-sm ${tone}`} data-testid="storage-badge" data-mode="local" data-backup={status?.state}>
      <span className="font-bold">Local Mode.</span> Class "{workspace.name}" is stored in this browser only.{' '}
      {storageProblem ? (
        <span className="font-bold">Not being kept after this tab closes. </span>
      ) : (
        <span data-testid="backup-status">{status ? `${describeBackup(status)}. ` : ''}</span>
      )}
      <Link to="/classes" className="underline">
        Classes and backups
      </Link>
    </p>
  );
}
