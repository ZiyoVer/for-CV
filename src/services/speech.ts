import axios from 'axios';
import { config } from '../config';

const SPEECH_API_URL = 'https://speech.googleapis.com/v1/speech:recognize';

export const speechService = {
    async transcribeAudio(audioBuffer: Uint8Array, fileName: string): Promise<string | null> {
        const apiKey = (config as any).GOOGLE_SPEECH_API_KEY;
        if (!apiKey) {
            console.warn('GOOGLE_SPEECH_API_KEY not configured');
            return null;
        }

        try {
            const base64Audio = Buffer.from(audioBuffer).toString('base64');

            const requestBody = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: 16000,
                    languageCode: 'uz-UZ',
                    model: 'default',
                    useEnhanced: true,
                    enableAutomaticPunctuation: true
                },
                audio: {
                    content: base64Audio
                }
            };

            const response = await axios.post(
                `${SPEECH_API_URL}?key=${apiKey}`,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );

            if (response.data?.results?.[0]?.alternatives?.[0]?.transcript) {
                return response.data.results[0].alternatives[0].transcript;
            }

            console.warn('Speech API response:', response.data);
            return null;
        } catch (error: any) {
            if (error.response?.data?.error) {
                console.error('Speech API error:', JSON.stringify(error.response.data.error));
            } else {
                console.error('Speech transcription error:', error.message);
            }
            return null;
        }
    }
};
