# Profile Miyo Widget API

Serverless Chatbot API untuk asisten virtual pribadi **Miyo** pada website portofolio Bayu Aziz.

## Standar Kecepatan & Waktu Tunggu Respon (UX Chatbot)

| Durasi Respon | Status UX | Evaluasi |
| :--- | :--- | :--- |
| **< 2 – 3 detik** | **Sangat Baik (Ideal)** | Pengunjung merasa chat sangat responsif dan interaktif. |
| **3 – 5 detik** | **Dapat Diterima** | Waktu berpikir wajar bagi AI non-streaming. |
| **5 – 8 detik** | **Mulai Lag / Lambat** | Pengunjung mulai gelisah menunggu balasan. |
| **> 8 – 10 detik** | **Kritis / Drop-off Tinggi** | Mayoritas pengunjung berasumsi bot hang dan menutup widget. |

> **Target Miyo**: Menghasilkan respon lengkap dalam rentang **1 – 3 detik**.

---

## Arsitektur Dual-AI & Optimasi Kecepatan (Ultra-Fast & Anti-Overload)

Endpoint `/api/chat` mengimplementasikan strategi **Dual-AI Failover Berkecepatan Tinggi**:

1. **AI Google Gemini**: Menggunakan `GEMINI_API_KEY` dengan model cepat `gemini-1.5-flash` (otomatis failover ke `gemini-1.5-flash-8b` / `gemini-2.0-flash`). Dilengkapi timeout ketat 4 detik per attempt.
2. **AI Groq (LPU Inference)**: Menggunakan `MIYO_API_KEY` atau `GROQ_API_KEY` dengan model kilat `llama-3.1-8b-instant` (~300–800ms) dan `llama-3.3-70b-versatile`.

### Fitur Optimasi Kecepatan yang Diterapkan
- **Timeout Cepat (4 detik)**: Tidak ada lagi request yang menggantung lama (15-30 detik). Jika provider utama lambat atau antre, backend langsung mengalihkan ke provider cadangan.
- **Google Sheets Timeout & Cache (15 Menit)**: Fetch Google Sheet dibatasi maksimal 2.5 detik dengan cadangan profil lokal lengkap, sehingga cold start tidak pernah menghambat chat.
- **Ramping Token (500 tokens)**: Memotong waktu inferensi sebesar ~40% dengan gaya respon padat, scannable, dan to-the-point.
- **Model Terverifikasi Aktif**: Menghilangkan error 404 dari model fiktif yang sebelumnya membuang waktu round-trip.

---

## Konfigurasi Environment Variables di Vercel

Tambahkan variabel lingkungan berikut di dashboard **Vercel > Settings > Environment Variables**:

| Variable | Wajib / Opsional | Keterangan |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Direkomendasikan | API Key Google AI Studio |
| `MIYO_API_KEY` / `GROQ_API_KEY` | Direkomendasikan | API Key Groq Cloud Console |
| `PREFER_GROQ` | Opsional | Set `true` untuk mendahulukan Groq (kecepatan respon < 1 detik) |
| `GEMINI_MODEL` | Opsional | Default: `gemini-1.5-flash` |
| `GROQ_MODEL` | Opsional | Default: `llama-3.1-8b-instant` (atau `llama-3.3-70b-versatile`) |

> *Catatan: Minimal salah satu dari `GEMINI_API_KEY` atau `MIYO_API_KEY`/`GROQ_API_KEY` harus tersedia agar chatbot dapat beroperasi.*
