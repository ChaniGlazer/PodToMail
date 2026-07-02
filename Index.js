const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Parser = require('rss-parser');
const { google } = require('googleapis');

// הגדרות - שנה בהתאם לצורך
const RSS_URL = 'YOUR_RSS_FEED_URL_HERE'; // קישור ה-RSS שלך
const DRIVE_FOLDER_ID = 'YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE'; // ה-ID של התיקייה בדרייב
const KEY_FILE_PATH = path.join(__dirname, 'credentials.json'); // קובץ המפתחות מ-Google

const parser = new Parser();

// התחברות ל-Google Drive API
const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// פונקציה להורדת קובץ זמני מקומי
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
        const feed = await parser.parseURL(RSS_URL);
        
        // לקיחת 10 הפריטים האחרונים בלבד
        const items = feed.items.slice(0, 10);
        console.log(`נמצאו ${items.length} פריטים לעיבוד.`);

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            // מציאת קישור הקובץ (לרוב נמצא בתוך enclosure או link)
            const fileUrl = item.enclosure ? item.enclosure.url : item.link;
            if (!fileUrl) {
                console.log(`לא נמצא קובץ להורדה עבור: ${item.title}`);
                continue;
            }

            // יצירת שם קובץ תקין (סיומת מותאמת או ברירת מחדל)
            const fileExtension = path.extname(new URL(fileUrl).pathname) || '.mp3'; // שנה ל-.pdf או סיומת רלוונטית אם צריך
            const cleanTitle = item.title.replace(/[^a-zA-Z0-9א-ת\s-_]/g, ''); // ניקוי תווים אסורים בשמות קבצים
            const fileName = `${cleanTitle}${fileExtension}`;
            const localPath = path.join(__dirname, fileName);

            console.log(`[${i + 1}/10] מוריד: ${fileName}...`);
            await downloadFile(fileUrl, localPath);

            console.log(`[${i + 1}/10] מעלה ל-Drive...`);
            await uploadToDrive(fileName, localPath);

            // מחיקת הקובץ המקומי כדי שלא יתפוס מקום בשרת
            fs.unlinkSync(localPath);
        }
        console.log('התהליך הסתיים בהצלחה!');
    } catch (error) {
        console.error('שגיאה כללית בתהליך:', error);
    }
}

main();
