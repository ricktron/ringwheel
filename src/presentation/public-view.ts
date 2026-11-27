/**
 * What the student-facing display may render.
 *
 * This is display privacy, not data isolation. The display shows only what
 * this function returns, and this function returns only names the teacher has
 * revealed. It does not make the hidden order secret: anyone who can use the
 * teacher's browser, or open a backup file, can read the whole order.
 */
import type { PresentationDraw, RosterEntry } from './types';

export interface PublicView {
  title: string;
  state: 'not_started' | 'presenting' | 'between' | 'finished';
  /** The presenter the teacher has revealed, or null. */
  presenting: string | null;
  /** The next presenter, only if the teacher chose to reveal them early. */
  onDeck: string | null;
  /** Presentations completed. */
  done: number;
  /** Presenters in this draw, not counting those who will not present. */
  total: number;
}

export function publicView(draw: PresentationDraw, roster: RosterEntry[]): PublicView {
  // Use the current roster name when there is one, so a corrected spelling shows; otherwise the name at draw time.
  const nameOf = (index: number): string => {
    const entry = draw.entries[index];
    return roster.find((student) => student.id === entry.studentId)?.name ?? entry.nameAtDraw;
  };
  const presenting = draw.entries.findIndex((e) => e.status === 'presenting');
  const onDeck = draw.entries.findIndex((e) => e.status === 'on_deck');
  const done = draw.entries.filter((e) => e.status === 'done').length;
  const total = draw.entries.filter((e) => e.status !== 'skipped').length;
  const open = draw.entries.some((e) => e.status === 'waiting' || e.status === 'presenting' || e.status === 'on_deck');
  return {
    title: draw.title,
    state: presenting >= 0 ? 'presenting' : !draw.order ? 'not_started' : !open ? 'finished' : done > 0 || onDeck >= 0 ? 'between' : 'not_started',
    presenting: presenting >= 0 ? nameOf(presenting) : null,
    onDeck: onDeck >= 0 ? nameOf(onDeck) : null,
    done,
    total,
  };
}
