// Audio effects for the spinner
export class AudioService {
  private static audioContext: AudioContext | null = null;
  private static enabled = true;

  static setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  static isEnabled(): boolean {
    return this.enabled;
  }

  private static getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  /**
   * Play a tick sound during spinning
   */
  static playTick() {
    if (!this.enabled) return;

    const context = this.getContext();
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    oscillator.frequency.value = 800;
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0.1, context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.05);

    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + 0.05);
  }

  /**
   * Play a win sound when spin completes
   */
  static playWin() {
    if (!this.enabled) return;

    const context = this.getContext();
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    oscillator.frequency.setValueAtTime(523.25, context.currentTime); // C5
    oscillator.frequency.setValueAtTime(659.25, context.currentTime + 0.1); // E5
    oscillator.frequency.setValueAtTime(783.99, context.currentTime + 0.2); // G5
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0.2, context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.4);

    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + 0.4);
  }

  /**
   * Play a veto sound
   */
  static playVeto() {
    if (!this.enabled) return;

    const context = this.getContext();
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    oscillator.frequency.setValueAtTime(200, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(100, context.currentTime + 0.3);
    oscillator.type = 'sawtooth';

    gainNode.gain.setValueAtTime(0.15, context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.3);

    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + 0.3);
  }
}
