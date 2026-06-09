export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dump, done, currentDashboard } = req.body;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;

  if (!ANTHROPIC_KEY || !NOTION_TOKEN || !NOTION_PAGE_ID) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  try {
    // 1. Call Claude
    const doneSection = done && done.length ? `\nCompleted items to remove:\n${done.join('\n')}\n` : '';
    const prompt = `You maintain a life dashboard for Jonas. Here is the current dashboard as JSON:\n${JSON.stringify(currentDashboard)}\n${doneSection}\nNew thoughts (raw inbox — integrate without over-interpreting):\n${dump || '(none)'}\n\nReturn ONLY a valid JSON array. Each item: {"id":"domain_id","now":[...],"next":[...],"later":[...]}. Domain ids: transition, thesis, move, housing, life, career, reading, ai. Rules: remove completed items, integrate new thoughts into correct domain and tier, keep NOW short and actionable this week, preserve existing items, avoid duplication, short verb-first phrases. No commentary, no markdown, just the JSON array.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });

    if (!claudeRes.ok) throw new Error(`Claude error: ${claudeRes.status}`);
    const claudeData = await claudeRes.json();
    const raw = claudeData.content[0].text.replace(/```json|```/g, '').trim();
    const updates = JSON.parse(raw);

    // 2. Write to Notion
    // Clear existing blocks
    const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children`, {
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
    });
    const blocksData = await blocksRes.json();
    for (const block of blocksData.results || []) {
      await fetch(`https://api.notion.com/v1/blocks/${block.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
      });
    }

    // Build updated dashboard text for Notion
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
      await fetch(`https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ children: blocks.slice(i, i+100) })
      });
    }

    return res.status(200).json({ success: true, updates });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
