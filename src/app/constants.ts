export const CONTRACT_ADDRESS = '';
export const ITEMS_PER_PAGE = 20;
export const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 10_000;

export const workerAlgorithmTemplate = `// Cloudflare Worker trade execution sketch
// This editor is stored locally in the browser for planning only.

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const payload = await request.json();
    console.log('Received event batch', payload.length ?? 1);

    // Real trade execution remains disabled in the current backend.
    return new Response('OK', { status: 200 });
  },
};
`;