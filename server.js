require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// ============================================================
// FIREBASE ADMIN
// ============================================================
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp({
    credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
    })
});

// ============================================================
// DAILY STREAK HELPERS
// ============================================================
const DAILY_STREAK_MIN_QUESTIONS = 5;

function getUTCDateString(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
    if (!a || !b) return Infinity;
    const msPerDay = 24 * 60 * 60 * 1000;
    const ta = Date.parse(a + "T00:00:00Z");
    const tb = Date.parse(b + "T00:00:00Z");
    if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
    return Math.floor((tb - ta) / msPerDay);
}

function normalizeProfile(data, fallback = {}) {
    return {
        displayName: data.displayName || fallback.displayName || "",
        email: data.email || fallback.email || "",
        photoURL: data.photoURL || fallback.photoURL || "",
        totalScore: Number(data.totalScore) || 0,
        currentStreak: Number(data.currentStreak) || 0,
        bestStreak: Number(data.bestStreak) || 0,
        lastPlayedDate: data.lastPlayedDate || null,
        todayQuestionsAnswered: Number(data.todayQuestionsAnswered) || 0,
        lastQuestionDate: data.lastQuestionDate || null
    };
}

const db = getFirestore();
const fbAuth = getAuth();
const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_QUESTION_TIME = Number(process.env.QUESTION_TIME) || 15;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({ success: false, message: "Not signed in." });
    }
    try {
        const decoded = await fbAuth.verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        console.error("Token verification failed:", error.message);
        return res.status(401).json({ success: false, message: "Invalid token." });
    }
}

// ============================================================
// HELPERS
// ============================================================
function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function isRoomActive(roomData, now = new Date()) {
    if (!roomData || !roomData.expiresAt) return false;
    try {
        return roomData.expiresAt.toDate() > now;
    } catch {
        return false;
    }
}

// ============================================================
// API: HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        server: "running",
        gemini: Boolean(process.env.GEMINI_API_KEY),
        model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
        questionTime: DEFAULT_QUESTION_TIME,
        dailyStreakMin: DAILY_STREAK_MIN_QUESTIONS
    });
});

// ============================================================
// API: CREATE ROOM
// ============================================================
app.post("/api/rooms/create", requireAuth, async (req, res) => {
    try {
        const { questions, roomName, hostMode } = req.body;

        if (!Array.isArray(questions) || questions.length < 5 || questions.length > 20) {
            return res.status(400).json({ success: false, message: "Room needs 5-20 questions." });
        }

        for (const q of questions) {
            if (!q.text || !Array.isArray(q.options) || q.options.length !== 4 || typeof q.correctIndex !== "number") {
                return res.status(400).json({ success: false, message: "Invalid question format." });
            }
        }

        const mode = hostMode === "host" ? "host" : "player";
        const now = new Date();

        // ---- One active room per user (24 h window) ----
        const existingSnap = await db.collection("rooms")
            .where("creatorUid", "==", req.user.uid)
            .limit(10)
            .get();

        const existingActive = existingSnap.docs.find((d) => isRoomActive(d.data(), now));
        if (existingActive) {
            return res.status(400).json({
                success: false,
                message:
                    "You already have an active room. You can create a new one when the current room expires (up to 24 hours).",
                existingRoomId: existingActive.id,
                existingCode: existingActive.data().code
            });
        }

        // ---- Generate unique code ----
        let code;
        let attempts = 0;
        while (attempts < 20) {
            code = generateRoomCode();
            const snap = await db.collection("rooms")
                .where("code", "==", code)
                .limit(5)
                .get();
            const inUse = snap.docs.some((doc) => isRoomActive(doc.data(), now));
            if (!inUse) break;
            attempts++;
        }

        if (attempts >= 20) {
            return res.status(500).json({
                success: false,
                message: "Could not generate a unique room code. Try again."
            });
        }

        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        // ---- Build players map ----
        const players = {};
        if (mode === "player") {
            players[req.user.uid] = {
                displayName: req.user.name || req.user.email,
                photoURL: req.user.picture || "",
                score: 0,
                streak: 0,
                bestStreak: 0,
                answers: [],
                joinedAt: Timestamp.fromDate(now)
            };
        }

        const roomData = {
            code,
            name: roomName || "Vocabulary Room",
            creatorUid: req.user.uid,
            creatorName: req.user.name || req.user.email,
            createdAt: Timestamp.fromDate(now),
            expiresAt: Timestamp.fromDate(expiresAt),
            status: "waiting",
            hostMode: mode,
            currentQuestionIndex: 0,
            questionStartedAt: null,
            questionTime: DEFAULT_QUESTION_TIME,
            finishedAt: null,
            maxPlayers: 40,
            questions,
            players,
            playerUids: mode === "player" ? [req.user.uid] : []
        };

        const docRef = await db.collection("rooms").add(roomData);

        res.json({
            success: true,
            roomId: docRef.id,
            code,
            hostMode: mode,
            expiresAt: expiresAt.toISOString()
        });
    } catch (error) {
        console.error("Create room failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: JOIN ROOM
// ============================================================
app.post("/api/rooms/join", requireAuth, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, message: "Room code required." });
        }

        const snap = await db.collection("rooms")
            .where("code", "==", code.toUpperCase())
            .limit(5)
            .get();

        if (snap.empty) {
            return res.status(404).json({ success: false, message: "Room not found or expired." });
        }

        const now = new Date();
        const validDocs = snap.docs.filter((doc) => isRoomActive(doc.data(), now));

        if (validDocs.length === 0) {
            return res.status(404).json({ success: false, message: "Room not found or expired." });
        }

        const roomDoc = validDocs[0];
        const room = roomDoc.data();
        const isCreator = room.creatorUid === req.user.uid;
        const isHost = isCreator && room.hostMode === "host";

        // Already a player?
        if (room.players && room.players[req.user.uid]) {
            return res.json({
                success: true,
                roomId: roomDoc.id,
                role: "player"
            });
        }

        // Host (spectator) rejoining — don't add as player
        if (isHost) {
            return res.json({
                success: true,
                roomId: roomDoc.id,
                role: "host"
            });
        }

        // Full?
        if (Object.keys(room.players || {}).length >= room.maxPlayers) {
            return res.status(400).json({ success: false, message: "Room is full (40/40)." });
        }

        if (room.status === "finished") {
            return res.status(400).json({ success: false, message: "This room has already ended." });
        }

        // Add player + sync playerUids
        await roomDoc.ref.update({
            [`players.${req.user.uid}`]: {
                displayName: req.user.name || req.user.email,
                photoURL: req.user.picture || "",
                score: 0,
                streak: 0,
                bestStreak: 0,
                answers: [],
                joinedAt: Timestamp.fromDate(new Date())
            },
            playerUids: FieldValue.arrayUnion(req.user.uid)
        });

        res.json({
            success: true,
            roomId: roomDoc.id,
            role: "player"
        });
    } catch (error) {
        console.error("Join room failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: GET MY ACTIVE ROOM
// ============================================================
// Returns the room the user is currently in, if any.
// Priority: created room → joined room.
app.get("/api/rooms/mine", requireAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const now = new Date();

        // 1) Do they own an active room?
        const creatorSnap = await db.collection("rooms")
            .where("creatorUid", "==", uid)
            .limit(10)
            .get();

        const asCreator = creatorSnap.docs.find((d) => isRoomActive(d.data(), now));
        if (asCreator) {
            const data = asCreator.data();
            return res.json({
                success: true,
                roomId: asCreator.id,
                role: data.hostMode === "host" ? "host" : "player",
                isCreator: true,
                code: data.code,
                status: data.status
            });
        }

        // 2) Are they a player in an active room?
        const playerSnap = await db.collection("rooms")
            .where("playerUids", "array-contains", uid)
            .limit(10)
            .get();

        const asPlayer = playerSnap.docs.find((d) => isRoomActive(d.data(), now));
        if (asPlayer) {
            const data = asPlayer.data();
            return res.json({
                success: true,
                roomId: asPlayer.id,
                role: "player",
                isCreator: data.creatorUid === uid,
                code: data.code,
                status: data.status
            });
        }

        res.json({ success: true, roomId: null });
    } catch (error) {
        console.error("Mine rooms failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: LEAVE ROOM
// ============================================================
// Removes the user from the room. If they are the creator + host,
// the room is also marked finished.
// IMPORTANT: This is ONLY called on explicit Leave button click.
// Refresh / navigation does NOT call this, so the room stays.
app.post("/api/rooms/:roomId/leave", requireAuth, async (req, res) => {
    try {
        const roomRef = db.collection("rooms").doc(req.params.roomId);
        const room = await roomRef.get();

        if (!room.exists) {
            return res.json({ success: true, message: "Room already gone." });
        }

        const data = room.data();
        const uid = req.user.uid;

        const update = {
            playerUids: FieldValue.arrayRemove(uid)
        };
        update[`players.${uid}`] = FieldValue.delete();

        await roomRef.update(update);

        // If creator leaves as host → finish the room
        if (data.creatorUid === uid && data.hostMode === "host") {
            await roomRef.update({
                status: "finished",
                finishedAt: Timestamp.now()
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Leave room failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: CHANGE HOST MODE (creator only, waiting status only)
// ============================================================
app.post("/api/rooms/:roomId/mode", requireAuth, async (req, res) => {
    try {
        const { hostMode } = req.body;
        if (hostMode !== "player" && hostMode !== "host") {
            return res.status(400).json({ success: false, message: "hostMode must be 'player' or 'host'." });
        }

        const roomRef = db.collection("rooms").doc(req.params.roomId);
        const room = await roomRef.get();

        if (!room.exists) {
            return res.status(404).json({ success: false, message: "Room not found." });
        }

        const data = room.data();
        if (data.creatorUid !== req.user.uid) {
            return res.status(403).json({ success: false, message: "Only the room creator can change their role." });
        }
        if (data.status !== "waiting") {
            return res.status(400).json({ success: false, message: "Can only change role before the game starts." });
        }
        if (data.hostMode === hostMode) {
            return res.json({ success: true, message: "Already in that mode." });
        }

        const update = { hostMode };
        if (hostMode === "host") {
            update[`players.${req.user.uid}`] = FieldValue.delete();
            update.playerUids = FieldValue.arrayRemove(req.user.uid);
        } else {
            update[`players.${req.user.uid}`] = {
                displayName: req.user.name || req.user.email,
                photoURL: req.user.picture || "",
                score: 0,
                streak: 0,
                bestStreak: 0,
                answers: [],
                joinedAt: Timestamp.now()
            };
            update.playerUids = FieldValue.arrayUnion(req.user.uid);
        }

        await roomRef.update(update);
        res.json({ success: true, hostMode });
    } catch (error) {
        console.error("Mode change failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: START GAME (creator only)
// ============================================================
app.post("/api/rooms/:roomId/start", requireAuth, async (req, res) => {
    try {
        const roomRef = db.collection("rooms").doc(req.params.roomId);
        const room = await roomRef.get();

        if (!room.exists) {
            return res.status(404).json({ success: false, message: "Room not found." });
        }

        const data = room.data();
        if (data.creatorUid !== req.user.uid) {
            return res.status(403).json({ success: false, message: "Only the creator can start the room." });
        }
        if (data.status !== "waiting") {
            return res.status(400).json({ success: false, message: "Game has already started or ended." });
        }
        if (!data.questions || data.questions.length === 0) {
            return res.status(400).json({ success: false, message: "Room has no questions." });
        }

        await roomRef.update({
            status: "playing",
            currentQuestionIndex: 0,
            questionStartedAt: Timestamp.now()
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Start game failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: NEXT QUESTION (host mode only)
// ============================================================
app.post("/api/rooms/:roomId/next", requireAuth, async (req, res) => {
    try {
        const { expectedIndex } = req.body;
        const roomRef = db.collection("rooms").doc(req.params.roomId);
        const room = await roomRef.get();

        if (!room.exists) {
            return res.status(404).json({ success: false, message: "Room not found." });
        }

        const data = room.data();
        if (data.creatorUid !== req.user.uid) {
            return res.status(403).json({ success: false, message: "Only the host can advance." });
        }
        if (data.status !== "playing") {
            return res.json({ success: true, message: "Not playing." });
        }
        if (typeof expectedIndex === "number" && data.currentQuestionIndex !== expectedIndex) {
            return res.json({ success: true, message: "Already advanced." });
        }

        const nextIndex = (data.currentQuestionIndex || 0) + 1;
        const total = (data.questions || []).length;

        if (nextIndex >= total) {
            await roomRef.update({
                status: "finished",
                finishedAt: Timestamp.now()
            });
        } else {
            await roomRef.update({
                currentQuestionIndex: nextIndex,
                questionStartedAt: Timestamp.now()
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Next question failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: SUBMIT ANSWER
// ============================================================
app.post("/api/rooms/:roomId/answer", requireAuth, async (req, res) => {
    try {
        const { questionIndex, selectedIndex } = req.body;
        if (typeof questionIndex !== "number" || typeof selectedIndex !== "number") {
            return res.status(400).json({ success: false, message: "Invalid answer payload." });
        }

        const roomRef = db.collection("rooms").doc(req.params.roomId);
        const room = await roomRef.get();

        if (!room.exists) {
            return res.status(404).json({ success: false, message: "Room not found." });
        }

        const data = room.data();
        if (data.status !== "playing") {
            return res.status(400).json({ success: false, message: "Room is not playing." });
        }
        if (data.currentQuestionIndex !== questionIndex) {
            return res.status(400).json({ success: false, message: "Question already passed." });
        }

        const player = data.players && data.players[req.user.uid];
        if (!player) {
            return res.status(403).json({ success: false, message: "You're not a player in this room." });
        }

        const alreadyAnswered = (player.answers || []).some(
            (a) => a.questionIndex === questionIndex
        );
        if (alreadyAnswered) {
            return res.json({ success: true, message: "Already answered." });
        }

        const questions = data.questions || [];
        const question = questions[questionIndex];
        if (!question) {
            return res.status(400).json({ success: false, message: "Invalid question." });
        }

        const isCorrect = selectedIndex === question.correctIndex;
        const baseScore = isCorrect ? 100 : 0;
        const newStreak = isCorrect ? (player.streak || 0) + 1 : 0;
        const streakBonus = isCorrect ? Math.min(newStreak * 10, 100) : 0;
        const earned = baseScore + streakBonus;
        const newBestStreak = Math.max(player.bestStreak || 0, newStreak);

        const answerRecord = {
            questionIndex,
            selectedIndex,
            isCorrect,
            timestamp: Date.now()
        };

        await roomRef.update({
            [`players.${req.user.uid}.score`]: (player.score || 0) + earned,
            [`players.${req.user.uid}.streak`]: newStreak,
            [`players.${req.user.uid}.bestStreak`]: newBestStreak,
            [`players.${req.user.uid}.answers`]: FieldValue.arrayUnion(answerRecord)
        });

        // Update global user stats
        const userRef = db.collection("users").doc(req.user.uid);
        const userSnap = await userRef.get();
        const userData = userSnap.exists ? userSnap.data() : {};

        await userRef.set(
            {
                displayName: userData.displayName || req.user.name || "",
                email: userData.email || req.user.email || "",
                photoURL: userData.photoURL || req.user.picture || "",
                totalScore: (userData.totalScore || 0) + earned,
                bestStreak: Math.max(userData.bestStreak || 0, newBestStreak),
                updatedAt: Timestamp.now()
            },
            { merge: true }
        );

        res.json({ success: true, isCorrect, earned });
    } catch (error) {
        console.error("Answer failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: GENERATE QUESTIONS FROM BANK
// ============================================================
app.post("/api/rooms/generate-questions", requireAuth, async (req, res) => {
    try {
        const count = Math.min(Math.max(Number(req.body.count) || 6, 5), 20);
        const vocabData = readJSON(VOCAB_FILE, { vocabulary: [] });
        const vocab = vocabData.vocabulary || [];

        if (vocab.length < 4) {
            return res.status(400).json({ success: false, message: "Not enough vocabulary to generate questions." });
        }

        const shuffled = [...vocab].sort(() => Math.random() - 0.5);
        const questions = [];

        for (let i = 0; i < count && i < shuffled.length; i++) {
            const correct = shuffled[i];
            const distractors = shuffled
                .filter((v) => v.id !== correct.id && v.answer !== correct.answer)
                .slice(0, 3)
                .map((v) => v.answer);

            const options = [correct.answer, ...distractors].sort(() => Math.random() - 0.5);
            const correctIndex = options.indexOf(correct.answer);

            const templates = readJSON(TEMPLATE_FILE, { templates: [] }).templates || [];
            const template = templates[Math.floor(Math.random() * templates.length)];
            const templateText = template?.text || "The result was {bad}.";

            const text = templateText
                .replace(/\{subject\}/gi, "The performance")
                .replace(/\{context\}/gi, "")
                .replace(/\{bad\}/gi, correct.bad)
                .replace(/\{answer\}/gi, correct.answer)
                .replace(/\s+/g, " ")
                .trim();

            questions.push({
                text,
                options,
                correctIndex,
                strikeWord: correct.bad
            });
        }

        res.json({ success: true, questions });
    } catch (error) {
        console.error("Generate questions failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: GET ROOM DETAILS
// ============================================================
app.get("/api/rooms/:roomId", requireAuth, async (req, res) => {
    try {
        const doc = await db.collection("rooms").doc(req.params.roomId).get();
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: "Room not found." });
        }

        const data = doc.data();
        if (!isRoomActive(data)) {
            await doc.ref.delete();
            return res.status(404).json({ success: false, message: "Room expired." });
        }

        res.json({ success: true, room: { id: doc.id, ...data } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: END ROOM (creator only)
// ============================================================
app.post("/api/rooms/:roomId/end", requireAuth, async (req, res) => {
    try {
        const roomRef = db.collection("rooms").doc(req.params.roomId);
        const room = await roomRef.get();

        if (!room.exists) {
            return res.status(404).json({ success: false, message: "Room not found." });
        }
        if (room.data().creatorUid !== req.user.uid) {
            return res.status(403).json({ success: false, message: "Only the creator can end the room." });
        }

        await roomRef.update({
            status: "finished",
            finishedAt: Timestamp.now()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// SERVER-SIDE AUTO-ADVANCE (player-mode rooms only)
// ============================================================
async function autoAdvancePlayingRooms() {
    try {
        const snap = await db.collection("rooms")
            .where("status", "==", "playing")
            .get();

        if (snap.empty) return;

        const now = Date.now();
        const batch = db.batch();
        let updates = 0;

        for (const doc of snap.docs) {
            const data = doc.data();
            if (data.hostMode !== "player") continue;

            const startedAt = data.questionStartedAt?.toMillis?.() || 0;
            if (!startedAt) continue;

            const qTimeMs = (data.questionTime || DEFAULT_QUESTION_TIME) * 1000;
            const elapsed = now - startedAt;

            if (elapsed >= qTimeMs + 2000) {
                const nextIndex = (data.currentQuestionIndex || 0) + 1;
                const total = (data.questions || []).length;

                if (nextIndex >= total) {
                    batch.update(doc.ref, {
                        status: "finished",
                        finishedAt: Timestamp.now()
                    });
                } else {
                    batch.update(doc.ref, {
                        currentQuestionIndex: nextIndex,
                        questionStartedAt: Timestamp.now()
                    });
                }
                updates++;
            }
        }

        if (updates > 0) {
            await batch.commit();
            console.log(`[auto-advance] Updated ${updates} room(s).`);
        }
    } catch (err) {
        console.error("[auto-advance] Failed:", err.message);
    }
}

setInterval(autoAdvancePlayingRooms, 3000);

// ============================================================
// API: GET USER PROFILE
// ============================================================
app.get("/api/user/profile", requireAuth, async (req, res) => {
    try {
        const userRef = db.collection("users").doc(req.user.uid);
        const snap = await userRef.get();

        if (!snap.exists) {
            const freshProfile = {
                displayName: req.user.name || "",
                email: req.user.email || "",
                photoURL: req.user.picture || "",
                totalScore: 0,
                currentStreak: 0,
                bestStreak: 0,
                lastPlayedDate: null,
                todayQuestionsAnswered: 0,
                lastQuestionDate: null,
                createdAt: Timestamp.now(),
                updatedAt: Timestamp.now()
            };
            await userRef.set(freshProfile);
            const { createdAt, updatedAt, ...clientProfile } = freshProfile;
            return res.json({ success: true, profile: clientProfile });
        }

        const profile = normalizeProfile(snap.data());
        res.json({ success: true, profile });
    } catch (error) {
        console.error("Get profile failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// API: UPDATE USER SCORE + DAILY STREAK
// ============================================================
app.post("/api/user/score", requireAuth, async (req, res) => {
    try {
        const delta = Math.max(0, Number(req.body.deltaScore) || 0);
        const userRef = db.collection("users").doc(req.user.uid);
        const snap = await userRef.get();
        const data = snap.exists ? snap.data() : {};

        const profile = normalizeProfile(data, {
            displayName: req.user.name || "",
            email: req.user.email || "",
            photoURL: req.user.picture || ""
        });

        const today = getUTCDateString();
        let todayAnswered = profile.todayQuestionsAnswered;
        let lastQuestionDate = profile.lastQuestionDate;

        if (lastQuestionDate !== today) {
            todayAnswered = 0;
            lastQuestionDate = today;
        }
        todayAnswered += 1;

        let currentStreak = profile.currentStreak;
        let bestStreak = profile.bestStreak;
        let lastPlayedDate = profile.lastPlayedDate;

        const qualifiesToday = todayAnswered >= DAILY_STREAK_MIN_QUESTIONS;
        const alreadyCountedToday = lastPlayedDate === today;

        if (qualifiesToday && !alreadyCountedToday) {
            if (lastPlayedDate) {
                const gap = daysBetween(lastPlayedDate, today);
                if (gap === 1) {
                    currentStreak += 1;
                } else if (gap > 1) {
                    currentStreak = 1;
                } else {
                    currentStreak = Math.max(currentStreak, 1);
                }
            } else {
                currentStreak = 1;
            }
            lastPlayedDate = today;
            bestStreak = Math.max(bestStreak, currentStreak);
        }

        const totalScore = profile.totalScore + delta;

        const update = {
            displayName: profile.displayName || req.user.name || "",
            email: profile.email || req.user.email || "",
            photoURL: profile.photoURL || req.user.picture || "",
            totalScore,
            currentStreak,
            bestStreak,
            lastPlayedDate,
            todayQuestionsAnswered: todayAnswered,
            lastQuestionDate,
            updatedAt: Timestamp.now()
        };

        await userRef.set(update, { merge: true });
        const { updatedAt, ...clientProfile } = update;
        res.json({ success: true, profile: clientProfile });
    } catch (error) {
        console.error("User score update failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// ROOM CLEANUP (runs every 30 minutes)
// ============================================================
async function cleanupExpiredRooms() {
    try {
        const now = new Date();
        const snap = await db.collection("rooms").where("expiresAt", "<=", now).get();

        if (snap.empty) {
            console.log("[cleanup] No expired rooms.");
            return;
        }

        const batch = db.batch();
        snap.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        console.log(`[cleanup] Deleted ${snap.size} expired room(s).`);
    } catch (error) {
        console.error("[cleanup] Failed:", error.message);
    }
}

cleanupExpiredRooms();
setInterval(cleanupExpiredRooms, 30 * 60 * 1000);

// ============================================================
// PATHS
// ============================================================
const DATA_DIR = path.join(__dirname, "public", "data");
const VOCAB_FILE = path.join(DATA_DIR, "vocabulary.json");
const TEMPLATE_FILE = path.join(DATA_DIR, "templates.json");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log("Created data directory.");
}

function ensureDataFiles() {
    if (!fs.existsSync(VOCAB_FILE)) {
        fs.writeFileSync(VOCAB_FILE, JSON.stringify({ vocabulary: [] }, null, 2));
        console.log("Created vocabulary.json");
    }
    if (!fs.existsSync(TEMPLATE_FILE)) {
        fs.writeFileSync(TEMPLATE_FILE, JSON.stringify({ templates: [] }, null, 2));
        console.log("Created templates.json");
    }
}
ensureDataFiles();

function readJSON(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        console.error(`Could not read ${filePath}:`, error.message);
        return fallback;
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ============================================================
// GEMINI CONFIG
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

async function callGemini(prompt) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing from .env");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 1.0, responseMimeType: "application/json" }
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Gemini API error: ${response.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned an empty response.");

    try {
        return JSON.parse(text);
    } catch (error) {
        console.error("Gemini returned invalid JSON:", text);
        throw new Error("Gemini response was not valid JSON.");
    }
}

function cleanString(value) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim();
}

function normalizeVocabulary(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
        if (!item || typeof item !== "object") return null;
        const bad = cleanString(item.bad);
        const answer = cleanString(item.answer);
        if (!bad || !answer) return null;
        return {
            id: cleanString(item.id) || `${bad.toLowerCase()}-${answer.toLowerCase()}`,
            bad,
            answer,
            category: cleanString(item.category) || "general",
            difficulty: Number(item.difficulty) || 1,
            tip: cleanString(item.tip),
            contexts: Array.isArray(item.contexts) ? item.contexts.map(cleanString).filter(Boolean) : [],
            subjects: Array.isArray(item.subjects) ? item.subjects.map(cleanString).filter(Boolean) : []
        };
    }).filter(Boolean);
}

function normalizeTemplates(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const text = cleanString(item.text);
        if (!text) return null;
        return {
            id: cleanString(item.id) || `template-${index + 1}`,
            category: cleanString(item.category) || "general",
            text,
            subjects: Array.isArray(item.subjects) ? item.subjects.map(cleanString).filter(Boolean) : [],
            contexts: Array.isArray(item.contexts) ? item.contexts.map(cleanString).filter(Boolean) : []
        };
    }).filter(Boolean);
}

function mergeVocabulary(existing, incoming) {
    const map = new Map();
    for (const item of existing) map.set(`${item.bad.toLowerCase()}|${item.answer.toLowerCase()}`, item);
    for (const item of incoming) {
        const key = `${item.bad.toLowerCase()}|${item.answer.toLowerCase()}`;
        if (!map.has(key)) map.set(key, item);
    }
    return Array.from(map.values());
}

function mergeTemplates(existing, incoming) {
    const map = new Map();
    for (const item of existing) map.set(item.text.toLowerCase(), item);
    for (const item of incoming) {
        const key = item.text.toLowerCase();
        if (!map.has(key)) map.set(key, item);
    }
    return Array.from(map.values());
}

async function generateVocabulary(count = 30) {
    const existingData = readJSON(VOCAB_FILE, { vocabulary: [] });
    const existingVocabulary = Array.isArray(existingData.vocabulary) ? existingData.vocabulary : [];
    const existingBadWords = existingVocabulary.map((item) => item.bad).filter(Boolean);

    const prompt = `You are creating content for a vocabulary game called "Ban The Boring Word — Gen Z Edition".
Generate exactly ${count} NEW vocabulary entries.
Examples: VERY GOOD -> EXCEPTIONAL, VERY BAD -> TERRIBLE, VERY BIG -> ENORMOUS.
Return ONLY valid JSON in this format:
{
  "vocabulary": [
    {
      "id": "unique_id",
      "bad": "VERY GOOD",
      "answer": "EXCEPTIONAL",
      "category": "quality",
      "difficulty": 2,
      "tip": "EXCEPTIONAL means unusually excellent.",
      "contexts": ["during the competition"],
      "subjects": ["The performance"]
    }
  ]
}
Rules:
1. "bad" must start with VERY.
2. Avoid these existing entries: ${JSON.stringify(existingBadWords)}
3. answer must be a single stronger English word.
4. Avoid obscure words.
5. Mix easy/medium/difficult.
6. Use categories: quality, size, speed, intelligence, emotion, appearance, difficulty, importance, quantity, sound, movement, general.
7. Every entry must have realistic contexts and subjects.
8. No HTML, no markdown, no explanation.`;

    const result = await callGemini(prompt);
    const generated = normalizeVocabulary(result.vocabulary);
    const merged = mergeVocabulary(existingVocabulary, generated);
    writeJSON(VOCAB_FILE, { vocabulary: merged });
    console.log(`Vocabulary bank: ${existingVocabulary.length} → ${merged.length}`);
    return { generated: generated.length, total: merged.length };
}

async function generateTemplates(count = 30) {
    const existingData = readJSON(TEMPLATE_FILE, { templates: [] });
    const existingTemplates = Array.isArray(existingData.templates) ? existingData.templates : [];
    const existingTemplateTexts = existingTemplates.map((item) => item.text).filter(Boolean);

    const prompt = `You are creating sentence templates for "Ban The Boring Word — Gen Z Edition".
Generate exactly ${count} NEW sentence templates.
Return ONLY valid JSON:
{
  "templates": [
    {
      "id": "quality_template_01",
      "category": "quality",
      "text": "{subject} was {bad} {context}.",
      "subjects": ["The performance"],
      "contexts": ["during the competition"]
    }
  ]
}
Available placeholders: {subject}, {bad}, {context}, {answer}
Rules:
1. Template must work with {bad}.
2. Suitable for students.
3. Mix school, college, sports, technology, etc.
4. No HTML, no markdown, no explanation.
5. Do NOT repeat: ${JSON.stringify(existingTemplateTexts)}`;

    const result = await callGemini(prompt);
    const generated = normalizeTemplates(result.templates);
    const merged = mergeTemplates(existingTemplates, generated);
    writeJSON(TEMPLATE_FILE, { templates: merged });
    console.log(`Template bank: ${existingTemplates.length} → ${merged.length}`);
    return { generated: generated.length, total: merged.length };
}

// ============================================================
// API: GET CONTENT
// ============================================================
app.get("/api/content", (req, res) => {
    try {
        const vocabularyData = readJSON(VOCAB_FILE, { vocabulary: [] });
        const templateData = readJSON(TEMPLATE_FILE, { templates: [] });
        res.json({
            success: true,
            vocabulary: vocabularyData.vocabulary || [],
            templates: templateData.templates || []
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Could not load content banks." });
    }
});

// ============================================================
// API: GENERATE NEW CONTENT
// ============================================================
app.post("/api/generate-content", async (req, res) => {
    try {
        const vocabularyCount = Math.max(1, Math.min(Number(req.body.vocabulary) || 30, 100));
        const templateCount = Math.max(1, Math.min(Number(req.body.templates) || 30, 100));

        console.log(`Generating ${vocabularyCount} vocab + ${templateCount} templates...`);
        const vocabularyResult = await generateVocabulary(vocabularyCount);
        const templateResult = await generateTemplates(templateCount);

        res.json({
            success: true,
            vocabulary: vocabularyResult,
            templates: templateResult
        });
    } catch (error) {
        console.error("Content generation failed:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Gemini content generation failed."
        });
    }
});

// ============================================================
// ROOT
// ============================================================
app.get("/", (req, res) => {
    res.send("BanWorld backend is running.");
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`\nBackend running on http://localhost:${PORT}`);
    console.log(`Gemini model: ${GEMINI_MODEL}`);
    console.log(`Default question time: ${DEFAULT_QUESTION_TIME}s`);
    console.log(`Vocabulary file: ${VOCAB_FILE}`);
    console.log(`Template file: ${TEMPLATE_FILE}`);
});