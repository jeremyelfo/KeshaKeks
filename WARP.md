# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Common commands

This is a static, client-only web app. There is no build system, linter, or test runner configured.

- Preview locally (open directly):
  - Windows (PowerShell): `start index.html`
  - macOS: `open index.html`
  - Linux: `xdg-open index.html`
- Serve with a local HTTP server (avoids some browser restrictions):
  - Python 3: `python -m http.server 5173`
  - Node (npx): `npx serve -l 5173`

Note: Full functionality (Telegram UI, haptics, game score proxy) requires loading inside a Telegram WebApp context. Running in a normal browser will work for most UI, but Telegram-specific APIs will be unavailable.

## High-level architecture

Single-page app composed of a single `index.html` with inline CSS/JS and a small auxiliary `style.css`.

- Entry point: `index.html`
  - External dependencies loaded via CDN scripts in `<head>`:
    - Telegram WebApp SDK: `https://telegram.org/js/telegram-web-app.js`
    - Supabase JS v2 (UMD): `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/supabase.min.js`
  - Fonts: Google Fonts (SF Pro Display)
  - Media:
    - Background music: `mur.mp3` (local file)
    - Cat images: referenced via raw GitHub URLs (not local files)

- UI structure (major blocks):
  - Achievements bar: fixed grid at the top with 12 slots (`.achievements-bar` → `#achievementGrid`, individual `#ach-slot-*` items). Slots unlock visually at specified score thresholds.
  - Modals:
    - `#welcomeModal`: initial modal with a “start therapy” button.
    - `#leaderboardModal`: shows top 10 from Supabase; closes on background click.
  - Main content: title, two cat images (`#cat1`, `#cat2`), score label (`#score`), button to open leaderboard.
  - Tap zone: invisible, fixed-bottom button (`#tapZone`) covering the lower viewport to route taps Left → cat1, Right → cat2.
  - Achievement toast: `#achievement` transient notification near the top.

- Core client logic (inline `<script>` in `index.html`):
  - Telegram bootstrapping: obtains `window.Telegram.WebApp`, calls `ready()` and `expand()`. Uses `HapticFeedback` and `GameProxy.setGameScore` when available.
  - Supabase integration:
    - Initializes a client with project URL and anon key embedded in the page.
    - Data model: `leaderboard` table with columns `telegram_id` (numeric), `username` (text), `max_score` (int), `updated_at` (timestamptz).
    - Functions:
      - `updateScore(telegramId, username, newScore)`: upserts the user’s max score by `telegram_id` when a new personal best is reached.
      - `getLeaderboardTop()`: fetches top 10 by `max_score`.
      - `showLeaderboard()`: populates the modal with fetched data, handles empty/error states.
    - Notes: Code comments assume RLS policies are configured to allow anon read and write to `leaderboard` (or that writes use a service role through a backend, which is not present here).
  - Game/UX logic:
    - Score state: `score` increments per tap (on cats or tap zone).
    - Assets rotation: `cat1Photos` and `cat2Photos` arrays of image URLs; clicking a specific cat rotates its photo.
    - Threshold system:
      - Precomputed threshold arrays for achievements and celebrations:
        - `achievementThresholds`: 1, 50, and a dense sequence around 100/150, 200/250, …
        - `everyHundredThresholds`: every 100.
        - `milestoneThresholds`: 500, 1500, 2500, …
        - `superThresholds`: every 1000.
      - Unlocked sets: `unlockedAchievements`, `unlockedMilestones`, `unlockedSupers` avoid duplicate triggers.
      - Effects:
        - `launchSalute()`: scatter hearts across the screen.
        - `launchMilestone()`: stronger background blink, particle burst, timed reset.
        - `launchSuperEffect(threshold)`: intense screen-wide emoji storm, cat blink, rainbow background cycling, repeated haptics, toast update.
      - `showAchievement(threshold)`: shows toast and unlocks a corresponding grid slot if mapped in `achSlotMapping`.
      - `checkAchievement(newScore)`: orchestrates which effect to fire based on the new score and threshold membership.
    - Event wiring (`window.onload`):
      - Opens the welcome modal after a short delay.
      - Sets up audio volume and best-effort autoplay.
      - Binds `touchstart`/`click` handlers to cats and the tap zone (with `passive: false` where needed), and modal close behavior.

## Working outside Telegram

When opened directly in a browser, `window.Telegram` will be undefined. To exercise the UI without Telegram errors, you can add a minimal stub in the devtools console before interactions:

```js
window.Telegram = {
  WebApp: {
    ready: () => {},
    expand: () => {},
    HapticFeedback: { impactOccurred: () => {}, notificationOccurred: () => {} },
    GameProxy: { setGameScore: (_opts, _cb) => {} }
  }
};
```

This enables most flows (taps, animations, leaderboard UI). Supabase calls will still run client-side; ensure CORS and RLS policies allow the operations you test.

## Notes for future changes

- Most styles live inline within `index.html` inside a `<style>` block; `style.css` only contains a small layout override for `.content-wrapper` and `.top-fixed-elements`. If you plan to grow styles, consider consolidating into `style.css` and removing the large inline `<style>` block.
- Cat images are sourced from external GitHub raw URLs. If you want to ship self-contained assets, replace those URLs with local files and keep the arrays in sync.
