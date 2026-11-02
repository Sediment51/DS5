import {
  ANTHROPIC_VERSION,
  FALLBACK_BETA,
  GEMINI_FALLBACK_MODELS,
  MESSAGES_URL,
  buildGeminiRequest,
  buildMessagesRequest,
  describeApiError,
  describeGeminiError,
  geminiOverloaded,
  geminiUrl,
  parseMentorRequest,
  readFeedback,
  readGeminiFeedback,
  type MentorRequest,
  type MentorService,
} from './mentorPrompt.ts';

/**
 * The mentor endpoint on the dev (and preview) server: GET /api/mentor says
 * whether feedback is set up; POST /api/mentor takes { image, stage,
 * stageLabel } and returns { feedback } or { error }. The API key stays on
 * the laptop (GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local); the
 * headset only ever talks to this server.
 */

/** The parts of Node's request and response used here (the project has no Node typings). */
interface Request {
  url?: string;
  method?: string;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
}
interface Response {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/** Largest request body accepted (bytes): a photo of a few MB as base64. */
const MAX_BODY = 8_000_000;
/** Longest wait for the AI service (ms). */
const API_TIMEOUT = 60_000;

function send(res: Response, status: number, body: object) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: Request, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) reject(new Error('too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(new TextDecoder().decode(all));
    });
    req.on('error', reject);
  });
}

/** @param service the AI service to ask (null: not set up). */
export function mentorMiddleware(service: MentorService | null) {
  return (req: Request, res: Response, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!path.endsWith('/api/mentor')) {
      next();
      return;
    }
    void handle(req, res, service);
  };
}

async function handle(req: Request, res: Response, service: MentorService | null) {
  if (req.method === 'GET') {
    send(res, 200, { ok: true, configured: service !== null, provider: service?.provider ?? null });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Use GET or POST.' });
    return;
  }
  if (!service) {
    send(res, 503, { error: 'Mentor feedback isn’t set up: add GEMINI_API_KEY to .env.local on the laptop and restart the app.' });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch {
    send(res, 400, { error: 'The photo couldn’t be read. Try again.' });
    return;
  }
  const parsed = parseMentorRequest(body);
  if ('error' in parsed) {
    send(res, 400, parsed);
    return;
  }
  try {
    const result = service.provider === 'gemini' ? await askGemini(service, parsed) : await askClaude(service, parsed);
    send(res, 'error' in result ? 502 : 200, result);
  } catch (err) {
    console.error(`[mentor] Request to ${service.provider} failed`, err);
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    send(res, 504, {
      error: timedOut ? 'The AI service took too long. Try again.' : 'The laptop couldn’t reach the AI service. Check its internet connection.',
    });
  }
}

type Answer = { feedback: string } | { error: string };

/**
 * Google Gemini's generateContent (the key goes in the query; the URL is
 * never logged). If the model is overloaded, asks the fallback models in turn.
 */
async function askGemini(service: MentorService, req: MentorRequest): Promise<Answer> {
  const call = async (model: string) => {
    const response = await fetch(`${geminiUrl(model)}?key=${encodeURIComponent(service.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildGeminiRequest(req)),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) console.error(`[mentor] Gemini error ${response.status} (model ${model})`, json);
    return { response, json };
  };
  let model = service.model;
  let { response, json } = await call(model);
  for (const fallback of GEMINI_FALLBACK_MODELS) {
    if (response.ok || !geminiOverloaded(response.status)) break;
    if (fallback === service.model) continue;
    console.warn(`[mentor] ${model} is busy; trying ${fallback}`);
    model = fallback;
    ({ response, json } = await call(model));
  }
  if (!response.ok) return { error: describeGeminiError(response.status, json) };
  const result = readGeminiFeedback(json);
  if ('error' in result) console.warn('[mentor] Gemini gave no feedback', json);
  return result;
}

/** Anthropic's Messages API. */
async function askClaude(service: MentorService, req: MentorRequest): Promise<Answer> {
  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': service.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': FALLBACK_BETA,
    },
    body: JSON.stringify(buildMessagesRequest(req, service.model)),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`[mentor] Messages API error ${response.status}`, json);
    return { error: describeApiError(response.status) };
  }
  return readFeedback(json);
}
