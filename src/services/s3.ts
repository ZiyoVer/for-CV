import { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { dbService } from './db';
import { parseBuffer } from 'music-metadata';

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

                    // Filter by date: only sync files from SYNC_START_DATE onwards
                    if (file.LastModified && file.LastModified < this.SYNC_START_DATE) {
                        tooOld++;
                        return; // Skip old files
                    }

                    // Check if file already exists in DB (any status: PENDING, ACCEPTED, REJECTED)
                    const existingFile = await dbService.checkFileExists(file.Key);
                    if (existingFile) {
                        skipped++;
                        return; // Skip if already in DB
                    }

                    // Try to get duration from JSON first
                    let duration = 0;
                    try {
                        const json = await this.getJsonContent(file.Key);
                        if (json && json.duration) {
                            duration = Math.round(json.duration / 1000); // ms to sec
                        }
                    } catch (e) { }

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
        } catch (error) {
            console.error(`Error fetching JSON for ${audioKey}:`, error);
            return { text: "[JSON fayli topilmadi]" };
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
        // key is like "transkripsiya/file.wav"
        // Destination: "saralangan/transkripsiya/2025/02/09/file.wav"

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        const fileName = key.split('/').pop() || 'unknown';

        let destinationKey = '';
        if (key.startsWith('transkripsiya/')) {
            destinationKey = key.replace('transkripsiya/', `saralangan/transkripsiya/${year}/${month}/${day}/`);
        } else {
            destinationKey = `saralangan/transkripsiya/${year}/${month}/${day}/${key}`;
        }

        // Copy audio file
        await s3.send(new CopyObjectCommand({
            Bucket: config.WASABI_BUCKET,
            CopySource: `${config.WASABI_BUCKET}/${key}`,
            Key: destinationKey
        }));

        // Create JSON with transcribed text and metadata
        const jsonDest = destinationKey.replace('.wav', '.json');

        const jsonContent: any = {
            audio_name: fileName,
            text: transcribedText,
            transcribed_at: now.toISOString()
        };

        if (duration) jsonContent.duration = duration;
        if (gender) jsonContent.gender = gender;

        await s3.send(new PutObjectCommand({
            Bucket: config.WASABI_BUCKET,
            Key: jsonDest,
            Body: JSON.stringify(jsonContent, null, 2),
            ContentType: 'application/json'
        }));

        console.log(`Copied transcription to ${destinationKey} with metadata`);

        // Delete original file from S3 to prevent re-syncing
        if (deleteOriginal) {
            try {
                await s3.send(new DeleteObjectCommand({
                    Bucket: config.WASABI_BUCKET,
                    Key: key
                }));
                console.log(`Deleted original transcription file: ${key}`);
            } catch (e) {
                console.warn(`Could not delete original transcription file for ${key}`, e);
            }
        }
    },

    // Upload transcription audio file to S3
    async uploadTranscriptionAudio(buffer: Buffer, filename: string): Promise<string> {
        const key = `transkripsiya/${filename}`;

        await s3.send(new PutObjectCommand({
            Bucket: config.WASABI_BUCKET,
            Key: key,
            Body: buffer,
            ContentType: 'audio/wav'
        }));

        // Add to DB
        await dbService.addTranscriptionFile(key);

        console.log(`Uploaded transcription audio: ${key}`);
        return key;
    },

    // --- XORAZM REGION FUNCTIONS (Placeholder) ---

    // Sync Xorazm region files from S3 'xorazm/' folder
    async syncXorazmFiles() {
        console.log("Starting S3 Sync for 'xorazm/' folder...");
        console.log("⚠️ Xorazm region: Datasetlar tez orada qo'shiladi");
        // Placeholder - will be implemented when Xorazm datasets are ready
        return 0;
    }
};