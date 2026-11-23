# Changelog

## Unreleased - One composer per chat, side questions in their own panel

- Each chat keeps its own composer: unsent text, attachments and the 补充 / 提问 mode no longer follow you into another chat. Text is kept on the device across reloads (newest 100 chats); the new-chat page of each project has its own draft too. A send that fails after you moved to another chat puts the text back into that chat's draft.
- Side questions (/btw, 提问) move out of the transcript into a 提问 panel beside files, terminal and browser. The panel has its own input (with its own per-chat draft), lists the chat's side questions with 带入对话 and delete, and a dot on its top-bar chip shows an answer in progress or one that arrived while the panel was closed. 提问 mode and `/btw` in the main composer open the panel.
- The 补充 / 提问 toggle no longer wraps when a side panel narrows the chat column.

## 2026-11-13 - Faster conversation history

- Open conversations with a recent-message window instead of downloading every message body. Earlier messages load when scrolling up. Branch metadata is retained for navigation.
- Limit each window to 30 messages and a 64 KiB message-body target. A single message can exceed the target. Completed assistant text above 16,000 characters is expandable; running replies remain complete for stream continuity.
- Download tool inputs and outputs only when their details or terminal entry are opened. Collapsed activity groups no longer construct hidden tool rows.
- Gzip authenticated conversation reads when accepted by the client. Existing full-history clients and Markdown export remain supported.
- Cancel superseded conversation requests, guard stale completions, and show read-timeout or incomplete-response errors instead of waiting indefinitely.
- Add browser network/render timings and server serialization/compression timings. Stored conversation data is unchanged.
