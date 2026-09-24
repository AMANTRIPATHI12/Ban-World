// ============================================================
// ROOMS — Create / Join / Play / Host
// ============================================================

import { escapeHTML } from "./main.js";
import {
    authFetch,
    fsDb,
    onAuthChange,
    signInWithGoogle,
    getCurrentUser
} from "./auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ============================================================
// CONSTANTS
// ============================================================

const MAX_QUESTIONS_PER_ROOM = 20;
const MIN_QUESTIONS_PER_ROOM = 5;
const GENERATE_BATCH_SIZE = 6;

// ============================================================
// DOM
// ============================================================

const el = {
    // auth
    signedOut: document.getElementById("roomsSignedOut"),
    controls: document.getElementById("roomsControls"),
    signInBtn: document.getElementById("roomsSignInBtn"),

    // create / join
    createBtn: document.getElementById("createRoomBtn"),
    joinBtn: document.getElementById("joinRoomBtn"),
    codeInput: document.getElementById("roomCodeInput"),
    error: document.getElementById("roomsError"),

    // create form
    createForm: document.getElementById("createRoomForm"),
    roomNameInput: document.getElementById("roomNameInput"),
    modePlayerBtn: document.getElementById("modePlayerBtn"),
    modeHostBtn: document.getElementById("modeHostBtn"),
    modeHint: document.getElementById("modeHint"),

    // unified question builder
    questionCounter: document.getElementById("questionCounter"),
    questionList: document.getElementById("questionList"),
    generateBtn: document.getElementById("generateQsBtn"),
    addQBtn: document.getElementById("addCustomQBtn"),
    builderHint: document.getElementById("builderHint"),

    confirmCreate: document.getElementById("confirmCreateBtn"),
    cancelCreate: document.getElementById("cancelCreateBtn"),

    // waiting room
    waitingPanel: document.getElementById("waitingRoomPanel"),
    waitingCode: document.getElementById("waitingRoomCode"),
    waitingName: document.getElementById("waitingRoomName"),
    waitingHostMode: document.getElementById("waitingHostMode"),
    waitingPlayerCount: document.getElementById("waitingPlayerCount"),
    waitingPlayerList: document.getElementById("waitingPlayerList"),
    waitingHint: document.getElementById("waitingHint"),
    startGameBtn: document.getElementById("startGameBtn"),
    leaveRoomBtn: document.getElementById("leaveRoomBtn"),

    // lobby role toggle
    lobbyRoleToggle: document.getElementById("lobbyRoleToggle"),
    lobbyModePlayerBtn: document.getElementById("lobbyModePlayerBtn"),
    lobbyModeHostBtn: document.getElementById("lobbyModeHostBtn"),
    lobbyModeHint: document.getElementById("lobbyModeHint"),

    // game — same IDs as play.html
    gamePanel: document.getElementById("gamePanel"),
    roleBanner: document.getElementById("roleBanner"),
    score: document.getElementById("score"),
    streak: document.getElementById("streak"),
    questionNumber: document.getElementById("questionNumber"),
    timer: document.getElementById("timer"),
    timerCard: document.getElementById("timerCard"),
    progressBar: document.getElementById("progressBar"),
    questionText: document.getElementById("questionText"),
    questionInstruction: document.getElementById("questionInstruction"),
    options: document.getElementById("options"),
    feedback: document.getElementById("feedback"),
    feedbackTitle: document.getElementById("feedbackTitle"),
    feedbackText: document.getElementById("feedbackText"),
    hostNextBtn: document.getElementById("hostNextBtn"),
    hostEndBtn: document.getElementById("hostEndBtn"),
    gameScoreList: document.getElementById("gameScoreList"),

    // finished
    finishedPanel: document.getElementById("finishedPanel"),
    finishedList: document.getElementById("finishedList"),
    backToLobbyBtn: document.getElementById("backToLobbyBtn")
};

// ============================================================
// STATE
// ============================================================

let currentUser = null;
let currentRoomId = null;
let roomUnsubscribe = null;

let currentRoom = null;
let myRole = "player"; // 'player' | 'host'
let questionTimerInterval = null;

// create-flow state
let createHostMode = "player";
let builderQuestions = []; // [{ text, options[4], correctIndex, strikeWord }]

// Diff-render cache (avoids re-rendering unchanged DOM)
const rendered = {
    qIdx: -1,
    scoreSig: "",
    answeredForQ: -1,
    roleBannerText: "",
    hostControlsVisible: null,
    timerCardDim: null,
    questionCounterText: "",
    questionListSignature: ""
};

// ============================================================
// AUTH
// ============================================================

onAuthChange((user) => {
    currentUser = user;

    if (!el.signedOut) return;

    if (user) {
        el.signedOut.classList.add("hidden");
        el.controls.classList.remove("hidden");
    } else {
        el.signedOut.classList.remove("hidden");
        el.controls.classList.add("hidden");
        el.createForm.classList.add("hidden");
        el.waitingPanel.classList.add("hidden");
        el.gamePanel.classList.add("hidden");
        el.finishedPanel.classList.add("hidden");
        teardownRoom();
    }
});

if (el.signInBtn) {
    el.signInBtn.addEventListener("click", () => signInWithGoogle());
}

// ============================================================
// HELPERS
// ============================================================

function showError(msg) {
    if (!el.error) return;
    el.error.textContent = msg;
    el.error.classList.remove("hidden");
}

function clearError() {
    if (!el.error) return;
    el.error.textContent = "";
    el.error.classList.add("hidden");
}

function showPanel(name) {
    el.controls.classList.toggle("hidden", name !== "controls");
    el.createForm.classList.toggle("hidden", name !== "createForm");
    el.waitingPanel.classList.toggle("hidden", name !== "waiting");
    el.gamePanel.classList.toggle("hidden", name !== "game");
    el.finishedPanel.classList.toggle("hidden", name !== "finished");
}

function teardownRoom() {
    if (roomUnsubscribe) {
        roomUnsubscribe();
        roomUnsubscribe = null;
    }
    stopQuestionTimer();
    currentRoomId = null;
    currentRoom = null;

    // Reset diff cache
    rendered.qIdx = -1;
    rendered.scoreSig = "";
    rendered.answeredForQ = -1;
    rendered.roleBannerText = "";
    rendered.hostControlsVisible = null;
    rendered.timerCardDim = null;
}

// ============================================================
// CREATE — host mode toggle
// ============================================================

if (el.modePlayerBtn) {
    el.modePlayerBtn.addEventListener("click", () => {
        createHostMode = "player";
        el.modePlayerBtn.classList.add("active");
        el.modeHostBtn.classList.remove("active");
        el.modeHint.textContent =
            "You'll play with everyone. Questions advance automatically when the timer ends.";
    });
}

if (el.modeHostBtn) {
    el.modeHostBtn.addEventListener("click", () => {
        createHostMode = "host";
        el.modeHostBtn.classList.add("active");
        el.modePlayerBtn.classList.remove("active");
        el.modeHint.textContent =
            "You'll be a spectator. You control when to move to the next question.";
    });
}

// ============================================================
// CREATE — open / cancel
// ============================================================

if (el.createBtn) {
    el.createBtn.addEventListener("click", () => {
        showPanel("createForm");
        builderQuestions = [];
        renderQuestionList(true);
        updateCounter();
        updateBuilderButtons();
        clearError();
    });
}

if (el.cancelCreate) {
    el.cancelCreate.addEventListener("click", () => {
        showPanel("controls");
    });
}

// ============================================================
// QUESTION BUILDER — counter & buttons
// ============================================================

function updateCounter() {
    const text = `${builderQuestions.length} / ${MAX_QUESTIONS_PER_ROOM}`;
    if (el.questionCounter && rendered.questionCounterText !== text) {
        el.questionCounter.textContent = text;
        rendered.questionCounterText = text;
    }

    // Color the counter when in valid range
    if (el.questionCounter) {
        const valid = builderQuestions.length >= MIN_QUESTIONS_PER_ROOM;
        el.questionCounter.classList.toggle("valid", valid);
    }
}

function updateBuilderButtons() {
    if (el.generateBtn) {
        const atCap = builderQuestions.length >= MAX_QUESTIONS_PER_ROOM;
        el.generateBtn.disabled = atCap;
        el.generateBtn.textContent = atCap
            ? "✓ Maximum reached"
            : `⚡ Generate ${Math.min(GENERATE_BATCH_SIZE, MAX_QUESTIONS_PER_ROOM - builderQuestions.length)} more`;
    }
    if (el.addQBtn) {
        el.addQBtn.disabled = builderQuestions.length >= MAX_QUESTIONS_PER_ROOM;
    }
    if (el.builderHint) {
        const count = builderQuestions.length;
        if (count === 0) {
            el.builderHint.textContent =
                `Click "Generate" or "+ Add blank" to start. Min ${MIN_QUESTIONS_PER_ROOM}, max ${MAX_QUESTIONS_PER_ROOM}.`;
        } else if (count < MIN_QUESTIONS_PER_ROOM) {
            el.builderHint.textContent =
                `Add ${MIN_QUESTIONS_PER_ROOM - count} more to enable Create Room.`;
        } else {
            el.builderHint.textContent = "Ready to create. Edit any question freely.";
        }
    }
}

// ============================================================
// QUESTION BUILDER — render list (with delegation)
// ============================================================

function renderQuestionList(forceRebuild = false) {
    if (!el.questionList) return;

    // Signature: length + last edit timestamp isn't reliable, so
    // rebuild whenever we're not in a forceRebuild-only scenario.
    // Simpler: always rebuild the list DOM. This is fine — the list
    // only re-renders during creation, not during gameplay.
    el.questionList.innerHTML = builderQuestions
        .map((q, i) => {
            const optionsHtml = q.options
                .map(
                    (opt, oi) => `
                <div class="q-option-row">
                    <label class="q-radio-label">
                        <input
                            type="radio"
                            class="q-radio"
                            name="q-correct-${i}"
                            value="${oi}"
                            data-index="${i}"
                            data-opt-index="${oi}"
                            ${q.correctIndex === oi ? "checked" : ""}
                        />
                        <span class="q-opt-letter">${String.fromCharCode(65 + oi)}</span>
                    </label>
                    <input
                        type="text"
                        class="q-opt"
                        placeholder="Option ${String.fromCharCode(65 + oi)}"
                        value="${escapeHTML(opt)}"
                        data-index="${i}"
                        data-opt-index="${oi}"
                    />
                </div>`
                )
                .join("");

            return `
            <div class="q-row" data-index="${i}">
                <div class="q-row-header">
                    <span class="q-number">Q${i + 1}</span>
                    <button class="q-remove" data-index="${i}" title="Remove">✕</button>
                </div>
                <input
                    type="text"
                    class="q-text"
                    placeholder="Question text"
                    value="${escapeHTML(q.text)}"
                    data-index="${i}"
                />
                <input
                    type="text"
                    class="q-strike"
                    placeholder="Word to strike through (e.g. VERY GOOD)"
                    value="${escapeHTML(q.strikeWord)}"
                    data-index="${i}"
                />
                <div class="q-options">
                    ${optionsHtml}
                </div>
            </div>`;
        })
        .join("");
}

// ============================================================
// QUESTION BUILDER — input delegation
// ============================================================

if (el.questionList) {
    // Text inputs
    el.questionList.addEventListener("input", (e) => {
        const t = e.target;
        const idx = Number(t.dataset.index);
        if (Number.isNaN(idx) || !builderQuestions[idx]) return;

        if (t.classList.contains("q-text")) {
            builderQuestions[idx].text = t.value;
        } else if (t.classList.contains("q-strike")) {
            builderQuestions[idx].strikeWord = t.value;
        } else if (t.classList.contains("q-opt")) {
            const oi = Number(t.dataset.optIndex);
            builderQuestions[idx].options[oi] = t.value;
        }
    });

    // Correct answer radio
    el.questionList.addEventListener("change", (e) => {
        const t = e.target;
        if (!t.classList.contains("q-radio")) return;
        const idx = Number(t.dataset.index);
        const oi = Number(t.dataset.optIndex);
        if (Number.isNaN(idx) || !builderQuestions[idx]) return;
        builderQuestions[idx].correctIndex = oi;
    });

    // Remove button
    el.questionList.addEventListener("click", (e) => {
        const btn = e.target.closest(".q-remove");
        if (!btn) return;
        const idx = Number(btn.dataset.index);
        if (Number.isNaN(idx)) return;
        builderQuestions.splice(idx, 1);
        renderQuestionList();
        updateCounter();
        updateBuilderButtons();
    });
}

// ============================================================
// QUESTION BUILDER — add / generate
// ============================================================

if (el.addQBtn) {
    el.addQBtn.addEventListener("click", () => {
        if (builderQuestions.length >= MAX_QUESTIONS_PER_ROOM) return;
        builderQuestions.push({
            text: "",
            options: ["", "", "", ""],
            correctIndex: 0,
            strikeWord: ""
        });
        renderQuestionList();
        updateCounter();
        updateBuilderButtons();
    });
}

if (el.generateBtn) {
    el.generateBtn.addEventListener("click", async () => {
        const remaining = MAX_QUESTIONS_PER_ROOM - builderQuestions.length;
        if (remaining <= 0) return;

        const requestCount = Math.min(GENERATE_BATCH_SIZE, remaining);

        el.generateBtn.disabled = true;
        el.generateBtn.textContent = "Generating...";

        try {
            const res = await authFetch("/api/rooms/generate-questions", {
                method: "POST",
                body: JSON.stringify({ count: requestCount })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message);

            // Append (not replace)
            const incoming = Array.isArray(data.questions) ? data.questions : [];
            const allowed = incoming.slice(0, MAX_QUESTIONS_PER_ROOM - builderQuestions.length);
            builderQuestions.push(...allowed);

            renderQuestionList();
            updateCounter();
        } catch (err) {
            alert("Generation failed: " + err.message);
        } finally {
            updateBuilderButtons();
        }
    });
}

// ============================================================
// CONFIRM CREATE
// ============================================================

if (el.confirmCreate) {
    el.confirmCreate.addEventListener("click", async () => {
        if (builderQuestions.length < MIN_QUESTIONS_PER_ROOM) {
            alert(`You need at least ${MIN_QUESTIONS_PER_ROOM} questions.`);
            return;
        }
        if (builderQuestions.length > MAX_QUESTIONS_PER_ROOM) {
            alert(`Maximum is ${MAX_QUESTIONS_PER_ROOM} questions.`);
            return;
        }

        // Validate every question
        for (let i = 0; i < builderQuestions.length; i++) {
            const q = builderQuestions[i];
            if (!q.text.trim()) {
                alert(`Question ${i + 1} is missing text.`);
                return;
            }
            if (q.options.some((o) => !o.trim())) {
                alert(`Question ${i + 1} has an empty option.`);
                return;
            }
            if (q.correctIndex < 0 || q.correctIndex > 3) {
                alert(`Question ${i + 1} has no correct answer selected.`);
                return;
            }
        }

        el.confirmCreate.disabled = true;
        el.confirmCreate.textContent = "Creating...";

        try {
            const res = await authFetch("/api/rooms/create", {
                method: "POST",
                body: JSON.stringify({
                    questions: builderQuestions,
                    roomName: el.roomNameInput.value.trim(),
                    hostMode: createHostMode
                })
            });

            const data = await res.json();
            if (!data.success) throw new Error(data.message);

            currentRoomId = data.roomId;
            myRole = createHostMode === "host" ? "host" : "player";
            el.waitingCode.textContent = data.code;

            subscribeToRoom(data.roomId);
            showPanel("waiting");
        } catch (err) {
            alert("Create failed: " + err.message);
        } finally {
            el.confirmCreate.disabled = false;
            el.confirmCreate.textContent = "Create Room";
        }
    });
}

// ============================================================
// JOIN ROOM
// ============================================================

if (el.joinBtn) {
    el.joinBtn.addEventListener("click", async () => {
        const code = el.codeInput.value.trim().toUpperCase();

        if (code.length !== 6) {
            showError("Enter a 6-character code.");
            return;
        }

        clearError();
        el.joinBtn.disabled = true;

        try {
            const res = await authFetch("/api/rooms/join", {
                method: "POST",
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message);

            currentRoomId = data.roomId;
            myRole = data.role || "player"; // joiners always get "player"

            subscribeToRoom(data.roomId);
        } catch (err) {
            showError(err.message);
        } finally {
            el.joinBtn.disabled = false;
        }
    });
}

// ============================================================
// SUBSCRIBE TO ROOM
// ============================================================

function subscribeToRoom(roomId) {
    if (roomUnsubscribe) roomUnsubscribe();

    roomUnsubscribe = onSnapshot(doc(fsDb, "rooms", roomId), (snap) => {
        if (!snap.exists()) {
            alert("Room expired or deleted.");
            backToLobby();
            return;
        }

        const data = snap.data();
        data.id = snap.id;
        currentRoom = data;

        const isCreator = data.creatorUid === currentUser?.uid;

        // Joiners are ALWAYS players. Only the creator can be a host.
        if (isCreator && data.hostMode === "host") {
            myRole = "host";
        } else if (data.players && data.players[currentUser?.uid]) {
            myRole = "player";
        }

        if (data.status === "waiting") {
            renderWaitingRoom(data, isCreator);
            showPanel("waiting");
        } else if (data.status === "playing") {
            renderGame(data, isCreator);
            showPanel("game");
        } else if (data.status === "finished") {
            renderFinished(data);
            showPanel("finished");
        }
    });
}

// ============================================================
// WAITING ROOM
// ============================================================

function renderWaitingRoom(room, isCreator) {
    el.waitingCode.textContent = room.code || "";
    el.waitingName.textContent = room.name || "Vocabulary Room";
    el.waitingHostMode.textContent =
        room.hostMode === "host" ? "👀 Spectator Host" : "🎮 Everyone Plays";

    const players = Object.entries(room.players || {}).map(([uid, p]) => ({ uid, ...p }));
    el.waitingPlayerCount.textContent = players.length;

    el.waitingPlayerList.innerHTML = players
        .map(
            (p) => `
        <li>
            <span>${escapeHTML(p.displayName)}${p.uid === room.creatorUid ? " 👑" : ""}</span>
            <span style="color:var(--muted);font-size:12px">Ready</span>
        </li>`
        )
        .join("");

    // Role toggle is visible to the CREATOR only
    if (isCreator) {
        el.lobbyRoleToggle.classList.remove("hidden");
        el.startGameBtn.classList.remove("hidden");
        el.waitingHint.textContent = "Click Start when everyone is ready.";

        if (room.hostMode === "host") {
            el.lobbyModeHostBtn.classList.add("active");
            el.lobbyModePlayerBtn.classList.remove("active");
            el.lobbyModeHint.textContent =
                "You're spectating. You'll control when to move to the next question.";
        } else {
            el.lobbyModePlayerBtn.classList.add("active");
            el.lobbyModeHostBtn.classList.remove("active");
            el.lobbyModeHint.textContent =
                "You're playing. Questions advance automatically when the timer ends.";
        }
    } else {
        // Joiners never see the role toggle
        el.lobbyRoleToggle.classList.add("hidden");
        el.startGameBtn.classList.add("hidden");
        el.waitingHint.textContent = "Waiting for the host to start…";
    }
}

// ============================================================
// LOBBY ROLE TOGGLE (creator only)
// ============================================================

async function changeHostMode(newMode) {
    if (!currentRoomId) return;
    try {
        const res = await authFetch(`/api/rooms/${currentRoomId}/mode`, {
            method: "POST",
            body: JSON.stringify({ hostMode: newMode })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
    } catch (err) {
        alert("Could not switch role: " + err.message);
    }
}

if (el.lobbyModePlayerBtn) {
    el.lobbyModePlayerBtn.addEventListener("click", () => {
        if (currentRoom?.hostMode === "player") return;
        changeHostMode("player");
    });
}

if (el.lobbyModeHostBtn) {
    el.lobbyModeHostBtn.addEventListener("click", () => {
        if (currentRoom?.hostMode === "host") return;
        changeHostMode("host");
    });
}

// ============================================================
// START GAME
// ============================================================

if (el.startGameBtn) {
    el.startGameBtn.addEventListener("click", async () => {
        if (!currentRoomId) return;
        el.startGameBtn.disabled = true;
        el.startGameBtn.textContent = "Starting...";

        try {
            const res = await authFetch(`/api/rooms/${currentRoomId}/start`, {
                method: "POST",
                body: JSON.stringify({})
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message);
        } catch (err) {
            alert("Start failed: " + err.message);
            el.startGameBtn.disabled = false;
            el.startGameBtn.textContent = "▶ Start Game";
        }
    });
}

// ============================================================
// GAME VIEW — DIFF-BASED RENDER
// ============================================================
//
// Firestore fires on every score update. Instead of rebuilding the
// whole view every tick, we compare values and only touch the DOM
// when something actually changed. This makes the room feel smooth.
// ============================================================

function renderGame(room, isCreator) {
    const qIdx = room.currentQuestionIndex || 0;
    const total = (room.questions || []).length;
    const question = room.questions[qIdx];
    if (!question) return;

    const isHost = isCreator && room.hostMode === "host";
    const me = room.players?.[currentUser?.uid];
    const isSpectator = isHost && !me;

    // ---- ROLE BANNER (only when text changes) ----
    const bannerText = isSpectator
        ? "👀 You are the host — students are playing"
        : "🎮 You are a player";
    const bannerClass = isSpectator ? "room-role-banner host" : "room-role-banner player";
    if (rendered.roleBannerText !== bannerText) {
        el.roleBanner.textContent = bannerText;
        el.roleBanner.className = bannerClass;
        rendered.roleBannerText = bannerText;
    }

    // ---- STATS (only when values change) ----
    const newScore = me ? String(me.score || 0) : "—";
    const newStreak = me ? String(me.streak || 0) : "—";
    const newQNum = String(qIdx + 1);

    if (el.score.textContent !== newScore) el.score.textContent = newScore;
    if (el.streak.textContent !== newStreak) el.streak.textContent = newStreak;
    if (el.questionNumber.textContent !== newQNum) el.questionNumber.textContent = newQNum;

    // ---- PROGRESS (only when qIdx changes) ----
    const progressPct = ((qIdx + 1) / total) * 100;
    const newWidth = `${progressPct}%`;
    if (el.progressBar.style.width !== newWidth) {
        el.progressBar.style.width = newWidth;
    }

    // ---- HOST CONTROLS ----
    const shouldShowHost = !!isHost;
    if (rendered.hostControlsVisible !== shouldShowHost) {
        el.hostNextBtn.classList.toggle("hidden", !shouldShowHost);
        el.hostEndBtn.classList.toggle("hidden", !shouldShowHost);
        rendered.hostControlsVisible = shouldShowHost;
    }

    // ---- TIMER CARD DIM ----
    const shouldDim = room.hostMode === "host";
    if (rendered.timerCardDim !== shouldDim) {
        el.timerCard.style.opacity = shouldDim ? "0.35" : "1";
        if (shouldDim) el.timer.textContent = "—";
        rendered.timerCardDim = shouldDim;
    }

    // ---- QUESTION + OPTIONS (only when qIdx changes) ----
    if (rendered.qIdx !== qIdx) {
        rendered.qIdx = qIdx;
        rendered.answeredForQ = -1;
        hideFeedback();

        // Question text with strike-through
        const escaped = escapeHTML(question.text);
        const strike = escapeRegExp(question.strikeWord || "");
        el.questionText.innerHTML = strike
            ? escaped.replace(new RegExp(`(${strike})`, "gi"), `<span class="badword">$1</span>`)
            : escaped;

        el.questionInstruction.textContent = isSpectator
            ? "Students are answering. You control when to advance."
            : "Replace the boring phrase with a stronger word.";

        renderOptions(question.options, isSpectator);

        // Restart timer for player-mode rooms
        if (room.hostMode === "host") {
            stopQuestionTimer();
        } else {
            startQuestionTimer(room.questionStartedAt, room.questionTime || 15);
        }
    }

    // ---- ALREADY ANSWERED? (only apply once per question) ----
    const myAnswer = me?.answers?.find((a) => a.questionIndex === qIdx);
    if (myAnswer && rendered.answeredForQ !== qIdx) {
        markAnswered(myAnswer.selectedIndex, question.correctIndex);
        rendered.answeredForQ = qIdx;
    }

    // ---- LIVE SCORES (only when the score signature changes) ----
    renderScoreList(room);
}

function renderOptions(options, isSpectator) {
    const buttons = el.options.querySelectorAll(".option");
    const letters = ["A", "B", "C", "D"];

    buttons.forEach((button, index) => {
        const opt = options[index];
        const text = button.querySelector(".option-text");
        const letter = button.querySelector(".option-letter");

        if (!opt) {
            button.style.display = "none";
            return;
        }

        button.style.display = "";
        button.disabled = isSpectator;
        button.classList.remove("correct", "wrong", "selected");
        button.dataset.index = index;
        button.dataset.answer = opt;
        text.textContent = opt;
        if (letter) letter.textContent = letters[index];

        // Attach a click handler that submits an answer
        button.onclick = isSpectator ? null : () => submitAnswer(index);
    });
}

// ============================================================
// SUBMIT ANSWER — OPTIMISTIC UI
// ============================================================
//
// We mark the button immediately (feels instant), then confirm
// with the server. If the server rejects, we revert.
// ============================================================

async function submitAnswer(selectedIndex) {
    if (!currentRoom || !currentUser) return;
    if (currentRoom.hostMode === "host" && !currentRoom.players?.[currentUser.uid]) return;

    const qIdx = currentRoom.currentQuestionIndex || 0;
    const question = currentRoom.questions[qIdx];

    // Optimistic UI: disable all buttons + show "checking"
    el.options.querySelectorAll(".option").forEach((b, i) => {
        b.disabled = true;
        if (i === selectedIndex) b.classList.add("selected");
    });

    try {
        const res = await authFetch(`/api/rooms/${currentRoomId}/answer`, {
            method: "POST",
            body: JSON.stringify({ questionIndex: qIdx, selectedIndex })
        });
        const data = await res.json();

        if (!data.success) {
            // Revert: remove selected class, re-enable buttons
            el.options.querySelectorAll(".option").forEach((b) => {
                b.classList.remove("selected");
                b.disabled = false;
            });
            showFeedback(false, data.message || "Could not submit.");
            return;
        }

        // Confirmed — apply correct/wrong markers
        markAnswered(selectedIndex, question.correctIndex);
        rendered.answeredForQ = qIdx;

        if (data.isCorrect) {
            showFeedback(
                true,
                `+${data.earned} points — ${question.options[question.correctIndex]} is the stronger word.`
            );
        } else {
            showFeedback(
                false,
                `The stronger word is ${question.options[question.correctIndex]}.`
            );
        }
    } catch (err) {
        console.error("Answer failed:", err);
        el.options.querySelectorAll(".option").forEach((b) => (b.disabled = false));
    }
}

function markAnswered(selectedIndex, correctIndex) {
    const buttons = el.options.querySelectorAll(".option");
    buttons.forEach((btn, idx) => {
        btn.disabled = true;
        btn.classList.remove("selected");
        if (idx === correctIndex) btn.classList.add("correct");
        if (idx === selectedIndex && idx !== correctIndex) btn.classList.add("wrong");
    });
}

function showFeedback(isCorrect, message) {
    el.feedback.classList.remove("hidden");
    el.feedbackTitle.textContent = isCorrect ? "CORRECT!" : "NOT QUITE!";
    el.feedbackText.textContent = message;
}

function hideFeedback() {
    el.feedback.classList.add("hidden");
}

// ============================================================
// HOST CONTROLS
// ============================================================

if (el.hostNextBtn) {
    el.hostNextBtn.addEventListener("click", async () => {
        if (!currentRoomId) return;
        el.hostNextBtn.disabled = true;
        const expectedIndex = currentRoom?.currentQuestionIndex ?? 0;

        try {
            await authFetch(`/api/rooms/${currentRoomId}/next`, {
                method: "POST",
                body: JSON.stringify({ expectedIndex })
            });
        } catch (err) {
            console.error("Next failed:", err);
        } finally {
            el.hostNextBtn.disabled = false;
        }
    });
}

if (el.hostEndBtn) {
    el.hostEndBtn.addEventListener("click", async () => {
        if (!currentRoomId) return;
        if (!confirm("End the game now?")) return;

        try {
            await authFetch(`/api/rooms/${currentRoomId}/end`, {
                method: "POST",
                body: JSON.stringify({})
            });
        } catch (err) {
            console.error("End failed:", err);
        }
    });
}

// ============================================================
// COUNTDOWN TIMER (visual only — server is authoritative)
// ============================================================

function startQuestionTimer(startedAtTimestamp, seconds) {
    stopQuestionTimer();

    const startedAtMs = startedAtTimestamp?.toMillis?.() || Date.now();
    const endMs = startedAtMs + seconds * 1000;

    function tick() {
        const remaining = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
        const newVal = String(remaining);
        if (el.timer.textContent !== newVal) el.timer.textContent = newVal;

        const urgent = remaining <= 5;
        if (el.timerCard.classList.contains("urgent") !== urgent) {
            el.timerCard.classList.toggle("urgent", urgent);
        }

        if (remaining <= 0) stopQuestionTimer();
    }

    tick();
    questionTimerInterval = setInterval(tick, 250);
}

function stopQuestionTimer() {
    if (questionTimerInterval) {
        clearInterval(questionTimerInterval);
        questionTimerInterval = null;
    }
}

// ============================================================
// LIVE SCORES — DIFF-BASED
// ============================================================

function renderScoreList(room) {
    const players = Object.entries(room.players || {}).map(([uid, p]) => ({ uid, ...p }));
    players.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Signature: uid + score for each player
    const sig = players.map((p) => `${p.uid}:${p.score || 0}`).join("|");
    if (sig === rendered.scoreSig) return;
    rendered.scoreSig = sig;

    el.gameScoreList.innerHTML = players
        .map((p, i) => {
            const isMe = p.uid === currentUser?.uid;
            return `
                <li class="${isMe ? "is-me" : ""}">
                    <span class="rank">#${i + 1}</span>
                    <span class="name">${escapeHTML(p.displayName)}${isMe ? " (you)" : ""}</span>
                    <span class="score">${p.score || 0}</span>
                </li>`;
        })
        .join("");
}

// ============================================================
// FINISHED VIEW
// ============================================================

function renderFinished(room) {
    stopQuestionTimer();

    const players = Object.entries(room.players || {}).map(([uid, p]) => ({ uid, ...p }));
    const sorted = players.sort((a, b) => (b.score || 0) - (a.score || 0));
    const medals = ["🥇", "🥈", "🥉"];

    el.finishedList.innerHTML = sorted
        .map((p, i) => {
            const isMe = p.uid === currentUser?.uid;
            return `
                <li class="finished-item ${isMe ? "is-me" : ""}">
                    <span class="medal">${medals[i] || "#" + (i + 1)}</span>
                    <span class="name">${escapeHTML(p.displayName)}${isMe ? " (you)" : ""}</span>
                    <span class="score">${p.score || 0} pts</span>
                </li>`;
        })
        .join("");
}

// ============================================================
// NAVIGATION
// ============================================================

if (el.leaveRoomBtn) {
    el.leaveRoomBtn.addEventListener("click", () => {
        if (!confirm("Leave this room?")) return;
        backToLobby();
    });
}

if (el.backToLobbyBtn) {
    el.backToLobbyBtn.addEventListener("click", () => {
        backToLobby();
    });
}

function backToLobby() {
    teardownRoom();
    showPanel("controls");
}

// ============================================================
// MISC
// ============================================================

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Auto-show controls on load if already signed in
if (getCurrentUser()) {
    el.controls.classList.remove("hidden");
    el.signedOut.classList.add("hidden");
}