import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "out/**", // electron-vite build output
      "coverage/**",
      "node_modules/**",
      "src-tauri/**", // Rust — linted by clippy, not eslint
      "site/**", // the website: its own Next.js lint (`npm run lint` in site/)
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Application source (browser environment).
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // Config files, Electron main/preload, build scripts, and test setup run in Node.
    files: [
      "*.{ts,js,mjs,cjs}",
      "electron/**",
      "src/test/**",
      "build/**",
      "scripts/**",
      ".claude/**", // agent skills' driver scripts
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // CommonJS build scripts (electron-builder hooks): require/module/exports.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
)
