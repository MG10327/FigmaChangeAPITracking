export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 bg-gray-50">
      <div className="max-w-xl w-full text-center space-y-4">
        <h1 className="text-3xl font-bold text-gray-900">Figma Change Tracker</h1>
        <p className="text-gray-500">
          This repo monitors Figma files for changes via GitHub Actions and sends
          Slack alerts when watched pages are updated.
        </p>
        <div className="mt-8 p-4 bg-white border border-gray-200 rounded-lg text-left text-sm text-gray-600 space-y-2">
          <p className="font-semibold text-gray-800">Setup checklist:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Add <code className="bg-gray-100 px-1 rounded">FIGMA_TOKEN</code> to GitHub Secrets</li>
            <li>Add <code className="bg-gray-100 px-1 rounded">FIGMA_FILE_KEY</code> to GitHub Secrets</li>
            <li>Add <code className="bg-gray-100 px-1 rounded">SLACK_WEBHOOK_URL</code> to GitHub Secrets</li>
            <li>Update <code className="bg-gray-100 px-1 rounded">figma-watch/config.json</code> with pages to watch</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
