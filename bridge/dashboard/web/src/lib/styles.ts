/** The Output styles a STYLE picker offers (bridge/outputstyles.py): Claude Code's built-ins,
 *  yours, and the session folder's. Kept apart so the composer's chip, PRESET, the FLOWS rows
 *  and the profile editor read one list the same way. */
import { useCallback, useEffect, useState } from "react";
import { api, type OutputStyle } from "../api";

/** The list for this session's folder (none: Claude's and yours), and a reload a menu calls
 *  as it opens, so a style file added since shows without a page reload. */
export function useStyles(sessionId?: string | null): [OutputStyle[], () => void] {
  const [list, setList] = useState<OutputStyle[]>([]);
  const load = useCallback(() => {
    void api.styles(sessionId || undefined).then((r) => setList(r.styles), () => {});
  }, [sessionId]);
  useEffect(load, [load]);
  return [list, load];
}

/** A style as a chip names it, whether or not the list has loaded: "" is unset. */
export const styleName = (id: string, unset = "Not set") => (!id ? unset : id === "default" ? "Default" : id);

const GROUP: Record<OutputStyle["source"], string> = { "built-in": "Claude Code", user: "Yours", folder: "This folder" };

/** A picker's rows: the unset row first (`unset`: what "" means there), then each style under
 *  where it comes from, its description as the hint. A value the list lacks stays as itself. */
export function styleRows(list: OutputStyle[], value: string, unset: { label: string; hint?: string }):
  { id: string; label: string; hint?: string; group?: string }[] {
  const rows = list.map((s) => ({ id: s.id, label: s.label, hint: s.description || undefined, group: GROUP[s.source] }));
  const kept = value && !rows.some((r) => r.id === value) ? [{ id: value, label: styleName(value) }] : [];
  return [{ id: "", label: unset.label, hint: unset.hint }, ...rows, ...kept];
}
