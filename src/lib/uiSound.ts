/**
 * Soft UI sounds for the headset's panels (no audio files): a click when a
 * button is pressed or a slider is grabbed, a lighter tick as a slider passes
 * each step, a low click when it's let go. Quiet, short, and silently
 * skipped where audio isn't available.
 */
let context: AudioContext | null = null;
let failed = false;

function audio(): AudioContext | null {
  if (failed) return null;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    failed = true;
    return null;
  }
}

function blip(frequency: number, seconds: number, volume: number) {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, t);
  osc.frequency.exponentialRampToValueAtTime(frequency * 0.7, t + seconds);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

export const uiSound = {
  /** A button pressed, or a slider grabbed. */
  press: () => blip(1250, 0.05, 0.12),
  /** A slider let go. */
  release: () => blip(700, 0.06, 0.08),
  /** A slider passing a step. */
  tick: () => blip(1900, 0.02, 0.04),
  /** Something done: the mat placed, a step finished (two rising notes). */
  success: () => {
    blip(990, 0.09, 0.1);
    window.setTimeout(() => blip(1480, 0.14, 0.1), 90);
  },
  /** Something needs attention: tracking lost. */
  alert: () => blip(520, 0.16, 0.09),
};
