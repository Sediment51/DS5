import { describe, expect, it } from 'vitest';
import {
  GEMINI_MODEL,
  MENTOR_MODEL,
  buildGeminiRequest,
  buildMessagesRequest,
  describeApiError,
  describeGeminiError,
  geminiUrl,
  mentorServiceFromEnv,
  parseMentorRequest,
  readFeedback,
  readGeminiFeedback,
} from './mentorPrompt';

describe('mentorServiceFromEnv', () => {
  it('uses Google when GEMINI_API_KEY is set, even with an Anthropic key too', () => {
    expect(mentorServiceFromEnv({ GEMINI_API_KEY: ' g-key ', ANTHROPIC_API_KEY: 'a-key' })).toEqual({
      provider: 'gemini',
      apiKey: 'g-key',
      model: GEMINI_MODEL,
    });
    expect(mentorServiceFromEnv({ GOOGLE_API_KEY: 'g', GEMINI_MODEL: 'gemini-3.6-flash' })?.model).toBe('gemini-3.6-flash');
  });

  it('falls back to Anthropic, and is off with no key', () => {
    expect(mentorServiceFromEnv({ ANTHROPIC_API_KEY: 'a-key' })).toEqual({ provider: 'claude', apiKey: 'a-key', model: MENTOR_MODEL });
    expect(mentorServiceFromEnv({ GEMINI_API_KEY: '  ' })).toBeNull();
  });
});

describe('Gemini', () => {
  it('sends the photo inline with the step, and the mentor prompt as the system instruction', () => {
    const body = buildGeminiRequest({ mediaType: 'image/jpeg', data: 'abc', stage: 2, stageLabel: 'Press the wax on.' });
    expect(body.systemInstruction.parts[0].text).toContain('Buddy');
    const [image, text] = body.contents[0].parts;
    expect(image).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'abc' } });
    expect((text as { text: string }).text).toContain('step 2 of 6: "Press the wax on."');
    expect(geminiUrl('gemini-3.8-flash')).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  });

  it('reads the reply text, skipping thoughts', () => {
    const response = {
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Nice clean edges.' }, { text: ' Blend the left side more.' }] },
        },
      ],
    };
    expect(readGeminiFeedback(response)).toEqual({ feedback: 'Nice clean edges. Blend the left side more.' });
  });

  it('treats a blocked prompt or a safety stop as declined', () => {
    expect(readGeminiFeedback({ promptFeedback: { blockReason: 'SAFETY' } })).toHaveProperty('error');
    expect(readGeminiFeedback({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] })).toEqual({
      error: expect.stringContaining('can’t give feedback'),
    });
    expect(readGeminiFeedback({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })).toEqual({
      error: expect.stringContaining('didn’t get any feedback'),
    });
  });

  it('explains a rejected key, a wrong model and a used-up quota', () => {
    expect(describeGeminiError(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' } })).toContain('GEMINI_API_KEY');
    expect(describeGeminiError(404, null)).toContain('GEMINI_MODEL');
    expect(describeGeminiError(429, null)).toContain('limit');
  });
});

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

describe('parseMentorRequest', () => {
  it('accepts a JPEG data URL, a stage and its instruction', () => {
    expect(parseMentorRequest({ image: PHOTO, stage: 2, stageLabel: ' Press the wax on. ' })).toEqual({
      mediaType: 'image/jpeg',
      data: '/9j/4AAQSkZJRgABAQ==',
      stage: 2,
      stageLabel: 'Press the wax on.',
    });
  });

  it('says what is wrong with a bad request', () => {
    expect(parseMentorRequest(null)).toEqual({ error: 'The request must be a JSON object.' });
    expect(parseMentorRequest({ stage: 1 })).toEqual({ error: 'The photo is missing.' });
    expect(parseMentorRequest({ image: 'data:text/plain;base64,aGk=', stage: 1 })).toEqual({
      error: 'The photo must be a JPEG, PNG or WebP data URL.',
    });
    expect(parseMentorRequest({ image: PHOTO, stage: 9 })).toEqual({ error: '"stage" must be a whole number from 0 to 6.' });
  });
});

describe('buildMessagesRequest', () => {
  it('sends the photo first, then the step, with the mentor prompt and the fallback', () => {
    const body = buildMessagesRequest({ mediaType: 'image/jpeg', data: 'abc', stage: 3, stageLabel: 'Slice the wax.' });
    expect(body.model).toBe(MENTOR_MODEL);
    expect(body.fallbacks).toBe('default');
    expect(body).not.toHaveProperty('temperature');
    const [image, text] = body.messages[0].content;
    expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } });
    expect(text.type).toBe('text');
    expect((text as { text: string }).text).toContain('step 3 of 6: "Slice the wax."');
  });
});

describe('readFeedback', () => {
  it('joins the text blocks and skips thinking', () => {
    const response = {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'The edges blend well.  ' },
        { type: 'text', text: 'Press the centre down a little.' },
      ],
    };
    expect(readFeedback(response)).toEqual({ feedback: 'The edges blend well. Press the centre down a little.' });
  });

  it('turns a refusal or an empty answer into a plain message', () => {
    expect(readFeedback({ stop_reason: 'refusal', content: [] })).toHaveProperty('error');
    expect(readFeedback({ stop_reason: 'end_turn', content: [] })).toHaveProperty('error');
    expect(readFeedback('nonsense')).toHaveProperty('error');
  });

  it('keeps long feedback to the bubble’s size, at a word boundary', () => {
    const result = readFeedback({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'word '.repeat(200) }] });
    if (!('feedback' in result)) throw new Error('expected feedback');
    expect(result.feedback.length).toBeLessThanOrEqual(420);
    expect(result.feedback.endsWith('word…')).toBe(true);
  });
});

describe('describeApiError', () => {
  it('explains the common failures in plain words', () => {
    expect(describeApiError(401)).toContain('API key');
    expect(describeApiError(429)).toContain('Try again');
    expect(describeApiError(529)).toContain('busy');
  });
});
