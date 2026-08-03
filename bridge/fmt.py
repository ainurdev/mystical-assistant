"""Editor formatting support: .editorconfig indent resolution and a
format-on-demand dispatcher.

The formatters run here, on the bridge, rather than as JS bundles in the
browser — the file is already on disk, the project's own config
(.prettierrc, pyproject.toml, .php-cs-fixer.php) resolves naturally, and
every language the user has a tool for works without shipping a parser per
language to the client.
"""
from __future__ import annotations

import configparser
import os
import re
import shutil
import subprocess
import tempfile

# ── formatters ─────────────────────────────────────────────────────────────
# ext -> ordered candidates, first one actually installed wins. `args` is
# templated with {path} (the real file's absolute path — a *hint* only, the
# content comes over stdin so unsaved edits format too).
_PRETTIER = [("prettier", ["--stdin-filepath", "{path}"])]
_FORMATTERS: dict[str, list[tuple[str, list[str]]]] = {
    "py": [("ruff", ["format", "--stdin-filename", "{path}", "-"]),
           ("black", ["-q", "--stdin-filename", "{path}", "-"])],
    "go": [("gofmt", [])],
    "rs": [("rustfmt", ["--emit", "stdout", "--edition", "2021"])],
    "sh": [("shfmt", ["-filename", "{path}"])],
    "bash": [("shfmt", ["-filename", "{path}"])],
    "zsh": [("shfmt", ["-filename", "{path}"])],
    "c": [("clang-format", ["--assume-filename={path}"])],
    "h": [("clang-format", ["--assume-filename={path}"])],
    "cpp": [("clang-format", ["--assume-filename={path}"])],
    "hpp": [("clang-format", ["--assume-filename={path}"])],
    "java": [("clang-format", ["--assume-filename={path}"])],
    # The php tools are php programs, so they need a php runtime; prettier's php
    # plugin is pure JS and formats php without one. Real tooling first (it obeys
    # the project's PSR config), prettier as the fallback that always works.
    "php": [("php-cs-fixer", []), ("pint", []), ("phpcbf", []),
            ("prettier", ["--stdin-filepath", "{path}"])],
}
for _e in ("js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "json", "jsonc",
           "css", "scss", "less", "html", "vue", "svelte", "md", "markdown",
           "yml", "yaml", "graphql"):
    _FORMATTERS[_e] = list(_PRETTIER)

_PHP_ARGS = {
    "php-cs-fixer": ["fix", "--quiet", "--using-cache=no", "{file}"],
    "pint": ["--quiet", "{file}"],
    "phpcbf": ["-q", "{file}"],
}


def _ext(rel: str) -> str:
    return rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""


def _resolve(cwd: str, tool: str) -> str | None:
    """Project-local tools beat global ones — a repo pinning prettier 2.x in
    node_modules must not get formatted by a global 3.x."""
    for rel in (f"node_modules/.bin/{tool}", f".venv/bin/{tool}", f"venv/bin/{tool}",
                f"vendor/bin/{tool}"):
        p = os.path.join(cwd, rel)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which(tool)


def _php_plugin(cwd: str, prettier: str) -> str | None:
    """`@prettier/plugin-php` is pure JS, so php formats with no php runtime —
    but prettier resolves --plugin against the cwd, so it needs an absolute
    path. Look in the project first, then wherever this prettier itself lives."""
    bases = [os.path.join(cwd, "node_modules")]
    d = os.path.dirname(os.path.realpath(prettier))
    while d and d != os.path.dirname(d):
        if os.path.basename(d) == "node_modules":
            bases.append(d)
        d = os.path.dirname(d)
    for b in bases:
        p = os.path.join(b, "@prettier", "plugin-php", "src", "index.mjs")
        if os.path.isfile(p):
            return p
    return None


def formatters_for(cwd: str, rel: str) -> tuple[str | None, list[str]]:
    """(resolved binary or None, names of every candidate) for this file type."""
    cands = _FORMATTERS.get(_ext(rel), [])
    for tool, _ in cands:
        found = _resolve(cwd, tool)
        # A prettier with no php plugin can't format php — keep looking rather
        # than offering the user a FORMAT button that only errors.
        if found and not (_ext(rel) == "php" and tool == "prettier"
                          and not _php_plugin(cwd, found)):
            return found, [t for t, _ in cands]
    return None, [t for t, _ in cands]


def _run_php(cwd: str, binary: str, rel: str, content: str) -> tuple[bool, str]:
    """php's formatters only work in place, so stage the buffer in a sibling
    temp file — inside the project, so its config file still resolves."""
    d = os.path.dirname(os.path.join(cwd, rel)) or cwd
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".mystical-fmt-", suffix=".php")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        args = [a.replace("{file}", tmp) for a in _PHP_ARGS[os.path.basename(binary)]]
        p = subprocess.run([binary, *args], cwd=cwd, capture_output=True, timeout=25)
        with open(tmp, encoding="utf-8") as f:
            out = f.read()
        # phpcbf exits 1 when it fixed something; trust the file, not the code.
        if not out.strip() and content.strip():
            return False, (p.stderr or p.stdout).decode("utf-8", "replace")[:400] or "formatter produced nothing"
        return True, out
    finally:
        try: os.unlink(tmp)
        except OSError: pass


def format_source(cwd: str, rel: str, content: str) -> dict:
    """Format `content` as if it were the file at `rel`. Never touches disk for
    non-php languages — the editor writes the result itself via files/write."""
    binary, cands = formatters_for(cwd, rel)
    if not binary:
        ext = _ext(rel) or "this file"
        if not cands:
            return {"ok": False, "error": f"no formatter configured for .{ext}"}
        return {"ok": False, "error": f"no formatter installed for .{ext} — tried: {', '.join(cands)}"}
    name = os.path.basename(binary)
    try:
        if name in _PHP_ARGS:                      # php's in-place-only tools
            ok, out = _run_php(cwd, binary, rel, content)
            return {"ok": True, "content": out, "tool": name} if ok else {"ok": False, "error": out, "tool": name}
        args = next(a for t, a in _FORMATTERS[_ext(rel)] if t == name)
        if _ext(rel) == "php":                     # prettier needs the plugin named
            args = [f"--plugin={_php_plugin(cwd, binary)}", *args]
        abs_path = os.path.join(os.path.realpath(cwd), rel)
        argv = [binary, *[a.replace("{path}", abs_path) for a in args]]
        p = subprocess.run(argv, cwd=cwd, input=content.encode("utf-8"),
                           capture_output=True, timeout=25)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{name} timed out after 25s", "tool": name}
    except OSError as e:
        return {"ok": False, "error": f"{name}: {e}", "tool": name}
    if p.returncode != 0:
        err = (p.stderr or p.stdout).decode("utf-8", "replace").strip()
        return {"ok": False, "error": err[:400] or f"{name} exited {p.returncode}", "tool": name}
    return {"ok": True, "content": p.stdout.decode("utf-8", "replace"), "tool": name}


# ── .editorconfig ──────────────────────────────────────────────────────────
# Language defaults, used when no .editorconfig claims the file. Mirrors what
# each ecosystem's own formatter would do.
_TAB_LANGS = {"go", "mod", "make", "mk"}
_FOUR_LANGS = {"py", "php", "rs", "java", "cs", "c", "h", "cpp", "hpp", "swift",
               "kt", "rb", "sh", "bash", "zsh", "sql", "lua", "pl"}


def _brace_expand(glob: str) -> list[str]:
    m = re.search(r"\{([^{}]*)\}", glob)
    if not m:
        return [glob]
    out = []
    for alt in m.group(1).split(","):
        out += _brace_expand(glob[:m.start()] + alt + glob[m.end():])
    return out


def _glob_re(glob: str) -> re.Pattern:
    """editorconfig globs: ** spans separators, * does not, and a pattern with
    no separator matches the basename at any depth."""
    if "/" not in glob:
        glob = "**/" + glob
    glob = glob.lstrip("/")
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if glob.startswith("**/", i):
            out += "(?:.*/)?"; i += 3
        elif glob.startswith("**", i):
            out += ".*"; i += 2
        elif c == "*":
            out += "[^/]*"; i += 1
        elif c == "?":
            out += "[^/]"; i += 1
        else:
            out += re.escape(c); i += 1
    return re.compile(f"^{out}$")


def _ec_props(cwd: str, rel: str) -> dict:
    """Collect .editorconfig properties for `rel`, outermost file first so the
    nearest one wins. A file with root=true stops the upward walk."""
    parts = rel.split("/")[:-1]
    dirs, chain = [cwd], cwd
    for p in parts:
        chain = os.path.join(chain, p)
        dirs.append(chain)
    props: dict[str, str] = {}
    stack = []
    for d in reversed(dirs):                       # nearest → outermost
        f = os.path.join(d, ".editorconfig")
        if not os.path.isfile(f):
            continue
        cp = configparser.ConfigParser(strict=False, interpolation=None)
        try:
            # Real .editorconfig files open with a bare `root = true`, which
            # configparser rejects as a missing section header — give it one.
            with open(f, encoding="utf-8") as fh:
                cp.read_string("[DEFAULT]\n" + fh.read())
        except (configparser.Error, OSError, UnicodeDecodeError):
            continue
        stack.append((d, cp))
        if cp.defaults().get("root", "").strip().lower() == "true":
            break
    for d, cp in reversed(stack):                  # outermost → nearest
        try:
            sub = os.path.relpath(os.path.join(cwd, rel), d).replace(os.sep, "/")
        except ValueError:
            continue
        for sec in cp.sections():
            if any(_glob_re(g).match(sub) for g in _brace_expand(sec)):
                props.update({k.lower(): v for k, v in cp.items(sec)})
    return props


def indent_for(cwd: str, rel: str) -> dict:
    """What the editor should use for this file: indent string, tab width, and
    the two save-time hygiene flags VS Code turns on by default."""
    ext = _ext(rel)
    base = os.path.basename(rel).lower()
    use_tabs = ext in _TAB_LANGS or base.startswith("makefile")
    width = 4 if (use_tabs or ext in _FOUR_LANGS) else 2
    trim, final_nl = True, True

    p = _ec_props(cwd, rel) if os.path.isdir(cwd) else {}
    style = p.get("indent_style", "").strip().lower()
    if style in ("tab", "space"):
        use_tabs = style == "tab"
    size = p.get("indent_size", p.get("tab_width", "")).strip().lower()
    if size.isdigit() and 1 <= int(size) <= 16:
        width = int(size)
    if p.get("trim_trailing_whitespace", "").strip().lower() in ("true", "false"):
        trim = p["trim_trailing_whitespace"].strip().lower() == "true"
    if p.get("insert_final_newline", "").strip().lower() in ("true", "false"):
        final_nl = p["insert_final_newline"].strip().lower() == "true"

    return {"indent": "\t" if use_tabs else " " * width, "tab_size": width,
            "trim_trailing_whitespace": trim, "insert_final_newline": final_nl}


def demo() -> None:
    """Self-check: globs, editorconfig precedence, language defaults."""
    assert _glob_re("*.py").match("bridge/git.py")
    assert _glob_re("*.py").match("git.py")
    assert not _glob_re("*.py").match("git.pyc")
    assert _glob_re("lib/**/*.ts").match("lib/a/b/c.ts")
    assert _glob_re("lib/**/*.ts").match("lib/c.ts")
    assert not _glob_re("lib/*.ts").match("lib/a/b.ts")
    assert sorted(_brace_expand("*.{js,ts}")) == ["*.js", "*.ts"]
    assert any(_glob_re(g).match("a.ts") for g in _brace_expand("*.{js,ts}"))

    assert indent_for("/nonexistent", "a.py")["indent"] == "    "
    assert indent_for("/nonexistent", "a.ts")["indent"] == "  "
    assert indent_for("/nonexistent", "main.go")["indent"] == "\t"
    assert indent_for("/nonexistent", "Makefile")["indent"] == "\t"

    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "web/src"))
        with open(os.path.join(d, ".editorconfig"), "w") as f:
            f.write("root = true\n[*]\nindent_style = space\nindent_size = 4\n"
                    "insert_final_newline = false\n[*.{js,ts}]\nindent_size = 2\n")
        with open(os.path.join(d, "web/.editorconfig"), "w") as f:
            f.write("[*.ts]\nindent_style = tab\n")
        assert indent_for(d, "a.py")["indent"] == "    ", indent_for(d, "a.py")
        assert indent_for(d, "a.py")["insert_final_newline"] is False
        assert indent_for(d, "a.js")["indent"] == "  "
        # nearest file wins on style, outer still supplies the size
        got = indent_for(d, "web/src/a.ts")
        assert got["indent"] == "\t" and got["tab_size"] == 2, got

    assert format_source("/nonexistent", "a.zzz", "x")["ok"] is False

    # php falls back to prettier's pure-JS plugin, but only when it's actually
    # there — a bare prettier must not claim it can format php.
    with tempfile.TemporaryDirectory() as d:
        binp = os.path.join(d, "node_modules", ".bin")
        os.makedirs(binp)
        pret = os.path.join(binp, "prettier")
        with open(pret, "w") as f:
            f.write("#!/bin/sh\ncat\n")
        os.chmod(pret, 0o755)
        assert _php_plugin(d, pret) is None
        assert formatters_for(d, "a.php")[0] is None, "no plugin → no php formatter"
        assert formatters_for(d, "a.ts")[0] == pret, "prettier still handles ts"

        plug = os.path.join(d, "node_modules", "@prettier", "plugin-php", "src")
        os.makedirs(plug)
        open(os.path.join(plug, "index.mjs"), "w").close()
        assert _php_plugin(d, pret) == os.path.join(plug, "index.mjs")
        assert formatters_for(d, "a.php")[0] == pret, "plugin present → php formats"

    print("bridge/fmt.py: all ok")


if __name__ == "__main__":
    demo()
