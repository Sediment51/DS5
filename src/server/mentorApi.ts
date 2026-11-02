import {
  ANTHROPIC_VERSION,
  FALLBACK_BETA,
  MESSAGES_URL,
  buildMessagesRequest,
  describeApiError,
  parseMentorRequest,
  readFeedback,
} from './mentorPrompt.ts';

/**
 * The mentor endpoint on the dev (and preview) server: GET /api/mentor says
 * whether feedback is set up; POST /api/mentor takes { image, stage,
 * stageLabel } and returns { feedback } or { error }. The API key stays on
 * the laptop (ANTHROPIC_API_KEY in .env.local); the headset only ever talks
 * to this server.
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

export function mentorMiddleware(apiKey: string | undefined) {
  const key = apiKey?.trim() || undefined;
  return (req: Request, res: Response, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!path.endsWith('/api/mentor')) {
      next();
      return;
    }
    void handle(req, res, key);
  };
}

async function handle(req: Request, res: Response, key: string | undefined) {
  if (req.method === 'GET') {
    send(res, 200, { ok: true, configured: key !== undefined });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Use GET or POST.' });
    return;
  }
  if (!key) {
    send(res, 503, { error: 'Mentor feedback isn’t set up: add ANTHROPIC_API_KEY to .env.local on the laptop and restart the app.' });
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
    const response = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': FALLBACK_BETA,
      },
      body: JSON.stringify(buildMessagesRequest(parsed)),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`[mentor] Messages API error ${response.status}`, json);
      send(res, 502, { error: describeApiError(response.status) });
      return;
    }
    const result = readFeedback(json);
    send(res, 'error' in result ? 502 : 200, result);
  } catch (err) {
    console.error('[mentor] Request to the Messages API failed', err);
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    send(res, 504, {
      error: timedOut ? 'The AI service took too long. Try again.' : 'The laptop couldn’t reach the AI service. Check its internet connection.',
    });
  }
}
