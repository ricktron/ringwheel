/**
 * Sound effects for the spinner, synthesized with the Web Audio API.
 * Sound is decoration: every failure here is swallowed so that a browser
 * without audio support (or with autoplay blocked) can still spin.
 */
type Tone = {
  type: OscillatorType;
  /** [frequency in Hz, offset in seconds] steps. */
  steps: [number, number][];
  /** Glide to this frequency by the end, if set. */
  glideTo?: number;
  gain: number;
  duration: number;
};

export class AudioService {
  private static audioContext: AudioContext | null = null;
  private static enabled = true;

  static setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  static isEnabled(): boolean {
    return this.enabled;
  }

  private static play(tone: Tone) {
    if (!this.enabled) return;
    try {
      if (typeof AudioContext === 'undefined') return;
      if (!this.audioContext) this.audioContext = new AudioContext();
      const context = this.audioContext;
      const oscillator = context.createOscillator();
      const gainNode = context.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(context.destination);

      const now = context.currentTime;
      oscillator.type = tone.type;
      for (const [frequency, offset] of tone.steps) {
        oscillator.frequency.setValueAtTime(frequency, now + offset);
      }
      if (tone.glideTo) {
        oscillator.frequency.exponentialRampToValueAtTime(tone.glideTo, now + tone.duration);
      }
      gainNode.gain.setValueAtTime(tone.gain, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + tone.duration);
      oscillator.start(now);
      oscillator.stop(now + tone.duration);
    } catch {
      // Ignore: audio is optional.
    }
  }

  /** Tick while the wheel spins. */
  static playTick() {
    this.play({ type: 'sine', steps: [[800, 0]], gain: 0.1, duration: 0.05 });
  }

  /** Rising three-note chime when a spin lands. */
  static playWin() {
    this.play({ type: 'sine', steps: [[523.25, 0], [659.25, 0.1], [783.99, 0.2]], gain: 0.2, duration: 0.4 });
  }

  /** Falling buzz for a veto re-spin. */
  static playVeto() {
    this.play({ type: 'sawtooth', steps: [[200, 0]], glideTo: 100, gain: 0.15, duration: 0.3 });
  }
}
