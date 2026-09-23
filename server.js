require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();

const PORT = process.env.PORT || 3000;


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// PATHS
// ============================================================

const DATA_DIR =
    path.join(__dirname, "data");

const VOCAB_FILE =
    path.join(DATA_DIR, "vocabulary.json");

const TEMPLATE_FILE =
    path.join(DATA_DIR, "templates.json");


// ============================================================
// CREATE DATA DIRECTORY
// ============================================================

if (!fs.existsSync(DATA_DIR)) {

    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });

    console.log("Created data directory.");
}


// ============================================================
// CREATE EMPTY BANKS IF THEY DON'T EXIST
// ============================================================

function ensureDataFiles() {

    if (!fs.existsSync(VOCAB_FILE)) {

        fs.writeFileSync(
            VOCAB_FILE,
            JSON.stringify(
                {
                    vocabulary: []
                },
                null,
                2
            )
        );

        console.log(
            "Created vocabulary.json"
        );
    }


    if (!fs.existsSync(TEMPLATE_FILE)) {

        fs.writeFileSync(
            TEMPLATE_FILE,
            JSON.stringify(
                {
                    templates: []
                },
                null,
                2
            )
        );

        console.log(
            "Created templates.json"
        );
    }
}


ensureDataFiles();


// ============================================================
// READ JSON FILE
// ============================================================

function readJSON(filePath, fallback) {

    try {

        const data =
            fs.readFileSync(
                filePath,
                "utf8"
            );

        return JSON.parse(data);

    } catch (error) {

        console.error(
            `Could not read ${filePath}:`,
            error.message
        );

        return fallback;
    }
}


// ============================================================
// WRITE JSON FILE
// ============================================================

function writeJSON(filePath, data) {

    fs.writeFileSync(
        filePath,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}


// ============================================================
// GEMINI CONFIGURATION
// ============================================================
//
// Keep the API key ONLY in .env:
//
// GEMINI_API_KEY=your_key_here
//
// Never put this key in index.html,
// script.js or any browser-side file.
// ============================================================

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;


// Use one verified model name here.
// You can change this through .env:
//
// GEMINI_MODEL=gemini-3.8-flash
//

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.8-flash";


// ============================================================
// GEMINI REQUEST
// ============================================================

async function callGemini(prompt) {

    if (!GEMINI_API_KEY) {

        throw new Error(
            "GEMINI_API_KEY is missing from .env"
        );
    }


    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;


    const response =
        await fetch(
            url,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    contents: [
                        {
                            parts: [
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ],

                    generationConfig: {

                        temperature: 1.0,

                        responseMimeType:
                            "application/json"

                    }

                })
            }
        );


    const data =
        await response.json();


    if (!response.ok) {

        throw new Error(
            data.error?.message ||
            `Gemini API error: ${response.status}`
        );
    }

    console.log(
        "========== GEMINI RAW RESPONSE =========="
    );

    console.log(
        JSON.stringify(data, null, 2)
    );

    console.log(
        "=========================================="
    );

    const text =
        data
            .candidates?.[0]
            ?.content?.parts?.[0]
            ?.text;


    if (!text) {

        throw new Error(
            "Gemini returned an empty response."
        );
    }


    try {

        return JSON.parse(text);

    } catch (error) {

        console.error(
            "Gemini returned invalid JSON:",
            text
        );

        throw new Error(
            "Gemini response was not valid JSON."
        );
    }
}


// ============================================================
// CLEAN JSON STRING
// ============================================================

function cleanString(value) {

    if (
        typeof value !== "string"
    ) {
        return "";
    }

    return value
        .replace(/\s+/g, " ")
        .trim();
}


// ============================================================
// NORMALIZE VOCABULARY
// ============================================================

function normalizeVocabulary(items) {

    if (!Array.isArray(items)) {
        return [];
    }


    return items
        .map(item => {

            if (
                !item ||
                typeof item !== "object"
            ) {
                return null;
            }


            const bad =
                cleanString(item.bad);

            const answer =
                cleanString(item.answer);


            if (!bad || !answer) {
                return null;
            }


            return {

                id:
                    cleanString(item.id) ||
                    `${bad.toLowerCase()}-${answer.toLowerCase()}`,

                bad,

                answer,

                category:
                    cleanString(item.category) ||
                    "general",

                difficulty:
                    Number(item.difficulty) || 1,

                tip:
                    cleanString(item.tip),

                contexts:
                    Array.isArray(item.contexts)
                        ? item.contexts
                            .map(cleanString)
                            .filter(Boolean)
                        : [],

                subjects:
                    Array.isArray(item.subjects)
                        ? item.subjects
                            .map(cleanString)
                            .filter(Boolean)
                        : []

            };

        })
        .filter(Boolean);
}


// ============================================================
// NORMALIZE TEMPLATES
// ============================================================

function normalizeTemplates(items) {

    if (!Array.isArray(items)) {
        return [];
    }


    return items
        .map((item, index) => {

            if (
                !item ||
                typeof item !== "object"
            ) {
                return null;
            }


            const text =
                cleanString(item.text);


            if (!text) {
                return null;
            }


            return {

                id:
                    cleanString(item.id) ||
                    `template-${index + 1}`,

                category:
                    cleanString(item.category) ||
                    "general",

                text,

                subjects:
                    Array.isArray(item.subjects)
                        ? item.subjects
                            .map(cleanString)
                            .filter(Boolean)
                        : [],

                contexts:
                    Array.isArray(item.contexts)
                        ? item.contexts
                            .map(cleanString)
                            .filter(Boolean)
                        : []

            };

        })
        .filter(Boolean);
}


// ============================================================
// REMOVE DUPLICATE VOCABULARY
// ============================================================

function mergeVocabulary(
    existing,
    incoming
) {

    const map =
        new Map();


    for (const item of existing) {

        const key =
            `${item.bad.toLowerCase()}|${item.answer.toLowerCase()}`;

        map.set(
            key,
            item
        );
    }


    for (const item of incoming) {

        const key =
            `${item.bad.toLowerCase()}|${item.answer.toLowerCase()}`;

        if (!map.has(key)) {

            map.set(
                key,
                item
            );
        }
    }


    return Array.from(
        map.values()
    );
}


// ============================================================
// REMOVE DUPLICATE TEMPLATES
// ============================================================

function mergeTemplates(
    existing,
    incoming
) {

    const map =
        new Map();


    for (const item of existing) {

        const key =
            item.text.toLowerCase();

        map.set(
            key,
            item
        );
    }


    for (const item of incoming) {

        const key =
            item.text.toLowerCase();

        if (!map.has(key)) {

            map.set(
                key,
                item
            );
        }
    }


    return Array.from(
        map.values()
    );
}


// ============================================================
// GENERATE VOCABULARY BANK
// ============================================================

async function generateVocabulary(
    count = 30
) {

    const existingData =
        readJSON(
            VOCAB_FILE,
            { vocabulary: [] }
        );


    const existingVocabulary =
        Array.isArray(
            existingData.vocabulary
        )
            ? existingData.vocabulary
            : [];


    const existingBadWords =
        existingVocabulary
            .map(item => item.bad)
            .filter(Boolean);


    const prompt = `
You are creating content for a vocabulary improvement game called:

"Ban The Boring Word — Gen Z Edition"

The game teaches students to replace weak and overused expressions
with stronger, more precise vocabulary.

Generate exactly ${count} NEW vocabulary entries.

The boring phrase should normally begin with "VERY".

Examples:

VERY GOOD -> EXCEPTIONAL
VERY BAD -> TERRIBLE
VERY BIG -> ENORMOUS

Do NOT simply generate synonyms mechanically.
The replacement should sound natural in real English.

Return ONLY valid JSON.

Required format:

{
  "vocabulary": [
    {
      "id": "unique_id",
      "bad": "VERY GOOD",
      "answer": "EXCEPTIONAL",
      "category": "quality",
      "difficulty": 2,
      "tip": "EXCEPTIONAL means unusually excellent or impressive.",
      "contexts": [
        "during the competition",
        "under pressure",
        "for a beginner"
      ],
      "subjects": [
        "The performance",
        "The project",
        "The presentation"
      ]
    }
  ]
}

Rules:

1. "bad" must start with VERY.
2. Do not generate entries already in this list:
${JSON.stringify(existingBadWords)}

3. answer must be a single stronger English word.
4. Avoid obscure words that students would almost never encounter.
5. Mix easy, medium and difficult vocabulary.
6. Keep the answer clearly related to the boring phrase.
7. Use categories such as:
   - quality
   - size
   - speed
   - intelligence
   - emotion
   - appearance
   - difficulty
   - importance
   - quantity
   - sound
   - movement
   - general

8. Every entry must contain realistic contexts.
9. Every entry must contain realistic subjects.
10. Do not include HTML.
11. Do not include markdown.
12. Do not explain anything outside the JSON.
`;


    const result =
        await callGemini(prompt);


    const generated =
        normalizeVocabulary(
            result.vocabulary
        );


    const merged =
        mergeVocabulary(
            existingVocabulary,
            generated
        );


    writeJSON(
        VOCAB_FILE,
        {
            vocabulary: merged
        }
    );


    console.log(
        `Vocabulary bank: ${existingVocabulary.length} → ${merged.length}`
    );


    return {

        generated:
            generated.length,

        total:
            merged.length

    };
}


// ============================================================
// GENERATE TEMPLATE BANK
// ============================================================

async function generateTemplates(
    count = 30
) {

    const existingData =
        readJSON(
            TEMPLATE_FILE,
            { templates: [] }
        );


    const existingTemplates =
        Array.isArray(
            existingData.templates
        )
            ? existingData.templates
            : [];


    const existingTemplateTexts =
        existingTemplates
            .map(item => item.text)
            .filter(Boolean);


    const prompt = `
You are creating sentence templates for:

"Ban The Boring Word — Gen Z Edition"

The game gives a student a boring expression such as:

VERY GOOD

and asks them to replace it with a stronger word.

Generate exactly ${count} NEW sentence templates.

Return ONLY valid JSON.

Required format:

{
  "templates": [
    {
      "id": "quality_template_01",
      "category": "quality",
      "text": "{subject} was {bad} {context}.",
      "subjects": [
        "The performance",
        "The project",
        "The presentation"
      ],
      "contexts": [
        "during the competition",
        "under pressure",
        "for a beginner"
      ]
    }
  ]
}

Available placeholders:

{subject}
{bad}
{context}
{answer}

Rules:

1. The template must naturally work with the phrase represented by {bad}.
2. Keep sentences suitable for students.
3. Make templates genuinely different from each other.
4. Do not produce awkward or grammatically incorrect sentences.
5. Use a mixture of:
   - school
   - college
   - technology
   - sports
   - entertainment
   - travel
   - social situations
   - projects
   - competitions
   - everyday life

6. Keep the language natural.
7. Do not include HTML.
8. Do not include markdown.
9. Do not explain anything outside the JSON.

Do NOT repeat these existing templates:

${JSON.stringify(existingTemplateTexts)}
`;


    const result =
        await callGemini(prompt);


    const generated =
        normalizeTemplates(
            result.templates
        );


    const merged =
        mergeTemplates(
            existingTemplates,
            generated
        );


    writeJSON(
        TEMPLATE_FILE,
        {
            templates: merged
        }
    );


    console.log(
        `Template bank: ${existingTemplates.length} → ${merged.length}`
    );


    return {

        generated:
            generated.length,

        total:
            merged.length

    };
}


// ============================================================
// GENERATE BOTH BANKS
// ============================================================

async function generateContentBanks() {

    console.log(
        "\nGenerating vocabulary bank..."
    );


    const vocabulary =
        await generateVocabulary(30);


    console.log(
        "\nGenerating sentence template bank..."
    );


    const templates =
        await generateTemplates(30);


    return {
        vocabulary,
        templates
    };
}


// ============================================================
// API: GET CONTENT
// ============================================================
//
// script.js calls this endpoint if needed.
// ============================================================

app.get(
    "/api/content",
    (req, res) => {

        try {

            const vocabularyData =
                readJSON(
                    VOCAB_FILE,
                    { vocabulary: [] }
                );


            const templateData =
                readJSON(
                    TEMPLATE_FILE,
                    { templates: [] }
                );


            res.json({

                success: true,

                vocabulary:
                    vocabularyData.vocabulary || [],

                templates:
                    templateData.templates || []

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                success: false,

                message:
                    "Could not load content banks."

            });
        }
    }
);


// ============================================================
// API: GENERATE NEW CONTENT
// ============================================================
//
// Call this manually whenever you want Gemini
// to expand the banks.
//
// POST /api/generate-content
//
// Optional:
//
// {
//   "vocabulary": 30,
//   "templates": 30
// }
// ============================================================

app.post(
    "/api/generate-content",
    async (req, res) => {

        try {

            const vocabularyCount =
                Math.max(
                    1,
                    Math.min(
                        Number(
                            req.body.vocabulary
                        ) || 30,
                        100
                    )
                );


            const templateCount =
                Math.max(
                    1,
                    Math.min(
                        Number(
                            req.body.templates
                        ) || 30,
                        100
                    )
                );


            console.log(
                `Generating ${vocabularyCount} vocabulary entries and ${templateCount} templates...`
            );


            const vocabularyResult =
                await generateVocabulary(
                    vocabularyCount
                );


            const templateResult =
                await generateTemplates(
                    templateCount
                );


            res.json({

                success: true,

                vocabulary:
                    vocabularyResult,

                templates:
                    templateResult

            });

        } catch (error) {

            console.error(
                "Content generation failed:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Gemini content generation failed."

            });
        }
    }
);


// ============================================================
// API: HEALTH CHECK
// ============================================================

app.get(
    "/api/health",
    (req, res) => {

        res.json({

            success: true,

            server: "running",

            gemini:
                Boolean(
                    GEMINI_API_KEY
                ),

            model:
                GEMINI_MODEL

        });
    }
);


// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.send(
            "Ban The Boring Word backend is running."
        );
    }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            `\nBackend running on https://ban-world.onrender.com:${PORT}`
        );

        console.log(
            `Gemini model: ${GEMINI_MODEL}`
        );

        console.log(
            `Vocabulary file: ${VOCAB_FILE}`
        );

        console.log(
            `Template file: ${TEMPLATE_FILE}`
        );

    }
);