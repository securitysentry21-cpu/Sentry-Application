// The alarm's sound (PROD §11.6), made with WebAudio oscillators: no audio files. Browsers keep a
// page silent until someone interacts with it (EXT-40), so sound starts "off": the shell offers
// "Enable alarm sound" and warns while it is off, and any click or key press on the page enables it
// too. The siren runs on the audio thread (a low oscillator switches the tone's pitch), so it keeps
// sounding in a background tab, where timers are throttled. Browser only; nothing runs on import.

export type SoundState = 'on' | 'off' | 'unavailable';

type Siren = { readonly stop: () => void };

let context: AudioContext | null = null;
let unavailable = false;
let siren: Siren | null = null;
const listeners = new Set<() => void>();
const GESTURES = ['click', 'keydown', 'touchend'] as const;

function notify(): void {
  for (const listener of listeners) listener();
}

function audioContext(): AudioContext | null {
  if (context || unavailable) return context;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) {
    unavailable = true;
    return null;
  }
  try {
    context = new Context();
  } catch {
    unavailable = true;
    return null;
  }
  context.addEventListener('statechange', notify);
  return context;
}

export function soundState(): SoundState {
  if (unavailable) return 'unavailable';
  return context?.state === 'running' ? 'on' : 'off';
}

export function onSoundChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A short beep: the alarm sound works. */
function chime(ctx: AudioContext): void {
  const tone = ctx.createOscillator();
  tone.frequency.value = 880;
  const volume = ctx.createGain();
  volume.gain.value = 0.15;
  tone.connect(volume);
  volume.connect(ctx.destination);
  tone.start();
  tone.stop(ctx.currentTime + 0.18);
}

/**
 * Must run inside a user gesture (a click or key press handler): resume() is called before any
 * await, which Safari requires. Resolves with the state it reached.
 */
export async function enableSound(withChime = true): Promise<SoundState> {
  const ctx = audioContext();
  if (!ctx) {
    notify();
    return 'unavailable';
  }
  // iPhone: let the alarm sound even with the ringer switch on silent (Safari 16.4+).
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
  } catch {
    // not supported: the ringer switch decides
  }
  try {
    await ctx.resume();
  } catch {
    // refused: still off, and the warning stays
  }
  if (withChime && ctx.state === 'running') chime(ctx);
  notify();
  return soundState();
}

function onGesture(): void {
  void enableSound(false).then((state) => {
    if (state !== 'off') for (const type of GESTURES) document.removeEventListener(type, onGesture, true);
  });
}

/**
 * Creates the audio context (it may already be allowed to play, e.g. for an installed dashboard)
 * and enables sound on the page's next click, tap or key press.
 */
export function prepareSound(): void {
  const ctx = audioContext();
  if (!ctx || ctx.state === 'running') return;
  for (const type of GESTURES) document.addEventListener(type, onGesture, true);
}

/**
 * The siren: a two-tone (660 and 1,100 Hz, half a second each). A 1 Hz square wave moves the tone's
 * pitch, so it repeats on the audio thread with no timer. Starts now; stops at `until`, or never.
 */
function sirenOn(ctx: AudioContext, until?: number): Siren {
  const tone = ctx.createOscillator();
  tone.type = 'square';
  tone.frequency.value = 880;
  const sweep = ctx.createOscillator();
  sweep.type = 'square';
  sweep.frequency.value = 1;
  const depth = ctx.createGain();
  depth.gain.value = 220;
  sweep.connect(depth);
  depth.connect(tone.frequency);
  const volume = ctx.createGain();
  volume.gain.value = 0.12;
  tone.connect(volume);
  volume.connect(ctx.destination);
  tone.start();
  sweep.start();
  if (until !== undefined) {
    tone.stop(until);
    sweep.stop(until);
  }
  return {
    stop: () => {
      tone.stop();
      sweep.stop();
      volume.disconnect();
    },
  };
}

/**
 * Starts the alarm's siren until stopSiren(). While sound is off it waits silently, and sounds the
 * moment sound is enabled.
 */
export function startSiren(): void {
  const ctx = audioContext();
  if (!ctx || siren) return;
  siren = sirenOn(ctx);
}

export function stopSiren(): void {
  siren?.stop();
  siren = null;
}

/** "Test the alarm sound": a few seconds of the siren, apart from any real alarm. */
export function previewSiren(seconds = 3): void {
  const ctx = audioContext();
  if (ctx?.state === 'running') sirenOn(ctx, ctx.currentTime + seconds);
}
