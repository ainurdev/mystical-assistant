/* Which tree rows .gitignore covers, so the explorer can dim them (VS Code's
   ignoredResourceForeground). The server sends `git ls-files --directory`
   output: a wholly ignored directory arrives as one `dir/` entry covering
   everything beneath it, a loose ignored file arrives bare. Tree row paths
   carry no trailing slash, hence the two lookups. */
export function ignoredMatcher(ignored: string[]): (path: string) => boolean {
  if (!ignored.length) return () => false;
  const exact = new Set(ignored);
  const dirs = ignored.filter((p) => p.endsWith("/"));
  return (path) =>
    exact.has(path) || exact.has(`${path}/`) || dirs.some((d) => path.startsWith(d));
}
