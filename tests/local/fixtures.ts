/** Synthetic classes for Local Mode tests. Every name and address is invented. */
import { buildSpinLogPayload } from '../../src/utils/spin-log';
import { spin } from '../../src/utils/spin-engine';
import { createStudent, createWorkspace, newId, type LocalSpin, type Workspace, type WorkspaceBundle } from '../../src/data/local/schema';

export function sampleWorkspace(name = 'Period 3 Ecology', studentNames = ['Ada Sample', 'Ben Placeholder', 'Cy Demo']): Workspace {
  const workspace = createWorkspace(name, new Date('2026-11-01T14:00:00.000Z'));
  workspace.students = studentNames.map((n, i) =>
    createStudent(n, i === 0 ? 'ada.sample@example.com' : '', new Date(`2026-11-01T14:0${i}:00.000Z`))
  );
  workspace.settings = [{ key: 'enableConfetti', value: 'false', notes: 'quiet room' }];
  return workspace;
}

export function sampleSpins(workspace: Workspace, count = 4, start = '2026-11-20T15:00:00.000Z'): LocalSpin[] {
  return Array.from({ length: count }, (_, i) => {
    const student = workspace.students[i % Math.max(workspace.students.length, 1)] ?? null;
    const payload = buildSpinLogPayload({
      outcome: spin({ seed: `fixture-${workspace.name}-${i}` }),
      timestamp: new Date(Date.parse(start) + i * 60000),
      sessionId: 'fixture-session',
      student: student ? { name: student.name, email: student.email, period: '' } : null,
      isTest: false,
    });
    return { ...payload, id: newId(), workspaceId: workspace.id, studentId: student?.id ?? null };
  });
}

export function sampleBundle(name?: string, students?: string[], spins = 4): WorkspaceBundle {
  const workspace = sampleWorkspace(name, students);
  return { workspace, spins: sampleSpins(workspace, spins) };
}
