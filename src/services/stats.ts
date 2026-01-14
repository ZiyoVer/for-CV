import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { dbService } from './db';

const width = 800;
const height = 400;
const chartCallback = (ChartJS: any) => {
    ChartJS.defaults.responsive = true;
    ChartJS.defaults.maintainAspectRatio = false;
};

const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, chartCallback });

export const statsService = {
    async generateAdminStatsChart(): Promise<Buffer> {
        const stats = dbService.getAllUserStats();

        // Prepare data
        const labels = stats.map((s: any) => s.full_name || 'Noma\'lum');
        const accepted = stats.map((s: any) => s.accepted_count);
        const rejected = stats.map((s: any) => s.rejected_count);

        const configuration: any = {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Qabul qilindi ✅',
                        data: accepted,
                        backgroundColor: 'rgba(75, 192, 192, 0.7)',
                    },
                    {
                        label: 'Rad etildi ❌',
                        data: rejected,
                        backgroundColor: 'rgba(255, 99, 132, 0.7)',
                    }
                ]
            },
            options: {
                plugins: {
                    title: {
                        display: true,
                        text: 'Foydalanuvchilar Statistikasi'
                    },
                    legend: {
                        position: 'top',
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        };

        return await chartJSNodeCanvas.renderToBuffer(configuration);
    }
};
