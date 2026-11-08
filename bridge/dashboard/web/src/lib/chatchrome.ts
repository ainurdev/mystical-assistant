import type { SendKey } from "./theme";
import { createContext, useContext, type ReactNode } from "react";

/** What the chat column hands down to the composer it hosts. In the COMPACT
 *  layout the session's nameplate (title, project, branch, running app) moves
 *  out of the header and into the composer's control row; Terminal owns every
 *  prop that nameplate needs, so it passes the rendered node down here instead
 *  of App threading six more props into Composer. `sendKey` rides along for
 *  the same reason — the composer's one other reading preference. */
export interface ChatChrome {
  compact: boolean;
  lead: ReactNode;
  sendKey: SendKey;
}

export const ChatChromeContext = createContext<ChatChrome>({ compact: false, lead: null, sendKey: "enter" });
export const useChatChrome = () => useContext(ChatChromeContext);
