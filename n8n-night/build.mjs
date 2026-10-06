// Generates the workflow JSON files in ./workflows from compact definitions.
// Usage: node build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out').replaceAll('\\', '/');

const every = (field, n) => ({ interval: [{ field, [`${field}Interval`]: n }] });
const dailyAt = hour => ({ interval: [{ field: 'days', daysInterval: 1, triggerAtHour: hour }] });

const code = (name, jsCode) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode } });
const http = (name, url, responseFormat = 'json') => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, onError: 'continueRegularOutput',
  parameters: { url, options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat } } } },
});
const rss = name => ({
  name, type: 'n8n-nodes-base.rssFeedRead', typeVersion: 1.1, onError: 'continueRegularOutput',
  parameters: { url: '={{ $json.url }}', options: {} },
});
const readFile = (name, file) => ({
  name, type: 'n8n-nodes-base.readWriteFile', typeVersion: 1, onError: 'continueRegularOutput', alwaysOutputData: true,
  parameters: { operation: 'read', fileSelector: `${OUT}/${file}`, options: {} },
});
// Turns $json.<prop> into a file and writes it to out/<file>.
const save = (name, file, { prop = 'text', append = false } = {}) => [
  { name: `${name} (to file)`, type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1,
    parameters: { operation: 'toText', sourceProperty: prop, options: { fileName: file } } },
  { name, type: 'n8n-nodes-base.readWriteFile', typeVersion: 1,
    parameters: { operation: 'write', fileName: `${OUT}/${file}`, dataPropertyName: 'data', options: { append } } },
];

function workflow({ id, name, rule, extraTriggers = [], chain }) {
  const steps = chain.flat();
  const triggers = [
    { name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule } },
    { name: 'Run now', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    ...extraTriggers,
  ];
  const nodes = [
    ...triggers.map((n, i) => ({ ...n, id: `${id}-t${i}`, position: [0, i * 180] })),
    ...steps.map((n, i) => ({ ...n, id: `${id}-s${i}`, position: [(i + 1) * 220, 0] })),
  ];
  const link = to => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  const connections = {};
  for (const t of triggers) connections[t.name] = link(steps[0].name);
  steps.slice(0, -1).forEach((n, i) => { connections[n.name] = link(steps[i + 1].name); });
  return { id, name, active: false, nodes, connections, settings: { executionOrder: 'v1' } };
}

const workflows = {
  '01-uptime': workflow({
    id: 'night01uptime', name: '01 Uptime monitor (replaces UptimeRobot)', rule: every('minutes', 5),
    chain: [
      code('Sites', `const sites = ['https://x.com', 'https://n8n.io', 'https://github.com', 'https://news.ycombinator.com'];
return sites.map(url => ({ json: { url } }));`),
      http('Ping', '={{ $json.url }}', 'text'),
      code('Build log line', `const sites = $('Sites').all();
const checkedAt = new Date().toISOString();
const rows = $input.all().map((item, i) => {
  const status = item.json.statusCode ?? 0;
  return { checkedAt, url: sites[i].json.url, status, up: status >= 200 && status < 400 };
});
return [{ json: { down: rows.filter(r => !r.up).length, total: rows.length, text: rows.map(r => JSON.stringify(r)).join('\\n') + '\\n' } }];`),
      save('Append to log', 'uptime.jsonl', { append: true }),
    ],
  }),

  '02-rss-digest': workflow({
    id: 'night02rss', name: '02 RSS digest (replaces Feedly Pro)', rule: dailyAt(8),
    chain: [
      code('Feeds', `const feeds = ['https://hnrss.org/frontpage', 'https://blog.n8n.io/rss/', 'https://huggingface.co/blog/feed.xml', 'https://simonwillison.net/atom/everything/'];
return feeds.map(url => ({ json: { url } }));`),
      rss('Read feed'),
      code('Build digest', `const since = Date.now() - 48 * 3600 * 1000;
const fresh = $input.all().map(i => i.json)
  .filter(p => p.title && p.link && new Date(p.isoDate || p.pubDate).getTime() > since)
  .sort((a, b) => new Date(b.isoDate || b.pubDate) - new Date(a.isoDate || a.pubDate))
  .slice(0, 25);
const lines = fresh.map(p => '- [' + p.title.trim() + '](' + p.link + ') - ' + (p.link.match(/^https?:\\/\\/([^\\/]+)/)?.[1] ?? ''));
const text = '# Digest ' + new Date().toISOString().slice(0, 10) + '\\n\\n' + lines.join('\\n') + '\\n';
return [{ json: { count: fresh.length, text } }];`),
      save('Write digest', 'digest.md'),
    ],
  }),

  '03-mentions': workflow({
    id: 'night03mentions', name: '03 Mention tracker (replaces Brand24)', rule: every('hours', 1),
    chain: [
      code('Keywords', `return ['n8n', 'claude code', 'mcp server'].map(q => ({ json: { q } }));`),
      http('Search Hacker News', '=https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=8&query={{ encodeURIComponent($json.q) }}'),
      code('Build mention list', `const keywords = $('Keywords').all();
let total = 0;
const blocks = $input.all().map((item, i) => {
  const hits = item.json.body?.hits ?? [];
  total += hits.length;
  const lines = hits.map(h => '- ' + h.created_at.slice(0, 16).replace('T', ' ') + ' | ' + h.points + ' pts | [' + h.title + '](https://news.ycombinator.com/item?id=' + h.objectID + ')');
  return '## ' + keywords[i].json.q + '\\n\\n' + lines.join('\\n');
});
return [{ json: { total, text: '# Mentions ' + new Date().toISOString() + '\\n\\n' + blocks.join('\\n\\n') + '\\n' } }];`),
      save('Write mentions', 'mentions.md'),
    ],
  }),

  '04-page-changes': workflow({
    id: 'night04pages', name: '04 Page change monitor (replaces Visualping)', rule: every('hours', 6),
    chain: [
      readFile('Read last hashes', 'state-pages.json'),
      code('Pages', `let prev = {};
try { prev = JSON.parse((await this.helpers.getBinaryDataBuffer(0, 'data')).toString()); } catch (e) {}
const pages = ['https://n8n.io/pricing/', 'https://docs.n8n.io/release-notes/', 'https://www.anthropic.com/pricing'];
return pages.map(url => ({ json: { url, prevHash: prev[url] ?? null } }));`),
      http('Fetch page', '={{ $json.url }}', 'text'),
      code('Compare', `const pages = $('Pages').all();
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
const state = {};
const rows = $input.all().map((item, i) => {
  const { url, prevHash } = pages[i].json;
  const body = String(item.json.data ?? '').replace(/<script[\\s\\S]*?<\\/script>/g, '').replace(/<style[\\s\\S]*?<\\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ');
  const ok = item.json.statusCode === 200;
  const h = ok ? hash(body) : prevHash;
  if (h) state[url] = h;
  return { checkedAt: new Date().toISOString(), url, status: !ok ? 'fetch failed' : prevHash === null ? 'baseline saved' : prevHash === h ? 'no change' : 'CHANGED' };
});
return [{ json: { changed: rows.filter(r => r.status === 'CHANGED').length, stateText: JSON.stringify(state, null, 2), text: rows.map(r => JSON.stringify(r)).join('\\n') + '\\n' } }];`),
      save('Save hashes', 'state-pages.json', { prop: 'stateText' }),
      code('Change log line', `return [{ json: { text: $('Compare').first().json.text } }];`),
      save('Append change log', 'page-changes.jsonl', { append: true }),
    ],
  }),

  '05-price-alerts': workflow({
    id: 'night05prices', name: '05 Price alerts (replaces TradingView alerts)', rule: every('minutes', 15),
    chain: [
      http('Get prices', 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true'),
      code('Check moves', `const THRESHOLD = 3; // percent in 24h
const data = $input.first().json.body ?? {};
const at = new Date().toISOString();
const rows = Object.entries(data).map(([coin, v]) => {
  const change = Number((v.usd_24h_change ?? 0).toFixed(2));
  return { at, coin, usd: v.usd, change24h: change, alert: Math.abs(change) >= THRESHOLD };
});
if (!rows.length) throw new Error('No price data: HTTP ' + $input.first().json.statusCode);
return [{ json: { alerts: rows.filter(r => r.alert).length, text: rows.map(r => JSON.stringify(r)).join('\\n') + '\\n' } }];`),
      save('Append prices', 'price-alerts.jsonl', { append: true }),
    ],
  }),

  '06-broken-links': workflow({
    id: 'night06links', name: '06 Broken link checker (replaces Dr. Link Check)', rule: every('days', 7),
    chain: [
      http('Fetch page', 'https://raw.githubusercontent.com/n8n-io/n8n/master/README.md', 'text'),
      code('Extract links', `const body = String($input.first().json.data ?? '');
const links = [...new Set(body.match(/https?:\\/\\/[^\\s)"'<>\\]]+/g) ?? [])].filter(u => !/\\/\\/(localhost|127\\.0\\.0\\.1)/.test(u)).slice(0, 30);
if (!links.length) throw new Error('No links found: HTTP ' + $input.first().json.statusCode);
return links.map(url => ({ json: { url } }));`),
      http('Check link', '={{ $json.url }}', 'text'),
      code('Build link report', `const links = $('Extract links').all();
const rows = $input.all().map((item, i) => ({ url: links[i].json.url, status: item.json.statusCode ?? 0 }));
const broken = rows.filter(r => r.status === 0 || r.status >= 400);
const text = '# Link check ' + new Date().toISOString() + '\\n\\nchecked: ' + rows.length + ', broken: ' + broken.length + '\\n\\n' + broken.map(r => '- ' + r.status + ' ' + r.url).join('\\n') + '\\n';
return [{ json: { checked: rows.length, broken: broken.length, text } }];`),
      save('Write link report', 'broken-links.md'),
    ],
  }),

  '07-post-queue': workflow({
    id: 'night07queue', name: '07 Post queue (replaces Buffer)', rule: every('minutes', 10),
    chain: [
      readFile('Read queue', 'queue.json'),
      code('Pick due posts', `let queue;
try { queue = JSON.parse((await this.helpers.getBinaryDataBuffer(0, 'data')).toString()); } catch (e) { throw new Error('queue.json is missing or not valid JSON'); }
const now = new Date();
const due = queue.filter(p => !p.sentAt && new Date(p.at) <= now);
for (const p of due) p.sentAt = now.toISOString();
// Publishing to X needs an API key, so due posts go to outbox.jsonl for now.
return [{ json: { due: due.length, waiting: queue.filter(p => !p.sentAt).length, queueText: JSON.stringify(queue, null, 2), text: due.map(p => JSON.stringify(p)).join('\\n') + (due.length ? '\\n' : '') } }];`),
      save('Save queue', 'queue.json', { prop: 'queueText' }),
      code('Outbox lines', `return [{ json: { text: $('Pick due posts').first().json.text } }];`),
      save('Append outbox', 'outbox.jsonl', { append: true }),
    ],
  }),

  '08-lead-webhook': workflow({
    id: 'night08leads', name: '08 Lead form webhook (replaces Zapier)', rule: every('days', 1),
    extraTriggers: [{ name: 'Lead webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: 'night08leads',
      parameters: { httpMethod: 'POST', path: 'lead', responseMode: 'onReceived', options: {} } }],
    chain: [
      code('Validate lead', `const src = $input.first().json;
// Schedule and manual runs have no body, so they send a test lead.
const lead = src.body ?? { name: 'Test Lead', email: 'test@example.com', note: 'self-test' };
const email = String(lead.email ?? '').trim().toLowerCase();
if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) throw new Error('Invalid email: ' + email);
const row = { receivedAt: new Date().toISOString(), name: String(lead.name ?? '').trim(), email, note: String(lead.note ?? '').trim(), test: !src.body };
return [{ json: { ...row, text: JSON.stringify(row) + '\\n' } }];`),
      save('Append lead', 'leads.jsonl', { append: true }),
    ],
  }),

  '09-morning-report': workflow({
    id: 'night09report', name: '09 Morning report', rule: dailyAt(7),
    chain: [
      { name: 'Read all outputs', type: 'n8n-nodes-base.readWriteFile', typeVersion: 1, alwaysOutputData: true,
        parameters: { operation: 'read', fileSelector: `${OUT}/*.{jsonl,md}`, options: {} } },
      code('Build report', `const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rows = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const meta = items[i].binary?.data;
  if (!meta) continue;
  const lines = (await this.helpers.getBinaryDataBuffer(i, 'data')).toString().split('\\n').filter(l => l.trim());
  rows.push({ file: meta.fileName, lines: lines.length, last: lines[lines.length - 1] ?? '' });
}
rows.sort((a, b) => a.file.localeCompare(b.file));
const html = '<!doctype html><meta charset="utf-8"><title>n8n morning report</title>' +
  '<style>body{background:#0e0f13;color:#e8e8ea;font:15px/1.5 ui-monospace,Consolas,monospace;padding:32px;max-width:900px;margin:auto}h1{font-size:22px}td,th{padding:8px 12px;border-bottom:1px solid #2a2c35;text-align:left;vertical-align:top}th{color:#8b8fa3}.last{color:#8b8fa3;word-break:break-all;font-size:12px}</style>' +
  '<h1>morning report - ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC</h1>' +
  '<p>' + rows.length + ' output files, ' + rows.reduce((n, r) => n + r.lines, 0) + ' lines written by the workflows</p>' +
  '<table><tr><th>file</th><th>lines</th><th>last line</th></tr>' +
  rows.map(r => '<tr><td>' + esc(r.file) + '</td><td>' + r.lines + '</td><td class="last">' + esc(r.last.slice(0, 220)) + '</td></tr>').join('') + '</table>';
return [{ json: { files: rows.length, text: html } }];`),
      save('Write report', 'report.html'),
    ],
  }),
};

mkdirSync(join(ROOT, 'workflows'), { recursive: true });
for (const [file, wf] of Object.entries(workflows)) {
  writeFileSync(join(ROOT, 'workflows', `${file}.json`), JSON.stringify(wf, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(workflows).length} workflows`);
