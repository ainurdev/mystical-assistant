import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tokenize, type Tok } from "./hl";

/* Syntax colours for components/DiffView, the dashboard's side: the editor's own grammars
   (lib/hl), found by the language the agent named or else the file's name. The Mini App's
   lib/codetok.ts draws code plain, as its Markdown does, to keep the grammars out of its bundle. */

export type { Tok };

export async function codeTokens(code: string, language: string, path: string): Promise<Tok[] | null> {
  const lang = language || LanguageDescription.matchFilename(languages, path.split("/").pop() ?? "")?.name || "";
  return lang ? tokenize(code, lang) : null;
}
