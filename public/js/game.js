// ============================================================
// INFINITE VOCABULARY MODE
// ============================================================

import {
    randomItem,
    shuffle,
    escapeHTML,
    normalizeText,
    hashString
} from "./main.js";
import { authFetch, onAuthChange, getCurrentUser } from "./auth.js";

// ============================================================
// PROFILE CACHE (localStorage) — instant render on reload
// ============================================================

const PROFILE_CACHE_KEY = "bw_profile_v1";

function readProfileCache() {
    try {
        const raw = localStorage.getItem(PROFILE_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeProfileCache(profile) {
    try {
        localStorage.setItem(
            PROFILE_CACHE_KEY,
            JSON.stringify({ ...profile, _cachedAt: Date.now() })
        );
    } catch {
        // quota / private mode — ignore
    }
}

function clearProfileCache() {
    try {
        localStorage.removeItem(PROFILE_CACHE_KEY);
    } catch {
        // ignore
    }
}

// ============================================================
// GAME STATE
// ============================================================

const gameState = {
    // Persisted (from DB + cache)
    score: 0,              // total cumulative score
    dailyStreak: 0,        // consecutive days with ≥5 questions
    bestStreak: 0,         // all-time best daily streak
    todayAnswered: 0,      // questions answered today
    lastPlayedDate: null,  // YYYY-MM-DD

    // Session-only
    sessionStreak: 0,      // correct-answer streak for score bonuses
    questionNumber: 1,

    vocabulary: [],
    templates: [],
    currentQuestion: null,
    timer: APP_CONFIG.QUESTION_TIME,
    timerInterval: null,
    answered: false,
    questionsGenerated: 0,
    usedQuestionBits: new Uint8Array(
        Math.ceil(APP_CONFIG.MAX_QUESTIONS / 8)
    ),
    generationCounter: 0
};

const isPlayPage = !!document.getElementById("options");
if (!isPlayPage) {
    console.warn("[game] play.html elements not found — skipping init.");
}

// ============================================================
// DOM
// ============================================================

const elements = {
    score: document.getElementById("score"),
    streak: document.getElementById("streak"),
    bestStreakMini: document.getElementById("bestStreakMini"),
    questionNumber: document.getElementById("questionNumber"),
    timer: document.getElementById("timer"),
    progressBar: document.getElementById("progressBar"),
    questionText: document.getElementById("questionText"),
    questionInstruction: document.getElementById("questionInstruction"),
    options: document.getElementById("options"),
    feedback: document.getElementById("feedback"),
    feedbackTitle: document.getElementById("feedbackTitle"),
    feedbackText: document.getElementById("feedbackText"),
    nextButton: document.getElementById("nextButton"),
    loadingIndicator: document.getElementById("loadingIndicator"),
    gameOver: document.getElementById("gameOver"),
    finalScore: document.getElementById("finalScore"),
    finalQuestions: document.getElementById("finalQuestions"),
    bestStreak: document.getElementById("bestStreak"),
    restartButton: document.getElementById("restartButton"),
    authArea: document.getElementById("authArea")
};

// ============================================================
// AUDIO ENGINE
// ============================================================

let audioContext = null;

function initAudio() {
    if (!APP_CONFIG.AUDIO_ENABLED) return;
    if (!audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            console.warn("Web Audio API not supported.");
            return;
        }
        audioContext = new AudioContext();
    }
    if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
    }
}

function playTone(frequency, duration = 0.1, type = "sine", volume = 0.05, delay = 0) {
    if (!APP_CONFIG.AUDIO_ENABLED || !audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    const startTime = audioContext.currentTime + delay;
    const endTime = startTime + duration;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime);
    oscillator.start(startTime);
    oscillator.stop(endTime);
}

function playCorrectSound() {
    initAudio();
    playTone(523.25, 0.08, "sine", 0.05, 0);
    playTone(659.25, 0.08, "sine", 0.05, 0.08);
    playTone(783.99, 0.12, "sine", 0.05, 0.16);
}

function playWrongSound() {
    initAudio();
    playTone(220, 0.12, "sawtooth", 0.035, 0);
    playTone(164.81, 0.18, "sawtooth", 0.035, 0.1);
}

function playTimeoutSound() {
    initAudio();
    playTone(180, 0.12, "square", 0.035, 0);
    playTone(140, 0.18, "square", 0.035, 0.12);
}

function playNextSound() {
    initAudio();
    playTone(440, 0.05, "sine", 0.025, 0);
}

function playGameOverSound() {
    initAudio();
    playTone(392, 0.1, "sine", 0.04, 0);
    playTone(330, 0.1, "sine", 0.04, 0.1);
    playTone(261.63, 0.2, "sine", 0.04, 0.2);
}

// ============================================================
// COMPACT QUESTION TRACKING
// ============================================================

function isQuestionUsed(id) {
    return gameState.usedQuestionBits[Math.floor(id / 8)] & (1 << (id % 8));
}

function markQuestionUsed(id) {
    gameState.usedQuestionBits[Math.floor(id / 8)] |= 1 << (id % 8);
}

function questionIdFromContent(vocabulary, template, subject, context, variation) {
    const raw = [vocabulary.id, template.id, subject, context, variation].join("|");
    return hashString(raw) % APP_CONFIG.MAX_QUESTIONS;
}

// ============================================================
// PROFILE SYNC — CACHE FIRST, THEN DB
// ============================================================

/**
 * Applies a profile object to local state + UI.
 */
function applyProfile(profile) {
    if (!profile) return;

    gameState.score = Number(profile.totalScore) || 0;
    gameState.dailyStreak = Number(profile.currentStreak) || 0;
    gameState.bestStreak = Number(profile.bestStreak) || 0;
    gameState.todayAnswered = Number(profile.todayQuestionsAnswered) || 0;
    gameState.lastPlayedDate = profile.lastPlayedDate || null;

    updateStats();
}

/**
 * Render from cache immediately so there's zero flash.
 * Returns true if a cache was found.
 */
function renderFromCache() {
    const cached = readProfileCache();
    if (!cached) return false;
    applyProfile(cached);
    return true;
}

/**
 * Fetch from backend, update cache, then re-render.
 */
async function fetchAndApplyProfile() {
    if (!getCurrentUser()) return;

    try {
        const res = await authFetch("/api/user/profile");
        const data = await res.json();
        if (!data.success || !data.profile) {
            console.warn("[game] Profile fetch returned no data:", data.message);
            return;
        }
        applyProfile(data.profile);
        writeProfileCache(data.profile);
    } catch (err) {
        console.warn("[game] Profile fetch failed (using cache):", err);
    }
}

/**
 * Sends a score delta to the backend.
 * The server returns the updated profile, which we use to
 * refresh the local state + cache.
 */
async function saveScoreDelta(delta) {
    if (!getCurrentUser() || delta <= 0) return;

    try {
        const res = await authFetch("/api/user/score", {
            method: "POST",
            body: JSON.stringify({ deltaScore: delta })
        });
        const data = await res.json();
        if (!data.success || !data.profile) return;

        applyProfile(data.profile);
        writeProfileCache(data.profile);

        console.log(
            `[game] Profile updated — total: ${data.profile.totalScore}, dailyStreak: ${data.profile.currentStreak}, best: ${data.profile.bestStreak}`
        );
    } catch (err) {
        console.warn("[game] Score save failed:", err);
    }
}

// Reset everything when the user signs out
function resetProfileState() {
    gameState.score = 0;
    gameState.dailyStreak = 0;
    gameState.bestStreak = 0;
    gameState.todayAnswered = 0;
    gameState.lastPlayedDate = null;
    clearProfileCache();
    updateStats();
}

// ============================================================
// AUTH STATE
// ============================================================

onAuthChange(async (user) => {
    // Reveal the auth area (fixes the "Sign in" flash on page load)
    if (elements.authArea) {
        elements.authArea.classList.remove("hidden");
    }

    if (user) {
        await fetchAndApplyProfile();
    } else {
        resetProfileState();
    }
});

// ============================================================
// CONTENT LOADING
// ============================================================

async function loadContent() {
    showLoading(true);
    try {
        console.log("Loading content from server...");
        const response = await fetch(APP_CONFIG.API_CONTENT_URL, { cache: "no-store" });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.vocabulary) || !Array.isArray(data.templates)) {
            throw new Error("Invalid content received from server.");
        }
        if (data.vocabulary.length === 0 || data.templates.length === 0) {
            throw new Error("Server content bank is empty.");
        }
        gameState.vocabulary = data.vocabulary;
        gameState.templates = data.templates;
        console.log(`Loaded ${gameState.vocabulary.length} vocabulary entries`);
        console.log(`Loaded ${gameState.templates.length} templates`);
    } catch (serverError) {
        console.warn("Server content unavailable. Using local JSON fallback.", serverError);
        await loadLocalContent();
    }
    showLoading(false);
}

async function loadLocalContent() {
    const [vocabularyResponse, templatesResponse] = await Promise.all([
        fetch(APP_CONFIG.LOCAL_VOCABULARY_URL),
        fetch(APP_CONFIG.LOCAL_TEMPLATES_URL)
    ]);

    if (!vocabularyResponse.ok) throw new Error("Could not load vocabulary.json");
    if (!templatesResponse.ok) throw new Error("Could not load templates.json");

    const vocabularyData = await vocabularyResponse.json();
    const templatesData = await templatesResponse.json();

    gameState.vocabulary = Array.isArray(vocabularyData) ? vocabularyData : vocabularyData.vocabulary || [];
    gameState.templates = Array.isArray(templatesData) ? templatesData : templatesData.templates || [];

    console.log(`Local fallback vocabulary: ${gameState.vocabulary.length}`);
    console.log(`Local fallback templates: ${gameState.templates.length}`);
}

// ============================================================
// TEMPLATE COMPATIBILITY
// ============================================================

function getCompatibleTemplates(vocabulary) {
    const categoryTemplates = gameState.templates.filter(
        (template) => !template.category || template.category === vocabulary.category
    );
    if (categoryTemplates.length > 0) return categoryTemplates;
    return gameState.templates;
}

// ============================================================
// SENTENCE VARIATIONS
// ============================================================

const sentenceVariations = [
    "", "today", "right now", "in the end", "once again", "by a huge margin",
    "without warning", "according to the judges", "during the challenge",
    "after the announcement", "in the final round", "under pressure",
    "for a beginner", "within seconds", "after several hours", "during the event",
    "in the competition", "after the results", "during the interview", "before the deadline"
];

function applyVariation(sentence, variation) {
    if (!variation) return sentence;
    const trimmed = sentence.trim();
    if (trimmed.endsWith(".") || trimmed.endsWith("!") || trimmed.endsWith("?")) {
        return trimmed.slice(0, -1) + ` ${variation}.`;
    }
    return `${trimmed} ${variation}.`;
}

// ============================================================
// SENTENCE BUILDER
// ============================================================

function buildSentence(vocabulary, template) {
    const subject = randomItem(template.subjects?.length ? template.subjects : vocabulary.subjects);
    const context = randomItem(template.contexts?.length ? template.contexts : vocabulary.contexts);
    const variation = randomItem(sentenceVariations);

    let sentence = template.text;

    sentence = sentence.replace(/\{subject\}/gi, escapeHTML(subject || "The subject"));
    sentence = sentence.replace(/\{bad\}/gi, `<span class="badword">${escapeHTML(vocabulary.bad)}</span>`);
    sentence = sentence.replace(/\{context\}/gi, escapeHTML(context || ""));
    sentence = sentence.replace(/\{answer\}/gi, escapeHTML(vocabulary.answer));
    sentence = applyVariation(sentence, variation);

    return {
        sentence,
        subject: subject || "",
        context: context || "",
        variation
    };
}

// ============================================================
// DISTRACTORS
// ============================================================

function getDistractors(correctVocabulary) {
    const possible = gameState.vocabulary.filter(
        (item) =>
            item.id !== correctVocabulary.id &&
            normalizeText(item.answer) !== normalizeText(correctVocabulary.answer)
    );
    return shuffle(possible).slice(0, 12);
}

function buildOptions(correctVocabulary) {
    const distractors = getDistractors(correctVocabulary);
    const selected = distractors.slice(0, 3);
    const options = [correctVocabulary, ...selected];
    return shuffle(options);
}

// ============================================================
// QUESTION GENERATION
// ============================================================

function generateQuestion() {
    if (gameState.questionsGenerated >= APP_CONFIG.MAX_QUESTIONS) return null;

    for (let attempt = 0; attempt < APP_CONFIG.MAX_GENERATION_ATTEMPTS; attempt++) {
        const vocabulary = randomItem(gameState.vocabulary);
        if (!vocabulary) return null;

        const templates = getCompatibleTemplates(vocabulary);
        const template = randomItem(templates);
        if (!template) continue;

        const built = buildSentence(vocabulary, template);
        const id = questionIdFromContent(vocabulary, template, built.subject, built.context, built.variation);

        if (isQuestionUsed(id)) continue;

        const options = buildOptions(vocabulary);
        if (options.length < 4) continue;

        markQuestionUsed(id);
        gameState.questionsGenerated++;

        return {
            id,
            vocabularyId: vocabulary.id,
            question: built.sentence,
            bad: vocabulary.bad,
            answer: vocabulary.answer,
            tip: vocabulary.tip || "",
            options,
            difficulty: vocabulary.difficulty || 1,
            category: vocabulary.category || "general"
        };
    }

    console.warn("Unable to generate another unique question.");
    return null;
}

// ============================================================
// START QUESTION
// ============================================================

function startQuestion() {
    stopTimer();
    gameState.answered = false;
    hideFeedback();

    const question = generateQuestion();
    if (!question) {
        endGame();
        return;
    }

    gameState.currentQuestion = question;

    elements.questionNumber.textContent = gameState.questionNumber;
    elements.questionText.innerHTML = question.question;
    elements.questionInstruction.textContent = "Replace the boring phrase with a stronger word.";

    renderOptions(question.options);
    startTimer();
    updateStats();
    updateProgress();
}

// ============================================================
// OPTIONS
// ============================================================

function renderOptions(options) {
    const buttons = elements.options.querySelectorAll(".option");
    const letters = ["A", "B", "C", "D"];

    buttons.forEach((button, index) => {
        const option = options[index];
        const text = button.querySelector(".option-text");

        if (!option) {
            button.style.display = "none";
            return;
        }

        button.style.display = "";
        button.disabled = false;
        button.classList.remove("correct", "wrong", "selected");
        button.dataset.answer = option.answer;
        button.dataset.index = index;
        text.textContent = option.answer;

        const letter = button.querySelector(".option-letter");
        if (letter) letter.textContent = letters[index];
    });
}

// ============================================================
// ANSWER
// ============================================================

function handleAnswer(index) {
    if (gameState.answered) return;
    gameState.answered = true;
    stopTimer();
    initAudio();

    const selected = gameState.currentQuestion.options[index];
    const correct =
        normalizeText(selected.answer) === normalizeText(gameState.currentQuestion.answer);

    const buttons = elements.options.querySelectorAll(".option");
    buttons.forEach((button) => {
        button.disabled = true;
        const answer = button.dataset.answer;
        if (normalizeText(answer) === normalizeText(gameState.currentQuestion.answer)) {
            button.classList.add("correct");
        }
    });

    const selectedButton = buttons[index];

    if (correct) {
        selectedButton.classList.add("selected");
        handleCorrectAnswer();
    } else {
        selectedButton.classList.add("wrong");
        handleWrongAnswer();
    }
}

function handleCorrectAnswer() {
    gameState.sessionStreak++;

    const baseScore = 100;
    const timeBonus = gameState.timer * 10;
    const streakBonus = Math.min(gameState.sessionStreak * 10, 100);
    const earned = baseScore + timeBonus + streakBonus;

    gameState.score += earned;
    playCorrectSound();

    showFeedback(
        true,
        `+${earned} points — ${gameState.currentQuestion.answer} is the stronger word.`,
        gameState.currentQuestion.tip
    );
    updateStats();

    // Fire-and-forget: server increments today's count, recalculates daily streak
    saveScoreDelta(earned);
}

function handleWrongAnswer() {
    gameState.sessionStreak = 0;
    playWrongSound();
    showFeedback(
        false,
        `The stronger word is ${gameState.currentQuestion.answer}.`,
        gameState.currentQuestion.tip
    );
    updateStats();

    // Wrong answers still count toward "played today"
    saveScoreDelta(0);
}

// ============================================================
// FEEDBACK
// ============================================================

function showFeedback(correct, message, tip) {
    elements.feedback.classList.remove("hidden");
    elements.feedbackTitle.textContent = correct ? "CORRECT!" : "NOT QUITE!";
    elements.feedbackText.innerHTML = `${escapeHTML(message)}${tip ? `<br><small>${escapeHTML(tip)}</small>` : ""}`;
}

function hideFeedback() {
    elements.feedback.classList.add("hidden");
}

// ============================================================
// TIMER
// ============================================================

function startTimer() {
    gameState.timer = APP_CONFIG.QUESTION_TIME;
    updateTimer();

    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        updateTimer();
        if (gameState.timer <= 0) handleTimeout();
    }, 1000);
}

function stopTimer() {
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
        gameState.timerInterval = null;
    }
}

function updateTimer() {
    elements.timer.textContent = gameState.timer;
    const percentage = (gameState.timer / APP_CONFIG.QUESTION_TIME) * 100;
    elements.progressBar.style.width = `${Math.max(0, percentage)}%`;
}

function handleTimeout() {
    if (gameState.answered) return;
    gameState.answered = true;
    stopTimer();
    gameState.sessionStreak = 0;
    playTimeoutSound();

    const buttons = elements.options.querySelectorAll(".option");
    buttons.forEach((button) => {
        button.disabled = true;
        const answer = button.dataset.answer;
        if (normalizeText(answer) === normalizeText(gameState.currentQuestion.answer)) {
            button.classList.add("correct");
        }
    });

    showFeedback(
        false,
        `Time's up! The answer was ${gameState.currentQuestion.answer}.`,
        gameState.currentQuestion.tip
    );
    updateStats();

    // Still counts as played today
    saveScoreDelta(0);
}

// ============================================================
// NEXT QUESTION
// ============================================================

function nextQuestion() {
    if (!gameState.answered) return;
    playNextSound();
    gameState.questionNumber++;
    startQuestion();
}

// ============================================================
// GAME END
// ============================================================

function endGame() {
    stopTimer();
    playGameOverSound();

    elements.options.style.display = "none";
    elements.feedback.classList.add("hidden");
    elements.questionText.textContent = "You've reached the current question limit.";
    elements.questionInstruction.textContent = "The current vocabulary bank has been exhausted.";
    elements.gameOver.classList.remove("hidden");

    elements.finalScore.textContent = gameState.score;
    elements.finalQuestions.textContent = gameState.questionsGenerated;
    elements.bestStreak.textContent = gameState.bestStreak;
}

// ============================================================
// RESTART
// ============================================================
// Keeps persisted score & daily streak. Only resets the session
// streak and question counter.
// ============================================================

function restartGame() {
    stopTimer();

    gameState.sessionStreak = 0;
    gameState.questionNumber = 1;
    gameState.currentQuestion = null;
    gameState.timer = APP_CONFIG.QUESTION_TIME;
    gameState.answered = false;
    gameState.questionsGenerated = 0;
    gameState.usedQuestionBits = new Uint8Array(Math.ceil(APP_CONFIG.MAX_QUESTIONS / 8));

    elements.options.style.display = "";
    elements.gameOver.classList.add("hidden");
    hideFeedback();
    updateStats();
    initAudio();
    startQuestion();
}

// ============================================================
// UI
// ============================================================

function updateStats() {
    elements.score.textContent = gameState.score;
    elements.streak.textContent = gameState.dailyStreak;

    if (elements.bestStreakMini) {
        elements.bestStreakMini.textContent = `Best: ${gameState.bestStreak}`;
    }

    elements.questionNumber.textContent = gameState.questionNumber;
}

function updateProgress() {
    const percentage = (gameState.timer / APP_CONFIG.QUESTION_TIME) * 100;
    elements.progressBar.style.width = `${percentage}%`;
}

function showLoading(show) {
    if (!elements.loadingIndicator) return;
    elements.loadingIndicator.classList.toggle("hidden", !show);
}

// ============================================================
// EVENTS
// ============================================================

function setupEvents() {
    elements.options.addEventListener("click", (event) => {
        const button = event.target.closest(".option");
        if (!button) return;
        const index = Number(button.dataset.index);
        initAudio();
        handleAnswer(index);
    });

    elements.nextButton.addEventListener("click", nextQuestion);
    elements.restartButton.addEventListener("click", restartGame);

    document.addEventListener("keydown", (event) => {
        if (event.key >= "1" && event.key <= "4") {
            const index = Number(event.key) - 1;
            if (!gameState.answered) {
                initAudio();
                handleAnswer(index);
            }
        }
        if (event.key === "Enter" && gameState.answered) {
            nextQuestion();
        }
    });

    document.addEventListener(
        "pointerdown",
        () => {
            initAudio();
        },
        { once: true }
    );
}

// ============================================================
// DEBUG API
// ============================================================

window.BoringWordGame = {
    state: gameState,
    getLimit() { return APP_CONFIG.MAX_QUESTIONS; },
    getGeneratedCount() { return gameState.questionsGenerated; },
    getVocabularyCount() { return gameState.vocabulary.length; },
    getTemplateCount() { return gameState.templates.length; },
    generateQuestion,
    restart() { restartGame(); },
    reloadProfile() { return fetchAndApplyProfile(); },
    enableSound() { APP_CONFIG.AUDIO_ENABLED = true; initAudio(); },
    disableSound() { APP_CONFIG.AUDIO_ENABLED = false; }
};

// ============================================================
// INITIALIZE
// ============================================================

async function initGame() {
    if (!isPlayPage) return;

    setupEvents();

    // 1) Render cached profile instantly (kills the flash)
    renderFromCache();

    // 2) Fetch fresh data in the background (if signed in)
    if (getCurrentUser()) {
        fetchAndApplyProfile();
    }

    try {
        await loadContent();
        if (gameState.vocabulary.length === 0 || gameState.templates.length === 0) {
            throw new Error("No vocabulary or templates available.");
        }
        updateStats();
        startQuestion();
    } catch (error) {
        console.error("GAME INITIALIZATION FAILED:", error);
        elements.questionText.textContent = "Unable to load the vocabulary bank.";
        elements.questionInstruction.textContent = "Check the server and data files.";
        showLoading(false);
    }
}

initGame();