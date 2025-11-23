/**
 * APP LOGIC
 */
const App = {
    srs: new SRSEngine(),
    currentSequence: [],
    sequenceIndex: 0,
    isProcessing: false,
    lastNoteTime: 0, // Timestamp when current note was displayed/activated
    settings: {
        clefs: ['treble'],
        keys: ['C'],
        mode: 'buttons',
        batchSize: 8
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
        } else {
            document.getElementById('clef-treble').checked = true;
            document.querySelector(`input[name="input_mode"][value="buttons"]`).checked = true;
            this.settings.batchSize = 8;
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

        this.settings = { clefs, keys, mode, batchSize };
        localStorage.setItem('sightread_settings_v2', JSON.stringify(this.settings));
        
        this.updateUIForMode();
        this.nextRound(); 
    },

    updateUIForMode: function() {
        const pianoWrap = document.getElementById('piano-wrapper');
        const btnWrap = document.getElementById('buttons-wrapper');
        
        if (this.settings.mode === 'piano') {
            pianoWrap.classList.remove('hidden');
            btnWrap.classList.add('hidden');
        } else {
            pianoWrap.classList.add('hidden');
            btnWrap.classList.remove('hidden');
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
        
        AudioEngine.init();
        let freqNote = note; 
        if (accidental) freqNote += accidental;
        AudioEngine.playTone(getFrequency(freqNote, octave));

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

