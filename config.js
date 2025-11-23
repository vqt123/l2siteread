/**
 * Configuration and Constants
 */

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const KEY_SIGNATURES = {
    'C': [],
    'G': ['F#'],
    'F': ['Bb'],
    'D': ['F#', 'C#'],
    'Bb': ['Bb', 'Eb']
};

/**
 * PROGRESSION DEFINITIONS
 * Standard Center-Out learning path for Treble and Bass
 */
const PROGRESSION = {
    'treble': [
        {n:'C', o:4}, // Middle C
        {n:'D', o:4}, {n:'E', o:4}, // Up
        {n:'B', o:3}, // Down
        {n:'F', o:4}, {n:'G', o:4}, 
        {n:'A', o:4}, {n:'B', o:4}, {n:'C', o:5}, // High C
        {n:'A', o:3}, {n:'G', o:3}, // Lower
        {n:'D', o:5}, {n:'E', o:5}, {n:'F', o:5}
    ],
    'bass': [
        {n:'C', o:3}, // Middle C (Bass is below usually, but let's start C3)
        {n:'B', o:2}, {n:'A', o:2}, // Down
        {n:'D', o:3}, // Up
        {n:'G', o:2}, {n:'F', o:2},
        {n:'E', o:3}, {n:'F', o:3},
        {n:'E', o:2}, {n:'D', o:2}, {n:'C', o:2} // Low C
    ]
};

function getFrequency(note, octave) {
    const noteIndex = NOTES.indexOf(note);
    const absNote = (octave * 12) + noteIndex;
    const absA4 = (4 * 12) + 9;
    return 440 * Math.pow(2, (absNote - absA4) / 12);
}

// Minimum consecutive correct answers required per note before progression
const REQUIRED_STREAK_PER_NOTE = 20;

