import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { useMultiOn } from "../../lib/multistore";
import { setChatImagesMode, useChatImages, type ChatImagesMode } from "../../lib/chatimages";
import { CARD, Row, Section, Segmented } from "./SettingsModal";

/* SETTINGS ▸ System: how an image you send travels (bridge/chat_images.py). Its own
   setting, whatever EXPERIMENTAL says. Nothing already in a chat changes with it. */

const OPTIONS: { label: string; value: ChatImagesMode }[] = [
  { label: "AS ATTACHMENT", value: "attachment" },
  { label: "IN THE CHAT", value: "inline" },
];

export function ChatImagesSection() {
  const st = useChatImages();
  const on = useMultiOn();
  const [error, setError] = useState<string | null>(null);
  const pick = (mode: ChatImagesMode) => {
    setError(null);
    setChatImagesMode(mode).catch((e: Error) => setError(e.message));
  };
  if (!on) return null;
  return (
    <Section title="IMAGES" icon={ImageIcon} top desc="How an image you paste, drop or attach reaches the chat.">
      <div style={CARD}>
        <Row first label="SEND IMAGES"
          desc={st.stale
            ? "The bridge is running older code than this dashboard. Restart the bridge to use this."
            : <>
                <div>As attachment: listed beside your message, and removed after a week.</div>
                <div>In the chat: saved in the project's .mystical/images, shown where you put them in your message, kept with the project.</div>
              </>}>
          {st.stale ? <span className="ma-tag" data-tone="warn">RESTART THE BRIDGE</span>
            : !st.loaded ? <span className="ma-set-note" role="status">reading…</span>
            : <div style={{ width: 280 }}><Segmented options={OPTIONS} value={st.mode} onPick={pick} /></div>}
        </Row>
        {error && <div className="ma-set-err" role="alert">{error}</div>}
      </div>
    </Section>
  );
}
