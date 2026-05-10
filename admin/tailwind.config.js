/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        paper: "rgb(var(--paper) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        sunken: "rgb(var(--sunken) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        "line-strong": "rgb(var(--line-strong) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        ink2: "rgb(var(--ink2) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        muted2: "rgb(var(--muted2) / <alpha-value>)",
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          strong: "rgb(var(--brand-strong) / <alpha-value>)",
          soft: "rgb(var(--brand-soft) / <alpha-value>)",
        },
        up: {
          DEFAULT: "rgb(var(--up) / <alpha-value>)",
          strong: "rgb(var(--up-strong) / <alpha-value>)",
          soft: "rgb(var(--up-soft) / <alpha-value>)",
        },
        down: {
          DEFAULT: "rgb(var(--down) / <alpha-value>)",
          strong: "rgb(var(--down-strong) / <alpha-value>)",
          soft: "rgb(var(--down-soft) / <alpha-value>)",
        },
        warn: {
          DEFAULT: "rgb(var(--warn) / <alpha-value>)",
          soft: "rgb(var(--warn-soft) / <alpha-value>)",
        },
        asset: {
          btc: "rgb(var(--asset-btc) / <alpha-value>)",
          eth: "rgb(var(--asset-eth) / <alpha-value>)",
          sol: "rgb(var(--asset-sol) / <alpha-value>)",
          avax: "rgb(var(--asset-avax) / <alpha-value>)",
          link: "rgb(var(--asset-link) / <alpha-value>)",
          doge: "rgb(var(--asset-doge) / <alpha-value>)",
          matic: "rgb(var(--asset-matic) / <alpha-value>)",
          xrp: "rgb(var(--asset-xrp) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: [
          "Geist",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "Geist Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      letterSpacing: {
        widest: "0.18em",
      },
      borderRadius: {
        DEFAULT: "0.375rem",
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 1px 0 rgb(0 0 0 / 0.02)",
      },
    },
  },
  plugins: [],
};
