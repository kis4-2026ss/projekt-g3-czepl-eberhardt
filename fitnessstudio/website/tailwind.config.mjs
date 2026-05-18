/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      colors: {
        'fs-white':    '#ffffff',
        'fs-surface':  '#f5f5f7',
        'fs-border':   '#e5e7eb',
        'fs-dark':     '#111827',
        'fs-muted':    '#6b7280',
        'fs-blue':     '#2563eb',
        'fs-blue-d':   '#1d4ed8',
        'fs-blue-bg':  '#eff6ff',
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        sans:    ['Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        'tight-2': '-0.02em',
        'eyebrow': '0.08em',
      },
      boxShadow: {
        'card':       '0 1px 2px rgba(17,24,39,0.04), 0 1px 3px rgba(17,24,39,0.05)',
        'card-hover': '0 10px 30px -12px rgba(17,24,39,0.18), 0 4px 6px rgba(17,24,39,0.04)',
        'feature':    '0 25px 60px -25px rgba(37,99,235,0.30)',
      },
      typography: ({ theme }) => ({
        gray: {
          css: {
            '--tw-prose-body':     theme('colors.fs-dark'),
            '--tw-prose-headings': theme('colors.fs-dark'),
          },
        },
      }),
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
