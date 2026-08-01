/* Explorer ordering: at every level, folders before files, each alphabetical.
   A path is "a folder here" when it still has segments below the one being
   compared. */
export function cmpTreePath(a: string, b: string): number {
  const A = a.split("/");
  const B = b.split("/");
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] === B[i]) continue;
    const aDir = i < A.length - 1;
    const bDir = i < B.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return A[i].localeCompare(B[i]);
  }
  return A.length - B.length;
}
