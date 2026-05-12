# Figma Change Tracker

Monitors multiple Figma files for design changes and comment @mentions, then sends Slack alerts — channel notifications for design diffs and direct messages for comment mentions.

## How it works

A GitHub Actions workflow runs every 20 minutes. For each configured Figma file it:

1. Fetches the file via the Figma REST API
2. Diffs the watched pages against a cached snapshot
3. Posts a Slack channel message (via webhook) if any nodes changed, with deep links to the exact frames and layers
4. Fetches new comments and DMs any @mentioned teammates via the Slack bot

The snapshot is persisted between runs using GitHub Actions cache.

## Setup

### 1. Configure your Figma files

Edit `figma-watch/config.json`. Add one entry to `files` per Figma file you want to monitor:

```json
{
  "files": [
    {
      "figmaFileKey": "RfCKFlP2fiNGWu1dNYjEyM",
      "label": "Project Name",
      "watch": ["For Development", "Local components"],
      "slackWebhook": "SLACK_WEBHOOK_PROJECT_1"
    }
  ],
  "notifications": {
    "comments": true
  },
  "slackDmNameOverrides": {
    "figmaHandle": "U0SLACKID"
  }
}
```

| Field | Description |
|---|---|
| `figmaFileKey` | The ID from the Figma file URL: `figma.com/design/`**`THIS_PART`**`/...` |
| `label` | Human-readable project name shown in Slack notifications |
| `watch` | Array of Figma page names to monitor for design changes |
| `slackWebhook` | Name of the GitHub secret that holds this project's Slack webhook URL |
| `notifications.comments` | When `true`, Figma comment @mentions trigger Slack DMs |
| `slackDmNameOverrides` | Optional — map a Figma handle to a Slack user ID when they don't match |

### 2. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**.

**Required for design change alerts:**

| Secret | Where to get it |
|---|---|
| `FIGMA_TOKEN` | figma.com → Account Settings → Personal access tokens |
| `SLACK_WEBHOOK_PROJECT_1` | api.slack.com/apps → your app → Incoming Webhooks (add one per project, matching the `slackWebhook` value in config.json) |

**Required for comment @mention DMs** (only if `notifications.comments` is `true`):

| Secret | Where to get it |
|---|---|
| `SLACK_BOT_TOKEN` | api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token |

> The Slack bot needs the `users:read`, `chat:write`, and `im:write` scopes.

### 3. Test manually

Go to **Actions → Figma Change Watch → Run workflow** to trigger a run without waiting for the 20-minute schedule. The first run saves a baseline snapshot — no alerts are sent. The second run onwards will diff against that baseline.

## File structure

```
figma-watch/
  config.json      ← which files and pages to watch
  snapshot.json    ← last known state per file (auto-updated by the action)
  index.js         ← diff, alert, and comment script

.github/
  workflows/
    figma-watch.yml  ← scheduled GitHub Action (every 20 minutes)

src/
  app/             ← Next.js landing page (setup checklist reference)
```

## Example Slack alerts

**Design change alert (channel webhook):**

```
🎨 Figma Update — Project Name

Page: For Development

• Events Detail Page
    └ ✏️ Footer ↗
    └ ✏️ Combined Menu ↗

• Homepage
    └ ➕ Hero Banner ↗
```

Change icons: ➕ added · ✏️ modified · 🗑️ deleted. Each link opens Figma directly to that layer.

**Comment @mention DM:**

> **marcusg** mentioned you in a Figma comment on **Project Name**:
> "Hey @Jane can you review this?"
>
> [View in Figma ↗]
