/**
 * Presentation Draw operations on Local Mode data.
 *
 * Every write here goes through `store.updatePresentation`, which checks that
 * the class is still what the caller last saw, validates and replays the
 * result, and checks its size, all in one step. Nothing in this file makes a
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
import { validatePresentation } from '../../presentation/validate';
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

/** The new class must be valid and must have real room to work in, or the old class is not frozen. */
function assertFits(planned: PresentationData): void {
  const checked = validatePresentation({ ...planned, rev: 1 });
  if (!checked.ok) throw new PresentationError(`The continuation could not be prepared, so nothing was changed. ${checked.problems[0]}`);
  if (presentationFileBytes(checked.value) > PRESENTATION_LIMITS.carryBytes) {
    throw new PresentationError('The continuation would not leave room to work in the new class, so nothing was changed.');
  }
}

/**
 * Step 2, and the whole of a retry: create the class the marker names.
 * Safe to repeat from any tab. The old class cannot change once it is marked,
 * so every attempt builds the same thing. If the class is already there and is
 * this continuation, that is success. If something else is there, nothing is
 * overwritten.
 */
export async function finishMoving(store: WorkspaceStore, sourceId: string): Promise<ContinuationResult> {
  const source = await store.getWorkspace(sourceId);
  if (!source || !source.presentation) throw new StoreMissingError();
  const marker = markerOf(sourceId, source.presentation);
  const destinationId = source.presentation.movedTo!.classId;

  const settle = (existing: Workspace): ContinuationResult => {
    if (!isContinuationOf(existing, marker)) throw new ContinuationConflictError();
    return { destinationId, created: false };
  };
  const existing = await store.getWorkspace(destinationId);
  if (existing) return settle(existing);

  const planned = buildContinuation(source.presentation, marker);
  assertFits(planned);
  const names = new Set((await store.listWorkspaces()).map((w) => w.name));
  const baseName = `${source.name} (continued)`.slice(0, LIMITS.nameLength);
  let name = baseName;
  for (let n = 2; names.has(name); n++) name = `${baseName.slice(0, LIMITS.nameLength - 6)} (${n})`;

  const workspace: Workspace = {
    id: destinationId,
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    name,
    createdAt: marker.at,
    updatedAt: marker.at,
    // A class that holds presentation data always has a revision above 1.
    rev: 2,
    // The same students with the same ids, so every carried presenter still points at the right person.
    students: JSON.parse(JSON.stringify(source.students)) as Workspace['students'],
    settings: JSON.parse(JSON.stringify(source.settings)) as Workspace['settings'],
    rings: JSON.parse(JSON.stringify(source.rings)) as Workspace['rings'],
    lastBackupAt: null,
    // The store assigns the lineage id when the class is put.
    presentation: { ...planned, rev: 1 },
  };
  try {
    // Adds a class and removes nothing. An id that is already in use is refused, never overwritten.
    await store.putBundles([{ workspace, spins: [] }]);
    return { destinationId, created: true };
  } catch (err) {
    // Another tab may have created it a moment ago.
    const now = await store.getWorkspace(destinationId);
    if (now) return settle(now);
    throw err;
  }
}

/**
 * Continue this class's presentations in a new class.
 *
 * 1. Before anything is frozen: choose the new class's id, confirm it is free,
 *    and confirm the continuation is valid and leaves room to work.
 * 2. Mark the old class as continued (one small class-log entry). From then on
 *    its presentation data cannot change in any tab.
 * 3. Create the new class from that frozen state.
 *
 * If step 3 does not complete, `finishMoving` completes it later from any tab,
 * using the id recorded in step 2. Nothing in the old class is deleted.
 */
export async function continueInNewClass(
  store: WorkspaceStore,
  sourceId: string,
  expected: PresentationToken,
  options: { now?: Date; today: DateKey; destinationId?: string }
): Promise<ContinuationResult> {
  const source = await store.getWorkspace(sourceId);
  if (!source) throw new StoreMissingError();
  if (!source.presentation) throw new PresentationError('This class has no presentations to continue.');
  if (source.presentation.movedTo) return finishMoving(store, sourceId);

  const destinationId = options.destinationId ?? newId();
  const at = (options.now ?? new Date()).toISOString();
  if (await store.getWorkspace(destinationId)) throw new ContinuationConflictError();
  assertFits(buildContinuation(source.presentation, { sourceClassId: sourceId, n: source.presentation.classLog.length + 1, at, on: options.today }));

  await store.updatePresentation(sourceId, expected, (current) => {
    if (!current) throw new PresentationError('This class has no presentations to continue.');
    return markMoved(current, destinationId, at, options.today);
  });
  return finishMoving(store, sourceId);
}

/** Undo "continued in another class", if the other class was never created and this class is not full. */
export async function reopenPresentations(store: WorkspaceStore, classId: string, expected: PresentationToken, now: Date = new Date()): Promise<Workspace> {
  const workspace = await store.getWorkspace(classId);
  if (!workspace || !workspace.presentation) throw new StoreMissingError();
  const movedTo = workspace.presentation.movedTo;
  if (movedTo && (await store.getWorkspace(movedTo.classId))) {
    throw new PresentationError('The class these presentations were continued in exists. Work continues there, so they cannot also be reopened here.');
  }
  return store.updatePresentation(classId, expected, (current) => markReopened(current as PresentationData, now.toISOString()));
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
