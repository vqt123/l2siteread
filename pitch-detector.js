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
        const MAX_FREQUENCY = 500; // Maximum frequency to detect (Hz) - lowered to avoid false 2000Hz detections
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
        
        // Track multiple peaks to help identify fundamentals vs harmonics
        const peaks = [];

        // Calculate RMS for signal strength
        for (let i = 0; i < SIZE; i++) {
            const val = buffer[i];
            rms += val * val;
        }
        rms = Math.sqrt(rms / SIZE);
        
        if (rms < 0.005) {
            // Don't log insufficient signal - too spammy
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
                    const fundamental = this.findFundamentalFrequency(frequency, correlations, sampleRate, MIN_SAMPLES, bestCorrelation);
                    if (fundamental > 0) {
                        return fundamental;
                    }
                }
            }
            lastCorrelation = correlation;
        }
        
        // After the loop, identify peaks from the correlations array
        for (let offset = MIN_SAMPLES + 2; offset < ACTUAL_MAX_SAMPLES - 2; offset++) {
            const correlation = correlations[offset];
            if (correlation > 0.3) {
                // Check if this is a local maximum
                if (correlation > correlations[offset - 1] && 
                    correlation > correlations[offset + 1] &&
                    correlation > correlations[offset - 2] * 0.9 &&
                    correlation > correlations[offset + 2] * 0.9) {
                    peaks.push({
                        offset: offset,
                        correlation: correlation,
                        frequency: sampleRate / offset
                    });
                }
            }
        }
        
        // If we found any correlation, use it (even if below threshold)
        // This helps catch weak signals
        if (bestCorrelation > 0.001 && bestOffset > 0 && bestOffset >= MIN_SAMPLES) {
            const frequency = sampleRate / bestOffset;
            
            // Before checking harmonics, see if we have peaks that suggest a lower fundamental
            // Sort peaks by frequency (lowest first)
            peaks.sort((a, b) => a.frequency - b.frequency);
            
            // Check if the best peak might be a harmonic of a lower peak
            for (let i = 0; i < peaks.length; i++) {
                const lowerPeak = peaks[i];
                if (lowerPeak.frequency >= 60 && lowerPeak.frequency <= 400) {
                    // Check if best frequency is a harmonic of this lower peak
                    const ratio = frequency / lowerPeak.frequency;
                    if (ratio > 1.8 && ratio < 2.2) {
                        // Likely 2x harmonic - prefer the fundamental if it has decent correlation
                        if (lowerPeak.correlation > bestCorrelation * 0.6) {
                            const fundamental = this.findFundamentalFrequency(frequency, correlations, sampleRate, MIN_SAMPLES, bestCorrelation);
                            if (fundamental > 0) {
                                return fundamental;
                            }
                        }
                    } else if (ratio > 2.8 && ratio < 3.2) {
                        // Likely 3x harmonic
                        if (lowerPeak.correlation > bestCorrelation * 0.5) {
                            const fundamental = this.findFundamentalFrequency(frequency, correlations, sampleRate, MIN_SAMPLES, bestCorrelation);
                            if (fundamental > 0) {
                                return fundamental;
                            }
                        }
                    }
                }
            }
            
            // Always check for harmonics - this is critical for guitar strings
            // Pass the bestCorrelation so we can compare with candidate fundamentals
            const fundamental = this.findFundamentalFrequency(frequency, correlations, sampleRate, MIN_SAMPLES, bestCorrelation);
            if (fundamental > 0 && fundamental !== frequency) {
                // Only log harmonic corrections (interesting case)
                Logger.debug('Harmonic corrected', {
                    detected: Math.round(frequency * 100) / 100,
                    corrected: Math.round(fundamental * 100) / 100
                });
                return fundamental;
            }
            
            // If fundamental check rejected it, return -1
            if (fundamental < 0) {
                return -1;
            }
            
            // Don't log every successful detection - too spammy
            return frequency;
        }
        
        // Don't log failed detections - too spammy
        return -1;
    },

    findFundamentalFrequency: function(detectedFreq, correlations, sampleRate, minSamples, detectedCorrelation) {
        // Check if detected frequency might be a harmonic (2x, 3x, 4x) of the fundamental
        // For guitar strings, we expect fundamentals between 82-330 Hz
        const expectedRange = { min: 60, max: 400 };
        const harmonics = [2, 3, 4, 5, 6]; // Check harmonics
        
        // If frequency is way too high (like 500Hz+), it's likely noise
        if (detectedFreq > 450) {
            return -1; // Reject it
        }
        
        // Always check if detected frequency might be a harmonic of a lower fundamental
        // This is critical - guitar strings often produce strong harmonics
        let bestFundamental = detectedFreq;
        let bestFundamentalCorrelation = detectedCorrelation || 0;
        
        for (const harmonic of harmonics) {
            const candidateFundamental = detectedFreq / harmonic;
            
            // Check if candidate is in valid range
            if (candidateFundamental < expectedRange.min || candidateFundamental > expectedRange.max) continue;
            
            // Calculate what offset would correspond to this fundamental
            const candidateOffset = Math.round(sampleRate / candidateFundamental);
            
            if (candidateOffset >= minSamples && candidateOffset < correlations.length && correlations[candidateOffset] !== undefined) {
                const candidateCorrelation = correlations[candidateOffset];
                
                // If the fundamental has comparable or stronger correlation, prefer it
                // This handles the case where we detect 147Hz (D3) but 73Hz (D2) has stronger correlation
                // We want the lower frequency (fundamental) if it has good correlation
                if (candidateCorrelation > bestFundamentalCorrelation * 0.7) {
                    // The fundamental has at least 70% of the detected frequency's correlation
                    // Prefer the fundamental (lower frequency)
                    if (candidateFundamental < bestFundamental) {
                        bestFundamental = candidateFundamental;
                        bestFundamentalCorrelation = candidateCorrelation;
                    }
                }
            }
        }
        
        // If we found a better fundamental (lower frequency with good correlation), use it
        if (bestFundamental < detectedFreq && bestFundamentalCorrelation > 0.3) {
            return bestFundamental;
        }
        
        // If detected frequency is outside expected range, reject it
        if (detectedFreq < expectedRange.min || detectedFreq > expectedRange.max) {
            return -1;
        }
        
        // If no better fundamental found, return the detected frequency
        return detectedFreq;
    },

    frequencyToNote: function(frequency) {
        if (frequency <= 0) return null;

        // A4 = 440 Hz
        const A4 = 440;
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        
        // Calculate semitones from A4
        const semitonesFromA4 = 12 * Math.log2(frequency / A4);
        
        // Round to nearest semitone
        const roundedSemitones = Math.round(semitonesFromA4);
        
        // A4 is in octave 4, and is note 9 (0-indexed from C)
        // A4 = 4*12 + 9 = 57 semitones from C0
        const A4_semitonesFromC0 = 4 * 12 + 9; // 57
        
        // Calculate absolute note number from C0
        const noteNumberFromC0 = A4_semitonesFromC0 + roundedSemitones;
        
        // Calculate octave (C0 = octave 0, C1 = octave 1, etc.)
        const octave = Math.floor(noteNumberFromC0 / 12);
        
        // Calculate note index (0-11)
        const noteIndex = ((noteNumberFromC0 % 12) + 12) % 12;
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

