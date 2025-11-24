export default {
  build: {
    rollupOptions: {
      input: 'index.html'
    }
  },
  server: {
    open: false, // Don't automatically open browser
    port: 5174, // Changed from 3000 to avoid Cursor's auto-detection
    strictPort: true,
    host: '127.0.0.1' // Bind to 127.0.0.1 instead of localhost to avoid IDE detection
    // HTTPS is optional - localhost HTTP works for microphone access
    // Uncomment below if you need HTTPS:
    // https: true
  }
}

