/**
 * METRONOME MODULE
 * Visual metronome only (no audio)
 */
const Metronome = {
    isRunning: false,
    tempo: 120, // BPM
    intervalId: null,
    beatCallback: null,
    currentBeat: 0,
    beatsPerMeasure: 4,

    start: function(callback) {
        if (this.isRunning) return;
        
        this.beatCallback = callback;
        this.isRunning = true;
        this.currentBeat = 0;
        
        // Trigger first beat immediately
        if (this.beatCallback) {
            this.beatCallback(this.currentBeat);
        }
        
        // Calculate interval in milliseconds
        const intervalMs = (60 / this.tempo) * 1000;
        
        this.intervalId = setInterval(() => {
            this.currentBeat = (this.currentBeat + 1) % this.beatsPerMeasure;
            if (this.beatCallback) {
                this.beatCallback(this.currentBeat);
            }
        }, intervalMs);
        
        Logger.info('Metronome started', { tempo: this.tempo, beatsPerMeasure: this.beatsPerMeasure });
    },

    stop: function() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        this.currentBeat = 0;
        Logger.info('Metronome stopped');
    },

    setTempo: function(bpm) {
        const wasRunning = this.isRunning;
        if (wasRunning) {
            this.stop();
        }
        this.tempo = Math.max(40, Math.min(200, bpm)); // Clamp between 40-200 BPM
        if (wasRunning) {
            this.start(this.beatCallback);
        }
        Logger.info('Metronome tempo changed', { tempo: this.tempo });
    },

    setBeatsPerMeasure: function(beats) {
        this.beatsPerMeasure = Math.max(2, Math.min(8, beats)); // Clamp between 2-8
    },

    getTimeUntilNextBeat: function() {
        if (!this.isRunning) return 0;
        const beatInterval = (60 / this.tempo) * 1000;
        // We can't easily get exact time, so return the full interval
        // This will be improved with better timing
        return beatInterval;
    }
};

