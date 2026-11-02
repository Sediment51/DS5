import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { mentorMiddleware } from './src/server/mentorApi.ts';

/**
 * /api/mentor on the dev and preview servers: Buddy's feedback on the user's
 * work. The key comes from ANTHROPIC_API_KEY (in .env.local next to this
 * file, which git ignores, or the shell's environment) and never reaches the
 * browser.
 */
function mentorApi(): Plugin {
  let apiKey: string | undefined;
  const use = (server: { middlewares: Connect.Server }) => {
    // The middleware types its own minimal request/response (the project has no Node typings).
    server.middlewares.use(mentorMiddleware(apiKey) as unknown as Connect.NextHandleFunction);
  };
  return {
    name: 'mentor-api',
    // Runs before the servers are configured.
    configResolved(config) {
      // '' loads every variable, not only VITE_-prefixed ones (those would be bundled into the page).
      const envDir = typeof config.envDir === 'string' ? config.envDir : config.root;
      apiKey = loadEnv(config.mode, envDir, '').ANTHROPIC_API_KEY;
    },
    configureServer: use,
    configurePreviewServer: use,
  };
}

export default defineConfig({
  // Relative asset paths so the build works from a sub-path such as
  // https://<user>.github.io/new-project/ (GitHub Pages).
  base: './',
  plugins: [react(), mentorApi()],
});
