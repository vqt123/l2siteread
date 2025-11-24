/**
 * PITCH DETECTION ADAPTER
 * Provides a unified interface for multiple pitch detection libraries
 * Allows easy switching between different algorithms for testing
 * 
 * Note: This uses ES6 dynamic imports for pitchfinder and pitchy
 * Make sure to load this as a module: <script type="module" src="pitch-detector-adapter.js"></script>
 */

const PitchDetectorAdapter = {
    // Current implementation being used
    currentImplementation: null,
    implementations: {},
    
    // Configuration
    config: {
        // 'autocorrelation' | 'pitchfinder-yin' | 'pitchfinder-amdf' | 'pitchfinder-macleod' | 'pitchy'
        algorithm: (() => {
            // Check localStorage first, then config, then default
            if (typeof localStorage !== 'undefined') {
                const saved = localStorage.getItem('pitchDetectionAlgorithm');
                if (saved) return saved;
            }
            if (typeof PITCH_DETECTION_ALGORITHM !== 'undefined') {
                return PITCH_DETECTION_ALGORITHM;
            }
            return 'autocorrelation';
        })(),
        sampleRate: 44100
    },
    
    // Initialize the adapter (this is the main init method)
    initialize: async function() {
        // Load all implementations
        await this.loadImplementations();
        
        // Set the current implementation based on config
        this.setAlgorithm(this.config.algorithm);
        
        Logger.info('Pitch detector adapter initialized', { algorithm: this.config.algorithm });
    },
    
    // Load all available implementations
    loadImplementations: async function() {
        // Load autocorrelation (existing implementation)
        this.implementations['autocorrelation'] = await this.loadAutocorrelation();
        
        // Load Pitchfinder implementations
        try {
            this.implementations['pitchfinder-yin'] = await this.loadPitchfinder('YIN');
            this.implementations['pitchfinder-amdf'] = await this.loadPitchfinder('AMDF');
            this.implementations['pitchfinder-macleod'] = await this.loadPitchfinder('MacLeod');
        } catch (error) {
            Logger.warn('Pitchfinder not available', { error: error.message });
        }
        
        // Load Pitchy
        try {
            this.implementations['pitchy'] = await this.loadPitchy();
        } catch (error) {
            Logger.warn('Pitchy not available', { error: error.message });
        }
    },
    
    // Load autocorrelation implementation (existing)
    loadAutocorrelation: async function() {
        return {
            name: 'Autocorrelation',
            init: async () => {
                return await PitchDetector.init();
            },
            startListening: (callback) => {
                return PitchDetector.startListening(callback);
            },
            stopListening: () => {
                PitchDetector.stopListening();
            },
            cleanup: () => {
                PitchDetector.cleanup();
            },
            getSampleRate: () => {
                return PitchDetector.audioContext ? PitchDetector.audioContext.sampleRate : 44100;
            }
        };
    },
    
    // Load Pitchfinder implementation
    loadPitchfinder: async function(algorithmName) {
        // Dynamically import pitchfinder
        const { PitchFinder } = await import('pitchfinder');
        
        let detector;
        switch(algorithmName) {
            case 'YIN':
                detector = PitchFinder.YIN({ sampleRate: 44100 });
                break;
            case 'AMDF':
                detector = PitchFinder.AMDF({ sampleRate: 44100 });
                break;
            case 'MacLeod':
                detector = PitchFinder.MacLeod({ sampleRate: 44100 });
                break;
            default:
                throw new Error(`Unknown Pitchfinder algorithm: ${algorithmName}`);
        }
        
        return {
            name: `Pitchfinder ${algorithmName}`,
            detector: detector,
            audioContext: null,
            analyser: null,
            microphone: null,
            dataArray: null,
            isListening: false,
            animationFrame: null,
            init: async function() {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ 
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false
                        } 
                    });
                    
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    this.analyser = this.audioContext.createAnalyser();
                    this.analyser.fftSize = 4096;
                    this.analyser.smoothingTimeConstant = 0.3;
                    
                    this.microphone = this.audioContext.createMediaStreamSource(stream);
                    this.microphone.connect(this.analyser);
                    
                    const bufferLength = this.analyser.frequencyBinCount;
                    this.dataArray = new Float32Array(bufferLength);
                    
                    return true;
                } catch (error) {
                    Logger.error('Failed to initialize Pitchfinder', { error: error.message });
                    return false;
                }
            },
            startListening: function(callback) {
                if (!this.analyser) {
                    Logger.error('Pitchfinder not initialized');
                    return false;
                }
                
                this.isListening = true;
                const self = this;
                
                const processAudio = () => {
                    if (!self.isListening) return;
                    
                    self.analyser.getFloatTimeDomainData(self.dataArray);
                    const pitch = self.detector(self.dataArray);
                    
                    if (pitch && pitch > 0) {
                        // Convert frequency to note
                        const note = PitchDetector.frequencyToNote(pitch);
                        if (note) {
                            callback(note, pitch);
                        }
                    }
                    
                    self.animationFrame = requestAnimationFrame(processAudio);
                };
                
                processAudio();
                return true;
            },
            stopListening: function() {
                this.isListening = false;
                if (this.animationFrame) {
                    cancelAnimationFrame(this.animationFrame);
                    this.animationFrame = null;
                }
            },
            cleanup: function() {
                this.stopListening();
                if (this.microphone) {
                    this.microphone.disconnect();
                }
                if (this.audioContext) {
                    this.audioContext.close();
                }
            },
            getSampleRate: function() {
                return this.audioContext ? this.audioContext.sampleRate : 44100;
            }
        };
    },
    
    // Load Pitchy implementation
    loadPitchy: async function() {
        // Dynamically import pitchy
        const { Pitchy } = await import('pitchy');
        
        return {
            name: 'Pitchy (McLeod)',
            audioContext: null,
            analyser: null,
            microphone: null,
            dataArray: null,
            isListening: false,
            animationFrame: null,
            init: async function() {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ 
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false
                        } 
                    });
                    
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    this.analyser = this.audioContext.createAnalyser();
                    this.analyser.fftSize = 4096;
                    this.analyser.smoothingTimeConstant = 0.3;
                    
                    this.microphone = this.audioContext.createMediaStreamSource(stream);
                    this.microphone.connect(this.analyser);
                    
                    const bufferLength = this.analyser.frequencyBinCount;
                    this.dataArray = new Float32Array(bufferLength);
                    
                    return true;
                } catch (error) {
                    Logger.error('Failed to initialize Pitchy', { error: error.message });
                    return false;
                }
            },
            startListening: function(callback) {
                if (!this.analyser) {
                    Logger.error('Pitchy not initialized');
                    return false;
                }
                
                this.isListening = true;
                const self = this;
                
                const processAudio = () => {
                    if (!self.isListening) return;
                    
                    self.analyser.getFloatTimeDomainData(self.dataArray);
                    const pitch = Pitchy.detectPitch(self.dataArray, self.audioContext.sampleRate);
                    
                    if (pitch && pitch > 0) {
                        // Convert frequency to note
                        const note = PitchDetector.frequencyToNote(pitch);
                        if (note) {
                            callback(note, pitch);
                        }
                    }
                    
                    self.animationFrame = requestAnimationFrame(processAudio);
                };
                
                processAudio();
                return true;
            },
            stopListening: function() {
                this.isListening = false;
                if (this.animationFrame) {
                    cancelAnimationFrame(this.animationFrame);
                    this.animationFrame = null;
                }
            },
            cleanup: function() {
                this.stopListening();
                if (this.microphone) {
                    this.microphone.disconnect();
                }
                if (this.audioContext) {
                    this.audioContext.close();
                }
            },
            getSampleRate: function() {
                return this.audioContext ? this.audioContext.sampleRate : 44100;
            }
        };
    },
    
    // Set the algorithm to use
    setAlgorithm: function(algorithmName) {
        if (!this.implementations[algorithmName]) {
            Logger.error('Algorithm not available', { algorithm: algorithmName, available: Object.keys(this.implementations) });
            return false;
        }
        
        // Stop current implementation if running
        if (this.currentImplementation && this.currentImplementation.isListening) {
            this.currentImplementation.stopListening();
        }
        
        this.config.algorithm = algorithmName;
        this.currentImplementation = this.implementations[algorithmName];
        
        Logger.info('Pitch detection algorithm changed', { 
            algorithm: algorithmName,
            name: this.currentImplementation.name 
        });
        
        return true;
    },
    
    // Get list of available algorithms
    getAvailableAlgorithms: function() {
        return Object.keys(this.implementations).map(key => ({
            key: key,
            name: this.implementations[key].name
        }));
    },
    
    // Unified interface methods
    init: async function() {
        // First time initialization
        if (!this.currentImplementation) {
            await this.initialize();
        }
        // Then initialize the current implementation
        if (this.currentImplementation) {
            return await this.currentImplementation.init();
        }
        return false;
    },
    
    startListening: function(callback) {
        if (!this.currentImplementation) {
            Logger.error('No pitch detection implementation selected');
            return false;
        }
        return this.currentImplementation.startListening(callback);
    },
    
    stopListening: function() {
        if (this.currentImplementation) {
            this.currentImplementation.stopListening();
        }
    },
    
    cleanup: function() {
        if (this.currentImplementation) {
            this.currentImplementation.cleanup();
        }
    },
    
    getSampleRate: function() {
        if (this.currentImplementation) {
            return this.currentImplementation.getSampleRate();
        }
        return 44100;
    },
    
    // Expose frequencyToNote from original PitchDetector (used by all implementations)
    frequencyToNote: function(frequency) {
        return PitchDetector.frequencyToNote(frequency);
    },
    
    // Expose autocorrelate for calibration mode (when using autocorrelation)
    autocorrelate: function(buffer, sampleRate) {
        if (this.config.algorithm === 'autocorrelation' && PitchDetector.autocorrelate) {
            return PitchDetector.autocorrelate(buffer, sampleRate);
        }
        return -1;
    }
};

// Export for use in other scripts
if (typeof window !== 'undefined') {
    window.PitchDetectorAdapter = PitchDetectorAdapter;
}

