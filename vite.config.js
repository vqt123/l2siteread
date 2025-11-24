import basicSsl from '@vitejs/plugin-basic-ssl'

export default {
  plugins: [basicSsl()],
  build: {
    rollupOptions: {
      input: 'index.html'
    }
  },
  server: {
    open: false, // Don't automatically open browser
    port: 3000,
    strictPort: true,
    https: true // Enable HTTPS for microphone access
  }
}

