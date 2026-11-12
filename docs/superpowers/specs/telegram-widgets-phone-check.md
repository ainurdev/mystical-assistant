# Telegram widgets: the phone check

Ticket 01 of the Live board (spec and tickets in `.mystical/tickets/telegram-widgets/`
of the main checkout). One hand-made widget was sent to the owner's chat, edited,
pinned, unpinned and deleted by a scratch script that never polls
(`.mystical/scratch/tg-widget-probe/`, kept out of git). Later tickets read this note.

**Seen on 2026-11-10, Telegram for macOS 13.2.0 (build 283467), the native App Store
app.** The owner used the Mac, not a phone; iOS and Android are still unseen.

## Answers to the spec's ten questions

1. **Widgets show.** The widget drew as a live box inside the message.
2. **The pinned bar shows the caption** ("probe · caption 2").
3. **Pinning adds a "pinned a message" line** each time, even with
   `disable_notification`. Owner's decision: the bridge deletes that service line
   right after its own pin (the poll loop sees it as a message with `pinned_message`).
   If the delete is refused, the line stays. Ticket 02 builds and checks this.
4. **The sandbox has what the board needs.** `setTimeout`, `setInterval` and
   `requestAnimationFrame` exist and a 1-second `setInterval` ticked on screen.
   Markup built with `innerHTML` and `createElement` and replaced on every tick drew.
   A `click` on a plain `<span role="button">` was seen. Flex and grid both laid out.
   Fallback dropped: times count up inside the card, and the limit card counts down.
5. **Height follows content.** Sent with no `height`, the box grew from 1 row to 6 rows
   after a data edit. Fallback dropped: the board keeps 7 rows.
6. **Chat data is a string** (`typeof TelegramWidget.chatData === "string"`), so the
   page `JSON.parse`s it inside try/catch. **`chatDataChanged`** announced the edit
   (registered with `TelegramWidget.onEvent`). `TelegramWidget.request()` with no bot
   listening for `widget_query` ended in `WidgetRequestError` code `TIMEOUT`.
7. **A widget message behaves like any other.** `editMessageCaption` with a new
   `reply_markup` changed the caption and the buttons together. A `web_app` button under
   the widget opened Telegram's web view. `pinChatMessage`, `unpinChatMessage` and
   `deleteMessage` all returned ok. The `sendWidget` result's `widget` carried
   `chat_data` and no `width` or `height` when none were sent.
8. **Still open.** Data edits every 5 s, a caption edit and a second `sendWidget` ran
   while the owner started a long turn from Telegram, but the owner couldn't tell
   whether its draft survived. The owner chose to leave it open. Look again on the
   phone once ticket 02 is live.
9. **One data edit per 5 s is accepted.** 24 edits over two minutes, all ok, no refusal,
   no wait. The ceiling was not searched for.
10. **Edits to a deleted message:**
    - `editMessageWidgetData` → 400 `Bad Request: message with widget to edit not found`
    - `editMessageCaption` → 400 `Bad Request: message to edit not found`

    Match both as "gone". The poll half (what `getUpdates` answers when
    `allowed_updates` names something it rejects) was not tried, since probing it
    means polling beside the live bridge. It stays open for ticket 05.
