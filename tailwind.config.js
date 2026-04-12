/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'cs-bg': '#0d1117',
        'cs-surface': '#161b22',
        'cs-border': '#30363d',
        'cs-text': '#c9d1d9',
        'cs-text-muted': '#8b949e',
        'cs-accent': '#58a6ff',
        'cs-accent-hover': '#79b8ff',
        'cs-success': '#3fb950',
        'cs-warning': '#d29922',
        'cs-error': '#f85149',
      },
      fontFamily: {
        mono: ['Cascadia Code', 'Consolas', 'Monaco', 'monospace'],
      }
    },
  },
  plugins: [],
}
