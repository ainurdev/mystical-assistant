/**
 * The six rows of the rail, which are also the six sections of the page.
 *
 * The headline claims you are running six sessions and can see one. The rail
 * has to be able to make that true on screen, so the page is cut into exactly
 * six — and the rail is the navigation as well as the demonstration. Add a
 * seventh section and either it gets no rail row or the headline stops being
 * illustrated by the thing next to it. Six.
 */
export type SectionId = (typeof SECTIONS)[number]["id"];

export const SECTIONS = [
  { id: "overview", path: "~/overview", note: "the pitch" },
  { id: "features", path: "~/features", note: "eight reasons" },
  { id: "limits", path: "~/limits", note: "when quota lands" },
  { id: "underneath", path: "~/underneath", note: "what actually runs" },
  { id: "setup", path: "~/setup", note: "two minutes" },
  { id: "questions", path: "~/questions", note: "the objections" },
] as const;
