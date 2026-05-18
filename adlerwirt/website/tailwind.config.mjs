/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      colors: {
        'w-green':      '#162a1b',
        'w-green-dark': '#0b160e',
        'w-gold':       '#c69c6d',
        'w-gold-light': '#dcb992',
        'w-cream':      '#fdfbf7',
        'w-linen':      '#f2efe9',
        'w-stone':      '#9c8e7e',
        'w-dark':       '#1a1816',
      },
      fontFamily: {
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        sans:  ['Inter', 'system-ui', 'sans-serif'],
      },
      typography: ({ theme }) => ({
        stone: {
          css: {
            '--tw-prose-body':    theme('colors.w-dark'),
            '--tw-prose-headings': theme('colors.w-dark'),
            '--tw-prose-bold':    theme('colors.w-dark'),
            p: { marginTop: '1em', marginBottom: '1em', lineHeight: '1.75' },
          },
        },
      }),
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
