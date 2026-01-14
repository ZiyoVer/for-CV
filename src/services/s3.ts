import { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { dbService } from './db';

const s3 = new S3Client({
    region: config.WASABI_REGION,
    endpoint: config.WASABI_ENDPOINT,
    credentials: {
        accessKeyId: config.WASABI_ACCESS_KEY,
        secretAccessKey: config.WASABI_SECRET_KEY
    }
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
                    // Skip if currently in 'saralangan/' or 'stt/saralangan/'
                    // Since we want saralangan at root, we check if key starts with that
                    if (file.Key.startsWith('saralangan/')) continue;

                    dbService.addFile(file.Key);
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
            return str ? JSON.parse(str) : null;
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
    }
};
