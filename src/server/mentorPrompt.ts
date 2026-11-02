/**
 * What the mentor endpoint sends to Claude and reads back: pure functions,
 * shared by the dev-server middleware (mentorApi.ts) and its tests.
 */

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const MENTOR_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_VERSION = '2026-10-21';
/** Server-side fallback when a safety classifier declines (routed by refusal category). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Largest photo accepted (base64 characters ≈ 4.5 MB of image). */
export const MAX_IMAGE_CHARS = 6_000_000;
const STAGE_COUNT = 6;
const MAX_LABEL = 300;
/** Longest feedback passed on (characters): it's shown in a small speech bubble. */
const MAX_FEEDBACK = 420;

export const MENTOR_SYSTEM = [
  'You are Buddy, a warm, encouraging special-effects (SFX) makeup mentor inside a mixed-reality app.',
  'The user is a beginner learning to make a fake scar-wax cut on their own palm, step by step.',
  'You get one photo from their headset camera, taken while they work, and the step they are on.',
  'Reply in at most three short sentences and under 60 words, in plain language: first what looks good, then one concrete tip for this step.',
  'No lists, headings, markdown or emoji. Talk to the user directly.',
  'If their hand or the work isn’t clearly visible, say so kindly and tell them how to hold their palm (open, facing up, in front of the headset).',
  'This is makeup, not a real injury: don’t give medical advice. If something looks like a real wound, gently suggest they stop and get it looked at.',
].join(' ');

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface MentorRequest {
  mediaType: ImageMediaType;
  /** Base64, no data-URL prefix. */
  data: string;
  /** 0 = the finished wound (no step yet), 1…6 = the build steps. */
  stage: number;
  stageLabel: string;
}

/** Checks the browser's request ({ image: data URL, stage, stageLabel }). */
export function parseMentorRequest(body: unknown): MentorRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'The request must be a JSON object.' };
  const { image, stage, stageLabel } = body as Record<string, unknown>;
  if (typeof image !== 'string') return { error: 'The photo is missing.' };
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) return { error: 'The photo must be a JPEG, PNG or WebP data URL.' };
  if (match[2].length > MAX_IMAGE_CHARS) return { error: 'The photo is too large.' };
  if (typeof stage !== 'number' || !Number.isInteger(stage) || stage < 0 || stage > STAGE_COUNT) {
    return { error: `"stage" must be a whole number from 0 to ${STAGE_COUNT}.` };
  }
  const label = typeof stageLabel === 'string' ? stageLabel.trim().slice(0, MAX_LABEL) : '';
  return { mediaType: match[1] as ImageMediaType, data: match[2], stage, stageLabel: label };
}

/** The step, in words, for the prompt. */
export function describeStage(stage: number, label: string): string {
  if (stage === 0) {
    return 'They are on the finished wound, before or after the step-by-step guide. Comment on how the finished wound looks on their palm.';
  }
  return `They are on step ${stage} of ${STAGE_COUNT}: "${label}"`;
}

/** The Messages API request body. */
export function buildMessagesRequest(req: MentorRequest) {
  return {
    model: MENTOR_MODEL,
    max_tokens: 4000,
    // Short, friendly feedback: low effort keeps it quick in the headset.
    output_config: { effort: 'low' },
    fallbacks: 'default',
    system: MENTOR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: req.mediaType, data: req.data } },
          { type: 'text', text: `${describeStage(req.stage, req.stageLabel)}\nHow is my work looking?` },
        ],
      },
    ],
  };
}

/** The feedback text from a Messages API response, or a plain reason there isn't any. */
export function readFeedback(response: unknown): { feedback: string } | { error: string } {
  const message = response as { stop_reason?: string; content?: Array<{ type?: string; text?: string }> } | null;
  if (!message || !Array.isArray(message.content)) return { error: 'The AI service sent back something unexpected.' };
  if (message.stop_reason === 'refusal') return { error: 'I can’t give feedback on that photo. Try again with just your palm in view.' };
  const text = message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { error: 'I didn’t get any feedback that time. Try again.' };
  return { feedback: text.length > MAX_FEEDBACK ? `${text.slice(0, MAX_FEEDBACK - 1).replace(/\s+\S*$/, '')}…` : text };
}

/** A plain-language reason for a failed API call (the details go to the laptop's console). */
export function describeApiError(status: number): string {
  if (status === 401 || status === 403) return 'The AI service didn’t accept the API key. Check ANTHROPIC_API_KEY in .env.local.';
  if (status === 429) return 'Too many requests just now. Try again in a minute.';
  if (status === 400 || status === 413) return 'The AI service couldn’t use that photo. Try again.';
  if (status >= 500) return 'The AI service is busy. Try again shortly.';
  return `The AI service returned an error (HTTP ${status}).`;
}
