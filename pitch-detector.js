/**
 * PITCH DETECTION MODULE
 * Uses Web Audio API with autocorrelation for pitch detection
 * Based on PitchDetect algorithm
 */
const PitchDetector = {
    audioContext: null,
    analyser: null,
    microphone: null,
    dataArray: null,
    isListening: false,
    onNoteDetected: null,
    animationFrame: null,

    init: async function() {
        try {
            // Get microphone access
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                } 
            });
            
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 4096; // Higher for better frequency resolution
            this.analyser.smoothingTimeConstant = 0.3;
            
            this.microphone = this.audioContext.createMediaStreamSource(stream);
            this.microphone.connect(this.analyser);
            
            const bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Float32Array(bufferLength);
            
            Logger.info('Pitch detector initialized');
            return true;
        } catch (error) {
            Logger.error('Failed to initialize pitch detector', { error: error.message });
            return false;
        }
    },

    startListening: function(callback) {
        if (!this.analyser) {
            Logger.error('Pitch detector not initialized');
            return false;
        }
        
        this.onNoteDetected = callback;
        this.isListening = true;
        this.detectPitch();
        Logger.info('Started listening for pitch');
        return true;
    },

    stopListening: function() {
        this.isListening = false;
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        Logger.info('Stopped listening for pitch');
    },

    detectPitch: function() {
        if (!this.isListening) return;

        this.analyser.getFloatTimeDomainData(this.dataArray);
        
        // Autocorrelation pitch detection
        const pitch = this.autocorrelate(this.dataArray, this.audioContext.sampleRate);
        
        if (pitch > 0) {
            const note = this.frequencyToNote(pitch);
            if (this.onNoteDetected && note) {
                this.onNoteDetected(note, pitch);
            }
        }

        this.animationFrame = requestAnimationFrame(() => this.detectPitch());
    },

    autocorrelate: function(buffer, sampleRate) {
        const MIN_FREQUENCY = 60; // Minimum frequency to detect (Hz) - helps avoid harmonics
        const MAX_FREQUENCY = 2000; // Maximum frequency to detect (Hz)
        const MIN_SAMPLES = Math.floor(sampleRate / MAX_FREQUENCY); // Minimum offset for max frequency
        const MAX_SAMPLES = Math.floor(sampleRate / MIN_FREQUENCY); // Maximum offset for min frequency
        const GOOD_ENOUGH_CORRELATION = 0.60; // Lowered significantly for better detection
        const SIZE = buffer.length;
        const ACTUAL_MAX_SAMPLES = Math.min(MAX_SAMPLES, Math.floor(SIZE / 2));
        
        let bestOffset = -1;
        let bestCorrelation = 0;
        let rms = 0;
        let foundGoodCorrelation = false;
        const correlations = new Array(ACTUAL_MAX_SAMPLES);

        // Calculate RMS for signal strength
        for (let i = 0; i < SIZE; i++) {
            const val = buffer[i];
            rms += val * val;
        }
        rms = Math.sqrt(rms / SIZE);
        
        if (rms < 0.005) {
            Logger.debug('Autocorrelation: insufficient signal', { rms: Math.round(rms * 10000) / 10000 });
            return -1; // Lowered threshold - not enough signal
        }

        // Normalize buffer to improve correlation
        let maxVal = 0;
        for (let i = 0; i < SIZE; i++) {
            if (Math.abs(buffer[i]) > maxVal) {
                maxVal = Math.abs(buffer[i]);
            }
        }
        if (maxVal === 0) return -1;
        
        const normalizedBuffer = new Float32Array(SIZE);
        for (let i = 0; i < SIZE; i++) {
            normalizedBuffer[i] = buffer[i] / maxVal;
        }

        let lastCorrelation = 1;
        for (let offset = MIN_SAMPLES; offset < ACTUAL_MAX_SAMPLES; offset++) {
            let correlation = 0;
            let count = 0;

            // Use normalized buffer and calculate correlation more carefully
            for (let i = 0; i < SIZE - offset; i++) {
                correlation += normalizedBuffer[i] * normalizedBuffer[i + offset];
                count++;
            }
            
            if (count > 0) {
                correlation = correlation / count;
            }
            
            correlations[offset] = correlation;

            // Track best correlation regardless of threshold
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestOffset = offset;
            }
            
            if (correlation > GOOD_ENOUGH_CORRELATION && correlation > lastCorrelation) {
                foundGoodCorrelation = true;
            } else if (foundGoodCorrelation && correlation < bestCorrelation * 0.9) {
                // Found peak, now interpolate for better accuracy
                if (bestOffset > 0 && bestOffset < ACTUAL_MAX_SAMPLES - 1 && bestOffset > MIN_SAMPLES) {
                    const shift = (correlations[bestOffset + 1] - correlations[bestOffset - 1]) / 
                                  (2 * correlations[bestOffset]);
                    const frequency = sampleRate / (bestOffset + shift);
                    
                    // Check if this is likely a harmonic (2x, 3x, etc. of a lower frequency)
                    const fundamental = this.findFundamentalFrequency(frequency, correlations, sampleRate, MIN_SAMPLES);
                    if (fundamental > 0) {
                        return fundamental;
                    }
                }
            }
            lastCorrelation = correlation;
        }
        
        // If we found any correlation, use it (even if below threshold)
        // This helps catch weak signals
        if (bestCorrelation > 0.001 && bestOffset > 0 && bestOffset >= MIN_SAMPLES) {
            const frequency = sampleRate / bestOffset;
            
            // Only check harmonics if correlation is decent
            if (bestCorrelation > 0.3) {
                const fundamental = this.findFundamentalFrequency(frequency, correlations, sampleRate, MIN_SAMPLES);
                if (fundamental > 0 && fundamental !== frequency) {
                    Logger.debug('Autocorrelation: found frequency (corrected harmonic)', {
                        frequency: Math.round(frequency * 100) / 100,
                        fundamental: Math.round(fundamental * 100) / 100,
                        bestCorrelation: Math.round(bestCorrelation * 1000) / 1000,
                        bestOffset: bestOffset
                    });
                    return fundamental;
                }
            }
            
            Logger.debug('Autocorrelation: found frequency', {
                frequency: Math.round(frequency * 100) / 100,
                bestCorrelation: Math.round(bestCorrelation * 1000) / 1000,
                bestOffset: bestOffset,
                minFreq: MIN_FREQUENCY,
                maxFreq: MAX_FREQUENCY
            });
            return frequency;
        }
        
        // Log why detection failed
        Logger.debug('Autocorrelation: no frequency found', {
            bestCorrelation: Math.round(bestCorrelation * 1000) / 1000,
            bestOffset: bestOffset,
            minSamples: MIN_SAMPLES,
            maxSamples: ACTUAL_MAX_SAMPLES,
            rms: Math.round(rms * 10000) / 10000,
            foundGoodCorrelation: foundGoodCorrelation
        });
        return -1;
    },

    findFundamentalFrequency: function(detectedFreq, correlations, sampleRate, minSamples) {
        // Check if detected frequency might be a harmonic (2x, 3x, 4x) of the fundamental
        // For guitar strings, we expect fundamentals between 82-330 Hz
        const expectedRange = { min: 60, max: 400 };
        const harmonics = [2, 3, 4];
        
        // If detected frequency is already in expected range, it's likely the fundamental
        if (detectedFreq >= expectedRange.min && detectedFreq <= expectedRange.max) {
            return detectedFreq;
        }
        
        // Check if it's a harmonic of a frequency in the expected range
        for (const harmonic of harmonics) {
            const candidateFundamental = detectedFreq / harmonic;
            
            // Check if candidate is in valid range
            if (candidateFundamental < expectedRange.min || candidateFundamental > expectedRange.max) continue;
            
            // Calculate what offset would correspond to this fundamental
            const candidateOffset = Math.round(sampleRate / candidateFundamental);
            
            if (candidateOffset >= minSamples && candidateOffset < correlations.length && correlations[candidateOffset] !== undefined) {
                // Check if there's a strong correlation at this offset (indicating it's the fundamental)
                const correlation = correlations[candidateOffset];
                
                // If correlation is strong enough, this is likely the fundamental
                if (correlation > 0.5) { // Lowered from 0.6
                    Logger.debug('Found fundamental frequency', {
                        detected: detectedFreq,
                        fundamental: candidateFundamental,
                        harmonic: harmonic,
                        correlation: correlation
                    });
                    return candidateFundamental;
                }
            }
        }
        
        // If detected frequency is way too high, try to find the fundamental
        // by checking if it's close to a multiple of an expected frequency
        if (detectedFreq > expectedRange.max) {
            for (const harmonic of harmonics) {
                const candidate = detectedFreq / harmonic;
                if (candidate >= expectedRange.min && candidate <= expectedRange.max) {
                    // This is likely a harmonic, return the candidate
                    Logger.debug('Correcting harmonic', {
                        detected: detectedFreq,
                        corrected: candidate,
                        harmonic: harmonic
                    });
                    return candidate;
                }
            }
        }
        
        // If no fundamental found, return the detected frequency (don't filter it out)
        return detectedFreq;
    },

    frequencyToNote: function(frequency) {
        if (frequency <= 0) return null;

        // A4 = 440 Hz
        const A4 = 440;
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        
        // Calculate semitones from A4
        const semitones = 12 * Math.log2(frequency / A4);
        const noteNumber = Math.round(semitones) + 9; // A4 is note 9 in the 12-note scale (0-indexed from C)
        
        // Calculate octave
        const octave = 4 + Math.floor((noteNumber + 9) / 12);
        const noteIndex = ((noteNumber % 12) + 12) % 12;
        const noteName = noteNames[noteIndex];
        
        return {
            note: noteName,
            octave: octave,
            frequency: frequency,
            accidental: noteName.includes('#') ? '#' : null
        };
    },

    cleanup: function() {
        this.stopListening();
        if (this.microphone) {
            this.microphone.disconnect();
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
};

