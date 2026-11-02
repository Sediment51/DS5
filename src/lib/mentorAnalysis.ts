/**
 * "Check my work": Buddy looks at a photo of the user's hand from the
 * headset camera and gives short feedback on the current step. The photo
 * goes to this app's own dev server (/api/mentor, see src/server/mentorApi.ts),
 * which holds the API key and asks Gemini or Claude; the key never reaches the browser.
 *
 * Shared state, read every frame by Buddy and the menus (no React state).
 */
export type MentorStatus = 'idle' | 'processing' | 'done' | 'error';

export const MENTOR_ENDPOINT = 'api/mentor';
/** Give up on an answer after this long (ms): the server may try up to three models. */
const TIMEOUT_MS = 65_000;

export const mentor = {
  status: 'idle' as MentorStatus,
  /** The feedback, or what went wrong, in plain words. */
  text: '',
  /** Bumps on every status change. */
  version: 0,
  /** Whether the feedback service is there: null until checked. */
  available: null as boolean | null,
  /** Why it isn't, in plain words. */
  reason: '',
  /** Set by the button; the next XR frame takes the photo (camera images are only readable inside a frame). */
  captureRequested: false,
  /** The stage being checked, and its instruction. */
  stage: 0,
  stageLabel: '',
  /** The one-time note that photos go to the AI service has been shown. */
  privacyShown: false,

  set(status: MentorStatus, text = '') {
    this.status = status;
    this.text = text;
    this.version++;
  },
};

/** Asks the dev server whether feedback is set up (it needs ANTHROPIC_API_KEY). */
export async function checkMentorService(): Promise<void> {
  try {
    const response = await fetch(new URL(MENTOR_ENDPOINT, document.baseURI), { method: 'GET' });
    const body = (await response.json().catch(() => null)) as { configured?: boolean } | null;
    if (!response.ok || !body) throw new Error(`HTTP ${response.status}`);
    mentor.available = body.configured === true;
    mentor.reason = mentor.available ? '' : 'Mentor feedback isn’t set up: the server has no GEMINI_API_KEY yet.';
  } catch {
    mentor.available = false;
    mentor.reason = 'Mentor feedback isn’t available on this site: open the Vercel link, or run the app from the laptop.';
  }
  mentor.version++;
}

/** Sends the photo for feedback; the answer (or a plain reason it failed) lands in `mentor`. */
export async function requestFeedback(image: string, stage: number, stageLabel: string): Promise<void> {
  mentor.set('processing');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL(MENTOR_ENDPOINT, document.baseURI), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, stage, stageLabel }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as { feedback?: string; error?: string } | null;
    if (response.ok && body?.feedback) mentor.set('done', body.feedback);
    else mentor.set('error', body?.error ?? `I couldn’t get feedback this time (HTTP ${response.status}).`);
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'AbortError';
    mentor.set('error', timedOut ? 'That took too long. Try again in a moment.' : 'I couldn’t reach the feedback service. Check the headset’s internet connection.');
  } finally {
    window.clearTimeout(timer);
  }
}
