import { Check, CircleHalf, Moon, Sun } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { useStore } from "../store"
import { THEME_FAMILIES, resolveScheme, type Appearance, type Theme } from "../settings/themes"

const APPEARANCES: { value: Appearance; label: string; icon: ReactNode }[] = [
  { value: "dark", label: "Dark", icon: <Moon size={13} weight="fill" /> },
  { value: "light", label: "Light", icon: <Sun size={13} weight="fill" /> },
  { value: "system", label: "System", icon: <CircleHalf size={13} weight="fill" /> },
]

const ANSI = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const

/** Appearance (dark / light / system) + a grid of theme cards previewing each family. */
export function ThemePicker() {
  const settings = useStore((s) => s.settings)
  const systemDark = useStore((s) => s.systemDark)
  const scheme = resolveScheme(settings.appearance, systemDark)

  return (
    <div className="theme-picker">
      <div className="segmented" role="radiogroup" aria-label="Appearance">
        {APPEARANCES.map((a) => (
          <button
            key={a.value}
            role="radio"
            aria-checked={settings.appearance === a.value}
            className={`segmented-item${settings.appearance === a.value ? " on" : ""}`}
            onClick={() => useStore.getState().updateSettings({ ...settings, appearance: a.value })}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>

      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {Object.values(THEME_FAMILIES).map((family) => {
          const selected = settings.theme === family.name
          const variant = family[scheme]
          return (
            <button
              key={family.name}
              role="radio"
              aria-checked={selected}
              aria-label={family.label}
              className={`theme-card${selected ? " selected" : ""}`}
              onClick={() =>
                useStore.getState().updateSettings({ ...settings, theme: family.name })
              }
            >
              <ThemePreview theme={variant} />
              <span className="theme-card-label">
                <span className="theme-card-name">{family.label}</span>
                <span className="theme-card-variant">{variant.variant}</span>
                {selected && <Check size={13} weight="bold" className="theme-card-check" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A miniature minmux window drawn in `theme`'s own colours (inline — not the live CSS vars). */
function ThemePreview({ theme }: { theme: Theme }) {
  const t = theme.terminal
  return (
    <span
      className="theme-preview"
      aria-hidden="true"
      style={{ background: t.background, borderColor: theme.ui.border2 }}
    >
      <span className="tp-bar" style={{ background: theme.ui.panel }}>
        <span className="tp-tab" style={{ background: theme.ui.elev, color: theme.ui.text }}>
          <span className="tp-dot" style={{ background: theme.ui.accent }} />
          zsh
        </span>
      </span>
      <span className="tp-body" style={{ color: t.foreground }}>
        <span>
          <span style={{ color: t.green }}>~/proj</span> <span style={{ color: t.blue }}>main</span>{" "}
          <span style={{ color: t.brightBlack }}>%</span> git status
        </span>
        <span>
          <span style={{ color: t.red }}>M</span> src/app.tsx
        </span>
        <span className="tp-swatches">
          {ANSI.map((c) => (
            <span key={c} className="tp-swatch" style={{ background: t[c] }} />
          ))}
        </span>
      </span>
    </span>
  )
}
