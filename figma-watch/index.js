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

// Walk the full subtree storing a hash per node.
//
// Instance children share IDs with their master component definition (on a
// different page), so a raw link to them goes to the wrong place. We solve
// this by tracking a `safeLinkId`: the ID of the nearest ancestor that was
// directly placed on the page. Once we enter an INSTANCE we lock the link ID
// to that instance so every descendant's change still links to the right page.
function buildNodeMap(node, map, ancestorName, ancestorId, safeLinkId = null) {
  // If no safe link has been established yet, this node itself is safe to link
  const myLinkId = safeLinkId ?? node.id;

  map[node.id] = {
    hash: hashNodeProps(node),
    name: node.name || node.type,
    type: node.type,
    ancestor: ancestorName,
    ancestorId,
    linkId: myLinkId
  };

  // Once inside an INSTANCE, all descendants link back to that instance.
  // Outside instances, pass the inherited safeLinkId through (null = use own).
  const childLinkId = node.type === 'INSTANCE' ? myLinkId : safeLinkId;

  for (const child of node.children ?? []) {
    buildNodeMap(child, map, ancestorName, ancestorId, childLinkId);
  }
}

// Build a flat map of every node on a page, keyed by node ID.
function buildPageMap(pageChildren) {
  const map = {};
  for (const node of pageChildren) {
    // Skip non-design nodes
    if (['LINE', 'SLICE'].includes(node.type)) continue;
    buildNodeMap(node, map, node.name || node.type, node.id);
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

    // groups is a Map: ancestorId -> { name, nodes[] }
    for (const [ancestorId, { name: ancestorName, nodes }] of groups.entries()) {
      const MAX = 10;

      // Exclude the ancestor node itself from the child list — it's already the header
      const children = nodes.filter(n => n.id !== ancestorId);

      // If nothing changed except the ancestor container itself, show one linked line
      if (children.length === 0) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `• *<${nodeUrl(ancestorId)}|${ancestorName}>* ↗` }
        });
        continue;
      }

      const visible = children.slice(0, MAX);
      const overflow = children.length - visible.length;

      // Children whose linkId differs from the ancestor get their own link;
      // children that would link to the same place just show as plain text.
      // Prefix with an icon based on the change type.
      const changeIcon = n => n.change === 'added' ? '➕' : n.change === 'deleted' ? '🗑️' : '✏️';
      const lines = visible
        .map(n =>
          n.linkId !== ancestorId
            ? `      └ ${changeIcon(n)} <${nodeUrl(n.linkId)}|${n.name}> ↗`
            : `      └ ${changeIcon(n)} ${n.name}`
        )
        .join('\n');

      const overflowNote = overflow > 0 ? `\n      └ _+${overflow} more_` : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `• *<${nodeUrl(ancestorId)}|${ancestorName}>* ↗\n${lines}${overflowNote}`
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
        Object.entries(currentMap).map(([id, data]) => [id, data])
      )
    };

    if (isFirstRun) continue;

    // Group changed nodes by their top-level ancestor (keyed by ancestorId)
    // Map<ancestorId, { name: string, nodes: Array<{id, name, type, linkId, change}> }>
    const groups = new Map();

    const addToGroup = (ancestorId, ancestorName, node) => {
      if (!groups.has(ancestorId)) groups.set(ancestorId, { name: ancestorName, nodes: [] });
      groups.get(ancestorId).nodes.push(node);
    };

    // Added or modified nodes
    for (const [id, { hash, name, type, ancestor, ancestorId, linkId }] of Object.entries(currentMap)) {
      const prevEntry = prevMap[id];
      // prevEntry may be a plain hash string (old snapshot format) or an object (new format)
      const prevHash = prevEntry && typeof prevEntry === 'object' ? prevEntry.hash : prevEntry;

      if (prevHash === hash) continue; // unchanged

      const change = prevHash === undefined ? 'added' : 'modified';
      addToGroup(ancestorId, ancestor, { id, name, type, linkId, change });
    }

    // Deleted nodes — iterate prevMap for IDs that no longer exist
    for (const [id, prevEntry] of Object.entries(prevMap)) {
      if (currentMap[id] !== undefined) continue; // still exists

      const meta = prevEntry && typeof prevEntry === 'object'
        ? prevEntry
        : { name: id, type: 'UNKNOWN', ancestor: id, ancestorId: id, linkId: id };

      addToGroup(meta.ancestorId, meta.ancestor, {
        id,
        name: meta.name,
        type: meta.type,
        linkId: meta.linkId,
        change: 'deleted'
      });
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
    for (const [, { name: ancestor, nodes }] of groups.entries()) {
      console.log(`    ${ancestor}:`);
      for (const n of nodes) console.log(`      • ${n.name} (${n.type}) [${n.change}]`);
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
