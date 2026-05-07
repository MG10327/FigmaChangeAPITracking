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
  // Hash the full subtree including all descendants so any nested change is detected
  return createHash('sha256').update(JSON.stringify(node)).digest('hex').slice(0, 8);
}

function nodeUrl(nodeId) {
  return `https://www.figma.com/design/${FIGMA_FILE_KEY}?node-id=${nodeId.replace(':', '-')}`;
}

// Strip Figma's decorative page name prefixes (↳, ❖, leading spaces)
function normalizePageName(name) {
  return name.replace(/^[\s↳❖–-]+/, '').trim();
}

// Recursively collect all top-level frames, traversing into sections
function collectFrames(nodes) {
  const frames = [];
  for (const node of nodes) {
    if (node.type === 'FRAME' || node.type === 'COMPONENT') {
      frames.push(node);
    } else if (node.type === 'SECTION') {
      frames.push(...collectFrames(node.children ?? []));
    }
  }
  return frames;
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

  for (const [pageName, frames] of Object.entries(changes)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Page: ${pageName}*` }
    });

    for (const frame of frames) {
      const named = frame.layers.filter(l => l.name);
      const unnamed = frame.layers.filter(l => !l.name);

      const layerLines = named
        .map(l => `      └ <${nodeUrl(l.id)}|${l.name}> ↗`)
        .join('\n');

      const unnamedNote = unnamed.length
        ? `\n      └ ${unnamed.length} unnamed layer${unnamed.length > 1 ? 's' : ''} changed  (<${nodeUrl(frame.id)}|View frame ↗>)`
        : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `• *<${nodeUrl(frame.id)}|${frame.name}>*\n${layerLines}${unnamedNote}`
        }
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Checked at ${new Date().toUTCString()}`
      }
    ]
  });

  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (!res.ok) throw new Error(`Slack webhook error: ${res.status}`);
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
  const newSnapshot = { lastChecked: new Date().toISOString(), pages: {} };
  const changes = {};

  const allPageNames = figmaData.document.children.map(p => normalizePageName(p.name));
  console.log(`Pages found in file (normalized): ${JSON.stringify(allPageNames)}`);
  console.log(`Watching for: ${JSON.stringify(config.watch)}`);

  for (const page of figmaData.document.children) {
    if (!config.watch.includes(normalizePageName(page.name))) continue;

    console.log(`Checking page: ${page.name}`);
    console.log(`  Top-level node types: ${[...new Set(page.children.map(n => n.type))].join(', ')}`);

    newSnapshot.pages[page.name] = { frames: {} };

    const prevPage = snapshot.pages?.[page.name];
    const changedFrames = [];
    const frames = collectFrames(page.children);

    console.log(`  Found ${frames.length} frame(s): ${frames.map(f => f.name).join(', ')}`);

    for (const frame of frames) {

      newSnapshot.pages[page.name].frames[frame.id] = {};
      const changedLayers = [];

      for (const layer of frame.children ?? []) {
        const hash = hashSubtree(layer);
        newSnapshot.pages[page.name].frames[frame.id][layer.id] = hash;

        const prevHash = prevPage?.frames?.[frame.id]?.[layer.id];
        if (prevHash === undefined || prevHash !== hash) {
          changedLayers.push({ id: layer.id, name: layer.name ?? null });
        }
      }

      if (changedLayers.length > 0) {
        changedFrames.push({ id: frame.id, name: frame.name, layers: changedLayers });
      }
    }

    if (changedFrames.length > 0) {
      changes[page.name] = changedFrames;
    }
  }

  writeFileSync(snapshotPath, JSON.stringify(newSnapshot, null, 2));
  console.log('Snapshot updated.');

  if (Object.keys(changes).length === 0) {
    console.log('No changes detected.');
    return;
  }

  console.log('Changes detected:');
  for (const [page, frames] of Object.entries(changes)) {
    console.log(`  ${page}:`);
    for (const frame of frames) {
      console.log(`    • ${frame.name} (${frame.layers.length} layer change${frame.layers.length > 1 ? 's' : ''})`);
    }
  }

  await sendSlack(changes);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
