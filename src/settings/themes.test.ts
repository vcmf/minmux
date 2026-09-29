import { describe, it, expect, beforeEach } from "vitest"
import {
  THEME_FAMILIES,
  applyThemeVars,
  resolveScheme,
  resolveTheme,
  themeFamilyName,
  type Theme,
} from "./themes"

const UI_KEYS = [
  "bg",
  "panel",
  "elev",
  "border",
  "border2",
  "text",
  "dim",
  "faint",
  "accent",
  "amber",
  "red",
  "blue",
  "scrim",
  "shadow",
] as const

const variants = (): Theme[] => Object.values(THEME_FAMILIES).flatMap((f) => [f.dark, f.light])

/** WCAG relative-luminance contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(bl!)
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe("theme families", () => {
  it("has the four families, each with a dark and a light variant of the right scheme", () => {
    expect(Object.keys(THEME_FAMILIES)).toEqual(["minimal", "tokyo-night", "catppuccin", "gruvbox"])
    for (const f of Object.values(THEME_FAMILIES)) {
      expect(f.dark.scheme).toBe("dark")
      expect(f.light.scheme).toBe("light")
      expect(f.dark.name).not.toBe(f.light.name)
    }
  })

  it("every variant has a full token set + terminal palette", () => {
    for (const theme of variants()) {
      expect(theme.label).toBeTruthy()
      expect(theme.variant).toBeTruthy()
      const ui = theme.ui as Record<string, string>
      for (const key of UI_KEYS) expect(ui[key], `${theme.name}.${key}`).toMatch(/#|rgb/)
      expect(theme.terminal.background).toBeTruthy()
      expect(theme.terminal.foreground).toBeTruthy()
    }
  })

  it("terminal text is readable on its background (≥ 4.5:1) in every variant", () => {
    for (const t of variants()) {
      const c = contrast(t.terminal.foreground!, t.terminal.background!)
      expect(c, `${t.name} fg/bg ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("light variants keep ANSI black visibly dark (≥ 3:1 on the background)", () => {
    for (const f of Object.values(THEME_FAMILIES)) {
      const t = f.light.terminal
      const c = contrast(t.black!, t.background!)
      expect(c, `${f.light.name} black/bg ${c.toFixed(2)}`).toBeGreaterThanOrEqual(3)
    }
  })

  it("each variant's UI background matches its terminal background (seamless panes)", () => {
    for (const t of variants()) expect(t.ui.bg).toBe(t.terminal.background)
  })
})

describe("resolving the active theme", () => {
  it("themeFamilyName maps legacy names and falls back to the default", () => {
    expect(themeFamilyName("minimal-dark")).toBe("minimal") // pre-families settings
    expect(themeFamilyName("gruvbox")).toBe("gruvbox")
    expect(themeFamilyName("does-not-exist")).toBe("minimal")
  })

  it("resolveScheme: explicit dark/light win; system follows the OS", () => {
    expect(resolveScheme("dark", false)).toBe("dark")
    expect(resolveScheme("light", true)).toBe("light")
    expect(resolveScheme("system", true)).toBe("dark")
    expect(resolveScheme("system", false)).toBe("light")
  })

  it("resolveTheme picks the family's variant for the appearance", () => {
    expect(resolveTheme("catppuccin", "light", true).name).toBe("catppuccin-latte")
    expect(resolveTheme("catppuccin", "dark", false).name).toBe("catppuccin")
    expect(resolveTheme("tokyo-night", "system", false).name).toBe("tokyo-night-day")
    expect(resolveTheme("minimal-dark", "light", true).name).toBe("minimal-light")
  })
})

describe("applying theme tokens", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute("style")
  })

  it("applyThemeVars writes CSS custom properties + color-scheme on :root", () => {
    applyThemeVars(resolveTheme("tokyo-night", "dark", true))
    const root = document.documentElement
    expect(root.style.getPropertyValue("--bg")).toBe("#1a1b26")
    expect(root.style.getPropertyValue("--accent")).toBe("#9ece6a")
    expect(root.style.getPropertyValue("--scrim")).toBeTruthy()
    expect(root.style.colorScheme).toBe("dark")
    expect(root.dataset.scheme).toBe("dark")
  })

  it("caches {vars, scheme} for index.html's pre-paint script", () => {
    applyThemeVars(resolveTheme("gruvbox", "light", true))
    const cached = JSON.parse(localStorage.getItem("minmux:theme-vars")!)
    expect(cached.scheme).toBe("light")
    expect(cached.vars["--bg"]).toBe("#f9f5d7")
    expect(cached.vars["--border2"]).toBeTruthy()
  })

  it("variant names map to their family + scheme", async () => {
    const { variantOf } = await import("./themes")
    expect(variantOf("catppuccin-latte")).toEqual({ family: "catppuccin", scheme: "light" })
    expect(variantOf("gruvbox")).toEqual({ family: "gruvbox", scheme: "dark" })
    expect(variantOf("nope")).toBeNull()
    expect(themeFamilyName("tokyo-night-day")).toBe("tokyo-night")
  })

  it("withAlpha turns a hex colour into rgba (non-hex passes through)", async () => {
    const { withAlpha } = await import("./themes")
    expect(withAlpha("#ff8000", 0.5)).toBe("rgba(255,128,0,0.5)")
    expect(withAlpha("rgba(1,2,3,1)", 0.5)).toBe("rgba(1,2,3,1)")
  })
})
