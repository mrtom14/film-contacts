const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const ZOHO_MCP = "https://zoho-mail-mcp-923873690.zohomcp.com/mcp/cdfe522995d14b465fb412f842d9d820/message";
const ACCOUNT_ID = "6645206000000008001";
const API_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEPARTMENTS = ["Production","AD Dept","Camera","Lighting","Sound","Art Dept","Costume","HMU","Locations","Grip","Editorial","Stills/BTS","Runners","Transport","Medical","SFX","Casting","Movement","Agency"];

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      s.processed = new Set(s.processed || []);
      return s;
    }
  } catch(e) {}
  return { crew: {}, agency: {}, shoots: [], productions: {}, processed: new Set(), skipped: 0, errors: 0, allIds: [] };
}

function saveState(state) {
  const s = Object.assign({}, state, { processed: Array.from(state.processed) });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}

async function callClaude(system, user) {
  const r = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system, messages: [{ role: 'user', content: user }] })
  });
  return r.json();
}

async function callClaudeMCP(prompt) {
  const r = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-client-2025-04-04' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
      mcp_servers: [{ type: 'url', url: ZOHO_MCP, name: 'zoho' }]
    })
  });
  return r.json();
}

function getText(data) {
  if (!data || !data.content) return '';
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function getToolResults(data) {
  if (!data || !data.content) return [];
  return data.content.filter(b => b.type === 'mcp_tool_result').map(b => (b.content && b.content[0] && b.content[0].text) || '').filter(Boolean);
}

function mergeData(state, data, fallbackDate) {
  const date = data.shoot_date || fallbackDate || 'Unknown';
  const title = data.production_title || 'Unknown';
  const year = (date && date !== 'Unknown') ? date.substring(0, 4) : 'Unknown';
  const mapsLink = data.location_maps_query ? 'https://maps.google.com/?q=' + encodeURIComponent(data.location_maps_query) : '';
  const pk = title + '|' + year;
  const brands = (data.brands || []).filter(Boolean).slice(0, 3);
  if (!state.productions[pk]) {
    state.productions[pk] = { title, year, type: data.project_type || 'Unknown', director: data.director || '', producer: data.producer || '', production_company: data.production_company || '', client: data.client || '', brands: brands, dates: [] };
  }
  const prod = state.productions[pk];
  if (date !== 'Unknown' && !prod.dates.includes(date)) prod.dates.push(date);
  ['director','producer','production_company'].forEach(f => { if (!prod[f] && data[f]) prod[f] = data[f]; });
  if ((!prod.brands || !prod.brands.length) && brands.length) prod.brands = brands;
  state.shoots.push({ date, title, type: data.project_type, director: data.director, producer: data.producer, production_company: data.production_company, client: data.client, brands: brands, location: data.location, maps_link: mapsLink });
  for (const p of (data.crew || [])) {
    if (!p.name) continue;
    const key = p.name + '|' + (p.phone || '') + '|' + (p.email || '');
    const store = p.is_agency ? state.agency : state.crew;
    if (!store[key]) store[key] = { name: p.name, primary_role: p.role || '', department: p.department || '', phone: p.phone || '', email: p.email || '', shoots: [] };
    store[key].primary_role = p.role || '';
    store[key].shoots.push({ date, role: p.role || '', project: title, client: data.client || '', location: data.location || '', maps_link: mapsLink });
  }
}

// SSE clients
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
}

// Routes
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
  // Send current state immediately
  const state = loadState();
  res.write(`event: status\ndata: ${JSON.stringify({ processed: state.processed.size, total: state.allIds.length, skipped: state.skipped, errors: state.errors, crew: Object.keys(state.crew).length, agency: Object.keys(state.agency).length, productions: Object.keys(state.productions).length, shoots: state.shoots.length })}\n\n`);
});

app.get('/state', (req, res) => {
  const state = loadState();
  res.json({ processed: state.processed.size, total: state.allIds.length, skipped: state.skipped, errors: state.errors, crew: Object.keys(state.crew).length, agency: Object.keys(state.agency).length, productions: Object.keys(state.productions).length, shoots: state.shoots.length });
});

app.post('/reset', (req, res) => {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  res.json({ ok: true });
});

app.post('/load-checkpoint', (req, res) => {
  try {
    const saved = req.body;
    if (!saved || !saved.allIds || !saved.allIds.length) return res.status(400).json({ error: 'Invalid checkpoint' });
    const state = { crew: saved.crew || {}, agency: saved.agency || {}, shoots: saved.shoots || [], productions: saved.productions || {}, processed: new Set(saved.processed || []), skipped: saved.skipped || 0, errors: saved.errors || 0, allIds: saved.allIds || [] };
    saveState(state);
    res.json({ ok: true, processed: state.processed.size, total: state.allIds.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

let running = false;
let stopFlag = false;

app.post('/start', async (req, res) => {
  if (running) return res.json({ ok: false, message: 'Already running' });
  res.json({ ok: true });
  running = true; stopFlag = false;

  try {
    let state = loadState();

    // Fetch email IDs if needed
    if (!state.allIds || !state.allIds.length) {
      broadcast('log', { msg: 'Searching Zoho for call sheet emails...', type: 'info' });
      let ids = [];
      for (let offset = 1; offset <= 1001; offset += 200) {
        if (stopFlag) break;
        broadcast('log', { msg: 'Fetching email list (offset ' + offset + ')...', type: 'info' });
        try {
          const res2 = await callClaudeMCP(
            'Use ZohoMail_SearchEmails with accountId=' + ACCOUNT_ID + ', searchKey=subject:call sheet, start=' + offset + ', limit=200. ' +
            'From the results data array, collect every messageId value. ' +
            'Return ONLY a JSON array of those messageId strings with no other text, e.g. ["abc123","def456"].'
          );
          const raw = getToolResults(res2).join('\n') + '\n' + getText(res2);
          const arrMatch = raw.match(/\[\s*"[^"]+"\s*(?:,\s*"[^"]+"\s*)*\]/);
          if (arrMatch) {
            try {
              const batch = JSON.parse(arrMatch[0]).filter(id => id && id.length > 3);
              if (batch.length > 0) { ids = Array.from(new Set([...ids, ...batch])); broadcast('log', { msg: '  -> +' + batch.length + ' IDs (total: ' + ids.length + ')', type: 'success' }); continue; }
            } catch(e2) {}
          }
          const msgIds = Array.from(raw.matchAll(/"messageId"\s*:\s*"([^"]+)"/g)).map(m => m[1]);
          if (msgIds.length > 0) { ids = Array.from(new Set([...ids, ...msgIds])); broadcast('log', { msg: '  -> +' + msgIds.length + ' IDs (total: ' + ids.length + ')', type: 'success' }); }
          else { broadcast('log', { msg: '  -> No IDs at offset ' + offset, type: 'warn' }); break; }
        } catch(e) { broadcast('log', { msg: '  -> Error at offset ' + offset + ': ' + e.message, type: 'warn' }); }
      }
      state.allIds = ids;
      saveState(state);
      broadcast('log', { msg: 'Found ' + ids.length + ' emails total.', type: ids.length > 0 ? 'success' : 'warn' });
      if (!ids.length) { broadcast('log', { msg: 'No emails found. Check Zoho connection.', type: 'error' }); running = false; return; }
    }

    // Process emails
    const todo = state.allIds.filter(id => !state.processed.has(id));
    broadcast('log', { msg: 'Starting extraction: ' + todo.length + ' emails to process.', type: 'info' });
    broadcast('status', { processed: state.processed.size, total: state.allIds.length, skipped: state.skipped, errors: state.errors, crew: Object.keys(state.crew).length, agency: Object.keys(state.agency).length, productions: Object.keys(state.productions).length, shoots: state.shoots.length });

    const BATCH = 4;
    for (let i = 0; i < todo.length; i += BATCH) {
      if (stopFlag) {
        saveState(state);
        broadcast('log', { msg: 'Paused. Progress saved.', type: 'warn' });
        broadcast('paused', {});
        running = false; return;
      }
      const batch = todo.slice(i, i + BATCH);
      await Promise.all(batch.map(async msgId => {
        try {
          const r1 = await callClaudeMCP('Use ZohoMail_getMessageContent with accountId="' + ACCOUNT_ID + '" and messageId="' + msgId + '". Return the full plain text body.');
          const body = (getToolResults(r1).join('\n') + '\n' + getText(r1)).trim();
          if (body.length < 80) { state.processed.add(msgId); state.skipped++; return; }
          const r2 = await callClaude(
            'Extract film/TV call sheet data and return ONLY valid JSON with no markdown fences or preamble.\nSchema: {"production_title":string,"shoot_date":string|null,"project_type":"Feature Film"|"Short Film"|"Documentary"|"Commercial"|"Corporate"|"TV Drama"|"TV Comedy"|"Music Video"|"Other","director":string|null,"producer":string|null,"production_company":string|null,"client":string|null,"brands":["string","string","string"],"location":string|null,"location_maps_query":string|null,"crew":[{"name":string,"role":string,"department":string,"phone":string|null,"email":string|null,"is_agency":boolean}]}\nRules: exclude Tom Osborn. department must be one of: ' + DEPARTMENTS.join(',') + '. Prefix uncertain values with ~. is_agency=true for agency/production company contacts. brands: extract up to 3 brand/advertiser names mentioned anywhere in the call sheet (e.g. Amazon Prime, Netflix, Fiat, West Ham) — only populate for Commercial or Corporate projects, leave empty array for all others. These are the end brands the work is being made for, not crew or production companies.',
            'CALL SHEET:\n\n' + body.substring(0, 7000)
          );
          let raw = getText(r2).replace(/```json|```/g, '').trim();
          let data;
          try { data = JSON.parse(raw); } catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { data = JSON.parse(m[0]); } catch(e2) { state.processed.add(msgId); state.errors++; return; } } else { state.processed.add(msgId); state.errors++; return; } }
          mergeData(state, data);
          state.processed.add(msgId);
          broadcast('log', { msg: '✓ ' + (data.production_title || 'Unknown') + ' (' + (data.shoot_date || '?') + ') — ' + (data.crew || []).length + ' crew', type: 'success' });
        } catch(e) { state.processed.add(msgId); state.errors++; broadcast('log', { msg: '✗ ' + msgId.slice(-6) + ': ' + e.message, type: 'warn' }); }
      }));
      saveState(state);
      broadcast('status', { processed: state.processed.size, total: state.allIds.length, skipped: state.skipped, errors: state.errors, crew: Object.keys(state.crew).length, agency: Object.keys(state.agency).length, productions: Object.keys(state.productions).length, shoots: state.shoots.length });
    }

    broadcast('log', { msg: '✅ Complete! ' + state.processed.size + ' processed, ' + state.skipped + ' skipped, ' + state.errors + ' errors.', type: 'success' });
    broadcast('done', {});
  } catch(e) {
    broadcast('log', { msg: 'Fatal error: ' + e.message, type: 'error' });
  }
  running = false;
});

app.post('/stop', (req, res) => { stopFlag = true; res.json({ ok: true }); });

app.get('/download', (req, res) => {
  const state = loadState();
  res.json({ crew: state.crew, agency: state.agency, shoots: state.shoots, productions: state.productions, processed: Array.from(state.processed), allIds: state.allIds, skipped: state.skipped, errors: state.errors });
});

app.listen(3000, () => console.log('Server running on port 3000'));
