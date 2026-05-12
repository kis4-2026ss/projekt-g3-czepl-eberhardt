/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens — easy to retheme by swapping these.
        'surface': {
          DEFAULT: '#0b0b10',
          raised:  '#15151c',
          sunken:  '#08080c',
        },
        'border-default': '#27272a',
        'brand': {
          DEFAULT: '#818cf8', // indigo-400
          strong:  '#6366f1', // indigo-500
          soft:    '#a5b4fc', // indigo-300
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
