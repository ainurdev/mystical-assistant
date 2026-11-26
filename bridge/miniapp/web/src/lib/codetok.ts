/* Syntax colours for components/DiffView, the Mini App's side: none. Its Markdown prints code
   plain too, since the editor's grammars would more than double the bundle a phone loads. The
   dashboard's lib/codetok.ts colours it. */

export type Tok = { text: string; cls: string };

export async function codeTokens(_code: string, _language: string, _path: string): Promise<Tok[] | null> {
  return null;
}
