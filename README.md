# Profile Miyo Widget API

Serverless Chatbot API untuk asisten virtual pribadi **Miyo** pada website portofolio Bayu Aziz.

## Arsitektur Dual-AI (Anti-Overload & Anti-Halu)

Untuk mencegah downtime akibat limit kuota atau overload pada Google Gemini, endpoint `/api/chat` mengimplementasikan strategi **Dual-AI Failover**:

1. **AI Utama (Google Gemini)**: Menggunakan `GEMINI_API_KEY` dengan model gratis `gemini-1.5-flash` (`temperature: 0.2`).
2. **AI Cadangan (Groq)**: Menggunakan `MIYO_API_KEY` dengan model gratis `llama-3.3-70b-versatile` (otomatis failover ke `llama-3.1-8b-instant` jika kuota 70B habis).

### Karakteristik Model & Anti-Halusinasi
- **Temperature Rendah (`0.2`)**: Menjaga respon tetap grounded pada data profil dari Google Sheets (*single source of truth*).
- **Llama 3.3 70B (Groq)**: Model berparameter besar dengan penalaran tinggi dan kepatuhan instruksi ketat untuk mencegah halusinasi data.
- **Failover Otomatis**: Jika Gemini mengembalikan error 429 (rate limit / kuota habis) atau 503 (overload), backend akan secara mulus mengalihkan permintaan ke Groq tanpa disadari pengunjung web.

## Konfigurasi Environment Variables di Vercel

Tambahkan variabel lingkungan berikut di dashboard **Vercel > Settings > Environment Variables**:

| Variable | Wajib / Opsional | Keterangan |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Direkomendasikan | API Key Google AI Studio (Gratis) |
| `MIYO_API_KEY` | Direkomendasikan | API Key Groq Cloud Console (Gratis) |
| `GEMINI_MODEL` | Opsional | Default: `gemini-1.5-flash` |
| `GROQ_MODEL` | Opsional | Default: `llama-3.3-70b-versatile` |

> *Catatan: Minimal salah satu dari `GEMINI_API_KEY` atau `MIYO_API_KEY` harus tersedia agar chatbot dapat beroperasi.*
