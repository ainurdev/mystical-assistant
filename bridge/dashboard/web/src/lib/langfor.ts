import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

/* CodeMirror's own language registry — ~140 languages and formats (Rust, Go,
   Java, PHP, C/C++, Ruby, Shell, SQL, YAML, TOML, XML, Dockerfile, diff, …),
   each loaded on demand when a file opens rather than bundled up front.

   Match on the basename: filename patterns (Dockerfile, BUILD, PKGBUILD) are
   anchored and case-sensitive, so try the name as-is, then lowercased so shouty
   extensions (.PY, .MD) still resolve. */
export function langFor(path: string): LanguageDescription | null {
  const base = path.split("/").pop() ?? path;
  return LanguageDescription.matchFilename(languages, base)
    ?? LanguageDescription.matchFilename(languages, base.toLowerCase());
}
