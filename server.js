const express = require("express"); //server web
const mysql = require("mysql2"); //conectare la MySQL
const cors = require("cors"); //permite request-uri din frontend
const bcrypt = require("bcrypt"); //pt criptarea parolei
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mammoth = require("mammoth");

const jwt = require("jsonwebtoken");
const SECRET_KEY = process.env.SECRET_KEY || "secret_key_123";

const PDFDocument = require("pdfkit"); // generare PDF

const app = express();

app.use(cors());
app.use(express.json());

//conectare express la fisierele statice
app.use(express.static("public"));

const db = mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "W8M77!zZky",
    database: process.env.DB_NAME || "workshop_db"
});

db.connect((e) => {
    if (e)
        console.error("Eroare conectare DB:", e);
    else
        console.log("Conectat la MySQL!");
});

const uploadsDir = path.join(__dirname, "uploads");
const materialsFile = path.join(__dirname, "materials.json");
const quizzesFile = path.join(__dirname, "quizzes.json");
const quizAttemptsFile = path.join(__dirname, "quiz_attempts.json");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(materialsFile)) {
    fs.writeFileSync(materialsFile, "[]", "utf8");
}
if (!fs.existsSync(quizzesFile)) {
    fs.writeFileSync(quizzesFile, "[]", "utf8");
}
if (!fs.existsSync(quizAttemptsFile)) {
    fs.writeFileSync(quizAttemptsFile, "[]", "utf8");
}

const query = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.query(sql, params, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });

const getWorkshopOwner = async (idWorkshop) => {
    const rows = await query("SELECT idWorkshop, idInstructor FROM WORKSHOPS WHERE idWorkshop = ?", [idWorkshop]);
    return rows.length ? rows[0] : null;
};

const ensureInstructorOwnsWorkshop = async (idWorkshop, idUtilizator) => {
    const row = await getWorkshopOwner(idWorkshop);
    if (!row) return { ok: false, status: 404, mesaj: "Workshop inexistent!" };
    if (Number(row.idInstructor) !== Number(idUtilizator)) {
        return { ok: false, status: 403, mesaj: "Acces interzis!" };
    }
    return { ok: true };
};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ mesaj: "Token lipsă!" });

    jwt.verify(token, SECRET_KEY, (err, payload) => {
        if (err) return res.status(403).json({ mesaj: "Token invalid!" });
        req.user = payload;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.rol !== "admin") {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }
    next();
};

const requireInstructorOrAdmin = (req, res, next) => {
    if (!req.user || (req.user.rol !== "instructor" && req.user.rol !== "admin")) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }
    next();
};

const readMaterials = () => {
    try {
        const raw = fs.readFileSync(materialsFile, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("Eroare la citirea materialelor:", err);
        return [];
    }
};

const writeMaterials = (materials) => {
    fs.writeFileSync(materialsFile, JSON.stringify(materials, null, 2), "utf8");
};

const logActivity = async ({ idUtilizator, idWorkshop, tip }) => {
    const userId = Number(idUtilizator);
    const workshopId = Number(idWorkshop);
    if (!userId || !workshopId || !tip) return;
    try {
        await query(
            "INSERT INTO ACTIVITATE_LOG (idUtilizator, idWorkshop, tip) VALUES (?, ?, ?)",
            [userId, workshopId, String(tip)]
        );
    } catch (err) {
        console.error("Eroare log activitate:", err);
    }
};

const readQuizzes = () => {
    try {
        const raw = fs.readFileSync(quizzesFile, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("Eroare la citirea quiz-urilor:", err);
        return [];
    }
};

const writeQuizzes = (quizzes) => {
    fs.writeFileSync(quizzesFile, JSON.stringify(quizzes, null, 2), "utf8");
};

const readQuizAttempts = () => {
    try {
        const raw = fs.readFileSync(quizAttemptsFile, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("Eroare la citirea incercarilor de quiz:", err);
        return [];
    }
};

const writeQuizAttempts = (attempts) => {
    fs.writeFileSync(quizAttemptsFile, JSON.stringify(attempts, null, 2), "utf8");
};

const attendanceRequirementsForWorkshop = (idWorkshop) => {
    const hasMaterials = readMaterials().some((material) =>
        Number(material.idWorkshop) === Number(idWorkshop)
        && fs.existsSync(path.join(uploadsDir, material.fileName))
    );
    const hasQuizzes = readQuizzes().some((quiz) => Number(quiz.idWorkshop) === Number(idWorkshop));
    return {
        hasMaterials,
        hasQuizzes
    };
};

const computeAutoPresence = (idWorkshop, hasDownload, hasQuiz) => {
    const requirements = attendanceRequirementsForWorkshop(idWorkshop);
    if (!requirements.hasMaterials && !requirements.hasQuizzes) {
        return false;
    }
    if (requirements.hasMaterials && !hasDownload) {
        return false;
    }
    if (requirements.hasQuizzes && !hasQuiz) {
        return false;
    }
    return true;
};

const parseDocxQuestions = (rawText) => {
    const lines = String(rawText || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const questions = [];
    let current = null;

    const pushCurrent = () => {
        if (!current) return;
        const text = String(current.text || "").trim();
        if (!text) {
            throw new Error("Există o întrebare fără text.");
        }
        if (current.options.length < 2) {
            throw new Error(`Întrebarea "${text}" trebuie să aibă cel puțin 2 opțiuni.`);
        }
        if (!current.correctLabel) {
            throw new Error(`Lipsește linia Correct pentru întrebarea "${text}".`);
        }
        const correctIndex = current.options.findIndex((opt) => opt.label === current.correctLabel);
        if (correctIndex < 0) {
            throw new Error(`Răspunsul corect nu există în opțiuni pentru întrebarea "${text}".`);
        }
        questions.push({
            id: `q_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
            text,
            options: current.options.map((opt) => opt.text),
            correctIndex,
            explanation: String(current.explanation || "").trim(),
            checkpoint: false
        });
    };

    for (const line of lines) {
        const questionMatch = line.match(/^Q:\s*(.+)$/i);
        if (questionMatch) {
            pushCurrent();
            current = {
                text: questionMatch[1].trim(),
                options: [],
                correctLabel: null,
                explanation: ""
            };
            continue;
        }

        const optionMatch = line.match(/^([A-Z])\)\s*(.+)$/);
        if (optionMatch) {
            if (!current) {
                throw new Error("Opțiune găsită înainte de întrebare (Q:).");
            }
            current.options.push({
                label: optionMatch[1].toUpperCase(),
                text: optionMatch[2].trim()
            });
            continue;
        }

        const correctMatch = line.match(/^Correct:\s*([A-Z])\b/i);
        if (correctMatch) {
            if (!current) {
                throw new Error("Linia Correct nu este asociată unei întrebări.");
            }
            current.correctLabel = correctMatch[1].toUpperCase();
            continue;
        }

        const explanationMatch = line.match(/^Explanation:\s*(.+)$/i);
        if (explanationMatch) {
            if (!current) {
                throw new Error("Linia Explanation nu este asociată unei întrebări.");
            }
            current.explanation = explanationMatch[1].trim();
            continue;
        }

        if (!current) {
            continue;
        }

        if (current.options.length === 0) {
            current.text = `${current.text} ${line}`.trim();
        } else {
            const lastOption = current.options[current.options.length - 1];
            lastOption.text = `${lastOption.text} ${line}`.trim();
        }
    }

    pushCurrent();

    if (!questions.length) {
        throw new Error("Nu am găsit întrebări valide în document.");
    }

    return questions;
};

const quizProgressForUser = (attempts, idWorkshop, idUtilizator, quizId, allowLegacy) => {
    const entry = attempts.find(
        (a) => String(a.idWorkshop) === String(idWorkshop) && String(a.idUtilizator) === String(idUtilizator)
    );
    const list = Array.isArray(entry?.attempts) ? entry.attempts : [];
    const isForQuiz = (attempt) => {
        if (!attempt) return false;
        if (String(attempt.quizId || "") === String(quizId)) return true;
        return Boolean(allowLegacy && !attempt.quizId);
    };
    const checkpointAttempts = list.filter((a) => a.type === "checkpoint" && isForQuiz(a));
    const checkpointPassed = checkpointAttempts.some((a) => a.passed);
    const quizAttempts = list.filter((a) => a.type === "quiz" && isForQuiz(a));
    const quizPassed = quizAttempts.some((a) => a.passed);
    const checkpointAttempted = checkpointAttempts.length > 0;
    const quizAttempted = quizAttempts.length > 0;
    const lastCheckpoint = checkpointAttempts.length ? checkpointAttempts[checkpointAttempts.length - 1] : null;
    const lastQuiz = quizAttempts.length ? quizAttempts[quizAttempts.length - 1] : null;
    return {
        attempts: checkpointAttempts.length + quizAttempts.length,
        checkpointPassed,
        quizPassed,
        checkpointAttempted,
        quizAttempted,
        lastCheckpointAnswers: Array.isArray(lastCheckpoint?.answers) ? lastCheckpoint.answers : [],
        lastQuizAnswers: Array.isArray(lastQuiz?.answers) ? lastQuiz.answers : [],
        lastScore: lastQuiz ? lastQuiz.score : null
    };
};

const toDateOnly = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
};

const deriveStatus = (currentStatus, workshopDate, durataOre) => {
    const normalized = String(currentStatus || "inscris").toLowerCase();
    const start = new Date(workshopDate);
    if (Number.isNaN(start.getTime())) return normalized;

    const duration = Number(durataOre);
    const end = new Date(start);
    if (Number.isFinite(duration) && duration > 0) {
        end.setHours(end.getHours() + duration);
    } else {
        end.setHours(23, 59, 59, 999);
    }

    const now = new Date();

    if (now < start) {
        return normalized === "finalizat" ? "finalizat" : "inscris";
    }
    if (now >= start && now <= end) return "in_curs";
    return "finalizat";
};

const allowedExtensions = new Set([
    ".pdf",
    ".ppt",
    ".pptx",
    ".doc",
    ".docx",
    ".zip",
    ".rar",
    ".7z"
]);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeName = `${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.has(ext)) {
            return cb(new Error("Format de fișier neacceptat."));
        }
        cb(null, true);
    }
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.get("/workshops", (req, res) => {
    const { data, nivel, categorie, status } = req.query;
    let sql = `SELECT W.*, COUNT(i.idInscriere) AS nrParticipanti FROM WORKSHOPS w LEFT JOIN INSCRIERI i ON i.idWorkshop = w.idWorkshop WHERE 1=1`;

    const params = [];

    if (data) {
        sql += ` AND DATE(w.data) = ?`;
        params.push(data);
    }
    if (nivel) {
        sql += ` AND W.idNivel = ?`;
        params.push(nivel);
    }
    if (categorie) {
        sql += ` AND W.idCategorie = ?`;
        params.push(categorie);
    }
    if (status) {
        sql += ` AND W.status = ?`;
        params.push(status);
    }

    sql += ` GROUP BY W.idWorkshop`;

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la preluarea workshop-urilor!" });
        }
        res.json(results);
    });
});

app.get("/workshops/:id", (req, res) => {
    const idWorkshop = req.params.id;

    const sql = `SELECT W.*, COUNT(i.idInscriere) AS nrParticipanti, u.nume AS numeInstructor
                FROM WORKSHOPS w
                LEFT JOIN INSCRIERI i ON i.idWorkshop = w.idWorkshop
                LEFT JOIN UTILIZATORI u ON w.idInstructor = u.idUtilizator
                WHERE w.idWorkshop = ?
                GROUP BY w.idWorkshop`;

    db.query(sql, [idWorkshop], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la preluarea workshop-ului" });
        }
        if (!results.length) {
            return res.status(404).json({ mesaj: "Workshop inexistent" });
        }
        res.json(results[0]);
    });
});

app.post("/recenzii", authenticateToken, (req, res) => {
    const { idWorkshop, rating, comentariu } = req.body;
    const idUtilizator = req.user?.idUtilizator;

    if (!idWorkshop || !idUtilizator) {
        return res.status(400).json({ mesaj: "Date lipsă!" });
    }

    const ratingNumber = Number(rating);
    const comentariuCurat = String(comentariu || "").trim();

    if (!Number.isFinite(ratingNumber) || ratingNumber < 1 || ratingNumber > 5) {
        return res.status(400).json({ mesaj: "Rating invalid!" });
    }

    if (!comentariuCurat) {
        return res.status(400).json({ mesaj: "Comentariu obligatoriu!" });
    }

    const enrollSql = "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idWorkshop = ? AND idUtilizator = ?";
    db.query(enrollSql, [idWorkshop, idUtilizator], (enrollErr, enrollRows) => {
        if (enrollErr) {
            console.error(enrollErr);
            return res.status(500).json({ mesaj: "Eroare la verificare înscriere!" });
        }

        const isEnrolled = Number(enrollRows?.[0]?.total || 0) > 0;
        if (!isEnrolled) {
            return res.status(403).json({ mesaj: "Doar participanții înscriși pot adăuga recenzii." });
        }

        const checkSql = "SELECT idRecenzie FROM RECENZII WHERE idWorkshop = ? AND idUtilizator = ? LIMIT 1";
        db.query(checkSql, [idWorkshop, idUtilizator], (checkErr, checkRows) => {
            if (checkErr) {
                console.error(checkErr);
                return res.status(500).json({ mesaj: "Eroare la verificarea recenziei!" });
            }

            if (checkRows.length) {
                return res.status(409).json({ mesaj: "Ai deja o recenzie. O poți modifica." });
            }

            const sql = `INSERT INTO RECENZII (idWorkshop, idUtilizator, rating, comentariu, data_recenzie)
                            VALUES (?, ?, ?, ?, NOW())`;
            db.query(sql, [idWorkshop, idUtilizator, ratingNumber, comentariuCurat], (e) => {
                if (e) {
                    console.error(e);
                    return res.status(500).json({ mesaj: "Eroare la adăugare recenzie!" });
                }

                res.json({ mesaj: "Recenzie adăugată cu succes!" });
            });
        });
    });
});

app.put("/recenzii", authenticateToken, (req, res) => {
    const { idWorkshop, rating, comentariu } = req.body;
    const idUtilizator = req.user?.idUtilizator;

    if (!idWorkshop || !idUtilizator) {
        return res.status(400).json({ mesaj: "Date lipsă!" });
    }

    const ratingNumber = Number(rating);
    const comentariuCurat = String(comentariu || "").trim();

    if (!Number.isFinite(ratingNumber) || ratingNumber < 1 || ratingNumber > 5) {
        return res.status(400).json({ mesaj: "Rating invalid!" });
    }

    if (!comentariuCurat) {
        return res.status(400).json({ mesaj: "Comentariu obligatoriu!" });
    }

    const enrollSql = "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idWorkshop = ? AND idUtilizator = ?";
    db.query(enrollSql, [idWorkshop, idUtilizator], (enrollErr, enrollRows) => {
        if (enrollErr) {
            console.error(enrollErr);
            return res.status(500).json({ mesaj: "Eroare la verificare înscriere!" });
        }

        const isEnrolled = Number(enrollRows?.[0]?.total || 0) > 0;
        if (!isEnrolled) {
            return res.status(403).json({ mesaj: "Doar participanții înscriși pot modifica recenzii." });
        }

        const checkSql = "SELECT idRecenzie FROM RECENZII WHERE idWorkshop = ? AND idUtilizator = ? LIMIT 1";
        db.query(checkSql, [idWorkshop, idUtilizator], (checkErr, checkRows) => {
            if (checkErr) {
                console.error(checkErr);
                return res.status(500).json({ mesaj: "Eroare la verificarea recenziei!" });
            }

            if (!checkRows.length) {
                return res.status(404).json({ mesaj: "Recenzie inexistentă!" });
            }

            const updateSql = `UPDATE RECENZII
                               SET rating = ?, comentariu = ?, data_recenzie = NOW()
                               WHERE idWorkshop = ? AND idUtilizator = ?`;
            db.query(updateSql, [ratingNumber, comentariuCurat, idWorkshop, idUtilizator], (e) => {
                if (e) {
                    console.error(e);
                    return res.status(500).json({ mesaj: "Eroare la actualizare recenzie!" });
                }

                res.json({ mesaj: "Recenzie actualizată cu succes!" });
            });
        });
    });
});

app.get("/workshops/:id/recenzii", (req, res) => {
    const idWorkshop = req.params.id;

    const sql = `SELECT r.rating, r.comentariu, r.data_recenzie, r.idUtilizator, u.nume AS numeUtilizator
                FROM RECENZII r
                JOIN UTILIZATORI u ON r.idUtilizator = u.idUtilizator
                WHERE r.idWorkshop = ?`;
    db.query(sql, [idWorkshop], (e, rezultate) => {
        if (e) {
            console.error(e);
            return res.status(500).json({ mesaj: "Eroare la preluarea recenziilor!" });
        }
        res.json(rezultate);
    });
});

//login
app.post("/login", (req, res) => {
    const { email, parola } = req.body;
    const sql = `SELECT u.idUtilizator, u.nume, u.email,u.parola, u.data_inregistrarii, r.denumireRol 
                FROM UTILIZATORI u 
                JOIN ROLURI r ON u.idRol = r.idRol
                WHERE u.email = ?`;

    db.query(sql, [email], async (e, results) => {
        if (e)
            return res.status(500).json({ mesaj: "Eroare server!" });

        if (results.length > 0) {
            const user = results[0];

            const parolaCorecta = await bcrypt.compare(parola, user.parola);

            if (!parolaCorecta)
                return res.status(401).json({ mesaj: "Email sau parolă incorectă!" });

            delete user.parola;

            const token = jwt.sign(
                {
                    idUtilizator: user.idUtilizator,
                    rol: user.denumireRol
                },
                SECRET_KEY,
                { expiresIn: "1h" }
            );

            res.json({
                mesaj: "Login reușit!",
                token,
                utilizator: user
            });
        }
        else
            res.status(401).json({ mesaj: "Email sau parolă incorectă!" });
    });
});

//register
app.post("/register", async (req, res) => {
    const { nume, email, parola, idRol } = req.body;

    //vf daca email-ul exista deja
    const vfSQL = "SELECT * FROM utilizatori WHERE email = ?";

    db.query(vfSQL, [email], async (e, rezultate) => {
        if (e)
            return res.status(500).json({ mesaj: "Eroare server!" });
        if (rezultate.length > 0)
            return res.status(400).json({ mesaj: "Email deja existent!" });

        try {
            //hash parola
            const hash = await bcrypt.hash(parola, 10);
            const insertSQL = `INSERT INTO utilizatori(nume, email, parola, idRol, data_inregistrarii)
                            VALUES (?, ?, ?, ?, NOW())`;
            db.query(insertSQL, [nume, email, hash, idRol], (e2) => {
                if (e2)
                    return res.status(500).json({ mesaj: "Eroare la înregistrare!" });
                res.json({ mesaj: "Cont creat cu succes!" });
            });
        } catch (e) {
            res.status(500).json({ mesaj: "Eroare la criptarea parolei!" });
        }
    });
});

app.get("/utilizatori/:id", authenticateToken, async (req, res) => {
    const idUtilizator = Number(req.params.id);
    if (!idUtilizator) return res.status(400).json({ mesaj: "Utilizator invalid!" });

    if (req.user.rol !== "admin" && Number(req.user.idUtilizator) !== idUtilizator) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    try {
        const rows = await query(
            `SELECT u.idUtilizator, u.nume, u.email, u.data_inregistrarii, r.denumireRol
             FROM UTILIZATORI u
             JOIN ROLURI r ON u.idRol = r.idRol
             WHERE u.idUtilizator = ?`,
            [idUtilizator]
        );
        if (!rows.length) return res.status(404).json({ mesaj: "Utilizator inexistent!" });
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la preluarea profilului!" });
    }
});

app.put("/utilizatori/:id", authenticateToken, async (req, res) => {
    const idUtilizator = Number(req.params.id);
    const { nume, email, parolaCurenta, parolaNoua } = req.body || {};

    if (!idUtilizator) return res.status(400).json({ mesaj: "Utilizator invalid!" });
    if (req.user.rol !== "admin" && Number(req.user.idUtilizator) !== idUtilizator) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    const numeCurat = String(nume || "").trim();
    const emailCurat = String(email || "").trim();
    const parolaNouaCurata = String(parolaNoua || "").trim();
    const parolaCurentaCurata = String(parolaCurenta || "").trim();

    if (!numeCurat || !emailCurat) {
        return res.status(400).json({ mesaj: "Nume și email sunt obligatorii." });
    }

    try {
        const rows = await query(
            "SELECT idUtilizator, email, parola FROM UTILIZATORI WHERE idUtilizator = ?",
            [idUtilizator]
        );
        if (!rows.length) return res.status(404).json({ mesaj: "Utilizator inexistent!" });

        if (emailCurat !== rows[0].email) {
            const emailCheck = await query("SELECT idUtilizator FROM UTILIZATORI WHERE email = ?", [emailCurat]);
            if (emailCheck.length) {
                return res.status(400).json({ mesaj: "Email deja existent!" });
            }
        }

        let parolaNouaHash = null;
        if (parolaNouaCurata) {
            if (!parolaCurentaCurata) {
                return res.status(400).json({ mesaj: "Introdu parola curentă pentru a schimba parola." });
            }
            const parolaOk = await bcrypt.compare(parolaCurentaCurata, rows[0].parola);
            if (!parolaOk) {
                return res.status(400).json({ mesaj: "Parola curentă este incorectă." });
            }
            parolaNouaHash = await bcrypt.hash(parolaNouaCurata, 10);
        }

        if (parolaNouaHash) {
            await query(
                "UPDATE UTILIZATORI SET nume = ?, email = ?, parola = ? WHERE idUtilizator = ?",
                [numeCurat, emailCurat, parolaNouaHash, idUtilizator]
            );
        } else {
            await query(
                "UPDATE UTILIZATORI SET nume = ?, email = ? WHERE idUtilizator = ?",
                [numeCurat, emailCurat, idUtilizator]
            );
        }

        const updated = await query(
            `SELECT u.idUtilizator, u.nume, u.email, u.data_inregistrarii, r.denumireRol
             FROM UTILIZATORI u
             JOIN ROLURI r ON u.idRol = r.idRol
             WHERE u.idUtilizator = ?`,
            [idUtilizator]
        );

        res.json({ mesaj: "Profil actualizat!", utilizator: updated[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la actualizarea profilului!" });
    }
});

app.get("/utilizatori/:id/statistici", authenticateToken, async (req, res) => {
    const idUtilizator = Number(req.params.id);
    if (!idUtilizator) return res.status(400).json({ mesaj: "Utilizator invalid!" });

    if (req.user.rol !== "admin" && Number(req.user.idUtilizator) !== idUtilizator) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    try {
        const rolRows = await query(
            "SELECT r.denumireRol FROM UTILIZATORI u JOIN ROLURI r ON u.idRol = r.idRol WHERE u.idUtilizator = ?",
            [idUtilizator]
        );
        if (!rolRows.length) return res.status(404).json({ mesaj: "Utilizator inexistent!" });

        const rol = rolRows[0].denumireRol;

        if (rol === "participant") {
            const totalInscrieriRows = await query(
                "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idUtilizator = ?",
                [idUtilizator]
            );

            const oreRows = await query(
                `SELECT COALESCE(SUM(w.durata), 0) AS oreTotale
                 FROM INSCRIERI i
                 JOIN WORKSHOPS w ON i.idWorkshop = w.idWorkshop
                 WHERE i.idUtilizator = ?`,
                [idUtilizator]
            );

            const categoriiRows = await query(
                `SELECT w.idCategorie, COUNT(*) AS total
                 FROM INSCRIERI i
                 JOIN WORKSHOPS w ON i.idWorkshop = w.idWorkshop
                 WHERE i.idUtilizator = ?
                 GROUP BY w.idCategorie`,
                [idUtilizator]
            );

            return res.json({
                rol,
                totalInscrieri: Number(totalInscrieriRows[0]?.total || 0),
                oreTotale: Number(oreRows[0]?.oreTotale || 0),
                peCategorii: categoriiRows.map((row) => ({
                    idCategorie: Number(row.idCategorie),
                    total: Number(row.total || 0)
                }))
            });
        }

        if (rol === "instructor") {
            const totalParticipantiRows = await query(
                `SELECT COUNT(*) AS total
                 FROM INSCRIERI i
                 JOIN WORKSHOPS w ON i.idWorkshop = w.idWorkshop
                 WHERE w.idInstructor = ?`,
                [idUtilizator]
            );

            const popularRows = await query(
                `SELECT w.idWorkshop, w.titlu, COUNT(i.idInscriere) AS total
                 FROM WORKSHOPS w
                 LEFT JOIN INSCRIERI i ON w.idWorkshop = i.idWorkshop
                 WHERE w.idInstructor = ?
                 GROUP BY w.idWorkshop
                 ORDER BY total DESC
                 LIMIT 1`,
                [idUtilizator]
            );

            const ratingRows = await query(
                `SELECT AVG(r.rating) AS ratingMediu
                 FROM RECENZII r
                 JOIN WORKSHOPS w ON r.idWorkshop = w.idWorkshop
                 WHERE w.idInstructor = ?`,
                [idUtilizator]
            );

            const popular = popularRows[0] || null;
            return res.json({
                rol,
                totalParticipanti: Number(totalParticipantiRows[0]?.total || 0),
                ratingMediu: Number(ratingRows[0]?.ratingMediu || 0),
                cursPopular: popular
                    ? { idWorkshop: popular.idWorkshop, titlu: popular.titlu, total: Number(popular.total || 0) }
                    : null
            });
        }

        if (rol === "admin") {
            const totaluri = await query(`
                SELECT
                    (SELECT COUNT(*) FROM WORKSHOPS) AS totalWorkshops,
                    (SELECT COUNT(*) FROM UTILIZATORI) AS totalUtilizatori,
                    (SELECT COUNT(*) FROM INSCRIERI) AS totalInscrieri,
                    (SELECT COUNT(*) FROM RECENZII) AS totalRecenzii
            `);

            const statusRows = await query(`
                SELECT status, COUNT(*) AS total
                FROM WORKSHOPS
                GROUP BY status
            `);

            const totals = totaluri[0] || {
                totalWorkshops: 0,
                totalUtilizatori: 0,
                totalInscrieri: 0,
                totalRecenzii: 0
            };

            const statusMap = {
                aprobat: 0,
                respins: 0,
                in_asteptare: 0
            };
            statusRows.forEach((row) => {
                statusMap[row.status] = Number(row.total || 0);
            });

            return res.json({
                rol,
                totaluri: {
                    workshopuri: Number(totals.totalWorkshops || 0),
                    utilizatori: Number(totals.totalUtilizatori || 0),
                    inscrieri: Number(totals.totalInscrieri || 0),
                    recenzii: Number(totals.totalRecenzii || 0)
                },
                status: statusMap
            });
        }

        return res.json({ rol, mesaj: "Nu sunt statistici pentru acest rol." });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ mesaj: "Eroare la preluarea statisticilor!" });
    }
});

//inscriere workshop
app.post("/inscrieri", authenticateToken, (req, res) => {
    const { idWorkshop } = req.body;
    const idUtilizator = req.user.idUtilizator;

    const vfSQL = `SELECT * FROM INSCRIERI
                WHERE idWorkshop = ? AND idUtilizator = ?`;

    db.query(vfSQL, [idWorkshop, idUtilizator], (e1, rezultate) => {
        if (e1)
            return res.status(500).json({ mesaj: "Eroare la verificare!" });

        if (rezultate.length > 0)
            return res.json({ mesaj: "Ești deja înscris la acest workshop!" });

         const capacitySQL = `SELECT w.nr_max_participanti, w.data,
                         COUNT(i.idInscriere) AS nr_participanti
                             FROM WORKSHOPS w
                             LEFT JOIN INSCRIERI i ON w.idWorkshop = i.idWorkshop
                             WHERE w.idWorkshop = ?
                     GROUP BY w.nr_max_participanti, w.data`;

        db.query(capacitySQL, [idWorkshop], (eCount, countResult) => {
            if (eCount) {
                console.error("Eroare la numărare înscrieri:", eCount);
                return res.status(500).json({ mesaj: "Eroare la verificare locuri!" });
            }

            if (countResult.length === 0) {
                return res.status(404).json({ mesaj: "Workshop inexistent!" });
            }

            const startDate = new Date(countResult[0].data);
            if (Number.isNaN(startDate.getTime())) {
                return res.status(500).json({ mesaj: "Data workshop-ului este invalidă!" });
            }

            if (new Date() >= startDate) {
                return res.status(400).json({ mesaj: "Înscrierea nu mai este posibilă. Workshop-ul a început sau s-a încheiat." });
            }

            const nrParticipanti = Number(countResult[0].nr_participanti);
            const nrMaxParticipanti = countResult[0].nr_max_participanti;

            if (nrMaxParticipanti !== null && nrParticipanti >= Number(nrMaxParticipanti)) {
                return res.status(400).json({ mesaj: "Nu mai sunt locuri disponibile!" });
            }

                const insertSQL = `INSERT INTO INSCRIERI (idWorkshop, idUtilizator, data_inscrierii, status)
                    VALUES (?, ?, NOW(), ?)`;
                db.query(insertSQL, [idWorkshop, idUtilizator, "inscris"], (e2) => {
                if (e2) {
                    console.error("EROARE SQL:", e2);
                    return res.status(500).json({ mesaj: "Eroare la înscriere!", eroare: e2 });
                }

                res.json({ mesaj: "Înscriere realizată cu succes!" });
            });
        });
    });
});

// lista participanti workshop
app.get("/workshops/:id/participanti", authenticateToken, requireInstructorOrAdmin, async (req, res) => {
    const idWorkshop = Number(req.params.id);
    try {
        if (req.user.rol === "instructor") {
            const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
            if (!ownership.ok) {
                return res.status(ownership.status).json({ mesaj: ownership.mesaj });
            }
        }
        const participanti = await query(
            `SELECT u.idUtilizator, u.nume, u.email, i.prezent_manual
             FROM UTILIZATORI u
             JOIN INSCRIERI i ON u.idUtilizator = i.idUtilizator
             WHERE i.idWorkshop = ?`,
            [idWorkshop]
        );

        if (!participanti.length) {
            return res.json([]);
        }

        const logs = await query(
            `SELECT idUtilizator,
                    SUM(tip = 'download_material') AS has_download,
                    SUM(tip = 'quiz_done') AS has_quiz
             FROM ACTIVITATE_LOG
             WHERE idWorkshop = ?
             GROUP BY idUtilizator`,
            [idWorkshop]
        );
        const logMap = new Map(
            logs.map((row) => [
                Number(row.idUtilizator),
                {
                    hasDownload: Number(row.has_download || 0),
                    hasQuiz: Number(row.has_quiz || 0)
                }
            ])
        );

        const response = participanti.map((p) => {
            const log = logMap.get(Number(p.idUtilizator)) || { hasDownload: 0, hasQuiz: 0 };
            const prezentaAuto = computeAutoPresence(idWorkshop, log.hasDownload > 0, log.hasQuiz > 0);
            const prezentaManual = p.prezent_manual === null ? null : Boolean(p.prezent_manual);
            const prezenta = prezentaManual === null ? prezentaAuto : prezentaManual;
            return {
                idUtilizator: p.idUtilizator,
                nume: p.nume,
                email: p.email,
                prezenta,
                prezentaAuto,
                prezentaManual
            };
        });

        res.json(response);
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la preluarea participanților!" });
    }
});

app.get("/workshops/:id/materiale", authenticateToken, async (req, res) => {
    const idWorkshop = Number(req.params.id);

    if (req.user.rol === "participant") {
        try {
            const rows = await query(
                "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idWorkshop = ? AND idUtilizator = ?",
                [idWorkshop, req.user.idUtilizator]
            );
            const total = Number(rows[0]?.total || 0);
            if (total === 0) {
                return res.status(403).json({ mesaj: "Materialele sunt disponibile doar participanților înscriși." });
            }
        } catch (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la verificarea înscrierii." });
        }
    }

    if (req.user.rol === "instructor") {
        const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
        if (!ownership.ok) {
            return res.status(ownership.status).json({ mesaj: ownership.mesaj });
        }
    }

    const materials = readMaterials()
        .filter((m) => Number(m.idWorkshop) === idWorkshop)
        .filter((m) => fs.existsSync(path.join(uploadsDir, m.fileName)));

    const response = materials.map((m) => ({
        id: m.id,
        idWorkshop: m.idWorkshop,
        nume: m.originalName,
        mimeType: m.mimeType,
        size: m.size,
        uploadedAt: m.uploadedAt,
        uploadedBy: m.uploadedBy
    }));
    if (req.user?.idUtilizator) {
        await logActivity({ idUtilizator: req.user.idUtilizator, idWorkshop, tip: "view_materials" });
    }
    res.json(response);
});

app.post(
    "/workshops/:id/materiale",
    authenticateToken,
    requireInstructorOrAdmin,
    upload.single("fisier"),
    async (req, res) => {
        const idWorkshop = Number(req.params.id);
        if (req.user.rol === "instructor") {
            const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
            if (!ownership.ok) {
                return res.status(ownership.status).json({ mesaj: ownership.mesaj });
            }
        }
        if (!req.file) {
            return res.status(400).json({ mesaj: "Fișier lipsă!" });
        }

        const materials = readMaterials();
        const material = {
            id: `${Date.now()}_${Math.round(Math.random() * 1e9)}`,
            idWorkshop,
            fileName: req.file.filename,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            uploadedAt: new Date().toISOString(),
            uploadedBy: req.user.idUtilizator
        };

        materials.push(material);
        writeMaterials(materials);

        res.json({ mesaj: "Material încărcat cu succes!" });
    }
);

app.get("/materiale/:id/descarca", authenticateToken, async (req, res) => {
    const materialId = req.params.id;
    const materials = readMaterials();
    const material = materials.find((m) => m.id === materialId);

    if (!material) {
        return res.status(404).json({ mesaj: "Material inexistent!" });
    }

    const filePath = path.join(uploadsDir, material.fileName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ mesaj: "Fișier inexistent!" });
    }
    if (req.user.rol === "participant") {
        const rows = await query(
            "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idWorkshop = ? AND idUtilizator = ?",
            [material.idWorkshop, req.user.idUtilizator]
        );
        if (Number(rows[0]?.total || 0) === 0) {
            return res.status(403).json({ mesaj: "Nu ai acces la acest material." });
        }
    }
    if (req.user.rol === "instructor") {
        const ownership = await ensureInstructorOwnsWorkshop(material.idWorkshop, req.user.idUtilizator);
        if (!ownership.ok) {
            return res.status(ownership.status).json({ mesaj: ownership.mesaj });
        }
    }
    if (req.user?.idUtilizator) {
        await logActivity({ idUtilizator: req.user.idUtilizator, idWorkshop: material.idWorkshop, tip: "download_material" });
    }
    res.download(filePath, material.originalName);
});

app.delete("/materiale/:id", authenticateToken, requireInstructorOrAdmin, (req, res) => {
    const materialId = req.params.id;
    const materials = readMaterials();
    const materialIndex = materials.findIndex((m) => m.id === materialId);

    if (materialIndex === -1) {
        return res.status(404).json({ mesaj: "Material inexistent!" });
    }

    const material = materials[materialIndex];
    if (req.user.rol !== "admin" && String(material.uploadedBy) !== String(req.user.idUtilizator)) {
        return res.status(403).json({ mesaj: "Nu poți șterge acest material." });
    }

    const filePath = path.join(uploadsDir, material.fileName);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    materials.splice(materialIndex, 1);
    writeMaterials(materials);

    res.json({ mesaj: "Material șters cu succes!" });
});

app.get("/workshops/:id/quiz", authenticateToken, async (req, res) => {
    const idWorkshop = Number(req.params.id);

    if (req.user.rol === "participant") {
        try {
            const rows = await query(
                "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idWorkshop = ? AND idUtilizator = ?",
                [idWorkshop, req.user.idUtilizator]
            );
            const total = Number(rows[0]?.total || 0);
            if (total === 0) {
                return res.status(403).json({ mesaj: "Quiz-ul este disponibil doar participanților înscriși." });
            }
        } catch (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la verificarea înscrierii." });
        }
    }

    if (req.user.rol === "instructor") {
        const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
        if (!ownership.ok) {
            return res.status(ownership.status).json({ mesaj: ownership.mesaj });
        }
    }

    const quizzes = readQuizzes().filter((q) => Number(q.idWorkshop) === idWorkshop);
    if (!quizzes.length) {
        return res.json({ exists: false });
    }

    const isPrivileged = req.user.rol === "instructor" || req.user.rol === "admin";
    const safeQuizzes = quizzes.map((quiz) => ({
        id: quiz.id,
        idWorkshop: quiz.idWorkshop,
        title: quiz.title,
        minScore: quiz.minScore,
        questions: isPrivileged
            ? (quiz.questions || [])
            : (quiz.questions || []).map((q) => ({
                id: q.id,
                text: q.text,
                options: q.options,
                checkpoint: Boolean(q.checkpoint)
            }))
    }));

    const attempts = readQuizAttempts();
    let progress = null;
    if (req.user?.idUtilizator) {
        const legacyQuizId = quizzes[0]?.id || null;
        const byQuizId = {};
        let scoreSum = 0;
        let scoreCount = 0;
        safeQuizzes.forEach((quiz) => {
            const allowLegacy = legacyQuizId && String(quiz.id) === String(legacyQuizId);
            const item = quizProgressForUser(attempts, idWorkshop, req.user.idUtilizator, quiz.id, allowLegacy);
            byQuizId[quiz.id] = item;
            if (Number.isFinite(item.lastScore)) {
                scoreSum += item.lastScore;
                scoreCount += 1;
            }
        });
        progress = {
            byQuizId,
            averageScore: scoreCount ? Math.round(scoreSum / scoreCount) : null,
            attemptedCount: scoreCount,
            totalQuizzes: safeQuizzes.length
        };
    }

    res.json({
        exists: true,
        quizzes: safeQuizzes,
        progress
    });
});

app.post("/workshops/:id/quiz", authenticateToken, requireInstructorOrAdmin, async (req, res) => {
    const idWorkshop = Number(req.params.id);
    if (req.user.rol === "instructor") {
        const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
        if (!ownership.ok) {
            return res.status(ownership.status).json({ mesaj: ownership.mesaj });
        }
    }
    const title = String(req.body.title || "Quiz materiale").trim();
    const minScore = Math.min(100, Math.max(1, Number(req.body.minScore || 70)));
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    const quizIdRaw = req.body.quizId ? String(req.body.quizId) : "";

    if (!questions.length) {
        return res.status(400).json({ mesaj: "Quiz-ul trebuie să conțină întrebări." });
    }

    const normalized = [];
    let checkpointCount = 0;
    for (const q of questions) {
        const text = String(q.text || "").trim();
        const options = Array.isArray(q.options) ? q.options.map((o) => String(o)) : [];
        const correctIndex = Number(q.correctIndex);
        const checkpoint = Boolean(q.checkpoint);

        if (!text || options.length < 2 || !Number.isFinite(correctIndex)) {
            return res.status(400).json({ mesaj: "Întrebările trebuie să aibă text, opțiuni și index corect." });
        }
        if (correctIndex < 0 || correctIndex >= options.length) {
            return res.status(400).json({ mesaj: "Indexul corect este invalid pentru o întrebare." });
        }
        if (checkpoint) {
            checkpointCount += 1;
            if (checkpointCount > 1) {
                return res.status(400).json({ mesaj: "Poți seta un singur checkpoint." });
            }
        }

        normalized.push({
            id: q.id ? String(q.id) : `q_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
            text,
            options,
            correctIndex,
            explanation: String(q.explanation || "").trim(),
            checkpoint
        });
    }

    const quizzes = readQuizzes();
    const existingIndex = quizIdRaw
        ? quizzes.findIndex((q) => String(q.id) === quizIdRaw && Number(q.idWorkshop) === idWorkshop)
        : -1;
    const quizPayload = {
        id: existingIndex === -1 ? `quiz_${Date.now()}_${Math.round(Math.random() * 1e9)}` : quizzes[existingIndex].id,
        idWorkshop,
        title: title || "Quiz materiale",
        minScore,
        questions: normalized
    };

    if (existingIndex === -1) {
        quizzes.push(quizPayload);
    } else {
        quizzes[existingIndex] = quizPayload;
    }

    writeQuizzes(quizzes);
    res.json({ mesaj: "Quiz salvat cu succes!", quizId: quizPayload.id });
});

app.post(
    "/workshops/:id/quiz/import-docx",
    authenticateToken,
    requireInstructorOrAdmin,
    upload.single("fisier"),
    async (req, res) => {
        const idWorkshop = Number(req.params.id);
        if (req.user.rol === "instructor") {
            const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
            if (!ownership.ok) {
                return res.status(ownership.status).json({ mesaj: ownership.mesaj });
            }
        }

        if (!req.file) {
            return res.status(400).json({ mesaj: "Fișier lipsă!" });
        }

        const filePath = path.join(uploadsDir, req.file.filename);
        const ext = path.extname(req.file.originalname || "").toLowerCase();
        if (ext !== ".docx") {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return res.status(400).json({ mesaj: "Doar fișiere .docx sunt acceptate." });
        }

        try {
            const result = await mammoth.extractRawText({ path: filePath });
            const questions = parseDocxQuestions(result.value || "");
            res.json({ questions });
        } catch (err) {
            console.error("Eroare import DOCX quiz:", err);
            res.status(400).json({ mesaj: err?.message || "Eroare la procesarea fișierului DOCX." });
        } finally {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
    }
);

app.post("/workshops/:id/quiz/submit", authenticateToken, async (req, res) => {
    const idWorkshop = Number(req.params.id);

    if (req.user.rol !== "participant") {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    try {
        const rows = await query(
            "SELECT COUNT(*) AS total FROM INSCRIERI WHERE idWorkshop = ? AND idUtilizator = ?",
            [idWorkshop, req.user.idUtilizator]
        );
        const total = Number(rows[0]?.total || 0);
        if (total === 0) {
            return res.status(403).json({ mesaj: "Quiz-ul este disponibil doar participanților înscriși." });
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ mesaj: "Eroare la verificarea înscrierii." });
    }

    const quizzes = readQuizzes().filter((q) => Number(q.idWorkshop) === idWorkshop);
    if (!quizzes.length) {
        return res.status(404).json({ mesaj: "Quiz inexistent." });
    }

    let quizId = String(req.body.quizId || "");
    let quiz = quizzes.find((q) => String(q.id) === quizId);
    if (!quiz && quizzes.length === 1) {
        quiz = quizzes[0];
        quizId = quiz.id;
    }
    if (!quiz) {
        return res.status(404).json({ mesaj: "Quiz inexistent." });
    }

    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
    const checkpointOnly = Boolean(req.body.checkpointOnly);
    const pool = (quiz.questions || []).filter((q) => (checkpointOnly ? q.checkpoint : !q.checkpoint));

    if (!pool.length) {
        return res.status(400).json({ mesaj: "Nu există întrebări pentru această etapă." });
    }

    const answersMap = new Map(
        answers
            .filter((a) => a && a.questionId !== undefined)
            .map((a) => [String(a.questionId), Number(a.selectedIndex)])
    );
    let missing = false;
    let correctCount = 0;
    const details = pool.map((q) => {
        const selectedIndex = answersMap.has(String(q.id)) ? answersMap.get(String(q.id)) : null;
        if (!Number.isFinite(selectedIndex)) {
            missing = true;
        }
        const correct = Number.isFinite(selectedIndex) && selectedIndex === Number(q.correctIndex);
        if (correct) correctCount += 1;
        return {
            questionId: q.id,
            correct,
            correctIndex: q.correctIndex,
            explanation: q.explanation || ""
        };
    });
    if (missing) {
        return res.status(400).json({ mesaj: "Completează toate întrebările înainte de a trimite." });
    }

    const total = pool.length;
    const score = Math.round((correctCount / total) * 100);
    const passed = checkpointOnly ? correctCount === total : score >= Number(quiz.minScore || 70);

    const attempts = readQuizAttempts();
    let entry = attempts.find(
        (a) => String(a.idWorkshop) === String(idWorkshop) && String(a.idUtilizator) === String(req.user.idUtilizator)
    );
    const attemptType = checkpointOnly ? "checkpoint" : "quiz";
    const previousAttempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
    const legacyQuizId = quizzes[0]?.id || null;
    const allowLegacy = legacyQuizId && String(legacyQuizId) === String(quizId);
    const hasPreviousAttempt = previousAttempts.some((a) =>
        a.type === attemptType
        && (String(a.quizId || "") === String(quizId) || (allowLegacy && !a.quizId))
    );
    if (hasPreviousAttempt) {
        return res.status(400).json({ mesaj: "Ai trimis deja acest quiz." });
    }
    if (!entry) {
        entry = { idWorkshop, idUtilizator: req.user.idUtilizator, attempts: [] };
        attempts.push(entry);
    }

    entry.attempts.push({
        type: checkpointOnly ? "checkpoint" : "quiz",
        quizId,
        score,
        passed,
        answers: pool.map((q) => ({
            questionId: q.id,
            selectedIndex: answersMap.get(String(q.id))
        })),
        createdAt: new Date().toISOString()
    });
    writeQuizAttempts(attempts);

    if (!checkpointOnly) {
        await logActivity({ idUtilizator: req.user.idUtilizator, idWorkshop, tip: "quiz_done" });
    }

    res.json({
        score,
        passed,
        correctCount,
        total,
        details
    });
});

app.get("/workshops/:id/quiz/results", authenticateToken, requireInstructorOrAdmin, async (req, res) => {
    const idWorkshop = Number(req.params.id);
    try {
        const quizzes = readQuizzes().filter((q) => Number(q.idWorkshop) === idWorkshop);
        if (!quizzes.length) {
            return res.json({ results: [] });
        }
        let quizId = String(req.query.quizId || "");
        let quiz = quizzes.find((q) => String(q.id) === quizId);
        if (!quiz && quizzes.length === 1) {
            quiz = quizzes[0];
            quizId = quiz.id;
        }
        if (!quiz) {
            return res.status(400).json({ mesaj: "Selectează un quiz pentru rezultate." });
        }
        const participants = await query(
            `SELECT u.idUtilizator, u.nume, u.email
             FROM UTILIZATORI u
             JOIN INSCRIERI i ON u.idUtilizator = i.idUtilizator
             WHERE i.idWorkshop = ?`,
            [idWorkshop]
        );

        const attempts = readQuizAttempts().filter(
            (a) => String(a.idWorkshop) === String(idWorkshop)
        );

        const legacyQuizId = quizzes[0]?.id || null;
        const allowLegacy = legacyQuizId && String(legacyQuizId) === String(quizId);
        const results = participants.map((p) => {
            const entry = attempts.find((a) => String(a.idUtilizator) === String(p.idUtilizator));
            const list = Array.isArray(entry?.attempts) ? entry.attempts : [];
            const quizAttempts = list.filter((a) =>
                a.type === "quiz"
                && (String(a.quizId || "") === String(quizId) || (allowLegacy && !a.quizId))
            );
            const lastQuiz = quizAttempts.length ? quizAttempts[quizAttempts.length - 1] : null;
            return {
                idUtilizator: p.idUtilizator,
                nume: p.nume,
                email: p.email,
                attempts: quizAttempts.length,
                lastScore: lastQuiz ? lastQuiz.score : null,
                quizPassed: lastQuiz ? lastQuiz.passed : false,
                lastAttemptAt: lastQuiz ? lastQuiz.createdAt : null
            };
        });

        res.json({ results, quizId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la preluarea rezultatelor." });
    }
});

app.get("/inscrierile-mele/:idUtilizator", authenticateToken, async (req, res) => {
    const idUtilizator = req.params.idUtilizator;
    if (req.user.rol !== "admin" && String(req.user.idUtilizator) !== String(idUtilizator)) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    const sql = `SELECT W.idWorkshop, W.titlu, W.descriere, W.data, W.durata, I.status
                FROM WORKSHOPS W
                JOIN INSCRIERI I ON W.idWorkshop = I.idWorkshop
                WHERE I.idUtilizator = ?`;

    try {
        const rezultate = await query(sql, [idUtilizator]);
        const actualizari = [];
        const raspuns = rezultate.map((r) => {
            const statusNou = deriveStatus(r.status, r.data, r.durata);
            if (statusNou !== r.status) {
                actualizari.push(
                    query(
                        "UPDATE INSCRIERI SET status = ? WHERE idUtilizator = ? AND idWorkshop = ?",
                        [statusNou, idUtilizator, r.idWorkshop]
                    )
                );
            }
            return { ...r, status: statusNou };
        });

        if (actualizari.length) {
            await Promise.all(actualizari);
        }

        res.json(raspuns);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ mesaj: "Eroare la preluarea înscrierilor!" });
    }
});

app.post("/anuleaza-inscriere", authenticateToken, (req, res) => {
    const { idWorkshop } = req.body;
    const idUtilizator = req.user.idUtilizator;

    const sql = `DELETE FROM INSCRIERI
                WHERE idUtilizator = ? AND idWorkshop = ?`;

    db.query(sql, [idUtilizator, idWorkshop], (e, rezultat) => {
        if (e) {
            console.error("EROARE SQL anulare:", e);
            return res.status(500).json({ mesaj: "Eroare la anulare!", eroare: e });
        }
        res.json({ mesaj: "Înscriere anulată cu succes!" });
    });
});

//stergere workshop - ADMIN
app.delete("/workshops/:id", authenticateToken, requireAdmin, (req, res) => {
    const id = req.params.id;

    db.beginTransaction((beginErr) => {
        if (beginErr) {
            console.error(beginErr);
            return res.status(500).json({ mesaj: "Eroare la ștergere workshop" });
        }

        db.query("DELETE FROM RECENZII WHERE idWorkshop = ?", [id], (recenziiErr) => {
            if (recenziiErr) {
                return db.rollback(() => {
                    console.error(recenziiErr);
                    res.status(500).json({ mesaj: "Eroare la ștergere workshop" });
                });
            }

            db.query("DELETE FROM INSCRIERI WHERE idWorkshop = ?", [id], (inscrieriErr) => {
                if (inscrieriErr) {
                    return db.rollback(() => {
                        console.error(inscrieriErr);
                        res.status(500).json({ mesaj: "Eroare la ștergere workshop" });
                    });
                }

                db.query("DELETE FROM WORKSHOPS WHERE idWorkshop = ?", [id], (workshopErr) => {
                    if (workshopErr) {
                        return db.rollback(() => {
                            console.error(workshopErr);
                            res.status(500).json({ mesaj: "Eroare la ștergere workshop" });
                        });
                    }

                    db.commit((commitErr) => {
                        if (commitErr) {
                            return db.rollback(() => {
                                console.error(commitErr);
                                res.status(500).json({ mesaj: "Eroare la ștergere workshop" });
                            });
                        }

                        res.json({ mesaj: "Workshop șters cu succes!" });
                    });
                });
            });
        });
    });
});

app.post("/workshops", authenticateToken, requireInstructorOrAdmin, (req, res) => {
    const { titlu, descriere, obiective, durata, data, nr_max_participanti, idCategorie, idNivel, idInstructor, status } = req.body;

    const statusFinal = status || "in_asteptare";

    const sql = `INSERT INTO WORKSHOPS (titlu, descriere, obiective, durata, data, nr_max_participanti, idCategorie, idNivel, idInstructor, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [titlu, descriere || '', obiective || '', durata || 0, data, nr_max_participanti, idCategorie, idNivel, idInstructor, statusFinal],
        (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ mesaj: "Eroare la adăugare workshop" });
            }
            res.json({ mesaj: "Workshop adăugat cu succes" });
        });
});

app.patch("/workshops/:id/status", authenticateToken, requireAdmin, (req, res) => {
    const idWorkshop = req.params.id;
    const { status } = req.body;

    const validStatus = ["in_asteptare", "aprobat", "respins"];
    if (!validStatus.includes(status)) {
        return res.status(400).json({ mesaj: "Status invalid" });
    }

    const sql = `UPDATE WORKSHOPS SET status = ? WHERE idWorkshop = ?`;
    db.query(sql, [status, idWorkshop], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la actualizarea statusului" });
        }
        res.json({ mesaj: "Status actualizat" });
    });
});

app.put("/workshops/:id", authenticateToken, requireInstructorOrAdmin, (req, res) => {
    const idWorkshop = req.params.id;
    const { titlu, descriere, obiective, durata, data, nr_max_participanti, idCategorie, idNivel } = req.body;

    const sql = `UPDATE WORKSHOPS
                SET titlu = ?, descriere = ?, obiective = ?, durata = ?, data = ?, nr_max_participanti = ?, idCategorie = ?, idNivel = ?
                WHERE idWorkshop = ?`;

    db.query(sql, [titlu, descriere || '', obiective || '', durata || 0, data, nr_max_participanti, idCategorie, idNivel, idWorkshop], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la actualizarea workshop-ului" });
        }
        res.json({ mesaj: "Workshop actualizat cu succes" });
    });
});

app.get("/certificat/:idWorkshop/:idUtilizator", authenticateToken, async (req, res) => {
    const { idWorkshop, idUtilizator } = req.params;

    if (req.user.rol !== "admin" && String(req.user.idUtilizator) !== String(idUtilizator)) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    const sql = `SELECT u.nume, w.titlu, w.data, w.durata, i.status, i.prezent_manual, instr.nume AS instructor
                FROM UTILIZATORI u
                JOIN INSCRIERI i ON u.idUtilizator = i.idUtilizator
                JOIN WORKSHOPS w ON i.idWorkshop = w.idWorkshop
                LEFT JOIN UTILIZATORI instr ON w.idInstructor = instr.idUtilizator
                WHERE u.idUtilizator = ? AND w.idWorkshop = ?`;

    try {
        const rezultate = await query(sql, [idUtilizator, idWorkshop]);
        if (!rezultate.length) {
            return res.status(404).json({ mesaj: "Inscriere inexistenta!" });
        }

        const detalii = rezultate[0];
        const statusNou = deriveStatus(detalii.status, detalii.data, detalii.durata);
        if (statusNou !== detalii.status) {
            await query(
                "UPDATE INSCRIERI SET status = ? WHERE idUtilizator = ? AND idWorkshop = ?",
                [statusNou, idUtilizator, idWorkshop]
            );
            detalii.status = statusNou;
        }

        if (detalii.status !== "finalizat") {
            return res.status(403).json({ mesaj: "Certificatul este disponibil dupa finalizarea workshop-ului." });
        }

        const { nume, titlu, data, durata, instructor, prezent_manual } = detalii;
        const fonts = {
            sans: path.join(__dirname, "public", "fonts", "NotoSans-Regular.ttf"),
            sansBold: path.join(__dirname, "public", "fonts", "NotoSans-Bold.ttf"),
            serif: path.join(__dirname, "public", "fonts", "NotoSerif-Regular.ttf"),
            serifBold: path.join(__dirname, "public", "fonts", "NotoSerif-Bold.ttf")
        };
        const doc = new PDFDocument({
            size: "A4",
            layout: "landscape",
            margins: { top: 60, bottom: 50, left: 60, right: 60 }
        });

        let quizAverageScore = null;
        try {
            const attempts = readQuizAttempts();
            const entry = attempts.find(
                (a) => String(a.idWorkshop) === String(idWorkshop) && String(a.idUtilizator) === String(idUtilizator)
            );
            const quizAttempts = Array.isArray(entry?.attempts)
                ? entry.attempts.filter((a) => a.type === "quiz")
                : [];
            if (quizAttempts.length) {
                const lastByQuiz = new Map();
                quizAttempts.forEach((attempt) => {
                    const key = attempt.quizId ? String(attempt.quizId) : "legacy";
                    lastByQuiz.set(key, attempt);
                });
                let sum = 0;
                let count = 0;
                lastByQuiz.forEach((attempt) => {
                    const parsedScore = Number(attempt?.score);
                    if (Number.isFinite(parsedScore)) {
                        sum += parsedScore;
                        count += 1;
                    }
                });
                quizAverageScore = count ? Math.round(sum / count) : null;
            }
        } catch (err) {
            quizAverageScore = null;
        }

        let prezentaAuto = false;
        try {
            const rows = await query(
                "SELECT SUM(tip = 'download_material') AS has_download, SUM(tip = 'quiz_done') AS has_quiz FROM ACTIVITATE_LOG WHERE idUtilizator = ? AND idWorkshop = ?",
                [idUtilizator, idWorkshop]
            );
            const hasDownload = Number(rows[0]?.has_download || 0) > 0;
            const hasQuiz = Number(rows[0]?.has_quiz || 0) > 0;
            prezentaAuto = computeAutoPresence(idWorkshop, hasDownload, hasQuiz);
        } catch (err) {
            prezentaAuto = false;
        }
        const prezentaManual = prezent_manual === null ? null : Boolean(prezent_manual);
        const prezenta = prezentaManual === null ? prezentaAuto : prezentaManual;

        if (!prezenta) {
            return res.status(403).json({ mesaj: "Certificatul este disponibil doar pentru participantii prezenti." });
        }

        res.setHeader("Content-Type", "application/pdf");
        const safeBase = `certificat_${String(nume || "").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "participant"}_${String(titlu || "").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "workshop"}`
            .replace(/\s+/g, "_")
            .slice(0, 80);
        const fallbackName = `${safeBase || "certificat"}.pdf`;
        const utf8Name = encodeURIComponent(`certificat_${nume || ""}_${titlu || ""}.pdf`);
        res.setHeader("Content-Disposition", `attachment; filename=\"${fallbackName}\"; filename*=UTF-8''${utf8Name}`);
        doc.pipe(res);

        doc.registerFont("NotoSans", fonts.sans);
        doc.registerFont("NotoSans-Bold", fonts.sansBold);
        doc.registerFont("NotoSerif", fonts.serif);
        doc.registerFont("NotoSerif-Bold", fonts.serifBold);

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const frameMargin = 36;
        const certificateId = `WH-${idWorkshop}-${idUtilizator}-${new Date(data).getFullYear()}`;

        const calificativ = !prezenta
            ? "Neprezentat"
            : quizAverageScore === null
                ? "Participare"
                : quizAverageScore >= 90
                    ? "Excelent"
                    : quizAverageScore >= 80
                        ? "Foarte bine"
                        : quizAverageScore >= 70
                            ? "Bine"
                            : "Satisfăcător";
        const quizSuffix = quizAverageScore === null ? "" : ` (Quiz: ${Math.round(quizAverageScore)}%)`;

        doc.save();
        doc.rect(frameMargin, frameMargin, pageWidth - frameMargin * 2, pageHeight - frameMargin * 2)
            .lineWidth(2)
            .strokeColor("#1f4fff")
            .stroke();
        doc.rect(frameMargin + 6, frameMargin + 6, pageWidth - (frameMargin + 6) * 2, 18)
            .fillColor("#e8efff")
            .fill();
        doc.restore();

        doc.save();
        doc.fillOpacity(0.08);
        doc.font("NotoSerif-Bold").fontSize(72).fillColor("#1f4fff")
            .text("Workshop Hub", frameMargin + 20, pageHeight / 2 - 60, {
                width: pageWidth - frameMargin * 2 - 40,
                align: "center"
            });
        doc.restore();

        const contentLeft = doc.page.margins.left;
        const contentRight = pageWidth - doc.page.margins.right;
        const contentWidth = contentRight - contentLeft;
        const yTitle = frameMargin + 70;
        const ySub = yTitle + 32;
        const yId = ySub + 20;
        const yCertify = yId + 30;
        const yName = yCertify + 30;
        const yBody = yName + 32;
        const yDetails = yBody + 28;
        const yGrade = yDetails + 18;
        const yDivider = yGrade + 32;
        const ySignature = yDivider + 28;

        doc.fillColor("#1f2937").font("NotoSerif-Bold").fontSize(28)
            .text("CERTIFICAT DE PARTICIPARE", contentLeft, yTitle, { width: contentWidth, align: "center" });
        doc.font("NotoSans").fontSize(12).fillColor("#6b7280")
            .text("Workshop Hub", contentLeft, ySub, { width: contentWidth, align: "center" });
        doc.font("NotoSans").fontSize(11).fillColor("#9ca3af")
            .text(`ID certificat: ${certificateId}`, contentLeft, yId, { width: contentWidth, align: "center" });

        doc.fillColor("#111827").font("NotoSans").fontSize(16)
            .text("Se certifică faptul că", contentLeft, yCertify, { width: contentWidth, align: "center" });
        doc.font("NotoSerif-Bold").fontSize(24)
            .text(nume, contentLeft, yName, { width: contentWidth, align: "center" });
        doc.font("NotoSans").fontSize(14)
            .text(
                `a participat la workshop-ul "${titlu}" desfășurat în data de ${new Date(data).toLocaleDateString("ro-RO")}.`,
                contentLeft,
                yBody,
                { width: contentWidth, align: "center" }
            );

        const durataText = Number.isFinite(Number(durata)) && Number(durata) > 0
            ? `${durata} ore`
            : "-";
        doc.font("NotoSans").fontSize(12).fillColor("#6b7280")
            .text(`Instructor: ${instructor || "-"} · Durată: ${durataText}`, contentLeft, yDetails, {
                width: contentWidth,
                align: "center"
            });
        doc.font("NotoSans").fontSize(12).fillColor("#6b7280")
            .text(`Calificativ: ${calificativ}${quizSuffix}`, contentLeft, yGrade, {
                width: contentWidth,
                align: "center"
            });

        doc.strokeColor("#d1d5db").lineWidth(1)
            .moveTo(contentLeft, yDivider)
            .lineTo(contentRight, yDivider)
            .stroke();

        doc.strokeColor("#9ca3af").lineWidth(1)
            .moveTo(contentRight - 180, ySignature)
            .lineTo(contentRight, ySignature)
            .stroke();
        doc.fillColor("#6b7280").font("NotoSans").fontSize(12)
            .text("Semnătura instructorului", contentRight - 180, ySignature + 6, {
                width: 180,
                align: "center"
            });

        doc.fillColor("#9ca3af").font("NotoSans").fontSize(10)
            .text(`Emis la ${new Date().toLocaleDateString("ro-RO")}`, contentLeft, pageHeight - 50, {
                align: "left"
            });

        doc.end();
    } catch (e) {
        console.error(e);
        return res.status(500).json({ mesaj: "Nu se poate genera certificatul!" });
    }
})

// vizualizare recenzii pentru un workshop
app.get("/recenzii/:idWorkshop", (req, res) => {
    const { idWorkshop } = req.params;

    const sql = `
        SELECT r.idRecenzie, r.rating, r.comentariu, r.data_recenzie,
               u.nume
        FROM RECENZII r
        JOIN UTILIZATORI u ON r.idUtilizator = u.idUtilizator
        WHERE r.idWorkshop = ?
        ORDER BY r.data_recenzie DESC
    `;

    db.query(sql, [idWorkshop], (err, rezultate) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ mesaj: "Eroare la preluarea recenziilor!" });
        }

        res.json(rezultate);
    });
});

app.get("/admin/statistici", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const totaluri = await query(`
            SELECT
                (SELECT COUNT(*) FROM WORKSHOPS) AS totalWorkshops,
                (SELECT COUNT(*) FROM UTILIZATORI) AS totalUtilizatori,
                (SELECT COUNT(*) FROM INSCRIERI) AS totalInscrieri,
                (SELECT COUNT(*) FROM RECENZII) AS totalRecenzii
        `);

        const statusRows = await query(`
            SELECT status, COUNT(*) AS total
            FROM WORKSHOPS
            GROUP BY status
        `);

        const workshopRecent = await query(`
            SELECT idWorkshop, titlu, data, status
            FROM WORKSHOPS
            ORDER BY data DESC
            LIMIT 5
        `);

        const utilizatoriRecents = await query(`
            SELECT idUtilizator, nume, email, data_inregistrarii
            FROM UTILIZATORI
            ORDER BY data_inregistrarii DESC
            LIMIT 5
        `);

        const popularRows = await query(`
            SELECT w.idWorkshop, w.titlu, COUNT(i.idInscriere) AS total
            FROM WORKSHOPS w
            LEFT JOIN INSCRIERI i ON w.idWorkshop = i.idWorkshop
            GROUP BY w.idWorkshop
            ORDER BY total DESC, w.data DESC
            LIMIT 1
        `);

        const unpopularRows = await query(`
            SELECT w.idWorkshop, w.titlu, COUNT(i.idInscriere) AS total
            FROM WORKSHOPS w
            LEFT JOIN INSCRIERI i ON w.idWorkshop = i.idWorkshop
            GROUP BY w.idWorkshop
            ORDER BY total ASC, w.data ASC
            LIMIT 1
        `);

        const statusMap = {
            aprobat: 0,
            respins: 0,
            in_asteptare: 0
        };
        statusRows.forEach((row) => {
            statusMap[row.status] = Number(row.total || 0);
        });

        const totals = totaluri[0] || {
            totalWorkshops: 0,
            totalUtilizatori: 0,
            totalInscrieri: 0,
            totalRecenzii: 0
        };

        const popular = popularRows[0] || null;
        const unpopular = unpopularRows[0] || null;

        res.json({
            totaluri: {
                workshopuri: Number(totals.totalWorkshops || 0),
                utilizatori: Number(totals.totalUtilizatori || 0),
                inscrieri: Number(totals.totalInscrieri || 0),
                recenzii: Number(totals.totalRecenzii || 0)
            },
            status: statusMap,
            workshopPopular: popular
                ? { idWorkshop: popular.idWorkshop, titlu: popular.titlu, total: Number(popular.total || 0) }
                : null,
            workshopNepopular: unpopular
                ? { idWorkshop: unpopular.idWorkshop, titlu: unpopular.titlu, total: Number(unpopular.total || 0) }
                : null,
            ultimeleWorkshopuri: workshopRecent,
            ultimiiUtilizatori: utilizatoriRecents
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la preluarea statisticilor!" });
    }
});

app.get("/admin/raport", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const stats = await query(`
            SELECT
                (SELECT COUNT(*) FROM WORKSHOPS) AS totalWorkshops,
                (SELECT COUNT(*) FROM UTILIZATORI) AS totalUtilizatori,
                (SELECT COUNT(*) FROM INSCRIERI) AS totalInscrieri,
                (SELECT COUNT(*) FROM RECENZII) AS totalRecenzii
        `);

        const statusRows = await query(`
            SELECT status, COUNT(*) AS total
            FROM WORKSHOPS
            GROUP BY status
        `);

        const popularRows = await query(`
            SELECT w.idWorkshop, w.titlu, COUNT(i.idInscriere) AS total
            FROM WORKSHOPS w
            LEFT JOIN INSCRIERI i ON w.idWorkshop = i.idWorkshop
            GROUP BY w.idWorkshop
            ORDER BY total DESC, w.data DESC
            LIMIT 1
        `);

        const unpopularRows = await query(`
            SELECT w.idWorkshop, w.titlu, COUNT(i.idInscriere) AS total
            FROM WORKSHOPS w
            LEFT JOIN INSCRIERI i ON w.idWorkshop = i.idWorkshop
            GROUP BY w.idWorkshop
            ORDER BY total ASC, w.data ASC
            LIMIT 1
        `);

        const totals = stats[0] || {
            totalWorkshops: 0,
            totalUtilizatori: 0,
            totalInscrieri: 0,
            totalRecenzii: 0
        };

        const statusMap = {
            aprobat: 0,
            respins: 0,
            in_asteptare: 0
        };
        statusRows.forEach((row) => {
            statusMap[row.status] = Number(row.total || 0);
        });

        const popular = popularRows[0] || null;
        const unpopular = unpopularRows[0] || null;

        const fonts = {
            sans: path.join(__dirname, "public", "fonts", "NotoSans-Regular.ttf"),
            sansBold: path.join(__dirname, "public", "fonts", "NotoSans-Bold.ttf"),
            serif: path.join(__dirname, "public", "fonts", "NotoSerif-Regular.ttf"),
            serifBold: path.join(__dirname, "public", "fonts", "NotoSerif-Bold.ttf")
        };
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 60, bottom: 60, left: 60, right: 60 }
        });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "attachment; filename=raport_admin.pdf");
        doc.pipe(res);

        doc.registerFont("NotoSans", fonts.sans);
        doc.registerFont("NotoSans-Bold", fonts.sansBold);
        doc.registerFont("NotoSerif", fonts.serif);
        doc.registerFont("NotoSerif-Bold", fonts.serifBold);

        const pageWidth = doc.page.width;
        const marginLeft = doc.page.margins.left;
        const marginRight = doc.page.margins.right;
        const contentWidth = pageWidth - marginLeft - marginRight;

        doc.font("NotoSerif-Bold").fontSize(22).fillColor("#111827").text("Raport administrativ", {
            align: "left"
        });
        doc.moveDown(0.3);
        doc.font("NotoSans").fontSize(11).fillColor("#6b7280").text(`Workshop Hub · Generat la: ${new Date().toLocaleString("ro-RO")}`);
        doc.moveDown(1.2);

        doc.strokeColor("#e5e7eb").lineWidth(1)
            .moveTo(marginLeft, doc.y)
            .lineTo(pageWidth - marginRight, doc.y)
            .stroke();
        doc.moveDown(1.1);

        doc.font("NotoSans-Bold").fontSize(14).fillColor("#111827").text("Indicatori principali");
        doc.moveDown(0.6);

        const cardWidth = (contentWidth - 16) / 2;
        const cardHeight = 64;
        const cardY = doc.y;

        const drawStatCard = (x, y, label, value, accent) => {
            doc.save();
            doc.roundedRect(x, y, cardWidth, cardHeight, 10).fillColor("#f9fafb").fill();
            doc.roundedRect(x, y, cardWidth, cardHeight, 10).lineWidth(1).strokeColor("#e5e7eb").stroke();
            doc.fillColor(accent).rect(x, y, 6, cardHeight).fill();
            doc.fillColor("#6b7280").font("NotoSans").fontSize(10).text(label, x + 16, y + 12);
            doc.fillColor("#111827").font("NotoSans-Bold").fontSize(20).text(String(value), x + 16, y + 30);
            doc.restore();
        };

        drawStatCard(marginLeft, cardY, "Workshop-uri totale", totals.totalWorkshops, "#1f4fff");
        drawStatCard(marginLeft + cardWidth + 16, cardY, "Utilizatori totali", totals.totalUtilizatori, "#00c2a8");
        drawStatCard(marginLeft, cardY + cardHeight + 12, "Înscrieri totale", totals.totalInscrieri, "#f59e0b");
        drawStatCard(marginLeft + cardWidth + 16, cardY + cardHeight + 12, "Recenzii totale", totals.totalRecenzii, "#ef4444");

        doc.y = cardY + cardHeight * 2 + 24;

        doc.x = marginLeft;
        doc.font("NotoSans-Bold").fontSize(14).fillColor("#111827").text("Status workshop-uri");
        doc.moveDown(0.6);

        const pill = (label, value, color) => {
            const text = `${label}: ${value}`;
            const paddingX = 10;
            const paddingY = 6;
            const textWidth = doc.widthOfString(text);
            const pillWidth = textWidth + paddingX * 2;
            const pillHeight = 22;
            const x = doc.x;
            const y = doc.y;
            doc.roundedRect(x, y, pillWidth, pillHeight, 11).fillColor(color).fill();
            doc.fillColor("#ffffff").font("NotoSans-Bold").fontSize(10).text(text, x + paddingX, y + 6);
            doc.x = x + pillWidth + 8;
        };

        doc.x = marginLeft;
        pill("Aprobate", statusMap.aprobat, "#22c55e");
        pill("În așteptare", statusMap.in_asteptare, "#f59e0b");
        pill("Respinse", statusMap.respins, "#ef4444");

        doc.moveDown(1.6);
        doc.x = marginLeft;
        doc.font("NotoSans-Bold").fontSize(14).fillColor("#111827").text("Popularitate workshop-uri");
        doc.moveDown(0.5);

        const popularLabel = popular
            ? `${popular.titlu || "Fără titlu"} · ${Number(popular.total || 0)} înscrieri`
            : "Nicio informație disponibilă.";
        const unpopularLabel = unpopular
            ? `${unpopular.titlu || "Fără titlu"} · ${Number(unpopular.total || 0)} înscrieri`
            : "Nicio informație disponibilă.";

        const highlightCardWidth = (contentWidth - 16) / 2;
        const highlightCardHeight = 68;
        const highlightY = doc.y;

        const drawHighlightCard = (x, y, title, value, accent) => {
            doc.save();
            doc.roundedRect(x, y, highlightCardWidth, highlightCardHeight, 10).fillColor("#ffffff").fill();
            doc.roundedRect(x, y, highlightCardWidth, highlightCardHeight, 10).lineWidth(1).strokeColor("#e5e7eb").stroke();
            doc.fillColor(accent).rect(x, y, 6, highlightCardHeight).fill();
            doc.fillColor("#6b7280").font("NotoSans").fontSize(10).text(title, x + 14, y + 10, {
                width: highlightCardWidth - 28
            });
            doc.fillColor("#111827").font("NotoSans-Bold").fontSize(11).text(value, x + 14, y + 26, {
                width: highlightCardWidth - 28
            });
            doc.restore();
        };

        drawHighlightCard(marginLeft, highlightY, "Cel mai popular", popularLabel, "#22c55e");
        drawHighlightCard(marginLeft + highlightCardWidth + 16, highlightY, "Cel mai nepopular", unpopularLabel, "#f59e0b");
        doc.y = highlightY + highlightCardHeight + 16;

        doc.moveDown(2.2);
        doc.strokeColor("#e5e7eb").lineWidth(1)
            .moveTo(marginLeft, doc.y)
            .lineTo(pageWidth - marginRight, doc.y)
            .stroke();
        doc.moveDown(0.8);
        doc.font("NotoSans").fontSize(10).fillColor("#6b7280")
            .text("Acest raport conține date administrative de performanță.");
        doc.end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la generarea raportului!" });
    }
});

app.use((err, req, res, next) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ mesaj: "Fișier prea mare. Limita este 50 MB." });
        }
    }

    if (err.message === "Format de fișier neacceptat.") {
        return res.status(400).json({ mesaj: err.message });
    }

    console.error(err);
    res.status(500).json({ mesaj: "Eroare la încărcarea fișierului!" });
});

app.listen(3000, () => {
    console.log("Server pornit pe http://localhost:3000");
});

app.get("/inscrieri/:idUtilizator/:idWorkshop", authenticateToken, async (req, res) => {
    const { idUtilizator: paramUserId, idWorkshop } = req.params;
    const idUtilizator = req.user.rol === "admin" ? paramUserId : req.user.idUtilizator;

    if (req.user.rol !== "admin" && String(paramUserId) !== String(req.user.idUtilizator)) {
        return res.status(403).json({ mesaj: "Acces interzis!" });
    }

    const sql = `SELECT i.status, i.data_inscrierii, i.prezent_manual, w.titlu, w.descriere, w.data,
                       w.obiective, w.durata, u.nume AS numeInstructor
                FROM INSCRIERI i
                JOIN WORKSHOPS w ON i.idWorkshop = w.idWorkshop
                LEFT JOIN UTILIZATORI u ON w.idInstructor = u.idUtilizator
                WHERE i.idUtilizator = ? AND i.idWorkshop = ?`;

    try {
        const rezultate = await query(sql, [idUtilizator, idWorkshop]);
        if (!rezultate.length) {
            return res.status(404).json({ mesaj: "Inscriere inexistenta!" });
        }

        const detalii = rezultate[0];
        const statusNou = deriveStatus(detalii.status, detalii.data, detalii.durata);
        if (statusNou !== detalii.status) {
            await query(
                "UPDATE INSCRIERI SET status = ? WHERE idUtilizator = ? AND idWorkshop = ?",
                [statusNou, idUtilizator, idWorkshop]
            );
            detalii.status = statusNou;
        }

        let prezentaAuto = false;
        try {
            const rows = await query(
                "SELECT SUM(tip = 'download_material') AS has_download, SUM(tip = 'quiz_done') AS has_quiz FROM ACTIVITATE_LOG WHERE idUtilizator = ? AND idWorkshop = ?",
                [idUtilizator, idWorkshop]
            );
            const hasDownload = Number(rows[0]?.has_download || 0) > 0;
            const hasQuiz = Number(rows[0]?.has_quiz || 0) > 0;
            prezentaAuto = computeAutoPresence(idWorkshop, hasDownload, hasQuiz);
        } catch (err) {
            prezentaAuto = false;
        }
        const prezentaManual = detalii.prezent_manual === null ? null : Boolean(detalii.prezent_manual);
        const prezenta = prezentaManual === null ? prezentaAuto : prezentaManual;
        detalii.prezentaAuto = prezentaAuto;
        detalii.prezentaManual = prezentaManual;
        detalii.prezenta = prezenta;

        await logActivity({ idUtilizator, idWorkshop, tip: "view_activity" });
        res.json(detalii);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ mesaj: "Eroare la preluarea inscrierii!" });
    }
});

app.patch("/workshops/:id/participanti/:idUtilizator/prezenta", authenticateToken, requireInstructorOrAdmin, async (req, res) => {
    const idWorkshop = Number(req.params.id);
    const idUtilizator = Number(req.params.idUtilizator);
    const { prezent } = req.body || {};

    if (!idWorkshop || !idUtilizator) {
        return res.status(400).json({ mesaj: "Date invalide." });
    }

    if (req.user.rol === "instructor") {
        const ownership = await ensureInstructorOwnsWorkshop(idWorkshop, req.user.idUtilizator);
        if (!ownership.ok) {
            return res.status(ownership.status).json({ mesaj: ownership.mesaj });
        }
    }

    let value = null;
    if (prezent === true || prezent === false) {
        value = prezent ? 1 : 0;
    }

    try {
        await query(
            "UPDATE INSCRIERI SET prezent_manual = ? WHERE idWorkshop = ? AND idUtilizator = ?",
            [value, idWorkshop, idUtilizator]
        );
        res.json({ mesaj: "Prezență actualizată." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ mesaj: "Eroare la actualizarea prezenței." });
    }
});