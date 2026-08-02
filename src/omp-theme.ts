import type { Theme } from "./omp-api.js";
import type { MarkdownTheme, SelectListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";

/**
 * Build TUI themes from the Theme instance supplied by ExtensionUIContext.
 *
 * OMP plugins can be linked with their own SDK dependency tree. Calling the
 * SDK's global get*Theme() helpers from that second module instance observes an
 * uninitialized theme singleton, while the Theme passed into ui.custom() is
 * always the active host theme.
 */
export function createSymbolTheme(theme: Theme): SymbolTheme {
  return {
    cursor: theme.nav.cursor,
    inputCursor: theme.getSymbolPreset() === "ascii" ? "|" : "▏",
    boxRound: theme.boxRound,
    boxSharp: theme.boxSharp,
    table: theme.boxSharp,
    quoteBorder: theme.md.quoteBorder,
    hrChar: theme.md.hrChar,
    colorSwatch: theme.md.colorSwatch,
    spinnerFrames: theme.getSpinnerFrames("activity"),
  };
}

export function createMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
    highlightCode: (code) => code.split("\n").map((line) => theme.fg("mdCodeBlock", line)),
    symbols: createSymbolTheme(theme),
  };
}

export function createSelectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text),
    symbols: createSymbolTheme(theme),
    hovered: (text) => theme.bg("selectedBg", text),
  };
}
