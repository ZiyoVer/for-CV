import { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
    // Populate DB with files from S3 ("stt/" folder)
    async syncFiles() {
        console.log("Starting S3 Sync for 'stt/' folder...");
        let continuationToken: string | undefined;
        let count = 0;

        do {
            const command = new ListObjectsV2Command({
                Bucket: config.WASABI_BUCKET,
                Prefix: 'stt/', // Only look in 'stt/' folder
                ContinuationToken: continuationToken
            });

            const response = await s3.send(command);
            const files = response.Contents || [];

            for (const file of files) {
                if (file.Key && file.Key.endsWith('.wav')) {
                    if (file.Key.startsWith('saralangan/')) continue;

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
                }
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);
        console.log(`Synced ${count} files from stt/ folder.`);
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

    async copyToSorted(key: string) {
        // key is something like "stt/file.wav"
        // We want to move it to "saralangan/file.wav" (OUTSIDE stt)

        let destinationKey = '';
        if (key.startsWith('stt/')) {
            // Remove "stt/" prefix and prepend "saralangan/"
            destinationKey = key.replace('stt/', 'saralangan/');
        } else {
            // Fallback: just put it in saralangan/
            destinationKey = `saralangan/${key}`;
        }

        await s3.send(new CopyObjectCommand({
            Bucket: config.WASABI_BUCKET,
            CopySource: `${config.WASABI_BUCKET}/${key}`,
            Key: destinationKey
        }));

        // Also copy JSON
        const jsonKey = key.replace('.wav', '.json');
        let jsonDest = '';
        if (jsonKey.startsWith('stt/')) {
            jsonDest = jsonKey.replace('stt/', 'saralangan/');
        } else {
            jsonDest = `saralangan/${jsonKey}`;
        }

        try {
            await s3.send(new CopyObjectCommand({
                Bucket: config.WASABI_BUCKET,
                CopySource: `${config.WASABI_BUCKET}/${jsonKey}`,
                Key: jsonDest
            }));
        } catch (e) {
            console.warn(`Could not copy JSON for ${key}`, e);
        }
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

        do {
            const command = new ListObjectsV2Command({
                Bucket: config.WASABI_BUCKET,
                Prefix: 'transkripsiya/',
                ContinuationToken: continuationToken
            });

            const response = await s3.send(command);
            const files = response.Contents || [];

            for (const file of files) {
                if (file.Key && file.Key.endsWith('.wav')) {
                    if (file.Key.includes('saralangan/')) continue;

                    await dbService.addTranscriptionFile(file.Key);
                    count++;
                }
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);
        console.log(`Synced ${count} transcription files from transkripsiya/ folder.`);
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
    async copyTranscriptionToSorted(key: string, transcribedText: string, duration?: number, gender?: string) {
        // key is like "transkripsiya/file.wav"
        // Destination: "saralangan/transkripsiya/file.wav"

        let destinationKey = '';
        if (key.startsWith('transkripsiya/')) {
            destinationKey = key.replace('transkripsiya/', 'saralangan/transkripsiya/');
        } else {
            destinationKey = `saralangan/transkripsiya/${key}`;
        }

        // Copy audio file
        await s3.send(new CopyObjectCommand({
            Bucket: config.WASABI_BUCKET,
            CopySource: `${config.WASABI_BUCKET}/${key}`,
            Key: destinationKey
        }));

        // Create JSON with transcribed text and metadata
        const jsonDest = destinationKey.replace('.wav', '.json');
        const fileName = key.split('/').pop() || 'unknown';

        const jsonContent: any = {
            audio_name: fileName,
            text: transcribedText,
            transcribed_at: new Date().toISOString()
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
    }
};
