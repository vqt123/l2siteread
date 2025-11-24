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
        // Load autocorrelation (existing implementation) - always available
        this.implementations['autocorrelation'] = await this.loadAutocorrelation();
        
        // Load Pitchfinder implementations (only if available)
        try {
            this.implementations['pitchfinder-yin'] = await this.loadPitchfinder('YIN');
            this.implementations['pitchfinder-amdf'] = await this.loadPitchfinder('AMDF');
            this.implementations['pitchfinder-macleod'] = await this.loadPitchfinder('MacLeod');
        } catch (error) {
            Logger.warn('Pitchfinder not available', { error: error.message });
            // Don't fail - just skip these implementations
        }
        
        // Load Pitchy (only if available)
        try {
            this.implementations['pitchy'] = await this.loadPitchy();
        } catch (error) {
            Logger.warn('Pitchy not available', { error: error.message });
            // Don't fail - just skip this implementation
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
                    // Check if getUserMedia is available
                    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                        const errorMsg = 'getUserMedia is not supported. Are you using HTTPS or localhost?';
                        Logger.error('getUserMedia not available', { 
                            hasMediaDevices: !!navigator.mediaDevices,
                            protocol: window.location.protocol,
                            hostname: window.location.hostname
                        });
                        throw new Error(errorMsg);
                    }

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
                    let errorDetails = {
                        error: error.message,
                        name: error.name,
                        protocol: window.location.protocol,
                        hostname: window.location.hostname,
                        isSecureContext: window.isSecureContext
                    };

                    // Provide specific error messages
                    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                        errorDetails.userMessage = 'Microphone permission denied. Please:\n' +
                            '1. Click the padlock icon in your browser address bar\n' +
                            '2. Allow microphone access\n' +
                            '3. Or check System Preferences > Security & Privacy > Microphone (macOS)';
                    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                        errorDetails.userMessage = 'No microphone found. Please connect a microphone.';
                    } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                        errorDetails.userMessage = 'Microphone is being used by another application. Please close other apps using the microphone.';
                    } else {
                        errorDetails.userMessage = error.message;
                    }

                    Logger.error('Failed to initialize Pitchfinder', errorDetails);
                    return { success: false, error: errorDetails };
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
        const pitchyModule = await import('pitchy');
        const Pitchy = pitchyModule.default || pitchyModule;
        
        return {
            name: 'Pitchy (McLeod)',
            pitchyDetector: Pitchy, // Store the imported module
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
                    // Use the stored Pitchy detector
                    const pitch = self.pitchyDetector.detectPitch(self.dataArray, self.audioContext.sampleRate);
                    
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

