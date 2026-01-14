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
    // Populate DB with files from S3
    // This is "Sync" logic.
    async syncFiles() {
        console.log("Starting S3 Sync...");
        let continuationToken: string | undefined;
        let count = 0;

        do {
            const command = new ListObjectsV2Command({
                Bucket: config.WASABI_BUCKET,
                ContinuationToken: continuationToken
            });

            const response = await s3.send(command);
            const files = response.Contents || [];

            for (const file of files) {
                if (file.Key && file.Key.endsWith('.wav')) {
                    // Skip if currently in 'saralangan/' or 'trash/' or 'rejected/' if separated
                    if (file.Key.startsWith('saralangan/')) continue;

                    dbService.addFile(file.Key);
                    count++;
                }
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);
        console.log(`Synced ${count} files.`);
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
            // Return dummy if missing
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
        const destinationKey = `saralangan/${key}`;
        await s3.send(new CopyObjectCommand({
            Bucket: config.WASABI_BUCKET,
            CopySource: `${config.WASABI_BUCKET}/${key}`, // Must include bucket name
            Key: destinationKey
        }));

        // Also copy JSON
        const jsonKey = key.replace('.wav', '.json');
        const jsonDest = `saralangan/${jsonKey}`;
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
