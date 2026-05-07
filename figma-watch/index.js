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

function hashSubtree(node) {
  return createHash('sha256').update(JSON.stringify(node)).digest('hex').slice(0, 8);
}

function nodeUrl(nodeId) {
  return `https://www.figma.com/design/${FIGMA_FILE_KEY}?node-id=${nodeId.replace(':', '-')}`;
}

function normalizePageName(name) {
  return name.replace(/^[\s↳❖–-]+/, '').trim();
}

// Collect top-level containers. Sections are tracked as-is so any change
// inside them at any depth is caught by hashing the full subtree.
function collectContainers(nodes) {
  const containers = [];
  for (const node of nodes) {
    if (['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET', 'SECTION'].includes(node.type)) {
      containers.push(node);
    }
  }
  return containers;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function sendSlack(changes) {
  if (!config.notifications.slack || !process.env.SLACK_WEBHOOK_URL) return;

  const MAX_CONTAINERS = 20;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🎨 Figma Update Detected', emoji: true }
    },
    { type: 'divider' }
  ];

  for (const [pageName, containers] of Object.entries(changes)) {
    const visible = containers.slice(0, MAX_CONTAINERS);
    const overflow = containers.length - visible.length;

    const lines = visible
      .map(c => `• *<${nodeUrl(c.id)}|${c.name}>* ↗`)
      .join('\n');

    const overflowNote = overflow > 0
      ? `\n_…and ${overflow} more changed containers_`
      : '';

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Page: ${normalizePageName(pageName)}*\n${lines}${overflowNote}` }
    });
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
    newSnapshot.pages[page.name] = { frames: {} };

    const prevPage = snapshot.pages?.[page.name];
    const changedContainers = [];
    const containers = collectContainers(page.children);

    for (const container of containers) {
      const hash = hashSubtree(container);
      newSnapshot.pages[page.name].frames[container.id] = hash;

      const prevHash = prevPage?.frames?.[container.id];
      if (prevHash !== undefined && prevHash !== hash) {
        changedContainers.push({ id: container.id, name: container.name ?? container.type });
      }
    }

    if (changedContainers.length > 0) {
      changes[page.name] = changedContainers;
    }
  }

  // Always write the snapshot so the commit step succeeds
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
  for (const [page, containers] of Object.entries(changes)) {
    console.log(`  ${normalizePageName(page)}:`);
    for (const c of containers) console.log(`    • ${c.name}`);
  }

  // Notify but don't let a Slack failure fail the whole job
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
