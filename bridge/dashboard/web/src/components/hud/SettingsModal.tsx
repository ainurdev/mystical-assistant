import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  api,
  type AccountInfo,
  type AiFeature,
  type FreeAgentInfo,
  type FreeAgents,
  type TagCount,
  type UpdateInfo,
  type Weather,
} from "../../api";
import {
  autoBaseFont,
  AURORA_KEYS,
  BASE_FONTS,
  CLAUDE_KEYS,
  FONTS,
  isLight,
  THEME_DEFS,
  themeCompensator,
  themeDef,
  themeHasCrt,
  themeUnfilter,
  type HudSettings,
  type Indicator,
  type ThemeKey,
} from "../../lib/theme";
import { describe, loadProfiles, saveProfiles, type Profile } from "../../lib/profiles";
import { NYAN_MODES, nyanThumb, type NyanSound } from "../../lib/nyan";
import { VOICES, VOICE_GROUPS } from "../../lib/piano";
import { SONGS, TILE_SPEEDS, type TileSpeed } from "../../lib/songs";
import { RADIO_STATIONS } from "../../lib/ambient";
import { setAiFeatures } from "../../lib/ai";
import { TONES, chime, pushSupported, requestPush, type ToneKey } from "../../lib/push";
import {
  loadPackSounds,
  loadPacks,
  OFF,
  packChoice,
  playSound,
  PUSH_EVENT_KEYS,
  PUSH_EVENTS,
  soundsFor,
  type Pack,
  type PackSound,
  type PushEvent,
  type SoundChoice,
} from "../../lib/sounds";
import { EFFORTS, PERMS, PONYTAILS } from "../Composer";
import { latestPerFamily } from "../../models";
import { UpdateButton } from "./UpdateButton";

export interface SettingsModalProps {
  host: string;
  port: string;
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
  onPatch: (patch: Partial<HudSettings>) => void;
  models: { id: string; label: string }[];
  weather: Weather;
  onSetCity: (city: string) => Promise<string | null>;
  onSetUnit: (unit: string) => Promise<string | null>;
  station: number;
  onStation: (i: number) => void;
  onFeed: (texts: string[]) => void; // a failed self-update hands git's error to Claude
  onReplayBoot: () => void;
  onClose: () => void;
  // Profiles snapshot the run knobs *and* the open session's tool switches, so
  // the panel needs to read the latter and write it back.
  sessionTools: string[];
  onSessionTools: (rules: string[]) => void;
  onOpenInspector: () => void;
}

// ---- CATEGORIES -------------------------------------------------------------
// A category is "what were you trying to change", not "which file holds it".
// The first four are taste — how the HUD looks, what plays while it works, how
// it behaves, what surrounds it. NOTIFICATIONS is when it interrupts you. The
// last four are what a run, an account and the bridge do.
//
// NOTIFICATIONS used to be a block inside SYSTEM, between the HTTP inspector
// and the updater, which is where you look for it only if you already know it
// is there; likewise the prompt-box and transcript switches sat under SESSION
// among the model/mode/effort knobs they have nothing to do with.

type Tab = "appearance" | "indicator" | "interface" | "ambient" | "notifications"
  | "session" | "ai" | "accounts" | "system";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "appearance", label: "APPEARANCE", hint: "theme · CRT · boot" },
  { key: "indicator", label: "INDICATOR", hint: "what plays while working" },
  { key: "interface", label: "INTERFACE", hint: "prompt box · transcript" },
  { key: "ambient", label: "AMBIENT", hint: "weather · Claude·FM" },
  { key: "notifications", label: "NOTIFY", hint: "desktop · a sound per event" },
  { key: "session", label: "SESSION", hint: "model · mode · effort" },
  { key: "ai", label: "AI", hint: "extras that spend model calls" },
  { key: "accounts", label: "ACCOUNTS", hint: "logins · usage-limit fallback" },
  { key: "system", label: "SYSTEM", hint: "bridge · updates" },
];

// ---- WORKING INDICATOR ------------------------------------------------------
// Four forms share one tabbed panel so the modal stays one screen: the stock
// equalizer, a nyan.cat ride, a playable piano, and piano tiles. Picking a tab
// IS picking the form — `settings.indicator` is the tab state.

const INDICATOR_TABS: { key: Indicator; label: string; blurb: string }[] = [
  { key: "bar", label: "EQUALIZER", blurb: "the stock braille spinner, phrase ticker and level bars" },
  { key: "nyan", label: "NYAN CAT", blurb: "a nyan.cat ride — 36 cats, their trails, their music" },
  { key: "piano", label: "PIANO", blurb: "two octaves to play with mouse or keyboard while you wait" },
  { key: "tiles", label: "TILES", blurb: "piano tiles — clear each falling note on the key that plays it" },
];

// 0 = AUTO (viewport-derived); the rest are the base the type scale hangs off.
const BASE_FONT_OPTS: { label: string; value: string }[] = BASE_FONTS.map((n) => ({
  label: n === 0 ? "AUTO" : `${n}PX`,
  value: String(n),
}));

const FONT_OPTS = FONTS.map((f) => ({ label: f.label, value: f.key }));

const TONE_OPTS = (Object.keys(TONES) as ToneKey[]).map((k) => ({ label: TONES[k].label, value: k }));

const CRT_TOGGLES: { key: "scanlines" | "sweep" | "glow"; label: string; desc: string }[] = [
  { key: "scanlines", label: "SCANLINES", desc: "horizontal CRT raster lines" },
  { key: "sweep", label: "SCAN SWEEP", desc: "roaming refresh glow band" },
  { key: "glow", label: "TEXT GLOW", desc: "phosphor bloom on headings" },
];

const field = {
  background: "var(--panel3)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  outline: "none",
  color: "var(--txb)",
  fontFamily: "inherit",
  fontSize: "var(--t10)",
  letterSpacing: 1,
  padding: "6px 8px",
};

const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 10, marginTop: 11 };
// Several controls abreast, wrapping onto a second line when the panel narrows.
const LINE: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 11 };
const CAPTION: CSSProperties = { fontSize: "var(--t95)", letterSpacing: 1, color: "var(--txd)", flex: "none", width: 62 };
const CARD: CSSProperties = { border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "12px 13px" };
const KV: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const KEY_TX: CSSProperties = { fontSize: "var(--t10)", letterSpacing: 1, color: "var(--txd)" };
const NOTE: CSSProperties = { fontSize: "var(--t95)", color: "var(--txl)", marginTop: 11, lineHeight: 1.7 };

/** Section caption above a settings block. */
function Label({ children, top }: { children: ReactNode; top?: boolean }) {
  return (
    <div style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--txl)", margin: top ? "20px 0 11px" : "0 0 11px" }}>
      {children}
    </div>
  );
}

/** An ON/OFF pill, matching the CRT rows. */
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        appearance: "none",
        cursor: "pointer",
        border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
        background: "var(--panel3)",
        padding: 2,
        display: "flex",
        gap: 2,
        flex: "none",
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px", background: on ? "var(--acc)" : "transparent", color: on ? "var(--acc-on)" : "var(--txl)" }}>
        ON
      </span>
      <span style={{ fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px", background: on ? "transparent" : "color-mix(in srgb, var(--acc) 18%, transparent)", color: on ? "var(--txl)" : "var(--txb)" }}>
        OFF
      </span>
    </button>
  );
}

function Volume({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        title={`Volume ${Math.round(value * 100)}%`}
        style={{ width: 96, flex: "none", accentColor: "var(--acc)" }}
      />
      <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: "none", width: 30, textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>
        {Math.round(value * 100)}%
      </span>
    </>
  );
}

/** Segmented picker — one button per option, active one filled. */
function Segmented<T extends string>({
  options,
  value,
  onPick,
  size = "var(--t10)",
}: {
  options: { label: string; value: T }[];
  value: T;
  onPick: (v: T) => void;
  size?: string;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onPick(o.value)}
            style={{
              flex: "1 1 72px",
              appearance: "none",
              cursor: "pointer",
              border: 0,
              background: active ? "var(--acc)" : "transparent",
              color: active ? "var(--acc-on)" : "var(--txd)",
              fontFamily: "inherit",
              fontSize: size,
              letterSpacing: 1,
              padding: "6px 4px",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled control that shares its line with the others beside it — the
 *  caption sits above so the cells stay narrow, and they wrap when the panel
 *  can't hold them all. */
function Cell({ label, grow = "1 1 148px", children }: { label: string; grow?: string; children: ReactNode }) {
  return (
    <div style={{ flex: grow, minWidth: 0 }}>
      <div style={{ ...CAPTION, width: "auto", marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

/** A labelled <select> cell over one of the composer's option lists. */
function PickCell({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <Cell label={label}>
      <select value={value} onChange={(e) => onPick(e.target.value)} style={{ ...field, width: "100%" }}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Cell>
  );
}

// ---- NOTIFICATION SOUNDS ----------------------------------------------------

/** One scrolling list, used for both halves of the browser. */
const LIST: CSSProperties = {
  maxHeight: 168, overflowY: "auto", marginTop: 6,
  border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
};

function ListRow({ on, children, onClick }: { on?: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", appearance: "none", cursor: "pointer",
        border: 0, borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
        background: on ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent",
        color: on ? "var(--txb)" : "var(--tx)", fontFamily: "inherit", fontSize: "var(--t10)",
        letterSpacing: .5, padding: "7px 9px", lineHeight: 1.4,
      }}
    >
      {children}
    </button>
  );
}

/** Browse peonping.com: search the catalog, open a pack, click a sound to hear
 *  it and assign it. Every sound in the pack is offered, not just the ones
 *  written for this event — a victory line on FAILURE is a valid taste. */
function PackBrowser({ cat, volume, onPick }: {
  cat: string;
  volume: number;
  onPick: (c: SoundChoice) => void;
}) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [pack, setPack] = useState<Pack | null>(null);
  const [byCat, setByCat] = useState<Record<string, PackSound[]> | null>(null);

  useEffect(() => {
    let live = true;
    loadPacks().then((p) => { if (live) setPacks(p); },
      (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);

  // Re-fetching a manifest is free (module-cached), so this just re-renders.
  useEffect(() => {
    if (!pack) { setByCat(null); return; }
    let live = true;
    setByCat(null);
    loadPackSounds(pack).then((m) => { if (live) setByCat(m); },
      (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [pack]);

  if (err) return <div style={{ ...NOTE, color: "var(--err)" }}>peonping.com unreachable — {err}</div>;
  if (!packs) return <div style={NOTE}>Loading the pack catalog…</div>;

  if (pack) {
    const groups = byCat ? soundsFor(byCat, cat) : [];
    return (
      <>
        <ListRow onClick={() => setPack(null)}>← {packs.length} packs</ListRow>
        <div style={{ ...NOTE, marginTop: 6 }}>{pack.display_name}</div>
        {!byCat ? <div style={NOTE}>Loading sounds…</div> : (
          <div style={LIST}>
            {groups.map((g) => (
              <div key={g.cat}>
                <div style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", padding: "6px 9px 3px" }}>
                  {g.cat === cat ? `${g.cat} — written for this` : g.cat}
                </div>
                {g.sounds.map((s) => {
                  const choice = packChoice(pack, s);
                  return (
                    <ListRow key={choice.src} onClick={() => { playSound(choice, volume, "blip"); onPick(choice); }}>
                      ♪ {choice.label.split(" · ").slice(1).join(" · ")}
                    </ListRow>
                  );
                })}
              </div>
            ))}
            {!groups.length && <div style={{ ...NOTE, padding: "0 9px 8px" }}>This pack ships no sounds.</div>}
          </div>
        )}
      </>
    );
  }

  const needle = q.trim().toLowerCase();
  const hits = packs
    // A pack without this event's category still has sounds you can assign, so
    // it stays in the list — it just sorts below the ones written for it.
    .filter((p) => !needle || `${p.display_name} ${p.name} ${(p.tags ?? []).join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.categories.includes(cat)) - Number(a.categories.includes(cat)))
    .slice(0, 120);
  return (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`search ${packs.length} packs — glados, peon, rick…`}
        style={{ ...field, width: "100%", boxSizing: "border-box" }}
      />
      <div style={LIST}>
        {hits.map((p) => (
          <ListRow key={p.name} onClick={() => setPack(p)}>
            {p.display_name}
            <span style={{ color: "var(--txl)", fontSize: "var(--t9)" }}>
              {"  "}· {p.sound_count ?? "?"} sounds{p.categories.includes(cat) ? "" : " · no clip for this event"}
            </span>
          </ListRow>
        ))}
        {!hits.length && <div style={{ ...NOTE, padding: "8px 9px" }}>No pack matches “{q}”.</div>}
      </div>
    </>
  );
}

/** The per-event table: one assignable sound per thing the dashboard notifies
 *  about. An unassigned event falls back to the single TONE below, which is
 *  what every install sounded like before this panel existed. */
function SoundBoard({ settings, onPatch }: {
  settings: HudSettings;
  onPatch: (patch: Partial<HudSettings>) => void;
}) {
  const [open, setOpen] = useState<PushEvent | null>(null);
  const set = (ev: PushEvent, c: SoundChoice | undefined) => {
    const next = { ...settings.pushSounds };
    if (c) next[ev] = c; else delete next[ev];
    onPatch({ pushSounds: next });
  };
  return (
    <div style={{ marginTop: 11 }}>
      {PUSH_EVENT_KEYS.map((ev) => {
        const meta = PUSH_EVENTS[ev];
        const cur = settings.pushSounds[ev];
        const on = open === ev;
        return (
          <div key={ev} style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", padding: "9px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={KEY_TX}>{meta.label}</div>
                <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 3 }}>{meta.hint}</div>
              </div>
              <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  fontSize: "var(--t9)", letterSpacing: .5, maxWidth: 150, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                  color: cur ? "var(--acc)" : "var(--txl)",
                }}>
                  {cur ? cur.label : `${TONES[settings.pushTone].label} (default)`}
                </span>
                <MiniBtn onClick={() => playSound(cur, settings.pushVolume, settings.pushTone)}>♪</MiniBtn>
                <MiniBtn onClick={() => setOpen(on ? null : ev)}>{on ? "×" : "…"}</MiniBtn>
              </div>
            </div>
            {on && (
              <div style={{ marginTop: 9 }}>
                <Segmented
                  size="var(--t9)"
                  options={[
                    { label: "DEFAULT", value: "" },
                    { label: "OFF", value: "off" },
                    ...TONE_OPTS.map((t) => ({ label: t.label, value: `tone:${t.value}` })),
                  ]}
                  value={cur?.src ?? ""}
                  onPick={(v) => {
                    if (!v) { set(ev, undefined); playSound(undefined, settings.pushVolume, settings.pushTone); return; }
                    const c = v === "off" ? OFF
                      : { src: v, label: TONES[v.slice(5) as ToneKey].label };
                    set(ev, c);
                    playSound(c, settings.pushVolume, settings.pushTone);
                  }}
                />
                <div style={{ marginTop: 9 }}>
                  <PackBrowser cat={meta.cat} volume={settings.pushVolume} onPick={(c) => set(ev, c)} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// The "DISPLAY PROFILE" grid. Because the whole app is run through the active
// theme's CSS filter, every swatch/preview colour is pre-corrected by the
// INVERSE of that filter's color matrix so the cards render TRUE colours.
// AURORA's four hues and CLAUDE's four accents each collapse into one card with
// a variant row; every other theme is its own card. The cards split by ground —
// six dark cards, six light — and each set gets its own labelled row.
type ThemeCard = { key: ThemeKey; variants?: ThemeKey[] };

const CARDS: ThemeCard[] = [
  { key: "aqua", variants: AURORA_KEYS },
  { key: "claude", variants: CLAUDE_KEYS },
  ...THEME_DEFS
    .filter((t) => !AURORA_KEYS.includes(t.key) && !CLAUDE_KEYS.includes(t.key))
    .map((t) => ({ key: t.key })),
];

const DARK_CARDS = CARDS.filter((c) => !isLight(c.key));
const LIGHT_CARDS = CARDS.filter((c) => isLight(c.key));

function ThemeCardGrid({
  cards,
  settings,
  onTheme,
}: { cards: ThemeCard[]; settings: HudSettings; onTheme: (t: ThemeKey) => void }) {
  const [hover, setHover] = useState<ThemeKey | null>(null);
  const comp = themeCompensator(settings.theme);
  // A family card wears whichever of its variants is live (the first otherwise).
  const liveOf = (variants: ThemeKey[]): ThemeKey =>
    variants.includes(settings.theme) ? settings.theme : variants[0];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
      {cards.map((card) => {
        const t = themeDef(card.variants ? liveOf(card.variants) : card.key);
        const on = card.variants ? card.variants.includes(settings.theme) : settings.theme === card.key;
        const name = card.variants ? themeDef(card.variants[0]).name : t.name;
        const sw = comp(t.sw);
        const cardBd = on ? comp(t.sw) : comp("#26413d");
        const cardBg = on ? comp("#132824") : comp("#0d1517");
        const dim = comp("#20332f");
        const pbg = comp(t.pbg);
        // The card ground is a hardcoded dark, so the name is a fixed light —
        // following the live theme's --txb turned it invisible in light themes.
        const nameC = comp("#e6f2ee");
        const descC = comp("#8fa8a2");
        const chipC = comp("var(--acc-on)");
        const pfont = t.font || "inherit";
        const prad = t.prad || "0";
        return (
          <div
            key={card.key}
            onClick={() => onTheme(t.key)}
            onMouseEnter={() => setHover(card.key)}
            onMouseLeave={() => setHover(null)}
            style={{
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
              border: `1px solid ${hover === card.key ? "color-mix(in srgb, var(--acc) 45%, transparent)" : cardBd}`,
              background: cardBg,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "relative",
                height: 38,
                background: pbg,
                borderBottom: `1px solid ${dim}`,
                overflow: "hidden",
                padding: "7px 9px",
              }}
            >
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: "100%" }}>
                <span style={{ flex: 1, height: "55%", background: sw, opacity: 0.8 }}></span>
                <span style={{ flex: 1, height: "100%", background: sw }}></span>
                <span style={{ flex: 1, height: "45%", background: sw, opacity: 0.5 }}></span>
                <span style={{ flex: 1, height: "80%", background: sw, opacity: 0.8 }}></span>
                <span style={{ flex: 1, height: "30%", background: sw, opacity: 0.35 }}></span>
                <span style={{ flex: 1, height: "65%", background: sw, opacity: 0.8 }}></span>
              </div>
              {t.crt && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    background:
                      "repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.28) 3px,rgba(0,0,0,0) 4px)",
                    opacity: 0.55,
                  }}
                ></div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px" }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: sw,
                  border: "1px solid rgba(0,0,0,.45)",
                  flex: "none",
                  borderRadius: prad,
                }}
              ></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--t105)",
                    letterSpacing: 1,
                    color: nameC,
                    fontFamily: pfont,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {name}
                </div>
                <div
                  style={{
                    fontSize: "var(--t8)",
                    letterSpacing: 0.4,
                    color: descC,
                    marginTop: 1,
                    fontFamily: pfont,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.feel}
                </div>
              </div>
              {on && (
                <span
                  style={{
                    fontSize: "var(--t7)",
                    letterSpacing: 1,
                    color: chipC,
                    background: sw,
                    padding: "1px 5px",
                    flex: "none",
                  }}
                >
                  ON
                </span>
              )}
            </div>

            {card.variants && (
              <div style={{ display: "flex", gap: 5, padding: "0 9px 8px" }}>
                {card.variants.map((k) => {
                  const c = themeDef(k);
                  const live = settings.theme === k;
                  return (
                    <button
                      key={k}
                      title={c.name}
                      onClick={(e) => { e.stopPropagation(); onTheme(k); }}
                      style={{
                        appearance: "none",
                        cursor: "pointer",
                        flex: 1,
                        height: 12,
                        padding: 0,
                        background: comp(c.sw),
                        border: `1px solid ${live ? comp("#f2fbf9") : "rgba(0,0,0,.45)"}`,
                        borderRadius: t.prad || "0",
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CrtToggles({
  settings,
  onToggle,
}: {
  settings: HudSettings;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
        background: "color-mix(in srgb, var(--acc) 8%, transparent)",
      }}
    >
      {CRT_TOGGLES.map((g) => (
        <div
          key={g.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            background: "color-mix(in srgb, var(--panel) 92%, transparent)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--t12)", color: "var(--txh)", letterSpacing: 0.5 }}>{g.label}</div>
            <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 2 }}>{g.desc}</div>
          </div>
          <Switch on={settings[g.key]} onClick={() => onToggle(g.key)} />
        </div>
      ))}
    </div>
  );
}

function IndicatorPicker({
  settings,
  onPatch,
}: {
  settings: HudSettings;
  onPatch: (patch: Partial<HudSettings>) => void;
}) {
  const unfilter = themeUnfilter(settings.theme);
  const active = INDICATOR_TABS.find((t) => t.key === settings.indicator) ?? INDICATOR_TABS[0];

  return (
    <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel) 92%, transparent)" }}>
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)" }}>
        {INDICATOR_TABS.map((t) => {
          const on = settings.indicator === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onPatch({ indicator: t.key })}
              style={{
                flex: 1,
                appearance: "none",
                cursor: "pointer",
                border: 0,
                borderBottom: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent",
                color: on ? "var(--txb)" : "var(--txd)",
                fontFamily: "inherit",
                fontSize: "var(--t95)",
                letterSpacing: 1.5,
                padding: "8px 4px",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ padding: "12px 13px" }}>
        <div style={{ fontSize: "var(--t95)", color: "var(--txl)" }}>{active.blurb}</div>

        {settings.indicator === "nyan" && (
          <>
            <div
              className="mscroll"
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(52px,1fr))", gap: 5, maxHeight: 172, overflowY: "auto", marginTop: 11 }}
            >
              {NYAN_MODES.map((m) => {
                const on = settings.nyan === m.key;
                return (
                  <button
                    key={m.key}
                    onClick={() => onPatch({ nyan: m.key })}
                    title={m.label}
                    style={{
                      appearance: "none",
                      cursor: "pointer",
                      padding: 3,
                      lineHeight: 0,
                      background: on ? "color-mix(in srgb, var(--acc) 20%, transparent)" : "var(--panel3)",
                      border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
                    }}
                  >
                    <img src={nyanThumb(m.thumb)} alt={m.label} loading="lazy" style={{ width: "100%", display: "block", filter: unfilter }} />
                  </button>
                );
              })}
            </div>

            <div style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--t11)", color: "var(--txh)", letterSpacing: 0.5 }}>EXTRA ANIMATIONS</div>
                <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 2 }}>
                  fly the cat, draw nyan.cat's rainbow trail + pixel stars
                </div>
              </div>
              <Switch on={settings.nyanExtra} onClick={() => onPatch({ nyanExtra: !settings.nyanExtra })} />
            </div>

            <div style={ROW}>
              <span style={CAPTION}>SOUND</span>
              <select
                value={settings.nyanSound}
                onChange={(e) => onPatch({ nyanSound: e.target.value as NyanSound })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                <option value="match">MATCH THE CAT</option>
                <option value="off">MUTE</option>
                {NYAN_MODES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <Volume
                value={settings.nyanVolume}
                disabled={settings.nyanSound === "off"}
                onChange={(nyanVolume) => onPatch({ nyanVolume })}
              />
            </div>
          </>
        )}

        {settings.indicator === "tiles" && (
          <>
            <div style={ROW}>
              <span style={CAPTION}>SONG</span>
              <select
                value={settings.tilesSong}
                onChange={(e) => onPatch({ tilesSong: e.target.value })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                {SONGS.map((song) => (
                  <option key={song.key} value={song.key}>
                    {song.title} — {song.composer}
                  </option>
                ))}
              </select>
              <select
                value={settings.tilesSpeed}
                onChange={(e) => onPatch({ tilesSpeed: e.target.value as TileSpeed })}
                style={{ ...field, flex: "none" }}
              >
                {TILE_SPEEDS.map((sp) => (
                  <option key={sp} value={sp}>
                    {sp.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div style={NOTE}>
              Notes fall down the lane of the key that plays them — hit that key as the tile lands.
              Mouse or computer keys, same as the piano, and it uses the VOICE picked on the PIANO
              tab.
              <br />
              Every melody is public domain; a modern chart hit&apos;s tune is a copyrighted
              composition, so the directory sticks to the canon. Add your own in{" "}
              <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
                src/lib/songs.ts
              </span>
              .
            </div>
          </>
        )}

        {settings.indicator === "piano" && (
          <>
            <div style={ROW}>
              <span style={CAPTION}>VOICE</span>
              <select
                value={settings.pianoVoice}
                onChange={(e) => onPatch({ pianoVoice: e.target.value })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                {VOICE_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {VOICES.filter((v) => v.group === g).map((v) => (
                      <option key={v.key} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <Volume value={settings.pianoVolume} onChange={(pianoVolume) => onPatch({ pianoVolume })} />
            </div>
            <div style={NOTE}>
              Click the board to arm the computer keys — unfocused, they stay yours for typing.
              <br />
              <span style={{ color: "var(--txd)" }}>SAMPLES</span> are real recordings, one MP3 per
              note, fetched on first use (~600&nbsp;KB a voice, then browser-cached); the synth
              covers until they land.{" "}
              <span style={{ color: "var(--txd)" }}>SYNTH</span> voices are generated locally and
              need no network.
              <br />
              <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
                Z S X D C V G B H N J M
              </span>{" "}
              plays C3–B3 ·{" "}
              <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
                Q 2 W 3 E R 5 T 6 Y 7 U I
              </span>{" "}
              plays C4–C5.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** City + unit for the header clock's weather — the same bridge-side setting the
 *  clock popover writes. */
function WeatherCard({
  weather,
  onSetCity,
  onSetUnit,
}: {
  weather: Weather;
  onSetCity: (city: string) => Promise<string | null>;
  onSetUnit: (unit: string) => Promise<string | null>;
}) {
  const [city, setCity] = useState(weather.loc);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!city.trim() || saving) return;
    setSaving(true);
    setErr(null);
    const e = await onSetCity(city.trim());
    setSaving(false);
    setErr(e);
  }

  return (
    <div style={CARD}>
      <div style={{ ...LINE, marginTop: 0 }}>
        <Cell label="CITY" grow="1 1 200px">
          <div style={{ display: "flex", gap: 9 }}>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              placeholder="city — e.g. Tehran"
              style={{
                flex: 1,
                minWidth: 0,
                background: "var(--panel3)",
                border: `1px solid ${err ? "var(--err)" : "color-mix(in srgb, var(--acc) 22%, transparent)"}`,
                outline: "none",
                color: "var(--txb)",
                fontFamily: "inherit",
                fontSize: "var(--t115)",
                padding: "7px 9px",
              }}
            />
            <button
              onClick={() => void save()}
              disabled={saving}
              style={{
                appearance: "none",
                cursor: saving ? "wait" : "pointer",
                border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                background: "color-mix(in srgb, var(--acc) 8%, transparent)",
                color: "var(--tx)",
                fontFamily: "inherit",
                fontSize: "var(--t10)",
                letterSpacing: 1.5,
                padding: "7px 13px",
                flex: "none",
              }}
            >
              {saving ? "…" : "SAVE"}
            </button>
          </div>
        </Cell>
        <Cell label="UNIT" grow="none">
          <Segmented
            options={[
              { label: "°C", value: "celsius" },
              { label: "°F", value: "fahrenheit" },
            ]}
            value={weather.unit === "F" ? "fahrenheit" : "celsius"}
            onPick={(u) => void onSetUnit(u)}
          />
        </Cell>
      </div>
      {err && <div style={{ fontSize: "var(--t9)", color: "var(--err)", marginTop: 5 }}>{err}</div>}
    </div>
  );
}

/** What the bridge's own checkout is running, and the pull-and-restart button. */
function UpdatePanel({ onFeed }: { onFeed: (texts: string[]) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let live = true;
    void api.update().then((u) => { if (live) setInfo(u); }).catch(() => { /* ignore */ });
    return () => { live = false; };
  }, []);

  return (
    <div style={CARD}>
      <div style={KV}>
        <span style={KEY_TX}>BRANCH</span>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", color: "var(--tx)" }}>
          {info ? `⎇ ${info.branch || "—"}` : "…"}
        </span>
      </div>
      <div style={{ ...KV, marginTop: 10 }}>
        <span style={KEY_TX}>UPSTREAM</span>
        <span style={{ fontSize: "var(--t105)", color: info && info.behind > 0 ? "var(--warn)" : "var(--ok)" }}>
          {!info ? "…" : info.behind > 0 ? `${info.behind} COMMIT${info.behind === 1 ? "" : "S"} BEHIND` : "UP TO DATE"}
        </span>
      </div>
      {info && info.dirty > 0 && (
        <div style={{ ...KV, marginTop: 10 }}>
          <span style={KEY_TX}>WORKING TREE</span>
          <span style={{ fontSize: "var(--t105)", color: "var(--warn)" }}>{info.dirty} UNCOMMITTED</span>
        </div>
      )}
      {info && info.behind > 0 && (
        <div style={{ marginTop: 12, display: "flex" }}>
          <UpdateButton onFeed={onFeed} />
        </div>
      )}
    </div>
  );
}

// ---- ACCOUNTS ---------------------------------------------------------------
// Multiple Claude logins + what happens when one hits its usage limit. Each
// account is a CLAUDE_CONFIG_DIR profile, so adding one means logging in with
// `claude /login` in a terminal first — we only snapshot what's on disk.

const POLICY_OPTS: { label: string; value: string }[] = [
  { label: "ASK", value: "ask" },
  { label: "AUTO", value: "auto" },
  { label: "WAIT", value: "wait" },
];

const POLICY_BLURB: Record<string, string> = {
  ask: "Offer the choices (other account · free agent · wait) and stay parked until you pick.",
  auto: "Take the best fallback immediately and report which one it landed on.",
  wait: "Only wait for the window to reset — the behaviour before the ladder existed.",
};

/** Every model call the bridge makes on top of your own turns, and its switch.
 *  Anything that runs on its own ships off: an install should cost exactly the
 *  turns you typed until you decide otherwise. The ones that only fire on a
 *  press ship on, and are listed so the spend is still visible and stoppable.
 *  Takes effect on the next turn — no restart. */
/** Every tag in play, with the two operations that actually come up: fix a name,
 *  or get rid of one. Merging isn't a separate button — renaming a tag to one
 *  that already exists is a merge, which is both true of the storage and one
 *  fewer thing to explain. */
function TagsPanel() {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.tags().then((r) => { if (live) setTags(r.tags); }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function commit(tag: string, next?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.retag(tag, next);
      setTags(r.tags);
    } catch { /* the list just doesn't change */ }
    setBusy(false);
    setEditing(null);
  }

  if (!tags.length)
    return <div style={CARD}><span style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>No tags yet — they arrive with the first named session.</span></div>;

  return (
    <div style={CARD}>
      {tags.map((t) => (
        <div key={t.tag} style={{ ...KV, marginTop: 8, gap: 10 }}>
          {editing === t.tag ? (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit(t.tag, value.trim() || undefined);
                if (e.key === "Escape") setEditing(null);
              }}
              onBlur={() => setEditing(null)}
              style={{ flex: 1, minWidth: 0, background: "transparent", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t11)", padding: "3px 7px", outline: "none" }}
            />
          ) : (
            <>
              <span style={{ fontSize: "var(--t11)", color: "var(--purple-d)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.tag}
              </span>
              <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: "none" }}>
                {t.count} session{t.count === 1 ? "" : "s"}
              </span>
              <button
                onClick={() => { setEditing(t.tag); setValue(t.tag); }}
                title="rename — an existing name merges the two"
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 8px", flex: "none" }}
              >RENAME</button>
              <button
                onClick={() => void commit(t.tag)}
                title={`remove "${t.tag}" from all ${t.count} session${t.count === 1 ? "" : "s"}`}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 8px", flex: "none" }}
              >✕</button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function AiPanel() {
  const [rows, setRows] = useState<AiFeature[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .aiFeatures()
      .then((r) => {
        setRows(r.features);
        setAiFeatures(r.features);
      })
      .catch(() => setRows([]));
  }, []);

  async function toggle(f: AiFeature) {
    setBusy(f.key);
    setErr(null);
    try {
      const fresh = (await api.setAiFeature(f.key, !f.enabled)).features;
      setRows(fresh);
      // The switch owns visible UI elsewhere (tabs, boards, cards) — hand the
      // fresh answer to the shared store so it appears/disappears right now.
      setAiFeatures(fresh);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <div style={NOTE}>Reading…</div>;
  if (!rows.length)
    return <div style={NOTE}>This bridge is running a build without the AI tab. Restart it.</div>;

  return (
    <>
      <Label>MODEL-SPENDING EXTRAS</Label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((f) => (
          <div key={f.key} style={CARD}>
            <div style={KV}>
              <span style={{ fontSize: "var(--t11)", letterSpacing: 1, color: "var(--txb)" }}>{f.label}</span>
              <Switch on={f.enabled} onClick={() => void (busy ? null : toggle(f))} />
            </div>
            <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 7, lineHeight: 1.7 }}>
              {f.hint}
            </div>
            {f.about && (
              <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 6, lineHeight: 1.8 }}>
                {f.about}
              </div>
            )}
            <div style={{ fontSize: "var(--t9)", color: "var(--txd)", marginTop: 6, letterSpacing: 0.5 }}>
              costs {f.cost}
            </div>
          </div>
        ))}
      </div>
      {err && <div style={{ ...NOTE, color: "var(--bad, #f66)" }}>{err}</div>}
      <div style={NOTE}>
        Anything that runs without you pressing something is off by default. A switch
        here beats the matching environment setting and applies to the next turn —
        nothing to restart. Everything a feature adds to the dashboard is hidden again
        the moment you switch it off. The next-up board also prefers a free provider
        (ACCOUNTS tab) over spending Claude quota.
      </div>
    </>
  );
}

function AccountsPanel() {
  const [rows, setRows] = useState<AccountInfo[] | null>(null);
  const [policy, setPolicy] = useState("ask");
  const [free, setFree] = useState<FreeAgents>({ installed: false, providers: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A sign-in in flight: the CLI is parked on its "paste the code" prompt in a
  // fresh profile, waiting for what the browser hands back.
  const [login, setLogin] = useState<{ slot: number; url: string } | null>(null);

  const load = () =>
    api
      .accounts()
      .then((r) => {
        setRows(r.accounts);
        setPolicy(r.default_policy);
        // A bridge still running the pre-setup build answers with a bare list of
        // labels; show no rungs rather than throwing until it restarts.
        setFree(
          Array.isArray(r.free_agents?.providers) ? r.free_agents : { installed: false, providers: [] },
        );
        if (r.pending_login?.url)
          setLogin({ slot: r.pending_login.slot, url: r.pending_login.url });
      })
      .catch(() => setRows([]));

  useEffect(() => {
    void load();
  }, []);

  async function act(action: "add" | "remove" | "disable" | "enable", slot?: number) {
    setBusy(true);
    setErr(null);
    try {
      await api.accountAction(action, slot);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.loginBegin();
      setLogin({ slot: r.slot, url: r.url });
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not start the sign-in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Label top>ON USAGE LIMIT</Label>
      <div style={CARD}>
        <Segmented
          options={POLICY_OPTS}
          value={policy}
          onPick={(v) => {
            setPolicy(v);
            void api.setDefaultPolicy(v).catch(() => void load());
          }}
        />
        <div style={{ ...NOTE, marginTop: 9 }}>{POLICY_BLURB[policy]}</div>
      </div>
      <div style={NOTE}>
        The default for new chats. Any one chat can override it — right-click it in the
        sessions list.
      </div>

      <Label>CLAUDE LOGINS</Label>
      <div style={CARD}>
        {rows === null && <div style={{ ...KEY_TX }}>LOADING…</div>}
        {rows?.length === 0 && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
            No login found. Run <span style={{ color: "var(--tx)" }}>claude /login</span> in a
            terminal.
          </div>
        )}
        {rows?.map((a) => (
          <div key={a.slot} style={{ ...KV, marginTop: a.slot === rows[0].slot ? 0 : 10 }}>
            <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...KEY_TX, color: "var(--acc)", flex: "none" }}>A{a.slot}</span>
              <span
                style={{
                  fontSize: "var(--t11)",
                  color: a.disabled ? "var(--txd)" : "var(--tx)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {a.email ?? "unknown"}
              </span>
              {a.default && <span style={{ ...CAPTION, width: "auto" }}>DEFAULT</span>}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
              <span
                style={{
                  fontSize: "var(--t105)",
                  color: a.left === null ? "var(--txd)" : a.left <= 1 ? "var(--warn)" : "var(--ok)",
                }}
              >
                {a.left === null ? "—" : `${a.left}% LEFT`}
              </span>
              {!a.default && (
                <>
                  <MiniBtn disabled={busy} onClick={() => void act(a.disabled ? "enable" : "disable", a.slot)}>
                    {a.disabled ? "ENABLE" : "DISABLE"}
                  </MiniBtn>
                  <MiniBtn disabled={busy} danger onClick={() => void act("remove", a.slot)}>
                    REMOVE
                  </MiniBtn>
                </>
              )}
            </span>
          </div>
        ))}
        {login ? (
          <LoginFlow
            url={login.url}
            onDone={async () => {
              setLogin(null);
              await load();
            }}
            onSubmit={(code) => api.loginSubmit(login.slot, code)}
            onCancel={async () => {
              await api.loginCancel(login.slot).catch(() => {});
              setLogin(null);
              await load();
            }}
          />
        ) : (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <MiniBtn disabled={busy} onClick={() => void startLogin()}>
              + ADD ANOTHER ACCOUNT
            </MiniBtn>
            <MiniBtn disabled={busy} onClick={() => void act("add")}>
              COPY CURRENT LOGIN
            </MiniBtn>
            {err && <span style={{ fontSize: "var(--t10)", color: "var(--warn)" }}>{err}</span>}
          </div>
        )}
      </div>
      <div style={NOTE}>
        ADD ANOTHER ACCOUNT signs in right here: a link opens, you log in as the other account, and
        you paste the code back. Your current login is never touched — the new one gets its own
        profile. COPY CURRENT LOGIN is the old way in: it snapshots whoever is logged in at{" "}
        <span style={{ color: "var(--txd)" }}>~/.claude</span> right now, which only helps if you
        already switched accounts in a terminal. Accounts share transcripts and skills; only the
        credentials differ.
      </div>

      <Label>FREE AGENTS</Label>
      <div style={CARD}>
        {!free.installed && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)", marginBottom: 13 }}>
            <span style={{ color: "var(--warn)" }}>opencode is not installed</span> — the rungs below
            stay unusable until it is. Install it with{" "}
            <code style={CODE}>curl -fsSL https://opencode.ai/install | bash</code>
          </div>
        )}
        {free.providers.map((p, i) => (
          <FreeAgentRow
            key={p.provider}
            p={p}
            first={i === 0}
            installed={free.installed}
            onSave={(v) => api.setFreeAgent(p.env, v).then((r) => setFree(r.free_agents))}
          />
        ))}
      </div>
      <div style={NOTE}>
        A free agent takes the turn when every Claude account is spent — a different provider on a
        fresh session, briefed with the task so far. Keys are saved to{" "}
        <span style={{ color: "var(--txd)" }}>~/.mystical/freeagents.json</span> and take effect on
        the next handover; no restart. A key already in the bridge's environment wins and shows as
        FROM ENV.
      </div>
    </>
  );
}

const CODE: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: "var(--t95)",
  color: "var(--tx)",
  background: "var(--panel3)",
  padding: "1px 5px",
};

const FIELD: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--panel3)",
  border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
  outline: "none",
  color: "var(--txb)",
  fontFamily: "inherit",
  fontSize: "var(--t11)",
  padding: "6px 8px",
};

/** The paste-the-code half of a sign-in: the link is already open in a tab. */
function LoginFlow({
  url,
  onSubmit,
  onDone,
  onCancel,
}: {
  url: string;
  onSubmit: (code: string) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(code.trim());
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 13, borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", paddingTop: 12 }}>
      <div style={{ fontSize: "var(--t105)", color: "var(--txl)", lineHeight: 1.7 }}>
        1 · Sign in as the account you want to add —{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acc)" }}>
          open the sign-in page
        </a>
        <br />2 · Paste the code it gives you back:
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          value={code}
          autoFocus
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="paste the code here"
          style={err ? { ...FIELD, border: "1px solid var(--err)" } : FIELD}
        />
        <MiniBtn disabled={busy} onClick={() => void submit()}>
          {busy ? "…" : "CONNECT"}
        </MiniBtn>
        <MiniBtn disabled={busy} danger onClick={onCancel}>
          CANCEL
        </MiniBtn>
      </div>
      {err && <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

/** One free-agent rung with the box that configures it. */
function FreeAgentRow({
  p,
  first,
  installed,
  onSave,
}: {
  p: FreeAgentInfo;
  first: boolean;
  installed: boolean;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(p.needs === "model" ? p.model : "");
  const [busy, setBusy] = useState(false);

  async function save(v: string) {
    setBusy(true);
    await onSave(v).catch(() => {});
    setBusy(false);
    setOpen(false);
    setValue("");
  }

  const state = p.ready ? "READY" : p.configured ? "NEEDS OPENCODE" : "NOT SET";
  return (
    <div style={{ marginTop: first ? 0 : 13 }}>
      <div style={KV}>
        <span style={{ fontSize: "var(--t11)", color: p.ready ? "var(--tx)" : "var(--txl)" }}>{p.label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          <span style={{ fontSize: "var(--t10)", color: p.ready ? "var(--ok)" : "var(--txd)" }}>
            {p.source === "env" ? "FROM ENV" : state}
          </span>
          {p.source !== "env" && (
            <MiniBtn disabled={busy} onClick={() => setOpen(!open)}>
              {p.configured ? "CHANGE" : "SET UP"}
            </MiniBtn>
          )}
          {p.source === "saved" && (
            <MiniBtn disabled={busy} danger onClick={() => void save("")}>
              CLEAR
            </MiniBtn>
          )}
        </span>
      </div>
      {open && (
        <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
          <input
            value={value}
            autoFocus
            type={p.needs === "key" ? "password" : "text"}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && void save(value.trim())}
            placeholder={p.needs === "key" ? `${p.env} — paste the API key` : "model name, e.g. qwen2.5-coder"}
            style={FIELD}
          />
          <MiniBtn disabled={busy || !value.trim()} onClick={() => void save(value.trim())}>
            {busy ? "…" : "SAVE"}
          </MiniBtn>
        </div>
      )}
      {!open && p.ready && (
        <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 4 }}>{p.model}</div>
      )}
    </div>
  );
}

function MiniBtn({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none",
        cursor: disabled ? "default" : "pointer",
        border: `1px solid color-mix(in srgb, ${danger ? "var(--warn)" : "var(--acc)"} 24%, transparent)`,
        background: hov && !disabled ? `color-mix(in srgb, ${danger ? "var(--warn)" : "var(--acc)"} 10%, transparent)` : "transparent",
        color: disabled ? "var(--txd)" : danger ? "var(--warn)" : "var(--tx)",
        fontFamily: "inherit",
        fontSize: "var(--t95)",
        letterSpacing: 1,
        padding: "4px 9px",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** Named snapshots of the run knobs plus the open session's tool switches.
 *  SAVE captures whatever is set right now; APPLY writes it all back. */
function ProfilesPanel({
  settings,
  sessionTools,
  onPatch,
  onSessionTools,
}: {
  settings: HudSettings;
  sessionTools: string[];
  onPatch: (patch: Partial<HudSettings>) => void;
  onSessionTools: (rules: string[]) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
  const [name, setName] = useState("");

  const write = (next: Profile[]) => {
    setProfiles(next);
    saveProfiles(next);
  };

  const save = () => {
    const n = name.trim().slice(0, 32);
    if (!n) return;
    const p: Profile = {
      id: `${Date.now().toString(36)}`,
      name: n,
      model: settings.model,
      effort: settings.effort,
      perm: settings.perm,
      ponytail: settings.ponytail,
      agent: settings.agent,
      disabledTools: sessionTools,
    };
    // Same name = replace, so re-saving after a tweak doesn't grow a pile of
    // near-identical profiles.
    write([...profiles.filter((x) => x.name !== n), p]);
    setName("");
  };

  const apply = (p: Profile) => {
    onPatch({ model: p.model, effort: p.effort, perm: p.perm,
              ponytail: p.ponytail, agent: p.agent });
    onSessionTools(p.disabledTools);
  };

  const btn = (accent: string): CSSProperties => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t85)",
    letterSpacing: 1, padding: "5px 10px", flex: "none",
    border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
    background: "transparent", color: accent,
  });

  return (
    <>
      <div style={CARD}>
        {profiles.length === 0 && (
          <div style={{ fontSize: "var(--t10)", color: "var(--txd)" }}>
            No profiles yet — set the knobs above and this session&apos;s tools, then save them under a name.
          </div>
        )}
        {profiles.map((p, i) => (
          <div key={p.id}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: i ? "1px solid color-mix(in srgb, var(--acc) 8%, transparent)" : undefined }}>
            <span style={{ fontSize: "var(--t12)", color: "var(--txb)", flex: "none" }}>{p.name}</span>
            <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txd)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {describe(p)}
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={() => apply(p)} style={btn("var(--ok)")}>APPLY</button>
            <button onClick={() => write(profiles.filter((x) => x.id !== p.id))}
              style={btn("var(--err)")} title="delete profile">✕</button>
          </div>
        ))}
        <div style={{ ...ROW, marginTop: profiles.length ? 12 : 11 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="name this setup"
            style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t11)", padding: "6px 9px" }}
          />
          <button onClick={save} style={btn("var(--acc)")}>SAVE CURRENT</button>
        </div>
      </div>
      <div style={NOTE}>
        A profile carries the four knobs above, the runtime, and the tools this session has
        switched off. APPLY writes all of them — the knobs globally, the tools onto the open
        session.
      </div>
    </>
  );
}

export function SettingsModal(props: SettingsModalProps) {
  const {
    host,
    port,
    settings,
    onTheme,
    onToggle,
    onPatch,
    models,
    weather,
    onSetCity,
    onSetUnit,
    station,
    onStation,
    onFeed,
    onReplayBoot,
    onClose,
    sessionTools,
    onSessionTools,
    onOpenInspector,
  } = props;

  const [tab, setTab] = useState<Tab>("appearance");
  const autoBase = autoBaseFont(window.innerWidth, window.innerHeight);
  const [escHover, setEscHover] = useState(false);
  const [replayHover, setReplayHover] = useState(false);
  const [doneHover, setDoneHover] = useState(false);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--panel3) 72%, transparent)",
        zIndex: 93,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "7vh",
        animation: "backdropIn .22s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{
          width: 720,
          maxWidth: "94vw",
          height: "76vh",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
          boxShadow: "0 0 70px var(--shadow-modal),0 0 30px color-mix(in srgb, var(--acc) 8%, transparent)",
          animation: "modalIn .46s cubic-bezier(.16,.84,.3,1) both",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "14px 18px",
            borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
            flex: "none",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="var(--acc)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: "none" }}
          >
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3.3v2.4M12 18.3v2.4M20.7 12h-2.4M5.7 12H3.3M18.16 5.84l-1.7 1.7M7.54 16.46l-1.7 1.7M18.16 18.16l-1.7-1.7M7.54 7.54l-1.7-1.7" />
          </svg>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 2.5, color: "var(--txl)" }}>
            CONFIGURE
          </span>
          <span
            style={{ fontSize: "var(--t15)", color: "var(--txb)", letterSpacing: ".5px" }}
            className="glow"
          >
            DASHBOARD SETTINGS
          </span>
          <span style={{ flex: 1 }}></span>
          <button
            onClick={onClose}
            onMouseEnter={() => setEscHover(true)}
            onMouseLeave={() => setEscHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
              background: escHover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
              color: "var(--txm)",
              fontFamily: "inherit",
              fontSize: "var(--t95)",
              letterSpacing: 1.5,
              padding: "4px 10px",
            }}
          >
            ESC ✕
          </button>
        </div>

        {/* Category rail + the active category's panel. Both the rail's own
            layout and its selected-tab marker live in index.css, which is what
            lets it turn from a side rail into a top strip on a phone. */}
        <div className="setbody">
          <div className="setrail">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={tab === t.key ? "on" : undefined}
                aria-current={tab === t.key ? "page" : undefined}
                onClick={() => setTab(t.key)}
              >
                <div style={{ fontSize: "var(--t10)", letterSpacing: 1.5 }}>{t.label}</div>
                <div className="hint"
                  style={{ fontSize: "var(--t85)", letterSpacing: 0.3, color: "var(--txl)", marginTop: 2 }}>
                  {t.hint}
                </div>
              </button>
            ))}
          </div>

          <div className="mscroll" style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 18 }}>
            {tab === "appearance" && (
              <>
                <Label>THEME · DARK</Label>
                <ThemeCardGrid cards={DARK_CARDS} settings={settings} onTheme={onTheme} />
                <Label top>THEME · LIGHT</Label>
                <ThemeCardGrid cards={LIGHT_CARDS} settings={settings} onTheme={onTheme} />

                {themeHasCrt(settings.theme) && (
                  <>
                    <Label top>CRT EFFECTS</Label>
                    <CrtToggles settings={settings} onToggle={onToggle} />
                    <div style={NOTE}>
                      Kept when you recolour AURORA; reset when you switch profile. The paper
                      and daylight themes have no CRT layer at all.
                    </div>
                  </>
                )}

                <Label top>FONT</Label>
                <Segmented
                  options={FONT_OPTS}
                  value={settings.font}
                  onPick={(v) => onPatch({ font: v })}
                />
                <div style={NOTE}>
                  A theme is a palette; the type voice is yours.{" "}
                  <span style={{ color: "var(--txd)" }}>THEME</span> follows whichever one the
                  palette brought — anything else stays put when you switch palettes. Code and
                  logs keep their monospace either way.
                </div>

                <Label top>BASE FONT SIZE</Label>
                <Segmented
                  options={BASE_FONT_OPTS}
                  value={String(settings.baseFont)}
                  onPick={(v) => onPatch({ baseFont: Number(v) })}
                />
                <div style={NOTE}>
                  Every size in the HUD is derived from this one — captions, body and headings
                  move together, spacing stays put.{" "}
                  <span style={{ color: "var(--txd)" }}>AUTO</span> tracks the window: {autoBase}px
                  on this one.
                </div>

                <Label top>BOOT SEQUENCE</Label>
                <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: "var(--t95)", color: "var(--txl)" }}>
                    Replay the intro this dashboard boots with.
                  </div>
                  <button
                    onClick={onReplayBoot}
                    onMouseEnter={() => setReplayHover(true)}
                    onMouseLeave={() => setReplayHover(false)}
                    style={{
                      appearance: "none",
                      cursor: "pointer",
                      border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
                      background: replayHover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
                      color: "var(--tx)",
                      fontFamily: "inherit",
                      fontSize: "var(--t10)",
                      letterSpacing: 1.5,
                      padding: "8px 13px",
                      flex: "none",
                    }}
                  >
                    ▸ REPLAY
                  </button>
                </div>
              </>
            )}

            {tab === "indicator" && (
              <>
                <Label>WORKING INDICATOR</Label>
                <IndicatorPicker settings={settings} onPatch={onPatch} />
              </>
            )}

            {tab === "ambient" && (
              <>
                <Label>WEATHER · header clock</Label>
                <WeatherCard weather={weather} onSetCity={onSetCity} onSetUnit={onSetUnit} />

                <Label top>CLAUDE·FM</Label>
                <div style={CARD}>
                  <div style={{ ...LINE, marginTop: 0 }}>
                    <Cell label="STATION" grow="1 1 220px">
                      <select
                        value={station}
                        onChange={(e) => onStation(Number(e.target.value))}
                        style={{ ...field, width: "100%" }}
                      >
                        {RADIO_STATIONS.map((s, i) => (
                          <option key={s.title} value={i}>
                            {s.title} — {s.artist}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <Cell label="VOLUME" grow="none">
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 26 }}>
                        <Volume value={settings.radioVolume} onChange={(radioVolume) => onPatch({ radioVolume })} />
                      </div>
                    </Cell>
                  </div>
                </div>
                <div style={NOTE}>
                  Play/pause and skip live on the header pill. Station resets to the first one on
                  reload; volume is remembered.
                </div>
              </>
            )}

            {tab === "session" && (
              <>
                <Label>RUN DEFAULTS</Label>
                <div style={CARD}>
                  <div style={{ ...ROW, marginTop: 0, marginBottom: 6 }}>
                    <span style={KEY_TX}>MODEL</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ ...CAPTION, flex: "none" }}>SHOW ALL</span>
                    <Switch on={settings.allModels} onClick={() => onPatch({ allModels: !settings.allModels })} />
                  </div>
                  <Segmented
                    options={(settings.allModels ? models : latestPerFamily(models, settings.model))
                      .map((m) => ({ label: m.label.toUpperCase(), value: m.id }))}
                    value={settings.model}
                    onPick={(model) => onPatch({ model })}
                  />
                  <div style={LINE}>
                    <PickCell label="MODE" value={settings.perm} options={PERMS} onPick={(perm) => onPatch({ perm })} />
                    <PickCell label="EFFORT" value={settings.effort} options={EFFORTS} onPick={(effort) => onPatch({ effort })} />
                    <PickCell label="PONYTAIL" value={settings.ponytail} options={PONYTAILS} onPick={(ponytail) => onPatch({ ponytail })} />
                  </div>
                </div>
                <div style={NOTE}>
                  The composer&apos;s four dropdowns are these same knobs — set them here and they
                  stick across reloads. MODE ·{" "}
                  <span style={{ color: "var(--txd)" }}>Session</span> keeps whatever mode the
                  session was started with.
                </div>

                <Label top>PROFILES</Label>
                <ProfilesPanel
                  settings={settings}
                  sessionTools={sessionTools}
                  onPatch={onPatch}
                  onSessionTools={onSessionTools}
                />

                <Label top>GUARDRAIL</Label>
                <div style={NOTE}>
                  Kept by the bridge for every surface — turning it off here silences the check
                  in the Mini App too.
                </div>

                <Label top>TAGS</Label>
                <TagsPanel />
                <div style={NOTE}>
                  Tags come from the model when it names a session. Renaming one onto another
                  merges them; every session wearing the old name follows.
                </div>
              </>
            )}

            {tab === "ai" && <AiPanel />}

            {tab === "accounts" && <AccountsPanel />}

            {tab === "system" && (
              <>
                <Label>BRIDGE</Label>
                <div style={CARD}>
                  <div style={KV}>
                    <span style={KEY_TX}>HOST</span>
                    <span style={{ fontSize: "var(--t11)", color: "var(--tx)" }}>{host}</span>
                  </div>
                  <div style={{ ...KV, marginTop: 10 }}>
                    <span style={KEY_TX}>PORT</span>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", color: "var(--tx)" }}>
                      {port}
                    </span>
                  </div>
                </div>

                <Label top>HTTP INSPECTOR</Label>
                <div style={CARD}>
                  <div style={KV}>
                    <div>
                      <div style={KEY_TX}>API TRAFFIC</div>
                      <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 4 }}>
                        Every request a run makes to the Anthropic API — its token accounting,
                        its SSE frames, its timings — through a local pass-through proxy.
                        Off by default: it sits on the critical path of the turns it watches.
                      </div>
                    </div>
                    <button onClick={onOpenInspector}
                      style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "transparent", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none", marginLeft: 12 }}>
                      OPEN
                    </button>
                  </div>
                </div>

                <Label top>NOTIFICATIONS</Label>
                <div style={CARD}>
                  <div style={KV}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={KEY_TX}>DESKTOP</div>
                      <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 4 }}>
                        {pushSupported()
                          ? "An OS notification when a session finishes or needs an answer — only for the ones you're not watching. Telegram still covers you when no dashboard is open."
                          : "This browser has no Notification API — Telegram remains the only push path."}
                      </div>
                    </div>
                    <Switch
                      on={settings.push}
                      onClick={() => {
                        if (settings.push) { onPatch({ push: false }); return; }
                        // Ask only on switch-on; a denial can't be re-asked, so the
                        // switch goes back off rather than sitting on and silent.
                        void requestPush().then((ok) => onPatch({ push: ok }));
                      }}
                    />
                  </div>
                  {/* Sound is its own switch, not a rider on DESKTOP: the failure
                      sound belongs to an in-app toast, which fires whether or not
                      the OS is showing banners. */}
                  <div style={{ ...KV, marginTop: 11 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={KEY_TX}>SOUND</div>
                      <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 4 }}>
                        A sound per event, for when the news lands on a screen you aren&apos;t
                        looking at. One per event per batch, not per session.
                      </div>
                    </div>
                    <Switch
                      on={settings.pushSound}
                      onClick={() => {
                        // Switching it on plays it once — otherwise you find out how
                        // loud it is at the wrong moment.
                        if (!settings.pushSound) chime(settings.pushTone, settings.pushVolume);
                        onPatch({ pushSound: !settings.pushSound });
                      }}
                    />
                  </div>
                  {settings.pushSound && (
                    <>
                      <SoundBoard settings={settings} onPatch={onPatch} />
                      {/* Every change plays itself: picking a notification sound you
                          can't hear until the next notification is guesswork. */}
                      <div style={{ ...ROW, alignItems: "flex-end", flexWrap: "wrap" }}>
                        <Cell label="DEFAULT" grow="2 1 200px">
                          <Segmented
                            options={TONE_OPTS}
                            value={settings.pushTone}
                            onPick={(pushTone) => { onPatch({ pushTone }); chime(pushTone, settings.pushVolume); }}
                          />
                        </Cell>
                        <Cell label="VOLUME" grow="1 1 150px">
                          {/* Preview when the drag ends, not on every step — a chime
                              per pixel of travel is a swarm, not a sample. */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}
                            onPointerUp={() => chime(settings.pushTone, settings.pushVolume)}
                            onKeyUp={() => chime(settings.pushTone, settings.pushVolume)}>
                            <Volume
                              value={settings.pushVolume}
                              onChange={(pushVolume) => onPatch({ pushVolume })}
                            />
                          </div>
                        </Cell>
                      </div>
                      <div style={NOTE}>
                        Pack sounds come from{" "}
                        <a href="https://www.peonping.com/" target="_blank" rel="noreferrer"
                          style={{ color: "var(--acc)" }}>peonping.com</a>
                        {" "}and stream from the pack&apos;s own repo — nothing is installed here.
                        Events left on DEFAULT ring the tone above.
                      </div>
                    </>
                  )}
                </div>

                <Label top>PLATFORM</Label>
                <UpdatePanel onFeed={onFeed} />
                <div style={NOTE}>
                  Updating pulls the bridge&apos;s own checkout, rebuilds this dashboard and
                  restarts the bridge; running turns resume on their own.
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 18px",
            borderTop: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
            flex: "none",
          }}
        >
          <span style={{ fontSize: "var(--t9)", letterSpacing: ".5px", color: "var(--txl)", flex: 1 }}>
            Stored in this browser — except weather and the prompt check, which the bridge keeps
            for every client.
          </span>
          <button
            onClick={onClose}
            onMouseEnter={() => setDoneHover(true)}
            onMouseLeave={() => setDoneHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid var(--acc)",
              background: doneHover
                ? "color-mix(in srgb, var(--acc) 22%, transparent)"
                : "color-mix(in srgb, var(--acc) 12%, transparent)",
              color: "var(--txb)",
              fontFamily: "inherit",
              fontSize: "var(--t10)",
              letterSpacing: 2,
              padding: "9px 22px",
            }}
          >
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}
