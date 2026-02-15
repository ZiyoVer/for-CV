import axios from 'axios';
import { config } from '../config';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-001:generateContent';

export const geminiService = {
    async transcribeAudio(audioBuffer: Uint8Array, fileName: string): Promise<string | null> {
        if (!config.GEMINI_API_KEY) {
            console.warn('GEMINI_API_KEY not configured');
            return null;
        }

        try {
            const base64Audio = Buffer.from(audioBuffer).toString('base64');

            const requestBody = {
                contents: [
                    {
                        parts: [
                            {
                                inline_data: {
                                    mime_type: 'audio/wav',
                                    data: base64Audio
                                }
                            },
                            {
                                text: 'Bu O\'zbekcha ovozli yozuv. Iltimos, uni matn ko\'rinishida transkripsiya qiling. Faqat transkripsiya matnini qaytaring, boshqa hech narsa yozmang.'
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 2048
                }
            };

            const response = await axios.post(
                `${GEMINI_API_URL}?key=${config.GEMINI_API_KEY}`,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 120000
                }
            );

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return response.data.candidates[0].content.parts[0].text.trim();
            }

            console.warn('Gemini response format unexpected:', response.data);
            return null;
        } catch (error: any) {
            if (error.response?.data?.error) {
                console.error('Gemini API error:', JSON.stringify(error.response.data.error));
            } else {
                console.error('Gemini transcription error:', error.message);
            }
            return null;
        }
    }
};
