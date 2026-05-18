/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      colors: {
        // Legacy aliases (kept so existing fields still resolve)
        'fs-white':    '#ffffff',
        'fs-surface':  '#f5f1e8',
        'fs-border':   '#e2dccc',
        'fs-dark':     '#0e0e0f',
        'fs-muted':    '#6b675e',
        'fs-blue':     '#0e0e0f',
        'fs-blue-d':   '#0e0e0f',
        'fs-blue-bg':  '#efece1',

        // New brand tokens — warm-ivory athletic palette
        'fc-ink':      '#0e0e0f',
        'fc-ink-soft': '#1a1a1c',
        'fc-paper':    '#f5f1e8',
        'fc-paper-2':  '#efece1',
        'fc-cream':    '#faf8f1',
        'fc-line':     '#e2dccc',
        'fc-muted':    '#6b675e',
        'fc-stone':    '#8e8a80',
        'fc-lime':     '#caf83a',
        'fc-lime-d':   '#a8d52f',
        'fc-rust':     '#ec4d27',
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', '"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        'tight-2': '-0.02em',
        'tight-3': '-0.035em',
        'eyebrow': '0.08em',
      },
      boxShadow: {
        'card':       '0 1px 2px rgba(14,14,15,0.04), 0 1px 3px rgba(14,14,15,0.05)',
        'card-hover': '0 10px 30px -12px rgba(14,14,15,0.20), 0 4px 6px rgba(14,14,15,0.04)',
        'feature':    '0 25px 60px -25px rgba(14,14,15,0.45)',
      },
      typography: ({ theme }) => ({
        gray: {
          css: {
            '--tw-prose-body':     theme('colors.fc-ink'),
            '--tw-prose-headings': theme('colors.fc-ink'),
          },
        },
      }),
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
