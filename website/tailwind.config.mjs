/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      colors: {
        'w-green':      '#1f3d18',
        'w-green-dark': '#132810',
        'w-gold':       '#b87530',
        'w-gold-light': '#d4943e',
        'w-cream':      '#faf7f0',
        'w-linen':      '#ede8dd',
        'w-stone':      '#8c7a5e',
        'w-dark':       '#1c160c',
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
