// api/update.js — Life OS v2 backend
// Contract:
//   GET                      -> { success, state }            (state is null on first run; the page seeds it)
//   POST { action:'save', state }    -> persist the whole board to Edge Config
//   POST { action:'capture', text }  -> Haiku guesses a domain, thought is appended to the inbox
//
// Reuses the existing infra: Edge Config for fast state, Vercel API to write it, Haiku for the guess.
// Stores under a NEW key ('dashboard_v2') so the old 'dashboard_state' stays as an untouched fallback.

const KEY = 'dashboard_v2';
const DOMAIN_IDS = ['thesis','career','tree','reading','house','life','build','hobbies'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
  const EDGE_CONFIG = process.env.EDGE_CONFIG;

  const ecId = () => EDGE_CONFIG.split('edge-config.vercel.com/')[1].split('?')[0];

  async function readState() {
    if (!EDGE_CONFIG || !VERCEL_API_TOKEN) return null;
    try {
      const r = await fetch(`https://api.vercel.com/v1/edge-config/${ecId()}/item/${KEY}`, {
        headers: { 'Authorization': `Bearer ${VERCEL_API_TOKEN}` }
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data.value || null;
    } catch (e) { return null; }
  }

  async function writeState(state) {
    if (!EDGE_CONFIG || !VERCEL_API_TOKEN) throw new Error('Edge Config not configured');
    const r = await fetch(`https://api.vercel.com/v1/edge-config/${ecId()}/items`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${VERCEL_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ operation: 'upsert', key: KEY, value: state }] })
    });
    if (!r.ok) throw new Error(`Edge Config write failed: ${r.status}`);
  }

  // light keyword fallback if Haiku is unavailable — mirrors the in-app guesser
  function keywordGuess(t) {
    t = (t || '').toLowerCase();
    if (/thesis|section|defen|seminar|chapter/.test(t)) return 'thesis';
    if (/job|career|coffee|role|phd|linkedin|appl|recruit|network/.test(t)) return 'career';
    if (/note|substack|tree|essay|publish|hypothesis/.test(t)) return 'tree';
    if (/read|book|quote|paper/.test(t)) return 'reading';
    if (/flat|house|apartment|viewing|mortgage|listing/.test(t)) return 'house';
    if (/dashboard|build|code|tool|fix|vercel|api|script/.test(t)) return 'build';
    if (/climb|skate|music|graffiti|paint|guitar/.test(t)) return 'hobbies';
    return 'life';
  }

  async function guessDomain(text) {
    if (!ANTHROPIC_KEY) return keywordGuess(text);
    try {
      const prompt = `Sort this captured thought into ONE domain of Jonas's life dashboard.\nDomains: thesis (master thesis), career (career reorientation / job search / PhD), tree (his Substack "The Living Issue Tree"), reading (reading & thinking), house (home search), life (life, energy, money, admin), build (side projects / coding / the dashboard), hobbies (climbing, skating, music, graffiti).\nThought: "${text}"\nReturn ONLY the domain id, nothing else.`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: prompt }] })
      });
      if (!r.ok) return keywordGuess(text);
      const data = await r.json();
      const guess = (data.content[0].text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
      return DOMAIN_IDS.includes(guess) ? guess : keywordGuess(text);
    } catch (e) { return keywordGuess(text); }
  }

  // ---- GET: load state ----
  if (req.method === 'GET') {
    return res.status(200).json({ success: true, state: await readState() });
  }

  // ---- POST: save or capture ----
  if (req.method === 'POST') {
    const { action, state, text } = req.body || {};
    try {
      if (action === 'save') {
        if (!state) return res.status(400).json({ error: 'No state provided' });
        await writeState(state);
        return res.status(200).json({ success: true });
      }

      if (action === 'capture') {
        if (!text || !text.trim()) return res.status(400).json({ error: 'No text' });
        const domain = await guessDomain(text);
        const current = await readState();
        if (!current) return res.status(409).json({ error: 'No state yet — load the page once first' });
        current.inbox = current.inbox || [];
        current.inbox.push({ id: 'i' + Date.now() + Math.floor(Math.random() * 1000), text: text.trim(), sug: domain });
        await writeState(current);
        return res.status(200).json({ success: true, state: current });
      }

      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      console.error('POST error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
