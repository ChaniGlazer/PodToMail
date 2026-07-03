const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Parser = require('rss-parser');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// טעינת משתני סביבה כלליים מהמערכת של Render
const RSS_URL = process.env.RSS_URL;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const DOWNLOAD_COUNT = parseInt(process.env.DOWNLOAD_COUNT, 10) || 10;

// מפתחות הגישה של ה-OAuth ל-Google Drive
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// משתני הסביבה של ה-SMTP שלך מהתמונה
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;

// המייל שאליו תרצה לקבל את ההתראה (אם זה אותו מייל של ה-FROM, נשתמש ב-SMTP_FROM כברירת מחדל)
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || SMTP_FROM;

// בדיקה שכל המשתנים הבסיסיים הוגדרו ב-Render
if (!RSS_URL || !DRIVE_FOLDER_ID || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    console.error("שגיאה: אחד או יותר ממשתני הסביבה (Google Drive או SMTP) חסרים!");
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
        const response = await drive.files.list({
            q: `name = '${fileName.replace(/'/g, "\\'")}' and '${DRIVE_FOLDER_ID}' in parents and trashed = false`,
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
        return response.data.id;
    } catch (error) {
        console.error(`שגיאה בהעלאת הקובץ ${fileName}:`, error.message);
        return null;
    }
}

// פונקציה לשליחת מייל עדכון באמצעות ה-SMTP שלך
async function sendEmailNotification(uploadedFiles, podcastName) {
    try {
        // הגדרת הטרנספורט באמצעות שרת ה-SMTP הקיים שלך
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465, // true עבור פורט 465, false עבור פורטים אחרים כמו 587
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS
            }
        });

        // בניית תוכן ה-HTML של המייל
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
                    <p style="font-size: 12px; color: #9aa0a6; text-align: center; margin-bottom: 0;">הודעה זו נשלחה באופן אוטומטי משרת ה-Cron Job שלך ב-Render.</p>
                </div>
            `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('מייל עדכון נשלח בהצלחה באמצעות SMTP:', info.messageId);
    } catch (error) {
        console.error('שגיאה בשליחת המייל דרך SMTP:', error.message);
    }
}

async function main() {
    try {
        console.log('קורא את ה-RSS...');
        console.log(`מנסה לגשת לכתובת: "${RSS_URL}"`);
        const feed = await parser.parseURL(RSS_URL);
       

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
            const exists = await isFileInDrive(fileName);
            if (exists) {
                console.log(`הקובץ "${fileName}" כבר קיים בדרייב. מדלג עליו.`);
                continue;
            }

            const localPath = path.join(__dirname, fileName);

            console.log(`[${i + 1}/${items.length}] מוריד: ${fileName}...`);
            await downloadFile(fileUrl, localPath);

            console.log(`[${i + 1}/${items.length}] מעלה ל-Drive...`);
            const driveFileId = await uploadToDrive(fileName, localPath);

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

        // שליחת מייל רק אם אכן הועלו קבצים חדשים
        if (uploadedFilesList.length > 0) {
            console.log(`מכין שליחת מייל עדכון ל-SMTP עבור ${uploadedFilesList.length} קבצים חדשים...`);
            await sendEmailNotification(uploadedFilesList, podcastName);
        } else {
            console.log('לא הועלו קבצים חדשים בריצה זו, אין צורך בשליחת מייל.');
        }

        console.log('כל התהליך הסתיים בהצלחה!');
    } catch (error) {
        console.error('שגיאה כללית בתהליך:', error.message);
    }
}

main();
