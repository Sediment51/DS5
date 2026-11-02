import { describe, expect, it } from 'vitest';
import { MENTOR_MODEL, buildMessagesRequest, describeApiError, parseMentorRequest, readFeedback } from './mentorPrompt';

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
