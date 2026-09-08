/**
 * Unit tests for the fullscreen tune mask (lib/tune-screen.ts).
 *
 * Everything is exercised through the pure state machine (applyKey) and the
 * theme-free renderer — no TUI involved. Raw-key normalization is checked
 * with a literal matches shim; the real adapter passes pi-tui's matchesKey.
 */
import {
  TUNE_FIELDS,
  createTuneState,
  applyKey,
  applyRawKey,
  renderTuneScreen,
  validateTuneEntry,
  getByPath,
  setByPath,
  createTuneScreen,
  PLAIN_STYLE,
  type TuneScreenState,
} from "../lib/tune-screen.js";
import { tuneThemeStyle } from "../lib/admin.js";

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

const META = { id: "Qwen3.8-27B-GGUF", tier: "user tier", loaded: true, ctxWindow: 262144, tags: ["reasoning"] };
const idx = (path: string) => TUNE_FIELDS.findIndex((f) => f.path === path);

// ─── Path access ────────────────────────────────────────────────────────────

{
  const e: Record<string, unknown> = {};
  setByPath(e, "budgets.medium", 8192);
  check("setByPath: creates nested", e.budgets && (e.budgets as Record<string, unknown>).medium === 8192, e);
  setByPath(e, "budgets.medium", undefined);
  check("setByPath: deletes + prunes empty parent", e.budgets === undefined, e);
  setByPath(e, "thinking.top_p", 0.9);
  check("getByPath: nested read", getByPath(e, "thinking.top_p") === 0.9, e);
  check("getByPath: missing → undefined", getByPath(e, "vision") === undefined);
}

// ─── Navigation ─────────────────────────────────────────────────────────────

{
  const s = createTuneState({});
  check("nav: starts at field 0", s.cursor === 0);
  applyKey(s, "down");
  check("nav: down advances", s.cursor === 1);
  s.cursor = TUNE_FIELDS.length - 1;
  applyKey(s, "down");
  check("nav: down wraps to 0", s.cursor === 0);
  applyKey(s, "shift+tab");
  check("nav: shift+tab wraps to last", s.cursor === TUNE_FIELDS.length - 1);
  applyKey(s, "up");
  check("nav: up goes back", s.cursor === TUNE_FIELDS.length - 2);
}

// ─── Bool toggle ────────────────────────────────────────────────────────────

{
  const s = createTuneState({ reasoning: false });
  applyKey(s, "right");
  check("bool: right toggles false→true", s.entry.reasoning === true);
  applyKey(s, "left");
  check("bool: left toggles true→false", s.entry.reasoning === false);
  applyKey(s, "enter");
  check("bool: enter toggles", s.entry.reasoning === true);
  check("bool: toggle marks dirty", s.dirty === true);
}

// ─── Number inline edit ─────────────────────────────────────────────────────

{
  const s = createTuneState({ thinking: { top_p: 0.9 } });
  s.cursor = idx("thinking.top_p");
  applyKey(s, "enter");
  check("edit: enter opens editor with current value", s.editing && s.buffer === "0.9", s.buffer);
  // Type a replacement: clear then enter 0.5
  for (let i = 0, n = s.buffer.length; i < n; i++) applyKey(s, "backspace");
  for (const c of "0.5") applyKey(s, c);
  applyKey(s, "enter");
  check("edit: commit valid value", s.editing === false && getByPath(s.entry, "thinking.top_p") === 0.5, s.entry);
  check("edit: commit clears notice + dirty", s.notice === undefined && s.dirty === true);
}

{
  const s = createTuneState({});
  s.cursor = idx("thinking.top_p");
  applyKey(s, "enter");
  for (const c of "5") applyKey(s, c);
  applyKey(s, "enter");
  check("edit: invalid value stays open + notice", s.editing === true && (s.notice ?? "").includes("top_p"), s.notice);
  // Fix it
  for (let i = 0, n = s.buffer.length; i < n; i++) applyKey(s, "backspace");
  for (const c of "1") applyKey(s, c);
  applyKey(s, "enter");
  check("edit: fixed value commits", s.editing === false && getByPath(s.entry, "thinking.top_p") === 1);
}

{
  const s = createTuneState({});
  s.cursor = idx("noThinkSuffix");
  applyKey(s, "enter");
  for (const c of "/no_think") applyKey(s, c);
  applyKey(s, "enter");
  check("string: commit", getByPath(s.entry, "noThinkSuffix") === "/no_think");
  s.cursor = idx("noThinkSuffix");
  applyKey(s, "enter");
  for (let i = 0, n = s.buffer.length; i < n; i++) applyKey(s, "backspace");
  applyKey(s, "enter");
  check("string: empty commit deletes field", getByPath(s.entry, "noThinkSuffix") === undefined);
}

// ─── Nudge (←/→ on numbers) ─────────────────────────────────────────────────

{
  const s = createTuneState({ thinking: { top_p: 0.9 } });
  s.cursor = idx("thinking.top_p");
  applyKey(s, "right");
  check("nudge: right adds step", getByPath(s.entry, "thinking.top_p") === 0.95, s.entry);
  applyKey(s, "right");
  check("nudge: clamps at max (1)", getByPath(s.entry, "thinking.top_p") === 1, s.entry);
  applyKey(s, "left");
  check("nudge: left subtracts step", getByPath(s.entry, "thinking.top_p") === 0.95);

  const s2 = createTuneState({});
  s2.cursor = idx("maxTokens");
  applyKey(s2, "right");
  check("nudge: undefined number starts at min", getByPath(s2.entry, "maxTokens") === 1024, s2.entry);
  applyKey(s2, "right");
  check("nudge: maxTokens step 1024", getByPath(s2.entry, "maxTokens") === 2048);
}

// ─── Budgets cross-validation ───────────────────────────────────────────────

{
  const s = createTuneState({
    maxTokens: 16384,
    budgets: { minimal: 4096, medium: 8192 },
  });
  check("budgets: valid entry passes", validateTuneEntry(s.entry) === undefined);
  s.cursor = idx("budgets.medium");
  applyKey(s, "enter");
  for (let i = 0, n = s.buffer.length; i < n; i++) applyKey(s, "backspace");
  for (const c of "2048") applyKey(s, c);
  applyKey(s, "enter");
  check("budgets: commit non-monotonic → notice", (s.notice ?? "").includes("not monotonic"), s.notice);
  check("save gated: invalid entry refuses 's'", applyKey(s, "s") === "render");
}

{
  const s = createTuneState({
    maxTokens: 4096,
    budgets: { high: 16384 },
  });
  check("budgets: exceeds maxTokens−1024 → invalid", (validateTuneEntry(s.entry) ?? "").includes("exceeds"), s.entry);
}

// ─── Save / cancel gate ─────────────────────────────────────────────────────

{
  const s = createTuneState({ reasoning: true });
  applyKey(s, "s");
  check("save: valid entry returns save", applyKey(s, "s") === "save");
  check("cancel: q returns cancel", applyKey(s, "q") === "cancel");
  check("cancel: escape returns cancel", applyKey(s, "escape") === "cancel");
}

// ─── Raw-key normalization ──────────────────────────────────────────────────

{
  const literal = (d: string, k: string) => d === k;
  const s = createTuneState({});
  const ev = applyRawKey(s, "down", literal);
  check("raw: literal passthrough works", ev === "render" && s.cursor === 1);
  // Simulate real terminal sequences with a sequence-aware shim.
  const seq = (d: string, k: string) => {
    const map: Record<string, string> = {
      "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
      "\t": "tab", "\r": "enter", "\x1b[Z": "shift+tab", "\x7f": "backspace", "\x1b": "escape",
    };
    return (map[d] ?? d) === k;
  };
  const s2 = createTuneState({ reasoning: false });
  applyRawKey(s2, "\x1b[C", seq);
  check("raw: escape-sequence right toggles bool", s2.entry.reasoning === true);
  applyRawKey(s2, "\t", seq);
  check("raw: tab moves down", s2.cursor === 1);
}

// ─── Renderer ───────────────────────────────────────────────────────────────

{
  const s = createTuneState({ reasoning: true, maxTokens: 16384, noThinkSuffix: "/no_think" });
  const lines = renderTuneScreen(s, 100, META, PLAIN_STYLE);
  const text = lines.join("\n");
  check("render: header has id + tier + loaded + ctx", text.includes("Qwen3.8-27B-GGUF") && text.includes("[user tier]") && text.includes("● loaded") && text.includes("ctx 262144"), lines[0]);
  check("render: group headers present", text.includes("capabilities") && text.includes("budgets") && text.includes("thinking") && text.includes("nonThinking"), lines);
  check("render: cursor marker on field 0", lines.some((l) => l.startsWith("> ")), lines.slice(0, 3));
  check("render: values shown at a glance", text.includes("true") && text.includes("16384") && text.includes('"\/no_think"'), text);
  check("render: legend at bottom", lines[lines.length - 1].includes("↑↓/tab move") && lines[lines.length - 1].includes("s save"), lines[lines.length - 1]);
  check("render: status line above legend", lines[lines.length - 2].includes("s to save"), lines[lines.length - 2]);

  // Width contract: every line ≤ width (even tiny).
  const tiny = renderTuneScreen(s, 20, META, PLAIN_STYLE);
  check("render: every line ≤ width", tiny.every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length <= 20), tiny.map((l) => l.length));

  // Editing render shows buffer + fake cursor.
  s.cursor = idx("maxTokens");
  s.editing = true;
  s.buffer = "16384";
  const editLines = renderTuneScreen(s, 100, META, PLAIN_STYLE);
  check("render: edit buffer with cursor", editLines.some((l) => l.includes("|16384▌")), editLines);

  // Notice render.
  s.editing = false;
  s.buffer = "";
  s.notice = "budgets: not monotonic";
  const warnLines = renderTuneScreen(s, 100, META, PLAIN_STYLE);
  check("render: notice in status line", warnLines[warnLines.length - 2].includes("⚠") && warnLines[warnLines.length - 2].includes("not monotonic"), warnLines[warnLines.length - 2]);
}

// ─── Adapter (fake tui + callbacks) ─────────────────────────────────────────

{
  const entry = { reasoning: true };
  const events: string[] = [];
  const commits: Record<string, unknown>[] = [];
  const screen = createTuneScreen({
    entry,
    meta: META,
    tui: { requestRender: () => events.push("render") },
    callbacks: {
      onCommit: (e) => { commits.push(e); return "ok"; },
      onClose: (committed) => events.push(committed ? "closed-saved" : "closed-cancel"),
    },
  });
  screen.handleInput("s");
  check("adapter: valid save commits + closes once", commits.length === 1 && events.includes("closed-saved"), { events, commits });
  screen.handleInput("q");
  check("adapter: input after close is ignored", events.filter((e) => e.startsWith("closed")).length === 1, events);

  // onCommit error keeps the screen open.
  const events2: string[] = [];
  const screen2 = createTuneScreen({
    entry: { reasoning: true },
    meta: META,
    tui: { requestRender: () => events2.push("render") },
    callbacks: {
      onCommit: () => "corrupt file",
      onClose: () => events2.push("closed"),
    },
  });
  screen2.handleInput("s");
  check("adapter: failed commit stays open + shows error", !events2.includes("closed"), events2);
  const lines = screen2.render(100);
  check("adapter: error visible in status", lines.some((l) => l.includes("corrupt file")), lines.slice(-2));
  screen2.handleInput("q");
  check("adapter: then cancel closes", events2.includes("closed"), events2);

  // Original entry object is not mutated (structuredClone).
  check("adapter: caller entry untouched", JSON.stringify(entry) === JSON.stringify({ reasoning: true }), entry);
}

// ─── Theme wiring regression (admin.tuneThemeStyle) ───────────────────────────
// pi passes a Theme whose `fg` is a PROTOTYPE method reading `this.fgColors`.
// Detaching it (const fg = theme.fg) makes `this` undefined at render time and
// crashed the TUI: "Cannot read properties of undefined (reading 'fgColors')".
// Arrow-function stubs in tests never catch this, so mimic the real shape.
{
  class FakePiTheme {
    fgColors: Map<string, string> = new Map([ ["accent", "\u001b[38;5;39m"], ["dim", "\u001b[2m"], ["success", "\u001b[32m"], ["warning", "\u001b[33m"] ]);
    fg(color: string, text: string): string {
      const ansi = this.fgColors.get(color);
      if (!ansi) throw new Error(`Unknown theme color: ${color}`);
      return `${ansi}${text}\u001b[39m`;
    }
  }
  const style = tuneThemeStyle(new FakePiTheme());
  const t = style.title("Tune Qwen");
  check("theme: prototype-method fg stays this-bound at render", t.includes("Tune Qwen") && t.includes("\u001b[38;5;39m"), t);
  check("theme: dim/ok/warn all render", style.dim("d").includes("d") && style.ok("o").includes("o") && style.warn("w").includes("w"));
  check("theme: undefined theme degrades to plain text", tuneThemeStyle(undefined).title("x") === "x");
}

console.log(fail === 0 ? "\nAll tune-screen tests passed." : `\n${fail} test(s) FAILED`);
if (fail > 0) process.exit(1);
