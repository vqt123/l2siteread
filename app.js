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
        
        const success = await PitchDetector.init();
        if (!success) {
            alert('Failed to access microphone. Please check permissions.');
            return;
        }
        
        // Reset detection state
        this.lastDetectedNote = null;
        this.lastDetectionTime = 0;
        
        PitchDetector.startListening((note, frequency) => {
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
            PitchDetector.stopListening();
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
            Logger.export();
        };
        
        document.getElementById('btn-stop-mic').onclick = () => {
            this.stopMicrophone();
            // Switch back to buttons mode
            document.querySelector('input[name="input_mode"][value="buttons"]').checked = true;
            this.saveSettings();
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

