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
        const MIN_SAMPLES = 0;
        const GOOD_ENOUGH_CORRELATION = 0.9;
        const SIZE = buffer.length;
        const MAX_SAMPLES = Math.floor(SIZE / 2);
        
        let bestOffset = -1;
        let bestCorrelation = 0;
        let rms = 0;
        let foundGoodCorrelation = false;
        const correlations = new Array(MAX_SAMPLES);

        for (let i = 0; i < SIZE; i++) {
            const val = buffer[i];
            rms += val * val;
        }
        rms = Math.sqrt(rms / SIZE);
        
        if (rms < 0.01) return -1; // Not enough signal

        let lastCorrelation = 1;
        for (let offset = MIN_SAMPLES; offset < MAX_SAMPLES; offset++) {
            let correlation = 0;

            for (let i = 0; i < MAX_SAMPLES; i++) {
                correlation += Math.abs((buffer[i] - buffer[i + offset]));
            }
            correlation = 1 - (correlation / MAX_SAMPLES);
            correlations[offset] = correlation; // Store it for later

            if (correlation > GOOD_ENOUGH_CORRELATION && correlation > lastCorrelation) {
                foundGoodCorrelation = true;
                if (correlation > bestCorrelation) {
                    bestCorrelation = correlation;
                    bestOffset = offset;
                }
            } else if (foundGoodCorrelation) {
                // Short-circuit - we found a good correlation, then a bad one, so we'd just be seeing copies from here.
                // Now we need to find the best correlation point and interpolate it.
                const shift = (correlations[bestOffset + 1] - correlations[bestOffset - 1]) / correlations[bestOffset];
                return sampleRate / (bestOffset + (8 * shift));
            }
            lastCorrelation = correlation;
        }
        
        if (bestCorrelation > 0.01) {
            return sampleRate / bestOffset;
        }
        return -1;
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

