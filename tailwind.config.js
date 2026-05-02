/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        comic: ['Bangers', 'cursive'],
      },
    },
  },
  plugins: [],
}
