import { answerMentor, type ApiResponse } from '../src/server/mentorApi.js';
import { mentorServiceFromEnv } from '../src/server/mentorPrompt.js';

/**
 * /api/mentor on Vercel: Buddy's "Check my work" feedback when the app is
 * hosted there. The same endpoint as the laptop's dev server
 * (src/server/mentorApi.ts); the key is GEMINI_API_KEY (or ANTHROPIC_API_KEY)
 * in the Vercel project's Environment Variables, and never reaches the page.
 */

/** Vercel's Node request: the JSON body arrives already parsed. */
interface VercelRequest {
  method?: string;
  body?: unknown;
}

/** The server's environment (the project has no Node typings). */
const env = () => (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

export default async function handler(req: VercelRequest, res: ApiResponse) {
  await answerMentor(
    req.method,
    async () => (typeof req.body === 'string' ? JSON.parse(req.body) : req.body),
    res,
    mentorServiceFromEnv(env()),
    'add GEMINI_API_KEY in the Vercel project’s Settings → Environment Variables, then redeploy',
  );
}
