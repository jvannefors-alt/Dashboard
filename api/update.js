export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
  const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
  const EDGE_CONFIG = process.env.EDGE_CONFIG;

  if (!ANTHROPIC_KEY || !NOTION_TOKEN || !NOTION_PAGE_ID) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  // GET — load from Edge Config
  if (req.method === 'GET') {
    try {
      if (!EDGE_CONFIG || !VERCEL_API_TOKEN) return res.status(200).json({ success: true, state: null });
      const ecId = EDGE_CONFIG.split('edge-config.vercel.com/')[1].split('?')[0];
      const r = await fetch(`https://api.vercel.com/v1/edge-config/${ecId}/item/dashboard_state`, {
        headers: { 'Authorization': `Bearer ${VERCEL_API_TOKEN}` }
      });
      if (!r.ok) return res.status(200).json({ success: true, state: null });
      const data = await r.json();
      return res.status(200).json({ success: true, state: data.value || null });
    } catch(e) {
      return res.status(200).json({ success: true, state: null });
    }
  }

  // POST — update dashboard
  if (req.method === 'POST') {
    const { dump, done, currentDashboard } = req.body;
    try {
      // 1. Call Claude
      const doneSection = done && done.length ? `\nCompleted items to remove:\n${done.join('\n')}\n` : '';
      const prompt = `You maintain a life dashboard for Jonas. Current dashboard:\n${JSON.stringify(currentDashboard)}\n${doneSection}\nNew thoughts:\n${dump || '(none)'}\n\nReturn ONLY a JSON array. Each item: {"id":"domain_id","now":[...],"next":[...],"later":[...]}. Domain ids: transition, thesis, move, housing, life, career, reading, ai. Remove completed items, integrate new thoughts, keep NOW actionable this week, preserve existing items, avoid duplication, short verb-first phrases. JSON only, no commentary.`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
      });
      if (!claudeRes.ok) throw new Error(`Claude error: ${claudeRes.status}`);
      const claudeData = await claudeRes.json();
      const raw = claudeData.content[0].text.replace(/```json|```/g, '').trim();
      const updates = JSON.parse(raw);

      // 2. Save to Edge Config FIRST (fast, reliable)
      if (EDGE_CONFIG && VERCEL_API_TOKEN) {
        const ecId = EDGE_CONFIG.split('edge-config.vercel.com/')[1].split('?')[0];
        await fetch(`https://api.vercel.com/v1/edge-config/${ecId}/items`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${VERCEL_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ operation: 'upsert', key: 'dashboard_state', value: updates }] })
        });
      }

      // 3. Update Notion in background (don't block response)
      updateNotion(updates, NOTION_TOKEN, NOTION_PAGE_ID).catch(e => console.error('Notion update failed:', e));

      return res.status(200).json({ success: true, updates });
    } catch(e) {
      console.error('POST error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function updateNotion(updates, token, pageId) {
  // Get existing blocks
  const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
  });
  const blocksData = await blocksRes.json();
  
  // Delete in parallel (much faster)
  await Promise.all((blocksData.results || []).map(block =>
    fetch(`https://api.notion.com/v1/blocks/${block.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    })
  ));

  const domainNames = { transition:'TRANSITION', thesis:'MASTER THESIS', move:'MOVE', housing:'BUYING / HOUSING', life:'LIFE / SOCIAL / ENERGY', career:'CAREER / EDUCATION', reading:'READING / THINKING', ai:'AI / TECH PROJECTS' };
  const blocks = [];
  blocks.push({ object:'block', type:'paragraph', paragraph:{ rich_text:[{ type:'text', text:{ content:`Updated: ${new Date().toLocaleDateString('sv-SE',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}` }, annotations:{ color:'gray' } }] } });
  blocks.push({ object:'block', type:'divider', divider:{} });
  updates.forEach(u => {
    blocks.push({ object:'block', type:'heading_2', heading_2:{ rich_text:[{ type:'text', text:{ content: domainNames[u.id] || u.id.toUpperCase() } }] } });
    ['now','next','later'].forEach(tier => {
      blocks.push({ object:'block', type:'heading_3', heading_3:{ rich_text:[{ type:'text', text:{ content: tier.toUpperCase() } }] } });
      (u[tier]||[]).forEach(item => {
        blocks.push({ object:'block', type:'bulleted_list_item', bulleted_list_item:{ rich_text:[{ type:'text', text:{ content: item } }] } });
      });
    });
  });

  for (let i = 0; i < blocks.length; i += 100) {
    await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ children: blocks.slice(i, i+100) })
    });
  }
}
