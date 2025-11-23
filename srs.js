/**
 * SRS ENGINE (PROGRESSIVE)
 */
class SRSEngine {
    constructor() {
        this.loadData();
    }

    loadData() {
        const saved = localStorage.getItem('sightread_srs_data_v3');
        // Schema: items = { id: { level: 0-5, nextReview: timestamp, streak: number } }
        // unlockedCount = how many notes from PROGRESSION are currently active
        // recentAttempts = array of recent results for performance tracking
        this.data = saved ? JSON.parse(saved) : { 
            items: {}, 
            unlockedCount: 3, // Start with 3 notes
            stats: { streak: 0, total: 0, correct: 0 },
            recentAttempts: [] // Track last 20 attempts for progression checks
        };
        // Ensure recentAttempts exists for old data
        if (!this.data.recentAttempts) {
            this.data.recentAttempts = [];
        }
        // Ensure streak exists for all existing items
        for (let id in this.data.items) {
            if (this.data.items[id].streak === undefined) {
                this.data.items[id].streak = 0;
            }
        }
        
        Logger.info('SRS data loaded', {
            unlockedCount: this.data.unlockedCount,
            totalItems: Object.keys(this.data.items).length,
            stats: this.data.stats
        });
    }

    saveData() {
        localStorage.setItem('sightread_srs_data_v3', JSON.stringify(this.data));
    }

    resetData() {
        localStorage.removeItem('sightread_srs_data_v3');
        this.loadData();
    }

    getKey(clef, note, octave) {
        return `${clef}-${note}${octave}`;
    }

    // Check if user is ready for new notes
    // Requires ALL unlocked notes to have met their streak requirement
    checkProgression(clef) {
        const prog = PROGRESSION[clef] || PROGRESSION['treble'];
        const max = prog.length;
        let currentUnlocked = this.data.unlockedCount;

        Logger.debug(`checkProgression called for clef: ${clef}, currentUnlocked: ${currentUnlocked}, max: ${max}`);

        if (currentUnlocked >= max) {
            Logger.debug('All notes already unlocked, returning false');
            return false; // All unlocked
        }

        // REQUIREMENT: ALL unlocked notes must have streak >= REQUIRED_STREAK_PER_NOTE
        let notesReady = 0;
        let totalUnlocked = 0;
        const noteDetails = [];

        for (let i = 0; i < currentUnlocked; i++) {
            const p = prog[i];
            const id = this.getKey(clef, p.n, p.o);
            const item = this.data.items[id];
            totalUnlocked++;
            
            // If note doesn't exist yet, it's not ready
            if (!item) {
                Logger.warn(`Note ${id} (${p.n}${p.o}) doesn't exist yet, blocking progression`, {
                    note: `${p.n}${p.o}`,
                    id,
                    index: i
                });
                return false;
            }
            
            // Ensure streak exists
            if (item.streak === undefined) {
                item.streak = 0;
                Logger.debug(`Initialized streak for ${id} to 0`);
            }
            
            const noteInfo = {
                note: `${p.n}${p.o}`,
                id,
                streak: item.streak,
                required: REQUIRED_STREAK_PER_NOTE,
                ready: item.streak >= REQUIRED_STREAK_PER_NOTE
            };
            noteDetails.push(noteInfo);
            
            // Check if this note has met the streak requirement
            if (item.streak >= REQUIRED_STREAK_PER_NOTE) {
                notesReady++;
            }
        }

        Logger.info(`Progression check: ${notesReady}/${totalUnlocked} notes ready`, {
            clef,
            currentUnlocked,
            notesReady,
            totalUnlocked,
            requiredStreak: REQUIRED_STREAK_PER_NOTE,
            noteDetails
        });

        // ALL notes must be ready before unlocking the next one
        if (totalUnlocked > 0 && notesReady === totalUnlocked) {
            const oldUnlocked = this.data.unlockedCount;
            this.data.unlockedCount++;
            this.saveData();
            Logger.warn(`PROGRESSION UNLOCKED: ${oldUnlocked} -> ${this.data.unlockedCount}`, {
                clef,
                oldUnlocked,
                newUnlocked: this.data.unlockedCount,
                noteDetails
            });
            return true; // Just unlocked something
        }
        
        Logger.debug(`Progression blocked: ${notesReady}/${totalUnlocked} notes ready (need all ${totalUnlocked})`);
        return false;
    }

    // Check if we should reduce unlocked count due to poor performance
    // If most notes have lost their streaks, reduce unlocked count
    checkRegression(clef) {
        const prog = PROGRESSION[clef] || PROGRESSION['treble'];
        let currentUnlocked = this.data.unlockedCount;

        Logger.debug(`checkRegression called for clef: ${clef}, currentUnlocked: ${currentUnlocked}`);

        if (currentUnlocked <= 3) {
            Logger.debug('At minimum unlocked count, cannot regress');
            return false; // Don't go below minimum
        }

        // Count how many notes have lost their streaks (streak < required)
        let notesWithLowStreak = 0;
        let totalUnlocked = 0;
        const noteDetails = [];

        for (let i = 0; i < currentUnlocked; i++) {
            const p = prog[i];
            const id = this.getKey(clef, p.n, p.o);
            const item = this.data.items[id];
            totalUnlocked++;
            
            const noteInfo = {
                note: `${p.n}${p.o}`,
                id,
                streak: item ? (item.streak || 0) : 0,
                exists: !!item
            };
            noteDetails.push(noteInfo);
            
            if (item) {
                const streak = item.streak || 0;
                if (streak < REQUIRED_STREAK_PER_NOTE) {
                    notesWithLowStreak++;
                }
            } else {
                // Note doesn't exist yet, count as low streak
                notesWithLowStreak++;
            }
        }

        const lowStreakRatio = totalUnlocked > 0 ? (notesWithLowStreak / totalUnlocked) : 0;
        Logger.debug(`Regression check: ${notesWithLowStreak}/${totalUnlocked} notes with low streak`, {
            clef,
            currentUnlocked,
            notesWithLowStreak,
            totalUnlocked,
            lowStreakRatio,
            threshold: 0.5,
            noteDetails
        });

        // If more than 50% of notes have lost their streaks, reduce unlocked count
        if (totalUnlocked > 0 && lowStreakRatio > 0.5) {
            const oldUnlocked = this.data.unlockedCount;
            this.data.unlockedCount = Math.max(3, currentUnlocked - 1);
            this.saveData();
            Logger.warn(`REGRESSION: Reduced unlocked count ${oldUnlocked} -> ${this.data.unlockedCount}`, {
                clef,
                oldUnlocked,
                newUnlocked: this.data.unlockedCount,
                reason: `${notesWithLowStreak}/${totalUnlocked} notes have low streak`,
                noteDetails
            });
            return true; // Just reduced unlocked count
        }
        return false;
    }

    // Generate a card based on progression and due dates
    generateCard(clef, keySig) {
        const prog = PROGRESSION[clef] || PROGRESSION['treble'];
        const limit = Math.min(this.data.unlockedCount, prog.length);
        const now = Date.now();

        // 1. Identify Candidate Pool
        let candidates = [];
        let dueItems = [];
        let newItems = [];
        let strugglingItems = [];

        for (let i = 0; i < limit; i++) {
            const p = prog[i];
            const id = this.getKey(clef, p.n, p.o);
            const item = this.data.items[id];

            // Create card object
            // Handle Key Signature Accidental logic
            let accidental = null;
            const sigNotes = KEY_SIGNATURES[keySig];
            sigNotes.forEach(mod => {
                if (mod.startsWith(p.n)) {
                    if(mod.length > 1) accidental = mod.substring(1); 
                }
            });

            const card = {
                clef, keySig, note: p.n, octave: p.o, accidental,
                id: id
            };

            if (!item) {
                newItems.push(card);
            } else {
                // Ensure streak exists
                if (item.streak === undefined) {
                    item.streak = 0;
                }
                if (item.nextReview <= now) dueItems.push(card);
                // Struggling = low streak or low level
                if (item.level === 0 || (item.streak || 0) < REQUIRED_STREAK_PER_NOTE) {
                    strugglingItems.push(card);
                }
                candidates.push(card); // General pool
            }
        }

        // 2. Selection Strategy (Weighted)
        // Priority: Struggling > New (if few) > Due > Random Review
        
        // If we have struggling items, 40% chance to pick one
        if (strugglingItems.length > 0 && Math.random() < 0.4) {
            return strugglingItems[Math.floor(Math.random() * strugglingItems.length)];
        }

        // If we have items never seen (new), 30% chance (limit new intake)
        if (newItems.length > 0 && Math.random() < 0.3) {
            return newItems[0]; // Pick the first new one (in order)
        }

        // Pick due items
        if (dueItems.length > 0) {
            return dueItems[Math.floor(Math.random() * dueItems.length)];
        }

        // Fallback: Pick any unlocked note (Review)
        // Bias towards recent unlocks (higher index)
        if (candidates.length > 0) {
             // Prefer higher indices (recently unlocked)
             // Simple random for now
             return candidates[Math.floor(Math.random() * candidates.length)];
        }

        // Fallback (shouldn't happen)
        return { clef, keySig, note: 'C', octave: 4, accidental: null, id: 'fallback' };
    }

    recordResult(cardId, isCorrect, timeDelta) {
        const now = Date.now();
        if (!this.data.items[cardId]) {
            this.data.items[cardId] = { level: 0, nextReview: 0, streak: 0 };
            Logger.debug(`Created new item for ${cardId}`);
        }

        const item = this.data.items[cardId];
        // Ensure streak exists
        if (item.streak === undefined) {
            item.streak = 0;
            Logger.debug(`Initialized streak for ${cardId} to 0`);
        }
        
        const oldStreak = item.streak;
        this.data.stats.total++;

        // Track recent attempts for performance monitoring
        this.data.recentAttempts.push(isCorrect);
        // Keep only last 50 attempts
        if (this.data.recentAttempts.length > 50) {
            this.data.recentAttempts.shift();
        }

        // Speed Threshold: 2500ms (2.5 seconds)
        const isFast = timeDelta <= 2500;

        let feedbackType = 'correct'; // correct, slow, wrong

        if (isCorrect) {
            this.data.stats.streak++;
            this.data.stats.correct++;
            
            // Increment per-note streak
            item.streak = (item.streak || 0) + 1;
            
            Logger.info(`Correct answer for ${cardId}`, {
                cardId,
                oldStreak,
                newStreak: item.streak,
                requiredStreak: REQUIRED_STREAK_PER_NOTE,
                timeDelta,
                isFast,
                progress: `${item.streak}/${REQUIRED_STREAK_PER_NOTE}`
            });
            
            if (isFast) {
                // Truly mastered this instance
                const intervals = [1, 5, 30, 120, 720, 2880]; // Minutes
                item.level = Math.min(item.level + 1, intervals.length - 1);
                item.nextReview = now + (intervals[item.level] * 60 * 1000);
                feedbackType = 'correct';
            } else {
                // Correct but slow - don't increase level, maybe decrease?
                // Keep level same or cap at level 2 (don't push to long term until fast)
                item.level = Math.max(0, Math.min(item.level, 2)); 
                item.nextReview = now + (3 * 60 * 1000); // Review soon
                feedbackType = 'slow';
            }
        } else {
            this.data.stats.streak = 0;
            // Reset per-note streak on wrong answer
            const wasReady = oldStreak >= REQUIRED_STREAK_PER_NOTE;
            item.streak = 0;
            item.level = 0; 
            item.nextReview = now + (1 * 60 * 1000); // Immediate review
            feedbackType = 'wrong';
            
            Logger.warn(`Wrong answer for ${cardId} - streak reset`, {
                cardId,
                oldStreak,
                newStreak: 0,
                wasReady,
                requiredStreak: REQUIRED_STREAK_PER_NOTE
            });
        }

        this.saveData();
        return feedbackType;
    }

    getStats() {
        // Calculate mastery % (items > level 2 / total unlocked)
        const prog = PROGRESSION['treble']; // Get the array, not the length
        const unlocked = this.data.unlockedCount;
        
        // Count notes that have met streak requirement
        let notesReady = 0;
        for (let i = 0; i < unlocked && i < prog.length; i++) {
            const p = prog[i];
            if (!p) break; // Safety check - prevent accessing undefined
            const id = this.getKey('treble', p.n, p.o);
            const item = this.data.items[id];
            if (item && (item.streak || 0) >= REQUIRED_STREAK_PER_NOTE) {
                notesReady++;
            }
        }
        
        return {
            unlocked,
            streak: this.data.stats.streak,
            totalNotes: prog.length,
            notesReady,
            requiredStreak: REQUIRED_STREAK_PER_NOTE
        };
    }
}

