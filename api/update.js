// api/update.js — Life OS backend on Redis (Upstash via REDIS_URL)
// Same contract as before, just a bigger, write-friendly store:
//   GET                              -> { success, state }   (auto-migrates old Edge Config data on first read)
//   POST { action:'save', state }    -> persist the whole board
//   POST { action:'capture', text }  -> Haiku guesses a domain, thought appended to inbox
//   POST { action:'briefing', context } -> Haiku writes the voiced read

import Redis from 'ioredis';

const KEY = 'dashboard_v2';
const PROG_KEYS = ['skate_v1', 'curriculum_v1', 'thesis_drill_v1'];
const DOMAIN_IDS = ['thesis','career','tree','reading','house','life','build','hobbies'];

let _redis;
function redis() {
  if (!_redis) _redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  return _redis;
}

// one-time fallback: read the old state out of Edge Config so nothing is lost on the move
async function edgeGet(key) {
  const EDGE_CONFIG = process.env.EDGE_CONFIG, VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
  if (!EDGE_CONFIG || !VERCEL_API_TOKEN) return null;
  try {
    const id = EDGE_CONFIG.split('edge-config.vercel.com/')[1].split('?')[0];
    const r = await fetch(`https://api.vercel.com/v1/edge-config/${id}/item/${key}`, {
      headers: { 'Authorization': `Bearer ${VERCEL_API_TOKEN}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.value || null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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
      const prompt = `Sort this captured thought into ONE domain of Jonas's life dashboard.\nDomains: thesis, career, tree (his Substack), reading, house, life, build (side projects/coding), hobbies (climbing/skating/music/graffiti).\nThought: "${text}"\nReturn ONLY the domain id.`;
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

  // ---- GET: load state (migrate from Edge Config on first run) ----
  if (req.method === 'GET') {
    try {
      const v = await redis().get(KEY);
      if (v) return res.status(200).json({ success: true, state: JSON.parse(v) });
      const old = await edgeGet(KEY);
      if (old) { await redis().set(KEY, JSON.stringify(old)); return res.status(200).json({ success: true, state: old }); }
      return res.status(200).json({ success: true, state: null });
    } catch (e) {
      console.error('GET error:', e);
      return res.status(200).json({ success: true, state: null });
    }
  }

  // ---- POST ----
  if (req.method === 'POST') {
    const { action, state, text } = req.body || {};
    try {
      if (action === 'save') {
        if (!state) return res.status(400).json({ error: 'No state provided' });
        await redis().set(KEY, JSON.stringify(state));
        return res.status(200).json({ success: true });
      }

      if (action === 'capture') {
        if (!text || !text.trim()) return res.status(400).json({ error: 'No text' });
        const domain = await guessDomain(text);
        const raw = await redis().get(KEY);
        const current = raw ? JSON.parse(raw) : null;
        if (!current) return res.status(409).json({ error: 'No state yet — load the page once first' });
        current.inbox = current.inbox || [];
        current.inbox.push({ id: 'i' + Date.now() + Math.floor(Math.random() * 1000), text: text.trim(), sug: domain });
        await redis().set(KEY, JSON.stringify(current));
        return res.status(200).json({ success: true, state: current });
      }

      if (action === 'briefing') {
        const context = (req.body.context || '').slice(0, 3000);
        if (!ANTHROPIC_KEY) return res.status(200).json({ success: true, text: null });
        const prompt = `You are the weekly briefing voice for a personal life dashboard. Speak to the person directly, calm and sharp, like a trusted advisor who knows their situation — not a cheerleader, no exclamation marks. In 2-3 sentences (under 60 words), name what the week is really about using the specific items given, and where it helps, raise ONE pointed observation about drift or tension as a question or invitation — never a scold or a judgement. Use only the facts in the state below; do not invent anything. No lists, no headings, no preamble — write only the briefing.\n\nState:\n${context}\n\nWrite only the briefing.`;
        try {
          const rr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
          });
          if (!rr.ok) return res.status(200).json({ success: true, text: null });
          const dd = await rr.json();
          const t = (dd.content && dd.content[0] && dd.content[0].text || '').trim();
          return res.status(200).json({ success: true, text: t || null });
        } catch (e) {
          return res.status(200).json({ success: true, text: null });
        }
      }

      if (action === 'progGet') {
        const key = req.body.key;
        if (!PROG_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown program key' });
        const v = await redis().get(key);
        return res.status(200).json({ success: true, state: v ? JSON.parse(v) : null });
      }

      if (action === 'progSave') {
        const key = req.body.key;
        if (!PROG_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown program key' });
        if (req.body.state === undefined) return res.status(400).json({ error: 'No state provided' });
        await redis().set(key, JSON.stringify(req.body.state));
        return res.status(200).json({ success: true });
      }

      if (action === 'gradeThesis') {
        const { question, risk, reference, notes, studentAnswer } = req.body;
        if (!ANTHROPIC_KEY) return res.status(200).json({ success: true, result: null });
        const sys = `You are a rigorous but fair oral examiner for a Swedish master's thesis defence in monetary economics (the bank lending channel and the external financing premium). Grade the student's spoken-answer attempt against the reference answer for one specific question.

Watch specifically for these four recurring habits and name them if they occur:
1. Conflating Bernanke & Blinder (1988) with Bernanke & Gertler (1995) — different papers, different jobs.
2. Restating a definition instead of instantiating it with a concrete example, when the question calls for one.
3. Predicting the wrong direction on a result (e.g. guessing a variable should lose significance when the reference says it remains significant, or vice versa).
4. Overclaiming "directly tests" where the reference only supports "consistent with."

Respond with ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:
{"rating": "nailed" | "shaky" | "blanked", "verdict": "a short 4-8 word headline", "feedback": "2-4 sentences of specific, concrete feedback — name exactly what was captured and what was missing or wrong, in the voice of a demanding but constructive examiner, not generic praise"}`;
        const userMsg = 'QUESTION: ' + (question || '')
          + '\n\nWHY IT\'S A RISK: ' + (risk || 'n/a')
          + '\n\nREFERENCE ANSWER: ' + (reference || '')
          + '\n\nREFERENCE NOTES: ' + (notes && notes.length ? notes.join(' | ') : 'none')
          + '\n\nSTUDENT\'S ATTEMPT: ' + (studentAnswer || '');
        try {
          const rr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 500, system: sys, messages: [{ role: 'user', content: userMsg }] })
          });
          if (!rr.ok) return res.status(200).json({ success: true, result: null });
          const dd = await rr.json();
          let t = (dd.content && dd.content[0] && dd.content[0].text || '').trim();
          t = t.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
          let parsed;
          try { parsed = JSON.parse(t); } catch (e) { parsed = null; }
          if (!parsed || !['nailed', 'shaky', 'blanked'].includes(parsed.rating)) return res.status(200).json({ success: true, result: null });
          return res.status(200).json({ success: true, result: parsed });
        } catch (e) {
          return res.status(200).json({ success: true, result: null });
        }
      }

      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      console.error('POST error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
