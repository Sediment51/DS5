import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from './mentor';

/** A response that records what the handler sent. */
function response() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    end(body?: string) {
      res.body = body ?? '';
    },
  };
  return res;
}

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQ';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the Vercel /api/mentor function', () => {
  it('says whether a key is set', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const off = response();
    await handler({ method: 'GET' }, off);
    expect(JSON.parse(off.body)).toEqual({ ok: true, configured: false, provider: null });

    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const on = response();
    await handler({ method: 'GET' }, on);
    expect(JSON.parse(on.body)).toMatchObject({ configured: true, provider: 'gemini' });
  });

  it('explains where to set the key when it is missing', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const res = response();
    await handler({ method: 'POST', body: { image: PHOTO, stage: 1, stageLabel: 'x' } }, res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('Vercel');
  });

  it('sends the parsed body to Gemini and returns its feedback', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Looks great.' }] } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = response();
    await handler({ method: 'POST', body: { image: PHOTO, stage: 2, stageLabel: 'Press the wax on.' } }, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ feedback: 'Looks great.' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('gemini-3.8-flash:generateContent?key=test-key');
    expect(JSON.parse(init.body).contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
  });

  it('tries the next model when Google is busy', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const busy = () => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }), { status: 503 });
    const ok = () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Nice.' }] } }] }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = response();
    await handler({ method: 'POST', body: JSON.stringify({ image: PHOTO, stage: 0, stageLabel: '' }) }, res);
    expect(JSON.parse(res.body)).toEqual({ feedback: 'Nice.' });
    expect((fetchMock.mock.calls[2] as unknown as [string])[0]).toContain('gemini-3.5-flash-lite');
  });

  it('treats a model that is too slow as busy and moves on', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const ok = () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Good.' }] } }] }), { status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = response();
    await handler({ method: 'POST', body: { image: PHOTO, stage: 1, stageLabel: 'x' } }, res);
    expect(JSON.parse(res.body)).toEqual({ feedback: 'Good.' });
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain('gemini-3.6-flash');
  });
});
