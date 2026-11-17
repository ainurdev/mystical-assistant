import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { useMultiOn } from "../../lib/multistore";
import { setChatImages, useChatImages, type ChatImagesMode, type ShownPictures } from "../../lib/chatimages";
import { CARD, Row, Section, Segmented } from "./SettingsModal";

/* SETTINGS ▸ System: how an image you send travels, and where one the agent shows you
   draws (bridge/chat_images.py). Its own
   setting, whatever EXPERIMENTAL says. Nothing already in a chat changes with it. */

const OPTIONS: { label: string; value: ChatImagesMode }[] = [
  { label: "AS ATTACHMENT", value: "attachment" },
  { label: "IN THE CHAT", value: "inline" },
];
const SHOWN: { label: string; value: ShownPictures }[] = [
  { label: "IN THE CHAT", value: "chat" },
  { label: "GALLERY ONLY", value: "gallery" },
];

export function ChatImagesSection() {
  const st = useChatImages();
  const on = useMultiOn();
  const [error, setError] = useState<string | null>(null);
  const pick = (body: { mode: ChatImagesMode } | { shown: ShownPictures }) => {
    setError(null);
    setChatImages(body).catch((e: Error) => setError(e.message));
  };
  if (!on) return null;
  return (
    <Section title="IMAGES" icon={ImageIcon} top desc="How images travel between you and the chat.">
      <div style={CARD}>
        <Row first label="SEND IMAGES"
          desc={st.stale
            ? "The bridge is running older code than this dashboard. Restart the bridge to use this."
            : <>
                <div>How an image you paste, drop or attach reaches the chat.</div>
                <div>As attachment: listed beside your message, and removed after a week.</div>
                <div>In the chat: saved in the project's .mystical/images, shown where you put them in your message, kept with the project.</div>
              </>}>
          {st.stale ? <span className="ma-tag" data-tone="warn">RESTART THE BRIDGE</span>
            : !st.loaded ? <span className="ma-set-note" role="status">reading…</span>
            : <div style={{ width: 280 }}><Segmented options={OPTIONS} value={st.mode} onPick={(mode) => pick({ mode })} /></div>}
        </Row>
        {!st.stale && (
          <Row label="PICTURES IT SHOWS YOU"
            desc={<>
              <div>In the chat: drawn large beside the answer.</div>
              <div>Gallery only: added to the WORK zone's pictures, with one line in the chat to open them. Telegram still gets them.</div>
            </>}>
            {st.loaded && <div style={{ width: 280 }}><Segmented options={SHOWN} value={st.shown} onPick={(shown) => pick({ shown })} /></div>}
          </Row>
        )}
        {error && <div className="ma-set-err" role="alert">{error}</div>}
      </div>
    </Section>
  );
}
