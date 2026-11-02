/**
 * What the mentor endpoint sends to the AI service and reads back: pure
 * functions, shared by the dev-server middleware (mentorApi.ts) and its
 * tests. Two services are supported: Google Gemini (GEMINI_API_KEY) and
 * Anthropic Claude (ANTHROPIC_API_KEY).
 */

export type MentorProvider = 'gemini' | 'claude';

/** Which service, its key and model (chosen from the environment in vite.config.ts). */
export interface MentorService {
  provider: MentorProvider;
  apiKey: string;
  model: string;
}

/** Google Gemini: the default model, and the generateContent endpoint (the key goes in `?key=`). */
export const GEMINI_MODEL = 'gemini-3.8-flash';
export const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

/** Anthropic Claude. */
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
const REFUSED = 'I can’t give feedback on that photo. Try again with just your palm in view.';
const EMPTY = 'I didn’t get any feedback that time. Try again.';

/**
 * Picks the service from environment variables: Google if GEMINI_API_KEY
 * (or GOOGLE_API_KEY) is set, else Anthropic if ANTHROPIC_API_KEY is;
 * GEMINI_MODEL / MENTOR_MODEL override the model. Null: not set up.
 */
export function mentorServiceFromEnv(env: Record<string, string | undefined>): MentorService | null {
  const google = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY)?.trim();
  if (google) return { provider: 'gemini', apiKey: google, model: env.GEMINI_MODEL?.trim() || GEMINI_MODEL };
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return { provider: 'claude', apiKey: anthropic, model: env.MENTOR_MODEL?.trim() || MENTOR_MODEL };
  return null;
}

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

/** The user's question that goes with the photo. */
const question = (req: MentorRequest) => `${describeStage(req.stage, req.stageLabel)}\nHow is my work looking?`;

/** One short paragraph, cut at a word boundary to fit the speech bubble. */
function tidy(parts: string[]): { feedback: string } | { error: string } {
  const text = parts.map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return { error: EMPTY };
  return { feedback: text.length > MAX_FEEDBACK ? `${text.slice(0, MAX_FEEDBACK - 1).replace(/\s+\S*$/, '')}…` : text };
}

// --- Google Gemini ----------------------------------------------------------

/** The generateContent request body. */
export function buildGeminiRequest(req: MentorRequest) {
  return {
    systemInstruction: { parts: [{ text: MENTOR_SYSTEM }] },
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: req.mediaType, data: req.data } }, { text: question(req) }],
      },
    ],
    // Room for the model's own reasoning as well as the short reply.
    generationConfig: { maxOutputTokens: 4096 },
  };
}

/** The feedback from a generateContent response, or a plain reason there isn't any. */
export function readGeminiFeedback(response: unknown): { feedback: string } | { error: string } {
  const r = response as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  } | null;
  if (!r || typeof r !== 'object') return { error: 'The AI service sent back something unexpected.' };
  if (r.promptFeedback?.blockReason) return { error: REFUSED };
  const candidate = r.candidates?.[0];
  const texts = (candidate?.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text!);
  const result = tidy(texts);
  // No text and a stop for any reason but finishing (a safety block, say): treat as declined.
  if ('error' in result && candidate?.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
    return { error: REFUSED };
  }
  return result;
}

/** A plain-language reason for a failed Gemini call (the details go to the laptop's console). */
export function describeGeminiError(status: number, response: unknown): string {
  const detail = (response as { error?: { message?: string; status?: string } } | null)?.error;
  const message = `${detail?.status ?? ''} ${detail?.message ?? ''}`;
  if (status === 401 || status === 403 || /API[_ ]key/i.test(message)) {
    return 'Google didn’t accept the API key. Check GEMINI_API_KEY in .env.local.';
  }
  if (status === 404) return 'Google doesn’t know that model. Check GEMINI_MODEL in .env.local (or remove it).';
  if (status === 429) return 'Google’s free limit is used up for now. Try again in a minute.';
  if (status === 400) return 'Google couldn’t use that photo. Try again.';
  if (status >= 500) return 'Google’s AI service is busy. Try again shortly.';
  return `Google’s AI service returned an error (HTTP ${status}).`;
}

// --- Anthropic Claude -------------------------------------------------------

/** The Messages API request body. */
export function buildMessagesRequest(req: MentorRequest, model = MENTOR_MODEL) {
  return {
    model,
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
          { type: 'text', text: question(req) },
        ],
      },
    ],
  };
}

/** The feedback text from a Messages API response, or a plain reason there isn't any. */
export function readFeedback(response: unknown): { feedback: string } | { error: string } {
  const message = response as { stop_reason?: string; content?: Array<{ type?: string; text?: string }> } | null;
  if (!message || !Array.isArray(message.content)) return { error: 'The AI service sent back something unexpected.' };
  if (message.stop_reason === 'refusal') return { error: REFUSED };
  return tidy(message.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text!));
}

/** A plain-language reason for a failed Claude API call (the details go to the laptop's console). */
export function describeApiError(status: number): string {
  if (status === 401 || status === 403) return 'The AI service didn’t accept the API key. Check ANTHROPIC_API_KEY in .env.local.';
  if (status === 429) return 'Too many requests just now. Try again in a minute.';
  if (status === 400 || status === 413) return 'The AI service couldn’t use that photo. Try again.';
  if (status >= 500) return 'The AI service is busy. Try again shortly.';
  return `The AI service returned an error (HTTP ${status}).`;
}
