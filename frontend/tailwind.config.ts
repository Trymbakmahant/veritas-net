import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink:    "#0a0a0a",
        slab:   "#111111",
        line:   "#262626",
        mute:   "#a1a1aa",
        accent: "#f59e0b",
        ok:     "#10b981",
        bad:    "#ef4444",
        warn:   "#f59e0b",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
