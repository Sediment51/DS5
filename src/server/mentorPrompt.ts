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
/** Asked in turn instead when a model is overloaded (HTTP 503 / 500): the previous stable Flash, then Flash-Lite. */
export const GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'] as const;

/** Whether a Gemini failure is "busy right now" (worth one try on another model). */
export const geminiOverloaded = (status: number) => status === 503 || status === 500;
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
/** Longest feedback passed on (characters): it's shown in a small speech bubble… */
const MAX_FEEDBACK = 160;
/** …and the tip that goes with the outlines on the wound. */
const MAX_TIP = 60;
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

/**
 * The parts of the wound the verdict marks (the headset outlines each one in
 * cyan when it's fine and amber where it needs work).
 */
export const MENTOR_ZONES = ['finger_end', 'wrist_end', 'thumb_edge', 'little_finger_edge', 'centre'] as const;
export type MentorZone = (typeof MENTOR_ZONES)[number];

/** What the mentor sees: overall, and per part of the wound. */
export interface MentorVerdict {
  overall: 'good' | 'needs_work' | 'not_visible';
  zones: Partial<Record<MentorZone, 'ok' | 'refine'>>;
}

export const MENTOR_SYSTEM = [
  'You are Buddy, a warm, encouraging special-effects (SFX) makeup mentor inside a mixed-reality app.',
  'The user is a beginner learning to make a fake scar-wax cut on their own palm, step by step.',
  'You get one photo from their headset camera, taken while they work, and the step they are on.',
  'The cut lies along the palm, from near the fingers towards the wrist, angled a little towards the thumb.',
  'Judge each part of it for the current step: "finger_end" (the end nearer the fingers), "wrist_end" (the end nearer the wrist),',
  '"thumb_edge" (the long edge on the thumb side), "little_finger_edge" (the long edge on the little-finger side) and "centre" (the middle of the cut).',
  'Mark a part "refine" only where it clearly needs work for this step, otherwise "ok".',
  'The app shows your verdict as coloured outlines on the wound, so keep words to a minimum.',
  'Reply with JSON only, no other text, exactly in this shape:',
  '{"overall": "good" | "needs_work" | "not_visible", "zones": {"finger_end": "ok" | "refine", "wrist_end": "ok" | "refine", "thumb_edge": "ok" | "refine", "little_finger_edge": "ok" | "refine", "centre": "ok" | "refine"}, "tip": "at most 6 words"}.',
  'The tip is one encouraging, concrete action for the part that most needs it (e.g. "Blend the wrist end smoother"), or praise if all is fine.',
  'If the palm or the work isn’t clearly visible, use "not_visible", mark every part "ok", and make the tip how to hold the palm (e.g. "Hold your palm up, closer").',
  'This is makeup, not a real injury: no medical advice.',
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

/** The answer sent to the headset: a few words, and the verdict per part of the wound when there is one. */
export type MentorAnswer = { feedback: string; verdict?: MentorVerdict } | { error: string };

/** A short line, cut at a word boundary to fit Buddy's bubble. */
function short(text: string, max: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : clean;
}

/**
 * Reads the model's reply: the JSON verdict (its tip as the words), or, if
 * the reply isn't that JSON, its text as the words.
 */
export function parseAnswer(parts: string[]): MentorAnswer {
  const text = parts.map((p) => p.trim()).filter(Boolean).join(' ');
  if (!text) return { error: EMPTY };
  const verdict = parseVerdict(text);
  if (verdict) return { feedback: verdict.tip || (verdict.verdict.overall === 'good' ? 'Looking good!' : 'Check the amber parts'), verdict: verdict.verdict };
  return { feedback: short(text, MAX_FEEDBACK) };
}

/** The verdict from the reply's JSON (it may be wrapped in other text), or null. */
export function parseVerdict(text: string): { verdict: MentorVerdict; tip: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const j = json as { overall?: unknown; zones?: Record<string, unknown>; tip?: unknown };
  if (j.overall !== 'good' && j.overall !== 'needs_work' && j.overall !== 'not_visible') return null;
  const zones: MentorVerdict['zones'] = {};
  for (const zone of MENTOR_ZONES) {
    const state = j.zones?.[zone];
    if (state === 'ok' || state === 'refine') zones[zone] = state;
  }
  return { verdict: { overall: j.overall, zones }, tip: typeof j.tip === 'string' ? short(j.tip, MAX_TIP) : '' };
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
    generationConfig: { maxOutputTokens: 4096, responseMimeType: 'application/json' },
  };
}

/** The feedback from a generateContent response, or a plain reason there isn't any. */
export function readGeminiFeedback(response: unknown): MentorAnswer {
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
  const result = parseAnswer(texts);
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
    return 'Google didn’t accept the API key. Check GEMINI_API_KEY.';
  }
  if (status === 404) return 'Google doesn’t know that model. Check GEMINI_MODEL (or remove it).';
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
export function readFeedback(response: unknown): MentorAnswer {
  const message = response as { stop_reason?: string; content?: Array<{ type?: string; text?: string }> } | null;
  if (!message || !Array.isArray(message.content)) return { error: 'The AI service sent back something unexpected.' };
  if (message.stop_reason === 'refusal') return { error: REFUSED };
  return parseAnswer(message.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text!));
}

/** A plain-language reason for a failed Claude API call (the details go to the laptop's console). */
export function describeApiError(status: number): string {
  if (status === 401 || status === 403) return 'The AI service didn’t accept the API key. Check ANTHROPIC_API_KEY in .env.local.';
  if (status === 429) return 'Too many requests just now. Try again in a minute.';
  if (status === 400 || status === 413) return 'The AI service couldn’t use that photo. Try again.';
  if (status >= 500) return 'The AI service is busy. Try again shortly.';
  return `The AI service returned an error (HTTP ${status}).`;
}
