# Workshop Hub

Workshop Hub este o platforma web care centralizeaza tot fluxul unui workshop: promovare, inscriere, materiale, evaluare si certificare. Frontend-ul static se afla in folderul `public`, 
iar backend-ul este un server Express care foloseste MySQL pentru persistenta datelor.

## Ce face aplicatia
- Suporta diferite roluri de utilizator: participant, instructor, administrator.
- Participantii pot cauta si se pot inscrie la activitati, pot descarca materiale de studiu, pot sustine quiz-uri si pot primi certificate de finalizare a activitatilor.
- Instructorii pot crea/edita workshop-uri, incarca materiale si configura quiz-uri.
- Administratorii aproba sau resping propunerile de workshop, vizualizeaza statistici si genereaza rapoarte PDF.

Datele persista partial in fisiere JSON locale pentru istoricul materialelor si quiz-urilor: `materials.json`, `quizzes.json`, `quiz_attempts.json`. Fisierele incarcate sunt stocate in `uploads/`.

## Getting Started
1. Se cloneaza repository-ul si se deschide local.
2. Se instaleaza dependentele:

```bash
npm install
```

3. Se configureaza variabilele de mediu (sectiunea urmatoare) sau editeaza valorile din `server.js` pentru dezvoltare.
4. Se creaza baza de date MySQL.
5. Se ruleaza serverul:

```bash
npm start
# sau pentru dezvoltare cu nodemon (global/local):
npx nodemon server.js
```

Aplicatia va fi disponibila implicit la http://localhost:3000.

## Variabile de mediu recomandate
Se poate crea un fisier `.env` in radacina proiectului cu o serie variabile de mediu, un exemplu fiind:

```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=parola
DB_NAME=workshop_db
SECRET_KEY=se_va_schimba_dupa_caz
MAX_UPLOAD_SIZE=52428800
```

`SECRET_KEY` nu va fi hardcodata in productie!

## Scripturi utile
- Este util in `package.json` un script `start` daca nu exista deja:

```json
"scripts": {
	"start": "node server.js",
	"dev": "nodemon server.js"
}
```

## `hashParole.js`
Scriptul `hashParole.js` se foloseste o singura data pentru a transforma parolele din baza de date în hash-uri bcrypt. Exemplu:

```bash
node hashParole.js
```

Rulare: variabilele DB trebuiesc configurate inainte de a rula scriptul.

## Endpoint-uri API (exemple)
Documentatia completa se afla in `server.js`, dar cateva endpoint-uri cheie ale aplicatiei sunt:

- POST `/api/auth/login` pentru autentificare
- POST `/api/auth/register` pentru inregistrare
- GET `/api/workshops` pentru listare workshop-uri aprobate
- POST `/api/workshops` pentru creare workshop (autentificat instructor)
- POST `/api/materials/upload` pentru upload materiale
- GET `/api/quizzes/:id` pentru a se obtine quiz-uri

## Uploads si limite
- Fisierele incarcate in aplicatie sunt stocate in `uploads/`.
- Limita de upload implicita este de 50 MB (configurata prin Multer). Daca un fisier depaseste limita, serverul respinge fisierul (avand setarea `MAX_UPLOAD_SIZE`).

## Securitate si productie
- A nu se lasa `SECRET_KEY` hardcodata in `server.js`. Se vor folosi in schimb variabile de mediu.
- In productie, se va activa HTTPS si se vor valida fisierele incarcate.
- Se vor restrictiona dimensiunea si tipurile MIME acceptate de Multer.

## Backup si restaurare
- Fisierele JSON ar trebui sa fie salvate periodic (`materials.json`, `quizzes.json`, `quiz_attempts.json`) si folderul `uploads/`.


---

Pentru detalii de implementare, se va consulta fisierul `server.js`, iar, pentru interfata, folderul `public`.