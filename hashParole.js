const mysql = require("mysql2");
const bcrypt = require("bcrypt");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "W8M77!zZky",
    database: "workshop_db"
});

db.connect((e) => {
    if (e) {
        console.error("Eroare conectare DB:", e);
        return;
    } else
        console.log("Conectat la MySQL!");
});

async function hashParole() {
    db.query("SELECT idUtilizator, parola FROM utilizatori", async (e, rezultate) => {
        if(e) {
            console.error(e);
            return;
        }

        for(let user of rezultate) {
            //vf daca parola e deja hash (incepe cu $2b$)
            if(user.parola.startsWith("$2b$")) {
                continue;
            }

            const hash = await bcrypt.hash(user.parola,10);

            db.query(
                "UPDATE utilizatori SET parola = ? WHERE idUtilizator =?",
                [hash, user.idUtilizator],
                (e) => {
                    if(e)
                        console.error(e);
                }
            );
        }
        console.log("Toate parolele au fost hash-uite.");
        process.exit();
    });
}

hashParole();