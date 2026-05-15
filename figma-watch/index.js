import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

// ─── Figma ────────────────────────────────────────────────────────────────────

async function fetchFigmaFile(fileKey) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN }
  });
  if (!res.ok) throw new Error(`Figma API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchFigmaComments(fileKey) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
    headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN }
  });
  if (!res.ok) throw new Error(`Figma comments API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.comments ?? [];
}

// Position/transform props that change automatically due to auto-layout
// repositioning when siblings are added or deleted — not meaningful design changes.
const LAYOUT_REFLOW_PROPS = new Set([
  'x', 'y', 'relativeTransform', 'absoluteTransform',
  'absoluteBoundingBox', 'absoluteRenderBounds'
]);

// Hash only the node's own properties — not its children, and not layout
// reflow props that auto-update when siblings move in an auto-layout container.
function hashNodeProps(node) {
  const { children, ...props } = node;
  const filtered = Object.fromEntries(
    Object.entries(props).filter(([k]) => !LAYOUT_REFLOW_PROPS.has(k))
  );
  return createHash('sha256').update(JSON.stringify(filtered)).digest('hex').slice(0, 8);
}

function nodeUrl(fileKey, nodeId) {
  return `https://www.figma.com/design/${fileKey}?node-id=${nodeId.replace(':', '-')}`;
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
  const myLinkId = safeLinkId ?? node.id;

  map[node.id] = {
    hash: hashNodeProps(node),
    name: node.name || node.type,
    type: node.type,
    ancestor: ancestorName,
    ancestorId,
    linkId: myLinkId
  };

  const childLinkId = node.type === 'INSTANCE' ? myLinkId : safeLinkId;

  for (const child of node.children ?? []) {
    buildNodeMap(child, map, ancestorName, ancestorId, childLinkId);
  }
}

function buildPageMap(pageChildren) {
  const map = {};
  for (const node of pageChildren) {
    if (['LINE', 'SLICE'].includes(node.type)) continue;
    buildNodeMap(node, map, node.name || node.type, node.id);
  }
  return map;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function sendSlackChannel(webhookUrl, fileKey, label, changes) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎨 Figma Update — ${label}`, emoji: true }
    },
    { type: 'divider' }
  ];

  for (const [pageName, groups] of Object.entries(changes)) {
    for (const [ancestorId, { name: ancestorName, nodes }] of groups.entries()) {
      const MAX = 10;
      const children = nodes.filter(n => n.id !== ancestorId);
      const changeIcon = n => n.change === 'added' ? '➕' : n.change === 'deleted' ? '🗑️' : '✏️';

      if (children.length === 0) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*<${nodeUrl(fileKey, ancestorId)}|${ancestorName}>* ↗` }
        });
        continue;
      }

      const visible = children.slice(0, MAX);
      const overflow = children.length - visible.length;

      const lines = visible
        .map(n =>
          n.linkId !== ancestorId
            ? `  └ ${changeIcon(n)} <${nodeUrl(fileKey, n.linkId)}|${n.name}> ↗`
            : `  └ ${changeIcon(n)} ${n.name}`
        )
        .join('\n');

      const overflowNote = overflow > 0 ? `\n  └ _+${overflow} more_` : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${nodeUrl(fileKey, ancestorId)}|${ancestorName}>* ↗\n${lines}${overflowNote}`
        }
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Checked at ${new Date().toUTCString()}` }]
  });

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook error: ${res.status} — ${body}`);
  }
  console.log(`  Slack channel notification sent.`);
}

async function buildSlackUserMap() {
  const res = await fetch('https://slack.com/api/users.list', {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack users.list error: ${data.error}`);

  const map = {};
  for (const member of data.members ?? []) {
    if (member.deleted || member.is_bot) continue;
    if (member.profile.real_name) map[member.profile.real_name] = member.id;
    if (member.profile.display_name && member.profile.display_name !== member.profile.real_name) {
      map[member.profile.display_name] = member.id;
    }
  }
  return map;
}

async function sendSlackDM(slackUserId, comment, fileKey, label) {
  const nodeId = comment.client_meta?.node_id;
  const link = nodeId ? nodeUrl(fileKey, nodeId) : `https://www.figma.com/design/${fileKey}`;
  // Figma's comment API returns `handle` but not `name` on the user object
  const author = comment.user?.handle ?? comment.user?.name ?? 'Someone';

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({
      channel: slackUserId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${author}* mentioned you in a Figma comment on *${label}*:\n> ${comment.message}`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View in Figma ↗', emoji: true },
              url: link
            }
          ]
        }
      ]
    })
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Slack DM error: ${data.error}`);
}

// ─── Per-file processors ──────────────────────────────────────────────────────

async function processFilePages(fileConfig, figmaData, fileSnapshot, newFileSnapshot) {
  const { figmaFileKey: fileKey, label, watch, slackWebhook } = fileConfig;
  // Support either a raw URL or the name of a GitHub secret env var
  const webhookUrl = slackWebhook.startsWith('https://') ? slackWebhook : process.env[slackWebhook];

  const isFirstRun = !fileSnapshot.pages || Object.keys(fileSnapshot.pages).length === 0;
  newFileSnapshot.pages = {};
  const changes = {};

  for (const page of figmaData.document.children) {
    if (!watch.includes(normalizePageName(page.name))) continue;

    console.log(`  [${label}] Checking page: ${normalizePageName(page.name)}`);

    const currentMap = buildPageMap(page.children);
    const prevMap = fileSnapshot.pages?.[page.name]?.nodes ?? {};

    newFileSnapshot.pages[page.name] = {
      nodes: Object.fromEntries(Object.entries(currentMap).map(([id, data]) => [id, data]))
    };

    if (isFirstRun) continue;

    // Determine which top-level ancestor frames were themselves added or deleted.
    // When an ancestor is added/deleted, all its children flood the diff as added/deleted too.
    // We suppress the children in that case and only report the ancestor itself.
    const ancestorLevelChange = new Map(); // ancestorId -> 'added' | 'deleted'

    for (const [id, { ancestor, ancestorId }] of Object.entries(currentMap)) {
      if (id !== ancestorId) continue;
      const prevEntry = prevMap[id];
      const prevHash = prevEntry && typeof prevEntry === 'object' ? prevEntry.hash : prevEntry;
      if (prevHash === undefined) ancestorLevelChange.set(id, 'added');
    }

    for (const [id, prevEntry] of Object.entries(prevMap)) {
      if (currentMap[id] !== undefined) continue;
      const meta = prevEntry && typeof prevEntry === 'object' ? prevEntry : null;
      if (meta && meta.ancestorId === id) ancestorLevelChange.set(id, 'deleted');
    }

    const groups = new Map();
    const addToGroup = (ancestorId, ancestorName, node) => {
      if (!groups.has(ancestorId)) groups.set(ancestorId, { name: ancestorName, nodes: [] });
      groups.get(ancestorId).nodes.push(node);
    };

    for (const [id, { hash, name, type, ancestor, ancestorId, linkId }] of Object.entries(currentMap)) {
      const prevEntry = prevMap[id];
      const prevHash = prevEntry && typeof prevEntry === 'object' ? prevEntry.hash : prevEntry;
      if (prevHash === hash) continue;
      const change = prevHash === undefined ? 'added' : 'modified';
      // If the ancestor was added, only add the ancestor node itself — skip all descendants
      if (ancestorLevelChange.get(ancestorId) === 'added' && id !== ancestorId) continue;
      addToGroup(ancestorId, ancestor, { id, name, type, linkId, change });
    }

    for (const [id, prevEntry] of Object.entries(prevMap)) {
      if (currentMap[id] !== undefined) continue;
      const meta = prevEntry && typeof prevEntry === 'object'
        ? prevEntry
        : { name: id, type: 'UNKNOWN', ancestor: id, ancestorId: id, linkId: id };
      // If the ancestor was deleted, only add the ancestor node itself — skip all descendants
      if (ancestorLevelChange.get(meta.ancestorId) === 'deleted' && id !== meta.ancestorId) continue;
      addToGroup(meta.ancestorId, meta.ancestor, { id, name: meta.name, type: meta.type, linkId: meta.linkId, change: 'deleted' });
    }

    if (groups.size > 0) changes[page.name] = groups;
  }

  if (isFirstRun) {
    console.log(`  [${label}] First run — baseline saved.`);
    return;
  }

  if (Object.keys(changes).length === 0) {
    console.log(`  [${label}] No design changes detected.`);
    return;
  }

  console.log(`  [${label}] Design changes detected:`);
  for (const [page, groups] of Object.entries(changes)) {
    console.log(`    ${normalizePageName(page)}:`);
    for (const [, { name: ancestor, nodes }] of groups.entries()) {
      console.log(`      ${ancestor}:`);
      for (const n of nodes) console.log(`        • ${n.name} (${n.type}) [${n.change}]`);
    }
  }

  if (!webhookUrl) {
    console.warn(`  [${label}] ${slackWebhook} not set — skipping channel notification.`);
    return;
  }

  try {
    await sendSlackChannel(webhookUrl, fileKey, label, changes);
  } catch (err) {
    console.error(`  [${label}] Channel notification failed:`, err.message);
  }
}

async function processFileComments(fileConfig, fileSnapshot, newFileSnapshot, slackUserMap) {
  if (!config.notifications?.comments) return;

  const { figmaFileKey: fileKey, label } = fileConfig;

  console.log(`  [${label}] Fetching comments...`);
  const comments = await fetchFigmaComments(fileKey);

  const seenIds = new Set(fileSnapshot.comments?.seenIds ?? []);
  const isFirstCommentRun = !fileSnapshot.comments;

  newFileSnapshot.comments = { seenIds: comments.map(c => c.id) };

  if (isFirstCommentRun) {
    console.log(`  [${label}] First comment run — baseline saved.`);
    return;
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    console.log(`  [${label}] SLACK_BOT_TOKEN not set — skipping comment DMs.`);
    return;
  }

  const newComments = comments.filter(c => !seenIds.has(c.id));
  if (newComments.length === 0) {
    console.log(`  [${label}] No new comments.`);
    return;
  }

  console.log(`  [${label}] Found ${newComments.length} new comment(s).`);

  for (const comment of newComments) {
    console.log(`    Comment ${comment.id} by ${comment.user?.handle ?? 'unknown'}: "${comment.message}"`);

    let mentionedNames = (comment.mentions ?? []).map(m => m.name).filter(Boolean);

    if (mentionedNames.length === 0 && comment.message) {
      const parsed = Object.keys(slackUserMap).filter(name =>
        comment.message.includes(`@${name}`)
      );
      if (parsed.length > 0) {
        console.log(`    Matched mentions from message text: ${parsed.join(', ')}`);
        mentionedNames = parsed;
      }
    }

    if (mentionedNames.length === 0) {
      console.log(`    No mentions — skipping.`);
      continue;
    }

    for (const name of mentionedNames) {
      const slackId = slackUserMap[name];
      if (!slackId) {
        console.warn(`    No Slack match for "${name}" — skipping DM.`);
        continue;
      }
      console.log(`    DMing ${name}`);
      try {
        await sendSlackDM(slackId, comment, fileKey, label);
      } catch (err) {
        console.error(`    Failed to DM ${name}:`, err.message);
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.FIGMA_TOKEN) throw new Error('FIGMA_TOKEN is not set');
  if (!config.files?.length) throw new Error('No files configured in config.json');

  const snapshotPath = join(__dirname, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const newSnapshot = { lastChecked: new Date().toISOString(), files: {} };

  // Build Slack user map once — shared across all files
  let slackUserMap = {};
  if (config.notifications?.comments && process.env.SLACK_BOT_TOKEN) {
    try {
      slackUserMap = await buildSlackUserMap();
      for (const [figmaName, slackId] of Object.entries(config.slackDmNameOverrides ?? {})) {
        if (figmaName.startsWith('_')) continue;
        slackUserMap[figmaName] = slackId;
      }
    } catch (err) {
      console.error('Failed to build Slack user map:', err.message);
    }
  }

  for (const fileConfig of config.files) {
    const { figmaFileKey: fileKey, label } = fileConfig;
    console.log(`\nProcessing: ${label} (${fileKey})`);

    const fileSnapshot = snapshot.files?.[fileKey] ?? {};
    newSnapshot.files[fileKey] = {};

    try {
      const figmaData = await fetchFigmaFile(fileKey);
      await processFilePages(fileConfig, figmaData, fileSnapshot, newSnapshot.files[fileKey]);
    } catch (err) {
      console.error(`  [${label}] Page processing failed:`, err.message);
    }

    try {
      await processFileComments(fileConfig, fileSnapshot, newSnapshot.files[fileKey], slackUserMap);
    } catch (err) {
      console.error(`  [${label}] Comment processing failed:`, err.message);
    }
  }

  writeFileSync(snapshotPath, JSON.stringify(newSnapshot, null, 2));
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
