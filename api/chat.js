// Cache in-memory untuk menghemat request & mempercepat respons (15 menit)
let cachedSheetData = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;

// URL Google Sheets Tab "miyo" (Format CSV via Google Visualization API)
const GSHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1-TtuuskcO0mvZWAO8pg26MHNfn9NdfrIPeuSlP7Kaug/gviz/tq?tqx=out:csv&gid=561116560";

// Fallback profil statis jika Google Sheet lambat (> 2.5s) atau gagal
const FALLBACK_PROFILE_DATA = `
Topik / Kategori: Data Profil Lengkap Bayu Aziz
- Nama Lengkap: Bayu Aziz
- Headline & Profesi: Logistic Specialist | Data Analyst | Data Engineer
- Ringkasan Profil: Berpengalaman dalam pengelolaan rantai pasok dan analisis data operasional. Memiliki keahlian kuat dalam problem-solving berbasis data dan automasi proses.
- Keahlian Utama: Supply-Chain Operations, Spreadsheet, SQL, Python, Dashboarding / Visualisasi Data.
- Tools & Software: Excel, Google Sheets, Looker Studio, Redash, Metabase, Google Drive, SQL, Python, JavaScript, Google Apps Script.
- Pengalaman Kerja: Recovery Specialist di Ninja Xpress (2018 - sekarang) - Menginvestigasi dan menyelesaikan anomali operasional rantai pasok dengan efisiensi tinggi.
- Pendidikan: D3 Sistem Informasi - Universitas Bina Sarana Informatika (2015 - 2018) - IPK 3.88.
- Kontak WhatsApp: https://wa.me/6281222493838
- LinkedIn: https://www.linkedin.com/in/azbayou
- Email: mailto:azbayou@gmail.com
- Website Portofolio: https://azbayou.github.io/profile
- Karakter & Gaya Kerja: Analitis, Adaptif, Terorganisir, fleksibel mandiri maupun tim, komunikator aktif dan terbuka terhadap kritik/evaluasi objektif.
- Fokus Karier Saat Ini: Aktif mencari peluang kerja full-time (remote / hybrid) di bidang Data Analysis, Warehouse Management, dan Logistik.
- Proyek Unggulan: Dashboard Portofolio Interaktif dengan formula Excel tingkat lanjut, Pivot Table, dan visualisasi data informatif.
`;

/**
 * Helper fetch dengan timeout ketat agar request tidak menggantung lama
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

async function fetchGoogleSheetData() {
  const now = Date.now();
  if (cachedSheetData && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedSheetData;
  }

  try {
    // Timeout 2.5s agar chat tidak terhambat jika Google Docs sedang lambat
    const res = await fetchWithTimeout(GSHEET_CSV_URL, {}, 2500);
    if (res.ok) {
      const text = await res.text();
      if (text && text.trim().length > 0) {
        cachedSheetData = text.trim();
        lastFetchTime = now;
        return cachedSheetData;
      }
    }
  } catch (err) {
    console.warn("[Google Sheets] Gagal/timeout mengambil data terbaru (menggunakan fallback cepat):", err.message);
  }

  // Gunakan data cache sebelumnya atau fallback statis jika sheet timeout/gagal
  return cachedSheetData || FALLBACK_PROFILE_DATA.trim();
}

/**
 * Panggilan ke Google Gemini API (Model resmi, cepat, dan timeout ketat 4s per attempt)
 */
async function callGemini(apiKey, systemPrompt, sheetData, history, userMessage) {
  const modelsToTry = [
    process.env.GEMINI_MODEL || "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-2.0-flash",
    "gemini-flash-latest"
  ];

  const formattedContents = [];
  for (const h of history) {
    if (h.role && h.content) {
      formattedContents.push({
        role: h.role === "assistant" || h.role === "model" ? "model" : "user",
        parts: [{ text: h.content }]
      });
    }
  }

  formattedContents.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  const geminiErrors = [];

  for (const model of modelsToTry) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetchWithTimeout(
        geminiUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            system_instruction: {
              parts: [
                {
                  text: `[INSTRUKSI SISTEM & ATURAN PERILAKU MIYO]\n${systemPrompt}\n\n[DATA PRIBADI BAYU AZIZ DARI GOOGLE SHEET (SINGLE SOURCE OF TRUTH)]\n${sheetData}`
                }
              ]
            },
            contents: formattedContents,
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 500 // 500 token untuk respon ringkas, padat & 40% lebih cepat
            }
          })
        },
        4000 // Batas 4 detik per percobaan agar failover berjalan sigap
      );

      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        geminiErrors.push(`${model}: HTTP ${response.status}`);
        continue;
      }

      if (!response.ok || data.error) {
        const errMsg = data.error?.message || `Status ${response.status}`;
        geminiErrors.push(`${model}: ${errMsg}`);
        continue;
      }

      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) {
        return reply;
      }

      const finishReason = data.candidates?.[0]?.finishReason;
      geminiErrors.push(`${model}: finishReason ${finishReason || "empty"}`);
    } catch (err) {
      const errMsg = err.name === "AbortError" ? "Timeout 4s" : err.message;
      geminiErrors.push(`${model}: ${errMsg}`);
    }
  }

  throw new Error(`Gemini gagal (${geminiErrors.join(" | ")})`);
}

/**
 * Panggilan ke Groq API (Inferensi ultra cepat ~300-800ms)
 * Menggunakan model resmi aktif: llama-3.1-8b-instant (kilat) & llama-3.3-70b-versatile (cerdas)
 */
async function callGroq(apiKey, systemPrompt, sheetData, history, userMessage) {
  const modelsToTry = [
    process.env.GROQ_MODEL || "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "mixtral-8x7b-32768"
  ];

  const messages = [
    {
      role: "system",
      content: `[INSTRUKSI SISTEM & ATURAN PERILAKU MIYO]\n${systemPrompt}\n\n[DATA PRIBADI BAYU AZIZ DARI GOOGLE SHEET (SINGLE SOURCE OF TRUTH)]\n${sheetData}`
    }
  ];

  for (const h of history) {
    if (h.role && h.content) {
      messages.push({
        role: h.role === "assistant" || h.role === "model" ? "assistant" : "user",
        content: h.content
      });
    }
  }

  messages.push({
    role: "user",
    content: userMessage
  });

  const groqErrors = [];

  for (const model of modelsToTry) {
    try {
      const response = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            max_tokens: 500 // Respon padat & kilat
          })
        },
        4000 // 4 detik timeout
      );

      const data = await response.json();
      if (!response.ok || data.error) {
        const errMsg = data.error?.message || `Status ${response.status}`;
        groqErrors.push(`${model}: ${errMsg}`);
        console.warn(`[Groq Failover] Model ${model} gagal: ${errMsg}`);
        continue;
      }

      const reply = data.choices?.[0]?.message?.content;
      if (reply) {
        return reply;
      }
    } catch (err) {
      const errMsg = err.name === "AbortError" ? "Timeout 4s" : err.message;
      groqErrors.push(`${model}: ${errMsg}`);
      console.warn(`[Groq Failover] Permintaan ke ${model} gagal:`, errMsg);
    }
  }

  throw new Error(`Groq API gagal (${groqErrors.join(" | ")})`);
}

export default async function handler(req, res) {
  // 1. Setup CORS headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // 2. Preflight request handler
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Debug endpoint untuk cek model Groq yang tersedia
  if (req.method === "GET" && req.query && req.query.debug === "groq") {
    const miyoKey = process.env.GROQ_API_KEY || process.env.GROQ_API || process.env.MIYO_API_KEY;
    if (!miyoKey) return res.status(400).json({ error: "GROQ_API_KEY / MIYO_API_KEY belum disetel di Vercel" });
    try {
      const groqResp = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${miyoKey}` }
      });
      const groqData = await groqResp.json();
      return res.status(groqResp.status).json(groqData);
    } catch (debugErr) {
      return res.status(500).json({ error: debugErr.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Gunakan POST." });
  }

  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Pesan tidak boleh kosong." });
    }

    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const groqKey = process.env.GROQ_API_KEY || process.env.GROQ_API || process.env.MIYO_API_KEY;

    if (!geminiKey && !groqKey) {
      return res.status(500).json({
        error:
          "Konfigurasi server belum lengkap: GEMINI_API_KEY atau GROQ_API_KEY/MIYO_API_KEY belum disetel di Vercel Environment Variables."
      });
    }

    // 3. Ambil data pribadi dinamis dari Google Sheets (Sheet: miyo) dengan timeout cepat
    const personalDataFromSheet = await fetchGoogleSheetData();

    // 4. System Prompt: Identitas, Sifat Dasar, Gaya Bahasa, dan Aturan Miyo
    const systemPrompt = `[IDENTITAS & PERAN UTAMA]
Kamu adalah Miyo, asisten virtual pribadi berbasis AI untuk Bayu Aziz.
Tugas utamamu adalah mendampingi pengunjung di website portofolio Bayu, menjawab pertanyaan seputar latar belakang profesional, proyek, keahlian, dan cara menghubungi Bayu secara cerdas, ramah, dan solutif.

[SIFAT DASAR MIYO]
1. Cerdas & Tanggap: Memahami maksud pertanyaan pengunjung dengan cepat layaknya asisten eksekutif yang cakap.
2. Hangat & Menyenangkan: Menghadirkan suasana percakapan yang ramah, nyaman, dan hidup (seperti Gemini AI atau teman pintar yang suportif).
3. Lucu & Ceria: Memiliki kepribadian manis dan sedikit menggemaskan, tapi tetap memegang batas etika profesional.
4. Loyal & Representatif: Selalu mewakili dan menonjolkan kelebihan Bayu Aziz secara jujur dan objektif.

[GAYA BAHASA & NADA BICARA (ALA GEMINI - WARM & SCANNABLE)]
1. Bahasa Indonesia Luwes: Gunakan bahasa Indonesia sehari-hari yang santai, luwes, dan natural. Hindari bahasa kaku seperti formulir resmi.
2. Ringkas, Padat, & Scannable: Berikan respon yang to-the-point dan mudah dibaca cepat (gunakan bullet points atau penomoran serta teks **bold**). Hindari pengantar yang bertele-tele agar pengunjung langsung mendapat info dalam hitungan detik.
3. Tanpa Salam Berulang: Jangan menyapa pengguna berulang-ulang ("Halo!", "Hai!") di setiap balon chat jika percakapan sedang berjalan.
4. Ciri Khas Akhir Chat: SELALU akhiri setiap responmu dengan "-Miyo~" dengan nada imut dan ramah.

[ATURAN KETAT & ANTI-HALUSINASI]
1. Faktual & Berpatokan pada Data Profil: Semua fakta mengenai nama, riwayat karier, kontak, dan keahlian Bayu HARUS berpatokan pada [DATA PRIBADI BAYU AZIZ DARI GOOGLE SHEET] di bawah.
2. Kejujuran Mutlak: JANGAN PERNAH mengarang proyek, perusahaan tempat bekerja, sertifikasi, atau kontak yang tidak tercantum di data.
3. Search & Bridge Logic (Penalaran Tools/Metode Baru):
   Jika pengguna menanyakan tools atau metode yang belum ada di riwayat Bayu (misalnya: Tableau, Snowflake, Docker, Flutter):
   - Jelaskan fungsi tools tersebut secara ringkas.
   - Hubungkan secara jujur dengan tools serupa yang sudah sangat dikuasai Bayu (misal SQL, Looker Studio, Metabase, Python, Spreadsheet).
   - Tekankan kemampuan adaptasi dan pemahaman logika data yang dimiliki Bayu.

[FORMAT TOMBOL & LINK (MANDATORI)]
Setiap kali kamu menyebutkan kontak, media sosial, atau tautan luar, KAMU WAJIB memformatnya menggunakan Markdown Link bergaya tombol:
- Format tautan Markdown: [Teks Tombol yang Jelas](URL)
- Jangan pernah tampilkan URL polos tanpa format tombol.
Contoh:
- WhatsApp: [💬 Chat via WhatsApp](https://wa.me/6281222493838?text=Hai%20Bayu%2C%20saya%20tertarik%20berdiskusi)
- LinkedIn: [🔗 Profil LinkedIn Bayu](https://www.linkedin.com/in/azbayou)
- Email: [✉️ Email Bayu Aziz](mailto:azbayou@gmail.com)
- Portofolio Web: [🌐 Web Portofolio Bayu](https://azbayou.github.io/profile)`;

    // Batasi riwayat obrolan maksimal 4 percakapan terakhir untuk efisiensi context & kecepatan
    const recentHistory = Array.isArray(history) ? history.slice(-4) : [];

    // Opsi konfigurasi prioritas provider:
    // Jika PREFER_GROQ=true atau PREFERRED_PROVIDER=groq disetel di Vercel, dahulukan Groq untuk kecepatan kilat (<1 detik)
    const preferGroq =
      (process.env.PREFER_GROQ === "true" || process.env.PREFERRED_PROVIDER === "groq") && !!groqKey;

    let reply = null;
    let usedProvider = null;
    const errors = [];

    if (preferGroq) {
      // 5A. Jalur Super Kilat: Coba Groq terlebih dahulu
      try {
        reply = await callGroq(groqKey, systemPrompt, personalDataFromSheet, recentHistory, message.trim());
        usedProvider = "groq";
      } catch (err) {
        console.warn("[Chatbot Failover] Groq mengalami kendala, beralih ke Gemini:", err.message);
        errors.push(`Groq: ${err.message}`);
      }

      // Failover ke Gemini jika Groq gagal
      if (!reply && geminiKey) {
        try {
          reply = await callGemini(geminiKey, systemPrompt, personalDataFromSheet, recentHistory, message.trim());
          usedProvider = "gemini";
        } catch (err) {
          console.error("[Chatbot Failover] Gemini juga mengalami kendala:", err.message);
          errors.push(`Gemini: ${err.message}`);
        }
      }
    } else {
      // 5B. Jalur Standar: Coba Gemini terlebih dahulu (dengan timeout 4s), failover otomatis ke Groq
      if (geminiKey) {
        try {
          reply = await callGemini(geminiKey, systemPrompt, personalDataFromSheet, recentHistory, message.trim());
          usedProvider = "gemini";
        } catch (err) {
          console.warn("[Chatbot Failover] Gemini mengalami kendala/timeout:", err.message);
          errors.push(`Gemini: ${err.message}`);
        }
      }

      // Failover ke Groq jika Gemini gagal / timeout
      if (!reply && groqKey) {
        try {
          console.log("[Chatbot Failover] Mengalihkan permintaan ke Groq API (kecepatan tinggi)...");
          reply = await callGroq(groqKey, systemPrompt, personalDataFromSheet, recentHistory, message.trim());
          usedProvider = "groq";
        } catch (err) {
          console.error("[Chatbot Failover] Groq API juga mengalami kendala:", err.message);
          errors.push(`Groq: ${err.message}`);
        }
      }
    }

    // 6. Jika seluruh penyedia AI gagal
    if (!reply) {
      return res.status(502).json({
        error: `Semua layanan AI sedang sibuk atau overload. Silakan coba beberapa saat lagi. Detail: ${errors.join(" | ")}`
      });
    }

    return res.status(200).json({ reply, provider: usedProvider });
  } catch (err) {
    console.error("Internal Server Error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan internal pada server chatbot." });
  }
}
