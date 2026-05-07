import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY;
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

// ─── Figma ────────────────────────────────────────────────────────────────────

async function fetchFigmaFile() {
  const res = await fetch(`https://api.figma.com/v1/files/${FIGMA_FILE_KEY}`, {
    headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN }
  });
  if (!res.ok) throw new Error(`Figma API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// Hash only the node's own properties — not its children.
// This means a hash change = THIS node changed, not something inside it.
function hashNodeProps(node) {
  const { children, ...props } = node;
  return createHash('sha256').update(JSON.stringify(props)).digest('hex').slice(0, 8);
}

function nodeUrl(nodeId) {
  return `https://www.figma.com/design/${FIGMA_FILE_KEY}?node-id=${nodeId.replace(':', '-')}`;
}

function normalizePageName(name) {
  return name.replace(/^[\s↳❖–-]+/, '').trim();
}

// Walk the full subtree of a top-level node, storing a hash for every
// individual node. `ancestorName` is the top-level container name used
// for grouping in the alert (e.g. "Food & Drink").
function buildNodeMap(node, map, ancestorName) {
  map[node.id] = {
    hash: hashNodeProps(node),
    name: node.name || node.type,
    type: node.type,
    ancestor: ancestorName
  };
  for (const child of node.children ?? []) {
    buildNodeMap(child, map, ancestorName);
  }
}

// Build a flat map of every node on a page, keyed by node ID.
function buildPageMap(pageChildren) {
  const map = {};
  for (const node of pageChildren) {
    // Skip non-design nodes
    if (['LINE', 'SLICE'].includes(node.type)) continue;
    buildNodeMap(node, map, node.name || node.type);
  }
  return map;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function sendSlack(changes) {
  if (!config.notifications.slack || !process.env.SLACK_WEBHOOK_URL) return;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🎨 Figma Update Detected', emoji: true }
    },
    { type: 'divider' }
  ];

  for (const [pageName, groups] of Object.entries(changes)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Page: ${normalizePageName(pageName)}*` }
    });

    // groups is a Map: ancestorName -> array of changed nodes
    for (const [ancestorName, nodes] of groups.entries()) {
      const MAX = 10;
      const visible = nodes.slice(0, MAX);
      const overflow = nodes.length - visible.length;

      const lines = visible
        .map(n => `      └ <${nodeUrl(n.id)}|${n.name}> ↗`)
        .join('\n');

      const overflowNote = overflow > 0 ? `\n      └ _+${overflow} more_` : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `• *<${nodeUrl(nodes[0]?.ancestorId || nodes[0]?.id)}|${ancestorName}>*\n${lines}${overflowNote}`
        }
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Checked at ${new Date().toUTCString()}` }]
  });

  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook error: ${res.status} — ${body}`);
  }
  console.log('Slack notification sent.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!FIGMA_FILE_KEY) throw new Error('FIGMA_FILE_KEY is not set');
  if (!process.env.FIGMA_TOKEN) throw new Error('FIGMA_TOKEN is not set');

  console.log('Fetching Figma file...');
  const figmaData = await fetchFigmaFile();

  const snapshotPath = join(__dirname, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const isFirstRun = Object.keys(snapshot.pages).length === 0;
  const newSnapshot = { lastChecked: new Date().toISOString(), pages: {} };
  const changes = {};

  for (const page of figmaData.document.children) {
    if (!config.watch.includes(normalizePageName(page.name))) continue;

    console.log(`Checking page: ${normalizePageName(page.name)}`);

    const currentMap = buildPageMap(page.children);
    const prevMap = snapshot.pages?.[page.name]?.nodes ?? {};

    newSnapshot.pages[page.name] = {
      nodes: Object.fromEntries(
        Object.entries(currentMap).map(([id, { hash }]) => [id, hash])
      )
    };

    if (isFirstRun) continue;

    // Group changed nodes by their top-level ancestor
    const groups = new Map();

    for (const [id, { hash, name, type, ancestor }] of Object.entries(currentMap)) {
      const prevHash = prevMap[id];
      if (prevHash === undefined || prevHash === hash) continue;

      if (!groups.has(ancestor)) groups.set(ancestor, []);
      groups.get(ancestor).push({ id, name, type });
    }

    if (groups.size > 0) {
      changes[page.name] = groups;
    }
  }

  writeFileSync(snapshotPath, JSON.stringify(newSnapshot, null, 2));

  if (isFirstRun) {
    console.log('First run — baseline snapshot saved. No alert sent.');
    return;
  }

  if (Object.keys(changes).length === 0) {
    console.log('Snapshot updated. No changes detected.');
    return;
  }

  console.log('Changes detected:');
  for (const [page, groups] of Object.entries(changes)) {
    console.log(`  ${normalizePageName(page)}:`);
    for (const [ancestor, nodes] of groups.entries()) {
      console.log(`    ${ancestor}:`);
      for (const n of nodes) console.log(`      • ${n.name} (${n.type})`);
    }
  }

  try {
    await sendSlack(changes);
  } catch (err) {
    console.error('Slack notification failed (snapshot was still saved):', err.message);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
