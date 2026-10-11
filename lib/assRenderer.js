/**
 * Advanced SubStation Alpha (ASS) output for merged dual subtitles.
 *
 * Why ASS and not styled SRT: Stremio's player pipes addon subtitles through
 * stremio-video's `withHTMLSubtitles`, whose SRT->VTT converter strips every
 * HTML tag before the cue is rendered ("remove all html tags for security
 * reasons" in subtitlesConverter.js). So `<b>`, `<i>` and `<font color>` in an
 * SRT never reach the screen. ASS, by contrast, is handed to a real libass
 * renderer (@stremio/libass-wasm, or mpv's native libass on desktop), which
 * honours per-line font size and colour.
 *
 * Caveat worth remembering: libass only kicks in when the user has enabled
 * Settings -> Player -> "ASS subtitles styling" (it defaults to OFF in
 * stremio-core). With it off, stremio-video runs `ass2webvtt`, which drops the
 * `{...}` override tags and turns `\N` into a newline — so the output degrades
 * to clean two-line plain text rather than breaking.
 *
 * Both languages are emitted as ONE Dialogue event joined by `\N`, with the
 * secondary line prefixed by inline override tags. One event per cue means the
 * line order is fixed, there is a single bottom margin to respect, and no
 * collision/overlap resolution is needed.
 */

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envHex(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(s)) return fallback;
  return s.startsWith('#') ? s : '#' + s;
}

/**
 * Tunable appearance. Sizes live in the script's own coordinate space
 * (PlayResY below), so libass scales them to whatever the real screen is — the
 * result looks the same on a phone and a 4K TV, and identical for movies and
 * episodes. Every value has an env override so appearance can be tuned without
 * touching code or the configure page.
 */
const ASS_STYLE = {
  playResX: 1920,
  playResY: 1080,
  fontName: process.env.DUAL_SUB_FONT || 'Arial',
  mainSize: envNumber('DUAL_SUB_MAIN_SIZE', 54),
  mainColor: envHex('DUAL_SUB_MAIN_COLOR', '#FFFFFF'),
  transSize: envNumber('DUAL_SUB_TRANS_SIZE', 40),
  transColor: envHex('DUAL_SUB_TRANS_COLOR_ASS', '#FFE9A3'),
  outlineColor: envHex('DUAL_SUB_OUTLINE_COLOR', '#101010'),
  outline: envNumber('DUAL_SUB_OUTLINE', 2.6),
  marginV: envNumber('DUAL_SUB_MARGIN_V', 60),
  marginH: envNumber('DUAL_SUB_MARGIN_H', 40)
};

/**
 * `#RRGGBB` -> `&H00BBGGRR`, the 8-digit form used in `[V4+ Styles]` lines.
 * ASS stores colours as little-endian BGR behind an alpha byte (00 = opaque).
 */
function hexToAssColor(hex) {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(String(hex || ''));
  if (!m) return '&H00FFFFFF';
  return ('&H00' + m[3] + m[2] + m[1]).toUpperCase();
}

/**
 * `#RRGGBB` -> `&HBBGGRR&`, the 6-digit form that `\c` / `\1c` override tags
 * take. (Style lines carry an alpha byte; inline colour tags conventionally
 * do not.)
 */
function hexToAssInlineColor(hex) {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(String(hex || ''));
  if (!m) return '&HFFFFFF&';
  return ('&H' + m[3] + m[2] + m[1] + '&').toUpperCase();
}

/** Milliseconds -> `h:mm:ss.cc` (ASS uses centiseconds and a single-digit hour). */
function msToAssTime(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return hours +
    ':' + String(minutes).padStart(2, '0') +
    ':' + String(seconds).padStart(2, '0') +
    '.' + String(centis).padStart(2, '0');
}

/**
 * Make cue text safe to drop into a Dialogue line.
 *
 * Note this is NOT html-encoded: ASS is not HTML, so `&`, `<` and `>` are
 * literal here and `htmlEncodeSrt` must not be applied to ASS text.
 */
function escapeAssText(text) {
  if (!text) return '';
  return String(text)
    // Leftover ASS override blocks, which turn up in source subtitles that
    // were themselves converted from ASS (`{\an8}`, `{\i1}`...). They are junk
    // in either renderer, so drop them outright.
    .replace(/\{\s*\\[^}]*\}/g, '')
    // Any brace still standing is literal text, and it cannot be left alone:
    // `{` opens an override block, so libass would silently eat everything up
    // to the matching `}`. Escaping as `\{` is only half a fix — libass does
    // accept `\{` (ass_parse.c), but Stremio's no-styling fallback converter
    // (`ass2webvtt`) matches /\{[^}]*\}/ and would delete the words between
    // the braces. Parentheses render identically and legibly in BOTH paths,
    // and `(SIGH)` is the SRT convention for this kind of annotation anyway.
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    // Backslashes carry no meaning in dialogue, but a stray one sitting before
    // `N`, `n` or `h` would be read as a control sequence. Dropped after the
    // brace work above, and before the hard breaks are introduced below.
    .replace(/\\/g, '')
    .replace(/\r?\n|\r/g, '\\N')
    .trim();
}

function srtTimeToMs(timeString) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(String(timeString || ''));
  if (!m) return 0;
  return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 +
    parseInt(m[4].padEnd(3, '0'), 10);
}

function cueMs(cue, which) {
  const direct = cue[which + 'Ms'];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  return srtTimeToMs(cue[which + 'Time']);
}

function buildHeader(style) {
  return [
    '[Script Info]',
    '; Generated by stremio-dual-subtitles',
    'ScriptType: v4.00+',
    'PlayResX: ' + style.playResX,
    'PlayResY: ' + style.playResY,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'Collisions: Normal',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 2 = bottom-centre. Combined with WrapStyle 0, a long line that
    // wraps grows the block upward from MarginV, so nothing is clipped off the
    // bottom of the screen.
    'Style: Dual,' + style.fontName + ',' + style.mainSize + ',' +
      hexToAssColor(style.mainColor) + ',' + hexToAssColor(style.mainColor) + ',' +
      hexToAssColor(style.outlineColor) + ',&H80000000,0,0,0,0,100,100,0,0,1,' +
      style.outline + ',0,2,' + style.marginH + ',' + style.marginH + ',' +
      style.marginV + ',1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ].join('\n');
}

/**
 * Render merged cues as a complete ASS file.
 *
 * @param {Array} cues  Output of `mergeSubtitles` — each entry needs `mainText`
 *                      and (optionally) `transText`, plus either `startMs`/`endMs`
 *                      or SRT-formatted `startTime`/`endTime`.
 * @param {Object} [styleOverrides]  Partial `ASS_STYLE` override, for tests.
 * @returns {string|null}
 */
function formatAss(cues, styleOverrides) {
  if (!Array.isArray(cues)) return null;

  const style = styleOverrides ? Object.assign({}, ASS_STYLE, styleOverrides) : ASS_STYLE;
  const transPrefix = '{\\fs' + style.transSize + '\\c' +
    hexToAssInlineColor(style.transColor) + '}';
  const lines = [buildHeader(style)];

  for (const cue of cues) {
    if (!cue) continue;

    const main = escapeAssText(cue.mainText);
    if (!main) continue;

    const start = cueMs(cue, 'start');
    const end = cueMs(cue, 'end');
    if (end <= start) continue;

    const trans = escapeAssText(cue.transText);
    const text = trans ? main + '\\N' + transPrefix + trans : main;
    lines.push(
      'Dialogue: 0,' + msToAssTime(start) + ',' + msToAssTime(end) + ',Dual,,0,0,0,,' + text
    );
  }

  // Header only, no dialogue: the player would reject that, so signal failure
  // the same way `formatSrt` does and let the caller fall back.
  if (lines.length === 1) return null;

  return lines.join('\n') + '\n';
}

module.exports = {
  ASS_STYLE,
  formatAss,
  escapeAssText,
  hexToAssColor,
  hexToAssInlineColor,
  msToAssTime
};
