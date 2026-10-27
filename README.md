# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

This repository contains Jayzengcodetrip’s customized v1.4.2, based on [Zara Zhang’s YouTube Digest](https://github.com/zarazhangrui/youtube-digest). The original MIT license and attribution are preserved.

Turn every YouTube video into a resource for deep learning. YouTube Digest brings transcripts, bilingual translation, AI overviews, explanations, and timestamped notes into one Chrome side panel, so you can study ideas and language without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI overview, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Save polished timestamped notes for later study.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

YouTube Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

![YouTube Digest demo](YouTube%20Digest%20demo.png)

## Local update v1.4.2: stability fixes

- Validate playback relays at both the background and receiving video, rebind the panel when switching between tabs showing the same video, and track global side panels across active tabs. Background navigation can no longer close another active video's panel.
- Reject stale source, caption, note-list and overview completion results. Apply display-language changes immediately and serialize their local preference writes.
- Serialize concurrent note saves/deletes and assign unique IDs. Player notes now share the source-aware transcript coordinator, including Japanese/Korean selection and request deduplication. Exact selected-text notes remain direct saves.
- Respect Cmd/Ctrl/Alt+N and held-key repeats, clean up reused-player Note listeners, suppress late note feedback on other videos, and allow pointer-focused subtitle controls to fade while retaining keyboard focus visibility.
- Split dialogue at gaps of at least five seconds instead of showing future speech early. Corrected groups may need new translations; old cache entries are retained and continuous-caption grouping stays compatible.
- No new permissions. Keep the original installation, reload it, and refresh existing YouTube pages. API configuration and saved notes are preserved.

## Local update v1.4.1: video navigation fix

- Fixed bilingual subtitle requests being rejected after entering a video from YouTube home, a channel or another video without a full page reload. Video identity now uses the current browser tab URL instead of the content script's initial document URL.
- Applied the same fix to right-click transcript controls while preserving synchronous user-gesture opening, extension and origin checks, top-frame restrictions, current-video matching and stale-request rejection.
- English, Japanese, Korean, automatic source selection, API configuration, notes and cached translations remain compatible. No new permissions. Reload the original extension and refresh existing YouTube pages after updating.

## Local update v1.4.0: English, Japanese and Korean bilingual subtitles

- Display English, Japanese or Korean original captions above Simplified Chinese, both in the player and in the transcript panel.
- Automatic selection uses explicit original-audio language, a unique automatic-caption language, or the sole available caption language. It does not record audio or run speech recognition.
- Videos with multiple manual caption tracks and no original-language metadata remain ambiguous. They default to English and say that the original language is unknown. Use **video right-click → 原文语言** or the panel's source selector to choose Japanese/Korean; the override is remembered per video. Viewer locale and default captions are not treated as original-language evidence.
- The chosen language must have an accessible native caption track. A provider fallback cannot silently masquerade as Japanese/Korean. Burned-in video text is not OCR input.
- Source tracks are cached separately and completed translations remain reusable. Switching source language preserves playback position, pause state and rate; late responses cannot overwrite the new source. Existing English segmentation, credentials, notes and Follow playback remain compatible.
- Japanese caption joins avoid artificial spaces; Korean word spacing is preserved. Known Japanese/Korean non-speech labels are cleaned conservatively.
- Update the existing installation folder, reload the existing extension at `chrome://extensions`, then refresh the YouTube page. Keep the same extension and folder path.

## Local update v1.3.3: dismissing playback notices

- Passive transcript-panel state checks no longer put error notices over the video. A failed check preserves the last confirmed panel state and does not start a retry loop.
- Failed manual transcript actions show a notice for 3 seconds, with a **× / 关闭提示** (Dismiss notice) control and the existing Retry action. Mouse movement, subtitle updates and rendering do not restart its timer. After it disappears, use the right-click menu to try again.
- Video navigation, player replacement and overlay cleanup discard old notices and pending responses. Closing a notice does not pause, seek, or change playback speed. This applies to all video languages.
- Reload the original YouTube Digest extension and refresh existing YouTube pages after updating. API configuration, notes, subtitle preferences, cached translations and strict video-identity checks are preserved.

## Local update v1.3.2: right-click transcript menu

- Removed both on-video transcript entry buttons and the caption toolbar's reserved space. Right-click the player, then left-click **打开逐字稿** (Open transcript). With the panel open, the item becomes **收起逐字稿** (Close transcript).
- Right-click only reveals the menu. Escape, outside clicks, blur and video navigation dismiss it; Shift + right-click preserves YouTube's original menu. The menu stays within the visible player.
- Fixed native Chrome side panels being rejected when their MessageSender omits documentId. Each panel uses a unique committed document URL and a live SIDE_PANEL context for binding. Startup failures now show a direct Retry action instead of stranding the welcome screen.
- In-player captions, current-sentence focus, Follow playback, cached translations and the panel Return control remain available.
- Tested by loading the actual extension in an isolated Chrome for Testing instance, reproducing the old failure and checking native panel open/load/focus/close/reopen without real paid API calls. Reload the original extension and refresh existing YouTube pages to apply this release to your browser.

## Local update v1.3.1: quick transcript switching

- Hover the video or focus the control to reveal **展开逐字稿** (Expand transcript) at the caption box's upper right. It opens Transcript in bilingual mode, focuses the latest playback position after loading, and resumes Follow playback.
- In-player bilingual captions remain visible with the panel open. Click **收起逐字稿** (Collapse transcript), the panel's **返回视频字幕** (Return to video captions), or Chrome's close button to collapse it.
- A matching side-panel icon beside the player's subtitle toggle works during caption gaps and when captions are disabled or unavailable.
- Expanding from video fullscreen exits fullscreen; collapsing preserves the current layout. Switching does not seek, pause, change playback rate, or change the persistent subtitle preference.
- Subtitle entry takes precedence over saved reading position; the ordinary Digest entry retains its existing restore behavior. Both surfaces reuse the same transcript and translation cache.
- Failures retain video captions and offer Retry. Each panel is scoped to its own window and active video. Requires Chrome 142 or newer for native panel state events.
- Update the existing folder, reload the original extension in `chrome://extensions`, and refresh existing YouTube pages. Do not uninstall: keep your original extension identity and its local API configuration, notes, and cache.

## Local update v1.3.0: in-player bilingual subtitles

- Use **双语字幕** beside Note in the player to show the original paragraph above its Chinese translation. Subtitles work in normal, theater, and fullscreen views, independently of the side panel.
- Initially off after upgrading. Your toggle choice is remembered for subsequent videos. When enabled, missing captions and translations use your configured Supadata and DeepSeek credits; existing cached results are reused.
- Translate the current paragraph first and prefetch the next three while playing. Show the original while Chinese is pending, without pausing the video. Failures offer an explicit Retry.
- The player and side panel share existing semantic segments and translations. Preserve the stronger row highlight, Follow playback, notes, and API settings. Long paragraphs wrap; source timing remains paragraph-level rather than word-aligned.
- Temporarily hide native CC while enabled and restore it on disable. Hide the overlay during ads. This release targets regular `/watch` videos, not Shorts, live captions, or picture-in-picture windows.
- Update the existing installation folder, reload the original YouTube Digest in `chrome://extensions`, and refresh YouTube. Do not uninstall first: Chrome removes extension settings and notes when uninstalling.

## Local update v1.2.2: stronger playback highlight

- Give the current spoken row a stronger warm-orange background, with a darker leading border, timestamp, and bilingual divider.
- Keep existing playback-follow behavior: click Follow playback to resume after browsing captions manually.

## Local update v1.2.1

- Remove recognized caption sound cues such as `[music]`, `[laughter]`, `[screaming]`, their Chinese equivalents, and clear hesitation sounds; omit noise-only rows.
- Use cleaned captions in Original, Chinese, bilingual, copy, and export views while preserving meaningful speech and source timing. Chinese translation omits empty verbal padding without dropping facts, negation, corrections, or meaningful tone.
- Clean cached captions locally without fetching them again. Previous transcript translations regenerate for visible rows to prevent source/translation mismatches after regrouping; normal translation token charges apply.
- After updating local files, reload YouTube Digest in `chrome://extensions`, refresh the video, and reopen the side panel. API keys and saved notes stay in place.

## New in v1.2.0

- Search transcript words or phrases and move through every match.
- Use one Original, Chinese, or bilingual setting across Transcript, Overview, and Notes. New videos stay in Original by default.
- Translate visible Overview and Notes content progressively in small cached batches.
- Explain selected transcript text or save it directly as a timestamped note.
- Keep your transcript position across navigation, with the panel closing automatically outside YouTube video pages.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/Jayzengcodetrip/youtube-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows.
2. Open the official Supadata and DeepSeek pages below and help you create your own accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the YouTube Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/Jayzengcodetrip/youtube-digest](https://github.com/Jayzengcodetrip/youtube-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin YouTube Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YouTube Digest card at `chrome://extensions`, then refresh open YouTube tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

YouTube Digest needs two keys under your own provider accounts:

1. A **Supadata API key** to retrieve YouTube transcripts.
2. A **DeepSeek API key** for overviews, explanations, translation, and automatic note polishing.

### Get a Supadata API key

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in YouTube Digest Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `YouTube Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in YouTube Digest Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the YouTube Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports DeepSeek V4 Flash as its only AI provider:

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

YouTube Digest sends every DeepSeek request in non-thinking mode for responsive, predictable interactions. The endpoint and model are fixed in Settings, so the only AI credential you enter is your DeepSeek API key. To use another provider or model, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use YouTube Digest

1. Open a standard YouTube watch page with captions.
2. Click the YouTube Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Overview** when you want AI-generated chapters and key quotes.
5. Select transcript text when you want an AI explanation.
6. Save a note from the player or a key quote, then revisit it from **Notes**.

## What works today

- Google Chrome 142 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Native subtitle tracks returned by Supadata, including English, Japanese and Korean. Source metadata selects the language when available; ambiguous videos default to English with a manual override.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, and automatic note polishing.
- Local notes and a local cache for recent transcript and digest results.
- DeepSeek V4 Flash for all published AI features. Other providers require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

YouTube Digest forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. YouTube Digest does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek usage is separate from Supadata. YouTube Digest does not collect payments or resell access. Set spending limits and monitor both accounts.

## DeepSeek V4 Flash pricing

As of August 27, 2026, DeepSeek lists these USD prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

| Token type | Off-peak | Peak |
| --- | ---: | ---: |
| Cache-hit input | $0.007 | $0.014 |
| Cache-miss input | $0.22 | $0.44 |
| Output | $0.66 | $1.32 |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday. All other hours use off-peak rates.

A measured 20-minute English talk used about **32,600 input tokens** and an estimated **3,500 to 4,500 output tokens** across 43 small translation batches. At current prices, translating the full video costs approximately:

- **Off-peak: $0.003 to $0.010 USD**.
- **Peak: $0.005 to $0.020 USD**.

The lower end assumes most repeated input hits DeepSeek's cache. The upper end assumes cache misses. Translation is lazy and cached, so translating only part of a video costs less. Check the official page before relying on these prices.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

YouTube Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact YouTube Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open YouTube Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

YouTube Digest makes provider requests directly from the extension:

1. It sends a canonical YouTube watch URL to Supadata to request the native transcript.
2. It sends the transcript and relevant video metadata to DeepSeek when you request AI features.
3. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
4. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no YouTube Digest account system, advertising, analytics, or telemetry. Supadata and DeepSeek still receive data under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm YouTube Digest is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### YouTube Digest asks for setup

- Open **Settings** and save both a Supadata key and a DeepSeek key.
- This published version uses the fixed DeepSeek V4 Flash endpoint and model. There are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- Check your Supadata key, remaining credits, rate limit, and account status.
- Remember that unavailable native lookups and manual retries may still consume credits.

YouTube Digest will not fall back to generated transcription.

### AI requests fail

- A `401` or `403` usually means the DeepSeek key or account access is invalid.
- A `429` usually means a DeepSeek rate or spending limit was reached.
- Confirm the key was created in the DeepSeek Platform account linked above and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test several real YouTube videos. Automated checks do not prove that live provider requests and YouTube interactions work.

## License

MIT. See [LICENSE](LICENSE).
