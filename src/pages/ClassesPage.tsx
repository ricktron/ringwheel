import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { describeError } from '../api';
import { ApiStatusIndicator } from '../components/ApiStatusIndicator';
import { StorageBadge } from '../components/StorageBadge';
import { useData } from '../data/context';
import { parseRosterCsv, planRosterImport, rosterToCsv, sameStudent, spinsToCsv, type RosterImportPlan } from '../data/local/csv';
import { LIMITS, parseBackupText, type BackupFile, type LocalStudent, type Workspace } from '../data/local/schema';
import { stampOf, type RecoveryPoint } from '../data/local/store';
import {
  addStudents,
  addWorkspace,
  applyRecoveryPoint,
  backupStatus,
  clearAllData,
  confirmBackup,
  deleteWorkspace,
  describeBackup,
  exportBackup,
  isUntouchedStarter,
  removeStudent,
  renameWorkspace,
  restoreBackup,
  updateStudent,
  type BackupStatus,
  type SeenClasses,
} from '../data/local/workspaces';
import { saveActiveWorkspaceId } from '../data/mode';

type Notice = { text: string; isError: boolean } | null;

interface ClassInfo {
  spins: number;
  backup: BackupStatus;
  /** Fingerprint of the class (roster, settings and spin history) as this page last showed it. */
  stamp: string;
}

interface PendingBackup {
  backup: BackupFile;
  filename: string;
}

/** Hand a file to the browser's download flow. The data never leaves this computer. */
function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileSafe = (name: string): string => name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'class';
const today = (): string => new Date().toISOString().slice(0, 10);

export const ClassesPage = () => {
  const { mode, store, workspaces, workspace, storageProblem, selectWorkspace, refresh } = useData();

  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<Record<string, ClassInfo>>({});
  /** Goes up each time the details below are re-read, so the status line at the top re-reads too. */
  const [detailsRevision, setDetailsRevision] = useState(0);
  const [recovery, setRecovery] = useState<RecoveryPoint[]>([]);
  const [protectedStorage, setProtectedStorage] = useState<boolean | null>(null);
  /** Bumped when a change fails, so roster fields snap back to what is actually stored. */
  const [rosterNonce, setRosterNonce] = useState(0);

  const [newClassName, setNewClassName] = useState('');
  const [renameTo, setRenameTo] = useState(workspace.name);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  const [csvText, setCsvText] = useState('');
  const [importPlan, setImportPlan] = useState<RosterImportPlan | null>(null);

  /** A backup file handed to the browser that the teacher has not yet said they have. */
  const [pendingBackup, setPendingBackup] = useState<PendingBackup | null>(null);
  const [restoreFile, setRestoreFile] = useState<{ name: string; backup: BackupFile } | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<string[]>([]);

  const [clearText, setClearText] = useState('');

  // If the stored name of the selected class changes underneath the page (a restore, an undo,
  // another tab), the rename box follows it instead of offering the old name back.
  const [nameShown, setNameShown] = useState(workspace.name);
  if (nameShown !== workspace.name) {
    setNameShown(workspace.name);
    setRenameTo(workspace.name);
  }

  // Reset the per-class forms when another class is selected (state adjusted during render).
  const [formsFor, setFormsFor] = useState(workspace.id);
  if (formsFor !== workspace.id) {
    setFormsFor(workspace.id);
    setRenameTo(workspace.name);
    setImportPlan(null);
    setCsvText('');
    setDuplicateWarning(false);
  }

  /** Re-read counts, backup status and recovery points from browser storage. */
  const reloadDetails = useCallback(async () => {
    const next: Record<string, ClassInfo> = {};
    for (const candidate of await store.listWorkspaces()) {
      const bundle = await store.getBundle(candidate.id);
      if (bundle) next[candidate.id] = { spins: bundle.spins.length, backup: backupStatus(bundle), stamp: stampOf(bundle) };
    }
    setInfo(next);
    setRecovery(await store.listRecoveryPoints());
    setDetailsRevision((n) => n + 1);
  }, [store]);

  // Also re-read whenever the list of classes on screen changes.
  useEffect(() => {
    reloadDetails().catch(() => undefined);
  }, [reloadDetails, workspaces]);

  /**
   * What is on screen right now, for the storage to check a destructive action against.
   * If another tab has logged a spin or edited a roster since, the action is refused.
   */
  const seen = (): SeenClasses => Object.fromEntries(Object.entries(info).map(([id, details]) => [id, details.stamp]));

  useEffect(() => {
    navigator.storage
      ?.persisted?.()
      .then(setProtectedStorage)
      .catch(() => setProtectedStorage(null));
  }, []);

  /** Run one storage action, then refresh what is on screen. Errors are shown, never swallowed. */
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const message = await action();
      await refresh();
      await reloadDetails();
      if (message) setNotice({ text: message, isError: false });
    } catch (err) {
      // Show what is really stored before reporting the problem, so a retry acts on the current version.
      await refresh().catch(() => undefined);
      await reloadDetails().catch(() => undefined);
      setRosterNonce((n) => n + 1);
      setNotice({ text: describeError(err), isError: true });
    } finally {
      setBusy(false);
    }
  };

  // --- Classes ---------------------------------------------------------------

  const handleCreateClass = (e: FormEvent) => {
    e.preventDefault();
    const name = newClassName.trim();
    if (!name) return;
    run(async () => {
      const created = await addWorkspace(store, name);
      selectWorkspace(created.id);
      setNewClassName('');
      return `Class "${created.name}" created. It starts with no students and no history.`;
    });
  };

  const handleRename = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const renamed = await renameWorkspace(store, workspace, renameTo);
      return `Class renamed to "${renamed.name}".`;
    });
  };

  const handleDeleteClass = (target: Workspace) =>
    run(async () => {
      setConfirmDeleteId(null);
      await deleteWorkspace(store, target.id, info[target.id]?.stamp ?? '');
      return `Class "${target.name}" was deleted. You can undo this under Recovery below.`;
    });

  // --- Roster ----------------------------------------------------------------

  const addOneStudent = () =>
    run(async () => {
      await addStudents(store, workspace, [{ name: studentName, email: studentEmail }]);
      setStudentName('');
      setStudentEmail('');
      setDuplicateWarning(false);
    });

  const handleAddStudent = (e: FormEvent) => {
    e.preventDefault();
    if (!studentName.trim()) return;
    const candidate = { name: studentName, email: studentEmail };
    if (!duplicateWarning && workspace.students.some((student) => sameStudent(student, candidate))) {
      setDuplicateWarning(true);
      return;
    }
    addOneStudent();
  };

  const saveStudentField = (student: LocalStudent, field: 'name' | 'email', value: string) => {
    if (value.trim() === student[field]) return;
    run(async () => {
      await updateStudent(store, workspace, student.id, { [field]: value });
    });
  };

  // --- CSV import --------------------------------------------------------------

  const checkCsv = (text: string) => {
    const parsed = parseRosterCsv(text);
    if (parsed.errors.length > 0) {
      setImportPlan(null);
      setNotice({ text: `Nothing was imported. ${parsed.errors.join(' ')}`, isError: true });
      return;
    }
    setNotice(null);
    setImportPlan(planRosterImport(workspace.students, parsed.candidates));
  };

  const handleCsvFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setNotice({ text: 'Nothing was imported. The file is larger than 1 MB. A class roster should be much smaller.', isError: true });
      return;
    }
    const text = await file.text();
    setCsvText(text);
    checkCsv(text);
  };

  const applyImport = () => {
    if (!importPlan || importPlan.toAdd.length === 0) return;
    const count = importPlan.toAdd.length;
    run(async () => {
      await addStudents(store, workspace, importPlan.toAdd);
      setImportPlan(null);
      setCsvText('');
      return `${count} student${count === 1 ? '' : 's'} added to "${workspace.name}".`;
    });
  };

  // --- Backup and restore ------------------------------------------------------

  const classCount = (backup: BackupFile) => `${backup.workspaces.length} class${backup.workspaces.length === 1 ? '' : 'es'}`;

  /**
   * Build the backup and hand it to the browser. Nothing is recorded as backed up here:
   * the page cannot see whether the browser saved the file, so the teacher is asked.
   */
  const handleBackup = (ids: string[] | undefined, label: string) =>
    run(async () => {
      setPendingBackup(null);
      const backup = await exportBackup(store, ids);
      const filename = `ringwheel-backup-${fileSafe(label)}-${today()}.json`;
      try {
        download(filename, JSON.stringify(backup, null, 2), 'application/json');
      } catch (err) {
        throw new Error(`The browser did not accept the download, so no backup was recorded (${describeError(err)}). Nothing in your classes changed.`);
      }
      setPendingBackup({ backup, filename });
    });

  const handleBackupConfirmed = () => {
    if (!pendingBackup) return;
    const { backup } = pendingBackup;
    run(async () => {
      await confirmBackup(store, backup);
      setPendingBackup(null);
      return `Backup recorded (${classCount(backup)}). Keep the file somewhere safe: it contains student names.`;
    });
  };

  const handleBackupNotSaved = () => {
    setPendingBackup(null);
    setNotice({ text: 'No backup was recorded. Your classes are unchanged. Try the download again when you are ready.', isError: true });
  };

  const handleSpinsCsv = () =>
    run(async () => {
      const spins = await store.listSpins(workspace.id);
      download(`ringwheel-spins-${fileSafe(workspace.name)}-${today()}.csv`, spinsToCsv(spins), 'text/csv');
    });

  const handleRosterCsv = () =>
    download(`ringwheel-roster-${fileSafe(workspace.name)}-${today()}.csv`, rosterToCsv(workspace.students), 'text/csv');

  const handleRestoreFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setRestoreFile(null);
    setRestoreErrors([]);
    if (!file) return;
    if (file.size > LIMITS.backupBytes) {
      setRestoreErrors(['The file is too large to be a RingWheel backup.']);
      return;
    }
    // The file is fully checked here. Nothing in the browser changes until a button below is pressed.
    const checked = parseBackupText(await file.text());
    if (checked.ok) setRestoreFile({ name: file.name, backup: checked.backup });
    else setRestoreErrors(checked.errors);
  };

  const handleRestore = (restoreMode: 'add' | 'replace') => {
    if (!restoreFile) return;
    run(async () => {
      const summary = await restoreBackup(store, restoreFile.backup, restoreMode, seen());
      setRestoreFile(null);
      const parts = [
        summary.added.length > 0 ? `Added: ${summary.added.join(', ')}.` : '',
        summary.replaced.length > 0 ? `Replaced: ${summary.replaced.join(', ')}. The previous version is under Recovery below.` : '',
      ].filter(Boolean);
      return `Restore finished. ${parts.join(' ')}`;
    });
  };

  const handleUndo = (point: RecoveryPoint) =>
    run(async () => {
      await applyRecoveryPoint(store, point, seen());
      return `Restored: ${point.bundles.map((bundle) => bundle.workspace.name).join(', ')}.`;
    });

  const handleDiscardRecovery = (point: RecoveryPoint) =>
    run(async () => {
      await store.deleteRecoveryPoint(point.id);
    });

  const handleClearAll = () =>
    run(async () => {
      await clearAllData(store, seen());
      saveActiveWorkspaceId('');
      setClearText('');
      return 'All RingWheel classes, rosters, history and recovery points were deleted from this browser.';
    });

  const handleProtect = async () => {
    try {
      const granted = (await navigator.storage?.persist?.()) ?? false;
      setProtectedStorage(granted);
      setNotice(
        granted
          ? { text: 'The browser agreed to keep this data unless you remove it yourself.', isError: false }
          : { text: 'The browser did not agree to protect this data. Keep downloading backups.', isError: true }
      );
    } catch (err) {
      setNotice({ text: describeError(err), isError: true });
    }
  };

  // The empty starter class holds nothing, so a restore replaces it without it counting as "already here".
  const existingIds = new Set(
    workspaces
      .filter((candidate) => !isUntouchedStarter(candidate, info[candidate.id]?.spins ?? 0))
      .map((candidate) => candidate.id)
  );
  const restoreMatches = restoreFile ? restoreFile.backup.workspaces.filter((bundle) => existingIds.has(bundle.workspace.id)) : [];
  const activeCount = workspace.students.filter((student) => student.active).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl font-extrabold text-sun">Classes and backups</h1>
        <div className="flex items-center gap-4">
          <ApiStatusIndicator />
          <Link to="/admin" className="btn">
            Admin
          </Link>
          <Link to="/spin" className="btn btn-primary">
            Back to spinner
          </Link>
        </div>
      </header>

      <StorageBadge revision={detailsRevision} />

      {mode === 'connected' && (
        <p className="rounded-xl border border-sun bg-sun/10 p-4" data-testid="classes-connected-note">
          Connected Mode is on, so the spinner is using your Google Sheet. The classes on this page are separate. They
          stay in this browser and are not sent to the Sheet.
        </p>
      )}

      {(storageProblem || !store.persistent) && (
        <p className="rounded-xl border-2 border-bad bg-bad/10 p-4 font-semibold text-bad" role="alert" data-testid="storage-problem">
          {storageProblem ?? 'This browser is not keeping data after the tab closes. Download a backup before you leave.'}
        </p>
      )}

      {notice && (
        <div
          className={`rounded-xl border-2 p-4 font-semibold ${notice.isError ? 'border-bad bg-bad/10 text-bad' : 'border-good bg-good/10 text-good'}`}
          role={notice.isError ? 'alert' : 'status'}
          data-testid="classes-notice"
        >
          {notice.text}
        </div>
      )}

      <section className="panel" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading" className="mb-2 text-2xl font-bold">
          Where this data lives
        </h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>Classes, students and spin history on this page are stored in this browser, on this computer, and nowhere else.</li>
          <li>Nothing here is uploaded. Another computer, another browser, or a private window will not have it.</li>
          <li>
            <strong>Browser storage is not a backup.</strong> Clearing site data, or the browser running low on space, can
            remove it. Download a backup file regularly.
          </li>
        </ul>
        <p className="mt-3 text-sm" data-testid="storage-protection">
          {protectedStorage === true && 'The browser has agreed to keep this data unless you remove it yourself.'}
          {protectedStorage === false && 'The browser may remove this data if the computer runs low on space.'}
          {protectedStorage === null && 'This browser does not say whether it will keep the data long term.'}
        </p>
        {protectedStorage === false && (
          <button type="button" className="btn mt-2" onClick={handleProtect}>
            Ask the browser to protect this data
          </button>
        )}
      </section>

      <section className="panel" aria-labelledby="classes-heading">
        <h2 id="classes-heading" className="mb-3 text-2xl font-bold">
          Classes
        </h2>
        <ul className="space-y-2" data-testid="class-list">
          {workspaces.map((candidate) => {
            const details = info[candidate.id];
            const isActive = candidate.id === workspace.id;
            return (
              <li
                key={candidate.id}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${isActive ? 'border-sun bg-sun/10' : 'border-line'}`}
              >
                <label className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="active-class"
                    checked={isActive}
                    onChange={() => selectWorkspace(candidate.id)}
                    disabled={busy}
                  />
                  <span>
                    <span className="font-bold">{candidate.name}</span>
                    <span className="block text-sm text-ink-dim">
                      {candidate.students.length} student{candidate.students.length === 1 ? '' : 's'}
                      {details ? `, ${details.spins} spin${details.spins === 1 ? '' : 's'}. ${describeBackup(details.backup)}.` : ''}
                    </span>
                  </span>
                </label>
                {confirmDeleteId === candidate.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">Delete this class and its history?</span>
                    <button type="button" className="btn btn-danger" onClick={() => handleDeleteClass(candidate)} disabled={busy}>
                      Yes, delete "{candidate.name}"
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirmDeleteId(null)}>
                      Keep it
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn" onClick={() => setConfirmDeleteId(candidate.id)} disabled={busy}>
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <form onSubmit={handleCreateClass} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="eyebrow">New class name</span>
              <input
                className="field"
                value={newClassName}
                maxLength={LIMITS.nameLength}
                onChange={(e) => setNewClassName(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || !newClassName.trim()}>
              Add class
            </button>
          </form>
          <form onSubmit={handleRename} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="eyebrow">Rename selected class</span>
              <input className="field" value={renameTo} maxLength={LIMITS.nameLength} onChange={(e) => setRenameTo(e.target.value)} />
            </label>
            <button type="submit" className="btn" disabled={busy || !renameTo.trim() || renameTo.trim() === workspace.name}>
              Rename
            </button>
          </form>
        </div>
      </section>

      <section className="panel" aria-labelledby="roster-heading">
        <h2 id="roster-heading" className="mb-1 text-2xl font-bold">
          Roster for "{workspace.name}"
        </h2>
        <p className="mb-3 text-sm text-ink-dim" data-testid="roster-count">
          {workspace.students.length} student{workspace.students.length === 1 ? '' : 's'}, {activeCount} in the spin queue.
          Untick "In queue" to keep a student on the roster without spinning them.
        </p>

        {workspace.students.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-full text-sm" data-testid="roster-table">
              <thead className="bg-panel-raised text-left text-ink-dim">
                <tr>
                  <th scope="col" className="px-3 py-2">Name</th>
                  <th scope="col" className="px-3 py-2">Email (optional)</th>
                  <th scope="col" className="px-3 py-2">In queue</th>
                  <th scope="col" className="px-3 py-2">Remove</th>
                </tr>
              </thead>
              <tbody>
                {workspace.students.map((student) => (
                  <tr key={`${student.id}:${workspace.rev}:${rosterNonce}`} className="border-t border-line">
                    <td className="px-3 py-2">
                      <input
                        className="field w-full"
                        aria-label={`Name of ${student.name}`}
                        defaultValue={student.name}
                        maxLength={LIMITS.nameLength}
                        onBlur={(e) => saveStudentField(student, 'name', e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className="field w-full"
                        aria-label={`Email of ${student.name}`}
                        defaultValue={student.email}
                        maxLength={LIMITS.nameLength}
                        onBlur={(e) => saveStudentField(student, 'email', e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        aria-label={`${student.name} is in the spin queue`}
                        defaultChecked={student.active}
                        disabled={busy}
                        onChange={(e) =>
                          run(async () => {
                            await updateStudent(store, workspace, student.id, { active: e.target.checked });
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="btn text-xs"
                        aria-label={`Remove ${student.name}`}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await removeStudent(store, workspace, student.id);
                            return `${student.name} was removed from the roster. Their past spins stay in the history.`;
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={handleAddStudent} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Student name</span>
            <input
              className="field"
              value={studentName}
              maxLength={LIMITS.nameLength}
              onChange={(e) => {
                setStudentName(e.target.value);
                setDuplicateWarning(false);
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Email (optional)</span>
            <input
              className="field"
              value={studentEmail}
              maxLength={LIMITS.nameLength}
              onChange={(e) => {
                setStudentEmail(e.target.value);
                setDuplicateWarning(false);
              }}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !studentName.trim()}>
            {duplicateWarning ? 'Add anyway' : 'Add student'}
          </button>
        </form>
        {duplicateWarning && (
          <p className="mt-2 font-semibold text-sun" role="alert" data-testid="duplicate-warning">
            A student with this name or email is already on the roster. Press "Add anyway" if this is a different person.
          </p>
        )}

        <h3 className="mt-6 mb-1 text-lg font-semibold text-ember">Import from a CSV file</h3>
        <p className="mb-2 text-sm text-ink-dim">
          Use a header row with <code>name</code> (or <code>first</code> and <code>last</code>) and optionally{' '}
          <code>email</code>, or a plain list with one name per line. You will see what would change before anything is
          added.
        </p>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">CSV file</span>
          <input type="file" accept=".csv,text/csv,text/plain" className="field" onChange={handleCsvFile} data-testid="csv-file" />
        </label>
        <label className="mt-3 flex flex-col gap-1">
          <span className="eyebrow">Or paste the list here</span>
          <textarea
            className="field min-h-24 font-mono text-sm"
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value);
              setImportPlan(null);
            }}
          />
        </label>
        <button type="button" className="btn mt-2" onClick={() => checkCsv(csvText)} disabled={busy || !csvText.trim()}>
          Check the list
        </button>

        {importPlan && (
          <div className="mt-3 rounded-lg border border-line p-3" data-testid="import-preview">
            <p className="font-semibold">
              {importPlan.toAdd.length} student{importPlan.toAdd.length === 1 ? '' : 's'} would be added.{' '}
              {importPlan.skipped.length} would be skipped.
            </p>
            {importPlan.toAdd.length > 0 && (
              <p className="mt-1 text-sm">
                <span className="text-ink-dim">To add: </span>
                {importPlan.toAdd.map((candidate) => candidate.name).join(', ')}
              </p>
            )}
            {importPlan.skipped.length > 0 && (
              <ul className="mt-1 list-disc pl-6 text-sm text-ink-dim">
                {importPlan.skipped.map(({ candidate, reason }) => (
                  <li key={candidate.line}>
                    Line {candidate.line}: {candidate.name || '(blank)'} ({reason})
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn btn-primary" onClick={applyImport} disabled={busy || importPlan.toAdd.length === 0}>
                Add {importPlan.toAdd.length} student{importPlan.toAdd.length === 1 ? '' : 's'}
              </button>
              <button type="button" className="btn" onClick={() => setImportPlan(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="backup-heading">
        <h2 id="backup-heading" className="mb-1 text-2xl font-bold">
          Backup and export
        </h2>
        <p className="mb-3 text-sm text-ink-dim">
          A backup file holds everything about a class: roster, settings and full spin history. It can be restored in
          this or any other browser. The files contain student names, so store them as you would a gradebook.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => handleBackup([workspace.id], workspace.name)} disabled={busy}>
            Back up "{workspace.name}"
          </button>
          <button type="button" className="btn" onClick={() => handleBackup(undefined, 'all-classes')} disabled={busy}>
            Back up all classes
          </button>
          <button type="button" className="btn" onClick={handleSpinsCsv} disabled={busy}>
            Spin history as CSV
          </button>
          <button type="button" className="btn" onClick={handleRosterCsv} disabled={busy}>
            Roster as CSV
          </button>
        </div>

        {pendingBackup && (
          <div className="mt-3 rounded-lg border-2 border-sun bg-sun/10 p-3" role="status" data-testid="backup-confirm">
            <p className="font-bold">Did the backup file save?</p>
            <p className="mt-1 text-sm">
              RingWheel handed <span className="font-mono break-all">{pendingBackup.filename}</span> ({classCount(pendingBackup.backup)}) to
              your browser. It cannot see whether the browser actually saved it: a download can be blocked or cancelled.
              Check your downloads folder, then answer. Until you do, no backup is recorded.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={handleBackupConfirmed} disabled={busy} data-testid="backup-confirm-yes">
                Yes, I have the file
              </button>
              <button type="button" className="btn" onClick={handleBackupNotSaved} disabled={busy} data-testid="backup-confirm-no">
                No, it did not save
              </button>
            </div>
          </div>
        )}

        <h3 className="mt-6 mb-1 text-lg font-semibold text-ember">Restore from a backup file</h3>
        <p className="mb-2 text-sm text-ink-dim">
          The file is checked first. Nothing in this browser changes until you choose one of the options that appear.
        </p>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Backup file (.json)</span>
          <input type="file" accept=".json,application/json" className="field" onChange={handleRestoreFile} data-testid="restore-file" />
        </label>

        {restoreErrors.length > 0 && (
          <div className="mt-3 rounded-lg border-2 border-bad bg-bad/10 p-3 text-bad" role="alert" data-testid="restore-errors">
            <p className="font-bold">This file was not restored. Nothing was changed.</p>
            <ul className="mt-1 list-disc pl-6 text-sm">
              {restoreErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {restoreFile && (
          <div className="mt-3 rounded-lg border border-line p-3" data-testid="restore-preview">
            <p className="font-semibold">
              "{restoreFile.name}" is a valid backup from {new Date(restoreFile.backup.exportedAt).toLocaleString()}.
            </p>
            <ul className="mt-1 list-disc pl-6 text-sm">
              {restoreFile.backup.workspaces.map((bundle) => (
                <li key={bundle.workspace.id}>
                  {bundle.workspace.name}: {bundle.workspace.students.length} students, {bundle.spins.length} spins
                  {existingIds.has(bundle.workspace.id) ? ' (this class already exists in this browser)' : ''}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={() => handleRestore('add')} disabled={busy} data-testid="restore-add">
                Add as new class{restoreFile.backup.workspaces.length === 1 ? '' : 'es'} (changes nothing that is already here)
              </button>
              {restoreMatches.length > 0 && (
                <button type="button" className="btn btn-danger" onClick={() => handleRestore('replace')} disabled={busy} data-testid="restore-replace">
                  Replace {restoreMatches.map((bundle) => `"${bundle.workspace.name}"`).join(', ')} with the backup
                </button>
              )}
              <button type="button" className="btn" onClick={() => setRestoreFile(null)}>
                Cancel
              </button>
            </div>
            {restoreMatches.length > 0 && (
              <p className="mt-2 text-sm text-ink-dim">
                Replacing keeps a copy of the current version under Recovery, so it can be undone.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="recovery-heading">
        <h2 id="recovery-heading" className="mb-1 text-2xl font-bold">
          Recovery
        </h2>
        <p className="mb-3 text-sm text-ink-dim">
          Before a class is deleted or replaced, a copy is kept here. The five most recent copies are kept.
        </p>
        {recovery.length === 0 ? (
          <p className="text-ink-dim">Nothing to recover.</p>
        ) : (
          <ul className="space-y-2" data-testid="recovery-list">
            {recovery.map((point) => (
              <li key={point.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3">
                <span>
                  <span className="font-semibold">{point.reason}</span>
                  <span className="block text-sm text-ink-dim">
                    {new Date(point.takenAt).toLocaleString()}: {point.bundles.map((bundle) => `${bundle.workspace.name} (${bundle.workspace.students.length} students, ${bundle.spins.length} spins)`).join(', ')}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button type="button" className="btn btn-primary" onClick={() => handleUndo(point)} disabled={busy}>
                    Put it back
                  </button>
                  <button type="button" className="btn" onClick={() => handleDiscardRecovery(point)} disabled={busy}>
                    Discard copy
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel border-bad" aria-labelledby="clear-heading">
        <h2 id="clear-heading" className="mb-1 text-2xl font-bold text-bad">
          Delete everything in this browser
        </h2>
        <p className="mb-3 text-sm">
          Removes every class, roster, spin history and recovery copy that RingWheel stored in this browser. This cannot
          be undone. Download a backup first if you might need any of it. It does not touch a Google Sheet.
        </p>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Type DELETE to confirm</span>
          <input className="field w-48" value={clearText} onChange={(e) => setClearText(e.target.value)} autoComplete="off" data-testid="clear-confirm" />
        </label>
        <button type="button" className="btn btn-danger mt-3" onClick={handleClearAll} disabled={busy || clearText !== 'DELETE'} data-testid="clear-all">
          Delete all RingWheel data in this browser
        </button>
      </section>
    </div>
  );
};
