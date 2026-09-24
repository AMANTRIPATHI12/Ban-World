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
// GAME STATE
// ============================================================

const gameState = {
    score: 0,
    streak: 0,
    bestStreak: 0,
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

// Guard: this script only runs on play.html
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
    restartButton: document.getElementById("restartButton")
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
// USER PROFILE SYNC
// ============================================================

let profileLoaded = false;

/**
 * Fetch the signed-in user's profile from backend and pre-fill score/bestStreak.
 * Called on page load and whenever the user signs in.
 */
async function loadUserProfile() {
    if (!getCurrentUser()) {
        // Not signed in → reset local stats
        gameState.score = 0;
        gameState.bestStreak = 0;
        updateStats();
        return;
    }

    try {
        const res = await authFetch("/api/user/profile");
        const data = await res.json();

        if (!data.success || !data.profile) {
            console.warn("[game] Could not load profile:", data.message);
            return;
        }

        gameState.score = data.profile.totalScore || 0;
        gameState.bestStreak = data.profile.bestStreak || 0;
        profileLoaded = true;

        updateStats();
        console.log(
            `[game] Loaded profile — totalScore: ${gameState.score}, bestStreak: ${gameState.bestStreak}`
        );
    } catch (err) {
        console.warn("[game] Profile fetch failed:", err);
    }
}

/**
 * Save a score delta to the backend. Fire-and-forget — no await,
 * so the game doesn't lag while the network call happens.
 */
async function saveScoreDelta(delta) {
    if (!getCurrentUser() || delta <= 0) return;

    try {
        await authFetch("/api/user/score", {
            method: "POST",
            body: JSON.stringify({
                deltaScore: delta,
                bestStreak: gameState.bestStreak
            })
        });
    } catch (err) {
        console.warn("[game] Score save failed:", err);
    }
}

// Subscribe to auth state — load profile on sign-in, reset on sign-out
onAuthChange(async (user) => {
    if (user) {
        await loadUserProfile();
    } else {
        gameState.score = 0;
        gameState.bestStreak = 0;
        updateStats();
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
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
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
    gameState.streak++;
    gameState.bestStreak = Math.max(gameState.bestStreak, gameState.streak);

    const baseScore = 100;
    const timeBonus = gameState.timer * 10;
    const streakBonus = Math.min(gameState.streak * 10, 100);
    const earned = baseScore + timeBonus + streakBonus;

    gameState.score += earned;
    playCorrectSound();

    showFeedback(
        true,
        `+${earned} points — ${gameState.currentQuestion.answer} is the stronger word.`,
        gameState.currentQuestion.tip
    );
    updateStats();

    // Save delta to backend (fire-and-forget)
    saveScoreDelta(earned);
}

function handleWrongAnswer() {
    gameState.streak = 0;
    playWrongSound();
    showFeedback(
        false,
        `The stronger word is ${gameState.currentQuestion.answer}.`,
        gameState.currentQuestion.tip
    );
    updateStats();
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
    gameState.streak = 0;
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
// Note: score & bestStreak are all-time cumulative (persisted).
// Restart only resets the current session's streak counter.
// ============================================================

function restartGame() {
    stopTimer();

    // Keep score & bestStreak — they're persisted to backend
    gameState.streak = 0;
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
    elements.streak.textContent = gameState.streak;
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
    reloadProfile() { return loadUserProfile(); },
    enableSound() { APP_CONFIG.AUDIO_ENABLED = true; initAudio(); },
    disableSound() { APP_CONFIG.AUDIO_ENABLED = false; }
};

// ============================================================
// INITIALIZE
// ============================================================

async function initGame() {
    if (!isPlayPage) return;

    setupEvents();

    // If already signed in, load profile immediately
    if (getCurrentUser()) {
        await loadUserProfile();
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