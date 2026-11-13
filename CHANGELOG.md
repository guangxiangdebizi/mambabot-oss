# Changelog

## 2026-11-13 - Faster conversation history

- Open conversations with a recent-message window instead of downloading every message body. Earlier messages load when scrolling up. Branch metadata is retained for navigation.
- Limit each window to 30 messages and a 64 KiB message-body target. A single message can exceed the target. Completed assistant text above 16,000 characters is expandable; running replies remain complete for stream continuity.
- Download tool inputs and outputs only when their details or terminal entry are opened. Collapsed activity groups no longer construct hidden tool rows.
- Gzip authenticated conversation reads when accepted by the client. Existing full-history clients and Markdown export remain supported.
- Cancel superseded conversation requests, guard stale completions, and show read-timeout or incomplete-response errors instead of waiting indefinitely.
- Add browser network/render timings and server serialization/compression timings. Stored conversation data is unchanged.
