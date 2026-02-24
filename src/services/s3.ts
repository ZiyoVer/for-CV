import { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { dbService } from './db';
import { parseBuffer } from 'music-metadata';
import { speechService } from './speech';

const s3 = new S3Client({
    region: config.WASABI_REGION,
    endpoint: config.WASABI_ENDPOINT,
    credentials: {
        accessKeyId: config.WASABI_ACCESS_KEY,
        secretAccessKey: config.WASABI_SECRET_KEY
    },
    forcePathStyle: true // Recommended for Wasabi/MinIO to avoid virtual-host style issues
});

export const s3Service = {
    // Minimum date for syncing files - only sync files modified on or after this date
    // This prevents old/already-checked files from being re-synced
    SYNC_START_DATE: new Date('2026-02-09T00:00:00Z'),

    // Populate DB with files from S3 ("stt/" folder) - only adds new files from SYNC_START_DATE onwards
    async syncFiles() {
        console.log(`Starting S3 Sync for 'stt/' folder (from ${this.SYNC_START_DATE.toISOString()})...`);
        const startDate = this.SYNC_START_DATE;
        let continuationToken: string | undefined;
        let count = 0;
        let skipped = 0;
        let tooOld = 0;

        do {
            const command = new ListObjectsV2Command({
                Bucket: config.WASABI_BUCKET,
                Prefix: 'stt/', // Only look in 'stt/' folder
                ContinuationToken: continuationToken
            });

            const response = await s3.send(command);
            const files = response.Contents || [];

            // Process in batches of 10 for better performance
            const BATCH_SIZE = 10;
            const wavFiles = files.filter(file =>
                file.Key &&
                file.Key.endsWith('.wav') &&
                !file.Key.startsWith('saralangan/')
            );

            for (let i = 0; i < wavFiles.length; i += BATCH_SIZE) {
                const batch = wavFiles.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (file) => {
                    if (!file.Key) return;

                    // Detailed logging for debugging
                    console.log(`Processing file: ${file.Key} (LastModified: ${file.LastModified?.toISOString()})`);

                    // Filter by date: only sync files from SYNC_START_DATE onwards
                    if (file.LastModified && file.LastModified < startDate) {
                        tooOld++;
                        // console.log(`Skipping old file: ${file.Key}`);
                        return; // Skip old files
                    }

                    // Check if file already exists in DB (any status: PENDING, ACCEPTED, REJECTED)
                    const existingFile = await dbService.checkFileExists(file.Key);
                    if (existingFile) {
                        skipped++;
                        console.log(`Skipping existing file: ${file.Key}`);
                        return; // Skip if already in DB
                    }

                    // Try to get duration from JSON first
                    let duration = 0;
                    try {
                        const json = await this.getJsonContent(file.Key);
                        if (json && json.duration) {
                            duration = Math.round(json.duration / 1000); // ms to sec
                        }
                    } catch (e) {
                        console.warn(`Failed to get duration for ${file.Key}`, e);
                    }

                    console.log(`Adding new file to DB: ${file.Key}, Duration: ${duration}s`);
                    await dbService.addFile(file.Key, duration);
                    count++;
                }));
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);
        console.log(`Synced ${count} new files. Skipped: ${skipped} existing, ${tooOld} too old.`);
    },

    async getJsonContent(audioKey: string): Promise<any> {
        const jsonKey = audioKey.replace('.wav', '.json');
        try {
            const command = new GetObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: jsonKey
            });
            const response = await s3.send(command);
            const str = await response.Body?.transformToString();
            return str ? JSON.parse(str) : {};
        } catch (error: any) {
            // Check for NoSuchKey error (standard AWS/minio error code)
            if (error.Code === 'NoSuchKey' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                // Suppress full error stack for missing JSON, it's expected sometimes
                console.warn(`JSON file missing for ${audioKey} (Key: ${jsonKey}) - proceeding without metadata.`);
                return {};
            }
            console.error(`Error fetching JSON for ${audioKey}:`, error);
            // Return empty object on error to prevent crash
            return {};
        }
    },

    async getAudioUrl(audioKey: string): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: config.WASABI_BUCKET,
            Key: audioKey
        });
        return getSignedUrl(s3, command, { expiresIn: 3600 });
    },

    async getFileBuffer(key: string): Promise<Uint8Array | undefined> {
        try {
            const command = new GetObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: key
            });
            const response = await s3.send(command);
            return await response.Body?.transformToByteArray();
        } catch (e) {
            console.error("Error downloading file buffer:", e);
            return undefined;
        }
    },

    // Copy to sorted folder with year/month/day structure
    // deleteOriginal: if true, delete the original file after successful copy
    async copyToSorted(key: string, transcribedText?: string, deleteOriginal: boolean = true) {
        // key is something like "stt/file.wav"
        // We want to copy it to "saralangan/2025/02/09/file.wav"

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        // Extract filename from key
        const fileName = key.split('/').pop() || key;

        // Build destination path: saralangan/2025/02/09/file.wav
        const destinationKey = `saralangan/${year}/${month}/${day}/${fileName}`;

        console.log(`Copying ${key} to ${destinationKey}`);

        // Copy audio file
        await s3.send(new CopyObjectCommand({
            Bucket: config.WASABI_BUCKET,
            CopySource: `${config.WASABI_BUCKET}/${key}`,
            Key: destinationKey
        }));

        // Also copy JSON with updated text if provided
        const jsonKey = key.replace('.wav', '.json');
        const jsonDest = destinationKey.replace('.wav', '.json');

        try {
            if (transcribedText) {
                // If text was edited, update JSON before copying
                const existingJson = await this.getJsonContent(key);
                existingJson.text = transcribedText;
                existingJson.transcribed_at = now.toISOString();

                // Save updated JSON to destination
                await s3.send(new PutObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: jsonDest,
                    Body: JSON.stringify(existingJson, null, 2),
                    ContentType: 'application/json'
                }));
            } else {
                // Just copy the JSON as-is
                await s3.send(new CopyObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    CopySource: `${config.WASABI_BUCKET}/${jsonKey}`,
                    Key: jsonDest
                }));
            }
        } catch (e) {
            console.warn(`Could not copy/update JSON for ${key}`, e);
        }

        // Update DB to track the copy
        const originalFileName = fileName.replace('.wav', '');
        await dbService.updateFileCopyInfo(key, destinationKey, transcribedText);

        // Delete original files from S3 to prevent re-syncing
        if (deleteOriginal) {
            try {
                // Delete original audio
                await s3.send(new DeleteObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: key
                }));
                // Delete original JSON
                await s3.send(new DeleteObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: jsonKey
                }));
                console.log(`Deleted original files: ${key}, ${jsonKey}`);
            } catch (e) {
                console.warn(`Could not delete original files for ${key}`, e);
            }
        }

        return destinationKey;
    },

    // Update text in JSON file
    async updateJsonText(audioKey: string, newText: string): Promise<boolean> {
        const jsonKey = audioKey.replace('.wav', '.json');
        try {
            // First, get the existing JSON
            const command = new GetObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: jsonKey
            });
            const response = await s3.send(command);
            const str = await response.Body?.transformToString();
            const json = str ? JSON.parse(str) : {};

            // Update the text field
            json.text = newText;
            json.edited_at = new Date().toISOString();

            // Save back to S3
            const putCommand = new PutObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: jsonKey,
                Body: JSON.stringify(json, null, 2),
                ContentType: 'application/json'
            });
            await s3.send(putCommand);

            console.log(`Updated JSON text for ${jsonKey}`);
            return true;
        } catch (error) {
            console.error(`Error updating JSON for ${audioKey}:`, error);
            return false;
        }
    },

    // --- TRANSCRIPTION FUNCTIONS ---

    // Sync transcription files from S3 'transkripsiya/' folder
    async syncTranscriptionFiles() {
        console.log("Starting S3 Sync for 'transkripsiya/' folder...");
        let continuationToken: string | undefined;
        let count = 0;
        let skipped = 0;

        do {
            const command = new ListObjectsV2Command({
                Bucket: config.WASABI_BUCKET,
                Prefix: 'transkripsiya/',
                ContinuationToken: continuationToken
            });

            const response = await s3.send(command);
            const files = response.Contents || [];

            // Process in batches of 10 for better performance
            const BATCH_SIZE = 10;
            const wavFiles = files.filter(file =>
                file.Key &&
                file.Key.endsWith('.wav') &&
                !file.Key.includes('saralangan/')
            );

            for (let i = 0; i < wavFiles.length; i += BATCH_SIZE) {
                const batch = wavFiles.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (file) => {
                    if (!file.Key) return;

                    // Check if file already exists in DB (prevent duplicates)
                    const existingFile = await dbService.checkTranscriptionFileExists(file.Key);
                    if (existingFile) {
                        skipped++;
                        return; // Skip if already in DB
                    }

                    await dbService.addTranscriptionFile(file.Key);
                    count++;
                }));
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);
        console.log(`Synced ${count} new transcription files. Skipped ${skipped} existing files.`);
    },

    // Get transcription audio buffer (audio only, no text)
    async getTranscriptionAudioBuffer(key: string): Promise<Uint8Array | undefined> {
        try {
            const command = new GetObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: key
            });
            const response = await s3.send(command);
            return await response.Body?.transformToByteArray();
        } catch (e) {
            console.error("Error downloading transcription file buffer:", e);
            return undefined;
        }
    },

    // Copy transcription to sorted folder with user's transcribed text and metadata
    async copyTranscriptionToSorted(key: string, transcribedText: string, duration?: number, gender?: string, deleteOriginal: boolean = true) {
        console.log(`[TRANSCRIBE] START copyTranscriptionToSorted: ${key}`);

        // key is like "transkripsiya/file.wav"
        // Destination: "saralangan/transkripsiya/2025/02/09/file.wav"

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        const fileName = key.split('/').pop() || 'unknown';
        console.log(`[TRANSCRIBE] filename: ${fileName}`);

        let destinationKey = '';
        if (key.startsWith('transkripsiya/')) {
            destinationKey = key.replace('transkripsiya/', `saralangan/transkripsiya/${year}/${month}/${day}/`);
        } else {
            destinationKey = `saralangan/transkripsiya/${year}/${month}/${day}/${key}`;
        }

        console.log(`[TRANSCRIBE] destination: ${destinationKey}`);

        // Copy audio file
        console.log(`[TRANSCRIBE] Copying audio...`);
        await s3.send(new CopyObjectCommand({
            Bucket: config.WASABI_BUCKET,
            CopySource: `${config.WASABI_BUCKET}/${key}`,
            Key: destinationKey
        }));
        console.log(`[TRANSCRIBE] Audio copied`);

        // Create JSON with transcribed text and metadata
        const jsonDest = destinationKey.replace('.wav', '.json');

        // JSON format as requested by user
        const jsonContent: any = {
            audio: fileName.replace('.wav', ''),  // audio name/id without extension
            text: transcribedText,                 // transcription text
            ms: duration || 0,                     // duration in milliseconds
            jinsi: gender === 'male' ? 'erkak' : 'ayol'  // gender in Uzbek
        };

        console.log(`[TRANSCRIBE] Saving JSON to: ${jsonDest}`);
        console.log(`[TRANSCRIBE] JSON content:`, JSON.stringify(jsonContent));
        
        try {
            await s3.send(new PutObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: jsonDest,
                Body: JSON.stringify(jsonContent, null, 2),
                ContentType: 'application/json'
            }));
            console.log(`[TRANSCRIBE] JSON saved successfully`);
        } catch (jsonErr: any) {
            console.error(`[TRANSCRIBE] ERROR saving JSON:`, jsonErr.message);
            throw jsonErr;
        }

        // Delete original file from S3 to prevent re-syncing
        if (deleteOriginal) {
            try {
                await s3.send(new DeleteObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: key
                }));
                console.log(`[TRANSCRIBE] Deleted original: ${key}`);
            } catch (e) {
                console.warn(`[TRANSCRIBE] Could not delete original: ${key}`, e);
            }
        }
        
        console.log(`[TRANSCRIBE] DONE - all complete`);
    },

    // Upload transcription audio file to S3
    async uploadTranscriptionAudio(buffer: Buffer, filename: string, mimeType: string = 'audio/wav'): Promise<string> {
        const key = `transkripsiya/${filename}`;

        // Determine content type
        let contentType = mimeType;
        if (filename.toLowerCase().endsWith('.mp3')) {
            contentType = 'audio/mpeg';
        } else if (filename.toLowerCase().endsWith('.ogg') || filename.toLowerCase().endsWith('.oga')) {
            contentType = 'audio/ogg';
        } else if (filename.toLowerCase().endsWith('.wav')) {
            contentType = 'audio/wav';
        } else if (filename.toLowerCase().endsWith('.m4a') || filename.toLowerCase().endsWith('.mp4')) {
            contentType = 'audio/mp4';
        } else if (filename.toLowerCase().endsWith('.webm')) {
            contentType = 'audio/webm';
        } else if (filename.toLowerCase().endsWith('.flac')) {
            contentType = 'audio/flac';
        }

        console.log(`[UPLOAD] Uploading: ${filename}, type: ${contentType}, size: ${buffer.length}`);

        try {
            await s3.send(new PutObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: key,
                Body: buffer,
                ContentType: contentType
            }));

            // Add to DB
            await dbService.addTranscriptionFile(key);

            console.log(`[UPLOAD] Success: ${key}`);
            return key;
        } catch (err: any) {
            console.error(`[UPLOAD] Error uploading ${filename}:`, err.message);
            throw err;
        }
    },

    // --- XORAZM DIALECT FUNCTIONS ---

    // Load metadata.jsonl from xorazm1 folder and insert into DB
    async loadXorazmMetadata() {
        console.log("[XORAZM] Loading metadata from xorazm1/metadata.jsonl...");
        try {
            const response = await s3.send(new GetObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: 'xorazm1/metadata.jsonl'
            }));

            const body = await response.Body?.transformToString();
            if (!body) {
                console.log("[XORAZM] No metadata.jsonl content found");
                return 0;
            }

            // Parse JSONL (one JSON per line)
            const entries: Array<{ id: string, audio: string, text: string }> = [];
            const lines = body.split('\n').filter(line => line.trim());
            
            // Log first few entries to see the format
            if (lines.length > 0) {
                try {
                    const firstEntry = JSON.parse(lines[0]);
                    console.log("[XORAZM] First entry audio path:", firstEntry.audio);
                } catch (e) {}
            }
            
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.id && entry.audio && entry.text) {
                        entries.push({ id: entry.id, audio: entry.audio, text: entry.text });
                    }
                } catch (e) {
                    // Skip malformed lines
                }
            }

            console.log(`[XORAZM] Parsed ${entries.length} entries from metadata.jsonl`);
            if (entries.length > 0) {
                console.log("[XORAZM] Sample audio paths:", entries.slice(0, 3).map(e => e.audio));
            }
            const added = await dbService.initXorazmFiles(entries);
            console.log(`[XORAZM] Added ${added} new Xorazm files to DB`);
            return added;
        } catch (e: any) {
            console.error('[XORAZM] Error loading metadata:', e.message);
            return 0;
        }
    },

    // Get audio buffer from xorazm1/{audioPath}
    async getXorazmAudioBuffer(audioPath: string): Promise<Uint8Array | undefined> {
        try {
            const key = `xorazm1/${audioPath}`;
            console.log(`[XORAZM] Trying to get audio: ${key}`);
            const response = await s3.send(new GetObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: key
            }));
            return response.Body ? new Uint8Array(await response.Body.transformToByteArray()) : undefined;
        } catch (e: any) {
            console.error(`[XORAZM] Error getting audio ${audioPath}:`, e.message);
            // Try without xorazm1/ prefix (maybe audioPath already includes full path)
            try {
                console.log(`[XORAZM] Trying without prefix: ${audioPath}`);
                const response = await s3.send(new GetObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: audioPath
                }));
                return response.Body ? new Uint8Array(await response.Body.transformToByteArray()) : undefined;
            } catch (e2: any) {
                console.error(`[XORAZM] Error also without prefix:`, e2.message);
                return undefined;
            }
        }
    },

    // Transcribe Xorazm audio with Google Speech-to-Text
    async transcribeXorazmAudio(audioPath: string): Promise<string | null> {
        const audioBuffer = await this.getXorazmAudioBuffer(audioPath);
        if (!audioBuffer) {
            console.error(`[STT] Could not load audio: ${audioPath}`);
            return null;
        }

        const fileName = audioPath.split('/').pop() || 'audio.wav';

        console.log('[STT] Using Google Speech-to-Text...');
        const result = await speechService.transcribeAudio(audioBuffer, fileName);
        if (result) {
            console.log('[STT] Success:', result.substring(0, 50));
            return result;
        }

        console.warn('[STT] No STT API configured');
        return null;
    },

    // Upload a trimmed audio buffer to saralangan/ (instead of copying from S3)
    async uploadTrimmedToSorted(key: string, trimmedBuffer: Buffer, transcribedText?: string) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const fileName = key.split('/').pop() || key;
        const destinationKey = `saralangan/${year}/${month}/${day}/${fileName}`;
        const jsonKey = key.replace('.wav', '.json');
        const jsonDest = destinationKey.replace('.wav', '.json');

        await s3.send(new PutObjectCommand({
            Bucket: config.WASABI_BUCKET,
            Key: destinationKey,
            Body: trimmedBuffer,
            ContentType: 'audio/wav'
        }));

        try {
            if (transcribedText) {
                const existingJson = await this.getJsonContent(key);
                existingJson.text = transcribedText;
                existingJson.transcribed_at = now.toISOString();
                await s3.send(new PutObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: jsonDest,
                    Body: JSON.stringify(existingJson, null, 2),
                    ContentType: 'application/json'
                }));
            } else {
                await s3.send(new CopyObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    CopySource: `${config.WASABI_BUCKET}/${jsonKey}`,
                    Key: jsonDest
                }));
            }
        } catch (e) {
            console.warn(`Could not save JSON for trimmed ${key}`, e);
        }

        await dbService.updateFileCopyInfo(key, destinationKey, transcribedText);

        try {
            await s3.send(new DeleteObjectCommand({ Bucket: config.WASABI_BUCKET, Key: key }));
            await s3.send(new DeleteObjectCommand({ Bucket: config.WASABI_BUCKET, Key: jsonKey }));
        } catch (e) {
            console.warn(`Could not delete originals for ${key}`, e);
        }

        return destinationKey;
    },

    // Upload a trimmed Xorazm audio buffer to xorazm_saralangan/
    async uploadTrimmedXorazmToAccepted(id: string, audioPath: string, trimmedBuffer: Buffer, text: string) {
        const audioFileName = audioPath.split('/').pop() || `${id}.wav`;
        const now = new Date();
        const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        const destAudioKey = `xorazm_saralangan/${dateStr}/${audioFileName}`;

        await s3.send(new PutObjectCommand({
            Bucket: config.WASABI_BUCKET,
            Key: destAudioKey,
            Body: trimmedBuffer,
            ContentType: 'audio/wav'
        }));

        const jsonKey = destAudioKey.replace('.wav', '.json');
        await s3.send(new PutObjectCommand({
            Bucket: config.WASABI_BUCKET,
            Key: jsonKey,
            Body: JSON.stringify({ id, audio: audioFileName, text, checked_at: now.toISOString() }, null, 2),
            ContentType: 'application/json'
        }));

        console.log(`Xorazm trimmed file ${id} uploaded to ${destAudioKey}`);
        return destAudioKey;
    },

    // Copy accepted file to xorazm_saralangan/ folder with JSON metadata
    async copyXorazmToAccepted(id: string, audioPath: string, text: string) {
        try {
            const audioFileName = audioPath.split('/').pop() || `${id}.wav`;
            const now = new Date();
            const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;

            // Copy audio to xorazm_saralangan/YYYY/MM/DD/
            const destAudioKey = `xorazm_saralangan/${dateStr}/${audioFileName}`;
            const srcKey = `xorazm1/${audioPath}`;

            await s3.send(new CopyObjectCommand({
                Bucket: config.WASABI_BUCKET,
                CopySource: `${config.WASABI_BUCKET}/${srcKey}`,
                Key: destAudioKey
            }));

            // Create JSON metadata file
            const jsonKey = destAudioKey.replace('.wav', '.json');
            const metadata = {
                id: id,
                audio: audioFileName,
                text: text,
                checked_at: now.toISOString()
            };

            await s3.send(new PutObjectCommand({
                Bucket: config.WASABI_BUCKET,
                Key: jsonKey,
                Body: JSON.stringify(metadata, null, 2),
                ContentType: 'application/json'
            }));

            console.log(`Xorazm file ${id} copied to ${destAudioKey}`);
            return destAudioKey;
        } catch (e: any) {
            console.error(`Error copying Xorazm file ${id}:`, e.message);
            throw e;
        }
    }
};