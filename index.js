const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Parser = require('rss-parser');
const { google } = require('googleapis');

// טעינת משתני סביבה מהמערכת של Render
const RSS_URL = process.env.RSS_URL;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// כמות קבצים להורדה - לוקח מהמשתנה סביבה, אם לא קיים לוקח ברירת מחדל 10
const DOWNLOAD_COUNT = parseInt(process.env.DOWNLOAD_COUNT, 10) || 10;

// Mפתחות הגישה של ה-OAuth שיצרת בגוגל קלאוד
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// בדיקה שכל המשתנים הבסיסיים הוגדרו ב-Render
if (!RSS_URL || !DRIVE_FOLDER_ID || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error("שגיאה: אחד או יותר ממשתני הסביבה (RSS_URL, DRIVE_FOLDER_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) חסרים!");
    process.exit(1);
}

const parser = new Parser();

// התחברות ל-Google Drive באמצעות OAuth2
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// פונקציה לבדיקה האם קובץ כבר קיים בתיקייה הספציפית ב-Google Drive
async function isFileInDrive(fileName) {
    try {
        // שאילתה שמחפשת קובץ לפי שם, מוודאת שהוא לא בסל המחזור ונמצא בתיקייה המבוקשת
        const response = await drive.files.list({
            q: `name = '${fileName.replace(/'/g, "\\'")}' and '${DRIVE_FOLDER_ID}' in parents and trashed = false`,
            fields: 'files(id, name)',
            pageSize: 1
        });
        return response.data.files.length > 0;
    } catch (error) {
        console.error(`שגיאה בבדיקת קיום הקובץ ${fileName} בדרייב:`, error.message);
        return false; // במקרה שגיאה נניח שלא קיים כדי לא לפספס הורדה
    }
}

// פונקציה להורדת קובץ זמני מקומי לשרת של רנדר
async function downloadFile(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// פונקציה להעלאת קובץ ל-Google Drive
async function uploadToDrive(fileName, filePath) {
    try {
        const fileMetadata = {
            name: fileName,
            parents: [DRIVE_FOLDER_ID]
        };
        const media = {
            body: fs.createReadStream(filePath)
        };
        const response = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id'
        });
        console.log(`הקובץ ${fileName} הועלה בהצלחה. ID: ${response.data.id}`);
    } catch (error) {
        console.error(`שגיאה בהעלאת הקובץ ${fileName}:`, error.message);
    }
}

async function main() {
    try {
        console.log('קורא את ה-RSS...');
        console.log(`מנסה לגשת לכתובת: "${RSS_URL}"`); // שורה חדשה לבדיקה
        const feed = await parser.parseURL(RSS_URL);
        
        
        // לקיחת כמות הפריטים שהוגדרה במשתנה הסביבה
        const items = feed.items.slice(0, DOWNLOAD_COUNT);
        console.log(`נקבעו ${items.length} פריטים מקסימליים לעיבוד (לפי הגדרת DOWNLOAD_COUNT).`);

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            // מציאת קישור הקובץ (מתוך enclosure או link)
            const fileUrl = item.enclosure ? item.enclosure.url : item.link;
            if (!fileUrl) {
                console.log(`לא נמצא קובץ להורדה עבור: ${item.title}`);
                continue;
            }

            // חילוץ סיומת הקובץ המקורית (למשל .mp3, .pdf) מתוך ה-URL
            let fileExtension = '.mp3'; // ברירת מחדל
            try {
                const parsedUrl = new URL(fileUrl);
                const ext = path.extname(parsedUrl.pathname);
                if (ext) fileExtension = ext;
            } catch (e) {
                // שגיאה בפענוח ה-URL, נשארים עם ברירת המחדל
            }

            // ניקוי שם הקובץ מתווים מיוחדים שאסורים במערכות קבצים
            const cleanTitle = item.title.replace(/[^a-zA-Z0-9א-ת\s-_]/g, '');
            const fileName = `${cleanTitle}${fileExtension}`;

            // ---- בדיקה האם הקובץ כבר קיים בדרייב ----
            console.log(`[${i + 1}/${items.length}] בודק האם ${fileName} כבר קיים ב-Google Drive...`);
            const exists = await isFileInDrive(fileName);
            if (exists) {
                console.log(`הקובץ "${fileName}" כבר קיים בדרייב. מדלג עליו.`);
                continue; // עובר לפריט הבא בלולאה מבלי להוריד או להעלות
            }
            // ----------------------------------------

            const localPath = path.join(__dirname, fileName);

            console.log(`[${i + 1}/${items.length}] מוריד: ${fileName}...`);
            await downloadFile(fileUrl, localPath);

            console.log(`[${i + 1}/${items.length}] מעלה ל-Drive...`);
            await uploadToDrive(fileName, localPath);

            // מחיקת הקובץ המקומי מיד לאחר ההעלאה כדי לשמור על שרת נקי
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
        }
        console.log('כל הקבצים עובדו בהצלחה!');
    } catch (error) {
        console.error('שגיאה כללית בתהליך:', error.message);
    }
}

main();
