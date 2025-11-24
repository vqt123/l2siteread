# Pitch Detection Library Testing Setup

## Overview
The app now supports multiple pitch detection algorithms through a unified adapter interface. You can easily switch between different algorithms to test which works best for guitar string detection.

## Available Algorithms

1. **Autocorrelation** (Current/Default)
   - Our custom implementation
   - Fast but struggles with harmonics

2. **Pitchfinder - YIN**
   - Excellent harmonic handling
   - Good for guitar strings
   - Recommended for testing

3. **Pitchfinder - AMDF**
   - Fast algorithm
   - Less robust to harmonics

4. **Pitchfinder - MacLeod**
   - Good balance of speed and accuracy
   - Used in some commercial tuners

5. **Pitchy (McLeod)**
   - Simple, fast implementation
   - Designed for real-time tuners

## Setup Instructions

### Option 1: Using npm packages (Current)
The libraries are installed via npm, but you'll need a bundler to use them in the browser:

1. Install a bundler (if not already):
   ```bash
   npm install --save-dev vite
   ```

2. Create `vite.config.js`:
   ```javascript
   export default {
     build: {
       rollupOptions: {
         input: 'index.html'
       }
     },
     server: {
       open: true
     }
   }
   ```

3. Update `package.json` scripts:
   ```json
   {
     "scripts": {
       "dev": "vite",
       "build": "vite build"
     }
   }
   ```

4. Run: `npm run dev`

### Option 2: Using CDN (Simpler, no bundler needed)
Update `pitch-detector-adapter.js` to load from CDN instead of npm packages.

## How to Switch Algorithms

1. Open Settings (gear icon)
2. Find "Pitch Detection Algorithm" dropdown
3. Select desired algorithm
4. Click "Save & Close"
5. Restart microphone mode for changes to take effect

The selection is saved in localStorage and persists across sessions.

## Testing Recommendations

1. Start with **YIN** algorithm - it's specifically designed to handle harmonics
2. Test with your calibration mode to see accuracy
3. Compare results across algorithms
4. Check the calibration logs to see which gives best results

## Current Status

- ✅ Adapter interface created
- ✅ UI controls added
- ✅ Algorithm switching implemented
- ⚠️ Module loading needs bundler or CDN setup
- ⚠️ Calibration mode needs testing with new algorithms

## Next Steps

1. Set up bundler (Vite recommended) OR switch to CDN
2. Test each algorithm with calibration mode
3. Compare accuracy rates from calibration logs
4. Select best algorithm for production use

