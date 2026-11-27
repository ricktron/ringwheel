/**
 * Presentation Draw operations on Local Mode data.
 *
 * Every write here goes through `store.updatePresentation`, or, where a new
 * class is created from an old one, `store.continuePresentation`. Both check
 * that the class is still what the caller last saw, validate and replay the
 * result, and check its size, all in one step. Nothing in this file makes a
 * network request.
 *
 * There is no screen for any of this yet. These are the operations the
 * screens will call.
 */
import { act, type DrawAction } from '../../presentation/actions';
import { presentationFileBytes, presentationUsage, type PresentationUsage } from '../../presentation/capacity';
import { buildContinuation, type CarryMarker } from '../../presentation/carry-over';
import { drawOrder, editDraft, newDraft, retitle, type DraftPatch } from '../../presentation/draw';
import { emptyPresentation, markMoved, markReopened, setPresenting } from '../../presentation/eligibility';
import {
  PRESENTATION_LIMITS,
  PresentationError,
  type DateKey,
  type InactiveReason,
  type PresentationData,
  type PresentationDraw,
  type PresentationToken,
  type Timing,
} from '../../presentation/types';
import { randomSeed } from '../../utils/spin-engine';
import { LIMITS, PRESENTATION_SCHEMA_VERSION, newId, type BackupFile, type Workspace } from './schema';
import { StoreMissingError, presentationTokenOf, type WorkspaceStore } from './store';

export { presentationTokenOf };

/** How full a class's presentation history is, in the same bytes a backup file would hold. */
export const usageOf = (workspace: Workspace): PresentationUsage => presentationUsage(workspace.presentation);

function changeDraw(data: PresentationData | undefined, drawId: string, change: (draw: PresentationDraw) => PresentationDraw): PresentationData {
  if (!data) throw new PresentationError('This class has no presentation draws.');
  const index = data.draws.findIndex((draw) => draw.id === drawId);
  if (index < 0) throw new PresentationError('That draw is no longer in this class.');
  const draws = [...data.draws];
  draws[index] = change(draws[index]);
  return { ...data, draws };
}

/** Create a draft. This is the first thing that writes presentation data to a class. */
export async function createDraw(
  store: WorkspaceStore,
  workspaceId: string,
  expected: PresentationToken,
  title: string,
  options: { now?: Date; id?: string; timing?: Timing } = {}
): Promise<{ workspace: Workspace; drawId: string }> {
  const drawId = options.id ?? newId();
  const at = (options.now ?? new Date()).toISOString();
  const workspace = await store.updatePresentation(workspaceId, expected, (current) => {
    const data = current ?? emptyPresentation();
    return { ...data, draws: [...data.draws, newDraft(drawId, title, at, options.timing)] };
  });
  return { workspace, drawId };
}

/** Change a draft before its order is drawn. */
export function changeDraft(store: WorkspaceStore, workspaceId: string, expected: PresentationToken, drawId: string, patch: DraftPatch): Promise<Workspace> {
  return store.updatePresentation(workspaceId, expected, (current) => changeDraw(current, drawId, (draw) => editDraft(draw, patch)));
}

/** Change a draw's title. A label only: not part of the order or its history. */
export function renameDraw(store: WorkspaceStore, workspaceId: string, expected: PresentationToken, drawId: string, title: string): Promise<Workspace> {
  return store.updatePresentation(workspaceId, expected, (current) => changeDraw(current, drawId, (draw) => retitle(draw, title)));
}

/** Discard a draft that was never drawn. A draw with an order can be archived but never removed. */
export function discardDraft(store: WorkspaceStore, workspaceId: string, expected: PresentationToken, drawId: string): Promise<Workspace> {
  return store.updatePresentation(workspaceId, expected, (current) => {
    const draw = current?.draws.find((d) => d.id === drawId);
    if (!current || !draw) throw new PresentationError('That draw is no longer in this class.');
    if (draw.order !== null) throw new PresentationError('This draw has a drawn order, which is kept permanently. It can be archived instead.');
    return { ...current, draws: current.draws.filter((d) => d.id !== drawId) };
  });
}

/** Draw the order (or redraw it, while nothing has been revealed). The seed comes from the browser's secure generator. */
export function drawTheOrder(
  store: WorkspaceStore,
  workspaceId: string,
  expected: PresentationToken,
  drawId: string,
  options: { now?: Date; seed?: string } = {}
): Promise<Workspace> {
  const at = (options.now ?? new Date()).toISOString();
  const seed = options.seed ?? randomSeed();
  return store.updatePresentation(workspaceId, expected, (current, workspace) =>
    changeDraw(current, drawId, (draw) => drawOrder(draw, { roster: workspace.students, inactive: current?.inactive ?? [], seed, at }))
  );
}

/** One teacher action on a drawn order. `today` is the calendar day on the teacher's computer. */
export function performAction(
  store: WorkspaceStore,
  workspaceId: string,
  expected: PresentationToken,
  drawId: string,
  action: DrawAction,
  when: { now?: Date; today: DateKey }
): Promise<Workspace> {
  const at = (when.now ?? new Date()).toISOString();
  return store.updatePresentation(workspaceId, expected, (current, workspace) =>
    changeDraw(current, drawId, (draw) => act(draw, action, { roster: workspace.students, inactive: current?.inactive ?? [], today: when.today, at }))
  );
}

/** Class level: mark a student as presenting, or not presenting, in this class. Never touches the roster or "In queue". */
export function setStudentPresenting(
  store: WorkspaceStore,
  workspaceId: string,
  expected: PresentationToken,
  studentId: string,
  presenting: boolean,
  reason: InactiveReason = 'teacher_choice',
  now: Date = new Date()
): Promise<Workspace> {
  return store.updatePresentation(workspaceId, expected, (current, workspace) => {
    if (!presenting && !workspace.students.some((student) => student.id === studentId)) throw new PresentationError('That student is not on the roster.');
    return setPresenting(current ?? emptyPresentation(), studentId, presenting, reason, now.toISOString());
  });
}

// ---------------------------------------------------------------------------
// Continue in a new class
// ---------------------------------------------------------------------------

/** Thrown when the class that should receive a continuation already exists and is something else. Nothing was overwritten. */
export class ContinuationConflictError extends Error {
  constructor() {
    super('A different class already exists where this continuation was going to be created. Nothing was overwritten.');
    this.name = 'ContinuationConflictError';
  }
}

export interface ContinuationResult {
  destinationId: string;
  /** False when the new class was already there from an earlier attempt, in this tab or another. */
  created: boolean;
}

const markerOf = (sourceId: string, data: PresentationData): CarryMarker => {
  if (!data.movedTo) throw new PresentationError('Presentations for this class are not marked as continued elsewhere.');
  const entry = [...data.classLog].reverse().find((item) => item.t === 'moved');
  return { sourceClassId: sourceId, n: entry ? entry.n : data.classLog.length, at: data.movedTo.at, on: data.movedTo.on };
};

const isContinuationOf = (workspace: Workspace, marker: CarryMarker): boolean =>
  workspace.presentation?.continuedFrom?.classId === marker.sourceClassId && workspace.presentation.continuedFrom.marker === marker.n;

/**
 * Thrown when the class a continuation went to is no longer here and the old
 * class's roster, settings or ring weights have changed since it was frozen.
 * The class as it was at that moment cannot be rebuilt, so nothing is created
 * unless the caller says the class as it is now should be used.
 */
export class ContinuationChangedError extends Error {
  constructor() {
    super(
      'The class these presentations were continued in is no longer here, and this class has changed since then. Nothing was created. Put the other class back from Recovery, or choose to continue again with this class as it is now.'
    );
    this.name = 'ContinuationChangedError';
  }
}

const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The new class, built from one reading of the old class. The caller makes
 * that reading inside the storage step that freezes (or has frozen) the old
 * class, so every part of the result comes from the same moment.
 */
function continuationOf(source: Workspace, marker: CarryMarker, destinationId: string, names: ReadonlySet<string>, at: string): Workspace {
  const planned = buildContinuation(source.presentation as PresentationData, marker);
  // The new class must have real room to work in. (Validity and the size budget are checked by the store.)
  if (presentationFileBytes({ ...planned, epoch: 'x'.repeat(36), rev: 1 }) > PRESENTATION_LIMITS.carryBytes) {
    throw new PresentationError('The continuation would not leave room to work in the new class, so nothing was changed.');
  }
  const baseName = `${source.name} (continued)`.slice(0, LIMITS.nameLength);
  let name = baseName;
  for (let n = 2; names.has(name); n++) name = `${baseName.slice(0, LIMITS.nameLength - 6)} (${n})`;
  return {
    id: destinationId,
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    name,
    createdAt: at,
    updatedAt: at,
    // A class that holds presentation data always has a revision above 1.
    rev: 2,
    // The same students with the same ids, so every carried presenter still points at the right person.
    students: copyOf(source.students),
    settings: copyOf(source.settings),
    rings: copyOf(source.rings),
    lastBackupAt: null,
    // The store validates this, sizes it and gives it its own lineage id.
    presentation: planned,
  };
}

/**
 * Continue this class's presentations in a new class.
 *
 * One storage step does all of it: confirms this tab's view is current,
 * confirms the new class's id is free and the continuation is valid and has
 * room, marks the old class as continued, and creates the new class from the
 * old class exactly as that step reads it. So the new class's roster,
 * settings, ring weights, presentation state and absences for the day all
 * come from the same moment, and there is no moment at which the old class is
 * frozen but the new class does not exist. If any part cannot be done, nothing
 * is changed.
 *
 * Calling it again on a class that was already continued changes nothing and
 * reports the class that exists (see `finishMoving`).
 */
export async function continueInNewClass(
  store: WorkspaceStore,
  sourceId: string,
  expected: PresentationToken,
  options: { now?: Date; today: DateKey; destinationId?: string }
): Promise<ContinuationResult> {
  const seen = await store.getWorkspace(sourceId);
  if (!seen) throw new StoreMissingError();
  if (!seen.presentation) throw new PresentationError('This class has no presentations to continue.');
  if (seen.presentation.movedTo) return finishMoving(store, sourceId, { now: options.now });

  const destinationId = options.destinationId ?? newId();
  const at = (options.now ?? new Date()).toISOString();
  await store.continuePresentation(
    sourceId,
    {
      expected,
      change: (current, workspace) => {
        if (!current) throw new PresentationError('This class has no presentations to continue.');
        return markMoved(current, destinationId, at, options.today, workspace.rev);
      },
    },
    (source, others) => {
      // Never overwritten, and checked before anything is frozen: this runs in the same step.
      if (others.find(destinationId)) throw new ContinuationConflictError();
      return continuationOf(source, markerOf(sourceId, source.presentation as PresentationData), destinationId, others.names, at);
    }
  );
  return { destinationId, created: true };
}

/**
 * For a class that is marked as continued: make sure the class it was
 * continued in exists. Safe to repeat from any tab.
 *
 * - If that class is here and is this continuation, nothing is changed.
 * - If something else is under its id, nothing is overwritten
 *   (`ContinuationConflictError`).
 * - If it is not here (it was deleted, or only the old class was restored
 *   from a backup) and the old class has not changed since it was frozen, the
 *   class is created again exactly as it was first created.
 * - If it is not here and the old class has changed since, nothing is created
 *   (`ContinuationChangedError`) unless `acceptCurrentClass` is set. Then the
 *   new class is built from the old class as it is now, in one step.
 *
 * Whichever happens, the new class is read from the old class and written in
 * one storage step.
 */
export async function finishMoving(
  store: WorkspaceStore,
  sourceId: string,
  options: { now?: Date; acceptCurrentClass?: boolean } = {}
): Promise<ContinuationResult> {
  const at = (options.now ?? new Date()).toISOString();
  let destinationId = '';
  const { created } = await store.continuePresentation(sourceId, null, (source, others) => {
    if (!source.presentation) throw new PresentationError('This class has no presentations to continue.');
    const marker = markerOf(sourceId, source.presentation);
    const movedTo = source.presentation.movedTo as NonNullable<PresentationData['movedTo']>;
    destinationId = movedTo.classId;
    const existing = others.find(destinationId);
    if (existing) {
      if (!isContinuationOf(existing, marker)) throw new ContinuationConflictError();
      return null;
    }
    // The class's own revision rises with every roster, settings or ring-weight edit.
    const unchanged = source.rev === movedTo.classRev;
    if (!unchanged && !options.acceptCurrentClass) throw new ContinuationChangedError();
    return continuationOf(source, marker, destinationId, others.names, unchanged ? marker.at : at);
  });
  return { destinationId, created: created !== null };
}

/**
 * Undo "continued in another class". Possible only while the class it was
 * continued in does not exist, and only if this class is not full.
 * The check and the change are one storage step, so another tab cannot create
 * that class in between.
 */
export async function reopenPresentations(store: WorkspaceStore, classId: string, expected: PresentationToken, now: Date = new Date()): Promise<Workspace> {
  let marker: CarryMarker | null = null;
  let destinationId = '';
  const { source } = await store.continuePresentation(
    classId,
    {
      expected,
      change: (current) => {
        if (!current) throw new PresentationError('This class has no presentations.');
        if (current.movedTo) {
          marker = markerOf(classId, current);
          destinationId = current.movedTo.classId;
        }
        return markReopened(current, now.toISOString());
      },
    },
    (_source, others) => {
      const existing = marker ? others.find(destinationId) : null;
      if (existing && isContinuationOf(existing, marker as CarryMarker)) {
        throw new PresentationError('The class these presentations were continued in exists. Work continues there, so they cannot also be reopened here.');
      }
      return null;
    }
  );
  return source;
}

// ---------------------------------------------------------------------------
// What a restore would do to presentation draws (for the preview)
// ---------------------------------------------------------------------------

export interface RestoreImpact {
  id: string;
  name: string;
  /** Presentation draws in the file's version of the class. */
  drawsInFile: number;
  /** Presentation draws in the class as it is in this browser now, or 0 if it is not here. */
  drawsHere: number;
  /** With "Replace": draws that would then exist only in the recovery copy. */
  drawsLeftOnlyInRecoveryCopy: number;
}

/** For each class in a backup file, how many presentation draws it holds and what replacing would leave behind. */
export function restoreImpact(backup: BackupFile, here: Workspace[]): RestoreImpact[] {
  return backup.workspaces.map(({ workspace }) => {
    const current = here.find((w) => w.id === workspace.id);
    const inFile = new Set((workspace.presentation?.draws ?? []).map((d) => d.id));
    const hereDraws = current?.presentation?.draws ?? [];
    return {
      id: workspace.id,
      name: workspace.name,
      drawsInFile: inFile.size,
      drawsHere: hereDraws.length,
      drawsLeftOnlyInRecoveryCopy: hereDraws.filter((d) => !inFile.has(d.id)).length,
    };
  });
}
