const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Parser = require('rss-parser');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// טעינת משתני סביבה כלליים מהמערכת של Render
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID; // תיקיית ברירת מחדל (אפשר לדרוס לכל פודקאסט)
const DOWNLOAD_COUNT = parseInt(process.env.DOWNLOAD_COUNT, 10) || 10;

// מפתחות הגישה של ה-OAuth ל-Google Drive
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// משתני הסביבה של ה-SMTP שלך
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;

// המייל שאליו תרצה לקבל את ההתראה
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || SMTP_FROM;

/**
 * הגדרת מקורות הפודקאסטים.
 *
 * PODCAST_SOURCES - מחרוזת JSON (מערך) ב-Render, לדוגמה:
 * [
 *   { "source": "https://podcasts.apple.com/il/podcast/xxx/id1234567890" },
 *   { "source": "https://open.spotify.com/show/1a2B3c4D5e6F7g8H9i0J" },
 *   { "source": "https://example.com/feed.xml", "driveFolderId": "אופציונלי - תיקייה שונה" }
 * ]
 *
 * כל "source" יכול להיות:
 *  - קישור ישיר לפיד RSS (xml)
 *  - קישור לעמוד פודקאסט ב-Apple Podcasts (יפוענח אוטומטית ל-RSS דרך iTunes API)
 *  - קישור ל-Show ב-Spotify (ינוחש הפיד המתאים דרך חיפוש ב-iTunes לפי שם התוכנית - ראה אזהרה בהמשך)
 *
 * לצורך תאימות לאחור: אם PODCAST_SOURCES לא מוגדר, ננסה להשתמש במשתנה הישן RSS_URL.
 */
function loadPodcastSources() {
    const raw = process.env.PODCAST_SOURCES;
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((entry) => ({
                    source: typeof entry === 'string' ? entry : entry.source,
                    driveFolderId: (typeof entry === 'object' && entry.driveFolderId) || DRIVE_FOLDER_ID
                }));
            }
        } catch (e) {
            console.error('שגיאה בפענוח PODCAST_SOURCES כ-JSON תקין:', e.message);
        }
    }

    // תאימות לאחור - משתנה בודד ישן
    if (process.env.RSS_URL) {
        return [{ source: process.env.RSS_URL, driveFolderId: DRIVE_FOLDER_ID }];
    }

    return [];
}

const PODCAST_SOURCES = loadPodcastSources();

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    console.error("שגיאה: אחד או יותר ממשתני הסביבה (Google Drive או SMTP) חסרים!");
    process.exit(1);
}

if (PODCAST_SOURCES.length === 0) {
    console.error("שגיאה: לא הוגדר אף מקור פודקאסט. יש להגדיר PODCAST_SOURCES (JSON) או RSS_URL.");
    process.exit(1);
}

const parser = new Parser();

// התחברות ל-Google Drive באמצעות OAuth2
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ---------------- פענוח אוטומטי של קישורי Apple Podcasts / Spotify ל-RSS ----------------

/**
 * מחלץ RSS feed URL מתוך קישור ל-Apple Podcasts, באמצעות iTunes Lookup API הציבורי.
 */
async function resolveAppleRssUrl(url) {
    const match = url.match(/id(\d+)/);
    if (!match) {
        throw new Error(`לא ניתן לחלץ מזהה פודקאסט (id) מהקישור: ${url}`);
    }
    const podcastId = match[1];
    console.log(`מזהה קישור Apple Podcasts (id=${podcastId}), שולף כתובת RSS מ-iTunes API...`);

    const { data } = await axios.get('https://itunes.apple.com/lookup', {
        params: { id: podcastId, entity: 'podcast' }
    });

    if (!data.results || data.results.length === 0 || !data.results[0].feedUrl) {
        throw new Error(`iTunes API לא החזיר כתובת RSS עבור id=${podcastId}`);
    }

    console.log(`נמצאה כתובת RSS עבור "${data.results[0].collectionName}": ${data.results[0].feedUrl}`);
    return data.results[0].feedUrl;
}

/**
 * מנסה לחלץ RSS feed URL מתוך קישור ל-Spotify Show.
 *
 * חשוב: ל-Spotify אין API ציבורי שחושף את כתובת ה-RSS המקורית של תוכנית.
 * הפתרון כאן הוא היוריסטי בלבד: שולפים את שם התוכנית מ-Spotify (דרך oEmbed הפומבי),
 * ואז מחפשים תוכנית באותו שם ב-iTunes/Apple Podcasts כדי למצוא את פיד ה-RSS שלה.
 * זה עובד טוב עבור תוכניות שמופצות גם ב-Apple Podcasts, אבל לא יעבוד עבור
 * תוכניות בלעדיות ל-Spotify (Spotify Originals/Exclusives) שאין להן RSS ציבורי כלל.
 * מומלץ לוודא ידנית שהתוצאה שנבחרה היא באמת התוכנית הנכונה.
 */
async function resolveSpotifyRssUrl(url) {
    console.log(`מזהה קישור Spotify Show, שולף שם תוכנית דרך oEmbed...`);

    const { data: oembed } = await axios.get('https://open.spotify.com/oembed', {
        params: { url }
    });

    const showTitle = oembed.title;
    if (!showTitle) {
        throw new Error(`לא ניתן לשלוף את שם התוכנית מ-Spotify עבור: ${url}`);
    }

    console.log(`שם התוכנית לפי Spotify: "${showTitle}". מחפש התאמה ב-iTunes...`);

    const { data: searchResults } = await axios.get('https://itunes.apple.com/search', {
        params: { term: showTitle, entity: 'podcast', limit: 5 }
    });

    if (!searchResults.results || searchResults.results.length === 0) {
        throw new Error(`לא נמצאה תוכנית מתאימה ב-iTunes עבור השם "${showTitle}". ייתכן שזו תוכנית בלעדית ל-Spotify ללא RSS ציבורי.`);
    }

    // ניסיון למצוא התאמה מדויקת יותר בשם, אחרת ניקח את התוצאה הראשונה
    const normalizedTitle = showTitle.trim().toLowerCase();
    const exactMatch = searchResults.results.find(
        (r) => r.collectionName && r.collectionName.trim().toLowerCase() === normalizedTitle
    );
    const bestMatch = exactMatch || searchResults.results[0];

    if (!bestMatch.feedUrl) {
        throw new Error(`נמצאה תוכנית "${bestMatch.collectionName}" ב-iTunes אך ללא כתובת RSS זמינה.`);
    }

    if (!exactMatch) {
        console.warn(`⚠️  לא נמצאה התאמה מדויקת לשם "${showTitle}". נבחרה התוצאה הקרובה ביותר: "${bestMatch.collectionName}". מומלץ לוודא ידנית שזו התוכנית הנכונה!`);
    }

    console.log(`נמצאה כתובת RSS עבור "${bestMatch.collectionName}": ${bestMatch.feedUrl}`);
    return bestMatch.feedUrl;
}

/**
 * נקודת הכניסה לפענוח - מזהה את סוג הקישור ומחזיר כתובת RSS בת-שימוש.
 */
async function resolveRssUrl(source) {
    if (/podcasts\.apple\.com/i.test(source)) {
        return resolveAppleRssUrl(source);
    }
    if (/open\.spotify\.com\/show\//i.test(source)) {
        return resolveSpotifyRssUrl(source);
    }
    // לא זוהה כ-Apple/Spotify - מניחים שזהו קישור RSS ישיר
    return source;
}

// ---------------- לוגיקת ה-Drive וה-RSS המקורית ----------------

// פונקציה לבדיקה האם קובץ כבר קיים בתיקייה הספציפית ב-Google Drive
async function isFileInDrive(fileName, folderId) {
    try {
        const response = await drive.files.list({
            q: `name = '${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`,
            fields: 'files(id, name)',
            pageSize: 1
        });
        return response.data.files.length > 0;
    } catch (error) {
        console.error(`שגיאה בבדיקת קיום הקובץ ${fileName} בדרייב:`, error.message);
        return false;
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
async function uploadToDrive(fileName, filePath, folderId) {
    try {
        const fileMetadata = {
            name: fileName,
            parents: [folderId]
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
        return response.data.id;
    } catch (error) {
        console.error(`שגיאה בהעלאת הקובץ ${fileName}:`, error.message);
        return null;
    }
}

// פונקציה לשליחת מייל עדכון באמצעות ה-SMTP שלך
async function sendEmailNotification(uploadedFiles, podcastName) {
    try {
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS
            }
        });

        let filesHtml = '';
        for (const file of uploadedFiles) {
            filesHtml += `
                <li style="margin-bottom: 10px;">
                    <strong>${file.name}</strong><br>
                    <a href="${file.driveUrl}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: bold;">צפייה/הורדה מ-Google Drive</a> | 
                    <a href="${file.originalUrl}" target="_blank" style="color: #5f6368; text-decoration: none; font-size: 12px;">קישור מקור מקורי</a>
                </li>
            `;
        }

        const mailOptions = {
            from: SMTP_FROM,
            to: NOTIFICATION_EMAIL,
            subject: `🚨 פרקים חדשים הועלו לדרייב: ${podcastName}`,
            html: `
                <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                    <h2 style="color: #1a73e8; border-bottom: 2px solid #1a73e8; padding-bottom: 10px; margin-top: 0;">עדכון אוטומטי - שרת פודקאסטים</h2>
                    <p style="font-size: 16px;">השרת סיים לרוץ כעת וזיהה פרקים חדשים בפיד של <strong>${podcastName}</strong>.</p>
                    <p style="font-size: 14px; font-weight: bold; color: #202124;">להלן הקבצים החדשים שהועלו בהצלחה לתיקיית הדרייב שלך:</p>
                    <ul style="padding-right: 20px; color: #3c4043;">
                        ${filesHtml}
                    </ul>
                    <hr style="border: 0; border-top: 1px solid #e0e0e0; margin: 20px 0;">
                    <p style="font-size: 12px; color: #9aa0a6; text-align: center; margin-bottom: 0;">הודעה זו נשלחה באופן אוטומטי משרת ה-Web Service שלך ב-Render.</p>
                </div>
            `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('מייל עדכון נשלח בהצלחה באמצעות SMTP:', info.messageId);
    } catch (error) {
        console.error('שגיאה בשליחת המייל דרך SMTP:', error.message);
    }
}

// לוגיקת עיבוד פודקאסט בודד (RSS + העלאה)
async function processSinglePodcast(podcastConfig) {
    const { source, driveFolderId } = podcastConfig;

    if (!driveFolderId) {
        console.error(`שגיאה: לא הוגדרה תיקיית Drive (DRIVE_FOLDER_ID) עבור המקור: ${source}`);
        return;
    }

    let rssUrl;
    try {
        rssUrl = await resolveRssUrl(source);
    } catch (error) {
        console.error(`שגיאה בפענוח כתובת RSS מהמקור "${source}":`, error.message);
        return;
    }

    try {
        console.log(`קורא את ה-RSS מהכתובת: "${rssUrl}"`);
        const feed = await parser.parseURL(rssUrl);

        const podcastName = feed.title || 'פודקאסט';
        const items = feed.items.slice(0, DOWNLOAD_COUNT);
        console.log(`נמצאו ${items.length} פריטים מקסימליים לעיבוד עבור הפודקאסט "${podcastName}".`);

        const uploadedFilesList = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            const fileUrl = item.enclosure ? item.enclosure.url : item.link;
            if (!fileUrl) {
                console.log(`לא נמצא קובץ להורדה עבור: ${item.title}`);
                continue;
            }

            let fileExtension = '.mp3';
            try {
                const parsedUrl = new URL(fileUrl);
                const ext = path.extname(parsedUrl.pathname);
                if (ext) fileExtension = ext;
            } catch (e) {}

            const cleanTitle = item.title.replace(/[^a-zA-Z0-9א-ת\s-_]/g, '');
            const fileName = `${cleanTitle}${fileExtension}`;

            console.log(`[${i + 1}/${items.length}] בודק האם ${fileName} כבר קיים ב-Google Drive...`);
            const exists = await isFileInDrive(fileName, driveFolderId);
            if (exists) {
                console.log(`הקובץ "${fileName}" כבר קיים בדרייב. מדלג עליו.`);
                continue;
            }

            const localPath = path.join(__dirname, fileName);

            console.log(`[${i + 1}/${items.length}] מוריד: ${fileName}...`);
            await downloadFile(fileUrl, localPath);

            console.log(`[${i + 1}/${items.length}] מעלה ל-Drive...`);
            const driveFileId = await uploadToDrive(fileName, localPath, driveFolderId);

            if (driveFileId) {
                uploadedFilesList.push({
                    name: fileName,
                    originalUrl: fileUrl,
                    driveUrl: `https://drive.google.com/open?id=${driveFileId}`
                });
            }

            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
        }

        if (uploadedFilesList.length > 0) {
            console.log(`מכין שליחת מייל עדכון ל-SMTP עבור ${uploadedFilesList.length} קבצים חדשים...`);
            await sendEmailNotification(uploadedFilesList, podcastName);
        } else {
            console.log(`לא הועלו קבצים חדשים עבור "${podcastName}" בריצה זו, אין צורך בשליחת מייל.`);
        }
    } catch (error) {
        console.error(`שגיאה כללית בעיבוד המקור "${source}":`, error.message);
    }
}

// לוגיקת עיבוד כלל הפודקאסטים המוגדרים
async function runRssToDriveProcess() {
    console.log('--- תחילת תהליך סנכרון אוטומטי ---');
    console.log(`מספר מקורות פודקאסט מוגדרים: ${PODCAST_SOURCES.length}`);

    for (const podcastConfig of PODCAST_SOURCES) {
        await processSinglePodcast(podcastConfig);
    }

    console.log('--- תהליך הסנכרון האוטומטי הסתיים בהצלחה! ---');
}

// ---------------- הגדרות שרת Express ----------------

// עמוד הבית (נשאר לטובת ה-Port החינמי של Render)
app.get('/', (req, res) => {
    res.send(`שרת ה-RSS ל-Google Drive פועל. מוגדרים ${PODCAST_SOURCES.length} מקורות. התהליך מופעל אוטומטית בכל עלייה של השרת.`);
});

// נקודת קצה ידנית (ליתר ביטחון, אם תרצה להפעיל גם ידנית)
app.get('/run', async (req, res) => {
    res.write('הפעלת ידנית את התהליך ברקע...\n');
    res.end();
    await runRssToDriveProcess();
});

// הפעלת האזנה לפורט + הפעלה אוטומטית מיידית של הסנכרון
app.listen(PORT, async () => {
    console.log(`שרת האינטרנט פעיל ומקשיב בפורט ${PORT}`);

    // שורה זו מפעילה את התהליך אוטומטית מיד כשהשרת עולה / נבנה מחדש!
    await runRssToDriveProcess();
});
