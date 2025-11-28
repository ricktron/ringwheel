import confetti from 'canvas-confetti';

// Note: This module provides audio and confetti effects
// For production use with an audio sprite file, install howler and update this file
// For now, we use the Web Audio API for basic sounds

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Play a tick sound during spinning
 */
export function playTick() {
  try {
    const context = getAudioContext();
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
  } catch (e) {
    // Silently fail on older browsers
    console.warn('Audio not supported:', e);
  }
}

/**
 * Play a dense tick sound
 */
export function playDense() {
  try {
    const context = getAudioContext();
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    oscillator.frequency.value = 600;
    oscillator.type = 'triangle';

    gainNode.gain.setValueAtTime(0.15, context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.08);

    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + 0.08);
  } catch (e) {
    console.warn('Audio not supported:', e);
  }
}

/**
 * Play a reveal sound when spin completes
 */
export function playReveal() {
  try {
    const context = getAudioContext();
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
  } catch (e) {
    console.warn('Audio not supported:', e);
  }
}

/**
 * Play a jackpot sound for special events
 */
export function playJackpot() {
  try {
    const context = getAudioContext();

    // Play multiple notes in sequence for fanfare effect
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6

    notes.forEach((freq, i) => {
      const oscillator = context.createOscillator();
      const gainNode = context.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(context.destination);

      oscillator.frequency.value = freq;
      oscillator.type = 'sine';

      const startTime = context.currentTime + i * 0.15;
      gainNode.gain.setValueAtTime(0.25, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.3);

      oscillator.start(startTime);
      oscillator.stop(startTime + 0.3);
    });
  } catch (e) {
    console.warn('Audio not supported:', e);
  }
}

/**
 * Fire confetti animation
 */
export function fireConfetti() {
  try {
    confetti({
      particleCount: 120,
      spread: 70,
      origin: { y: 0.7 },
    });
  } catch (e) {
    console.warn('Confetti not supported:', e);
  }
}
