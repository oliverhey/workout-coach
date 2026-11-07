# Workout Coach

An offline-first iPhone web app (PWA) that replaces the Apple Notes + ChatGPT workflow:

1. **Log at the gym, offline.** The next workout opens with the coach's targets already filled in. Tap ✓ to accept a target or type what you did. Each set has an optional pain score (0–10).
2. **Get a review automatically.** When you finish (or once you're back online), Claude rates the session, compares it with previous ones and writes the plan for the next session of that day.
3. **Coach tab.** Ask for substitutions, a new exercise order or a refreshed plan. Every proposed change waits for your approval and can be undone. You can also generate progress reports for any period, e.g. the last 6 months.
4. **Progress tab.** Estimated 1RM, top set and pain per exercise, plus training frequency, ratings and body weight.

## Deploy (GitHub Pages)
1. Create a new repository, e.g. `workout-coach`, and upload the contents of this folder (`index.html` must be at the root).
2. Go to Settings → Pages → Deploy from branch → `main` / root.
3. On your iPhone, open `https://oliverhey.github.io/workout-coach/` in Safari → Share → **Add to Home Screen**.
4. Open the app → ⚙︎ → paste your Anthropic API key (console.anthropic.com → API Keys) → Save.

## Import your ChatGPT history
ChatGPT → Settings → Data controls → **Export data** → unzip the email attachment → in the app: ⚙︎ → **Import ChatGPT export** → choose `conversations.json`. Pick the workout project chat. Your raw logs are structured by Claude in batches; ChatGPT's original reviews and ratings are kept with each session. The import can be stopped and resumed, and logs that were already imported are skipped. Afterwards, run **Rebuild plans**.

## Data
Everything is stored on the device (IndexedDB). Use ⚙︎ → **Export backup** regularly (file `YYMMDD_workout-coach-backup.json`). Your API key is never included in the backup.
