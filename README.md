# Figma Change Tracker

Monitors specific Figma pages for changes and sends Slack alerts with deep links to the exact frames and layers that were updated.

## How it works

A GitHub Actions workflow runs every 30 minutes, fetches the Figma file via the REST API, compares it against a stored snapshot, and posts a Slack message if anything changed on a watched page.

Alerts include direct links to the changed frames and named layers inside Figma.

## Setup

### 1. Configure which pages to watch

Edit `figma-watch/config.json`:

```json
{
  "watch": ["For Development"],
  "notifications": {
    "slack": true,
    "email": false
  }
}
```

### 2. Add GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Where to get it |
|---|---|
| `FIGMA_TOKEN` | figma.com → Account Settings → Personal access tokens |
| `FIGMA_FILE_KEY` | The ID in your Figma file URL: `figma.com/design/`**`THIS_PART`**`/...` |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps → your app → Incoming Webhooks |

### 3. Trigger manually to test

Go to **Actions → Figma Change Watch → Run workflow** to test without waiting for the 30-minute schedule.

## File structure

```
figma-watch/
  config.json      ← which pages to watch
  snapshot.json    ← last known state (auto-updated by the action)
  index.js         ← diff + alert script

.github/
  workflows/
    figma-watch.yml  ← scheduled GitHub Action
```

## Example Slack alert

```
🎨 Figma Update Detected

Page: For Development

• Events Detail Page
    └ Footer ↗
    └ Combined Menu ↗

• Homepage
    └ Hero Banner ↗
```

Each link opens Figma and jumps directly to that layer.
