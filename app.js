/**
 * APP LOGIC
 */
const App = {
    srs: new SRSEngine(),
    currentSequence: [],
    sequenceIndex: 0,
    isProcessing: false,
    lastNoteTime: 0, // Timestamp when current note was displayed/activated
    lastDetectedNote: null, // For debouncing microphone input
    lastDetectionTime: 0, // Timestamp of last detection
    metronomeEnabled: false,
    nextBeatTime: 0, // When the next beat should occur
    beatMeterAnimation: null, // Animation frame ID for beat meter
    isCalibrating: false, // Whether calibration mode is active
    calibrationDetector: null, // Separate pitch detector for calibration
    guidedCalibration: {
        active: false,
        currentStringIndex: 0,
        strings: [
            { note: 'E', octave: 2, name: 'E (6th string)', expectedFreq: 82.41 },
            { note: 'A', octave: 2, name: 'A (5th string)', expectedFreq: 110.00 },
            { note: 'D', octave: 3, name: 'D (4th string)', expectedFreq: 146.83 },
            { note: 'G', octave: 3, name: 'G (3rd string)', expectedFreq: 196.00 },
            { note: 'B', octave: 3, name: 'B (2nd string)', expectedFreq: 246.94 },
            { note: 'E', octave: 4, name: 'E (1st string)', expectedFreq: 329.63 }
        ],
        logs: [], // Array to store detection logs for each string
        sessionLog: [] // Separate log for this calibration session (concise)
    },
    settings: {
        clefs: ['treble'],
        keys: ['C'],
        mode: 'buttons',
        batchSize: 8,
        metronomeEnabled: false,
        tempo: 120
    },

    init: function() {
        Logger.info('App.init() called');
        this.loadSettings();
        this.setupPiano();
        this.setupEventListeners();
        this.updateUIForMode();
        
        // Log initial state of all unlocked notes
        this.logUnlockedNotesState();
        
        this.nextRound();
        this.updateStats();
        Logger.info('App initialization complete');
    },

    logUnlockedNotesState: function() {
        const allClefs = ['treble', 'bass'];
        allClefs.forEach(clef => {
            const prog = PROGRESSION[clef] || PROGRESSION['treble'];
            const unlocked = this.srs.data.unlockedCount;
            const noteStates = [];
            
            for (let i = 0; i < unlocked; i++) {
                const p = prog[i];
                const id = this.srs.getKey(clef, p.n, p.o);
                const item = this.srs.data.items[id];
                noteStates.push({
                    note: `${p.n}${p.o}`,
                    id,
                    streak: item ? (item.streak || 0) : 0,
                    required: REQUIRED_STREAK_PER_NOTE,
                    ready: item ? ((item.streak || 0) >= REQUIRED_STREAK_PER_NOTE) : false,
                    exists: !!item
                });
            }
            
            Logger.info(`Initial state for ${clef} clef`, {
                clef,
                unlocked,
                noteStates,
                allReady: noteStates.every(n => n.ready)
            });
        });
    },

    loadSettings: function() {
        const s = localStorage.getItem('sightread_settings_v2');
        if (s) {
            this.settings = JSON.parse(s);
            document.getElementById('clef-treble').checked = this.settings.clefs.includes('treble');
            document.getElementById('clef-bass').checked = this.settings.clefs.includes('bass');
            document.querySelectorAll('.key-sig-opt').forEach(cb => {
                cb.checked = this.settings.keys.includes(cb.value);
            });
            document.querySelector(`input[name="input_mode"][value="${this.settings.mode}"]`).checked = true;
            document.getElementById('batch-size').value = this.settings.batchSize;
            
            // Metronome settings
            if (this.settings.metronomeEnabled !== undefined) {
                document.getElementById('metronome-enabled').checked = this.settings.metronomeEnabled;
            }
            if (this.settings.tempo) {
                document.getElementById('tempo-slider').value = this.settings.tempo;
                document.getElementById('tempo-display').textContent = this.settings.tempo;
            }
        } else {
            document.getElementById('clef-treble').checked = true;
            document.querySelector(`input[name="input_mode"][value="buttons"]`).checked = true;
            this.settings.batchSize = 8;
            this.settings.metronomeEnabled = false;
            this.settings.tempo = 120;
        }
    },

    saveSettings: function() {
        const clefs = [];
        if (document.getElementById('clef-treble').checked) clefs.push('treble');
        if (document.getElementById('clef-bass').checked) clefs.push('bass');
        if (clefs.length === 0) clefs.push('treble'); 

        const keys = [];
        document.querySelectorAll('.key-sig-opt:checked').forEach(cb => keys.push(cb.value));

        const mode = document.querySelector('input[name="input_mode"]:checked').value;
        const batchSize = parseInt(document.getElementById('batch-size').value);
        const metronomeEnabled = document.getElementById('metronome-enabled').checked;
        const tempo = parseInt(document.getElementById('tempo-slider').value);

        this.settings = { clefs, keys, mode, batchSize, metronomeEnabled, tempo };
        localStorage.setItem('sightread_settings_v2', JSON.stringify(this.settings));
        
        // Update metronome if running
        if (this.settings.mode === 'microphone' && metronomeEnabled && Metronome.isRunning) {
            Metronome.setTempo(tempo);
        }
        
        this.updateUIForMode();
        this.nextRound(); 
    },

    updateUIForMode: function() {
        const pianoWrap = document.getElementById('piano-wrapper');
        const btnWrap = document.getElementById('buttons-wrapper');
        const micStatus = document.getElementById('mic-status');
        
        if (this.settings.mode === 'piano') {
            pianoWrap.classList.remove('hidden');
            btnWrap.classList.add('hidden');
            micStatus.classList.add('hidden');
            this.stopMicrophone();
        } else if (this.settings.mode === 'microphone') {
            pianoWrap.classList.add('hidden');
            btnWrap.classList.add('hidden');
            micStatus.classList.remove('hidden');
            // Require metronome for microphone mode
            if (!this.settings.metronomeEnabled) {
                alert('Metronome is required for microphone mode. Please enable it in settings.');
                // Auto-enable metronome
                this.settings.metronomeEnabled = true;
                document.getElementById('metronome-enabled').checked = true;
            }
            if (this.settings.metronomeEnabled) {
                this.startMicrophone();
            }
        } else {
            pianoWrap.classList.add('hidden');
            btnWrap.classList.remove('hidden');
            micStatus.classList.add('hidden');
            this.stopMicrophone();
        }
    },

    startMicrophone: async function() {
        if (PitchDetector.isListening) return;
        
        // Check if adapter is available, fallback to direct PitchDetector
        let detector = PitchDetector;
        let useAdapter = false;
        
        if (typeof window !== 'undefined' && window.PitchDetectorAdapter) {
            try {
                // Initialize adapter if not already done
                if (!window.PitchDetectorAdapter.currentImplementation) {
                    await window.PitchDetectorAdapter.initialize();
                }
                detector = window.PitchDetectorAdapter;
                useAdapter = true;
            } catch (error) {
                Logger.warn('Failed to initialize adapter, using direct PitchDetector', { error: error.message });
                detector = PitchDetector;
                useAdapter = false;
            }
        }
        
        const result = await detector.init();
        if (!result || (typeof result === 'object' && !result.success)) {
            const errorInfo = typeof result === 'object' && result.error ? result.error : { userMessage: 'Failed to access microphone. Please check permissions.' };
            const message = errorInfo.userMessage || errorInfo.error || 'Failed to access microphone. Please check permissions.';
            
            Logger.error('Microphone access failed', errorInfo);
            alert(message + '\n\nIf the issue persists, try:\n' +
                '1. Using HTTPS (the dev server can be configured for this)\n' +
                '2. Checking browser permissions (click padlock icon)\n' +
                '3. Checking macOS System Preferences > Security & Privacy > Microphone\n' +
                '4. Closing other apps that might be using the microphone');
            return;
        }
        
        // Reset detection state
        this.lastDetectedNote = null;
        this.lastDetectionTime = 0;
        
        detector.startListening((note, frequency) => {
            // Only process if we're not already processing
            if (this.isProcessing) return;
            
            const now = Date.now();
            const noteKey = `${note.note}${note.octave}`;
            
            // Debounce: ignore if same note detected within 300ms
            if (this.lastDetectedNote === noteKey && (now - this.lastDetectionTime) < 300) {
                return;
            }
            
            // If metronome is enabled, only accept notes near the beat
            if (this.settings.metronomeEnabled && Metronome.isRunning) {
                const beatInterval = (60 / this.settings.tempo) * 1000;
                const timeUntilNextBeat = this.nextBeatTime - now;
                const beatWindow = beatInterval * 0.4; // 40% of beat interval window (allows some flexibility)
                
                // Check if we're within the beat window (before the next beat)
                // Allow notes slightly before the beat (up to 40% of interval) or right at the beat
                const isNearBeat = timeUntilNextBeat >= -beatWindow && timeUntilNextBeat <= beatWindow;
                
                if (!isNearBeat) {
                    Logger.debug('Note detected but not on beat', { 
                        note: noteKey, 
                        timeUntilNextBeat,
                        beatWindow,
                        nextBeatTime: this.nextBeatTime,
                        now
                    });
                    return; // Ignore notes not on the beat
                }
            }
            
            Logger.debug('Note detected from microphone', { note, frequency });
            
            // Convert detected note to input format
            const noteName = note.note.replace('#', '');
            const accidental = note.note.includes('#') ? '#' : null;
            
            // Update detection state
            this.lastDetectedNote = noteKey;
            this.lastDetectionTime = now;
            
            // Handle input with detected note
            this.handleInput(noteName, note.octave, accidental);
        });
        
        // Start metronome if enabled
        if (this.settings.metronomeEnabled) {
            this.startMetronome();
        }
        
        // Update UI indicator
        const indicator = document.getElementById('mic-indicator');
        if (indicator) {
            indicator.classList.remove('bg-red-500');
            indicator.classList.add('bg-green-500');
        }
    },

    stopMicrophone: function() {
        if (PitchDetector.isListening) {
            if (typeof window !== 'undefined' && window.PitchDetectorAdapter && window.PitchDetectorAdapter.currentImplementation) {
                window.PitchDetectorAdapter.stopListening();
            } else {
                PitchDetector.stopListening();
            }
            PitchDetector.cleanup();
        }
        
        this.stopMetronome();
        
        // Update UI indicator
        const indicator = document.getElementById('mic-indicator');
        if (indicator) {
            indicator.classList.remove('bg-green-500');
            indicator.classList.add('bg-red-500');
        }
    },

    startMetronome: function() {
        Metronome.setTempo(this.settings.tempo);
        const beatInterval = (60 / this.settings.tempo) * 1000;
        this.nextBeatTime = Date.now() + beatInterval; // Set initial next beat time
        
        Metronome.start((beat) => {
            // Update next beat time based on current time and interval
            const beatInterval = (60 / this.settings.tempo) * 1000;
            this.nextBeatTime = Date.now() + beatInterval;
            
            // Update visual indicator
            this.updateMetronomeVisual(beat);
        });
        
        // Initialize visual indicator
        this.updateMetronomeVisual(0);
        
        // Start beat meter animation
        this.startBeatMeter();
    },

    updateMetronomeVisual: function(currentBeat) {
        const beats = document.querySelectorAll('.metronome-beat');
        beats.forEach((beatEl, index) => {
            if (index === currentBeat) {
                // Active beat - larger and brighter
                beatEl.classList.remove('bg-slate-600', 'w-4', 'h-4');
                beatEl.classList.add('bg-indigo-500', 'w-6', 'h-6', 'ring-2', 'ring-indigo-400');
            } else if (index === 0 && currentBeat === 0) {
                // Downbeat (beat 1) - special styling
                beatEl.classList.remove('bg-slate-600', 'w-4', 'h-4');
                beatEl.classList.add('bg-indigo-600', 'w-6', 'h-6', 'ring-2', 'ring-indigo-400');
            } else {
                // Inactive beat
                beatEl.classList.remove('bg-indigo-500', 'bg-indigo-600', 'w-6', 'h-6', 'ring-2', 'ring-indigo-400');
                beatEl.classList.add('bg-slate-600', 'w-4', 'h-4');
            }
        });
    },

    stopMetronome: function() {
        Metronome.stop();
        // Reset visual indicator
        const beats = document.querySelectorAll('.metronome-beat');
        beats.forEach((beatEl) => {
            beatEl.classList.remove('bg-indigo-500', 'bg-indigo-600', 'w-6', 'h-6', 'ring-2', 'ring-indigo-400');
            beatEl.classList.add('bg-slate-600', 'w-4', 'h-4');
        });
        
        // Stop beat meter animation
        this.stopBeatMeter();
    },

    startBeatMeter: function() {
        if (this.beatMeterAnimation) {
            cancelAnimationFrame(this.beatMeterAnimation);
        }
        
        const meter = document.getElementById('beat-meter');
        const indicator = document.getElementById('beat-indicator');
        const zone = document.getElementById('acceptance-zone');
        
        if (!meter || !indicator || !zone) return;
        
        const meterWidth = meter.offsetWidth;
        const beatInterval = (60 / this.settings.tempo) * 1000;
        const windowPercent = 0.4; // 40% of beat interval is the acceptance window
        
        // Position and size acceptance zone (centered around beat)
        const zoneCenter = 0.5; // Center of meter
        const zoneWidth = windowPercent;
        const zoneLeft = (zoneCenter - zoneWidth / 2) * meterWidth;
        const zoneWidthPx = zoneWidth * meterWidth;
        
        zone.style.left = zoneLeft + 'px';
        zone.style.width = zoneWidthPx + 'px';
        
        let startTime = Date.now();
        
        const animate = () => {
            if (!Metronome.isRunning) {
                this.beatMeterAnimation = null;
                return;
            }
            
            const elapsed = (Date.now() - startTime) % beatInterval;
            const progress = elapsed / beatInterval;
            
            // Calculate position (0 to 1, back and forth)
            // Use sine wave for smooth back-and-forth motion
            // Map to 0-1 range: sin gives -1 to 1, we want 0 to 1
            const position = Math.sin(progress * Math.PI * 2) * 0.5 + 0.5;
            
            // Position indicator (accounting for indicator width)
            const indicatorWidth = 12; // 3 * 4 (w-3 = 12px)
            const indicatorPos = position * (meterWidth - indicatorWidth);
            indicator.style.left = indicatorPos + 'px';
            
            // Change indicator color based on whether it's in the green zone
            const distanceFromCenter = Math.abs(position - zoneCenter);
            if (distanceFromCenter < zoneWidth / 2) {
                // In green zone
                indicator.classList.remove('bg-indigo-500');
                indicator.classList.add('bg-green-400', 'ring-2', 'ring-green-300');
            } else {
                // Outside green zone
                indicator.classList.remove('bg-green-400', 'ring-2', 'ring-green-300');
                indicator.classList.add('bg-indigo-500');
            }
            
            this.beatMeterAnimation = requestAnimationFrame(animate);
        };
        
        animate();
    },

    stopBeatMeter: function() {
        if (this.beatMeterAnimation) {
            cancelAnimationFrame(this.beatMeterAnimation);
            this.beatMeterAnimation = null;
        }
        
        // Reset indicator position
        const indicator = document.getElementById('beat-indicator');
        if (indicator) {
            indicator.style.left = '50%';
            indicator.classList.remove('bg-green-400', 'ring-2', 'ring-green-300');
            indicator.classList.add('bg-indigo-500');
        }
    },

    setupPiano: function() {
        const container = document.getElementById('piano-container');
        container.innerHTML = '';
        const startOctave = 2;
        const endOctave = 5;
        const noteNames = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        
        for (let o = startOctave; o <= endOctave; o++) {
            noteNames.forEach((n, i) => {
                const wk = document.createElement('div');
                wk.className = 'piano-key white-key flex-1 border-r border-slate-300 cursor-pointer flex items-end justify-center pb-2 text-slate-400 text-xs hover:bg-gray-100 relative';
                wk.dataset.note = n;
                wk.dataset.octave = o;
                if (n === 'C') wk.textContent = 'C' + o;
                wk.onmousedown = () => this.handleInput(n, o, null);
                
                const hasSharp = ['C', 'D', 'F', 'G', 'A'].includes(n);
                if (hasSharp) {
                    const bk = document.createElement('div');
                    bk.className = 'piano-key black-key cursor-pointer hover:bg-slate-900';
                    bk.dataset.note = n;
                    bk.dataset.accidental = '#';
                    bk.dataset.octave = o;
                    bk.onmousedown = (e) => { e.stopPropagation(); this.handleInput(n, o, '#'); };
                    wk.appendChild(bk);
                }
                container.appendChild(wk);
            });
        }
    },

    setupEventListeners: function() {
        const modal = document.getElementById('settings-modal');
        document.getElementById('btn-settings').onclick = () => modal.classList.remove('hidden');
        document.getElementById('btn-close-settings').onclick = () => {
            this.saveSettings();
            modal.classList.add('hidden');
        };
        
        document.getElementById('btn-reset-data').onclick = () => {
            if(confirm("Reset all learning progress?")) {
                this.srs.resetData();
                this.updateStats();
                this.nextRound();
                modal.classList.add('hidden');
            }
        };
        
        document.getElementById('btn-export-logs').onclick = () => {
            this.exportAllLogs();
        };
        
        // Pitch detection algorithm selector
        const pitchAlgorithmSelect = document.getElementById('pitch-algorithm-select');
        if (pitchAlgorithmSelect) {
            // Load saved algorithm
            const savedAlgorithm = localStorage.getItem('pitchDetectionAlgorithm') || 'autocorrelation';
            pitchAlgorithmSelect.value = savedAlgorithm;
            
            pitchAlgorithmSelect.onchange = (e) => {
                const algorithm = e.target.value;
                localStorage.setItem('pitchDetectionAlgorithm', algorithm);
                if (PitchDetectorAdapter) {
                    PitchDetectorAdapter.setAlgorithm(algorithm);
                    Logger.info('Pitch detection algorithm changed', { algorithm });
                }
            };
        }
        
        document.getElementById('btn-stop-mic').onclick = () => {
            this.stopMicrophone();
            // Switch back to buttons mode
            document.querySelector('input[name="input_mode"][value="buttons"]').checked = true;
            this.saveSettings();
        };
        
        // Calibration mode
        document.getElementById('btn-calibrate-mic').onclick = () => {
            const calModal = document.getElementById('calibration-modal');
            calModal.classList.remove('hidden');
            // Reset guided calibration state
            this.guidedCalibration.active = false;
            this.guidedCalibration.currentStringIndex = 0;
            this.guidedCalibration.logs = [];
            this.guidedCalibration.sessionLog = [];
            document.getElementById('guided-calibration').classList.remove('hidden');
            document.getElementById('free-calibration').classList.add('hidden');
            document.getElementById('cal-progress').classList.add('hidden');
            document.getElementById('btn-save-cal-logs').classList.add('hidden');
            document.getElementById('btn-export-cal-logs').classList.add('hidden');
        };
        
        document.getElementById('btn-close-calibration').onclick = () => {
            this.stopCalibration();
            this.stopGuidedCalibration();
            const calModal = document.getElementById('calibration-modal');
            calModal.classList.add('hidden');
        };
        
        // Also stop calibration if modal is closed by clicking outside
        document.getElementById('calibration-modal').onclick = (e) => {
            if (e.target.id === 'calibration-modal') {
                this.stopCalibration();
                this.stopGuidedCalibration();
                e.target.classList.add('hidden');
            }
        };
        
        document.getElementById('btn-start-calibration').onclick = () => {
            if (this.isCalibrating) {
                this.stopCalibration();
            } else {
                this.startCalibration();
            }
        };
        
        document.getElementById('btn-start-guided-cal').onclick = () => {
            if (this.guidedCalibration.active) {
                this.stopGuidedCalibration();
            } else {
                this.startGuidedCalibration();
            }
        };
        
        document.getElementById('btn-skip-guided').onclick = () => {
            document.getElementById('guided-calibration').classList.add('hidden');
            document.getElementById('free-calibration').classList.remove('hidden');
        };
        
        document.getElementById('btn-save-cal-logs').onclick = () => {
            this.saveCalibrationLogs();
        };
        
        const exportCalBtn = document.getElementById('btn-export-cal-logs');
        if (exportCalBtn) {
            exportCalBtn.onclick = () => {
                console.log('Export button clicked');
                this.exportCalibrationSessionLogs();
            };
        } else {
            console.error('btn-export-cal-logs button not found');
        }
        
        document.getElementById('btn-next-string').onclick = () => {
            this.advanceToNextString();
        };
        
        // Metronome tempo slider
        const tempoSlider = document.getElementById('tempo-slider');
        const tempoDisplay = document.getElementById('tempo-display');
        if (tempoSlider && tempoDisplay) {
            tempoSlider.oninput = () => {
                tempoDisplay.textContent = tempoSlider.value;
                // Restart meter if running
                if (this.settings.mode === 'microphone' && Metronome.isRunning) {
                    this.stopBeatMeter();
                    this.startBeatMeter();
                }
            };
        }
        
        document.getElementById('piano-container').oncontextmenu = (e) => e.preventDefault();
        
        // Log app initialization
        Logger.info('App initialized', {
            unlockedCount: this.srs.data.unlockedCount,
            settings: this.settings
        });
    },

    startCalibration: async function() {
        if (this.isCalibrating) return;
        
        // Stop main microphone if running
        const wasMicRunning = PitchDetector.isListening;
        if (wasMicRunning) {
            if (typeof window !== 'undefined' && window.PitchDetectorAdapter && window.PitchDetectorAdapter.currentImplementation) {
                window.PitchDetectorAdapter.stopListening();
            } else {
                PitchDetector.stopListening();
            }
        }
        
        const success = await PitchDetectorAdapter.init();
        if (!success) {
            alert('Failed to access microphone. Please check permissions.');
            // Restore microphone if it was running
            if (wasMicRunning) {
                this.startMicrophone();
            }
            return;
        }
        
        this.isCalibrating = true;
        const history = [];
        
        // Update UI
        document.getElementById('cal-indicator').classList.remove('bg-red-500');
        document.getElementById('cal-indicator').classList.add('bg-green-500');
        document.getElementById('cal-status-text').textContent = 'Listening...';
        document.getElementById('btn-start-calibration').textContent = 'Stop Calibration';
        document.getElementById('cal-history').innerHTML = '<div class="text-xs text-slate-500 text-center">No detections yet</div>';
        
        // Create separate detector for calibration (doesn't interfere with main app)
        const detector = {
            analyser: PitchDetector.analyser,
            dataArray: PitchDetector.dataArray,
            audioContext: PitchDetector.audioContext,
            isRunning: true,
            animationFrame: null
        };
        
        const detectPitch = () => {
            if (!this.isCalibrating) return;
            
            detector.analyser.getFloatTimeDomainData(detector.dataArray);
            
            // Calculate signal strength (RMS)
            let sum = 0;
            for (let i = 0; i < detector.dataArray.length; i++) {
                sum += detector.dataArray[i] * detector.dataArray[i];
            }
            const rms = Math.sqrt(sum / detector.dataArray.length);
            const signalStrength = Math.min(100, (rms * 1000)); // Scale to 0-100
            
            // Update signal strength bar
            document.getElementById('cal-signal-bar').style.width = signalStrength + '%';
            
            // Detect pitch
            const pitch = PitchDetector.autocorrelate(detector.dataArray, detector.audioContext.sampleRate);
            
            if (pitch > 0 && signalStrength > 5) { // Minimum signal threshold
                const note = PitchDetector.frequencyToNote(pitch);
                
                if (!note) return; // Invalid note
                
                if (note) {
                    // Update display
                    const noteDisplay = note.note + note.octave;
                    document.getElementById('cal-detected-note').innerHTML = `<span class="text-white">${noteDisplay}</span>`;
                    document.getElementById('cal-frequency').textContent = pitch.toFixed(1);
                    document.getElementById('cal-octave').textContent = note.octave;
                    
                    // Add to history
                    const timestamp = new Date().toLocaleTimeString();
                    history.unshift({
                        note: noteDisplay,
                        frequency: pitch.toFixed(1),
                        octave: note.octave,
                        time: timestamp
                    });
                    
                    // Keep only last 10
                    if (history.length > 10) history.pop();
                    
                    // Update history display
                    const historyHtml = history.map(h => 
                        `<div class="text-xs text-slate-300 flex justify-between">
                            <span class="font-mono">${h.note}</span>
                            <span class="text-slate-500">${h.frequency}Hz</span>
                            <span class="text-slate-500">${h.time}</span>
                        </div>`
                    ).join('');
                    document.getElementById('cal-history').innerHTML = historyHtml || '<div class="text-xs text-slate-500 text-center">No detections yet</div>';
                }
            } else {
                // No detection
                if (signalStrength < 5) {
                    document.getElementById('cal-detected-note').innerHTML = '<span class="text-slate-500">--</span>';
                    document.getElementById('cal-frequency').textContent = '0.0';
                    document.getElementById('cal-octave').textContent = '--';
                }
            }
            
            detector.animationFrame = requestAnimationFrame(detectPitch);
        };
        
        detectPitch();
        this.calibrationDetector = detector;
        
        Logger.info('Calibration mode started');
    },

    stopCalibration: function() {
        this.isCalibrating = false;
        
        if (this.calibrationDetector && this.calibrationDetector.animationFrame) {
            cancelAnimationFrame(this.calibrationDetector.animationFrame);
        }
        
        // Clean up detector
        this.calibrationDetector = null;
        
        // Update UI
        document.getElementById('cal-indicator').classList.remove('bg-green-500');
        document.getElementById('cal-indicator').classList.add('bg-red-500');
        document.getElementById('cal-status-text').textContent = 'Not Listening';
        document.getElementById('btn-start-calibration').textContent = 'Start Calibration';
        document.getElementById('cal-detected-note').innerHTML = '<span class="text-slate-500">--</span>';
        document.getElementById('cal-frequency').textContent = '0.0';
        document.getElementById('cal-octave').textContent = '--';
        document.getElementById('cal-signal-bar').style.width = '0%';
        
        Logger.info('Calibration mode stopped');
    },

    startGuidedCalibration: async function() {
        if (this.guidedCalibration.active) return;
        
        // Stop main microphone if running
        const wasMicRunning = PitchDetector.isListening;
        if (wasMicRunning) {
            if (typeof window !== 'undefined' && window.PitchDetectorAdapter && window.PitchDetectorAdapter.currentImplementation) {
                window.PitchDetectorAdapter.stopListening();
            } else {
                PitchDetector.stopListening();
            }
        }
        
        const success = await PitchDetectorAdapter.init();
        if (!success) {
            alert('Failed to access microphone. Please check permissions.');
            return;
        }
        
        this.guidedCalibration.active = true;
        this.guidedCalibration.currentStringIndex = 0;
        this.guidedCalibration.logs = [];
        this.guidedCalibration.sessionLog = []; // Start new session log
        
        // Update UI
        document.getElementById('cal-progress').classList.remove('hidden');
        document.getElementById('btn-start-guided-cal').textContent = 'Stop Calibration';
        document.getElementById('btn-next-string').classList.remove('hidden');
        document.getElementById('btn-export-cal-logs').classList.add('hidden'); // Hide until stopped
        this.updateGuidedCalibrationUI();
        
        // Create detector for guided calibration
        // For calibration, we'll use the adapter but need direct access to audio data
        // We'll create a custom callback that processes the audio buffer
        const detector = {
            isRunning: true,
            animationFrame: null,
            lastDetection: null,
            detectionCount: 0,
            detections: [],
            analyser: null,
            dataArray: null,
            audioContext: null
        };
        
        // Get audio context from adapter's current implementation
        // For autocorrelation, we can access directly; for others, we'll use the callback
        const currentImpl = PitchDetectorAdapter.currentImplementation;
        if (currentImpl && currentImpl.audioContext) {
            detector.analyser = currentImpl.analyser;
            detector.dataArray = currentImpl.dataArray;
            detector.audioContext = currentImpl.audioContext;
        } else if (PitchDetector.audioContext) {
            // Fallback to original PitchDetector
            detector.analyser = PitchDetector.analyser;
            detector.dataArray = PitchDetector.dataArray;
            detector.audioContext = PitchDetector.audioContext;
        }
        
        // Initialize detector state
        detector.currentString = this.guidedCalibration.strings[this.guidedCalibration.currentStringIndex];
        detector.stringStartTime = Date.now();
        
        const detectPitch = () => {
            if (!this.guidedCalibration.active || !detector.analyser) return;
            
            // Get current string from index (in case it changed)
            const currentString = this.guidedCalibration.strings[this.guidedCalibration.currentStringIndex];
            
            detector.analyser.getFloatTimeDomainData(detector.dataArray);
            
            // Calculate signal strength
            let sum = 0;
            for (let i = 0; i < detector.dataArray.length; i++) {
                sum += detector.dataArray[i] * detector.dataArray[i];
            }
            const rms = Math.sqrt(sum / detector.dataArray.length);
            const signalStrength = Math.min(100, (rms * 1000));
            
            // Update signal strength display
            document.getElementById('cal-guided-signal-bar').style.width = signalStrength + '%';
            
            // Detect pitch - use adapter's current implementation or fallback to autocorrelation
            let pitch = -1;
            if (PitchDetectorAdapter && PitchDetectorAdapter.config.algorithm === 'autocorrelation' && PitchDetector.autocorrelate) {
                pitch = PitchDetector.autocorrelate(detector.dataArray, detector.audioContext.sampleRate);
            } else if (currentImpl && currentImpl.detector) {
                // For Pitchfinder implementations
                pitch = currentImpl.detector(detector.dataArray);
            } else if (typeof Pitchy !== 'undefined' && Pitchy.detectPitch) {
                // For Pitchy
                pitch = Pitchy.detectPitch(detector.dataArray, detector.audioContext.sampleRate);
            } else if (PitchDetector.autocorrelate) {
                // Fallback to autocorrelation
                pitch = PitchDetector.autocorrelate(detector.dataArray, detector.audioContext.sampleRate);
            }
            
            // Lower signal threshold and be more lenient with detections
            const signalThreshold = 2; // Lowered from 5
            
            if (pitch > 0 && signalStrength > signalThreshold) {
                const note = PitchDetector.frequencyToNote(pitch);
                
                if (note) {
                    // Update display
                    const noteDisplay = note.note + note.octave;
                    const match = (note.note === currentString.note && note.octave === currentString.octave);
                    const colorClass = match ? 'text-green-400' : 'text-red-400';
                    document.getElementById('cal-guided-detected-note').innerHTML = `<span class="${colorClass}">${noteDisplay}</span>`;
                    document.getElementById('cal-guided-frequency').textContent = pitch.toFixed(1);
                    
                    const elapsed = Date.now() - (detector.stringStartTime || Date.now());
                    
                    // Record detection
                    const detection = {
                        timestamp: elapsed,
                        detectedNote: note.note,
                        detectedOctave: note.octave,
                        detectedFrequency: pitch,
                        expectedNote: currentString.note,
                        expectedOctave: currentString.octave,
                        expectedFrequency: currentString.expectedFreq,
                        signalStrength: signalStrength,
                        match: match
                    };
                    
                    // Only add if it's a new detection (avoid duplicates)
                    // But be less strict - allow same note if frequency changed significantly or enough time passed
                    const lastDetection = detector.detections[detector.detections.length - 1];
                    const timeSinceLastDetection = lastDetection ? (elapsed - lastDetection.timestamp) : Infinity;
                    
                    if (!lastDetection || 
                        lastDetection.detectedNote !== note.note || 
                        lastDetection.detectedOctave !== note.octave ||
                        Math.abs(lastDetection.detectedFrequency - pitch) > 3 || // Lowered from 5
                        timeSinceLastDetection > 500) { // Allow same note if 500ms passed
                        detector.detections.push(detection);
                        
                        // Log to calibration session log (concise)
                        this.guidedCalibration.sessionLog.push({
                            timestamp: Date.now(),
                            string: currentString.name,
                            expected: `${currentString.note}${currentString.octave}`,
                            expectedFreq: currentString.expectedFreq,
                            detected: noteDisplay,
                            detectedFreq: Math.round(pitch * 100) / 100,
                            match: match,
                            signalStrength: Math.round(signalStrength * 100) / 100
                        });
                    }
                    
                    // Count consecutive matches
                    if (match) {
                        detector.detectionCount++;
                    } else {
                        detector.detectionCount = 0; // Reset on mismatch
                    }
                }
            } else {
                // No detection - show why
                if (signalStrength <= signalThreshold) {
                    document.getElementById('cal-guided-detected-note').innerHTML = '<span class="text-slate-500">--</span>';
                    document.getElementById('cal-guided-frequency').textContent = '0.0';
                } else if (pitch <= 0) {
                    // Pitch detection failed but signal is strong
                    document.getElementById('cal-guided-detected-note').innerHTML = '<span class="text-yellow-400">No pitch</span>';
                    document.getElementById('cal-guided-frequency').textContent = '0.0';
                }
            }
            
            detector.animationFrame = requestAnimationFrame(detectPitch);
        };
        
        detectPitch();
        this.calibrationDetector = detector;
        
        const initialString = this.guidedCalibration.strings[this.guidedCalibration.currentStringIndex];
        Logger.info('Guided calibration started', { string: initialString.name });
    },

    advanceToNextString: function() {
        if (!this.guidedCalibration.active || !this.calibrationDetector) return;
        
        const detector = this.calibrationDetector;
        const currentString = this.guidedCalibration.strings[this.guidedCalibration.currentStringIndex];
        
        // Save log for current string (even if no matches)
        this.guidedCalibration.logs.push({
            string: currentString.name,
            expected: `${currentString.note}${currentString.octave}`,
            expectedFrequency: currentString.expectedFreq,
            detections: [...detector.detections], // Copy array
            bestMatch: detector.detections.length > 0 ? {
                note: detector.detections[detector.detections.length - 1].detectedNote,
                octave: detector.detections[detector.detections.length - 1].detectedOctave,
                frequency: detector.detections[detector.detections.length - 1].detectedFrequency
            } : null,
            accuracy: this.calculateAccuracy(detector.detections, currentString),
            totalDetections: detector.detections.length
        });
        
        // Move to next string
        this.guidedCalibration.currentStringIndex++;
        
        if (this.guidedCalibration.currentStringIndex >= this.guidedCalibration.strings.length) {
            // All strings done
            this.completeGuidedCalibration();
            return;
        }
        
        // Reset for next string
        const nextString = this.guidedCalibration.strings[this.guidedCalibration.currentStringIndex];
        detector.detections = [];
        detector.detectionCount = 0;
        detector.stringStartTime = Date.now();
        detector.currentString = nextString;
        
        // Reset display
        document.getElementById('cal-guided-detected-note').innerHTML = '<span class="text-slate-500">--</span>';
        document.getElementById('cal-guided-frequency').textContent = '0.0';
        document.getElementById('cal-guided-signal-bar').style.width = '0%';
        
        this.updateGuidedCalibrationUI();
        
        Logger.info('Advanced to next string', { 
            from: currentString.name, 
            to: nextString.name,
            previousLog: this.guidedCalibration.logs[this.guidedCalibration.logs.length - 1]
        });
    },

    updateGuidedCalibrationUI: function() {
        const currentString = this.guidedCalibration.strings[this.guidedCalibration.currentStringIndex];
        document.getElementById('cal-current-string').innerHTML = `<span class="text-indigo-400">${currentString.name}</span>`;
        
        // Update progress bars
        document.querySelectorAll('.cal-string-progress').forEach((bar, index) => {
            if (index < this.guidedCalibration.currentStringIndex) {
                bar.classList.remove('bg-slate-700');
                bar.classList.add('bg-green-500');
            } else if (index === this.guidedCalibration.currentStringIndex) {
                bar.classList.remove('bg-slate-700', 'bg-green-500');
                bar.classList.add('bg-indigo-500');
            } else {
                bar.classList.remove('bg-indigo-500', 'bg-green-500');
                bar.classList.add('bg-slate-700');
            }
        });
    },

    completeGuidedCalibration: function() {
        this.guidedCalibration.active = false;
        
        if (this.calibrationDetector && this.calibrationDetector.animationFrame) {
            cancelAnimationFrame(this.calibrationDetector.animationFrame);
        }
        
        document.getElementById('cal-current-string').innerHTML = '<span class="text-green-400">✓ All strings calibrated!</span>';
        document.getElementById('btn-start-guided-cal').textContent = 'Restart Calibration';
        document.getElementById('btn-next-string').classList.add('hidden');
        document.getElementById('btn-save-cal-logs').classList.remove('hidden');
        
        // Show export button
        if (this.guidedCalibration.sessionLog.length > 0) {
            document.getElementById('btn-export-cal-logs').classList.remove('hidden');
        }
    },

    stopGuidedCalibration: function() {
        this.guidedCalibration.active = false;
        
        if (this.calibrationDetector && this.calibrationDetector.animationFrame) {
            cancelAnimationFrame(this.calibrationDetector.animationFrame);
        }
        
        document.getElementById('btn-start-guided-cal').textContent = 'Start Guided Calibration';
        document.getElementById('btn-next-string').classList.add('hidden');
        
        // Show export button if there are logs
        if (this.guidedCalibration.sessionLog.length > 0) {
            document.getElementById('btn-export-cal-logs').classList.remove('hidden');
        }
        
        // Reset display
        document.getElementById('cal-guided-detected-note').innerHTML = '<span class="text-slate-500">--</span>';
        document.getElementById('cal-guided-frequency').textContent = '0.0';
        document.getElementById('cal-guided-signal-bar').style.width = '0%';
    },

    calculateAccuracy: function(detections, expectedString) {
        if (detections.length === 0) return 0;
        
        let correct = 0;
        let total = detections.length;
        
        detections.forEach(d => {
            if (d.match) correct++;
        });
        
        return (correct / total) * 100;
    },

    saveCalibrationLogs: function() {
        // Process logs to add analysis
        const processedLogs = this.guidedCalibration.logs.map((log, index) => {
            return this.analyzeStringLog(log, this.guidedCalibration.strings[index]);
        });
        
        const logData = {
            timestamp: new Date().toISOString(),
            calibrationType: 'Guitar String Calibration',
            
            // Quick summary for overview
            quickSummary: {
                totalStrings: this.guidedCalibration.strings.length,
                calibratedStrings: this.guidedCalibration.logs.length,
                averageAccuracy: this.guidedCalibration.logs.length > 0 
                    ? Math.round(this.guidedCalibration.logs.reduce((sum, log) => sum + (log.accuracy || 0), 0) / this.guidedCalibration.logs.length * 100) / 100
                    : 0,
                stringsByAccuracy: processedLogs.map(l => ({
                    string: l.string,
                    accuracy: l.analysis.accuracy,
                    status: l.analysis.accuracy >= 80 ? 'excellent' : 
                           l.analysis.accuracy >= 50 ? 'good' : 
                           l.analysis.accuracy >= 20 ? 'poor' : 'failed'
                }))
            },
            
            // Detailed analysis per string
            strings: processedLogs,
            
            // Overall patterns and issues
            patterns: this.analyzeOverallPatterns(processedLogs),
            
            // Full raw data (for deep analysis if needed)
            rawData: {
                strings: this.guidedCalibration.strings.map((s, i) => ({
                    string: s.name,
                    expected: `${s.note}${s.octave}`,
                    expectedFrequency: s.expectedFreq,
                    allDetections: this.guidedCalibration.logs[i]?.detections || []
                }))
            }
        };
        
        const logText = JSON.stringify(logData, null, 2);
        
        // Create and download file
        const blob = new Blob([logText], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `guitar-calibration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        Logger.info('Calibration logs saved');
    },

    analyzeStringLog: function(log, expectedString) {
        if (!log || !log.detections || log.detections.length === 0) {
            return {
                string: expectedString.name,
                expected: `${expectedString.note}${expectedString.octave}`,
                expectedFrequency: expectedString.expectedFreq,
                analysis: {
                    accuracy: 0,
                    totalDetections: 0,
                    status: 'no_data'
                }
            };
        }
        
        const detections = log.detections;
        const totalDetections = detections.length;
        const correctDetections = detections.filter(d => d.match).length;
        const accuracy = (correctDetections / totalDetections) * 100;
        
        // Group detections by note/octave to see patterns
        const detectionGroups = {};
        detections.forEach(d => {
            const key = `${d.detectedNote}${d.detectedOctave}`;
            if (!detectionGroups[key]) {
                detectionGroups[key] = {
                    note: `${d.detectedNote}${d.detectedOctave}`,
                    count: 0,
                    frequencies: [],
                    avgFrequency: 0,
                    avgSignalStrength: 0
                };
            }
            detectionGroups[key].count++;
            detectionGroups[key].frequencies.push(d.detectedFrequency);
            detectionGroups[key].avgSignalStrength += d.signalStrength;
        });
        
        // Calculate averages and find most common incorrect detection
        const groups = Object.values(detectionGroups).map(group => {
            group.avgFrequency = group.frequencies.reduce((a, b) => a + b, 0) / group.frequencies.length;
            group.avgSignalStrength = group.avgSignalStrength / group.count;
            group.percentage = (group.count / totalDetections) * 100;
            return group;
        }).sort((a, b) => b.count - a.count);
        
        const mostCommon = groups[0];
        const mostCommonIncorrect = groups.find(g => g.note !== `${expectedString.note}${expectedString.octave}`);
        
        // Frequency error analysis
        const frequencyErrors = detections.map(d => ({
            detected: d.detectedFrequency,
            expected: expectedString.expectedFreq,
            error: d.detectedFrequency - expectedString.expectedFreq,
            errorPercent: ((d.detectedFrequency - expectedString.expectedFreq) / expectedString.expectedFreq) * 100,
            isHarmonic: this.isLikelyHarmonic(d.detectedFrequency, expectedString.expectedFreq)
        }));
        
        const avgFrequencyError = frequencyErrors.reduce((sum, e) => sum + Math.abs(e.error), 0) / frequencyErrors.length;
        const avgFrequencyErrorPercent = frequencyErrors.reduce((sum, e) => sum + Math.abs(e.errorPercent), 0) / frequencyErrors.length;
        
        // Check for harmonic issues
        const harmonicDetections = frequencyErrors.filter(e => e.isHarmonic).length;
        const harmonicPercentage = (harmonicDetections / totalDetections) * 100;
        
        return {
            string: expectedString.name,
            expected: `${expectedString.note}${expectedString.octave}`,
            expectedFrequency: expectedString.expectedFreq,
            analysis: {
                accuracy: Math.round(accuracy * 100) / 100,
                totalDetections: totalDetections,
                correctDetections: correctDetections,
                status: accuracy >= 80 ? 'excellent' : 
                       accuracy >= 50 ? 'good' : 
                       accuracy >= 20 ? 'poor' : 'failed',
                
                // Detection patterns
                mostCommonDetection: mostCommon ? {
                    note: mostCommon.note,
                    count: mostCommon.count,
                    percentage: Math.round(mostCommon.percentage * 100) / 100,
                    avgFrequency: Math.round(mostCommon.avgFrequency * 100) / 100,
                    isCorrect: mostCommon.note === `${expectedString.note}${expectedString.octave}`
                } : null,
                
                mostCommonError: mostCommonIncorrect ? {
                    note: mostCommonIncorrect.note,
                    count: mostCommonIncorrect.count,
                    percentage: Math.round(mostCommonIncorrect.percentage * 100) / 100,
                    avgFrequency: Math.round(mostCommonIncorrect.avgFrequency * 100) / 100,
                    frequencyRatio: Math.round((mostCommonIncorrect.avgFrequency / expectedString.expectedFreq) * 100) / 100
                } : null,
                
                // Frequency accuracy
                frequencyAnalysis: {
                    avgError: Math.round(avgFrequencyError * 100) / 100,
                    avgErrorPercent: Math.round(avgFrequencyErrorPercent * 100) / 100,
                    harmonicIssues: {
                        count: harmonicDetections,
                        percentage: Math.round(harmonicPercentage * 100) / 100,
                        likelyIssue: harmonicPercentage > 50 ? 'detecting_harmonics' : null
                    }
                },
                
                // Top 5 detected notes (for pattern analysis)
                topDetections: groups.slice(0, 5).map(g => ({
                    note: g.note,
                    count: g.count,
                    percentage: Math.round(g.percentage * 100) / 100,
                    avgFrequency: Math.round(g.avgFrequency * 100) / 100
                }))
            }
        };
    },

    isLikelyHarmonic: function(detectedFreq, expectedFreq) {
        // Check if detected frequency is close to 2x, 3x, 4x, or 0.5x of expected
        const ratios = [2, 3, 4, 0.5, 1.5];
        for (const ratio of ratios) {
            const harmonicFreq = expectedFreq * ratio;
            const error = Math.abs(detectedFreq - harmonicFreq) / expectedFreq;
            if (error < 0.1) { // Within 10%
                return true;
            }
        }
        return false;
    },

    analyzeOverallPatterns: function(processedLogs) {
        const patterns = {
            commonIssues: [],
            frequencyRangeIssues: [],
            harmonicIssues: []
        };
        
        processedLogs.forEach(log => {
            const analysis = log.analysis;
            
            // Check for harmonic issues
            if (analysis.frequencyAnalysis?.harmonicIssues?.percentage > 50) {
                patterns.harmonicIssues.push({
                    string: log.string,
                    percentage: analysis.frequencyAnalysis.harmonicIssues.percentage,
                    issue: 'Detecting harmonics instead of fundamentals'
                });
            }
            
            // Check for common wrong detections
            if (analysis.mostCommonError) {
                const error = analysis.mostCommonError;
                if (error.percentage > 30) {
                    patterns.commonIssues.push({
                        string: log.string,
                        expected: log.expected,
                        mostCommonlyDetectedAs: error.note,
                        frequency: error.avgFrequency,
                        ratio: error.frequencyRatio,
                        percentage: error.percentage,
                        likelyCause: error.frequencyRatio > 1.8 && error.frequencyRatio < 2.2 ? 'octave_error' :
                                   error.frequencyRatio > 0.4 && error.frequencyRatio < 0.6 ? 'half_octave_error' :
                                   'frequency_detection_error'
                    });
                }
            }
            
            // Check frequency range issues
            if (analysis.frequencyAnalysis?.avgErrorPercent > 50) {
                patterns.frequencyRangeIssues.push({
                    string: log.string,
                    expected: log.expectedFrequency,
                    avgDetected: analysis.mostCommonDetection?.avgFrequency || 0,
                    errorPercent: analysis.frequencyAnalysis.avgErrorPercent
                });
            }
        });
        
        return patterns;
    },

    exportAllLogs: function() {
        // Export both app logs and calibration data if available
        const exportData = {
            timestamp: new Date().toISOString(),
            appLogs: Logger.getLogs(),
            calibrationData: this.guidedCalibration.logs.length > 0 ? {
                strings: this.guidedCalibration.strings,
                logs: this.guidedCalibration.logs
            } : null,
            settings: {
                mode: this.settings.mode,
                clefs: this.settings.clefs,
                keys: this.settings.keys,
                metronomeEnabled: this.settings.metronomeEnabled,
                tempo: this.settings.tempo
            },
            systemInfo: {
                userAgent: navigator.userAgent,
                sampleRate: PitchDetector.audioContext ? PitchDetector.audioContext.sampleRate : 'not initialized',
                isListening: PitchDetector.isListening,
                isCalibrating: this.isCalibrating,
                guidedCalibrationActive: this.guidedCalibration.active
            }
        };
        
        const logText = JSON.stringify(exportData, null, 2);
        
        // Create and download file
        const blob = new Blob([logText], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sightread-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        Logger.info('All logs exported');
    },

    exportCalibrationSessionLogs: function() {
        console.log('Export calibration session logs called', {
            hasSessionLog: !!this.guidedCalibration.sessionLog,
            logLength: this.guidedCalibration.sessionLog?.length || 0,
            sessionLog: this.guidedCalibration.sessionLog
        });
        
        if (!this.guidedCalibration.sessionLog || this.guidedCalibration.sessionLog.length === 0) {
            alert('No calibration session logs to export. Please run calibration first.');
            return;
        }
        
        // Analyze the session log to create a concise summary
        const summary = {
            totalDetections: this.guidedCalibration.sessionLog.length,
            strings: {},
            accuracy: {}
        };
        
        // Group by string
        this.guidedCalibration.sessionLog.forEach(log => {
            if (!summary.strings[log.string]) {
                summary.strings[log.string] = {
                    expected: log.expected,
                    expectedFreq: log.expectedFreq,
                    detections: [],
                    correct: 0,
                    total: 0
                };
            }
            
            summary.strings[log.string].detections.push({
                detected: log.detected,
                detectedFreq: log.detectedFreq,
                match: log.match,
                signalStrength: log.signalStrength,
                timestamp: new Date(log.timestamp).toISOString()
            });
            
            summary.strings[log.string].total++;
            if (log.match) {
                summary.strings[log.string].correct++;
            }
        });
        
        // Calculate accuracy per string
        Object.keys(summary.strings).forEach(string => {
            const s = summary.strings[string];
            summary.accuracy[string] = {
                accuracy: s.total > 0 ? Math.round((s.correct / s.total) * 100 * 100) / 100 : 0,
                correct: s.correct,
                total: s.total
            };
        });
        
        // Create concise export
        const exportData = {
            timestamp: new Date().toISOString(),
            sessionSummary: {
                totalDetections: summary.totalDetections,
                accuracyByString: summary.accuracy
            },
            detections: this.guidedCalibration.sessionLog.map(log => ({
                string: log.string,
                expected: `${log.expected} (${log.expectedFreq}Hz)`,
                detected: `${log.detected} (${log.detectedFreq}Hz)`,
                match: log.match,
                signalStrength: log.signalStrength
            })),
            // Grouped by string for easier analysis
            byString: Object.keys(summary.strings).map(string => ({
                string: string,
                expected: summary.strings[string].expected,
                expectedFreq: summary.strings[string].expectedFreq,
                accuracy: summary.accuracy[string].accuracy,
                detections: summary.strings[string].detections.map(d => ({
                    detected: d.detected,
                    detectedFreq: d.detectedFreq,
                    match: d.match,
                    signalStrength: d.signalStrength
                }))
            }))
        };
        
        const logText = JSON.stringify(exportData, null, 2);
        
        console.log('Exporting calibration session logs', {
            dataSize: logText.length,
            detections: this.guidedCalibration.sessionLog.length
        });
        
        // Create and download file
        try {
            const blob = new Blob([logText], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `calibration-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('File download initiated');
        } catch (error) {
            console.error('Error exporting logs:', error);
            alert('Error exporting logs: ' + error.message);
        }
    },

    nextRound: function() {
        this.isProcessing = false;
        this.sequenceIndex = 0;
        this.currentSequence = [];
        this.lastDetectedNote = null; // Reset detection state

        Logger.debug('Starting new round', {
            unlockedCount: this.srs.data.unlockedCount,
            batchSize: this.settings.batchSize
        });

        // Check for regression first (reduce unlocked if struggling)
        this.settings.clefs.forEach(c => this.srs.checkRegression(c));
        
        // Only check progression if we just completed a round successfully
        // (progression is now checked after successful rounds, not every round)

        const clef = this.settings.clefs[Math.floor(Math.random() * this.settings.clefs.length)];
        const key = this.settings.keys[Math.floor(Math.random() * this.settings.keys.length)];

        for(let i=0; i<this.settings.batchSize; i++) {
            this.currentSequence.push(this.srs.generateCard(clef, key));
        }

        Logger.debug('Generated sequence', {
            clef,
            key,
            batchSize: this.currentSequence.length,
            sequence: this.currentSequence.map(c => `${c.note}${c.octave}`)
        });

        this.renderSequence();
        this.lastNoteTime = Date.now(); // Start timer for first note
        
        // Reset next beat time for metronome
        if (this.settings.mode === 'microphone' && this.settings.metronomeEnabled && Metronome.isRunning) {
            this.nextBeatTime = Date.now() + (60 / this.settings.tempo) * 1000;
        }
    },

    renderSequence: function() {
        const div = document.getElementById('notation-container');
        div.innerHTML = ''; 

        const VF = Vex.Flow;
        const renderer = new VF.Renderer(div, VF.Renderer.Backends.SVG);
        const width = Math.min(800, window.innerWidth - 30); 
        renderer.resize(width, 200);
        const context = renderer.getContext();

        const clef = this.currentSequence[0].clef;
        const keySig = this.currentSequence[0].keySig;

        const stave = new VF.Stave(10, 40, width - 20);
        stave.addClef(clef).addKeySignature(keySig);
        stave.setContext(context).draw();

        const notes = this.currentSequence.map((card, index) => {
            let keyString = `${card.note.toLowerCase()}`;
            if (card.accidental) keyString += card.accidental;
            keyString += `/${card.octave}`;

            const vfNote = new VF.StaveNote({
                clef: card.clef,
                keys: [keyString],
                duration: "q",
                auto_stem: true
            });

            // Add Accidental if needed
            const sigNotes = KEY_SIGNATURES[keySig];
            const noteNameFull = card.note + (card.accidental || '');
            let needsVisualAccidental = false;
            if (card.accidental) {
                const isInSig = sigNotes.some(s => s === noteNameFull);
                if (!isInSig) needsVisualAccidental = true;
            } 
            if (needsVisualAccidental) {
               vfNote.addAccidental(0, new VF.Accidental(card.accidental));
            }

            // Coloring Logic
            if (index < this.sequenceIndex) {
                vfNote.setStyle({fillStyle: "#22c55e", strokeStyle: "#22c55e"}); // Green
            } else if (index === this.sequenceIndex) {
                vfNote.setStyle({fillStyle: "#4f46e5", strokeStyle: "#4f46e5"}); // Blue (Active)
            } else {
                vfNote.setStyle({fillStyle: "black", strokeStyle: "black"});
            }

            return vfNote;
        });

        const voice = new VF.Voice({num_beats: this.currentSequence.length, beat_value: 4});
        voice.addTickables(notes);
        new VF.Formatter().joinVoices([voice]).format([voice], width - 60);
        voice.draw(context, stave);
    },

    handleInput: function(note, octave, accidental) {
        if (this.isProcessing) return;
        
        // Don't play audio in microphone mode to avoid feedback
        if (this.settings.mode !== 'microphone') {
            AudioEngine.init();
            let freqNote = note; 
            if (accidental) freqNote += accidental;
            AudioEngine.playTone(getFrequency(freqNote, octave));
        }

        const targetCard = this.currentSequence[this.sequenceIndex];
        if (!targetCard) return;

        const inputTime = Date.now();
        const delta = inputTime - this.lastNoteTime;

        const targetNote = targetCard.note;
        const targetAcc = targetCard.accidental;
        
        let inputNote = note;
        let inputAcc = accidental;

        const isEnharmonic = (n1, a1, n2, a2) => {
            const map = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
            const i1 = n1 + (a1||'');
            const i2 = n2 + (a2||'');
            if (i1 === i2) return true;
            if (map[i1] === i2) return true;
            if (map[i2] === i1) return true;
            return false;
        };

        const correctNote = isEnharmonic(inputNote, inputAcc, targetNote, targetAcc);
        let correctOctave = true;
        if (this.settings.mode === 'piano') {
            correctOctave = (octave === targetCard.octave);
        }

        if (correctNote && correctOctave) {
            // Record with Time Delta
            const resultType = this.srs.recordResult(targetCard.id, true, delta);
            this.sequenceIndex++;
            this.lastNoteTime = Date.now(); // Reset timer for next note
            
            // Advance metronome beat when correct note is played
            if (this.settings.metronomeEnabled && Metronome.isRunning) {
                const beatInterval = (60 / this.settings.tempo) * 1000;
                this.nextBeatTime = Date.now() + beatInterval;
            }
            
            if (this.sequenceIndex >= this.currentSequence.length) {
                // Round complete - check for progression only after successful completion
                Logger.info('Round completed successfully, checking progression', {
                    sequenceLength: this.currentSequence.length,
                    unlockedCount: this.srs.data.unlockedCount
                });
                this.settings.clefs.forEach(c => this.srs.checkProgression(c));
                this.provideFeedback(true, resultType);
            } else {
                // Immediate mini-feedback for speed
                if (resultType === 'slow') {
                    this.flashFeedback('slow');
                }
                this.renderSequence();
            }
        } else {
            this.srs.recordResult(targetCard.id, false, delta);
            this.flashFeedback('wrong');
            // Check for regression after wrong answers
            this.settings.clefs.forEach(c => this.srs.checkRegression(c));
        }
        this.updateStats();
    },

    flashFeedback: function(type) {
        const mainArea = document.getElementById('main-area');
        mainArea.classList.remove('feedback-correct', 'feedback-wrong', 'feedback-slow');
        void mainArea.offsetWidth; // trigger reflow
        
        let cls = 'feedback-wrong';
        if (type === 'correct') cls = 'feedback-correct';
        if (type === 'slow') cls = 'feedback-slow';
        
        mainArea.classList.add(cls);
    },

    provideFeedback: function(isRoundComplete, lastResultType) {
        this.isProcessing = true;
        this.flashFeedback('correct');
        
        const feedbackEl = document.getElementById('feedback-text');
        
        let msg = "Round Complete!";
        let col = "text-green-500";
        
        // Check if the user struggled with speed in this round
        // (Simplified: just check last note for now, or could check average)
        if (lastResultType === 'slow') {
            msg = "Correct, but Slow";
            col = "text-orange-500";
        }

        feedbackEl.textContent = msg;
        feedbackEl.className = `absolute top-8 text-3xl font-bold transition-opacity z-10 ${col}`;
        feedbackEl.style.opacity = 1;

        this.renderSequence(); // ensure final note is green

        setTimeout(() => {
            feedbackEl.style.opacity = 0;
            this.nextRound();
        }, 1000);
    },

    updateStats: function() {
        const stats = this.srs.getStats();
        document.getElementById('unlocked-disp').textContent = stats.unlocked;
        document.getElementById('ready-disp').textContent = stats.notesReady;
        
        // Update progress bar based on how many notes are ready
        // Progress = notes ready / notes unlocked
        const pct = stats.unlocked > 0 ? Math.min(100, (stats.notesReady / stats.unlocked) * 100) : 0;
        document.getElementById('mastery-bar').style.width = pct + "%";
    }
};

window.onload = () => App.init();

